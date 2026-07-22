'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, '..', 'feishu-attendance.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');
assert.match(source, /^\/\/ @match\s+https:\/\/thundersoft\.feishu\.cn\/next\/messenger$/m);
assert.match(source, /^\/\/ @match\s+https:\/\/thundersoft\.feishu\.cn\/next\/messenger\/\*$/m);
const sandbox = { console, Date, Intl, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: scriptPath });

const api = sandbox.__FEISHU_ATTENDANCE_TEST__;
assert.ok(api, '脚本应暴露纯函数测试接口');

const baseConfig = {
  cycleStartDay: 1,
  rangeStart: '2026-07-01',
  rangeEnd: '2026-07-03',
  scheduleMode: 'fixed',
  workStart: '09:00',
  workEnd: '18:00',
  graceMinutes: 0,
  workdays: [1, 2, 3, 4, 5],
  holidayDates: '',
  extraWorkDates: '',
  noMessageAsMissing: false,
  unknownSplitTime: '14:00',
};

{
  const event = api.parseAttendanceMessage('2026年7月1日\n上班打卡成功\n打卡时间：08:57', '2026-07-01', baseConfig);
  assert.equal(event.date, '2026-07-01');
  assert.deepEqual(Array.from(event.inTimes), ['08:57']);
  assert.deepEqual(Array.from(event.outTimes), []);
}

{
  const event = api.parseAttendanceMessage('7月1日 下班打卡成功 18:31', '2026-07-01', baseConfig);
  assert.deepEqual(Array.from(event.outTimes), ['18:31']);
}

{
  const event = api.parseAttendanceMessage('下班打卡提醒：请在 18:00 后及时打卡', '2026-07-01', baseConfig);
  assert.equal(event, null, '提醒中的计划时间不能算成实际打卡');
}

{
  const event = api.parseAttendanceMessage('上班打卡提醒：应打卡时间 09:00，请及时打卡', '2026-07-01', baseConfig);
  assert.equal(event, null, '“应打卡时间”不能算成实际打卡');
}

{
  const reminders = [
    '08:22\n上班打卡提醒\n快到上班时间了，别忘了打卡哦~\n去打卡',
    '08:22\n上班打卡提醒\n再不打卡就要迟到了，快去打卡吧~\n去打卡',
    '17:55\n下班打卡提醒\n再不打卡就要早退了，完成打卡后可忽略本提醒',
  ];
  for (const text of reminders) {
    assert.equal(
      api.parseAttendanceMessage(text, '2026-07-01', baseConfig, { dateResolved: true }),
      null,
      '打卡提醒整张卡片不能生成时间或异常状态',
    );
  }
}

{
  const cachedReminder = api.normalizeCachedEvent({
    date: '2026-07-01',
    inTimes: [],
    outTimes: [],
    unknownTimes: [],
    flags: { late: true },
    text: '08:22\n上班打卡提醒\n再不打卡就要迟到了，快去打卡吧~',
    source: 'message',
  });
  assert.equal(cachedReminder, null, '升级后应自动剔除旧缓存中的提醒误记录');
}

{
  const event = api.parseAttendanceMessage(
    '08:22\n上班打卡成功!\n打卡方式：通过考勤机打卡\n查看详情',
    '2026-07-01',
    baseConfig,
    { dateResolved: true },
  );
  assert.deepEqual(Array.from(event.inTimes), ['08:22'], '实际打卡成功消息仍应正常解析');
  assert.equal(event.flags.late, false);
}

{
  const event = api.parseAttendanceMessage(
    '上班打卡成功，班次 09:00-18:00，实际打卡时间 09:06',
    '2026-07-01',
    baseConfig,
  );
  assert.deepEqual(Array.from(event.inTimes), ['09:06'], '班次时间不能混入实际打卡时间');
}

{
  const event = api.parseAttendanceMessage(
    'Jul 17, 9:23 AMClocked in successfully!Method:By attendance machineViewdetails',
    '2026-07-22',
    baseConfig,
  );
  assert.equal(event.date, '2026-07-17');
  assert.deepEqual(Array.from(event.inTimes), ['09:23']);
  assert.deepEqual(Array.from(event.outTimes), []);
}

{
  const event = api.parseAttendanceMessage(
    'Jul 17, 9:10 PMClocked out successfully!Method: By attendance machineView Details',
    '2026-07-22',
    baseConfig,
  );
  assert.equal(event.date, '2026-07-17');
  assert.deepEqual(Array.from(event.outTimes), ['21:10'], '12 小时制 PM 时间应转换为 24 小时制');
}

