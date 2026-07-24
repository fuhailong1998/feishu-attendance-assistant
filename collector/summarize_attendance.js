#!/usr/bin/env node
'use strict';

process.env.TZ = 'Asia/Shanghai';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(ROOT, '.attendance-data', 'attendance-messages.json');
const DEFAULT_OUTPUT = path.join(ROOT, '.attendance-data', 'attendance-report.json');

function parseArgs(argv) {
  const options = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    period: 'auto',
    start: '',
    end: '',
    config: '',
    manual: '',
    now: '',
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--quiet') {
      options.quiet = true;
      continue;
    }
    const key = argument.replace(/^--/, '');
    if (!Object.prototype.hasOwnProperty.call(options, key) || typeof options[key] === 'boolean') {
      throw new Error(`未知参数：${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少值`);
    options[key] = value;
    index += 1;
  }
  if (!['auto', 'natural', 'detected', 'custom'].includes(options.period)) {
    throw new Error('--period 必须是 auto、natural、detected 或 custom');
  }
  if (options.period === 'custom' && (!options.start || !options.end)) {
    throw new Error('--period custom 必须同时提供 --start 与 --end');
  }
  return options;
}

function readJson(filePath, fallback = null) {
  if (!filePath) return fallback;
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function loadParserApi() {
  const scriptPath = path.join(ROOT, 'feishu-attendance.user.js');
  const source = fs.readFileSync(scriptPath, 'utf8');
  const sandbox = { console, Date, Intl, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: scriptPath });
  if (!sandbox.__FEISHU_ATTENDANCE_TEST__) {
    throw new Error('油猴脚本没有暴露解析接口');
  }
  return sandbox.__FEISHU_ATTENDANCE_TEST__;
}

function dateAtNoon(dateKey) {
  const date = new Date(`${dateKey}T12:00:00+08:00`);
  if (Number.isNaN(date.getTime())) throw new Error(`无效消息日期：${dateKey}`);
  return date;
}

function normalizedMessageText(message) {
  const time = /^\d{2}:\d{2}$/.test(String(message.time || '')) ? message.time : '';
  return [time, String(message.text || '').trim()].filter(Boolean).join('\n');
}

function detectCycles(api, messages) {
  const cycles = new Map();
  for (const message of messages) {
    const cycle = api.extractAttendanceCycle(
      normalizedMessageText(message),
      dateAtNoon(message.date),
    );
    if (!cycle) continue;
    cycles.set(`${cycle.start}|${cycle.end}|${cycle.cutoff || ''}`, cycle);
  }
  return [...cycles.values()].sort((left, right) => (
    left.end.localeCompare(right.end) || left.start.localeCompare(right.start)
  ));
}

function resolvePeriod(api, options, cycles, now) {
  if (options.period === 'custom') {
    return { mode: 'custom', start: options.start, end: options.end, cycle: null };
  }
  if (options.period === 'natural') {
    const range = api.getNaturalMonthRange(now);
    return { mode: 'natural', ...range, cycle: null };
  }

  const matching = cycles.filter((cycle) => api.isAttendanceCycleForMonth(cycle, now)).at(-1) || null;
  if (options.period === 'detected') {
    const selected = matching || cycles.at(-1);
    if (!selected) throw new Error('消息中没有识别到封账考勤周期');
    return { mode: 'detected', start: selected.start, end: selected.end, cycle: selected };
  }
  if (matching) {
    return { mode: 'detected', start: matching.start, end: matching.end, cycle: matching };
  }
  const range = api.getNaturalMonthRange(now);
  return { mode: 'natural', ...range, cycle: null };
}

