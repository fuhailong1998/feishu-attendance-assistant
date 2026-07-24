(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RECONCILIATION_VERSION = 2;
  const RECONCILIATION_STORAGE_KEY = `attendance-report:reconciliation:${RECONCILIATION_VERSION}:global`;
  const LEGACY_RECONCILIATION_STORAGE_PREFIX = 'attendance-report:reconciliation:1:';
  const RECONCILIATION_TYPES = Object.freeze({
    confirmed: '原记录无误',
    holiday: '法定节假日',
    patch: '补卡或更正时间',
    'leave-full': '全天请假',
    'leave-am': '上午半天假',
    'leave-pm': '下午半天假',
    travel: '出差',
    field: '外出或外勤',
    other: '其他说明',
  });
  const state = {
    filter: 'all',
    query: '',
    newestFirst: true,
    reconciliations: new Map(),
    storageAvailable: true,
    activePeriod: null,
    periodDraftMode: 'detected',
    cycleStartDay: 1,
    baselineRows: [],
    chartMode: 'candlestick',
  };
  let baseReport = null;
  let report = null;
  let parserApi = null;
  let toastTimer = null;
  let periodApplyTimer = null;

  const $ = (selector) => document.querySelector(selector);

  function setText(selector, value) {
    const node = $(selector);
    if (node) node.textContent = String(value ?? '');
  }

  function number(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function hasNumericValue(value) {
    return value !== null
      && value !== undefined
      && value !== ''
      && Number.isFinite(Number(value));
  }

  function formatMinutes(value) {
    const minutes = Math.max(0, Math.round(number(value)));
    if (!minutes) return '0分';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest}分`;
    return rest ? `${hours}小时${rest}分` : `${hours}小时`;
  }

  function compactMinutes(value) {
    const minutes = Math.max(0, Math.round(number(value)));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h${rest}` : `${hours}h`;
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }

  function todayKey() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  function periodModeLabel(mode) {
    const labels = {
      all: '全部数据',
      detected: '考勤周期',
      natural: '自然月',
      cycle: '固定起始日周期',
      custom: '自定义周期',
    };
    return labels[mode] || '考勤周期';
  }

  function statusTone(label) {
    if (/(?:迟到|早退|缺卡|缺勤|旷工)/.test(label)) return 'danger';
    if (/(?:待核对|进行中)/.test(label)) return 'warning';
    if (/(?:正常|已补卡)/.test(label)) return 'success';
    if (/(?:外勤|请假|出差|无需打卡|法定节假日)/.test(label)) return 'info';
    return '';
  }

  function rowCategory(row) {
    if (row.abnormal || row.pending) return 'attention';
    if (/(?:请假|出差|外勤|无需打卡)/.test(row.status || '')) return 'leave';
    if (!row.workday || /休息/.test(row.status || '')) return 'rest';
    return 'normal';
  }

  function showToast(message) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
  }

  function createNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function createSvg(tag, attributes = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) {
      node.setAttribute(key, String(value));
    }
    return node;
  }

  function attendanceNow() {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false,
      }).formatToParts(new Date()).map((part) => [part.type, part.value]),
    );
    return new Date(
      number(values.year),
      number(values.month) - 1,
      number(values.day),
      number(values.hour) % 24,
      number(values.minute),
      number(values.second),
    );
  }

  function validDateKey(value) {
    const key = String(value || '');
    return parserApi && parserApi.parseLocalDate(key) ? key : '';
  }

  function normalizedDetectedCycle(value) {
    if (!value || typeof value !== 'object') return null;
    const start = validDateKey(value.start);
    const end = validDateKey(value.end);
    if (!start || !end || start > end) return null;
    const startDate = parserApi.parseLocalDate(start);
    const endDate = parserApi.parseLocalDate(end);
    const spanDays = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
    if (spanDays > 62) return null;
    const cutoff = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(value.cutoff || ''))
      ? String(value.cutoff)
      : '';
    return { start, end, cutoff };
  }

  function detectedCycleKey(cycle) {
    return `${cycle.start}|${cycle.end}`;
  }

  function detectedCycles() {
    const cycles = new Map();
    const candidates = [
      ...(Array.isArray(baseReport.detected_cycles) ? baseReport.detected_cycles : []),
      baseReport.period?.cycle,
    ];
    for (const candidate of candidates) {
      const cycle = normalizedDetectedCycle(candidate);
      if (cycle) cycles.set(detectedCycleKey(cycle), cycle);
    }
    return [...cycles.values()].sort(
      (left, right) => right.end.localeCompare(left.end) || right.start.localeCompare(left.start),
    );
  }

  function normalizePeriod(value) {
    const start = validDateKey(value?.start);
    const end = validDateKey(value?.end);
    if (!start || !end || start > end) return null;
    const supportedModes = new Set(['all', 'detected', 'natural', 'cycle', 'custom']);
    const mode = supportedModes.has(value?.mode) ? value.mode : 'custom';
    const cycle = mode === 'detected' ? normalizedDetectedCycle(value?.cycle) : null;
    return { mode, start, end, cycle };
  }

  function monthReference(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const date = new Date(year, month - 1, 15);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1) return null;
    return date;
  }

  function shortDate(value) {
    return String(value || '').slice(5).replace('-', '/');
  }

  function sourceCoverage() {
    const first = String(baseReport.source?.first_message_at || '').slice(0, 10);
    const last = String(baseReport.source?.last_message_at || '').slice(0, 10);
    return {
      first: validDateKey(first),
      last: validDateKey(last),
    };
  }

  function allDataRange() {
    const dates = [];
    const include = (value) => {
      const date = validDateKey(value);
      if (date) dates.push(date);
    };
    const coverage = sourceCoverage();
    include(coverage.first);
    include(coverage.last);
    for (const event of Array.isArray(baseReport.events) ? baseReport.events : []) {
      include(event?.date);
    }
    for (const adjustment of Array.isArray(baseReport.manual_adjustments)
      ? baseReport.manual_adjustments
      : []) {
      include(adjustment?.date);
    }
    for (const entry of state.reconciliations.values()) {
      include(entry?.date);
    }
    if (!dates.length) {
      include(baseReport.period?.start);
      include(baseReport.period?.end);
    }
    dates.sort();
    if (!dates.length) throw new Error('当前报告没有可统计的数据范围。');
    return { start: dates[0], end: dates[dates.length - 1] };
  }

  function periodSelectionFromForm() {
    const mode = state.periodDraftMode;
    if (mode === 'all') {
      return {
        period: { mode, ...allDataRange(), cycle: null },
        cycleStartDay: state.cycleStartDay,
      };
    }

    if (mode === 'detected') {
      const cycle = detectedCycles().find(
        (candidate) => detectedCycleKey(candidate) === $('#detected-cycle-select').value,
      );
      if (!cycle) throw new Error('当前报告没有可用的考勤周期。');
      return {
        period: {
          mode,
          start: cycle.start,
          end: cycle.end,
          cycle,
        },
        cycleStartDay: state.cycleStartDay,
      };
    }

    if (mode === 'natural') {
      const reference = monthReference($('#natural-month').value);
      if (!reference) throw new Error('请选择有效的自然月。');
      const range = parserApi.getNaturalMonthRange(reference);
      return {
        period: { mode, ...range, cycle: null },
        cycleStartDay: state.cycleStartDay,
      };
    }

    if (mode === 'cycle') {
      const reference = monthReference($('#cycle-month').value);
      const startDay = Number($('#cycle-start-day').value);
      if (!reference) throw new Error('请选择固定周期的归属月份。');
      if (!Number.isInteger(startDay) || startDay < 1 || startDay > 28) {
        throw new Error('每月周期起始日必须是 1–28 的整数。');
      }
      const range = parserApi.getCycleRange(reference, startDay);
      return {
        period: { mode, ...range, cycle: null },
        cycleStartDay: startDay,
      };
    }

    const start = validDateKey($('#custom-period-start').value);
    const end = validDateKey($('#custom-period-end').value);
    if (!start || !end) throw new Error('请填写有效的开始日期和结束日期。');
    if (start > end) throw new Error('开始日期不能晚于结束日期。');
    return {
      period: { mode: 'custom', start, end, cycle: null },
      cycleStartDay: state.cycleStartDay,
    };
  }

  function populateDetectedCycleOptions(cycles, selectedPeriod) {
    const select = $('#detected-cycle-select');
    const coverage = sourceCoverage();
    const options = cycles.map((cycle) => {
      const option = document.createElement('option');
      option.value = detectedCycleKey(cycle);
      const cutoff = cycle.cutoff
        ? ` · ${shortDate(cycle.cutoff.slice(0, 10))} ${cycle.cutoff.slice(11)} 封账`
        : '';
      const partial = coverage.first && cycle.start < coverage.first ? ' · 消息覆盖不完整' : '';
      option.textContent = `${cycle.start} → ${cycle.end}${cutoff}${partial}`;
      return option;
    });
    if (!options.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '未从消息中识别到封账周期';
      options.push(option);
    }
    select.replaceChildren(...options);
    const matching = cycles.find(
      (cycle) => cycle.start === selectedPeriod.start && cycle.end === selectedPeriod.end,
    );
    if (matching) select.value = detectedCycleKey(matching);
  }

  function initializePeriodSelection() {
    const initial = normalizePeriod(baseReport.period)
      || normalizePeriod({
        mode: 'custom',
        start: baseReport.config?.rangeStart,
        end: baseReport.config?.rangeEnd,
      });
    if (!initial) throw new Error('报告缺少有效的统计周期。');

    const cycles = detectedCycles();
    const matchingCycle = cycles.find(
      (cycle) => cycle.start === initial.start && cycle.end === initial.end,
    );
    state.activePeriod = {
      ...initial,
      cycle: initial.mode === 'detected' ? (matchingCycle || initial.cycle) : null,
    };
    state.periodDraftMode = initial.mode === 'detected' && !cycles.length
      ? 'custom'
      : initial.mode;
    state.cycleStartDay = Math.max(
      1,
      Math.min(28, Number(baseReport.config?.cycleStartDay) || 1),
    );

    populateDetectedCycleOptions(cycles, state.activePeriod);
    const currentMonth = todayKey().slice(0, 7);
    $('#natural-month').value = initial.mode === 'natural'
      ? initial.start.slice(0, 7)
      : currentMonth;
    $('#cycle-month').value = initial.mode === 'cycle'
      ? initial.end.slice(0, 7)
      : currentMonth;
    $('#cycle-start-day').value = String(state.cycleStartDay);
    $('#custom-period-start').value = initial.start;
    $('#custom-period-end').value = initial.end;
    const allRange = allDataRange();
    setText('#all-period-range', `${allRange.start} → ${allRange.end}`);
  }

  function renderPeriodControls() {
    const cycles = detectedCycles();
    const mode = state.periodDraftMode;
    const availableRange = allDataRange();
    setText('#all-period-range', `${availableRange.start} → ${availableRange.end}`);
    for (const button of document.querySelectorAll('[data-period-mode]')) {
      const active = button.dataset.periodMode === mode;
      button.setAttribute('aria-pressed', String(active));
      if (button.dataset.periodMode === 'detected') button.disabled = !cycles.length;
    }
    for (const panel of document.querySelectorAll('[data-period-panel]')) {
      panel.hidden = panel.dataset.periodPanel !== mode;
    }
    setText('#detected-cycle-count', cycles.length);

    const period = state.activePeriod;
    const cutoff = period?.cycle?.cutoff ? ` · ${period.cycle.cutoff} 封账` : '';
    setText(
      '#period-active',
      period
        ? `${periodModeLabel(period.mode)} · ${period.start} → ${period.end}${cutoff}`
        : '当前周期 —',
    );

    const coverage = sourceCoverage();
    const parts = [
      `已识别 ${cycles.length} 个考勤周期`,
      coverage.first && coverage.last
        ? `消息覆盖 ${coverage.first} 至 ${coverage.last}`
        : '消息覆盖范围未知',
      '选择后自动加载；手动补充按日期跨周期共享',
    ];
    const historicalGap = Boolean(period && coverage.first && period.start < coverage.first);
    if (historicalGap) {
      parts.push(`${period.start} 至 ${coverage.first} 前的数据可能不完整`);
    }
    setText('#period-data-note', parts.join(' · '));
    $('#period-data-note').dataset.tone = historicalGap ? 'warning' : '';
  }

  function setPeriodDraftMode(mode) {
    if (!['all', 'detected', 'natural', 'cycle', 'custom'].includes(mode)) return;
    if (mode === 'detected' && !detectedCycles().length) return;
    state.periodDraftMode = mode;
    setText('#period-error', '');
    renderPeriodControls();
    applyPeriodSelection();
  }

  function applyPeriodSelection() {
    window.clearTimeout(periodApplyTimer);
    periodApplyTimer = null;
    setText('#period-error', '');
    let selection;
    try {
      selection = periodSelectionFromForm();
    } catch (error) {
      setText('#period-error', error.message || String(error));
      return;
    }

    const previous = {
      activePeriod: state.activePeriod,
      cycleStartDay: state.cycleStartDay,
      reconciliations: state.reconciliations,
      baselineRows: state.baselineRows,
      report,
    };
    state.activePeriod = selection.period;
    state.periodDraftMode = selection.period.mode;
    state.cycleStartDay = selection.cycleStartDay;
    try {
      loadReconciliations();
      recomputeReport();
    } catch (error) {
      state.activePeriod = previous.activePeriod;
      state.cycleStartDay = previous.cycleStartDay;
      state.reconciliations = previous.reconciliations;
      state.baselineRows = previous.baselineRows;
      report = previous.report;
      setText('#period-error', `周期计算失败：${error.message || error}`);
      return;
    }

    state.query = '';
    $('#table-search').value = '';
    renderAll();
    setFilter('all');
    showToast(`${selection.period.start} 至 ${selection.period.end} 已重新计算`);
  }

  function schedulePeriodSelection() {
    window.clearTimeout(periodApplyTimer);
    periodApplyTimer = window.setTimeout(applyPeriodSelection, 80);
  }

  function reconciliationStorageKey() {
    return RECONCILIATION_STORAGE_KEY;
  }

  function normalizeReconciliation(value) {
    if (!value || typeof value !== 'object') return null;
    const date = String(value.date || '');
    if (!validDateKey(date)) return null;
    const outcome = RECONCILIATION_TYPES[value.outcome] ? value.outcome : 'confirmed';
    const adjustment = outcome === 'confirmed'
      ? null
      : parserApi.normalizeManualAdjustment(value.adjustment || {
        date,
        type: outcome,
        note: value.note,
      });
    if (outcome !== 'confirmed' && !adjustment) return null;
    return {
      date,
      reviewed: true,
      outcome,
      adjustment,
      note: String(value.note || adjustment?.note || '').trim().slice(0, 300),
      updatedAt: String(value.updatedAt || ''),
    };
  }

  function mergeReconciliationEntries(entries) {
    for (const value of entries) {
      const entry = normalizeReconciliation(value);
      if (!entry) continue;
      const existing = state.reconciliations.get(entry.date);
      if (!existing || entry.updatedAt >= existing.updatedAt) {
        state.reconciliations.set(entry.date, entry);
      }
    }
  }

  function parseStoredReconciliations(raw) {
    try {
      const stored = JSON.parse(raw || 'null');
      return Array.isArray(stored?.entries) ? stored.entries : [];
    } catch (_) {
      return [];
    }
  }

  function loadReconciliations() {
    state.reconciliations = new Map();
    try {
      const globalValue = localStorage.getItem(reconciliationStorageKey());
      if (globalValue !== null) {
        mergeReconciliationEntries(parseStoredReconciliations(globalValue));
        state.storageAvailable = true;
        return;
      }

      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(LEGACY_RECONCILIATION_STORAGE_PREFIX)) continue;
        mergeReconciliationEntries(
          parseStoredReconciliations(localStorage.getItem(key)),
        );
      }
      saveReconciliations();
    } catch (_) {
      state.storageAvailable = false;
    }
  }

  function saveReconciliations() {
    try {
      localStorage.setItem(
        reconciliationStorageKey(),
        JSON.stringify({
          version: RECONCILIATION_VERSION,
          updatedAt: new Date().toISOString(),
          entries: [...state.reconciliations.values()],
        }),
      );
      state.storageAvailable = true;
      return true;
    } catch (_) {
      state.storageAvailable = false;
      return false;
    }
  }

  function baseManualAdjustments() {
    const values = Array.isArray(baseReport.manual_adjustments)
      ? baseReport.manual_adjustments
      : baseReport.rows.map((row) => row.manual).filter(Boolean);
    const mergedValues = typeof parserApi.mergeManualAdjustments === 'function'
      ? parserApi.mergeManualAdjustments(values)
      : values;
    const adjustments = new Map();
    for (const value of mergedValues) {
      const adjustment = parserApi.normalizeManualAdjustment(value);
      if (adjustment) adjustments.set(adjustment.date, adjustment);
    }
    return adjustments;
  }

  function effectiveManualAdjustments() {
    const values = [...baseManualAdjustments().values()];
    for (const entry of state.reconciliations.values()) {
      if (entry.adjustment) values.push(entry.adjustment);
    }
    const mergedValues = typeof parserApi.mergeManualAdjustments === 'function'
      ? parserApi.mergeManualAdjustments(values)
      : values;
    const adjustments = new Map();
    for (const value of mergedValues) {
      const adjustment = parserApi.normalizeManualAdjustment(value);
      if (adjustment) adjustments.set(adjustment.date, adjustment);
    }
    return adjustments;
  }

  function recomputeReport() {
    if (!parserApi || typeof parserApi.buildDailySummary !== 'function') {
      throw new Error('未能载入油猴脚本的考勤计算核心。');
    }
    if (!Array.isArray(baseReport.events) || !baseReport.config) {
      throw new Error('报告缺少网页核对所需的数据，请重新运行采集命令生成。');
    }
    const period = state.activePeriod;
    if (!period) throw new Error('尚未选择有效的统计周期。');
    const config = {
      ...baseReport.config,
      cycleStartDay: state.cycleStartDay,
      rangeStart: period.start,
      rangeEnd: period.end,
    };
    const now = attendanceNow();
    const baseline = parserApi.buildDailySummary(
      baseReport.events,
      config,
      now,
      [...baseManualAdjustments().values()],
    );
    if (baseline.error) throw new Error(baseline.error);
    state.baselineRows = baseline.rows;

    const adjustments = [...effectiveManualAdjustments().values()];
    const result = parserApi.buildDailySummary(
      baseReport.events,
      config,
      now,
      adjustments,
    );
    if (result.error) throw new Error(result.error);
    const activeAdjustments = adjustments.filter(
      (adjustment) => adjustment.date >= period.start && adjustment.date <= period.end,
    );
    report = {
      ...baseReport,
      period: { ...period },
      config,
      manual_adjustment_count: activeAdjustments.length,
      manual_adjustments: activeAdjustments,
      totals: result.totals,
      rows: result.rows,
    };
  }

  function reconciliationFor(date) {
    return state.reconciliations.get(date) || null;
  }

  function isReviewed(rowOrDate) {
    const date = typeof rowOrDate === 'string' ? rowOrDate : rowOrDate.date;
    return Boolean(reconciliationFor(date)?.reviewed);
  }

  function isAttentionRow(row) {
    return row.status !== '未到' && Boolean(row.abnormal || row.pending);
  }

  function isUnresolvedAttentionRow(row) {
    return isAttentionRow(row) && !isReviewed(row);
  }

  function reviewTargetDates() {
    const dates = new Set();
    for (const rows of [state.baselineRows || [], report.rows || []]) {
      for (const row of rows) {
        if (isAttentionRow(row)) dates.add(row.date);
      }
    }
    return dates;
  }

  function initializeTheme() {
    let saved = '';
    try {
      saved = localStorage.getItem('attendance-report-theme') || '';
    } catch (_) {
      saved = '';
    }
    const preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = saved || preferred;
    $('#theme-toggle').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('attendance-report-theme', next);
      } catch (_) {
        // Local file storage may be unavailable; the current page still updates.
      }
      renderChart();
    });
  }

  function renderHeader() {
    const period = report.period || {};
    const source = report.source || {};
    const range = `${period.start || '—'} 至 ${period.end || '—'}`;
    const ownerName = String(report.owner_name || report.ownerName || '')
      .replace(/\s+/g, ' ')
      .trim();
    const title = ownerName ? `${ownerName}的考勤报告` : '我的考勤报告';
    setText('#page-title', title);
    setText('#hero-period', range);
    setText('#source-method', `数据源 ${source.method === 'lark-cli-user-im' ? 'lark-cli 用户消息' : source.method || '未知'}`);
    setText('#source-count', `消息 ${number(source.message_count)} 条 · 解析 ${number(report.parsed_event_count)} 条`);
    setText('#generated-time', `生成 ${formatDateTime(report.generated_at)}`);
    setText('#footer-period', range);
    document.title = title;
  }

  function metric(value, label, note, tone = '') {
    const card = createNode('div', 'metric');
    if (tone) card.dataset.tone = tone;
    const labelNode = createNode('span', 'metric-label');
    labelNode.append(createNode('i', 'metric-dot'), document.createTextNode(label));
    card.append(
      labelNode,
      createNode('strong', '', value),
      createNode('small', '', note),
    );
    return card;
  }

  function renderMetrics() {
    const totals = report.totals || {};
    const completeWorkDays = number(totals.completeWorkDays);
    const fullLeaveWorkDays = number(totals.fullLeaveWorkDays);
    const halfLeaveWorkDays = number(totals.halfLeaveWorkDays);
    const excludedHalfLeaveDays = number(totals.excludedHalfLeaveDays);
    const travelWorkDays = number(totals.travelWorkDays);
    const averageAttendanceDays = hasNumericValue(totals.averageAttendanceDays)
      ? number(totals.averageAttendanceDays)
      : Math.max(0, completeWorkDays - excludedHalfLeaveDays);
    const averageWorkDays = hasNumericValue(totals.averageWorkDays)
      ? number(totals.averageWorkDays)
      : averageAttendanceDays + travelWorkDays;
    const metrics = [
      [number(totals.workdays), '应出勤', '周期内已到工作日', 'primary'],
      [number(totals.attended), '有记录', '工作日有效状态', 'success'],
      [number(totals.normal), '正常', '无异常工作日', 'success'],
      [number(totals.abnormal), '异常', '迟到、早退或缺卡', number(totals.abnormal) ? 'danger' : ''],
      [number(totals.pending), '待核对', '缺少完整依据', number(totals.pending) ? 'warning' : ''],
      [formatMinutes(totals.overtimeMinutes), '加班总计', `${number(totals.overtimeDays)} 个加班日`, number(totals.overtimeMinutes) ? 'primary' : ''],
      [number(totals.restDayOvertimeDays), '周末/节假日加班', '完整上下班卡的天数', number(totals.restDayOvertimeDays) ? 'primary' : ''],
      [formatMinutes(totals.averageOvertimeMinutes), '平均加班', `${completeWorkDays} 个完整出勤日（含 0 加班）`, ''],
      [
        formatMinutes(totals.averageWorkMinutes),
        '平均工时',
        `${averageWorkDays} 个计入均值日${halfLeaveWorkDays ? `，含 ${halfLeaveWorkDays} 个半天假` : ''}${travelWorkDays ? `，含 ${travelWorkDays} 个工作日出差` : ''}${fullLeaveWorkDays ? `；${fullLeaveWorkDays} 天全天假已排除` : ''}`,
        '',
      ],
    ];
    const grid = $('#metric-grid');
    grid.replaceChildren(...metrics.map((item) => metric(...item)));

    const elapsed = report.rows.filter((row) => row.workday && row.status !== '未到');
    const covered = elapsed.filter((row) => number(row.evidenceCount) > 0 || row.manual);
    const coverage = elapsed.length ? Math.round((covered.length / elapsed.length) * 100) : 0;
    setText('#coverage-chip', `记录覆盖 ${coverage}%`);
    const targets = reviewTargetDates();
    const reviewed = [...targets].filter((date) => isReviewed(date)).length;
    setText(
      '#review-progress-chip',
      targets.size ? `核对进度 ${reviewed}/${targets.size}` : '无需额外核对',
    );
  }

  function configuredDateCount(value) {
    return String(value || '')
      .split(/[\s,，;；]+/)
      .map((item) => validDateKey(item))
      .filter(Boolean)
      .length;
  }

  function scheduleRuleDescription(config) {
    const grace = Math.max(0, number(config.graceMinutes));
    let schedule = '';
    if (config.scheduleMode === 'fixed') {
      schedule = `固定班次 ${config.workStart || '—'}–${config.workEnd || '—'}`;
    } else if (config.scheduleMode === 'flex-window') {
      schedule = `独立弹性：上班 ${config.flexStartEarliest || '—'}–${config.flexStartLatest || '—'}，下班 ${config.flexEndEarliest || '—'}–${config.flexEndLatest || '—'}`;
    } else {
      schedule = `弹性联动：上班 ${config.flexStartEarliest || '—'}–${config.flexStartLatest || '—'}，对应下班 ${config.flexEndEarliest || '—'}–${config.flexEndLatest || '—'}`;
    }
    return `${schedule}；迟到/早退宽限 ${grace} 分钟。`;
  }

  function renderCalculationRules() {
    const totals = report.totals || {};
    const config = report.config || {};
    const period = report.period || {};
    const completeWorkDays = number(totals.completeWorkDays);
    const fullLeaveWorkDays = number(totals.fullLeaveWorkDays);
    const halfLeaveWorkDays = number(totals.halfLeaveWorkDays);
    const excludedHalfLeaveDays = number(totals.excludedHalfLeaveDays);
    const travelWorkDays = number(totals.travelWorkDays);
    const averageAttendanceDays = hasNumericValue(totals.averageAttendanceDays)
      ? number(totals.averageAttendanceDays)
      : Math.max(0, completeWorkDays - excludedHalfLeaveDays);
    const averageWorkDays = hasNumericValue(totals.averageWorkDays)
      ? number(totals.averageWorkDays)
      : averageAttendanceDays + travelWorkDays;
    const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const workdays = (Array.isArray(config.workdays) ? config.workdays : [])
      .map(Number)
      .filter((day) => day >= 0 && day <= 6)
      .map((day) => weekdayNames[day]);
    const holidayCount = configuredDateCount(config.holidayDates);
    const extraWorkdayCount = configuredDateCount(config.extraWorkDates);

    setText(
      '#rules-current-summary',
      `当前周期 ${period.start || '—'} 至 ${period.end || '—'} · 所有结果均由同一计算核心实时重算`,
    );
    setText(
      '#rule-scope-detail',
      '只统计当前周期内的消息、审批记录与本地补充；未来日期显示为“未到”。周末出差、普通休息日和法定节假日不进入“有记录”、应出勤、工时或平均值；休息日/节假日上下班卡完整时只另计加班天数。',
    );
    setText(
      '#rule-workday-detail',
      `固定工作日：${workdays.length ? workdays.join('、') : '未设置'}；配置的法定节假日 ${holidayCount} 天，额外工作日 ${extraWorkdayCount} 天。额外工作日优先于配置的法定节假日，逐日核对为“法定节假日”时则以核对结果为准。`,
    );
    setText(
      '#rule-punch-detail',
      `同一天取最早上班卡和最晚下班卡；未标明类型的时间以 ${config.unknownSplitTime || '14:00'} 为界拆分，次日 ${config.overnightClockOutCutoff || '06:00'} 前的下班卡归前一考勤日。`,
    );
    setText('#rule-schedule-detail', scheduleRuleDescription(config));
    setText(
      '#rule-missing-detail',
      config.noMessageAsMissing
        ? '工作日无消息按缺卡处理；法定节假日、补卡、请假、出差和外勤会覆盖对应机器人异常后重新计算。'
        : '工作日无消息默认标记“待核对”；法定节假日、补卡、请假、出差和外勤会覆盖对应机器人异常后重新计算。',
    );
    setText(
      '#rule-overtime-current',
      completeWorkDays
        ? `当前周期：${formatMinutes(totals.overtimeMinutes)} ÷ ${completeWorkDays} 个完整出勤日 = ${formatMinutes(totals.averageOvertimeMinutes)}。`
        : '当前周期暂无完整出勤日，平均加班为 0 分。',
    );
    setText(
      '#rule-work-current',
      averageWorkDays
        ? `当前周期：${formatMinutes(totals.workMinutes)} ÷ ${averageWorkDays} 个计入均值日 = ${formatMinutes(totals.averageWorkMinutes)}；纳入半天假 ${halfLeaveWorkDays} 天（请假额度 ${formatMinutes(totals.halfLeaveCreditMinutes)}），工作日出差 ${travelWorkDays} 天；全天请假 ${fullLeaveWorkDays} 天、取消纳入的半天假 ${excludedHalfLeaveDays} 天均已排除。`
        : '当前周期暂无可计入平均工时的日期，平均工时为 0 分。',
    );
  }

  function attentionRows() {
    return report.rows.filter(isAttentionRow);
  }

  function unresolvedAttentionRows() {
    return report.rows.filter(isUnresolvedAttentionRow);
  }

  function renderAttention() {
    const rows = attentionRows();
    const unresolved = unresolvedAttentionRows();
    const targets = reviewTargetDates();
    const card = $('#attention-card');
    card.hidden = targets.size === 0;
    if (!targets.size) return;
    const button = $('#show-attention');
    if (!unresolved.length) {
      card.dataset.state = 'complete';
      setText('#attention-title', '核对已完成');
      setText('#attention-copy', `本周期 ${targets.size} 个需关注日期均已在本地核对。`);
      button.textContent = '查看已核对';
      button.dataset.targetFilter = 'reviewed';
      return;
    }
    card.dataset.state = 'attention';
    const abnormal = rows.filter((row) => row.abnormal).length;
    const pending = rows.filter((row) => row.pending).length;
    setText('#attention-title', '需要核对');
    setText(
      '#attention-copy',
      `本周期有 ${abnormal} 个异常日、${pending} 个待核对日，尚有 ${unresolved.length} 天未处理。`,
    );
    button.textContent = '开始核对';
    button.dataset.targetFilter = 'attention';
  }

  function renderReviewList() {
    const container = $('#review-list');
    const rows = unresolvedAttentionRows()
      .sort((left, right) => right.date.localeCompare(left.date))
      .slice(0, 8);
    if (!rows.length) {
      const empty = createNode('div', 'review-empty');
      const wrapper = createNode('div');
      const icon = createSvg('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' });
      icon.append(createSvg('path', {
        d: 'm5 12 4 4L19 6',
        stroke: 'currentColor',
        'stroke-width': '1.8',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }));
      wrapper.append(
        icon,
        createNode(
          'div',
          '',
          reviewTargetDates().size
            ? '需要关注的日期均已核对完成。'
            : '当前周期没有需要核对的日期。',
        ),
      );
      empty.append(wrapper);
      container.replaceChildren(empty);
      return;
    }
    const items = rows.map((row) => {
      const button = createNode('button', 'review-item');
      button.type = 'button';
      button.dataset.date = row.date;
      const date = createNode('span', 'review-date', row.date.slice(5).replace('-', '/'));
      const content = createNode('span');
      content.append(
        createNode('span', 'review-status', row.status || '待核对'),
        createNode('span', 'review-time', `${row.clockIn || '—'} → ${row.clockOut || '—'}`),
      );
      button.append(date, content, createNode('span', 'review-arrow', '›'));
      button.addEventListener('click', () => openReconcileDialog(row.date));
      return button;
    });
    container.replaceChildren(...items);
  }

  function overtimeChartData() {
    let overtimeTotal = 0;
    let completeAttendanceDays = 0;
    return parserApi.getOvertimeTrendData(report.rows).map((item, sourceIndex) => {
      if (item.available) {
        overtimeTotal += Math.max(0, number(item.overtimeMinutes));
        completeAttendanceDays += 1;
      }
      return {
        ...item,
        sourceIndex,
        averageMinutes: item.available
          ? overtimeTotal / completeAttendanceDays
          : null,
      };
    });
  }

  function smoothSeriesPath(points) {
    if (!points.length) return '';
    let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const middle = (previous.x + current.x) / 2;
      path += ` C ${middle.toFixed(2)} ${previous.y.toFixed(2)}, ${middle.toFixed(2)} ${current.y.toFixed(2)}, ${current.x.toFixed(2)} ${current.y.toFixed(2)}`;
    }
    return path;
  }

  function legendItem(swatchClass, label, direction = '') {
    const item = createNode('span');
    item.append(createNode('i', swatchClass));
    if (direction) {
      item.append(createNode('b', `legend-direction ${direction}`.trim(), direction === 'up' ? '▲' : direction === 'down' ? '▼' : '—'));
    }
    item.append(document.createTextNode(label));
    return item;
  }

  function renderChartLegend(mode, gapCount) {
    const items = mode === 'candlestick'
      ? [
        legendItem('legend-candle up', '增加', 'up'),
        legendItem('legend-candle down', '减少', 'down'),
        legendItem('legend-candle flat', '持平', 'flat'),
      ]
      : [legendItem('legend-swatch', '每日加班')];
    items.push(legendItem('legend-swatch average', '累计平均加班'));
    if (gapCount) items.push(legendItem('legend-swatch gap', '跨缺卡日'));
    $('#chart-legend').replaceChildren(...items);
  }

  function renderChart() {
    const svg = $('#overtime-chart');
    svg.replaceChildren();
    const mode = state.chartMode === 'line' ? 'line' : 'candlestick';
    const isCandlestick = mode === 'candlestick';
    const trend = overtimeChartData();
    const available = trend.filter((item) => item.available);
    const gaps = trend.filter((item) => !item.available);
    const height = 260;
    const margin = { top: 22, right: 28, bottom: 42, left: 48 };
    const horizontalCount = Math.max(1, isCandlestick ? available.length : trend.length);
    const width = Math.max(720, margin.left + margin.right + Math.max(1, horizontalCount - 1) * 36);
    const plotRight = width - margin.right;
    const plotBottom = height - margin.bottom;
    const plotWidth = plotRight - margin.left;
    const plotHeight = plotBottom - margin.top;
    const maximum = Math.max(
      60,
      ...available.map((item) => number(item.highMinutes)),
      ...available.map((item) => number(item.averageMinutes)),
    );
    const yMaximum = Math.max(60, Math.ceil(maximum / 60) * 60);
    const fullSpacing = horizontalCount > 1 ? plotWidth / (horizontalCount - 1) : 34;
    const pointSpacing = isCandlestick ? Math.min(38, fullSpacing) : fullSpacing;
    const occupiedWidth = horizontalCount > 1 ? pointSpacing * (horizontalCount - 1) : 0;
    const xStart = isCandlestick
      ? margin.left + (plotWidth - occupiedWidth) / 2
      : margin.left;
    const xAt = (index) => horizontalCount === 1
      ? margin.left + plotWidth / 2
      : xStart + index * pointSpacing;
    const yAt = (minutes) => (
      plotBottom - (Math.max(0, Math.min(yMaximum, number(minutes))) / yMaximum) * plotHeight
    );
    let candleIndex = 0;
    const plotted = trend.map((item, index) => {
      const x = isCandlestick
        ? (item.available ? xAt(candleIndex++) : null)
        : xAt(index);
      return {
        ...item,
        x,
        y: item.available ? yAt(item.closeMinutes) : plotBottom,
        openY: item.available ? yAt(item.openMinutes) : null,
        closeY: item.available ? yAt(item.closeMinutes) : null,
        highY: item.available ? yAt(item.highMinutes) : null,
        lowY: item.available ? yAt(item.lowMinutes) : null,
        averageY: item.available ? yAt(item.averageMinutes) : null,
      };
    });
    const increases = available.filter((item) => item.direction === 'up').length;
    const decreases = available.filter((item) => item.direction === 'down').length;
    const peak = available.reduce(
      (best, item) => (!best || item.overtimeMinutes > best.overtimeMinutes ? item : best),
      null,
    );
    const finalAverage = available.length
      ? available[available.length - 1].averageMinutes
      : 0;
    const peakText = peak && peak.overtimeMinutes > 0
      ? `峰值 ${peak.date.slice(5).replace('-', '/')} · ${formatMinutes(peak.overtimeMinutes)}`
      : '暂无已记录加班';
    const chartTitle = isCandlestick ? '每日加班 K 线' : '每日加班趋势';
    const chartSummary = isCandlestick
      ? `${available.length} 个完整出勤日 · ${increases} 涨 ${decreases} 跌 · ${peakText}`
      : `${available.length} 个完整出勤日 · ${peakText}`;
    const descriptionText = isCandlestick
      ? `K 线开盘值为前一完整出勤日加班时长，收盘值为当日加班时长；绿色表示增加，红色表示减少，灰色表示持平。橙色曲线按截至当日的全部完整出勤日（包含 0 加班日）计算平均加班，最终为 ${formatMinutes(finalAverage)}。`
      : `蓝色曲线展示每日加班时长，橙色曲线按截至当日的全部完整出勤日（包含 0 加班日）计算平均加班，最终为 ${formatMinutes(finalAverage)}。`;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.style.width = `${width}px`;
    svg.dataset.mode = mode;
    svg.dataset.gapCount = String(gaps.length);
    svg.dataset.averageFinal = String(Math.round(finalAverage));
    svg.setAttribute('aria-labelledby', 'overtime-chart-svg-title overtime-chart-svg-desc');
    const title = createSvg('title', { id: 'overtime-chart-svg-title' });
    title.textContent = chartTitle;
    const description = createSvg('desc', { id: 'overtime-chart-svg-desc' });
    description.textContent = descriptionText;
    svg.append(title, description);

    for (let index = 0; index <= 4; index += 1) {
      const ratio = index / 4;
      const y = margin.top + plotHeight - ratio * plotHeight;
      svg.append(createSvg('line', {
        x1: margin.left,
        y1: y,
        x2: plotRight,
        y2: y,
        class: 'chart-grid-line',
      }));
      const label = createSvg('text', {
        x: margin.left - 8,
        y: y + 3,
        'text-anchor': 'end',
        class: 'chart-axis-label',
      });
      label.textContent = compactMinutes(ratio * yMaximum);
      svg.append(label);
    }

    if (!available.length) {
      const empty = createSvg('text', {
        x: margin.left + plotWidth / 2,
        y: margin.top + plotHeight / 2,
        'text-anchor': 'middle',
        class: 'chart-axis-label',
      });
      empty.textContent = '暂无完整上下班记录，无法绘制加班图表';
      svg.append(empty);
    } else if (isCandlestick) {
      const candleWidth = Math.max(8, Math.min(14, pointSpacing * 0.48));
      const hitWidth = Math.max(candleWidth + 8, Math.min(28, pointSpacing * 0.9));
      let previous = null;
      for (const item of plotted) {
        if (!item.available) continue;
        if (previous) {
          const connector = createSvg('path', {
            d: `M ${(previous.x + candleWidth / 2).toFixed(2)} ${previous.closeY.toFixed(2)} L ${(item.x - candleWidth / 2).toFixed(2)} ${item.openY.toFixed(2)}`,
            class: `chart-candle-connector${item.sourceIndex - previous.sourceIndex > 1 ? ' through-gap' : ''}`,
            'aria-hidden': 'true',
          });
          svg.append(connector);
        }
        previous = item;
      }

      for (const item of plotted) {
        if (!item.available) continue;
        const rawBodyHeight = Math.abs(item.closeY - item.openY);
        const bodyHeight = Math.max(3, rawBodyHeight);
        const bodyTop = Math.min(item.openY, item.closeY);
        const bodyY = Math.max(
          margin.top,
          Math.min(plotBottom - bodyHeight, bodyTop - (bodyHeight - rawBodyHeight) / 2),
        );
        const comparison = item.comparisonDate
          ? `前一有效日 ${item.comparisonDate.slice(5).replace('-', '/')} ${formatMinutes(item.openMinutes)}`
          : '首个有效日';
        const change = item.changeMinutes > 0
          ? `增加 ${formatMinutes(item.changeMinutes)}`
          : item.changeMinutes < 0
            ? `减少 ${formatMinutes(Math.abs(item.changeMinutes))}`
            : '持平';
        const tooltipText = `${item.date} ${item.weekday}｜${comparison}｜当日 ${formatMinutes(item.closeMinutes)}｜${change}｜累计平均 ${formatMinutes(item.averageMinutes)}`;
        const group = createSvg('g', {
          class: `chart-point chart-candle-point ${item.direction}`,
          tabindex: '0',
          role: 'img',
          'aria-label': tooltipText,
        });
        group.append(
          createSvg('rect', {
            x: item.x - hitWidth / 2,
            y: margin.top,
            width: hitWidth,
            height: plotHeight,
            class: 'chart-hit',
          }),
          createSvg('rect', {
            x: item.x - candleWidth / 2 - 5,
            y: Math.max(margin.top, bodyY - 5),
            width: candleWidth + 10,
            height: Math.max(13, bodyHeight + 10),
            rx: 5,
            class: 'chart-focus',
          }),
          createSvg('line', {
            x1: item.x,
            y1: item.highY,
            x2: item.x,
            y2: item.lowY,
            class: 'chart-candle-wick',
          }),
        );
        if (item.direction === 'flat') {
          group.append(createSvg('line', {
            x1: item.x - candleWidth / 2,
            y1: item.closeY,
            x2: item.x + candleWidth / 2,
            y2: item.closeY,
            class: 'chart-candle-doji',
          }));
        } else {
          group.append(createSvg('rect', {
            x: item.x - candleWidth / 2,
            y: bodyY,
            width: candleWidth,
            height: bodyHeight,
            rx: 1.5,
            class: 'chart-candle-body',
          }));
        }
        const tooltip = createSvg('title');
        tooltip.textContent = tooltipText;
        group.append(tooltip);
        svg.append(group);
      }
    } else {
      const segments = [];
      let segment = [];
      for (const item of plotted) {
        if (item.available) {
          segment.push(item);
        } else if (segment.length) {
          segments.push(segment);
          segment = [];
        }
      }
      if (segment.length) segments.push(segment);
      for (const points of segments) {
        if (points.length > 1) {
          const areaPath = `${smoothSeriesPath(points)} L ${points[points.length - 1].x.toFixed(2)} ${plotBottom} L ${points[0].x.toFixed(2)} ${plotBottom} Z`;
          svg.append(createSvg('path', { d: areaPath, class: 'chart-daily-area' }));
        }
        svg.append(createSvg('path', {
          d: smoothSeriesPath(points),
          class: 'chart-daily-line',
        }));
      }
      for (const item of plotted) {
        const tooltipText = item.available
          ? `${item.date} ${item.weekday}｜加班 ${formatMinutes(item.overtimeMinutes)}｜累计平均 ${formatMinutes(item.averageMinutes)}`
          : `${item.date} ${item.weekday}｜暂无完整上下班记录｜${item.status}`;
        const group = createSvg('g', {
          class: `chart-point ${item.available ? 'chart-line-point' : 'chart-gap-point'}`,
          tabindex: '0',
          role: 'img',
          'aria-label': tooltipText,
        });
        group.append(
          createSvg('rect', {
            x: item.x - 12,
            y: margin.top,
            width: 24,
            height: plotHeight,
            class: 'chart-hit',
          }),
          createSvg('rect', {
            x: item.x - 9,
            y: item.y - 9,
            width: 18,
            height: 18,
            rx: 5,
            class: 'chart-focus',
          }),
          createSvg('circle', {
            cx: item.x,
            cy: item.y,
            r: 4,
            class: item.available ? '' : 'chart-gap-marker',
          }),
        );
        const tooltip = createSvg('title');
        tooltip.textContent = tooltipText;
        group.append(tooltip);
        svg.append(group);
      }
    }

    const averagePoints = plotted.filter((item) => item.available);
    for (let index = 1; index < averagePoints.length; index += 1) {
      const previous = averagePoints[index - 1];
      const current = averagePoints[index];
      const middle = (previous.x + current.x) / 2;
      const curve = createSvg('path', {
        d: `M ${previous.x.toFixed(2)} ${previous.averageY.toFixed(2)} C ${middle.toFixed(2)} ${previous.averageY.toFixed(2)}, ${middle.toFixed(2)} ${current.averageY.toFixed(2)}, ${current.x.toFixed(2)} ${current.averageY.toFixed(2)}`,
        class: `chart-average-curve${current.sourceIndex - previous.sourceIndex > 1 ? ' through-gap' : ''}`,
        'data-average-start': Math.round(previous.averageMinutes),
        'data-average-end': Math.round(current.averageMinutes),
      });
      svg.append(curve);
    }
    for (const item of averagePoints) {
      svg.append(createSvg('circle', {
        cx: item.x,
        cy: item.averageY,
        r: 3.2,
        class: 'chart-average-point',
        'data-average-minutes': Math.round(item.averageMinutes),
        'aria-hidden': 'true',
      }));
    }
    if (averagePoints.length) {
      const last = averagePoints[averagePoints.length - 1];
      const averageLabel = createSvg('text', {
        x: Math.min(plotRight, last.x + 5),
        y: Math.max(margin.top + 10, last.averageY - 7),
        'text-anchor': last.x > plotRight - 70 ? 'end' : 'start',
        class: 'chart-average-label',
      });
      averageLabel.textContent = `日均 ${compactMinutes(last.averageMinutes)}`;
      svg.append(averageLabel);
    }

    const labelItems = isCandlestick ? plotted.filter((item) => item.available) : plotted;
    const labelStep = Math.max(1, Math.ceil(labelItems.length / 8));
    labelItems.forEach((item, index) => {
      if (index % labelStep !== 0 && index !== labelItems.length - 1) return;
      const label = createSvg('text', {
        x: item.x,
        y: height - 18,
        'text-anchor': 'middle',
        class: 'chart-axis-label',
      });
      label.textContent = item.date.slice(5).replace('-', '/');
      svg.append(label);
    });

    setText('#chart-title', chartTitle);
    setText('#chart-subtitle', chartSummary);
    setText(
      '#chart-hint',
      isCandlestick
        ? 'K 线比较前一完整出勤日与当日加班；橙色曲线按全部完整出勤日（含 0 加班日）展示累计平均加班。'
        : '蓝色曲线展示每日加班；橙色曲线按全部完整出勤日（含 0 加班日）展示累计平均加班，缺卡日期会断开。',
    );
    for (const button of document.querySelectorAll('[data-chart-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.chartMode === mode));
    }
    renderChartLegend(mode, gaps.length);
  }

  function appendTimeCell(row, value) {
    const cell = document.createElement('td');
    const display = value || '—';
    cell.append(createNode('span', `time-cell${display === '—' ? ' is-empty' : ''}`, display));
    row.append(cell);
  }

  function appendStatusCell(row, value) {
    const cell = document.createElement('td');
    const list = createNode('span', 'status-list');
    const labels = String(value || '—').split('、').filter(Boolean);
    for (const label of labels) {
      list.append(createNode('span', `status-pill ${statusTone(label)}`.trim(), label));
    }
    cell.append(list);
    row.append(cell);
  }

  function appendSourceCell(row, item) {
    const cell = document.createElement('td');
    const stack = createNode('span', 'source-stack');
    const evidenceCount = number(item.evidenceCount);
    if (evidenceCount) {
      const sourceButton = createNode(
        'button',
        'source-chip source-message-button',
        `查看 ${evidenceCount} 条消息`,
      );
      sourceButton.type = 'button';
      sourceButton.dataset.sourceDate = item.date;
      sourceButton.setAttribute('aria-haspopup', 'dialog');
      sourceButton.setAttribute('aria-controls', 'reconcile-dialog');
      sourceButton.setAttribute(
        'aria-label',
        `查看 ${item.date} 的 ${evidenceCount} 条来源消息`,
      );
      sourceButton.addEventListener('click', () => {
        openReconcileDialog(item.date, { focusEvidence: true });
      });
      stack.append(sourceButton);
    }
    if (item.manual) {
      stack.append(createNode('span', 'source-chip manual', item.manualLabel || '本地补充'));
    }
    if (isReviewed(item)) {
      stack.append(createNode('span', 'source-chip reviewed', '已核对'));
    }
    if (!stack.childNodes.length) {
      stack.append(createNode('span', 'source-chip', '无消息'));
    }
    cell.append(stack);
    row.append(cell);
  }

  function filteredRows() {
    const query = state.query.trim().toLocaleLowerCase();
    const today = todayKey();
    const rows = report.rows.filter((row) => {
      if (state.filter === 'attention' && !isUnresolvedAttentionRow(row)) return false;
      if (state.filter === 'reviewed' && !isReviewed(row)) return false;
      if (
        !['all', 'attention', 'reviewed'].includes(state.filter)
        && rowCategory(row) !== state.filter
      ) {
        return false;
      }
      if (!query) return true;
      const haystack = [
        row.date,
        row.weekday,
        row.dayType,
        row.status,
        row.clockIn,
        row.clockOut,
        row.manualLabel,
      ].join(' ').toLocaleLowerCase();
      return haystack.includes(query);
    });
    if (!state.newestFirst) return rows;
    return [...rows].sort((left, right) => {
      const leftFuture = left.date > today;
      const rightFuture = right.date > today;
      if (leftFuture !== rightFuture) return leftFuture ? 1 : -1;
      return leftFuture
        ? left.date.localeCompare(right.date)
        : right.date.localeCompare(left.date);
    });
  }

  function renderFilterCounts() {
    const counts = {
      all: report.rows.length,
      attention: unresolvedAttentionRows().length,
      reviewed: report.rows.filter((row) => isReviewed(row)).length,
      normal: 0,
      leave: 0,
      rest: 0,
    };
    for (const row of report.rows) {
      const category = rowCategory(row);
      if (Object.prototype.hasOwnProperty.call(counts, category) && category !== 'attention') {
        counts[category] += 1;
      }
    }
    for (const [key, value] of Object.entries(counts)) setText(`#count-${key}`, value);
  }

  function renderTable() {
    const tbody = $('#details-body');
    const rows = filteredRows();
    const fragments = document.createDocumentFragment();
    for (const item of rows) {
      const row = document.createElement('tr');
      row.id = `row-${item.date}`;
      row.dataset.category = rowCategory(item);
      if (isReviewed(item)) row.classList.add('is-reviewed');
      else if (item.abnormal) row.classList.add('is-attention');
      else if (item.pending) row.classList.add('is-pending');

      const dateCell = document.createElement('td');
      const date = createNode('span', 'date-cell');
      date.append(createNode('strong', '', item.date), createNode('span', '', item.weekday || ''));
      dateCell.append(date);
      row.append(dateCell);

      const dayCell = document.createElement('td');
      const dayType = item.dayType || (item.workday ? '工作日' : '休息日');
      const dayTypeClass = dayType === '法定节假日'
        ? ' holiday'
        : (item.workday ? '' : ' rest');
      dayCell.append(createNode('span', `day-chip${dayTypeClass}`, dayType));
      row.append(dayCell);
      appendTimeCell(row, item.clockIn);
      appendTimeCell(row, item.clockOut);
      const hasHalfDayRule = item.manual
        && (item.manual.type === 'leave-am' || item.manual.type === 'leave-pm');
      appendTimeCell(row, item.workday || hasHalfDayRule ? item.expectedOut : '—');
      appendTimeCell(row, item.workDuration);
      appendTimeCell(row, item.overtime);
      appendStatusCell(row, item.status);
      appendSourceCell(row, item);
      const actionCell = document.createElement('td');
      const action = createNode(
        'button',
        `reconcile-row-button${isReviewed(item) ? ' is-reviewed' : ''}`,
        isReviewed(item) ? '查看/编辑' : '核对',
      );
      action.type = 'button';
      action.dataset.reconcileDate = item.date;
      action.setAttribute('aria-label', `${isReviewed(item) ? '查看或编辑' : '核对'} ${item.date} 的考勤记录`);
      action.addEventListener('click', () => openReconcileDialog(item.date));
      actionCell.append(action);
      row.append(actionCell);
      fragments.append(row);
    }
    tbody.replaceChildren(fragments);
    $('#empty-state').hidden = rows.length !== 0;
    setText('#details-caption', `显示 ${rows.length} / ${report.rows.length} 天 · ${state.newestFirst ? '近期日期优先' : '按日期正序'}`);
  }

  function setFilter(filter) {
    state.filter = filter;
    for (const button of document.querySelectorAll('[data-filter]')) {
      const active = button.dataset.filter === filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    renderTable();
  }

  function focusRow(date) {
    state.query = '';
    $('#table-search').value = '';
    setFilter('all');
    window.requestAnimationFrame(() => {
      const row = document.getElementById(`row-${date}`);
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.setAttribute('tabindex', '-1');
      row.focus({ preventScroll: true });
      window.setTimeout(() => row.removeAttribute('tabindex'), 1200);
    });
  }

  function reconciliationRuleText(type) {
    const rules = {
      confirmed: '只记录“已核对”，不会改变机器人识别出的打卡、异常或统计结果。',
      holiday: '法定节假日不计应出勤、工时或平均值；上下班卡完整时另计 1 个节假日加班日。',
      patch: '补录时间会覆盖当天对应一侧的机器人打卡，并重新判断迟到、早退、工时和加班。',
      'leave-full': '全天请假会覆盖机器人异常，但不进入平均工时的分子或分母。',
      'leave-am': '上午半天假按 14:00–15:00 上班、18:00–19:00 下班的联动规则重新计算。',
      'leave-pm': '下午半天假按 08:30–09:30 上班、14:00–15:00 下班的联动规则重新计算。',
      travel: '工作日出差固定按 8 小时计入平均工时；周末出差只保留明细，不进入平均值分母。',
      field: '外出或外勤会标记为有效状态；填写实际打卡后仍会计算工时。',
      other: '仅增加本地说明，不会自动消除机器人识别出的异常。',
    };
    return rules[type] || rules.confirmed;
  }

  function updateReconciliationHint() {
    const type = $('#reconcile-type').value;
    const isHalfLeave = type === 'leave-am' || type === 'leave-pm';
    const clockIn = $('#reconcile-clock-in');
    const clockOut = $('#reconcile-clock-out');
    const nextDay = $('#reconcile-next-day');
    $('#reconcile-half-average-field').hidden = !isHalfLeave;
    const confirmed = type === 'confirmed';
    clockIn.disabled = confirmed;
    clockOut.disabled = confirmed;

    const inMinutes = parserApi.timeToMinutes(clockIn.value);
    const outMinutes = parserApi.timeToMinutes(clockOut.value);
    const cutoff = parserApi.timeToMinutes(
      report.config.overnightClockOutCutoff || '06:00',
    );
    const nextDayEligible = !confirmed && outMinutes !== null && outMinutes < cutoff;
    nextDay.disabled = !nextDayEligible;
    if (!nextDayEligible) nextDay.checked = false;

    let text = reconciliationRuleText(type);
    if (isHalfLeave) {
      text += $('#reconcile-include-average').checked
        ? ' 当前已纳入平均工时，按“4 小时请假额度 + 实际半天有效工时”计算。'
        : ' 当前不纳入平均工时，仅保留打卡、状态与加班统计。';
    }
    let warning = false;
    if (!confirmed && inMinutes !== null && outMinutes !== null) {
      const resolvedOut = outMinutes + (nextDay.checked ? 24 * 60 : 0);
      if (resolvedOut <= inMinutes) {
        text += ' 当前下班时间不晚于上班时间；凌晨下班请勾选“次日”。';
        warning = true;
      } else {
        const effective = parserApi.netWorkMinutes(inMinutes, resolvedOut);
        const mode = type === 'leave-am' || type === 'leave-pm' ? type : 'full';
        const schedule = parserApi.getScheduleThresholds(report.config, clockIn.value, mode);
        const overtime = Number.isFinite(schedule.overtimeAfter)
          ? Math.max(0, resolvedOut - schedule.overtimeAfter)
          : 0;
        text += ` 当前录入的净打卡跨度约 ${formatMinutes(effective)}${overtime ? `，预计加班 ${formatMinutes(overtime)}` : ''}。`;
      }
    }
    setText('#reconcile-hint', text);
    $('#reconcile-hint').dataset.tone = warning ? 'warning' : '';
  }

  function openReconcileDialog(date, options = {}) {
    const row = report.rows.find((item) => item.date === date);
    if (!row) return;
    const focusEvidence = Boolean(options.focusEvidence);
    const entry = reconciliationFor(date);
    const adjustment = entry?.adjustment || row.manual || null;
    const type = entry?.outcome
      || (adjustment && RECONCILIATION_TYPES[adjustment.type] ? adjustment.type : 'confirmed');
    const dialog = $('#reconcile-dialog');
    dialog.dataset.date = date;
    setText('#reconcile-date', `${date} ${row.weekday || ''}`);
    setText('#reconcile-current-time', `${row.clockIn || '—'} → ${row.clockOut || '—'}`);
    setText('#reconcile-current-status', row.status || '—');
    const evidence = Array.isArray(row.evidence) ? row.evidence.filter(Boolean) : [];
    setText('#reconcile-evidence-count', `${evidence.length} 条`);
    const evidenceList = $('#reconcile-evidence-list');
    evidenceList.replaceChildren(
      ...(evidence.length
        ? evidence.map((value) => createNode('p', 'reconcile-evidence-item', value))
        : [createNode(
          'p',
          'reconcile-evidence-empty',
          '当天没有解析到假勤消息；请结合实际出勤、请假或补卡情况核对。',
        )]),
    );
    $('#reconcile-evidence').open = focusEvidence || evidence.length === 0;
    $('#reconcile-type').value = type;
    $('#reconcile-clock-in').value = adjustment?.clockIn || '';
    $('#reconcile-clock-out').value = adjustment?.clockOut || '';
    $('#reconcile-next-day').checked = Boolean(adjustment?.clockOutNextDay);
    $('#reconcile-include-average').checked = adjustment
      ? adjustment.includeInAverage !== false
      : true;
    $('#reconcile-note').value = entry?.note || adjustment?.note || '';
    $('#reconcile-delete').hidden = !entry;
    setText('#reconcile-error', '');
    updateReconciliationHint();
    if (!dialog.open) dialog.showModal();
    window.requestAnimationFrame(() => {
      if (focusEvidence) {
        evidenceList.scrollIntoView({ block: 'nearest' });
        evidenceList.focus({ preventScroll: true });
        return;
      }
      $('#reconcile-type').focus();
    });
  }

  function closeReconcileDialog() {
    const dialog = $('#reconcile-dialog');
    if (dialog.open) dialog.close();
    setText('#reconcile-error', '');
  }

  function saveReconciliationFromForm(event) {
    event.preventDefault();
    const dialog = $('#reconcile-dialog');
    const date = dialog.dataset.date || '';
    const outcome = $('#reconcile-type').value;
    const clockIn = $('#reconcile-clock-in').value;
    const clockOut = $('#reconcile-clock-out').value;
    const clockOutNextDay = $('#reconcile-next-day').checked;
    const includeInAverage = $('#reconcile-include-average').checked;
    const note = $('#reconcile-note').value.trim().slice(0, 300);
    if (!RECONCILIATION_TYPES[outcome]) {
      setText('#reconcile-error', '请选择有效的核对结果。');
      return;
    }

    const inMinutes = parserApi.timeToMinutes(clockIn);
    const outMinutes = parserApi.timeToMinutes(clockOut);
    const cutoff = parserApi.timeToMinutes(
      report.config.overnightClockOutCutoff || '06:00',
    );
    if (outcome !== 'confirmed' && clockOutNextDay && (outMinutes === null || outMinutes >= cutoff)) {
      setText('#reconcile-error', '次日下班时间只能是 00:00–05:59。');
      return;
    }
    if (
      outcome !== 'confirmed'
      && inMinutes !== null
      && outMinutes !== null
      && !clockOutNextDay
      && outMinutes <= inMinutes
    ) {
      setText('#reconcile-error', '下班时间需晚于上班时间；凌晨下班请勾选“次日”。');
      return;
    }

    const adjustment = outcome === 'confirmed'
      ? null
      : parserApi.normalizeManualAdjustment({
        date,
        type: outcome,
        clockIn,
        clockOut,
        clockOutNextDay,
        includeInAverage,
        note,
        updatedAt: new Date().toISOString(),
      });
    if (outcome !== 'confirmed' && !adjustment) {
      setText('#reconcile-error', '补充内容无效，请检查日期和时间。');
      return;
    }

    const previous = new Map(state.reconciliations);
    state.reconciliations.set(date, {
      date,
      reviewed: true,
      outcome,
      adjustment,
      note,
      updatedAt: new Date().toISOString(),
    });
    try {
      recomputeReport();
    } catch (error) {
      state.reconciliations = previous;
      setText('#reconcile-error', `重新计算失败：${error.message || error}`);
      return;
    }
    const persisted = saveReconciliations();
    closeReconcileDialog();
    renderAll();
    showToast(
      persisted
        ? `${date} 已核对并保存到本地`
        : `${date} 已核对；当前浏览器不允许持久保存`,
    );
  }

  function deleteCurrentReconciliation() {
    const date = $('#reconcile-dialog').dataset.date || '';
    if (!state.reconciliations.has(date)) return;
    const previous = new Map(state.reconciliations);
    state.reconciliations.delete(date);
    try {
      recomputeReport();
    } catch (error) {
      state.reconciliations = previous;
      setText('#reconcile-error', `恢复失败：${error.message || error}`);
      return;
    }
    const persisted = saveReconciliations();
    closeReconcileDialog();
    renderAll();
    showToast(persisted ? `${date} 的本地核对已删除` : `${date} 已在本次页面恢复`);
  }

  function renderAll() {
    renderHeader();
    renderPeriodControls();
    renderMetrics();
    renderCalculationRules();
    renderAttention();
    renderReviewList();
    renderChart();
    renderFilterCounts();
    renderTable();
  }

  function summaryText() {
    const period = report.period || {};
    const totals = report.totals || {};
    const rows = attentionRows();
    const unresolved = unresolvedAttentionRows();
    const reviewed = report.rows.filter((row) => isReviewed(row));
    return [
      `考勤周期：${period.start || '—'} 至 ${period.end || '—'}（${periodModeLabel(period.mode)}）`,
      `应出勤 ${number(totals.workdays)} 天；工作日有记录 ${number(totals.attended)} 天；正常 ${number(totals.normal)} 天；异常 ${number(totals.abnormal)} 天；待核对 ${number(totals.pending)} 天。`,
      `工作日加班总计 ${formatMinutes(totals.overtimeMinutes)}（${number(totals.overtimeDays)} 个加班日）；周末/节假日加班 ${number(totals.restDayOvertimeDays)} 天；平均加班 ${formatMinutes(totals.averageOvertimeMinutes)}（${number(totals.completeWorkDays)} 个完整出勤日）；平均工作 ${formatMinutes(totals.averageWorkMinutes)}（${number(totals.averageWorkDays)} 个计入均值日，含 ${number(totals.halfLeaveWorkDays)} 个半天假、${number(totals.travelWorkDays)} 个工作日出差；${number(totals.fullLeaveWorkDays)} 天全天假已排除）。`,
      `网页已核对 ${reviewed.length} 天；仍有 ${unresolved.length} 个异常或待核对日期未处理。`,
      rows.length ? '异常/待核对明细：' : '未发现异常或待核对日期。',
      ...rows.map((row) => `${row.date} ${row.weekday}：${row.clockIn}–${row.clockOut}，${row.status}${isReviewed(row) ? '（已核对）' : ''}`),
      '',
      '说明：结果由「假勤」消息与本地补充推算，最终结果以飞书考勤后台为准。',
    ].join('\n');
  }

  async function copySummary() {
    const value = summaryText();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.append(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      showToast('考勤摘要已复制');
    } catch (_) {
      showToast('复制失败，请使用打印或 CSV 导出');
    }
  }

  function csvCell(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  function downloadFile(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    const lines = [
      ['日期', '星期', '日期类型', '上班打卡', '下班打卡', '应下班时间', '有效工时', '加班时间', '时间跨度', '状态', '本地补充', '网页核对', '核对说明', '解析消息数'],
      ...report.rows.map((row) => [
        row.date,
        row.weekday,
        row.dayType || (row.workday ? '工作日' : '休息日'),
        row.clockIn,
        row.clockOut,
        row.expectedOut,
        row.workDuration,
        row.overtime,
        row.duration,
        row.status,
        row.manualLabel,
        isReviewed(row) ? RECONCILIATION_TYPES[reconciliationFor(row.date).outcome] : '',
        reconciliationFor(row.date)?.note || '',
        row.evidenceCount,
      ]),
    ];
    const csv = `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}`;
    downloadFile(
      `飞书考勤_${report.period.start}_${report.period.end}.csv`,
      csv,
      'text/csv;charset=utf-8',
    );
    showToast('CSV 已导出');
  }

  function exportManualJson() {
    const adjustments = [...(report.manual_adjustments || [])]
      .sort((left, right) => left.date.localeCompare(right.date));
    downloadFile(
      `考勤补充_${report.period.start}_${report.period.end}.json`,
      `${JSON.stringify(adjustments, null, 2)}\n`,
      'application/json;charset=utf-8',
    );
    showToast(
      adjustments.length
        ? `已导出 ${adjustments.length} 条补充，可通过 --manual 复用`
        : '当前没有需要导出的考勤补充',
    );
  }

  function attachEvents() {
    for (const button of document.querySelectorAll('[data-period-mode]')) {
      button.addEventListener('click', () => setPeriodDraftMode(button.dataset.periodMode));
    }
    $('#detected-cycle-select').addEventListener('change', applyPeriodSelection);
    for (const input of [
      $('#natural-month'),
      $('#cycle-month'),
      $('#cycle-start-day'),
      $('#custom-period-start'),
      $('#custom-period-end'),
    ]) {
      input.addEventListener('input', schedulePeriodSelection);
      input.addEventListener('change', applyPeriodSelection);
    }
    for (const button of document.querySelectorAll('[data-chart-mode]')) {
      button.addEventListener('click', () => {
        state.chartMode = button.dataset.chartMode === 'line' ? 'line' : 'candlestick';
        renderChart();
      });
    }
    $('#copy-summary').addEventListener('click', copySummary);
    $('#export-csv').addEventListener('click', exportCsv);
    $('#export-manual').addEventListener('click', exportManualJson);
    $('#print-report').addEventListener('click', () => window.print());
    $('#show-attention').addEventListener('click', () => {
      const target = $('#show-attention').dataset.targetFilter || 'attention';
      const rows = target === 'attention'
        ? unresolvedAttentionRows()
          .sort((left, right) => right.date.localeCompare(left.date))
        : [];
      if (target === 'attention' && !rows.length) {
        renderAttention();
        return;
      }
      state.query = '';
      $('#table-search').value = '';
      setFilter(target);
      $('#daily-details').scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (rows.length) {
        window.requestAnimationFrame(() => {
          const firstAction = document.querySelector(
            `#row-${rows[0].date} [data-reconcile-date]`,
          );
          if (firstAction) firstAction.focus({ preventScroll: true });
        });
      }
    });
    $('#toggle-order').addEventListener('click', () => {
      state.newestFirst = !state.newestFirst;
      const button = $('#toggle-order');
      button.setAttribute('aria-pressed', String(state.newestFirst));
      button.lastChild.textContent = state.newestFirst ? ' 近期在前' : ' 最早在前';
      renderTable();
    });
    $('#table-search').addEventListener('input', (event) => {
      state.query = event.target.value;
      renderTable();
    });
    for (const button of document.querySelectorAll('[data-filter]')) {
      button.addEventListener('click', () => setFilter(button.dataset.filter));
    }
    $('#reconcile-form').addEventListener('submit', saveReconciliationFromForm);
    $('#reconcile-close').addEventListener('click', closeReconcileDialog);
    $('#reconcile-cancel').addEventListener('click', closeReconcileDialog);
    $('#reconcile-delete').addEventListener('click', deleteCurrentReconciliation);
    $('#reconcile-dialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      closeReconcileDialog();
    });
    $('#reconcile-dialog').addEventListener('click', (event) => {
      if (event.target === $('#reconcile-dialog')) closeReconcileDialog();
    });
    for (const input of [
      $('#reconcile-type'),
      $('#reconcile-clock-in'),
      $('#reconcile-clock-out'),
      $('#reconcile-next-day'),
      $('#reconcile-include-average'),
    ]) {
      input.addEventListener('input', () => {
        setText('#reconcile-error', '');
        updateReconciliationHint();
      });
      input.addEventListener('change', updateReconciliationHint);
    }
  }

  function fatal(error) {
    $('.page-shell').hidden = true;
    $('#fatal-error').hidden = false;
    setText('#fatal-message', error && error.message ? error.message : String(error));
  }

  function initialize() {
    try {
      baseReport = JSON.parse($('#attendance-report-data').textContent);
      if (!baseReport || baseReport.schema_version !== 1 || !Array.isArray(baseReport.rows)) {
        throw new Error('报告数据格式无效。');
      }
      parserApi = window.__FEISHU_ATTENDANCE_TEST__;
      loadReconciliations();
      initializePeriodSelection();
      recomputeReport();
      initializeTheme();
      renderAll();
      attachEvents();
      window.__ATTENDANCE_REPORT_READY__ = true;
    } catch (error) {
      fatal(error);
      window.__ATTENDANCE_REPORT_READY__ = false;
    }
  }

  initialize();
})();
