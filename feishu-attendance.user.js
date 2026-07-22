// ==UserScript==
// @name         飞书假勤消息考勤汇总
// @namespace    https://github.com/fuhailong1998/feishu-attendance-assistant
// @version      1.0.5
// @description  跨会话缓存飞书「假勤」记录，统计异常、工时、加班 K 线并导出 CSV
// @author       fuhailong1998
// @homepageURL  https://github.com/fuhailong1998/feishu-attendance-assistant
// @supportURL   https://github.com/fuhailong1998/feishu-attendance-assistant/issues
// @downloadURL  https://raw.githubusercontent.com/fuhailong1998/feishu-attendance-assistant/main/feishu-attendance.user.js
// @updateURL    https://raw.githubusercontent.com/fuhailong1998/feishu-attendance-assistant/main/feishu-attendance.user.js
// @match        https://thundersoft.feishu.cn/next/messenger
// @match        https://thundersoft.feishu.cn/next/messenger/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const APP_ID = 'fs-attendance-assistant';
  const STORAGE_KEY = 'fs-attendance-assistant:config:v1';
  const MANUAL_STORAGE_KEY = 'fs-attendance-assistant:manual:v1';
  const EVENT_STORAGE_KEY = 'fs-attendance-assistant:events:v1';
  const EVENT_CACHE_VERSION = 1;
  const MAX_CACHED_EVENTS = 2500;
  const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
  const ATTENDANCE_HINT_RE = /(?:假勤|考勤|打卡|上班|下班|签到|签退|到岗|离岗|缺卡|漏卡|迟到|早退|旷工|补卡|外勤|请假|出差|无需打卡|attendance\s+(?:requests?|records?|reports?|summary|machine|results?|exception|irregular)|(?:weekly|monthly)\s+report|clock(?:ed)?\s*(?:in|out)|check(?:ed)?[ -]?(?:in|out)|no record|missing punch)/i;
  const ATTENDANCE_BOT_EVIDENCE_RE = /(?:打卡成功|缺卡通知|考勤申请截止|封存[^\n]{0,80}考勤数据|clocked\s+(?:in|out)\s+successfully|no record notification|attendance requests closing soon|(?:weekly|monthly)\s+report)/i;
  const PUNCH_REMINDER_RE = /(?:打卡提醒|attendance reminder|(?:clock|check)[ -]?(?:in|out)\s+reminder)/i;
  const DATE_TOKEN_RE = /(?:20\d{2}\s*[年/.\-]\s*\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*日?|\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*日?|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*20\d{2})?|今天|今日|昨天|昨日|前天|today|yesterday)/i;
  const ENGLISH_MONTHS = Object.freeze({
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
    dec: 12, december: 12,
  });
  const MANUAL_TYPES = Object.freeze({
    'leave-full': '全天请假',
    'leave-am': '上午半天假',
    'leave-pm': '下午半天假',
    patch: '补卡',
    travel: '出差',
    field: '外出/外勤',
    other: '其他说明',
  });
  const LUNCH_START_MINUTES = 12 * 60;
  const LUNCH_END_MINUTES = 13 * 60 + 30;

  const DEFAULT_CONFIG = Object.freeze({
    cycleStartDay: 1,
    rangeStart: '',
    rangeEnd: '',
    scheduleMode: 'flex-linked',
    workStart: '09:00',
    workEnd: '18:00',
    flexStartEarliest: '08:30',
    flexStartLatest: '09:30',
    flexEndEarliest: '18:00',
    flexEndLatest: '19:00',
    graceMinutes: 0,
    workdays: [1, 2, 3, 4, 5],
    holidayDates: '',
    extraWorkDates: '',
    noMessageAsMissing: false,
    unknownSplitTime: '14:00',
    overnightClockOutCutoff: '06:00',
  });

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatDate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  // 飞书消息元素的 19 位 ID 是 Snowflake 风格 ID，高 32 位为 Unix 秒。
  // 只把它作为消息发送日期使用；非消息 ID 或异常时间戳一律拒绝，避免猜日期。
  function dateFromFeishuMessageId(value) {
    const normalized = String(value || '').trim();
    if (!/^\d{18,20}$/.test(normalized)) return null;
    try {
      const seconds = Number(BigInt(normalized) >> 32n);
      if (!Number.isSafeInteger(seconds)) return null;
      const date = new Date(seconds * 1000);
      const year = date.getFullYear();
      if (Number.isNaN(date.getTime()) || year < 2015 || year > 2100) return null;
      return formatDate(date);
    } catch (_) {
      return null;
    }
  }

  function parseLocalDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (
      date.getFullYear() !== Number(match[1]) ||
      date.getMonth() !== Number(match[2]) - 1 ||
      date.getDate() !== Number(match[3])
    ) return null;
    return date;
  }

  function addDays(date, amount) {
    const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    copy.setDate(copy.getDate() + amount);
    return copy;
  }

  function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
  }

  function safeDay(year, monthIndex, day) {
    return new Date(year, monthIndex, Math.min(day, daysInMonth(year, monthIndex)));
  }

  function getCycleRange(referenceDate, startDay) {
    const day = Math.max(1, Math.min(28, Number(startDay) || 1));
    const ref = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
    let start;
    if (ref.getDate() >= day) {
      start = safeDay(ref.getFullYear(), ref.getMonth(), day);
    } else {
      start = safeDay(ref.getFullYear(), ref.getMonth() - 1, day);
    }
    const nextStart = safeDay(start.getFullYear(), start.getMonth() + 1, day);
    return { start: formatDate(start), end: formatDate(addDays(nextStart, -1)) };
  }

  function getNaturalMonthRange(referenceDate = new Date()) {
    const ref = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
      ? referenceDate
      : new Date();
    return {
      start: formatDate(new Date(ref.getFullYear(), ref.getMonth(), 1)),
      end: formatDate(new Date(ref.getFullYear(), ref.getMonth() + 1, 0)),
    };
  }

  function normalizeAttendanceCycle(value) {
    if (!value || typeof value !== 'object') return null;
    const start = String(value.start || '');
    const end = String(value.end || '');
    const startDate = parseLocalDate(start);
    const endDate = parseLocalDate(end);
    if (!startDate || !endDate || startDate > endDate) return null;
    const spanDays = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
    if (spanDays > 62) return null;
    const cutoff = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(value.cutoff || ''))
      ? String(value.cutoff)
      : '';
    return { start, end, cutoff };
  }

  function isAttendanceCycleForMonth(cycle, referenceDate = new Date()) {
    const normalized = normalizeAttendanceCycle(cycle);
    if (!normalized) return false;
    const monthKey = formatDate(referenceDate).slice(0, 7);
    return normalized.end.startsWith(monthKey) || normalized.cutoff.startsWith(monthKey);
  }

  function extractAttendanceCycle(text, referenceDate = new Date()) {
    const normalized = normalizeText(text);
    if (!normalized) return null;
    const isClosingReminder = /(?:考勤[^\n]{0,36}(?:截止|封存|封账)|(?:封存|封账|锁定)[^\n]{0,80}考勤|attendance\s+requests?\s+closing\s+soon|records?[^\n]{0,100}(?:will\s+be\s+)?locked)/i.test(normalized);
    if (!isClosingReminder) return null;

    const range = normalized.match(/(20\d{2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})\s*日?\s*(?:至|到|—|–|~|～|-|\bto\b)\s*(20\d{2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})\s*日?/i);
    if (!range) return null;
    const startDate = new Date(Number(range[1]), Number(range[2]) - 1, Number(range[3]));
    const endDate = new Date(Number(range[4]), Number(range[5]) - 1, Number(range[6]));
    const validStart = startDate.getFullYear() === Number(range[1])
      && startDate.getMonth() === Number(range[2]) - 1
      && startDate.getDate() === Number(range[3]);
    const validEnd = endDate.getFullYear() === Number(range[4])
      && endDate.getMonth() === Number(range[5]) - 1
      && endDate.getDate() === Number(range[6]);
    if (!validStart || !validEnd) return null;

    let cutoff = '';
    const cutoffMatch = normalized.match(/(\d{1,2})\s*[月/.]\s*(\d{1,2})\s*日?\s*(\d{1,2})[:：](\d{2})[^\n。；]{0,20}(?:封存|封账|锁定)/)
      || normalized.match(/(?:locked|closed)[^\n.;]{0,28}?(?:on\s*)?(\d{1,2})[/.](\d{1,2})\s+(\d{1,2}):(\d{2})/i);
    if (cutoffMatch) {
      const hour = Number(cutoffMatch[3]);
      const minute = Number(cutoffMatch[4]);
      if (hour <= 23 && minute <= 59) {
        const cutoffDate = closestYearDate(Number(cutoffMatch[1]), Number(cutoffMatch[2]), endDate || referenceDate);
        if (cutoffDate.getMonth() === Number(cutoffMatch[1]) - 1 && cutoffDate.getDate() === Number(cutoffMatch[2])) {
          cutoff = `${formatDate(cutoffDate)} ${pad2(hour)}:${pad2(minute)}`;
        }
      }
    }
    return normalizeAttendanceCycle({ start: formatDate(startDate), end: formatDate(endDate), cutoff });
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '')
      .replace(/\r/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function closestYearDate(month, day, referenceDate) {
    const ref = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
      ? referenceDate
      : new Date();
    let candidate = new Date(ref.getFullYear(), month - 1, day);
    const diffDays = Math.round((candidate.getTime() - ref.getTime()) / 86400000);
    if (diffDays > 183) candidate = new Date(ref.getFullYear() - 1, month - 1, day);
    if (diffDays < -183) candidate = new Date(ref.getFullYear() + 1, month - 1, day);
    return candidate;
  }

  function extractDateFromText(text, referenceDate = new Date()) {
    const value = normalizeText(text);
    if (!value) return null;

    let match = value.match(/(20\d{2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})\s*日?/);
    if (match) {
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (
        date.getFullYear() === Number(match[1]) &&
        date.getMonth() === Number(match[2]) - 1 &&
        date.getDate() === Number(match[3])
      ) return formatDate(date);
    }

    match = value.match(/(?:^|[^\d])(\d{1,2})\s*[月/.\-]\s*(\d{1,2})\s*日?(?:[^\d]|$)/);
    if (match) {
      const month = Number(match[1]);
      const day = Number(match[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const date = closestYearDate(month, day, referenceDate);
        if (date.getMonth() === month - 1 && date.getDate() === day) return formatDate(date);
      }
    }

    match = value.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,\s*(20\d{2}))?/i);
    if (match) {
      const month = ENGLISH_MONTHS[match[1].toLowerCase()];
      const day = Number(match[2]);
      const date = match[3]
        ? new Date(Number(match[3]), month - 1, day)
        : closestYearDate(month, day, referenceDate);
      if (date.getMonth() === month - 1 && date.getDate() === day) return formatDate(date);
    }

    const ref = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
    if (/(?:前天)/.test(value)) return formatDate(addDays(ref, -2));
    if (/(?:昨天|昨日|yesterday)/i.test(value)) return formatDate(addDays(ref, -1));
    if (/(?:今天|今日|today)/i.test(value)) return formatDate(ref);
    return null;
  }

  function extractLeadingMessageDate(text, referenceDate = new Date()) {
    const value = normalizeText(text);
    if (!value) return null;
    const ref = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
    if (/^(?:today|今天|今日)(?:\s|,|，)/i.test(value)) return formatDate(ref);
    if (/^(?:yesterday|昨天|昨日)(?:\s|,|，)/i.test(value)) return formatDate(addDays(ref, -1));
    if (/^(?:前天)(?:\s|,|，)/.test(value)) return formatDate(addDays(ref, -2));
    const datedPrefix = value.match(/^(?:(?:20\d{2}\s*[年/.\-]\s*\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*日?)|(?:\d{1,2}\s*月\s*\d{1,2}\s*日?)|(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*20\d{2})?))[^\n]{0,18}?\d{1,2}[:：]\d{2}/i);
    return datedPrefix ? extractDateFromText(datedPrefix[0], ref) : null;
  }

  function extractReferencedAttendanceDate(text, referenceDate = new Date()) {
    const value = normalizeText(text);
    const datePattern = '((?:20\\d{2}\\s*[年/.\\-]\\s*\\d{1,2}\\s*[月/.\\-]\\s*\\d{1,2}\\s*日?)|(?:\\d{1,2}\\s*[月/.\\-]\\s*\\d{1,2}\\s*日?))';
    const patterns = [
      new RegExp(`(?:no\\s+record\\s+notification|recent\\s+no\\s+record|recent\\s+missing\\s+punch|近期(?:缺卡|无记录)|最近(?:缺卡|无记录))[^\\d]{0,36}${datePattern}`, 'i'),
      new RegExp(`${datePattern}[^\\n。；]{0,42}(?:(?:clock|check)[ -]?(?:in|out)[^\\n.;]{0,18}(?:no\\s+record|missing)|(?:上班|下班|签到|签退)[^\\n。；]{0,18}(?:缺卡|漏卡|未打卡))`, 'i'),
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) return extractDateFromText(match[1], referenceDate);
    }
    return null;
  }

  function timeToMinutes(value) {
    const match = String(value || '').trim().match(/^(次日\s*)?(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hour = Number(match[2]);
    const minute = Number(match[3]);
    if (hour > 23 || minute > 59) return null;
    return (match[1] ? 24 * 60 : 0) + hour * 60 + minute;
  }

  function normalizeManualAdjustment(value) {
    if (!value || typeof value !== 'object') return null;
    const date = String(value.date || '');
    if (!parseLocalDate(date)) return null;
    const rawClockIn = String(value.clockIn || '').trim();
    const rawClockOut = String(value.clockOut || '').trim();
    const clockInMinutes = timeToMinutes(rawClockIn);
    const clockOutMinutes = timeToMinutes(rawClockOut);
    const clockIn = clockInMinutes !== null && clockInMinutes < 24 * 60 ? rawClockIn : '';
    const clockOut = clockOutMinutes !== null && clockOutMinutes < 24 * 60 ? rawClockOut : '';
    const type = MANUAL_TYPES[value.type]
      ? value.type
      : (clockIn || clockOut ? 'patch' : '');
    if (!type) return null;
    const cutoff = timeToMinutes(DEFAULT_CONFIG.overnightClockOutCutoff);
    const clockOutNextDay = Boolean(value.clockOutNextDay)
      && Boolean(clockOut)
      && clockOutMinutes < cutoff;
    return {
      date,
      type,
      clockIn,
      clockOut,
      clockOutNextDay,
      note: String(value.note || '').trim().slice(0, 300),
      updatedAt: String(value.updatedAt || ''),
    };
  }

  function manualAdjustmentLabel(value) {
    const adjustment = normalizeManualAdjustment(value);
    return adjustment ? MANUAL_TYPES[adjustment.type] : '';
  }

  function netWorkMinutes(startMinutes, endMinutes) {
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return null;
    let end = endMinutes;
    if (end < startMinutes) end += 24 * 60;
    if (end <= startMinutes) return 0;
    const lunchOverlap = Math.max(
      0,
      Math.min(end, LUNCH_END_MINUTES) - Math.max(startMinutes, LUNCH_START_MINUTES),
    );
    return Math.max(0, end - startMinutes - lunchOverlap);
  }

  function minutesToClock(value) {
    if (!Number.isFinite(value)) return '';
    const normalized = ((Math.round(value) % 1440) + 1440) % 1440;
    return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
  }

  function getScheduleThresholds(config, clockIn = '', attendanceMode = 'full') {
    const schedule = { ...DEFAULT_CONFIG, ...(config || {}) };
    if (attendanceMode === 'leave-am' || attendanceMode === 'leave-pm') {
      const morningLeave = attendanceMode === 'leave-am';
      const startEarliest = morningLeave ? 14 * 60 : 8 * 60 + 30;
      const startLatest = morningLeave ? 15 * 60 : 9 * 60 + 30;
      const endEarliest = morningLeave ? 18 * 60 : 14 * 60;
      const endLatest = morningLeave ? 19 * 60 : 15 * 60;
      const rangeLabel = `${minutesToClock(endEarliest)}–${minutesToClock(endLatest)}`;
      const clockInMinutes = timeToMinutes(clockIn);
      if (clockInMinutes === null) {
        return {
          lateAfter: startLatest,
          earlyBefore: null,
          completeAfter: endLatest,
          overtimeAfter: endLatest,
          normalStart: null,
          requiredMinutes: 4 * 60,
          expectedOut: rangeLabel,
        };
      }
      const boundedIn = Math.max(startEarliest, Math.min(startLatest, clockInMinutes));
      const linkedOut = endEarliest + (boundedIn - startEarliest);
      return {
        lateAfter: startLatest,
        earlyBefore: linkedOut,
        completeAfter: linkedOut,
        overtimeAfter: linkedOut,
        normalStart: boundedIn,
        requiredMinutes: 4 * 60,
        expectedOut: minutesToClock(linkedOut),
      };
    }
    if (schedule.scheduleMode === 'fixed') {
      const fixedIn = timeToMinutes(schedule.workStart);
      const fixedOut = timeToMinutes(schedule.workEnd);
      return {
        lateAfter: fixedIn,
        earlyBefore: fixedOut,
        completeAfter: fixedOut,
        overtimeAfter: fixedOut,
        normalStart: fixedIn,
        requiredMinutes: netWorkMinutes(fixedIn, fixedOut),
        expectedOut: minutesToClock(fixedOut),
      };
    }

    const startEarliest = timeToMinutes(schedule.flexStartEarliest);
    const startLatest = timeToMinutes(schedule.flexStartLatest);
    const endEarliest = timeToMinutes(schedule.flexEndEarliest);
    const endLatest = timeToMinutes(schedule.flexEndLatest);
    const rangeLabel = `${minutesToClock(endEarliest)}–${minutesToClock(endLatest)}`;
    const clockInMinutes = timeToMinutes(clockIn);
    if (schedule.scheduleMode === 'flex-window') {
      return {
        lateAfter: startLatest,
        earlyBefore: endEarliest,
        completeAfter: endLatest,
        overtimeAfter: endLatest,
        normalStart: clockInMinutes === null ? null : Math.max(startEarliest, Math.min(startLatest, clockInMinutes)),
        requiredMinutes: netWorkMinutes(startEarliest, endEarliest),
        expectedOut: rangeLabel,
      };
    }

    if (clockInMinutes === null) {
      return {
        lateAfter: startLatest,
        earlyBefore: null,
        completeAfter: endLatest,
        overtimeAfter: endLatest,
        normalStart: null,
        requiredMinutes: netWorkMinutes(startEarliest, endEarliest),
        expectedOut: rangeLabel,
      };
    }
    const boundedIn = Math.max(startEarliest, Math.min(startLatest, clockInMinutes));
    const startWidth = Math.max(0, startLatest - startEarliest);
    const endWidth = Math.max(0, endLatest - endEarliest);
    const ratio = startWidth ? (boundedIn - startEarliest) / startWidth : 0;
    const linkedOut = Math.round(endEarliest + ratio * endWidth);
    return {
      lateAfter: startLatest,
      earlyBefore: linkedOut,
      completeAfter: linkedOut,
      overtimeAfter: linkedOut,
      normalStart: boundedIn,
      requiredMinutes: netWorkMinutes(boundedIn, linkedOut),
      expectedOut: minutesToClock(linkedOut),
    };
  }

  function describeSchedule(config) {
    const cutoff = timeToMinutes(config.overnightClockOutCutoff || DEFAULT_CONFIG.overnightClockOutCutoff);
    const overnightRule = `次日 00:00–${minutesToClock(Math.max(0, cutoff - 1))} 下班归前一考勤日`;
    if (config.scheduleMode === 'fixed') return `固定班次 ${config.workStart}–${config.workEnd}；加班从 ${config.workEnd} 起算；${overnightRule}`;
    const range = `${config.flexStartEarliest}–${config.flexStartLatest} 上班，${config.flexEndEarliest}–${config.flexEndLatest} 下班`;
    const schedule = config.scheduleMode === 'flex-window' ? `独立弹性：${range}` : `联动弹性：${range}`;
    const overtimeRule = config.scheduleMode === 'flex-window' ? `加班从 ${config.flexEndLatest} 起算` : '加班从联动应下班时间起算';
    return `${schedule}；${overtimeRule}；${overnightRule}`;
  }

  function minutesToDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) return '—';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}小时${rest ? `${rest}分` : ''}`;
  }

  function uniqueSortedTimes(values) {
    return [...new Set(values.filter((value) => timeToMinutes(value) !== null))]
      .sort((a, b) => timeToMinutes(a) - timeToMinutes(b));
  }

  function countDateTokens(text) {
    return (String(text).match(new RegExp(DATE_TOKEN_RE.source, 'gi')) || []).length;
  }

  function extractClockCandidates(text) {
    const candidates = [];
    const regex = /(^|[^\d])(\d{1,2})[:：]([0-5]\d)(?!\d)/g;
    const nearestKeywordDistance = (index, pattern, accept = () => true) => {
      const start = Math.max(0, index - 48);
      const end = Math.min(text.length, index + 53);
      const segment = text.slice(start, end);
      const matcher = new RegExp(pattern.source, pattern.ignoreCase ? 'gi' : 'g');
      let nearest = Infinity;
      let keywordMatch;
      while ((keywordMatch = matcher.exec(segment))) {
        const matchStart = start + keywordMatch.index;
        if (!accept(matchStart, keywordMatch[0])) continue;
        const matchMiddle = matchStart + keywordMatch[0].length / 2;
        nearest = Math.min(nearest, Math.abs(matchMiddle - index));
      }
      return nearest;
    };
    let match;
    while ((match = regex.exec(text))) {
      let hour = Number(match[2]);
      if (hour > 23) continue;
      const index = match.index + match[1].length;
      const suffixIndex = index + match[0].length - match[1].length;
      const meridiemMatch = text.slice(suffixIndex, suffixIndex + 10).match(/^\s*(AM|PM)/i);
      if (meridiemMatch) {
        if (hour < 1 || hour > 12) continue;
        if (meridiemMatch[1].toUpperCase() === 'AM') hour %= 12;
        else if (hour !== 12) hour += 12;
      }
      const value = `${pad2(hour)}:${match[3]}`;
      const before = text.slice(Math.max(0, index - 36), index);
      const after = text.slice(suffixIndex, index + 52);
      const context = `${before} ${after}`;
      const lineStart = text.lastIndexOf('\n', index - 1) + 1;
      const nextBreak = text.indexOf('\n', index);
      const lineEnd = nextBreak === -1 ? text.length : nextBreak;
      const line = text.slice(lineStart, lineEnd);
      const lineHasIn = /(?:上班|签到|到岗|开始工作|clock(?:ed)?\s*in|check(?:ed)?[ -]?in)/i.test(line);
      const lineHasOut = /(?:下班|签退|离岗|结束工作|clock(?:ed)?\s*out|check(?:ed)?[ -]?out)/i.test(line);
      const inDistance = nearestKeywordDistance(index, /(?:上班|签到|到岗|开始工作|clock(?:ed)?\s*in|check(?:ed)?[ -]?in)/i);
      const outDistance = nearestKeywordDistance(index, /(?:下班|签退|离岗|结束工作|clock(?:ed)?\s*out|check(?:ed)?[ -]?out)/i);
      const inHint = lineHasIn !== lineHasOut ? lineHasIn : inDistance < outDistance;
      const outHint = lineHasIn !== lineHasOut ? lineHasOut : outDistance < inDistance;
      const planDistance = nearestKeywordDistance(index, /(?:应打卡(?:时间)?|应到|应退|班次|工作时间|提醒时间|最早|最晚|截止|请在)/);
      const actualDistance = nearestKeywordDistance(
        index,
        /(?:实际打卡(?:时间)?|实际时间|打卡时间|打卡成功|签到成功|签退成功|已打卡|已于|已完成|完成打卡|正常|迟到|早退|补卡|successfully|actual(?:\s+punch)?\s+time)/i,
        (matchStart, keyword) => keyword !== '打卡时间' || text.charAt(matchStart - 1) !== '应',
      );
      const planned = planDistance < actualDistance;
      const actual = Number.isFinite(actualDistance) && actualDistance <= planDistance;
      candidates.push({ value, index, inHint, outHint, planned, actual, context });
    }
    return candidates;
  }

  function emptyFlags() {
    return {
      late: false,
      early: false,
      missingIn: false,
      missingOut: false,
      missing: false,
      absent: false,
      field: false,
      leave: false,
      travel: false,
      rest: false,
      patched: false,
      normal: false,
    };
  }

  function parseAttendanceMessage(text, contextDate, config = DEFAULT_CONFIG, options = {}) {
    const normalized = normalizeText(text);
    if (!normalized || !ATTENDANCE_HINT_RE.test(normalized)) return null;

    const referenceDate = parseLocalDate(contextDate) || new Date();
    // 封账/封存提醒只用于发现统计周期，不能因包含“请假、出差”等申请词而计入某一天。
    if (extractAttendanceCycle(normalized, referenceDate)) return null;
    // 打卡提醒描述的是未来动作，即使正文出现“迟到、早退、打卡成功”等词也不是考勤结果。
    if (PUNCH_REMINDER_RE.test(normalized)) return null;
    let date = options.dateResolved
      ? (extractReferencedAttendanceDate(normalized, referenceDate) || contextDate || null)
      : (extractDateFromText(normalized, referenceDate) || contextDate || null);
    if (!date) return null;

    // 周报/月报往往在一张卡片里包含很多天，不能当作单日打卡记录。
    if (/(?:考勤|假勤|个人)?(?:周报|月报|周统计|月统计)|(?:weekly|monthly)\s+report/i.test(normalized) && countDateTokens(normalized) > 1) {
      return null;
    }

    const flags = emptyFlags();
    flags.late = /(?:严重迟到|迟到|晚到|\blate\b)/i.test(normalized);
    flags.early = /(?:早退|left\s+early|early\s+(?:leave|departure))/i.test(normalized);
    flags.missingIn = /(?:上班|签到|到岗)[^\n。；]{0,12}(?:缺卡|漏卡|未打卡)|(?:缺卡|漏卡|未打卡)[^\n。；]{0,12}(?:上班|签到|到岗)|(?:缺卡|漏卡)记录[^\n。；]{0,48}(?:上班卡|签到|到岗)|(?:clock|check)[ -]?in[^\n.;]{0,18}(?:missing|no record)|(?:missing|no record)[^\n.;]{0,18}(?:clock|check)[ -]?in/i.test(normalized);
    flags.missingOut = /(?:下班|签退|离岗)[^\n。；]{0,12}(?:缺卡|漏卡|未打卡)|(?:缺卡|漏卡|未打卡)[^\n。；]{0,12}(?:下班|签退|离岗)|(?:缺卡|漏卡)记录[^\n。；]{0,48}(?:下班卡|签退|离岗)|(?:clock|check)[ -]?out[^\n.;]{0,18}(?:missing|no record)|(?:missing|no record)[^\n.;]{0,18}(?:clock|check)[ -]?out/i.test(normalized);
    flags.missing = /(?:缺卡|漏卡|未打卡|missing punch|no record)/i.test(normalized) && !flags.missingIn && !flags.missingOut;
    flags.absent = /(?:旷工|缺勤|\babsent\b)/i.test(normalized);
    flags.field = /(?:外勤|offsite|field work)/i.test(normalized);
    flags.leave = /(?:请假|休假|年假|病假|事假|on leave)/i.test(normalized);
    flags.travel = /(?:出差|business trip)/i.test(normalized);
    flags.rest = /(?:无需打卡|休息日|no punch required|rest day)/i.test(normalized);
    flags.patched = /(?:补卡[^\n。；]{0,12}(?:通过|成功|完成)|(?:通过|成功)[^\n。；]{0,12}补卡)/.test(normalized);
    flags.normal = /(?:打卡正常|考勤正常|状态[:：]?\s*正常|正常打卡|attendance\s+normal|status[:：]?\s*normal)/i.test(normalized);

    const isReminder = /(?:打卡提醒|提醒你|记得打卡|别忘|请及时打卡|该打卡了|attendance reminder|remember to (?:clock|check)|requests closing soon)/i.test(normalized);
    // 缺卡通知里的时间表示“本应打但没有打”的班次时间，不是实际打卡时间。
    const isMissingNotification = /(?:缺卡提醒|缺卡通知|漏卡提醒|no record notification|missing punch notification)/i.test(normalized);
    const hasActualEvidence = /(?:打卡成功|(?:^|[^应])打卡时间|实际打卡|已打卡|已于[^\n]{0,18}打卡|完成[^\n]{0,8}打卡|签到成功|签退成功|考勤结果|clocked\s+(?:in|out)\s+successfully|checked[ -]?(?:in|out)\s+successfully)/i.test(normalized);
    const candidates = (isMissingNotification ? [] : extractClockCandidates(normalized)).filter((candidate) => {
      if (candidate.planned) return false;
      if (isReminder && !hasActualEvidence) return false;
      return true;
    });

    const inTimes = [];
    const outTimes = [];
    const unknownTimes = [];
    for (const candidate of candidates) {
      if (candidate.inHint && !candidate.outHint) inTimes.push(candidate.value);
      else if (candidate.outHint && !candidate.inHint) outTimes.push(candidate.value);
      else if (candidate.actual || hasActualEvidence) unknownTimes.push(candidate.value);
    }

    const messageSaysIn = /(?:上班打卡|签到|到岗)(?:成功|完成|正常)?|(?:成功|完成)[^\n]{0,12}(?:上班打卡|签到)|clocked\s+in|checked[ -]?in/i.test(normalized);
    const messageSaysOut = /(?:下班打卡|签退|离岗)(?:成功|完成|正常)?|(?:成功|完成)[^\n]{0,12}(?:下班打卡|签退)|clocked\s+out|checked[ -]?out/i.test(normalized);
    if (!inTimes.length && !outTimes.length && unknownTimes.length === 1) {
      if (messageSaysIn && !messageSaysOut) inTimes.push(unknownTimes.pop());
      else if (messageSaysOut && !messageSaysIn) outTimes.push(unknownTimes.pop());
    }

    const hasStatus = Object.values(flags).some(Boolean);
    if (!inTimes.length && !outTimes.length && !unknownTimes.length && !hasStatus) return null;
    if (isReminder && !hasActualEvidence && !hasStatus) return null;

    let normalizedOutTimes = uniqueSortedTimes(outTimes);
    const overnightCutoff = timeToMinutes(config.overnightClockOutCutoff || DEFAULT_CONFIG.overnightClockOutCutoff);
    const isOvernightClockOut = hasActualEvidence
      && messageSaysOut
      && !messageSaysIn
      && normalizedOutTimes.length > 0
      && overnightCutoff !== null
      && normalizedOutTimes.every((value) => {
        const minutes = timeToMinutes(value);
        return minutes !== null && minutes < overnightCutoff;
      });
    if (isOvernightClockOut) {
      const messageDate = parseLocalDate(date);
      if (messageDate) {
        date = formatDate(addDays(messageDate, -1));
        normalizedOutTimes = normalizedOutTimes.map((value) => `次日 ${value}`);
      }
    }

    return {
      date,
      inTimes: uniqueSortedTimes(inTimes),
      outTimes: normalizedOutTimes,
      unknownTimes: uniqueSortedTimes(unknownTimes),
      flags,
      text: normalized,
      source: 'message',
    };
  }

  function parseDateList(value) {
    return new Set(
      String(value || '')
        .split(/[\s,，;；]+/)
        .map((item) => item.trim())
        .filter((item) => parseLocalDate(item)),
    );
  }

  function isScheduledWorkday(date, config) {
    const key = formatDate(date);
    const extra = parseDateList(config.extraWorkDates);
    const holidays = parseDateList(config.holidayDates);
    if (extra.has(key)) return true;
    if (holidays.has(key)) return false;
    return (config.workdays || []).includes(date.getDay());
  }

  function mergeFlags(target, source) {
    for (const key of Object.keys(target)) target[key] = target[key] || Boolean(source && source[key]);
  }

  function buildDailySummary(events, config, now = new Date(), manualAdjustments = []) {
    const start = parseLocalDate(config.rangeStart);
    const end = parseLocalDate(config.rangeEnd);
    if (!start || !end || start > end) return { rows: [], totals: {}, error: '考勤周期无效' };

    const grouped = new Map();
    const ensureDay = (date) => {
      if (!grouped.has(date)) {
        grouped.set(date, {
          inTimes: [],
          outTimes: [],
          unknownTimes: [],
          flags: emptyFlags(),
          evidence: [],
          manual: null,
        });
      }
      return grouped.get(date);
    };
    for (const event of events || []) {
      if (!event || !event.date || event.date < config.rangeStart || event.date > config.rangeEnd) continue;
      const day = ensureDay(event.date);
      day.inTimes.push(...(event.inTimes || []));
      day.outTimes.push(...(event.outTimes || []));
      day.unknownTimes.push(...(event.unknownTimes || []));
      mergeFlags(day.flags, event.flags || {});
      if (event.text) day.evidence.push(event.text);
    }
    const manualValues = manualAdjustments instanceof Map
      ? [...manualAdjustments.values()]
      : (Array.isArray(manualAdjustments) ? manualAdjustments : Object.values(manualAdjustments || {}));
    for (const value of manualValues) {
      const adjustment = normalizeManualAdjustment(value);
      if (!adjustment || adjustment.date < config.rangeStart || adjustment.date > config.rangeEnd) continue;
      ensureDay(adjustment.date).manual = adjustment;
    }

    const todayKey = formatDate(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const splitAt = timeToMinutes(config.unknownSplitTime) ?? 14 * 60;
    const grace = Math.max(0, Number(config.graceMinutes) || 0);
    const rows = [];
    const totals = {
      calendarDays: 0,
      workdays: 0,
      attended: 0,
      normal: 0,
      late: 0,
      early: 0,
      missing: 0,
      absent: 0,
      pending: 0,
      leave: 0,
      travel: 0,
      rest: 0,
      abnormal: 0,
      overtimeMinutes: 0,
      overtimeDays: 0,
      workMinutes: 0,
      completeWorkDays: 0,
      averageOvertimeMinutes: 0,
      averageWorkMinutes: 0,
    };

    for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
      const dateKey = formatDate(cursor);
      const workday = isScheduledWorkday(cursor, config);
      const day = grouped.get(dateKey) || {
        inTimes: [], outTimes: [], unknownTimes: [], flags: emptyFlags(), evidence: [], manual: null,
      };
      const manual = normalizeManualAdjustment(day.manual);
      const manualType = manual ? manual.type : '';
      const isHalfLeave = manualType === 'leave-am' || manualType === 'leave-pm';
      const isManualFullLeave = manualType === 'leave-full';
      const flags = { ...day.flags };
      const resolvesRobotAnomaly = ['leave-full', 'leave-am', 'leave-pm', 'patch', 'travel', 'field'].includes(manualType);
      if (resolvesRobotAnomaly) {
        flags.late = false;
        flags.early = false;
        flags.missingIn = false;
        flags.missingOut = false;
        flags.missing = false;
        flags.absent = false;
        flags.leave = false;
        flags.travel = false;
        flags.field = false;
        flags.rest = false;
      }
      if (manualType === 'patch') flags.patched = true;
      if (manualType === 'travel') flags.travel = true;
      if (manualType === 'field') {
        flags.field = true;
        flags.normal = true;
      }

      let inTimes = uniqueSortedTimes(day.inTimes);
      let outTimes = uniqueSortedTimes(day.outTimes);
      const unknownTimes = uniqueSortedTimes(day.unknownTimes);

      if (manual && manual.clockIn) inTimes = [manual.clockIn];
      if (manual && manual.clockOut) {
        outTimes = [`${manual.clockOutNextDay ? '次日 ' : ''}${manual.clockOut}`];
      }

      for (const value of unknownTimes) {
        if (timeToMinutes(value) < splitAt) {
          if (!(manual && manual.clockIn)) inTimes.push(value);
        } else if (!(manual && manual.clockOut)) outTimes.push(value);
      }
      const sortedIn = uniqueSortedTimes(inTimes);
      const sortedOut = uniqueSortedTimes(outTimes);
      const clockIn = sortedIn[0] || '';
      const clockOut = sortedOut[sortedOut.length - 1] || '';
      const schedule = getScheduleThresholds(config, clockIn, isHalfLeave ? manualType : 'full');
      const hasPunch = Boolean(clockIn || clockOut);
      const isFuture = dateKey > todayKey;
      const isToday = dateKey === todayKey;
      const afterWorkEnd = schedule.completeAfter === null || nowMinutes > schedule.completeAfter + grace;
      const completedDay = dateKey < todayKey || (isToday && afterWorkEnd);
      const labels = [];
      let abnormal = false;
      let pending = false;

      if (isFuture) {
        labels.push('未到');
      } else if (isManualFullLeave) {
        labels.push('全天请假');
        totals.leave += 1;
      } else if (flags.leave) {
        labels.push('请假');
        totals.leave += 1;
      } else if (flags.travel) {
        labels.push('出差');
        totals.travel += 1;
      } else if (!workday && !isHalfLeave && !hasPunch && !flags.rest) {
        labels.push('休息');
        totals.rest += 1;
      } else if (flags.rest && !hasPunch) {
        labels.push('无需打卡');
        totals.rest += 1;
      } else if (workday || isHalfLeave) {
        if (isHalfLeave) {
          labels.push(manualType === 'leave-am' ? '上午半天假' : '下午半天假');
          totals.leave += 0.5;
        }
        if (!hasPunch && !flags.patched && !flags.normal) {
          if (isToday && !completedDay) {
            labels.push('进行中');
          } else if (config.noMessageAsMissing || flags.missing || flags.missingIn || flags.missingOut || flags.absent) {
            abnormal = true;
            if (flags.absent) {
              labels.push('缺勤');
              totals.absent += 1;
            } else if (flags.missingIn || flags.missingOut) {
              if (flags.missingIn) {
                labels.push('缺上班卡');
                totals.missing += 1;
              }
              if (flags.missingOut) {
                labels.push('缺下班卡');
                totals.missing += 1;
              }
            } else {
              labels.push('缺卡');
              totals.missing += 1;
            }
          } else {
            labels.push(isHalfLeave ? '半天出勤无记录·待核对' : '无消息·待核对');
            pending = true;
            totals.pending += 1;
          }
        } else {
          if (hasPunch || flags.patched || flags.normal) totals.attended += 1;
          if (flags.missingIn && !flags.patched) {
            labels.push('缺上班卡');
            totals.missing += 1;
            abnormal = true;
          }
          if (flags.missingOut && !flags.patched) {
            labels.push('缺下班卡');
            totals.missing += 1;
            abnormal = true;
          }
          if (flags.missing && !flags.missingIn && !flags.missingOut && !flags.patched) {
            labels.push('缺卡');
            totals.missing += 1;
            abnormal = true;
          }
          const partialPunchNeedsReview = completedDay
            && !flags.patched
            && !flags.missing
            && !flags.missingIn
            && !flags.missingOut
            && ((clockIn && !clockOut) || (!clockIn && clockOut));
          if (partialPunchNeedsReview) {
            labels.push(clockIn ? '仅上班卡·待核对' : '仅下班卡·待核对');
            totals.pending += 1;
            pending = true;
          }
          const computedLate = clockIn && schedule.lateAfter !== null && timeToMinutes(clockIn) > schedule.lateAfter + grace;
          const computedEarly = clockOut && schedule.earlyBefore !== null && timeToMinutes(clockOut) < schedule.earlyBefore - grace;
          if (flags.late || computedLate) {
            labels.push('迟到');
            totals.late += 1;
            abnormal = true;
          }
          if (flags.early || computedEarly) {
            labels.push('早退');
            totals.early += 1;
            abnormal = true;
          }
          if (flags.absent) {
            labels.push('缺勤');
            totals.absent += 1;
            abnormal = true;
          }
          if (flags.field) labels.push('外勤');
          if (flags.patched) labels.push('已补卡');
          if (isHalfLeave && !abnormal && !pending) {
            labels.push('半天出勤正常');
          } else if (!labels.length) {
            if (isToday && !clockOut) labels.push('进行中');
            else labels.push('正常');
          }
        }
      } else if (hasPunch) {
        labels.push('休息日打卡');
        totals.attended += 1;
      }
      if (manualType === 'other' && !isFuture) labels.push('手工说明');

      let durationMinutes = null;
      let workMinutes = null;
      let overtimeMinutes = 0;
      if (clockIn && clockOut) {
        const clockInMinutes = timeToMinutes(clockIn);
        let clockOutMinutes = timeToMinutes(clockOut);
        if (clockOutMinutes < clockInMinutes) clockOutMinutes += 24 * 60;
        durationMinutes = clockOutMinutes - clockInMinutes;
        const eligibleForWorkStats = (workday || isHalfLeave)
          && !isManualFullLeave
          && !flags.leave
          && Number.isFinite(schedule.normalStart)
          && Number.isFinite(schedule.overtimeAfter);
        if (eligibleForWorkStats) {
          const normalStart = Math.max(clockInMinutes, schedule.normalStart);
          const normalEnd = Math.min(clockOutMinutes, schedule.overtimeAfter);
          const normalWorkedMinutes = normalEnd > normalStart
            ? netWorkMinutes(normalStart, normalEnd)
            : 0;
          overtimeMinutes = Math.max(0, clockOutMinutes - schedule.overtimeAfter);
          workMinutes = normalWorkedMinutes + overtimeMinutes;
          totals.workMinutes += workMinutes;
          totals.completeWorkDays += 1;
          totals.overtimeMinutes += overtimeMinutes;
          if (overtimeMinutes > 0) totals.overtimeDays += 1;
        }
      }
      if (abnormal) totals.abnormal += 1;
      if (!abnormal && !pending && workday && !isFuture && labels.some((label) => /正常/.test(label))) totals.normal += 1;
      totals.calendarDays += 1;
      if (workday && !isFuture) totals.workdays += 1;

      rows.push({
        date: dateKey,
        weekday: `周${WEEKDAY_NAMES[cursor.getDay()]}`,
        workday,
        clockIn: clockIn || '—',
        clockOut: clockOut || '—',
        expectedOut: schedule.expectedOut || '—',
        duration: minutesToDuration(durationMinutes),
        workDuration: minutesToDuration(workMinutes),
        overtime: overtimeMinutes > 0 ? minutesToDuration(overtimeMinutes) : '—',
        workMinutes,
        overtimeMinutes,
        status: [...new Set(labels)].join('、'),
        abnormal,
        pending,
        manual,
        manualLabel: manualAdjustmentLabel(manual),
        evidenceCount: day.evidence.length,
        evidence: [...new Set(day.evidence)],
      });
    }
    totals.averageOvertimeMinutes = totals.overtimeDays
      ? Math.round(totals.overtimeMinutes / totals.overtimeDays)
      : 0;
    totals.averageWorkMinutes = totals.completeWorkDays
      ? Math.round(totals.workMinutes / totals.completeWorkDays)
      : 0;
    return { rows, totals, error: '' };
  }

  function getOvertimeTrendData(rows) {
    const trend = (rows || [])
      .filter((row) => {
        const halfDay = row.manual && (row.manual.type === 'leave-am' || row.manual.type === 'leave-pm');
        return row.status !== '未到' && (row.workday || halfDay);
      })
      .map((row) => {
        const available = Number.isFinite(row.workMinutes);
        return {
          date: row.date,
          weekday: row.weekday,
          available,
          overtimeMinutes: available ? Math.max(0, Number(row.overtimeMinutes) || 0) : null,
          workMinutes: available ? row.workMinutes : null,
          status: row.status,
        };
      });
    let previous = null;
    return trend.map((item) => {
      if (!item.available) {
        return {
          ...item,
          openMinutes: null,
          closeMinutes: null,
          highMinutes: null,
          lowMinutes: null,
          changeMinutes: null,
          direction: 'gap',
          comparisonDate: null,
        };
      }
      const openMinutes = previous ? previous.overtimeMinutes : item.overtimeMinutes;
      const closeMinutes = item.overtimeMinutes;
      const changeMinutes = closeMinutes - openMinutes;
      const candle = {
        ...item,
        openMinutes,
        closeMinutes,
        highMinutes: Math.max(openMinutes, closeMinutes),
        lowMinutes: Math.min(openMinutes, closeMinutes),
        changeMinutes,
        direction: previous ? (changeMinutes > 0 ? 'up' : changeMinutes < 0 ? 'down' : 'flat') : 'flat',
        comparisonDate: previous ? previous.date : null,
      };
      previous = item;
      return candle;
    });
  }

  const TEST_API = {
    addDays,
    buildDailySummary,
    dateFromFeishuMessageId,
    extractDateFromText,
    extractAttendanceCycle,
    formatDate,
    extractLeadingMessageDate,
    extractReferencedAttendanceDate,
    getCycleRange,
    getNaturalMonthRange,
    getOvertimeTrendData,
    getScheduleThresholds,
    isAttendanceCycleForMonth,
    manualAdjustmentLabel,
    netWorkMinutes,
    normalizeCachedEvent,
    normalizeManualAdjustment,
    parseAttendanceMessage,
    parseLocalDate,
    timeToMinutes,
  };
  if (typeof globalThis !== 'undefined') globalThis.__FEISHU_ATTENDANCE_TEST__ = TEST_API;
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (document.getElementById(APP_ID)) return;

  function loadConfig() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (_) {
      stored = {};
    }
    const config = { ...DEFAULT_CONFIG, ...stored };
    config.workdays = Array.isArray(config.workdays) ? config.workdays.map(Number) : [...DEFAULT_CONFIG.workdays];
    config.cycleStartDay = Math.max(1, Math.min(28, Number(config.cycleStartDay) || 1));
    if (!['fixed', 'flex-linked', 'flex-window'].includes(config.scheduleMode)) {
      config.scheduleMode = DEFAULT_CONFIG.scheduleMode;
    }
    if (!parseLocalDate(config.rangeStart) || !parseLocalDate(config.rangeEnd)) {
      Object.assign(config, getCycleRange(new Date(), config.cycleStartDay));
      config.rangeStart = config.start;
      config.rangeEnd = config.end;
      delete config.start;
      delete config.end;
    }
    return config;
  }

  function saveConfig(config) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  function loadManualAdjustments() {
    let stored = [];
    try {
      stored = JSON.parse(localStorage.getItem(MANUAL_STORAGE_KEY) || '[]');
    } catch (_) {
      stored = [];
    }
    const values = Array.isArray(stored) ? stored : Object.values(stored || {});
    const adjustments = new Map();
    for (const value of values) {
      const adjustment = normalizeManualAdjustment(value);
      if (adjustment) adjustments.set(adjustment.date, adjustment);
    }
    return adjustments;
  }

  function saveManualAdjustments(adjustments) {
    const values = [...adjustments.values()]
      .map(normalizeManualAdjustment)
      .filter(Boolean)
      .sort((left, right) => left.date.localeCompare(right.date));
    localStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify(values));
  }

  function normalizeCachedEvent(value) {
    if (!value || typeof value !== 'object' || !parseLocalDate(value.date)) return null;
    const text = normalizeText(value.text).slice(0, 5000);
    if (PUNCH_REMINDER_RE.test(text)) return null;
    const flags = emptyFlags();
    for (const key of Object.keys(flags)) flags[key] = Boolean(value.flags && value.flags[key]);
    const event = {
      date: value.date,
      inTimes: uniqueSortedTimes(Array.isArray(value.inTimes) ? value.inTimes : []),
      outTimes: uniqueSortedTimes(Array.isArray(value.outTimes) ? value.outTimes : []),
      unknownTimes: uniqueSortedTimes(Array.isArray(value.unknownTimes) ? value.unknownTimes : []),
      flags,
      text,
      source: value.source === 'paste' ? 'paste' : 'message',
    };
    const hasStatus = Object.values(flags).some(Boolean);
    if (!event.inTimes.length && !event.outTimes.length && !event.unknownTimes.length && !hasStatus) return null;
    return event;
  }

  function loadEventCache() {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(EVENT_STORAGE_KEY) || 'null');
    } catch (_) {
      stored = null;
    }
    const values = Array.isArray(stored) ? stored : (Array.isArray(stored && stored.events) ? stored.events : []);
    const events = new Map();
    for (const value of values) {
      const event = normalizeCachedEvent(value);
      if (event) events.set(eventKey(event), event);
    }
    return {
      events,
      updatedAt: String(stored && !Array.isArray(stored) ? stored.updatedAt || '' : ''),
    };
  }

  function saveEventCache(events) {
    const values = [...events.values()]
      .map(normalizeCachedEvent)
      .filter(Boolean)
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-MAX_CACHED_EVENTS);
    const updatedAt = new Date().toISOString();
    localStorage.setItem(EVENT_STORAGE_KEY, JSON.stringify({
      version: EVENT_CACHE_VERSION,
      updatedAt,
      events: values,
    }));
    return updatedAt;
  }

  function clearEventCache() {
    localStorage.removeItem(EVENT_STORAGE_KEY);
  }

  const initialConfig = loadConfig();
  const initialDetectedCycle = normalizeAttendanceCycle(initialConfig.detectedCycle);
  const initialCurrentCycle = initialDetectedCycle && isAttendanceCycleForMonth(initialDetectedCycle)
    ? initialDetectedCycle
    : null;
  const initialPeriod = initialCurrentCycle || getNaturalMonthRange();
  const initialEventCache = loadEventCache();
  initialConfig.detectedCycle = initialDetectedCycle;
  initialConfig.rangeStart = initialPeriod.start;
  initialConfig.rangeEnd = initialPeriod.end;

  const state = {
    config: initialConfig,
    events: initialEventCache.events,
    manualAdjustments: loadManualAdjustments(),
    rawSeen: new Set(),
    messageDates: new Set(),
    detectedCycles: new Map(initialDetectedCycle ? [[`${initialDetectedCycle.start}|${initialDetectedCycle.end}`, initialDetectedCycle]] : []),
    periodMode: initialCurrentCycle ? 'detected' : 'natural',
    periodSelectionTouched: false,
    scanning: false,
    abortScan: false,
    locating: false,
    inAttendanceConversation: false,
    cacheUpdatedAt: initialEventCache.updatedAt,
    cacheError: '',
    tableNewestFirst: true,
    scanStats: { examined: 0, parsed: 0, undated: 0, duplicates: 0 },
    status: initialEventCache.events.size
      ? `已从本地缓存恢复 ${initialEventCache.events.size} 条考勤记录，可在任意 Messenger 会话查看。`
      : '尚无本地考勤缓存，可自动定位「假勤」并扫描。',
  };

  function persistEventCache() {
    try {
      state.cacheUpdatedAt = saveEventCache(state.events);
      state.cacheError = '';
      return true;
    } catch (error) {
      state.cacheError = error.message || String(error);
      return false;
    }
  }

  function cacheUpdatedLabel() {
    if (!state.cacheUpdatedAt) return '';
    const date = new Date(state.cacheUpdatedAt);
    if (Number.isNaN(date.getTime())) return '';
    return `${formatDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function latestDetectedCycle() {
    return [...state.detectedCycles.values()]
      .map(normalizeAttendanceCycle)
      .filter(Boolean)
      .sort((left, right) => right.end.localeCompare(left.end) || right.start.localeCompare(left.start))[0] || null;
  }

  function setPeriodState(mode, range, touched = false) {
    state.periodMode = mode;
    if (touched) state.periodSelectionTouched = true;
    state.config.rangeStart = range.start;
    state.config.rangeEnd = range.end;
  }

  function registerAttendanceCycle(value) {
    const cycle = normalizeAttendanceCycle(value);
    if (!cycle) return { added: false, applied: false };
    const key = `${cycle.start}|${cycle.end}`;
    const previous = state.detectedCycles.get(key);
    state.detectedCycles.set(key, cycle);
    const latest = latestDetectedCycle();
    state.config.detectedCycle = latest;
    let applied = false;
    if (isAttendanceCycleForMonth(cycle) && !state.periodSelectionTouched) {
      applied = state.config.rangeStart !== cycle.start || state.config.rangeEnd !== cycle.end || state.periodMode !== 'detected';
      setPeriodState('detected', cycle);
    }
    saveConfig(state.config);
    return { added: !previous, applied };
  }

  function hashText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function eventKey(event) {
    return `${event.date}|${event.inTimes.join(',')}|${event.outTimes.join(',')}|${event.unknownTimes.join(',')}|${hashText(event.text)}`;
  }

  function attrDateValue(value) {
    if (!value) return null;
    const stringValue = String(value).trim();
    if (/^\d{10,13}$/.test(stringValue)) {
      const number = Number(stringValue);
      const date = new Date(stringValue.length === 10 ? number * 1000 : number);
      if (!Number.isNaN(date.getTime()) && date.getFullYear() >= 2000 && date.getFullYear() <= 2100) {
        return formatDate(date);
      }
    }
    const parsed = new Date(stringValue);
    if (!Number.isNaN(parsed.getTime()) && /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(stringValue)) {
      return formatDate(parsed);
    }
    return extractDateFromText(stringValue);
  }

  function metadataDate(element) {
    const attributeNames = [
      'datetime', 'data-time', 'data-timestamp', 'data-create-time', 'data-created-at',
      'data-message-time', 'aria-label', 'title',
    ];
    const nodes = [element];
    let ancestor = element.parentElement;
    for (let index = 0; ancestor && index < 3; index += 1, ancestor = ancestor.parentElement) nodes.push(ancestor);
    for (const descendant of element.querySelectorAll('time,[datetime],[data-timestamp],[data-message-time]')) {
      nodes.push(descendant);
      if (nodes.length > 20) break;
    }
    for (const node of nodes) {
      const idDate = dateFromFeishuMessageId(node.id)
        || dateFromFeishuMessageId(node.getAttribute && node.getAttribute('data-message-id'))
        || dateFromFeishuMessageId(node.getAttribute && node.getAttribute('data-msg-id'));
      if (idDate) return idDate;
      for (const name of attributeNames) {
        const date = attrDateValue(node.getAttribute && node.getAttribute(name));
        if (date) return date;
      }
    }

    // 飞书的外层 messageItem-wrapper 没有 ID，但通常只包着同一条带数字 ID 的消息。
    // 只有所有后代消息 ID 都指向同一天时才采信，避免跨消息容器串日期。
    const descendantDates = new Set();
    for (const descendant of element.querySelectorAll('[id],[data-message-id],[data-msg-id]')) {
      const date = dateFromFeishuMessageId(descendant.id)
        || dateFromFeishuMessageId(descendant.getAttribute('data-message-id'))
        || dateFromFeishuMessageId(descendant.getAttribute('data-msg-id'));
      if (date) descendantDates.add(date);
      if (descendantDates.size > 1) return null;
    }
    if (descendantDates.size === 1) return [...descendantDates][0];
    return null;
  }

  function shortDateFromElement(element, referenceDate) {
    const text = normalizeText(element && element.textContent);
    if (!text || text.length > 90 || !DATE_TOKEN_RE.test(text)) return null;
    return extractDateFromText(text, referenceDate);
  }

  function nearbyDate(element, referenceDate) {
    let branch = element;
    for (let depth = 0; branch && depth < 9; depth += 1, branch = branch.parentElement) {
      let sibling = branch.previousElementSibling;
      for (let count = 0; sibling && count < 14; count += 1, sibling = sibling.previousElementSibling) {
        const direct = shortDateFromElement(sibling, referenceDate);
        if (direct) return direct;
        const children = sibling.querySelectorAll('time,[class*="date"],[class*="time"],[aria-label]');
        for (let index = children.length - 1; index >= 0 && index >= children.length - 10; index -= 1) {
          const childDate = shortDateFromElement(children[index], referenceDate) || metadataDate(children[index]);
          if (childDate) return childDate;
        }
      }
    }
    return null;
  }

  function resolveMessageDate(element, text) {
    const meta = metadataDate(element);
    const reference = parseLocalDate(meta) || new Date();
    return meta
      || extractLeadingMessageDate(text, reference)
      || nearbyDate(element, reference)
      || extractDateFromText(text, reference);
  }

  function relevantElement(element) {
    if (!(element instanceof Element)) return false;
    if (element.closest('script,style,noscript,template,[hidden],[aria-hidden="true"]')) return false;
    const text = normalizeText(element.textContent);
    return text.length >= 2 && text.length <= 5000 && ATTENDANCE_HINT_RE.test(text);
  }

  function collectMessageCandidates() {
    const result = new Set();
    const selectors = [
      '[data-message-id]',
      '[data-msg-id]',
      '[data-testid="message-item"]',
      '[data-testid*="message_item"]',
      '[data-testid*="message-item"]',
      '[class*="message-item"]',
      '[class*="messageItem"]',
      '[class*="MessageItem"]',
      '[role="listitem"]',
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (relevantElement(element)) result.add(element);
      }
    }

    // 飞书类名变化时，退化为从关键词文本节点向上寻找最小的消息卡片。
    if (!result.size) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let textNode;
      let inspected = 0;
      while ((textNode = walker.nextNode()) && inspected < 80000) {
        inspected += 1;
        if (!textNode.parentElement || textNode.parentElement.closest('script,style,noscript,template,[hidden],[aria-hidden="true"]')) continue;
        if (!ATTENDANCE_HINT_RE.test(textNode.nodeValue || '')) continue;
        let element = textNode.parentElement;
        let best = null;
        let bestLength = 0;
        for (let depth = 0; element && depth < 9; depth += 1, element = element.parentElement) {
          const text = normalizeText(element.textContent);
          if (/^(?:MAIN|BODY)$/.test(element.tagName) || text.length > 1800 || (countDateTokens(text) > 2 && !extractAttendanceCycle(text))) break;
          if (best && text.length > Math.max(700, bestLength * 2.5)) break;
          if (text.length >= 6) {
            best = element;
            bestLength = text.length;
          }
          if (element.matches && element.matches(selectors.join(','))) {
            best = element;
            break;
          }
        }
        if (best) result.add(best);
      }
    }
    const candidates = [...result];
    // 同一消息常同时命中 message-item 与其 wrapper；只保留最内层卡片，防止重复解析，
    // 也防止无 ID 的外层容器从相邻日期分隔符继承错误日期。
    return candidates.filter((element) => !candidates.some(
      (other) => other !== element && element.contains(other),
    ));
  }

  function captureVisibleMessages(options = {}) {
    const candidates = collectMessageCandidates();
    const attendanceEvidence = candidates.some((element) => ATTENDANCE_BOT_EVIDENCE_RE.test(normalizeText(element.textContent)));
    let added = 0;
    let parsedCount = 0;
    let undated = 0;
    let cycleApplied = false;
    const cycleKeys = new Set();
    for (const element of candidates) {
      const text = normalizeText(element.textContent);
      if (!text) continue;
      const date = resolveMessageDate(element, text);
      const detectedCycle = extractAttendanceCycle(text, parseLocalDate(date) || new Date());
      if (detectedCycle) {
        cycleKeys.add(`${detectedCycle.start}|${detectedCycle.end}`);
        const registration = registerAttendanceCycle(detectedCycle);
        cycleApplied = registration.applied || cycleApplied;
      }
      const rawKey = `${date || '?'}|${hashText(text)}`;
      if (date) state.messageDates.add(date);
      if (state.rawSeen.has(rawKey)) {
        state.scanStats.duplicates += 1;
        continue;
      }
      state.rawSeen.add(rawKey);
      state.scanStats.examined += 1;
      if (!date) {
        undated += 1;
        state.scanStats.undated += 1;
        continue;
      }
      const event = parseAttendanceMessage(text, date, state.config, { dateResolved: true });
      if (!event) continue;
      parsedCount += 1;
      const key = eventKey(event);
      if (!state.events.has(key)) {
        state.events.set(key, event);
        state.scanStats.parsed += 1;
        added += 1;
      }
    }
    if (options.updateConversationState) state.inAttendanceConversation = attendanceEvidence;
    else if (attendanceEvidence) state.inAttendanceConversation = true;
    if (added) persistEventCache();
    if (!options.silent) {
      state.status = candidates.length
        ? `本次检查 ${candidates.length} 个候选消息，新增 ${added} 条考勤记录${cycleKeys.size ? `，识别到 ${cycleKeys.size} 个机器人周期` : ''}${undated ? `，${undated} 条未识别日期` : ''}${state.cacheError ? `；本地缓存失败：${state.cacheError}` : '，结果已保存到本地'}。`
        : state.events.size
          ? `当前不是「假勤」会话；继续显示本地缓存中的 ${state.events.size} 条记录。需要更新时可自动定位并扫描。`
          : '当前不是「假勤」会话，且本地尚无缓存。可自动定位并扫描「假勤」。';
      render();
    }
    return { candidates, added, parsedCount, undated, cyclesFound: cycleKeys.size, cycleApplied, attendanceEvidence };
  }

  function findScrollContainer(seedElements) {
    const candidates = new Set();
    for (const seed of seedElements || []) {
      let node = seed.parentElement;
      for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) candidates.add(node);
    }
    for (const selector of ['[class*="scroll"]', '[class*="virtual"]', '[role="log"]', '[role="list"]']) {
      for (const node of document.querySelectorAll(selector)) candidates.add(node);
    }
    let best = null;
    let bestScore = -Infinity;
    for (const element of candidates) {
      if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement) continue;
      const overflow = element.scrollHeight - element.clientHeight;
      if (overflow < 120 || element.clientHeight < 220) continue;
      const style = getComputedStyle(element);
      if (!/(?:auto|scroll)/.test(style.overflowY) && !/scroll|virtual/i.test(element.className || '')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 280 || rect.height < 220) continue;
      const contained = (seedElements || []).reduce((total, seed) => total + (element.contains(seed) ? 1 : 0), 0);
      const score = contained * 1000 + Math.min(overflow, 100000) / 100 + rect.width / 10 + rect.height / 10;
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    }
    return best;
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function earliestCapturedMessageDate() {
    const dates = [...state.messageDates].filter(Boolean).sort();
    return dates[0] || '';
  }

  function findAttendanceConversationEntry() {
    // 支持飞书中文和英文界面的会话名称。
    const labelPattern = /^(?:假勤|Attendance(?:\s+Bot)?)$/i;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const matches = [];
    let textNode;
    let inspected = 0;
    while ((textNode = walker.nextNode()) && inspected < 80000) {
      inspected += 1;
      if (!labelPattern.test(normalizeText(textNode.nodeValue))) continue;
      let element = textNode.parentElement;
      for (let depth = 0; element && depth < 7; depth += 1, element = element.parentElement) {
        if (element === host || host.contains(element)) break;
        const rect = element.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 24 || rect.height > 130 || rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
        const style = getComputedStyle(element);
        const clickable = element.matches('button,a,[role="button"],[role="option"],[role="listitem"],[data-testid*="chat"],[data-testid*="conversation"]')
          || style.cursor === 'pointer'
          || typeof element.onclick === 'function';
        if (!clickable) continue;
        const textLength = normalizeText(element.textContent).length;
        const sidebarPenalty = rect.left < window.innerWidth * 0.48 ? 0 : 10000;
        const score = sidebarPenalty + rect.left * 10 + Math.abs(rect.height - 56) * 4 + Math.min(textLength, 1000);
        matches.push({ element, score });
        break;
      }
    }
    return matches.sort((left, right) => left.score - right.score)[0]?.element || null;
  }

  async function locateAttendanceConversation() {
    if (state.locating) return false;
    const current = captureVisibleMessages({ silent: true, updateConversationState: true });
    if (current.attendanceEvidence || current.parsedCount || current.cyclesFound) return true;
    const entry = findAttendanceConversationEntry();
    if (!entry) {
      state.inAttendanceConversation = false;
      state.status = state.events.size
        ? `当前不是「假勤」会话，已继续使用 ${state.events.size} 条本地缓存；左侧已加载会话中未找到「假勤」，暂时无法自动更新。`
        : '当前不是「假勤」会话，且左侧已加载会话中未找到「假勤」。请先在飞书中搜索并打开一次「假勤」。';
      render();
      return false;
    }

    state.locating = true;
    state.status = '正在切换到「假勤」会话……';
    render();
    entry.scrollIntoView({ block: 'center', inline: 'nearest' });
    entry.click();
    let located = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(250);
      const probe = captureVisibleMessages({ silent: true, updateConversationState: true });
      if (probe.attendanceEvidence || probe.parsedCount || probe.cyclesFound) {
        located = true;
        break;
      }
    }
    state.locating = false;
    state.inAttendanceConversation = located;
    state.status = located
      ? '已自动切换到「假勤」会话，准备扫描完整考勤周期。'
      : state.events.size
        ? `未能确认「假勤」会话，继续显示 ${state.events.size} 条本地缓存；可在飞书中打开「假勤」后重试更新。`
        : '未能确认「假勤」会话，请在飞书中打开「假勤」后重试。';
    render();
    return located;
  }

  async function scanHistory() {
    if (state.scanning) {
      state.abortScan = true;
      state.status = '正在停止扫描……';
      render();
      return;
    }
    if (!applyFormConfig()) return;
    if (state.locating) return;
    state.messageDates.clear();
    let first = captureVisibleMessages({ silent: true, updateConversationState: true });
    if (!first.attendanceEvidence) {
      const located = await locateAttendanceConversation();
      if (!located) return;
      state.messageDates.clear();
      first = captureVisibleMessages({ silent: true, updateConversationState: true });
    }
    state.scanning = true;
    state.abortScan = false;
    state.status = '正在定位消息列表……';
    render();

    const scroller = findScrollContainer(first.candidates);
    if (!scroller) {
      state.scanning = false;
      state.status = `已进入「假勤」会话，但没有找到消息滚动区域；当前仍可查看 ${state.events.size} 条本地缓存，也可以扫描当前页面或粘贴消息文本。`;
      render();
      return;
    }

    const initialTop = scroller.scrollTop;
    const initiallyNearBottom = initialTop + scroller.clientHeight >= scroller.scrollHeight * 0.8;
    let stalls = 0;
    let reachedRange = false;
    let steps = 0;
    for (; steps < 100 && !state.abortScan; steps += 1) {
      const result = captureVisibleMessages({ silent: true });
      if (result.cycleApplied) reachedRange = false;
      const earliest = earliestCapturedMessageDate();
      if (earliest && earliest < state.config.rangeStart) {
        reachedRange = true;
        break;
      }
      state.status = `自动扫描第 ${steps + 1} 页：已解析 ${state.events.size} 条记录${earliest ? `，最早消息到 ${earliest}` : ''}。再次点击可停止。`;
      renderStatus();

      const beforeTop = scroller.scrollTop;
      const beforeHeight = scroller.scrollHeight;
      const distance = Math.max(260, Math.floor(scroller.clientHeight * 0.78));
      scroller.scrollTop = Math.max(0, beforeTop - distance);
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(beforeTop <= 3 ? 900 : 420);
      const moved = Math.abs(scroller.scrollTop - beforeTop) > 2 || scroller.scrollHeight !== beforeHeight;
      if (!moved && !result.added) stalls += 1;
      else stalls = 0;
      if (stalls >= 4) break;
    }

    captureVisibleMessages({ silent: true });
    const finalEarliestMessage = earliestCapturedMessageDate();
    if (!reachedRange && finalEarliestMessage && finalEarliestMessage <= state.config.rangeStart && stalls >= 4) reachedRange = true;
    if (initiallyNearBottom) {
      let stableBottomPasses = 0;
      for (let pass = 0; pass < 24 && stableBottomPasses < 2; pass += 1) {
        const beforeHeight = scroller.scrollHeight;
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(220);
        const nearBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 3;
        stableBottomPasses = nearBottom && scroller.scrollHeight === beforeHeight ? stableBottomPasses + 1 : 0;
      }
    } else {
      scroller.scrollTop = Math.min(initialTop, scroller.scrollHeight - scroller.clientHeight);
    }
    state.scanning = false;
    const stopped = state.abortScan;
    state.abortScan = false;
    state.status = stopped
      ? `扫描已停止，共解析 ${state.events.size} 条记录。`
      : reachedRange
        ? `扫描完成，已覆盖周期起始日 ${state.config.rangeStart}，共解析 ${state.events.size} 条记录。`
        : `扫描停止于消息列表顶部或连续无新内容处，共解析 ${state.events.size} 条记录；请检查最早记录是否覆盖所选周期。`;
    render();
  }

  function parsePastedText(raw) {
    const text = normalizeText(raw);
    if (!text) return 0;
    const lines = text.split('\n');
    let activeDate = null;
    let buffer = [];
    const chunks = [];
    const flush = () => {
      if (buffer.length) chunks.push({ text: buffer.join('\n'), date: activeDate });
      buffer = [];
    };
    for (const line of lines) {
      const lineDate = line.length <= 90 && DATE_TOKEN_RE.test(line) ? extractDateFromText(line, parseLocalDate(activeDate) || new Date()) : null;
      if (lineDate && (line.trim().length <= 28 || !ATTENDANCE_HINT_RE.test(line))) {
        flush();
        activeDate = lineDate;
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      buffer.push(line);
    }
    flush();

    let added = 0;
    for (const chunk of chunks) {
      const date = extractDateFromText(chunk.text, parseLocalDate(chunk.date) || new Date()) || chunk.date;
      const detectedCycle = extractAttendanceCycle(chunk.text, parseLocalDate(date) || new Date());
      if (detectedCycle) registerAttendanceCycle(detectedCycle);
      const event = parseAttendanceMessage(chunk.text, date, state.config, { dateResolved: true });
      if (!event) continue;
      event.source = 'paste';
      const key = eventKey(event);
      if (!state.events.has(key)) {
        state.events.set(key, event);
        added += 1;
      }
    }
    if (added) persistEventCache();
    return added;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  const host = document.createElement('div');
  host.id = APP_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        --fa-primary: #1e40af;
        --fa-primary-strong: #1e3a8a;
        --fa-primary-soft: #eff6ff;
        --fa-ink: #172033;
        --fa-muted: #536075;
        --fa-subtle: #667085;
        --fa-border: #e3e8f1;
        --fa-canvas: #f8fafc;
        --fa-surface: #ffffff;
        --fa-danger: #b4232b;
        --fa-danger-soft: #fff1f2;
        --fa-warning: #9a4f00;
        --fa-warning-soft: #fff7e8;
        --fa-success: #08734f;
        --fa-success-soft: #eaf8f2;
        --fa-shadow: 0 24px 70px rgba(20, 31, 56, .18);
        --fa-font: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      *, *::before, *::after { box-sizing: border-box; }
      button, input, select, textarea { font: inherit; }
      button { -webkit-tap-highlight-color: transparent; }
      svg { display: block; }
      #fab {
        position: fixed; right: 22px; bottom: 82px; z-index: 2147483600;
        display: inline-flex; align-items: center; gap: 9px; height: 48px; padding: 0 16px 0 11px;
        border: 1px solid rgba(255,255,255,.2); border-radius: 16px; color: #fff;
        background: linear-gradient(135deg, #3b82f6 0%, #1e40af 100%);
        box-shadow: 0 10px 30px rgba(38, 91, 224, .34), inset 0 1px rgba(255,255,255,.22);
        cursor: pointer; font: 650 14px/1 var(--fa-font); letter-spacing: .01em;
        transition: transform .2s ease, box-shadow .2s ease;
      }
      #fab:hover { transform: translateY(-2px); box-shadow: 0 14px 36px rgba(38, 91, 224, .4), inset 0 1px rgba(255,255,255,.22); }
      #fab:active { transform: translateY(0); }
      .fab-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; background: rgba(255,255,255,.16); }
      .fab-mark svg { width: 17px; height: 17px; }
      .fab-dot { width: 6px; height: 6px; margin-left: 1px; border-radius: 50%; background: #69e2b5; box-shadow: 0 0 0 3px rgba(105,226,181,.18); }
      #backdrop {
        display: none; position: fixed; inset: 0; z-index: 2147483601; justify-content: flex-end;
        background: rgba(15, 23, 42, .42); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
        font-family: var(--fa-font); color: var(--fa-ink);
      }
      #backdrop.open { display: flex; animation: fa-fade-in .18s ease-out; }
      #panel {
        position: relative; width: min(920px, calc(100vw - 28px)); height: 100dvh;
        display: flex; flex-direction: column; overflow: hidden;
        background: var(--fa-canvas); border-left: 1px solid rgba(255,255,255,.7); border-radius: 24px 0 0 24px;
        box-shadow: var(--fa-shadow); animation: fa-slide-in .26s cubic-bezier(.2,.8,.2,1);
      }
      #panel:focus { outline: none; }
      @keyframes fa-fade-in { from { opacity: 0; } }
      @keyframes fa-slide-in { from { transform: translateX(32px); opacity: .6; } }
      .app-header {
        position: relative; z-index: 4; display: flex; align-items: center; gap: 12px; min-height: 72px;
        padding: 13px 20px; background: rgba(255,255,255,.94); border-bottom: 1px solid var(--fa-border);
        backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      }
      .brand-mark { display: grid; place-items: center; flex: 0 0 auto; width: 42px; height: 42px; border-radius: 13px; color: #fff; background: linear-gradient(145deg, #3b82f6, #1e40af); box-shadow: 0 7px 18px rgba(30,64,175,.25); }
      .brand-mark svg { width: 22px; height: 22px; }
      .brand-copy { min-width: 0; flex: 1; }
      .brand-copy h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 17px; line-height: 1.3; font-weight: 720; letter-spacing: -.01em; }
      .version { padding: 2px 6px; border-radius: 999px; color: var(--fa-primary); background: var(--fa-primary-soft); font-size: 10px; font-weight: 700; }
      .brand-copy p { margin: 3px 0 0; color: var(--fa-muted); font-size: 11px; }
      .privacy-pill { display: inline-flex; align-items: center; gap: 6px; padding: 7px 10px; border: 1px solid #d9eee5; border-radius: 999px; color: #247456; background: #f1faf6; font-size: 11px; font-weight: 600; }
      .privacy-pill svg { width: 13px; height: 13px; }
      .icon-btn { display: grid; place-items: center; width: 38px; height: 38px; border: 0; border-radius: 11px; background: transparent; color: #667085; cursor: pointer; transition: background .16s ease, color .16s ease; }
      .icon-btn:hover { color: var(--fa-ink); background: #f0f2f6; }
      .icon-btn svg { width: 19px; height: 19px; }
      main { flex: 1; overflow: auto; padding: 18px 20px 30px; scrollbar-gutter: stable; }
      main::-webkit-scrollbar, .table-wrap::-webkit-scrollbar { width: 8px; height: 8px; }
      main::-webkit-scrollbar-thumb, .table-wrap::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 99px; background: #c4cad5; background-clip: padding-box; }
      .card { margin-bottom: 14px; background: var(--fa-surface); border: 1px solid var(--fa-border); border-radius: 16px; box-shadow: 0 1px 2px rgba(16,24,40,.025); }
      .control-card { padding: 17px; }
      .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
      .eyebrow { display: block; margin-bottom: 4px; color: var(--fa-primary); font-size: 10px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
      .section-heading h3, .table-title h3 { margin: 0; color: var(--fa-ink); font-size: 15px; line-height: 1.35; font-weight: 700; }
      .section-heading p, .table-title p { margin: 4px 0 0; color: var(--fa-muted); font-size: 11px; }
      .schedule-chip { max-width: 54%; padding: 7px 10px; overflow: hidden; border: 1px solid #dce6ff; border-radius: 9px; color: #385691; background: #f4f7ff; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
      .period-grid { display: grid; grid-template-columns: minmax(180px, 1fr) 20px minmax(180px, 1fr) auto; gap: 10px; align-items: end; }
      .date-field { display: block; color: var(--fa-muted); font-size: 11px; font-weight: 600; }
      .date-field > span { display: block; margin-bottom: 6px; }
      .range-arrow { display: grid; place-items: center; height: 42px; color: #a0a8b8; }
      .range-arrow svg { width: 15px; height: 15px; }
      .preset-group { display: flex; gap: 6px; padding: 4px; border-radius: 11px; background: #f1f3f7; }
      input[type="date"], input[type="time"], input[type="number"], input[type="text"], select, textarea {
        width: 100%; min-height: 40px; padding: 8px 10px; border: 1px solid #d7dce5; border-radius: 10px;
        outline: none; color: var(--fa-ink); background: #fff; font-size: 13px; transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
      }
      input:hover, select:hover, textarea:hover { border-color: #bfc7d5; }
      input:focus, select:focus, textarea:focus { border-color: var(--fa-primary); box-shadow: 0 0 0 3px rgba(47,107,255,.12); }
      button.action { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 38px; padding: 8px 12px; border: 1px solid #d4dae4; border-radius: 10px; color: #344054; background: #fff; cursor: pointer; font-size: 12px; font-weight: 650; white-space: nowrap; transition: transform .16s ease, background .16s ease, border-color .16s ease, box-shadow .16s ease; }
      button.action:hover { border-color: #bec6d4; background: #f8f9fb; }
      button.action:active { transform: translateY(1px); }
      button.action:disabled { opacity: .48; cursor: not-allowed; box-shadow: none; transform: none; }
      button.action:disabled:hover { border-color: #d4dae4; background: #fff; }
      button.action svg { width: 15px; height: 15px; }
      button.action.primary { min-height: 42px; padding-inline: 16px; border-color: var(--fa-primary); color: #fff; background: linear-gradient(135deg, #3b82f6, var(--fa-primary)); box-shadow: 0 6px 16px rgba(30,64,175,.2); }
      button.action.primary:hover { border-color: #172f83; background: linear-gradient(135deg, #3275df, var(--fa-primary-strong)); box-shadow: 0 8px 20px rgba(30,64,175,.27); }
      button.action.ghost { border-color: transparent; color: var(--fa-muted); background: transparent; }
      button.action.ghost:hover { color: var(--fa-ink); background: #f1f3f7; }
      button.action.danger { border-color: #ffd4d7; color: var(--fa-danger); background: var(--fa-danger-soft); box-shadow: none; }
      .preset-group button.action { min-height: 34px; padding: 6px 9px; border: 0; background: transparent; font-size: 11px; }
      .preset-group button.action:hover { background: #fff; box-shadow: 0 1px 3px rgba(16,24,40,.08); }
      .preset-group button.action[aria-pressed="true"] { color: var(--fa-primary); background: #fff; box-shadow: 0 1px 4px rgba(16,24,40,.12), inset 0 0 0 1px #c9d8ff; }
      .preset-check { display: none; place-items: center; width: 14px; height: 14px; color: var(--fa-primary); }
      .preset-check svg { width: 13px !important; height: 13px !important; }
      .preset-group button[aria-pressed="true"] .preset-check { display: grid; }
      .cycle-source { grid-column: 1 / -1; display: flex; align-items: center; gap: 7px; min-height: 22px; margin: -1px 0 0; color: var(--fa-muted); font-size: 11px; line-height: 1.45; }
      .cycle-source-icon { display: grid; place-items: center; flex: 0 0 auto; width: 20px; height: 20px; border-radius: 7px; color: var(--fa-primary); background: var(--fa-primary-soft); }
      .cycle-source-icon svg { width: 12px; height: 12px; }
      .scan-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid #eef0f4; }
      .status { position: relative; margin-top: 10px; padding: 10px 12px 10px 34px; overflow: hidden; border: 1px solid #dce6ff; border-radius: 11px; color: #3c5892; background: #f4f7ff; font-size: 11px; line-height: 1.55; }
      .status::before { content: ""; position: absolute; left: 13px; top: 14px; width: 8px; height: 8px; border-radius: 50%; background: #6d91ea; box-shadow: 0 0 0 4px rgba(109,145,234,.12); }
      .status.is-scanning::before { background: var(--fa-primary); animation: fa-pulse 1.1s ease-in-out infinite; }
      .status.is-scanning::after { content: ""; position: absolute; left: -40%; bottom: 0; width: 40%; height: 2px; background: linear-gradient(90deg, transparent, var(--fa-primary), transparent); animation: fa-progress 1.4s linear infinite; }
      @keyframes fa-pulse { 50% { transform: scale(.7); opacity: .55; } }
      @keyframes fa-progress { to { left: 100%; } }
      details > summary { list-style: none; }
      details > summary::-webkit-details-marker { display: none; }
      .rule-card { margin-top: 12px; padding-top: 12px; border-top: 1px solid #eef0f4; }
      .rule-card > summary, .import-card > summary { display: flex; align-items: center; gap: 10px; min-height: 38px; border-radius: 10px; cursor: pointer; color: var(--fa-ink); }
      .summary-icon { display: grid; place-items: center; flex: 0 0 auto; width: 30px; height: 30px; border-radius: 9px; color: var(--fa-primary); background: var(--fa-primary-soft); }
      .summary-icon svg { width: 15px; height: 15px; }
      .summary-copy { min-width: 0; flex: 1; }
      .summary-copy b { display: block; font-size: 12px; }
      .summary-copy small { display: block; margin-top: 2px; overflow: hidden; color: var(--fa-muted); font-size: 10px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
      .chevron { color: #98a2b3; transition: transform .2s ease; }
      .chevron svg { width: 16px; height: 16px; }
      details[open] > summary .chevron { transform: rotate(180deg); }
      .settings { display: grid; grid-template-columns: repeat(4, minmax(100px, 1fr)); gap: 12px; padding-top: 14px; }
      label { display: block; color: #667085; font-size: 11px; font-weight: 580; }
      label > input, label > select, label > textarea { margin-top: 6px; color: var(--fa-ink); font-size: 12px; font-weight: 400; }
      .span-2 { grid-column: span 2; }
      .span-4 { grid-column: 1 / -1; }
      .schedule-fields { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(4, minmax(100px, 1fr)); gap: 10px; padding: 12px; border: 1px solid #e4eaff; border-radius: 12px; background: #f7f9ff; }
      .schedule-fields.hidden { display: none; }
      .weekdays { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 7px; }
      .weekdays label { display: inline-flex; align-items: center; gap: 4px; min-height: 30px; padding: 5px 9px; border: 1px solid #e0e4eb; border-radius: 9px; color: #475467; background: #fff; cursor: pointer; font-size: 11px; }
      .weekdays label:has(input:checked) { border-color: #adc3ff; color: #2456cc; background: #f1f5ff; }
      .weekdays input { width: 13px; height: 13px; margin: 0; accent-color: var(--fa-primary); }
      .check-option { display: flex; align-items: center; gap: 7px; min-height: 40px; padding: 8px 10px; border: 1px solid #e4e7ec; border-radius: 10px; color: #475467; background: #fafbfc; }
      .check-option input { width: 14px; height: 14px; margin: 0; accent-color: var(--fa-primary); }
      .hint { margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; color: #697386; background: #f7f8fa; font-size: 10px; line-height: 1.65; }
      .overview { margin-bottom: 14px; }
      .overview-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin: 2px 2px 10px; }
      .overview-head h3 { margin: 0; font-size: 14px; }
      .overview-head p { margin: 3px 0 0; color: var(--fa-muted); font-size: 10px; }
      .overview-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
      .coverage-pill { padding: 5px 8px; border: 1px solid #d9eee5; border-radius: 999px; color: var(--fa-success); background: var(--fa-success-soft); font-size: 10px; font-weight: 650; }
      .cache-pill { padding: 5px 8px; border: 1px solid #dce6ff; border-radius: 999px; color: #315bc7; background: #edf3ff; font-size: 10px; font-weight: 650; }
      .cache-pill.warning { border-color: #f5dcae; color: var(--fa-warning); background: var(--fa-warning-soft); }
      .summary { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
      .work-summary { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 8px; }
      .metric { position: relative; min-height: 88px; padding: 12px; overflow: hidden; border: 1px solid var(--fa-border); border-radius: 13px; background: #fff; }
      .metric::after { content: ""; position: absolute; right: -18px; top: -22px; width: 62px; height: 62px; border-radius: 50%; background: var(--metric-soft, #f1f4f8); }
      .metric-label { position: relative; z-index: 1; display: flex; align-items: center; gap: 6px; color: var(--fa-muted); font-size: 10px; }
      .metric-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--metric-color, #7c8ba1); }
      .metric b { position: relative; z-index: 1; display: block; margin-top: 8px; color: var(--metric-color, var(--fa-ink)); font-size: 24px; line-height: 1; font-weight: 720; letter-spacing: -.03em; }
      .metric small { position: relative; z-index: 1; display: block; margin-top: 6px; color: var(--fa-subtle); font-size: 10px; }
      .metric[data-tone="primary"] { --metric-color: var(--fa-primary); --metric-soft: #edf3ff; }
      .metric[data-tone="success"] { --metric-color: var(--fa-success); --metric-soft: #e9f8f1; }
      .metric[data-tone="danger"] { --metric-color: var(--fa-danger); --metric-soft: #fff0f1; }
      .metric[data-tone="warning"] { --metric-color: var(--fa-warning); --metric-soft: #fff6e6; }
      .work-summary .metric b { font-size: 20px; }
      .work-summary-note { margin: 8px 2px 0; color: var(--fa-muted); font-size: 10px; line-height: 1.55; }
      .trend-card { padding: 16px; }
      .trend-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
      .trend-head h3 { margin: 0; color: var(--fa-ink); font-size: 14px; line-height: 1.4; }
      .trend-head p { margin: 4px 0 0; color: var(--fa-muted); font-size: 10px; line-height: 1.5; }
      .trend-legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px 14px; color: var(--fa-muted); font-size: 10px; }
      .legend-item { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
      .legend-candle { position: relative; display: inline-block; flex: 0 0 auto; width: 10px; height: 16px; color: #667085; }
      .legend-candle::before { content: ""; position: absolute; left: 4px; top: 0; width: 2px; height: 16px; border-radius: 2px; background: currentColor; }
      .legend-candle::after { content: ""; position: absolute; left: 1px; top: 4px; width: 8px; height: 8px; border: 1px solid currentColor; border-radius: 2px; background: currentColor; }
      .legend-candle.up { color: #067647; }
      .legend-candle.up::after { background: #ecfdf3; }
      .legend-candle.down { color: #b42318; }
      .legend-candle.flat::after { top: 7px; height: 2px; border: 0; border-radius: 2px; }
      .legend-direction { color: var(--fa-ink); font-weight: 700; }
      .legend-direction.up { color: #067647; }
      .legend-direction.down { color: #b42318; }
      .legend-swatch { display: inline-block; flex: 0 0 auto; width: 18px; height: 3px; border-radius: 99px; background: #8090aa; }
      .legend-swatch.average { height: 0; border-top: 2px dashed #8090aa; border-radius: 0; background: transparent; }
      .legend-swatch.gap { width: 8px; height: 8px; border: 2px solid #98a2b3; border-radius: 50%; background: #fff; }
      .trend-scroll { overflow-x: auto; overflow-y: hidden; border: 1px solid #edf0f5; border-radius: 13px; background: linear-gradient(180deg, #fbfdff, #fff); scrollbar-width: thin; }
      .trend-figure { margin: 0; }
      .trend-stage { position: relative; min-width: 720px; }
      .overtime-chart { display: block; width: 100%; height: auto; font-family: var(--fa-font); }
      .chart-grid { stroke: #e8edf5; stroke-width: 1; vector-effect: non-scaling-stroke; }
      .chart-axis-label { fill: #748096; font-size: 10px; font-variant-numeric: tabular-nums; }
      .chart-average { stroke: #8090aa; stroke-width: 1.4; stroke-dasharray: 5 5; vector-effect: non-scaling-stroke; }
      .chart-average-label { fill: #667085; font-size: 9px; font-weight: 650; }
      .chart-point { --candle-color: #667085; --candle-fill: #98a2b3; cursor: pointer; outline: none; }
      .chart-point.up { --candle-color: #067647; --candle-fill: #ecfdf3; }
      .chart-point.down { --candle-color: #b42318; --candle-fill: #f04438; }
      .chart-point.flat { --candle-color: #475467; --candle-fill: #98a2b3; }
      .chart-hit { fill: transparent; pointer-events: all; }
      .chart-candle-wick { stroke: var(--candle-color); stroke-width: 2; stroke-linecap: round; vector-effect: non-scaling-stroke; }
      .chart-candle-body { fill: var(--candle-fill); stroke: var(--candle-color); stroke-width: 1.4; vector-effect: non-scaling-stroke; transition: filter .16s ease, stroke-width .16s ease; }
      .chart-candle-doji { stroke: var(--candle-color); stroke-width: 3; stroke-linecap: round; vector-effect: non-scaling-stroke; }
      .chart-focus-ring { fill: none; stroke: transparent; stroke-width: 2; vector-effect: non-scaling-stroke; }
      .chart-point:hover .chart-candle-body, .chart-point:focus-visible .chart-candle-body { filter: drop-shadow(0 2px 3px rgba(15,23,42,.2)); stroke-width: 2.8; }
      .chart-point:hover .chart-candle-doji, .chart-point:focus-visible .chart-candle-doji { stroke-width: 5; }
      .chart-point:focus-visible .chart-focus-ring { stroke: #155eef; stroke-dasharray: 3 2; }
      .chart-peak-marker { fill: #b54708; stroke: #fff; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
      .chart-gap-marker { fill: #fff; stroke: #98a2b3; stroke-width: 2.2; stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; transition: stroke-width .16s ease; }
      .chart-point.gap:hover .chart-gap-marker, .chart-point.gap:focus-visible .chart-gap-marker { stroke-width: 4; }
      .chart-tooltip { position: absolute; z-index: 3; left: 0; top: 0; width: max-content; min-width: 148px; max-width: 240px; padding: 8px 10px; border: 1px solid #d9e2f2; border-radius: 9px; color: #fff; background: #172033; box-shadow: 0 8px 24px rgba(15,23,42,.2); font-size: 10px; line-height: 1.55; white-space: pre-line; pointer-events: none; opacity: 0; transform: translate(-50%, calc(-100% - 8px)); transition: opacity .14s ease; }
      .chart-tooltip.open { opacity: 1; }
      .chart-tooltip.below { transform: translate(-50%, 8px); }
      .trend-empty { display: grid; min-height: 180px; place-items: center; padding: 28px; color: var(--fa-muted); text-align: center; font-size: 11px; line-height: 1.7; }
      .trend-mobile-hint { display: none; margin: 8px 2px 0; color: var(--fa-muted); font-size: 10px; }
      .sr-only { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0,0,0,0) !important; white-space: nowrap !important; border: 0 !important; }
      .table-card { padding: 0; overflow: hidden; }
      .table-title { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 12px 14px 12px 16px; border-bottom: 1px solid var(--fa-border); }
      .table-title-copy { min-width: 0; flex: 1; }
      .table-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
      .table-wrap { max-height: min(520px, calc(100vh - 360px)); overflow: auto; background: #fff; }
      table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 11px; background: #fff; }
      th { position: sticky; top: 0; z-index: 2; padding: 9px 10px; border-bottom: 1px solid var(--fa-border); color: #697386; background: rgba(248,249,251,.96); backdrop-filter: blur(8px); font-size: 10px; font-weight: 700; letter-spacing: .04em; text-align: left; text-transform: uppercase; white-space: nowrap; }
      td { position: relative; padding: 11px 10px; border-bottom: 1px solid #edf0f4; color: #344054; text-align: left; white-space: nowrap; transition: background .14s ease; }
      tbody tr:last-child td { border-bottom: 0; }
      tbody tr:hover td { background: #f8faff; }
      tr.abnormal td:first-child::before, tr.pending td:first-child::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 0 3px 3px 0; background: var(--fa-danger); }
      tr.pending td:first-child::before { background: #e69a23; }
      tr.rest td { color: #9299a7; background: #fbfcfd; }
      .date-cell strong { display: block; color: var(--fa-ink); font-size: 11px; }
      .date-cell span { display: block; margin-top: 3px; color: var(--fa-subtle); font-size: 10px; }
      .day-type, .source-count, .manual-badge { display: inline-flex; align-items: center; padding: 3px 6px; border-radius: 999px; color: #536075; background: #f0f2f5; font-size: 10px; font-weight: 600; }
      .day-type.rest { color: #7c8492; background: #f3f4f6; }
      .manual-badge { color: #315bc7; background: #edf3ff; }
      .source-stack { display: flex; align-items: center; gap: 4px; }
      .edit-row { min-height: 30px !important; padding: 5px 8px !important; }
      .time-value { color: var(--fa-ink); font-variant-numeric: tabular-nums; font-weight: 650; }
      .time-value.muted { color: #a2a9b5; font-weight: 500; }
      .status-list { display: flex; flex-wrap: wrap; gap: 4px; }
      .status-pill { display: inline-flex; align-items: center; min-height: 22px; padding: 3px 7px; border-radius: 999px; color: #536075; background: #f0f2f5; font-size: 10px; font-weight: 650; }
      .status-pill.success { color: var(--fa-success); background: var(--fa-success-soft); }
      .status-pill.danger { color: var(--fa-danger); background: var(--fa-danger-soft); }
      .status-pill.warning { color: var(--fa-warning); background: var(--fa-warning-soft); }
      .status-pill.info { color: #315bc7; background: #edf3ff; }
      .manual-dialog { width: min(560px, calc(100vw - 24px)); max-height: min(760px, calc(100dvh - 24px)); padding: 0; overflow: hidden; border: 1px solid var(--fa-border); border-radius: 18px; color: var(--fa-ink); background: #fff; box-shadow: 0 28px 90px rgba(15,23,42,.3); font-family: var(--fa-font); }
      .manual-dialog::backdrop { background: rgba(15,23,42,.5); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
      .manual-form { display: flex; max-height: min(760px, calc(100dvh - 24px)); flex-direction: column; }
      .manual-head { display: flex; align-items: flex-start; gap: 12px; padding: 17px 18px 14px; border-bottom: 1px solid var(--fa-border); }
      .manual-head-copy { min-width: 0; flex: 1; }
      .manual-head h3 { margin: 0; font-size: 16px; line-height: 1.4; }
      .manual-head p { margin: 4px 0 0; color: var(--fa-muted); font-size: 11px; line-height: 1.5; }
      .manual-body { overflow: auto; padding: 16px 18px; }
      .manual-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px; }
      .manual-grid .full { grid-column: 1 / -1; }
      .manual-next-day { margin-top: 2px; }
      .manual-hint { margin: 13px 0 0; padding: 10px 12px; border: 1px solid #dce6ff; border-radius: 10px; color: #3c5892; background: #f4f7ff; font-size: 11px; line-height: 1.6; }
      .manual-hint[data-tone="warning"] { border-color: #f5dcae; color: var(--fa-warning); background: var(--fa-warning-soft); }
      .manual-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 13px 18px; border-top: 1px solid var(--fa-border); background: #fafbfc; }
      .manual-actions .delete { margin-right: auto; }
      .manual-error { min-height: 18px; margin: 10px 0 0; color: var(--fa-danger); font-size: 11px; line-height: 1.5; }
      .import-card { padding: 13px 15px; }
      .import-body { padding-top: 10px; }
      textarea#importText { min-height: 104px; resize: vertical; line-height: 1.6; }
      .empty { display: grid; place-items: center; min-height: 160px; padding: 28px; color: var(--fa-muted); text-align: center; }
      button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 3px solid rgba(47,107,255,.25); outline-offset: 2px; }
      @media (max-width: 760px) {
        #fab { right: 14px; bottom: 70px; width: 48px; padding: 0; justify-content: center; border-radius: 15px; }
        #fab .fab-label, #fab .fab-dot { display: none; }
        #panel { width: 100vw; border-radius: 0; }
        .app-header { min-height: 64px; padding: 10px 14px; }
        .icon-btn { width: 44px; height: 44px; }
        button.action, button.action.primary, .preset-group button.action { min-height: 44px; }
        input[type="date"], input[type="time"], input[type="number"], input[type="text"], select, textarea { min-height: 44px; }
        .privacy-pill { display: none; }
        main { padding: 14px 12px 24px; }
        .control-card { padding: 14px; }
        .section-heading { display: block; }
        .schedule-chip { display: block; max-width: 100%; margin-top: 9px; }
        .period-grid { grid-template-columns: 1fr 16px 1fr; }
        .preset-group { grid-column: 1 / -1; justify-self: start; }
        .scan-actions button.primary { flex: 1; }
        .settings { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .schedule-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .span-4 { grid-column: 1 / -1; }
        .summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .work-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .metric { min-height: 82px; }
        .overview-head { align-items: flex-start; }
        .trend-head { flex-direction: column; }
        .trend-legend { justify-content: flex-start; }
        .trend-mobile-hint { display: block; }
        .table-title { align-items: flex-start; flex-wrap: wrap; }
        .table-title-copy { flex-basis: 100%; }
        .table-wrap { max-height: 460px; }
      }
      @media (min-width: 461px) and (max-width: 820px) {
        .period-grid { grid-template-columns: minmax(0, 1fr) 16px minmax(0, 1fr); }
        .preset-group { grid-column: 1 / -1; justify-self: start; }
      }
      @media (max-width: 460px) {
        .brand-copy p { display: none; }
        .period-grid { grid-template-columns: 1fr; }
        .range-arrow { display: none; }
        .preset-group { width: 100%; }
        .preset-group button { flex: 1; }
        .scan-actions { align-items: stretch; }
        .scan-actions button { width: 100%; }
        .settings, .schedule-fields { grid-template-columns: 1fr; }
        .span-2 { grid-column: 1 / -1; }
        .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .trend-card { padding: 13px; }
        .manual-grid { grid-template-columns: 1fr; }
        .manual-grid .full { grid-column: auto; }
        .manual-actions { flex-wrap: wrap; }
        .manual-actions .delete { margin-right: 0; }
        .manual-actions button { flex: 1; min-width: 100px; }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
      }
    </style>
    <button id="fab" title="打开考勤汇总" aria-label="打开飞书考勤汇总" aria-haspopup="dialog" aria-expanded="false">
      <span class="fab-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 3v3M17 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="m8.5 15 2.2 2.1 4.8-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
      <span class="fab-label">考勤汇总</span><span class="fab-dot" aria-hidden="true"></span>
    </button>
    <div id="backdrop">
      <section id="panel" role="dialog" aria-modal="true" aria-label="飞书考勤汇总" tabindex="-1">
        <header class="app-header">
          <div class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none"><path d="M7 3v3M17 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="m8.5 15 2.2 2.1 4.8-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <div class="brand-copy">
            <h2>考勤洞察 <span class="version">v1.0.5</span></h2>
            <p>从「假勤」消息生成个人考勤概览</p>
          </div>
          <div class="privacy-pill" title="脚本不上传聊天内容">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 14v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            仅本地处理
          </div>
          <button class="icon-btn" id="close" aria-label="关闭考勤面板" title="关闭">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
        </header>
        <main>
          <section class="card control-card">
            <div class="section-heading">
              <div>
                <span class="eyebrow">Attendance period</span>
                <h3>选择统计周期</h3>
                <p>设定范围后，扫描「假勤」会话</p>
              </div>
              <div class="schedule-chip" id="scheduleChip"></div>
            </div>
            <div class="period-grid">
              <label class="date-field"><span>开始日期</span><input id="rangeStart" type="date" aria-label="周期开始日期"></label>
              <span class="range-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
              <label class="date-field"><span>结束日期</span><input id="rangeEnd" type="date" aria-label="周期结束日期"></label>
              <div class="preset-group" aria-label="周期快捷选择">
                <button class="action" id="naturalMonth" aria-pressed="false"><span class="preset-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="m6 12 4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>本自然月</button>
                <button class="action" id="currentCycle" aria-pressed="false"><span class="preset-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="m6 12 4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>自定义周期</button>
                <button class="action" id="detectedCycle" aria-pressed="false" disabled><span class="preset-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="m6 12 4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>机器人周期</button>
              </div>
              <div class="cycle-source" id="cycleSource" role="status" aria-live="polite"><span class="cycle-source-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M7 3v3M17 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 14h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span><span id="cycleSourceText"></span></div>
            </div>
            <div class="scan-actions">
              <button class="action primary" id="scanHistory">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v12m0-12L7.5 8.5M12 4l4.5 4.5M5 20h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span id="scanHistoryLabel">自动加载并扫描</span>
              </button>
              <button class="action" id="scanCurrent">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/></svg>
                扫描当前页面
              </button>
              <button class="action ghost" id="clearData">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                清空数据
              </button>
            </div>
            <div class="status" id="scanStatus" role="status" aria-live="polite"></div>
            <details class="rule-card">
              <summary>
                <span class="summary-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M10 14v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="14" cy="7" r="2" stroke="currentColor" stroke-width="1.8"/><circle cx="8" cy="17" r="2" stroke="currentColor" stroke-width="1.8"/></svg></span>
                <span class="summary-copy"><b>考勤规则与周期设置</b><small id="ruleSummary"></small></span>
                <span class="chevron" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="m7 9 5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
              </summary>
              <div class="settings">
                <label>每月周期起始日（1–28）<input id="cycleStartDay" type="number" min="1" max="28"></label>
                <label>班次类型<select id="scheduleMode">
                  <option value="flex-linked">弹性联动</option>
                  <option value="flex-window">独立弹性区间</option>
                  <option value="fixed">固定时间</option>
                </select></label>
                <label>迟到/早退宽限（分钟）<input id="graceMinutes" type="number" min="0" max="180"></label>
                <label>无类型时间的上下班分界<input id="unknownSplitTime" type="time"></label>
                <div class="schedule-fields" id="flexScheduleFields">
                  <label>最早上班<input id="flexStartEarliest" type="time"></label>
                  <label>最晚上班<input id="flexStartLatest" type="time"></label>
                  <label>最早下班<input id="flexEndEarliest" type="time"></label>
                  <label>最晚下班<input id="flexEndLatest" type="time"></label>
                </div>
                <div class="schedule-fields hidden" id="fixedScheduleFields">
                  <label>应上班时间<input id="workStart" type="time"></label>
                  <label>应下班时间<input id="workEnd" type="time"></label>
                </div>
                <div class="span-4">
                  <label>固定工作日</label>
                  <div class="weekdays">
                    ${[1, 2, 3, 4, 5, 6, 0].map((day) => `<label><input type="checkbox" name="workday" value="${day}">周${WEEKDAY_NAMES[day]}</label>`).join('')}
                  </div>
                </div>
                <label class="span-2">排除日期（节假日，逗号分隔）<input id="holidayDates" type="text" placeholder="2026-10-01, 2026-10-02"></label>
                <label class="span-2">额外工作日（调休上班，逗号分隔）<input id="extraWorkDates" type="text" placeholder="2026-10-10"></label>
                <label class="span-2 check-option"><input id="noMessageAsMissing" type="checkbox"> 将没有任何消息的工作日统计为缺卡</label>
              </div>
              <p class="hint">“弹性联动”按上班时间等量推迟应下班时间，例如 09:10 上班对应 18:40 下班；“独立弹性区间”只判断是否落在两个区间内。上午半天假为 14:00–15:00 上班、18:00–19:00 联动下班；下午半天假为 08:30–09:30 上班、14:00–15:00 联动下班，午休 12:00–13:30 不计工时。周期起始日为 26 时，会自动定位到上月 26 日—本月 25 日。</p>
            </details>
          </section>
          <section id="summary"></section>
          <section class="card table-card">
            <div class="table-title">
              <div class="table-title-copy"><h3>每日考勤明细</h3><p id="tableCaption">按日期核对打卡时间与异常状态</p></div>
              <div class="table-actions">
                <button class="action primary" id="addManual">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                  添加补充
                </button>
                <button class="action" id="toggleOrder" title="切换日期排序" aria-label="切换日期排序" aria-pressed="true">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 7h10M8 12h7M8 17h4M5 5v14m0 0-2.5-2.5M5 19l2.5-2.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  <span id="orderLabel">近期在前</span>
                </button>
                <button class="action" id="copySummary">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
                  复制摘要
                </button>
                <button class="action" id="exportCsv">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  导出 CSV
                </button>
              </div>
            </div>
            <div class="table-wrap" id="tableWrap"></div>
          </section>
          <details class="card import-card">
            <summary>
              <span class="summary-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
              <span class="summary-copy"><b>粘贴机器人消息</b><small>网页结构变化或自动扫描遗漏时使用</small></span>
              <span class="chevron" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="m7 9 5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            </summary>
            <div class="import-body">
              <textarea id="importText" aria-label="粘贴假勤消息文本" placeholder="粘贴「假勤」消息，保留日期分隔；每条消息之间建议留一个空行。"></textarea>
              <div class="scan-actions"><button class="action" id="parsePaste">解析粘贴内容</button></div>
            </div>
          </details>
        </main>
      </section>
    </div>
    <dialog class="manual-dialog" id="manualDialog" aria-labelledby="manualTitle" aria-describedby="manualDescription">
      <form class="manual-form" id="manualForm" novalidate>
        <header class="manual-head">
          <div class="manual-head-copy">
            <h3 id="manualTitle">补充考勤情况</h3>
            <p id="manualDescription">补充仅保存在当前浏览器本地；补录时间会覆盖机器人对应一侧的打卡。</p>
          </div>
          <button class="icon-btn" id="manualClose" type="button" aria-label="关闭补充考勤窗口" title="关闭">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
        </header>
        <div class="manual-body">
          <div class="manual-grid">
            <label>考勤日期<input id="manualDate" type="date" required></label>
            <label>补充类型<select id="manualType" required>
              ${Object.entries(MANUAL_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
            </select></label>
            <label>上班时间（可选）<input id="manualClockIn" type="time"></label>
            <label>下班时间（可选）<input id="manualClockOut" type="time"></label>
            <label class="check-option manual-next-day full"><input id="manualClockOutNextDay" type="checkbox"> 下班卡发生在次日 00:00–05:59</label>
            <label class="full">说明（可选）<textarea id="manualNote" maxlength="300" rows="3" placeholder="例如：补卡审批已通过、年假半天"></textarea></label>
          </div>
          <p class="manual-hint" id="manualHint" role="status" aria-live="polite"></p>
          <p class="manual-error" id="manualError" role="alert" aria-live="assertive"></p>
        </div>
        <footer class="manual-actions">
          <button class="action danger delete" id="deleteManual" type="button" hidden>删除此补充</button>
          <button class="action" id="cancelManual" type="button">取消</button>
          <button class="action primary" type="submit">保存到本地</button>
        </footer>
      </form>
    </dialog>
  `;

  const $ = (selector) => shadow.querySelector(selector);

  function defaultManualDate() {
    const today = formatDate(new Date());
    if (today < state.config.rangeStart) return state.config.rangeStart;
    if (today > state.config.rangeEnd) return state.config.rangeEnd;
    return today;
  }

  function manualRuleText(type) {
    const rules = {
      'leave-full': '全天请假不计入平均工时；已解析的机器人异常会由此补充说明覆盖。',
      'leave-am': '上午半天假：14:00–15:00 上班，联动 18:00–19:00 下班，净出勤需满 4 小时。',
      'leave-pm': '下午半天假：08:30–09:30 上班，联动 14:00–15:00 下班；12:00–13:30 午休不计工时，净出勤需满 4 小时。',
      patch: '补录的上班或下班时间会覆盖机器人当天对应一侧的打卡，并重新判断迟到、早退和工时。',
      travel: '出差会覆盖机器人当天的异常提示；如需统计工时，可同时填写实际打卡。',
      field: '外出/外勤会标记为有效状态；如填写打卡，也会计算有效工时和加班。',
      other: '仅追加本地说明，不会自动消除机器人识别到的异常。',
    };
    return rules[type] || rules.other;
  }

  function updateManualHint() {
    const type = $('#manualType').value;
    const clockIn = $('#manualClockIn').value;
    const clockOut = $('#manualClockOut').value;
    const outMinutes = timeToMinutes(clockOut);
    const cutoff = timeToMinutes(state.config.overnightClockOutCutoff || DEFAULT_CONFIG.overnightClockOutCutoff);
    const nextDayEligible = outMinutes !== null && outMinutes < cutoff;
    $('#manualClockOutNextDay').disabled = !nextDayEligible;
    if (!nextDayEligible) $('#manualClockOutNextDay').checked = false;

    let text = manualRuleText(type);
    let warning = false;
    const inMinutes = timeToMinutes(clockIn);
    if (inMinutes !== null && outMinutes !== null) {
      const resolvedOut = outMinutes + ($('#manualClockOutNextDay').checked ? 24 * 60 : 0);
      if (resolvedOut <= inMinutes) {
        text += ' 当前下班时间不晚于上班时间；若为凌晨下班，请勾选“次日”。';
        warning = true;
      } else {
        const effective = netWorkMinutes(inMinutes, resolvedOut);
        const mode = type === 'leave-am' || type === 'leave-pm' ? type : 'full';
        const schedule = getScheduleThresholds(state.config, clockIn, mode);
        const overtime = Number.isFinite(schedule.overtimeAfter)
          ? Math.max(0, resolvedOut - schedule.overtimeAfter)
          : 0;
        text += ` 当前录入的净打卡跨度为 ${minutesToDuration(effective)}${overtime ? `，其中预计加班 ${minutesToDuration(overtime)}` : ''}。`;
      }
    }
    $('#manualHint').textContent = text;
    $('#manualHint').dataset.tone = warning ? 'warning' : '';
  }

  function openManualDialog(date = '') {
    const selectedDate = date || defaultManualDate();
    const existing = normalizeManualAdjustment(state.manualAdjustments.get(selectedDate));
    const dialog = $('#manualDialog');
    dialog.dataset.originalDate = existing ? existing.date : '';
    $('#manualDate').min = state.config.rangeStart;
    $('#manualDate').max = state.config.rangeEnd;
    $('#manualDate').value = existing ? existing.date : selectedDate;
    $('#manualType').value = existing ? existing.type : 'patch';
    $('#manualClockIn').value = existing ? existing.clockIn : '';
    $('#manualClockOut').value = existing ? existing.clockOut : '';
    $('#manualClockOutNextDay').checked = Boolean(existing && existing.clockOutNextDay);
    $('#manualNote').value = existing ? existing.note : '';
    $('#deleteManual').hidden = !existing;
    $('#manualError').textContent = '';
    updateManualHint();
    if (!dialog.open) dialog.showModal();
    window.requestAnimationFrame(() => $('#manualType').focus());
  }

  function closeManualDialog() {
    const dialog = $('#manualDialog');
    if (dialog.open) dialog.close();
    $('#manualError').textContent = '';
  }

  function saveManualFromForm(event) {
    event.preventDefault();
    const date = $('#manualDate').value;
    const type = $('#manualType').value;
    const clockIn = $('#manualClockIn').value;
    const clockOut = $('#manualClockOut').value;
    const clockOutNextDay = $('#manualClockOutNextDay').checked;
    if (!parseLocalDate(date) || date < state.config.rangeStart || date > state.config.rangeEnd) {
      $('#manualError').textContent = `请选择 ${state.config.rangeStart} 至 ${state.config.rangeEnd} 内的日期。`;
      return;
    }
    if (!MANUAL_TYPES[type]) {
      $('#manualError').textContent = '请选择有效的补充类型。';
      return;
    }
    const inMinutes = timeToMinutes(clockIn);
    const outMinutes = timeToMinutes(clockOut);
    const cutoff = timeToMinutes(state.config.overnightClockOutCutoff || DEFAULT_CONFIG.overnightClockOutCutoff);
    if (clockOutNextDay && (outMinutes === null || outMinutes >= cutoff)) {
      $('#manualError').textContent = '次日下班时间只能是 00:00–05:59。';
      return;
    }
    if (inMinutes !== null && outMinutes !== null && !clockOutNextDay && outMinutes <= inMinutes) {
      $('#manualError').textContent = '下班时间需晚于上班时间；凌晨下班请勾选“次日”。';
      return;
    }
    const adjustment = normalizeManualAdjustment({
      date,
      type,
      clockIn,
      clockOut,
      clockOutNextDay,
      note: $('#manualNote').value,
      updatedAt: new Date().toISOString(),
    });
    if (!adjustment) {
      $('#manualError').textContent = '补充内容无效，请检查日期和时间。';
      return;
    }

    const previous = new Map(state.manualAdjustments);
    const originalDate = $('#manualDialog').dataset.originalDate;
    if (originalDate && originalDate !== adjustment.date) state.manualAdjustments.delete(originalDate);
    state.manualAdjustments.set(adjustment.date, adjustment);
    try {
      saveManualAdjustments(state.manualAdjustments);
    } catch (error) {
      state.manualAdjustments = previous;
      $('#manualError').textContent = `保存失败：${error.message || error}`;
      return;
    }
    closeManualDialog();
    state.status = `已在本地保存 ${adjustment.date} 的“${MANUAL_TYPES[adjustment.type]}”补充。`;
    render();
  }

  function deleteCurrentManual() {
    const originalDate = $('#manualDialog').dataset.originalDate;
    if (!originalDate || !state.manualAdjustments.has(originalDate)) return;
    const previous = new Map(state.manualAdjustments);
    state.manualAdjustments.delete(originalDate);
    try {
      saveManualAdjustments(state.manualAdjustments);
    } catch (error) {
      state.manualAdjustments = previous;
      $('#manualError').textContent = `删除失败：${error.message || error}`;
      return;
    }
    closeManualDialog();
    state.status = `已删除 ${originalDate} 的本地考勤补充。`;
    render();
  }

  function shortCycleDate(value) {
    return String(value || '').slice(5).replace('-', '/');
  }

  function periodModeLabel() {
    if (state.periodMode === 'natural') return '本自然月';
    if (state.periodMode === 'custom') return '自定义周期';
    if (state.periodMode === 'detected') return '机器人周期';
    return '手动日期范围';
  }

  function syncPeriodControls() {
    if ($('#rangeStart').value !== state.config.rangeStart) $('#rangeStart').value = state.config.rangeStart;
    if ($('#rangeEnd').value !== state.config.rangeEnd) $('#rangeEnd').value = state.config.rangeEnd;
    const detected = latestDetectedCycle();
    const detectedSelected = Boolean(
      detected
      && state.periodMode === 'detected'
      && state.config.rangeStart === detected.start
      && state.config.rangeEnd === detected.end
    );
    $('#naturalMonth').setAttribute('aria-pressed', String(state.periodMode === 'natural'));
    $('#currentCycle').setAttribute('aria-pressed', String(state.periodMode === 'custom'));
    $('#detectedCycle').setAttribute('aria-pressed', String(detectedSelected));
    $('#detectedCycle').disabled = !detected;
    if (detected) {
      const periodLabel = `${shortCycleDate(detected.start)}–${shortCycleDate(detected.end)}`;
      const cutoffLabel = detected.cutoff
        ? `，${shortCycleDate(detected.cutoff.slice(0, 10))} ${detected.cutoff.slice(11)} 封账`
        : '';
      const currentLabel = isAttendanceCycleForMonth(detected) ? '已识别本月机器人周期' : '最近识别到历史机器人周期';
      $('#detectedCycle').title = `使用机器人周期 ${detected.start} 至 ${detected.end}${cutoffLabel}`;
      $('#detectedCycle').setAttribute('aria-label', `机器人周期 ${detected.start} 至 ${detected.end}`);
      $('#cycleSourceText').textContent = `${currentLabel}：${periodLabel}${cutoffLabel} · 当前使用${periodModeLabel()}`;
    } else {
      $('#detectedCycle').title = '扫描到考勤封账提醒后可用';
      $('#detectedCycle').setAttribute('aria-label', '机器人周期，尚未识别');
      $('#cycleSourceText').textContent = `未识别到本月封账周期 · 当前使用${periodModeLabel()}`;
    }
  }

  function updateScheduleFields() {
    const fixed = $('#scheduleMode').value === 'fixed';
    $('#fixedScheduleFields').classList.toggle('hidden', !fixed);
    $('#flexScheduleFields').classList.toggle('hidden', fixed);
  }

  function fillForm() {
    const config = state.config;
    $('#rangeStart').value = config.rangeStart;
    $('#rangeEnd').value = config.rangeEnd;
    $('#cycleStartDay').value = config.cycleStartDay;
    $('#scheduleMode').value = config.scheduleMode;
    $('#workStart').value = config.workStart;
    $('#workEnd').value = config.workEnd;
    $('#flexStartEarliest').value = config.flexStartEarliest;
    $('#flexStartLatest').value = config.flexStartLatest;
    $('#flexEndEarliest').value = config.flexEndEarliest;
    $('#flexEndLatest').value = config.flexEndLatest;
    $('#graceMinutes').value = config.graceMinutes;
    $('#holidayDates').value = config.holidayDates;
    $('#extraWorkDates').value = config.extraWorkDates;
    $('#unknownSplitTime').value = config.unknownSplitTime;
    $('#noMessageAsMissing').checked = Boolean(config.noMessageAsMissing);
    for (const checkbox of shadow.querySelectorAll('input[name="workday"]')) {
      checkbox.checked = config.workdays.includes(Number(checkbox.value));
    }
    updateScheduleFields();
    syncPeriodControls();
  }

  function applyFormConfig(shouldRender = false) {
    const config = {
      ...state.config,
      rangeStart: $('#rangeStart').value,
      rangeEnd: $('#rangeEnd').value,
      cycleStartDay: Math.max(1, Math.min(28, Number($('#cycleStartDay').value) || 1)),
      scheduleMode: $('#scheduleMode').value,
      workStart: $('#workStart').value || DEFAULT_CONFIG.workStart,
      workEnd: $('#workEnd').value || DEFAULT_CONFIG.workEnd,
      flexStartEarliest: $('#flexStartEarliest').value || DEFAULT_CONFIG.flexStartEarliest,
      flexStartLatest: $('#flexStartLatest').value || DEFAULT_CONFIG.flexStartLatest,
      flexEndEarliest: $('#flexEndEarliest').value || DEFAULT_CONFIG.flexEndEarliest,
      flexEndLatest: $('#flexEndLatest').value || DEFAULT_CONFIG.flexEndLatest,
      graceMinutes: Math.max(0, Number($('#graceMinutes').value) || 0),
      holidayDates: $('#holidayDates').value.trim(),
      extraWorkDates: $('#extraWorkDates').value.trim(),
      unknownSplitTime: $('#unknownSplitTime').value || DEFAULT_CONFIG.unknownSplitTime,
      noMessageAsMissing: $('#noMessageAsMissing').checked,
      workdays: [...shadow.querySelectorAll('input[name="workday"]:checked')].map((item) => Number(item.value)),
    };
    if (!parseLocalDate(config.rangeStart) || !parseLocalDate(config.rangeEnd) || config.rangeStart > config.rangeEnd) {
      state.status = '周期日期无效：请确认开始日期不晚于结束日期。';
      renderStatus();
      return false;
    }
    if (config.scheduleMode === 'fixed') {
      if (timeToMinutes(config.workStart) === null || timeToMinutes(config.workEnd) === null) {
        state.status = '固定班次时间无效。';
        renderStatus();
        return false;
      }
    } else {
      const flexTimes = [
        config.flexStartEarliest,
        config.flexStartLatest,
        config.flexEndEarliest,
        config.flexEndLatest,
      ].map(timeToMinutes);
      if (flexTimes.some((value) => value === null) || flexTimes[0] > flexTimes[1] || flexTimes[2] > flexTimes[3]) {
        state.status = '弹性时间无效：最早时间不能晚于最晚时间。';
        renderStatus();
        return false;
      }
    }
    state.config = config;
    saveConfig(config);
    if (shouldRender) render();
    return true;
  }

  function currentSummary() {
    return buildDailySummary(
      [...state.events.values()],
      state.config,
      new Date(),
      state.manualAdjustments,
    );
  }

  function renderStatus() {
    syncPeriodControls();
    $('#scanStatus').textContent = `${state.status} 累计检查 ${state.scanStats.examined} 条候选，解析 ${state.events.size} 条。`;
    $('#scanHistoryLabel').textContent = state.locating
      ? '正在定位「假勤」'
      : state.scanning
        ? '停止自动扫描'
        : state.inAttendanceConversation
          ? '自动加载并扫描'
          : '定位并扫描「假勤」';
    $('#scanHistory').disabled = state.locating;
    $('#scanHistory').classList.toggle('danger', state.scanning);
    $('#scanStatus').classList.toggle('is-scanning', state.scanning);
    const ruleText = describeSchedule(state.config);
    $('#scheduleChip').textContent = ruleText;
    $('#scheduleChip').title = ruleText;
    $('#ruleSummary').textContent = `${ruleText} · 每月 ${state.config.cycleStartDay} 日起算`;
  }

  function statusTone(label) {
    if (/(?:迟到|早退|缺卡|缺勤|旷工)/.test(label)) return 'danger';
    if (/(?:待核对|进行中)/.test(label)) return 'warning';
    if (/(?:正常|已补卡)/.test(label)) return 'success';
    if (/(?:外勤|请假|出差|无需打卡)/.test(label)) return 'info';
    return '';
  }

  function metricCard(value, label, note, tone = '') {
    const displayValue = typeof value === 'number'
      ? (Number.isFinite(value) ? value : 0)
      : (String(value || '0'));
    return `<div class="metric"${tone ? ` data-tone="${tone}"` : ''}>
      <span class="metric-label"><i class="metric-dot"></i>${escapeHtml(label)}</span>
      <b>${escapeHtml(displayValue)}</b><small>${escapeHtml(note)}</small>
    </div>`;
  }

  function compactDuration(minutes) {
    const value = Math.max(0, Math.round(Number(minutes) || 0));
    if (!value) return '0';
    if (value < 60) return `${value}分`;
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest ? `${hours}h${rest}` : `${hours}h`;
  }

  function renderOvertimeTrend(rows, totals) {
    const trend = getOvertimeTrendData(rows);
    const available = trend.filter((item) => item.available);
    const gaps = trend.filter((item) => !item.available);
    const increases = available.filter((item) => item.direction === 'up').length;
    const decreases = available.filter((item) => item.direction === 'down').length;
    const peak = available.reduce(
      (best, item) => (!best || item.overtimeMinutes > best.overtimeMinutes ? item : best),
      null,
    );
    const peakText = peak && peak.overtimeMinutes > 0
      ? `峰值 ${peak.date.slice(5).replace('-', '/')} · ${minutesToDuration(peak.overtimeMinutes)}`
      : '暂无已记录加班';
    const legend = `<div class="trend-legend" aria-label="图例">
      <span class="legend-item" aria-label="绿色空心 K 线和上箭头表示较前一有效日增加"><i class="legend-candle up" aria-hidden="true"></i><b class="legend-direction up">▲</b>增加</span>
      <span class="legend-item" aria-label="红色实心 K 线和下箭头表示较前一有效日减少"><i class="legend-candle down" aria-hidden="true"></i><b class="legend-direction down">▼</b>减少</span>
      <span class="legend-item"><i class="legend-candle flat" aria-hidden="true"></i><b class="legend-direction">—</b>持平</span>
      ${totals.averageOvertimeMinutes ? '<span class="legend-item"><i class="legend-swatch average"></i>加班日均值</span>' : ''}
      ${gaps.length ? '<span class="legend-item"><i class="legend-swatch gap"></i>暂无完整打卡</span>' : ''}
    </div>`;
    const head = `<div class="trend-head">
      <div><h3>加班 K 线</h3><p>覆盖 ${available.length} 个完整打卡日 · ${increases} 涨 ${decreases} 跌 · ${peakText}</p></div>
      ${legend}
    </div>`;
    if (!available.length) {
      return `<section class="card trend-card" aria-labelledby="overtimeTrendHeading">
        ${head.replace('<h3>', '<h3 id="overtimeTrendHeading">')}
        <div class="trend-empty">暂无可绘制的加班数据。<br>扫描到完整上下班卡，或补录打卡时间后会自动生成 K 线。</div>
      </section>`;
    }

    const height = 250;
    const margin = { top: 22, right: 18, bottom: 38, left: 48 };
    const width = Math.max(820, margin.left + margin.right + Math.max(1, trend.length - 1) * 28);
    const plotRight = width - margin.right;
    const plotBottom = height - margin.bottom;
    const plotWidth = plotRight - margin.left;
    const plotHeight = plotBottom - margin.top;
    const maximum = Math.max(...available.map((item) => item.highMinutes));
    const yMaximum = Math.max(60, Math.ceil(maximum / 60) * 60);
    const xAt = (index) => trend.length === 1
      ? margin.left + plotWidth / 2
      : margin.left + (index / (trend.length - 1)) * plotWidth;
    const yAt = (minutes) => plotBottom - (Math.min(yMaximum, Math.max(0, minutes)) / yMaximum) * plotHeight;
    const pointSpacing = trend.length > 1 ? plotWidth / (trend.length - 1) : 28;
    const candleWidth = Math.max(8, Math.min(14, pointSpacing * 0.48));
    const hitWidth = Math.max(candleWidth + 8, Math.min(28, pointSpacing * 0.9));
    const plotted = trend.map((item, index) => ({
      ...item,
      x: xAt(index),
      y: item.available ? yAt(item.closeMinutes) : plotBottom,
      openY: item.available ? yAt(item.openMinutes) : null,
      closeY: item.available ? yAt(item.closeMinutes) : null,
      highY: item.available ? yAt(item.highMinutes) : null,
      lowY: item.available ? yAt(item.lowMinutes) : null,
    }));
    const grid = Array.from({ length: 5 }, (_, index) => {
      const ratio = index / 4;
      const y = margin.top + ratio * plotHeight;
      const value = Math.round(yMaximum * (1 - ratio));
      return `<line class="chart-grid" x1="${margin.left}" y1="${y}" x2="${plotRight}" y2="${y}"></line>
        <text class="chart-axis-label" x="${margin.left - 9}" y="${y + 3}" text-anchor="end">${compactDuration(value)}</text>`;
    }).join('');
    const labelStep = Math.max(1, Math.ceil(trend.length / 6));
    const labelIndexes = new Set([0, trend.length - 1]);
    for (let index = 0; index < trend.length; index += labelStep) labelIndexes.add(index);
    const xLabels = [...labelIndexes]
      .sort((left, right) => left - right)
      .map((index) => `<text class="chart-axis-label" x="${xAt(index)}" y="${height - 14}" text-anchor="middle">${escapeHtml(trend[index].date.slice(5).replace('-', '/'))}</text>`)
      .join('');
    const averageLine = totals.averageOvertimeMinutes
      ? `<line class="chart-average" x1="${margin.left}" y1="${yAt(totals.averageOvertimeMinutes)}" x2="${plotRight}" y2="${yAt(totals.averageOvertimeMinutes)}"></line>
        <text class="chart-average-label" x="${plotRight - 2}" y="${Math.max(12, yAt(totals.averageOvertimeMinutes) - 5)}" text-anchor="end">日均 ${compactDuration(totals.averageOvertimeMinutes)}</text>`
      : '';
    const points = plotted.map((item) => {
      const isPeak = peak && peak.overtimeMinutes > 0 && item.date === peak.date;
      if (!item.available) {
        const tooltip = `${item.date} ${item.weekday}\n${item.status}\n暂无完整上下班卡，未计入 K 线`;
        return `<g class="chart-point gap" tabindex="0" focusable="true" role="img" aria-label="${escapeHtml(tooltip.replace(/\n/g, '，'))}" data-tooltip="${escapeHtml(tooltip)}" data-chart-x="${item.x.toFixed(2)}" data-chart-y="${plotBottom}">
          <rect class="chart-hit" x="${(item.x - hitWidth / 2).toFixed(2)}" y="${margin.top}" width="${hitWidth.toFixed(2)}" height="${plotHeight}"></rect>
          <rect class="chart-focus-ring" x="${(item.x - 9).toFixed(2)}" y="${plotBottom - 9}" width="18" height="18" rx="5"></rect>
          <circle class="chart-gap-marker" cx="${item.x.toFixed(2)}" cy="${plotBottom}" r="4"></circle>
          <title>${escapeHtml(tooltip.replace(/\n/g, '；'))}</title>
        </g>`;
      }
      const comparison = item.comparisonDate
        ? `前一有效日 ${item.comparisonDate.slice(5).replace('-', '/')}：${item.openMinutes ? minutesToDuration(item.openMinutes) : '无'}`
        : `比较基线：首个有效日（${item.openMinutes ? minutesToDuration(item.openMinutes) : '无'}）`;
      const change = item.comparisonDate
        ? item.changeMinutes > 0
          ? `▲ 增加 ${minutesToDuration(item.changeMinutes)}`
          : item.changeMinutes < 0
            ? `▼ 减少 ${minutesToDuration(Math.abs(item.changeMinutes))}`
            : '— 持平'
        : '— 首个有效日';
      const tooltip = `${item.date} ${item.weekday}\n${comparison}\n当日加班：${item.closeMinutes ? minutesToDuration(item.closeMinutes) : '无'}\n变化：${change}\n有效工时：${minutesToDuration(item.workMinutes)}`;
      const classes = ['chart-point'];
      classes.push(item.direction);
      if (isPeak) classes.push('peak');
      const bodyTop = Math.min(item.openY, item.closeY);
      const rawBodyHeight = Math.abs(item.closeY - item.openY);
      const bodyHeight = Math.max(3, rawBodyHeight);
      const bodyY = Math.max(margin.top, Math.min(plotBottom - bodyHeight, bodyTop - (bodyHeight - rawBodyHeight) / 2));
      const focusY = Math.max(margin.top, bodyY - 5);
      const focusHeight = Math.max(13, bodyHeight + 10);
      const candleShape = item.direction === 'flat'
        ? `<line class="chart-candle-doji" x1="${(item.x - candleWidth / 2).toFixed(2)}" y1="${item.closeY.toFixed(2)}" x2="${(item.x + candleWidth / 2).toFixed(2)}" y2="${item.closeY.toFixed(2)}"></line>`
        : `<rect class="chart-candle-body" x="${(item.x - candleWidth / 2).toFixed(2)}" y="${bodyY.toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${bodyHeight.toFixed(2)}" rx="1.5"></rect>`;
      const peakMarkerY = Math.max(margin.top + 3, item.highY - 7);
      const peakMarker = isPeak
        ? `<path class="chart-peak-marker" d="M ${item.x.toFixed(2)} ${(peakMarkerY - 3).toFixed(2)} l 3 5 h -6 Z"></path>`
        : '';
      return `<g class="${classes.join(' ')}" tabindex="0" focusable="true" role="img" aria-label="${escapeHtml(tooltip.replace(/\n/g, '，'))}" data-chart-x="${item.x.toFixed(2)}" data-chart-y="${item.closeY.toFixed(2)}" data-tooltip="${escapeHtml(tooltip)}">
        <rect class="chart-hit" x="${(item.x - hitWidth / 2).toFixed(2)}" y="${margin.top}" width="${hitWidth.toFixed(2)}" height="${plotHeight}"></rect>
        <rect class="chart-focus-ring" x="${(item.x - candleWidth / 2 - 5).toFixed(2)}" y="${focusY.toFixed(2)}" width="${(candleWidth + 10).toFixed(2)}" height="${focusHeight.toFixed(2)}" rx="5"></rect>
        <line class="chart-candle-wick" x1="${item.x.toFixed(2)}" y1="${item.highY.toFixed(2)}" x2="${item.x.toFixed(2)}" y2="${item.lowY.toFixed(2)}"></line>
        ${candleShape}${peakMarker}
        <title>${escapeHtml(tooltip.replace(/\n/g, '；'))}</title>
      </g>`;
    }).join('');
    const accessibleRows = plotted.map((item) => item.available
      ? `<li>${escapeHtml(`${item.date}，当日加班 ${item.closeMinutes ? minutesToDuration(item.closeMinutes) : '无'}，${item.comparisonDate ? (item.changeMinutes > 0 ? `较前一有效日增加 ${minutesToDuration(item.changeMinutes)}` : item.changeMinutes < 0 ? `较前一有效日减少 ${minutesToDuration(Math.abs(item.changeMinutes))}` : '较前一有效日持平') : '首个有效日'}`)}</li>`
      : `<li>${escapeHtml(`${item.date}，暂无完整上下班卡`)}</li>`).join('');
    const description = `按工作日展示每日加班 K 线。开盘值为前一有效出勤日加班时长，收盘值为当日加班时长；绿色空心和上箭头表示增加，红色实心和下箭头表示减少，灰色横线表示持平。${available.length} 个日期有完整打卡，${gaps.length} 个日期暂无可计算数据。${peakText}。`;

    return `<section class="card trend-card" aria-labelledby="overtimeTrendHeading">
      ${head.replace('<h3>', '<h3 id="overtimeTrendHeading">')}
      <figure class="trend-figure">
        <div class="trend-scroll" tabindex="0" aria-label="加班 K 线图，可横向滚动查看完整周期">
          <div class="trend-stage" style="min-width:${width}px">
            <svg class="overtime-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="overtimeChartTitle overtimeChartDescription">
              <title id="overtimeChartTitle">每日加班 K 线</title>
              <desc id="overtimeChartDescription">${escapeHtml(description)}</desc>
              ${grid}${averageLine}${points}${xLabels}
            </svg>
            <div class="chart-tooltip" id="overtimeTooltip" aria-hidden="true"></div>
          </div>
        </div>
        <figcaption class="sr-only">${escapeHtml(description)}</figcaption>
        <ul class="sr-only" aria-label="加班 K 线数据">${accessibleRows}</ul>
      </figure>
      <p class="trend-mobile-hint">可左右滑动查看完整周期；聚焦或悬停 K 线可查看前值、当日值与变化。</p>
    </section>`;
  }

  function render() {
    renderStatus();
    const result = currentSummary();
    const totals = result.totals;
    const elapsedWorkRows = result.rows.filter((row) => row.workday && row.status !== '未到');
    const coveredWorkRows = elapsedWorkRows.filter((row) => row.evidenceCount > 0 || row.manual);
    const coverage = elapsedWorkRows.length ? Math.round((coveredWorkRows.length / elapsedWorkRows.length) * 100) : 0;
    const cacheTime = cacheUpdatedLabel();
    const cacheText = state.cacheError
      ? '本地缓存失败'
      : state.events.size
        ? `本地缓存 ${state.events.size} 条${cacheTime ? ` · ${cacheTime}` : ''}`
        : '本地缓存为空';
    $('#summary').innerHTML = `
      <div class="overview">
        <div class="overview-head">
          <div><h3>周期概览</h3><p>${state.config.rangeStart} 至 ${state.config.rangeEnd}</p></div>
          <div class="overview-badges"><span class="coverage-pill">记录覆盖 ${coverage}%</span><span class="cache-pill${state.cacheError ? ' warning' : ''}">${escapeHtml(cacheText)}</span></div>
        </div>
        <div class="summary">
          ${metricCard(totals.workdays, '应出勤', '周期内工作日', 'primary')}
          ${metricCard(totals.attended, '有记录', '已识别有效状态', 'success')}
          ${metricCard(totals.late, '迟到', '超过最晚上班', totals.late ? 'danger' : '')}
          ${metricCard(totals.early, '早退', '早于应下班时间', totals.early ? 'danger' : '')}
          ${metricCard(totals.missing, '缺卡', '缺少上下班卡', totals.missing ? 'danger' : '')}
          ${metricCard(totals.pending, '待核对', '未发现机器人消息', totals.pending ? 'warning' : '')}
        </div>
        <div class="summary work-summary">
          ${metricCard(minutesToDuration(totals.overtimeMinutes), '加班总时间', `${totals.overtimeDays} 个加班日`, totals.overtimeMinutes ? 'primary' : '')}
          ${metricCard(totals.overtimeDays, '加班天数', '下班晚于联动应下班', totals.overtimeDays ? 'primary' : '')}
          ${metricCard(minutesToDuration(totals.averageOvertimeMinutes), '平均加班时间', '按实际加班日计算')}
          ${metricCard(minutesToDuration(totals.averageWorkMinutes), '平均工作时间', `${totals.completeWorkDays} 个完整打卡日`)}
        </div>
        <p class="work-summary-note">有效工时从正常上班起算，扣除 12:00–13:30 午休，再加应下班时间后的加班；平均工时纳入完整上下班卡的半天出勤，排除全天请假与休息日。</p>
      </div>
      ${renderOvertimeTrend(result.rows, totals)}`;
    if (result.error) {
      $('#tableWrap').innerHTML = `<div class="empty">${escapeHtml(result.error)}</div>`;
      return;
    }
    $('#orderLabel').textContent = state.tableNewestFirst ? '近期在前' : '最早在前';
    $('#toggleOrder').setAttribute('aria-pressed', String(state.tableNewestFirst));
    $('#tableCaption').textContent = `共 ${result.rows.length} 天 · ${state.tableNewestFirst ? '最近日期优先，未来日期置底' : '按日期正序'} · 悬停行可查看消息证据`;
    const today = formatDate(new Date());
    const displayRows = state.tableNewestFirst
      ? [...result.rows].sort((left, right) => {
        const leftFuture = left.date > today;
        const rightFuture = right.date > today;
        if (leftFuture !== rightFuture) return leftFuture ? 1 : -1;
        return leftFuture ? left.date.localeCompare(right.date) : right.date.localeCompare(left.date);
      })
      : result.rows;
    const rows = displayRows.map((row) => {
      const rowClass = row.abnormal ? 'abnormal' : row.pending ? 'pending' : (!row.workday ? 'rest' : '');
      const evidenceTitle = row.evidence.length
        ? `来源 ${row.evidenceCount} 条：\n${row.evidence.join('\n---\n').slice(0, 1600)}`
        : '该日期未解析到消息';
      const manualTitle = row.manual
        ? `\n本地补充：${row.manualLabel}${row.manual.note ? `（${row.manual.note}）` : ''}`
        : '';
      const title = `${evidenceTitle}${manualTitle}`;
      const statusBadges = row.status.split('、')
        .map((label) => `<span class="status-pill ${statusTone(label)}">${escapeHtml(label)}</span>`)
        .join('');
      const timeCell = (value) => `<span class="time-value${value === '—' ? ' muted' : ''}">${escapeHtml(value)}</span>`;
      const hasHalfDayRule = row.manual && (row.manual.type === 'leave-am' || row.manual.type === 'leave-pm');
      const source = `<span class="source-stack">
        ${row.evidenceCount ? `<span class="source-count">${row.evidenceCount} 条</span>` : ''}
        ${row.manual ? `<span class="manual-badge">${escapeHtml(row.manualLabel)}</span>` : ''}
        ${!row.evidenceCount && !row.manual ? '<span class="source-count">—</span>' : ''}
      </span>`;
      return `<tr class="${rowClass}" title="${escapeHtml(title)}">
        <td><span class="date-cell"><strong>${row.date}</strong><span>${row.weekday}</span></span></td>
        <td><span class="day-type${row.workday ? '' : ' rest'}">${row.workday ? '工作日' : '休息日'}</span></td>
        <td>${timeCell(row.clockIn)}</td><td>${timeCell(row.clockOut)}</td>
        <td>${timeCell(row.workday || hasHalfDayRule ? row.expectedOut : '—')}</td>
        <td>${timeCell(row.workDuration)}</td><td>${timeCell(row.overtime)}</td><td>${timeCell(row.duration)}</td>
        <td><span class="status-list">${statusBadges}</span></td>
        <td>${source}</td>
        <td><button class="action edit-row" type="button" data-edit-date="${row.date}" aria-label="补充 ${row.date} 的考勤">${row.manual ? '编辑' : '补充'}</button></td>
      </tr>`;
    }).join('');
    $('#tableWrap').innerHTML = `
      <table>
        <thead><tr><th>日期</th><th>类型</th><th>上班</th><th>下班</th><th>应下班</th><th>有效工时</th><th>加班</th><th>时间跨度</th><th>状态</th><th>来源</th><th>补充</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function showOvertimeTooltip(point) {
    const tooltip = $('#overtimeTooltip');
    const stage = point && point.closest('.trend-stage');
    const scroller = stage && stage.closest('.trend-scroll');
    if (!tooltip || !stage || !scroller) return;
    tooltip.textContent = point.dataset.tooltip || '';
    tooltip.classList.add('open');
    tooltip.setAttribute('aria-hidden', 'false');
    const stageRect = stage.getBoundingClientRect();
    const chart = point.closest('.overtime-chart');
    const chartX = Number(point.dataset.chartX);
    const chartY = Number(point.dataset.chartY);
    let localX;
    let localY;
    if (chart && Number.isFinite(chartX) && Number.isFinite(chartY)) {
      const chartRect = chart.getBoundingClientRect();
      const viewBox = chart.viewBox && chart.viewBox.baseVal;
      const viewWidth = viewBox && viewBox.width ? viewBox.width : chartRect.width;
      const viewHeight = viewBox && viewBox.height ? viewBox.height : chartRect.height;
      localX = chartRect.left - stageRect.left + (chartX / viewWidth) * chartRect.width;
      localY = chartRect.top - stageRect.top + (chartY / viewHeight) * chartRect.height;
    } else {
      const pointRect = point.getBoundingClientRect();
      localX = pointRect.left - stageRect.left + pointRect.width / 2;
      localY = pointRect.top - stageRect.top + pointRect.height / 2;
    }
    const halfWidth = tooltip.offsetWidth / 2;
    const visibleLeft = scroller.scrollLeft;
    const visibleRight = visibleLeft + scroller.clientWidth;
    const clampedX = Math.max(visibleLeft + halfWidth + 8, Math.min(visibleRight - halfWidth - 8, localX));
    tooltip.style.left = `${clampedX}px`;
    tooltip.style.top = `${localY}px`;
    tooltip.classList.toggle('below', localY < tooltip.offsetHeight + 18);
  }

  function hideOvertimeTooltip() {
    const tooltip = $('#overtimeTooltip');
    if (!tooltip) return;
    tooltip.classList.remove('open', 'below');
    tooltip.setAttribute('aria-hidden', 'true');
  }

  function summaryText() {
    applyFormConfig();
    const { rows, totals, error } = currentSummary();
    if (error) return error;
    const abnormalRows = rows.filter((row) => row.abnormal || row.pending);
    const manualRows = rows.filter((row) => row.manual);
    return [
      `考勤周期：${state.config.rangeStart} 至 ${state.config.rangeEnd}`,
      `班次规则：${describeSchedule(state.config)}`,
      `应出勤 ${totals.workdays} 天；有打卡/有效状态 ${totals.attended} 天；迟到 ${totals.late} 次；早退 ${totals.early} 次；缺卡 ${totals.missing} 次；待核对 ${totals.pending} 天。`,
      `加班总计 ${minutesToDuration(totals.overtimeMinutes)}（${totals.overtimeDays} 天）；平均加班 ${minutesToDuration(totals.averageOvertimeMinutes)}；平均工作 ${minutesToDuration(totals.averageWorkMinutes)}。`,
      manualRows.length ? `本地补充 ${manualRows.length} 天：${manualRows.map((row) => `${row.date} ${row.manualLabel}${row.manual.note ? `（${row.manual.note}）` : ''}`).join('；')}` : '本周期无本地考勤补充。',
      abnormalRows.length ? '异常/待核对明细：' : '未发现异常或待核对日期。',
      ...abnormalRows.map((row) => `${row.date} ${row.weekday}：${row.clockIn}–${row.clockOut}（应下班 ${row.expectedOut}，有效工时 ${row.workDuration}，加班 ${row.overtime}），${row.status}`),
      '',
      '说明：结果由当前已加载的「假勤」消息与本地补充推算；午休 12:00–13:30 不计工时，请以飞书假勤后台最终统计为准。',
    ].join('\n');
  }

  async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  function csvCell(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    applyFormConfig();
    const { rows, error } = currentSummary();
    if (error) {
      state.status = error;
      renderStatus();
      return;
    }
    const lines = [
      ['日期', '星期', '日期类型', '上班打卡', '下班打卡', '应下班时间', '有效工时', '加班时间', '时间跨度', '状态', '本地补充类型', '本地补充说明', '解析消息数', '消息原文'],
      ...rows.map((row) => [
        row.date, row.weekday, row.workday ? '工作日' : '休息日', row.clockIn, row.clockOut,
        row.expectedOut, row.workDuration, row.overtime, row.duration, row.status,
        row.manualLabel, row.manual ? row.manual.note : '', row.evidenceCount, row.evidence.join(' | '),
      ]),
    ];
    const csv = `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `飞书考勤_${state.config.rangeStart}_${state.config.rangeEnd}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    state.status = 'CSV 已导出。';
    renderStatus();
  }

  function setNaturalMonth() {
    const range = getNaturalMonthRange();
    setPeriodState('natural', range, true);
    $('#rangeStart').value = range.start;
    $('#rangeEnd').value = range.end;
    applyFormConfig(true);
  }

  function setCurrentCycle() {
    const range = getCycleRange(new Date(), Number($('#cycleStartDay').value));
    setPeriodState('custom', range, true);
    $('#rangeStart').value = range.start;
    $('#rangeEnd').value = range.end;
    applyFormConfig(true);
  }

  function setDetectedCycle() {
    const range = latestDetectedCycle();
    if (!range) return;
    setPeriodState('detected', range, true);
    $('#rangeStart').value = range.start;
    $('#rangeEnd').value = range.end;
    applyFormConfig(true);
  }

  let previousFocus = null;
  let previousBodyOverflow = '';

  function openPanel() {
    previousFocus = document.activeElement;
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    $('#backdrop').classList.add('open');
    $('#fab').setAttribute('aria-expanded', 'true');
    fillForm();
    const capture = captureVisibleMessages({ silent: true, updateConversationState: true });
    const cacheTime = cacheUpdatedLabel();
    state.status = capture.attendanceEvidence
      ? `已读取「假勤」当前会话${capture.added ? `，新增 ${capture.added} 条记录` : ''}${capture.cyclesFound ? `，识别到机器人周期` : ''}，共 ${state.events.size} 条记录已保存在本地。需要完整周期时请自动加载并扫描。`
      : state.events.size
        ? `当前不是「假勤」会话；已从本地缓存载入 ${state.events.size} 条考勤记录${cacheTime ? `（更新于 ${cacheTime}）` : ''}，汇总可正常查看。更新数据时可自动定位并扫描。`
        : '当前不是「假勤」会话，且本地尚无考勤缓存。点击“定位并扫描「假勤」”可自动切换。';
    render();
    window.requestAnimationFrame(() => $('#panel').focus());
  }

  function closePanel() {
    $('#backdrop').classList.remove('open');
    $('#fab').setAttribute('aria-expanded', 'false');
    document.body.style.overflow = previousBodyOverflow;
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
    else $('#fab').focus();
  }

  $('#fab').addEventListener('click', openPanel);
  $('#close').addEventListener('click', closePanel);
  $('#backdrop').addEventListener('click', (event) => {
    if (event.target === $('#backdrop')) closePanel();
  });
  $('#naturalMonth').addEventListener('click', setNaturalMonth);
  $('#currentCycle').addEventListener('click', setCurrentCycle);
  $('#detectedCycle').addEventListener('click', setDetectedCycle);
  $('#scanCurrent').addEventListener('click', () => {
    if (applyFormConfig()) captureVisibleMessages();
  });
  $('#scanHistory').addEventListener('click', scanHistory);
  $('#clearData').addEventListener('click', () => {
    state.events.clear();
    clearEventCache();
    state.cacheUpdatedAt = '';
    state.cacheError = '';
    state.rawSeen.clear();
    state.messageDates.clear();
    state.detectedCycles.clear();
    state.config.detectedCycle = null;
    state.periodSelectionTouched = false;
    setPeriodState('natural', getNaturalMonthRange());
    saveConfig(state.config);
    state.scanStats = { examined: 0, parsed: 0, undated: 0, duplicates: 0 };
    state.status = `已清空机器人消息与本地考勤缓存；${state.manualAdjustments.size} 条手工补充已保留。`;
    render();
  });
  $('#addManual').addEventListener('click', () => {
    if (applyFormConfig()) openManualDialog();
  });
  $('#tableWrap').addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit-date]');
    if (button) openManualDialog(button.dataset.editDate);
  });
  $('#manualForm').addEventListener('submit', saveManualFromForm);
  $('#manualClose').addEventListener('click', closeManualDialog);
  $('#cancelManual').addEventListener('click', closeManualDialog);
  $('#deleteManual').addEventListener('click', deleteCurrentManual);
  $('#manualDialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeManualDialog();
  });
  for (const input of [$('#manualType'), $('#manualClockIn'), $('#manualClockOut'), $('#manualClockOutNextDay')]) {
    input.addEventListener('change', () => {
      $('#manualError').textContent = '';
      updateManualHint();
    });
  }
  $('#toggleOrder').addEventListener('click', () => {
    state.tableNewestFirst = !state.tableNewestFirst;
    render();
  });
  $('#summary').addEventListener('pointerover', (event) => {
    const point = event.target.closest && event.target.closest('.chart-point');
    if (point) showOvertimeTooltip(point);
  });
  $('#summary').addEventListener('pointerout', (event) => {
    const point = event.target.closest && event.target.closest('.chart-point');
    if (point && (!(event.relatedTarget instanceof Node) || !point.contains(event.relatedTarget))) hideOvertimeTooltip();
  });
  $('#summary').addEventListener('focusin', (event) => {
    const point = event.target.closest && event.target.closest('.chart-point');
    if (point) showOvertimeTooltip(point);
  });
  $('#summary').addEventListener('focusout', (event) => {
    const point = event.target.closest && event.target.closest('.chart-point');
    if (point && (!(event.relatedTarget instanceof Node) || !point.contains(event.relatedTarget))) hideOvertimeTooltip();
  });
  $('#summary').addEventListener('scroll', hideOvertimeTooltip, true);
  $('#copySummary').addEventListener('click', async () => {
    try {
      await copyText(summaryText());
      state.status = '摘要已复制到剪贴板。';
    } catch (error) {
      state.status = `复制失败：${error.message || error}`;
    }
    renderStatus();
  });
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#parsePaste').addEventListener('click', () => {
    applyFormConfig();
    const cycleBefore = latestDetectedCycle();
    const added = parsePastedText($('#importText').value);
    const cycleAfter = latestDetectedCycle();
    const cycleNote = cycleAfter && (!cycleBefore || cycleAfter.start !== cycleBefore.start || cycleAfter.end !== cycleBefore.end)
      ? `，识别到机器人周期 ${cycleAfter.start} 至 ${cycleAfter.end}`
      : '';
    state.status = `粘贴内容解析完成，新增 ${added} 条记录${cycleNote}。`;
    render();
  });
  for (const input of shadow.querySelectorAll('#panel input, #panel select')) {
    input.addEventListener('change', () => {
      if (input.id === 'rangeStart' || input.id === 'rangeEnd') {
        state.periodSelectionTouched = true;
        state.periodMode = 'manual';
      }
      if (input.id === 'scheduleMode') updateScheduleFields();
      applyFormConfig(true);
    });
  }
  shadow.addEventListener('keydown', (event) => {
    if (!$('#backdrop').classList.contains('open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if ($('#manualDialog').open) closeManualDialog();
      else closePanel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusRoot = $('#manualDialog').open ? $('#manualDialog') : shadow;
    const focusable = [...focusRoot.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary')]
      .filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const current = shadow.activeElement;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key !== EVENT_STORAGE_KEY) return;
    const cache = loadEventCache();
    state.events = cache.events;
    state.cacheUpdatedAt = cache.updatedAt;
    state.cacheError = '';
    state.rawSeen.clear();
    state.status = cache.events.size
      ? `其他 Messenger 标签页已更新本地考勤缓存，共 ${cache.events.size} 条记录。`
      : '其他 Messenger 标签页已清空本地考勤缓存。';
    render();
  });

  fillForm();
  render();
}());