{
  const reference = new Date(2026, 6, 22, 12, 0);
  assert.equal(
    api.extractLeadingMessageDate('Yesterday, 10:05 PMClocked out successfully!', reference),
    '2026-07-21',
  );
  assert.equal(
    api.extractLeadingMessageDate('9:24 AMClocked in successfully!', reference),
    null,
    '只有时间、没有日期或消息元数据时必须保持未归档，不能擅自认定为当天',
  );
  assert.equal(
    api.dateFromFeishuMessageId('7665152627892949899'),
    '2026-07-22',
    '合成的飞书消息 ID 应提供当天消息的完整日期',
  );
  assert.equal(
    api.dateFromFeishuMessageId('7664969404477081428'),
    '2026-07-21',
    '消息 ID 日期必须和机器人显示的 Yesterday 日期一致',
  );
  assert.equal(api.dateFromFeishuMessageId('jul22-in'), null, '普通 DOM id 不能被当成时间戳');
  const yesterdayOut = api.parseAttendanceMessage(
    'Yesterday, 10:05 PMClocked out successfully!Method: By attendance machineView Details',
    '2026-07-21',
    baseConfig,
    { dateResolved: true },
  );
  assert.equal(yesterdayOut.date, '2026-07-21', 'DOM 已解析的 Yesterday 日期不能再减一天');
  assert.deepEqual(Array.from(yesterdayOut.outTimes), ['22:05']);
}

{
  const noRecord = api.parseAttendanceMessage(
    'Jul 1, 9:58 AMNo record notificationRecent no record: 06-30 08:30 clock-inNo record in this month: 0 times in totalDetailsCorrect',
    '2026-07-01',
    baseConfig,
    { dateResolved: true },
  );
  assert.equal(noRecord.date, '2026-06-30', '缺卡通知应归属机器人明确写出的考勤日期，而不是通知发送日');
  assert.equal(noRecord.flags.missingIn, true);
}

{
  const report = api.parseAttendanceMessage(
    'Weekly Report(07/13-07/19) Irregular records: No Record 1 times',
    '2026-07-20',
    baseConfig,
  );
  assert.equal(report, null, '周报不能被当作某一天的缺卡消息');
  const reminder = api.parseAttendanceMessage(
    'Attendance requests closing soon. Records from 2026-06-25 to 2026-07-24 will be locked on 07/25 18:00.',
    '2026-07-22',
    baseConfig,
  );
  assert.equal(reminder, null, '截止提醒中的时间不能算成实际打卡');
}

{
  const reminderText = `考勤申请截止时间提醒中

7月25日 18:00将封存2026-06-25 - 2026-07-24期间的考勤数据，封存后将无法再提交补卡、请假、出差、外出、加班、换班等申请；同时，未完成审批的流程，审批人将无法继续审批。

待封账期间，您共有2次异常考勤，请及时处理并跟进流程进度`;
  const cycle = api.extractAttendanceCycle(reminderText, new Date(2026, 6, 22));
  assert.deepEqual(
    JSON.parse(JSON.stringify(cycle)),
    { start: '2026-06-25', end: '2026-07-24', cutoff: '2026-07-25 18:00' },
  );
  assert.equal(api.isAttendanceCycleForMonth(cycle, new Date(2026, 6, 22)), true);
  assert.equal(api.isAttendanceCycleForMonth(cycle, new Date(2026, 7, 1)), false);
  assert.equal(
    api.parseAttendanceMessage(reminderText, '2026-07-22', baseConfig),
    null,
    '封账提醒不能因包含请假、出差等词而被计入每日考勤',
  );
}

{
  const cycle = api.extractAttendanceCycle(
    'Attendance requests closing soon. Records from 2026-06-25 to 2026-07-24 will be locked on 07/25 18:00.',
    new Date(2026, 6, 22),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(cycle)),
    { start: '2026-06-25', end: '2026-07-24', cutoff: '2026-07-25 18:00' },
    '英文封账提醒也应识别同一周期',
  );
  assert.equal(api.extractAttendanceCycle('2026-07-17 上班打卡成功 09:23', new Date(2026, 6, 22)), null);
}

{
  const event = api.parseAttendanceMessage('昨日上班缺卡，请尽快申请补卡', '2026-07-02', baseConfig);
  assert.equal(event.date, '2026-07-01');
  assert.equal(event.flags.missingIn, true);
}