function parseNow(value) {
  if (!value) return new Date();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T12:00:00+08:00`
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error(`--now 无效：${value}`);
  return date;
}

function normalizeConfig(api, options, period) {
  const defaults = api.getDefaultConfig();
  const overrides = readJson(options.config, {}) || {};
  const config = {
    ...defaults,
    ...overrides,
    rangeStart: period.start,
    rangeEnd: period.end,
  };
  if (!Array.isArray(config.workdays)) config.workdays = [...defaults.workdays];
  return config;
}

function atomicWritePrivate(filePath, payload) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(absolute), 0o700); } catch (_) {}
  const temporary = `${absolute}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, absolute);
  try { fs.chmodSync(absolute, 0o600); } catch (_) {}
  return absolute;
}

function compactRows(rows) {
  return rows.map((row) => {
    const { evidence, ...rest } = row;
    return rest;
  });
}

function compactEvents(events) {
  return events.map((event) => ({
    date: event.date,
    inTimes: [...(event.inTimes || [])],
    outTimes: [...(event.outTimes || [])],
    unknownTimes: [...(event.unknownTimes || [])],
    flags: { ...(event.flags || {}) },
    text: event.text || '',
  }));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = readJson(options.input);
  if (!input || input.schema_version !== 1 || !Array.isArray(input.messages)) {
    throw new Error('采集文件格式无效或版本不受支持');
  }
  const api = loadParserApi();
  const now = parseNow(options.now);
  const cycles = detectCycles(api, input.messages);
  const period = resolvePeriod(api, options, cycles, now);
  const config = normalizeConfig(api, options, period);
  const manual = readJson(options.manual, []) || [];
  if (!Array.isArray(manual)) throw new Error('--manual 文件必须是 JSON 数组');
  const approvalAdjustments = input.approval_adjustments || [];
  if (!Array.isArray(approvalAdjustments)) {
    throw new Error('采集文件中的 approval_adjustments 必须是 JSON 数组');
  }
  const normalizedApprovals = api.mergeManualAdjustments(approvalAdjustments);
  const normalizedManual = api.mergeManualAdjustments([
    ...normalizedApprovals,
    ...manual,
  ]);

  const events = [];
  let ignoredMessages = 0;
  for (const message of input.messages) {
    const event = api.parseAttendanceMessage(
      normalizedMessageText(message),
      message.date,
      config,
      { dateResolved: true },
    );
    if (event) events.push(event);
    else ignoredMessages += 1;
  }

  const summary = api.buildDailySummary(events, config, now, normalizedManual);
  if (summary.error) throw new Error(summary.error);
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: {
      collected_at: input.collected_at,
      method: input.source?.method || 'unknown',
      message_count: input.messages.length,
      first_message_at: input.source?.first_message_at || '',
      last_message_at: input.source?.last_message_at || '',
      approval_collection_enabled: Boolean(input.source?.approval_collection_enabled),
      approval_instances_matched: Number(input.source?.approval_instances_matched) || 0,
      approval_instances_approved: Number(input.source?.approval_instances_approved) || 0,
      approval_instances_unparsed: Number(input.source?.approval_instances_unparsed) || 0,
      approval_adjustment_count: normalizedApprovals.length,
    },
    period,
    config,
    detected_cycles: cycles,
    parsed_event_count: events.length,
    ignored_message_count: ignoredMessages,
    manual_adjustment_count: normalizedManual.length,
    manual_adjustments: normalizedManual,
    events: compactEvents(events),
    totals: summary.totals,
    rows: compactRows(summary.rows),
  };
  const output = atomicWritePrivate(options.output, report);

  if (!options.quiet) {
    const totals = summary.totals;
    console.log(`汇总完成：${period.start} 至 ${period.end}（${period.mode}）`);
    console.log(`正常 ${totals.normal} 天，异常 ${totals.abnormal} 天，待核对 ${totals.pending} 天。`);
    console.log(`加班总计 ${Math.round(totals.overtimeMinutes / 60 * 10) / 10} 小时，完整工时 ${totals.completeWorkDays} 天。`);
    console.log(`本地报告：${output}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`汇总失败：${error.message || error}`);
  process.exitCode = 1;
}