{
  const event = api.parseAttendanceMessage('2026-07-03 上班 09:12 迟到\n下班 17:50 早退', '2026-07-03', baseConfig);
  assert.deepEqual(Array.from(event.inTimes), ['09:12']);
  assert.deepEqual(Array.from(event.outTimes), ['17:50']);
  assert.equal(event.flags.late, true);
  assert.equal(event.flags.early, true);
}

{
  const beforeStart = api.getCycleRange(new Date(2026, 6, 22), 26);
  assert.equal(beforeStart.start, '2026-06-26');
  assert.equal(beforeStart.end, '2026-07-25');
  const afterStart = api.getCycleRange(new Date(2026, 6, 30), 26);
  assert.equal(afterStart.start, '2026-07-26');
  assert.equal(afterStart.end, '2026-08-25');
}

{
  const events = [
    api.parseAttendanceMessage('2026-07-01 上班打卡成功 08:57', '2026-07-01', baseConfig),
    api.parseAttendanceMessage('2026-07-01 下班打卡成功 18:31', '2026-07-01', baseConfig),
    api.parseAttendanceMessage('2026-07-02 上班打卡成功 09:12 迟到', '2026-07-02', baseConfig),
    api.parseAttendanceMessage('2026-07-02 下班打卡成功 17:50 早退', '2026-07-02', baseConfig),
  ];
  const result = api.buildDailySummary(events, baseConfig, new Date(2026, 6, 4, 12, 0));
  const july1 = result.rows.find((row) => row.date === '2026-07-01');
  const july2 = result.rows.find((row) => row.date === '2026-07-02');
  const july3 = result.rows.find((row) => row.date === '2026-07-03');
  assert.equal(july1.status, '正常');
  assert.equal(july1.duration, '9小时34分');
  assert.match(july2.status, /迟到/);
  assert.match(july2.status, /早退/);
  assert.equal(july3.status, '无消息·待核对');
  assert.equal(result.totals.pending, 1);
  assert.equal(result.totals.late, 1);
  assert.equal(result.totals.early, 1);
}

{
  const strictConfig = { ...baseConfig, noMessageAsMissing: true };
  const result = api.buildDailySummary([], strictConfig, new Date(2026, 6, 4, 12, 0));
  assert.equal(result.totals.missing, 3);
  assert.equal(result.totals.pending, 0);
}

{
  const onePunchConfig = { ...baseConfig, rangeStart: '2026-07-01', rangeEnd: '2026-07-01' };
  const event = api.parseAttendanceMessage('2026-07-01 上班打卡成功 08:57', '2026-07-01', onePunchConfig);
  const result = api.buildDailySummary([event], onePunchConfig, new Date(2026, 6, 2, 12, 0));
  assert.equal(result.rows[0].status, '仅上班卡·待核对');
  assert.equal(result.totals.missing, 0, '只有单侧消息且机器人未明确报缺卡时不能自行判缺卡');
  assert.equal(result.totals.pending, 1);
}

{
  const overnightConfig = {
    ...baseConfig,
    scheduleMode: 'flex-linked',
    rangeStart: '2026-05-28',
    rangeEnd: '2026-05-30',
    flexStartEarliest: '08:30',
    flexStartLatest: '09:30',
    flexEndEarliest: '18:00',
    flexEndLatest: '19:00',
    overnightClockOutCutoff: '06:00',
  };
  const events = [
    api.parseAttendanceMessage('May 28, 9:30 AMClocked in successfully!', '2026-05-28', overnightConfig, { dateResolved: true }),
    api.parseAttendanceMessage('May 29, 12:12 AMClocked out successfully!', '2026-05-29', overnightConfig, { dateResolved: true }),
    api.parseAttendanceMessage('May 29, 9:22 AMClocked in successfully!', '2026-05-29', overnightConfig, { dateResolved: true }),
    api.parseAttendanceMessage('May 30, 2:03 AMClocked out successfully!', '2026-05-30', overnightConfig, { dateResolved: true }),
    api.parseAttendanceMessage('May 30, 10:02 AMClocked in successfully!', '2026-05-30', overnightConfig, { dateResolved: true }),
    api.parseAttendanceMessage('May 30, 10:00 PMClocked out successfully!', '2026-05-30', overnightConfig, { dateResolved: true }),
  ];
  assert.equal(events[1].date, '2026-05-28');
  assert.deepEqual(Array.from(events[1].outTimes), ['次日 00:12']);
  assert.equal(events[3].date, '2026-05-29');
  assert.deepEqual(Array.from(events[3].outTimes), ['次日 02:03']);

  const result = api.buildDailySummary(events, overnightConfig, new Date(2026, 5, 1, 12, 0));
  const may28 = result.rows.find((row) => row.date === '2026-05-28');
  const may29 = result.rows.find((row) => row.date === '2026-05-29');
  const may30 = result.rows.find((row) => row.date === '2026-05-30');
  assert.equal(may28.clockOut, '次日 00:12');
  assert.equal(may28.duration, '14小时42分');
  assert.equal(may28.status, '正常');
  assert.equal(may29.clockOut, '次日 02:03');
  assert.equal(may29.duration, '16小时41分');
  assert.equal(may29.status, '正常');
  assert.equal(may30.clockOut, '22:00');
  assert.equal(may30.status, '休息日打卡');

  const april18Config = { ...overnightConfig, rangeStart: '2026-04-18', rangeEnd: '2026-04-18' };
  const april18 = api.buildDailySummary([
    api.parseAttendanceMessage('Apr 18, 10:35 AMClocked in successfully!', '2026-04-18', april18Config, { dateResolved: true }),
    api.parseAttendanceMessage('Apr 18, 8:05 PMClocked out successfully!', '2026-04-18', april18Config, { dateResolved: true }),
    api.parseAttendanceMessage('Apr 19, 2:39 AMClocked out successfully!', '2026-04-19', april18Config, { dateResolved: true }),
  ], april18Config, new Date(2026, 3, 20, 12, 0)).rows[0];
  assert.equal(april18.clockOut, '次日 02:39', '次日凌晨下班应晚于同日已有的晚间下班卡');
  assert.equal(april18.duration, '16小时4分');
}

{
  const cutoffConfig = { ...baseConfig, overnightClockOutCutoff: '06:00' };
  const beforeCutoff = api.parseAttendanceMessage(
    '2026-07-02 下班打卡成功 05:59',
    '2026-07-02',
    cutoffConfig,
    { dateResolved: true },
  );
  const atCutoff = api.parseAttendanceMessage(
    '2026-07-02 下班打卡成功 06:00',
    '2026-07-02',
    cutoffConfig,
    { dateResolved: true },
  );
  const earlyClockIn = api.parseAttendanceMessage(
    '2026-07-02 上班打卡成功 05:59',
    '2026-07-02',
    cutoffConfig,
    { dateResolved: true },
  );
  assert.equal(beforeCutoff.date, '2026-07-01', '05:59 下班卡应归前一考勤日');
  assert.deepEqual(Array.from(beforeCutoff.outTimes), ['次日 05:59']);
  assert.equal(atCutoff.date, '2026-07-02', '06:00 下班卡不能再归前一考勤日');
  assert.deepEqual(Array.from(atCutoff.outTimes), ['06:00']);
  assert.equal(earlyClockIn.date, '2026-07-02', '凌晨上班卡不适用下班跨日规则');

  const missingOut = api.parseAttendanceMessage(
    'No record notification Recent no record: 07-02 05:59 clock-out',
    '2026-07-02',
    cutoffConfig,
    { dateResolved: true },
  );
  assert.equal(missingOut.date, '2026-07-02', '缺卡通知不是实际下班卡，不能套用跨日归档规则');
  assert.equal(missingOut.flags.missingOut, true);
}

{
  const flexConfig = {
    ...baseConfig,
    scheduleMode: 'flex-linked',
    rangeStart: '2026-07-06',
    rangeEnd: '2026-07-08',
    flexStartEarliest: '08:30',
    flexStartLatest: '09:30',
    flexEndEarliest: '18:00',
    flexEndLatest: '19:00',
  };
  const messages = [
    ['2026-07-06', '08:30', '18:00'],
    ['2026-07-07', '09:10', '18:39'],
    ['2026-07-08', '09:31', '19:00'],
  ];
  const events = messages.flatMap(([date, clockIn, clockOut]) => [
    api.parseAttendanceMessage(`${date} 上班打卡成功 ${clockIn}`, date, flexConfig),
    api.parseAttendanceMessage(`${date} 下班打卡成功 ${clockOut}`, date, flexConfig),
  ]);
  const result = api.buildDailySummary(events, flexConfig, new Date(2026, 6, 9, 12, 0));
  assert.equal(result.rows[0].expectedOut, '18:00');
  assert.equal(result.rows[0].status, '正常');
  assert.equal(result.rows[1].expectedOut, '18:40');
  assert.match(result.rows[1].status, /早退/);
  assert.equal(result.rows[2].expectedOut, '19:00');
  assert.match(result.rows[2].status, /迟到/);
  assert.equal(result.totals.early, 1);
  assert.equal(result.totals.late, 1);
}

{
  const windowConfig = {
    ...baseConfig,
    scheduleMode: 'flex-window',
    rangeStart: '2026-07-06',
    rangeEnd: '2026-07-06',
    flexStartEarliest: '08:30',
    flexStartLatest: '09:30',
    flexEndEarliest: '18:00',
    flexEndLatest: '19:00',
  };
  const events = [
    api.parseAttendanceMessage('2026-07-06 上班打卡成功 09:10', '2026-07-06', windowConfig),
    api.parseAttendanceMessage('2026-07-06 下班打卡成功 18:00', '2026-07-06', windowConfig),
  ];
  const result = api.buildDailySummary(events, windowConfig, new Date(2026, 6, 7, 12, 0));
  assert.equal(result.rows[0].expectedOut, '18:00–19:00');
  assert.equal(result.rows[0].status, '正常');
}

{
  assert.equal(api.netWorkMinutes(9 * 60, 14 * 60 + 30), 4 * 60, '上午出勤跨午休时应扣除 12:00–13:30');
  assert.equal(api.netWorkMinutes(14 * 60 + 30, 18 * 60 + 30), 4 * 60, '下午出勤不应额外扣减午休');
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.normalizeManualAdjustment({
      date: '2026-07-06',
      type: 'patch',
      clockIn: '09:00',
      clockOut: '02:00',
      clockOutNextDay: true,
      note: '补下班卡',
    }))),
    {
      date: '2026-07-06',
      type: 'patch',
      clockIn: '09:00',
      clockOut: '02:00',
      clockOutNextDay: true,
      note: '补下班卡',
      updatedAt: '',
    },
  );
  assert.equal(
    api.normalizeManualAdjustment({ date: '2026-07-06', type: 'patch', clockOut: '06:00', clockOutNextDay: true }).clockOutNextDay,
    false,
    '次日下班手工标记同样只允许到 05:59',
  );
}

{
  const config = {
    ...baseConfig,
    scheduleMode: 'flex-linked',
    rangeStart: '2026-07-06',
    rangeEnd: '2026-07-09',
    flexStartEarliest: '08:30',
    flexStartLatest: '09:30',
    flexEndEarliest: '18:00',
    flexEndLatest: '19:00',
    overnightClockOutCutoff: '06:00',
  };
  const punches = [
    ['2026-07-06', '09:00', '20:00'],
    ['2026-07-07', '14:30', '20:00'],
    ['2026-07-08', '09:00', '15:30'],
  ];
  const events = [
    ...punches.flatMap(([date, clockIn, clockOut]) => [
      api.parseAttendanceMessage(`${date} 上班打卡成功 ${clockIn}`, date, config),
      api.parseAttendanceMessage(`${date} 下班打卡成功 ${clockOut}`, date, config),
    ]),
    api.parseAttendanceMessage('2026-07-07 请假审批通过', '2026-07-07', config),
  ];
  const manual = [
    { date: '2026-07-07', type: 'leave-am', note: '上午请假' },
    { date: '2026-07-08', type: 'leave-pm', note: '下午请假' },
    { date: '2026-07-09', type: 'leave-full', note: '年假' },
  ];
  const result = api.buildDailySummary(events, config, new Date(2026, 6, 10, 12, 0), manual);
  const fullDay = result.rows.find((row) => row.date === '2026-07-06');
  const morningLeave = result.rows.find((row) => row.date === '2026-07-07');
  const afternoonLeave = result.rows.find((row) => row.date === '2026-07-08');
  const fullLeave = result.rows.find((row) => row.date === '2026-07-09');

  assert.equal(fullDay.expectedOut, '18:30');
  assert.equal(fullDay.workDuration, '9小时30分');
  assert.equal(fullDay.overtime, '1小时30分');

  assert.equal(morningLeave.expectedOut, '18:30');
  assert.equal(morningLeave.workDuration, '5小时30分');
  assert.equal(morningLeave.overtime, '1小时30分');
  assert.match(morningLeave.status, /上午半天假/);
  assert.match(morningLeave.status, /半天出勤正常/);

  assert.equal(afternoonLeave.expectedOut, '14:30');
  assert.equal(afternoonLeave.workDuration, '5小时');
  assert.equal(afternoonLeave.overtime, '1小时');
  assert.match(afternoonLeave.status, /下午半天假/);
  assert.match(afternoonLeave.status, /半天出勤正常/);

  assert.equal(fullLeave.status, '全天请假');
  assert.equal(fullLeave.workDuration, '—');
  assert.equal(result.totals.leave, 2, '全天假计 1 天，两个半天各计 0.5 天');
  assert.equal(result.totals.overtimeMinutes, 4 * 60);
  assert.equal(result.totals.overtimeDays, 3);
  assert.equal(result.totals.averageOvertimeMinutes, 80, '平均加班按实际发生加班的日期计算');
  assert.equal(result.totals.workMinutes, 20 * 60);
  assert.equal(result.totals.completeWorkDays, 3);
  assert.equal(result.totals.averageWorkMinutes, 400, '平均工时应包含完整半天出勤，并排除全天请假');
  const trend = api.getOvertimeTrendData(result.rows);
  assert.equal(trend.length, 4);
  assert.equal(trend.filter((item) => item.available).length, 3);
  assert.equal(trend.find((item) => item.date === '2026-07-07').overtimeMinutes, 90);
  assert.equal(trend.find((item) => item.date === '2026-07-09').available, false, '全天请假不能伪装成 0 加班数据点');
}

{
  const config = { ...baseConfig, rangeStart: '2026-07-01', rangeEnd: '2026-07-01' };
  const events = [
    api.parseAttendanceMessage('2026-07-01 上班打卡成功 09:12 迟到', '2026-07-01', config),
    api.parseAttendanceMessage('2026-07-01 下班打卡成功 17:50 早退', '2026-07-01', config),
  ];
  const result = api.buildDailySummary(events, config, new Date(2026, 6, 2, 12, 0), [{
    date: '2026-07-01',
    type: 'patch',
    clockIn: '09:00',
    clockOut: '18:00',
    note: '补卡审批已通过',
  }]);
  assert.equal(result.rows[0].clockIn, '09:00');
  assert.equal(result.rows[0].clockOut, '18:00');
  assert.equal(result.rows[0].status, '已补卡');
  assert.equal(result.rows[0].abnormal, false, '本地补卡应覆盖机器人原始异常，再按补录时间重新计算');
  assert.equal(result.rows[0].manualLabel, '补卡');
}

{
  const config = {
    ...baseConfig,
    scheduleMode: 'flex-linked',
    rangeStart: '2026-07-13',
    rangeEnd: '2026-07-16',
    flexStartEarliest: '08:30',
    flexStartLatest: '09:30',
    flexEndEarliest: '18:00',
    flexEndLatest: '19:00',
  };
  const punches = [
    ['2026-07-13', '15:00', '19:00'],
    ['2026-07-14', '15:01', '19:00'],
    ['2026-07-15', '09:30', '15:00'],
    ['2026-07-16', '09:30', '14:59'],
  ];
  const events = punches.flatMap(([date, clockIn, clockOut]) => [
    api.parseAttendanceMessage(`${date} 上班打卡成功 ${clockIn}`, date, config),
    api.parseAttendanceMessage(`${date} 下班打卡成功 ${clockOut}`, date, config),
  ]);
  const result = api.buildDailySummary(events, config, new Date(2026, 6, 17, 12, 0), [
    { date: '2026-07-13', type: 'leave-am' },
    { date: '2026-07-14', type: 'leave-am' },
    { date: '2026-07-15', type: 'leave-pm' },
    { date: '2026-07-16', type: 'leave-pm' },
  ]);
  const rows = Object.fromEntries(result.rows.map((row) => [row.date, row]));
  assert.doesNotMatch(rows['2026-07-13'].status, /迟到|早退/);
  assert.equal(rows['2026-07-13'].workDuration, '4小时');
  assert.match(rows['2026-07-14'].status, /迟到/);
  assert.doesNotMatch(rows['2026-07-14'].status, /早退/);
  assert.doesNotMatch(rows['2026-07-15'].status, /迟到|早退/);
  assert.equal(rows['2026-07-15'].workDuration, '4小时');
  assert.match(rows['2026-07-16'].status, /早退/);
}

console.log('parser.test.js: all tests passed');
