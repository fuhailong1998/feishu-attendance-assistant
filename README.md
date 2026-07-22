# 飞书假勤考勤助手

一个运行在飞书网页版中的 Tampermonkey 用户脚本。它从「假勤」会话读取打卡消息，在浏览器本地生成每日考勤明细、异常汇总、有效工时和加班趋势。

## 功能

- 自动定位飞书「假勤」会话并扫描已加载的消息
- 支持本自然月、自定义周期和消息识别周期
- 识别上下班打卡、迟到、早退、缺卡等中英文消息
- 支持弹性联动、固定班次和独立弹性区间
- 支持全天请假、半天请假、补卡、出差、外出与备注补充
- 统计加班总时间、平均加班时间和平均工作时间
- 绘制每日加班趋势图
- 复制考勤摘要或导出 CSV
- 跨会话缓存已解析记录，刷新页面后仍可查看
- 可选本地采集器：复用已登录 Chrome，会话数据直接从飞书本地 SQLite 读取，不依赖 DOM 滚动

## 适用环境

- Chrome、Edge 或 Firefox
- Tampermonkey
- `https://thundersoft.feishu.cn/next/messenger`、尾部带 `/` 的地址及其会话子路由

本地采集器另外需要 Python 3.11+、Node.js 18+ 和 Google Chrome。

脚本不会在其他飞书页面或域名运行。

## 安装

### 在线安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 [`feishu-attendance.user.js`](https://raw.githubusercontent.com/fuhailong1998/feishu-attendance-assistant/main/feishu-attendance.user.js)。
3. 在 Tampermonkey 安装页面确认安装。
4. 登录飞书网页版并进入 Messenger，页面右下角会显示“考勤汇总”。

### 手动安装

1. 在 Tampermonkey 管理面板中新建脚本。
2. 删除示例内容。
3. 复制仓库中 [`feishu-attendance.user.js`](./feishu-attendance.user.js) 的完整内容并保存。

## 使用

1. 点击页面右下角的“考勤汇总”。
2. 选择统计周期并确认班次设置。
3. 点击“自动加载并扫描”。
4. 在每日明细中核对打卡记录与异常状态。
5. 对请假、补卡等情况使用“补充”进行本地标记。
6. 查看汇总与加班趋势，或复制摘要、导出 CSV。

当前不在「假勤」会话时，脚本会从左侧已加载的会话列表中定位「假勤」并切换。英文界面支持 `Attendance` 和 `Attendance Bot`。首次扫描后，解析结果会保存在当前飞书站点的本地缓存中，可以在其他 Messenger 会话中直接查看。

## 无 UI 本地采集

如果网页版 Messenger 太卡，可以使用 `collector/` 中的本地采集器。它不解析页面 DOM，也不复制 Cookie 或 Token；Chrome 自己保管登录态，采集器通过本机 CDP 进入同源上下文，读取飞书 Rust/WASM IM 引擎写入 IndexedDB 的 SQLite 快照，再复用油猴脚本的同一套考勤解析规则生成报告。

飞书当前的页面 IM 调用使用 protobuf `/im/gateway/` 和本地 Rust/WASM 数据库。直接在浏览器外复制 HTTP 请求既容易因协议升级失效，也会迫使程序导出会话凭据，因此本项目使用“让已登录 Chrome 发请求、采集器只读本地消息库”的方式。

### 1. 安装采集器依赖

```bash
python3 -m pip install -r requirements-collector.txt
```

不需要执行 `playwright install`，采集器连接的是系统 Chrome。

### 2. 首次建立专用登录会话

在 Windows PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File collector/start_chrome.ps1
```

脚本会使用独立目录 `%LOCALAPPDATA%\FeishuAttendanceCollector\ChromeProfile`，并仅在 `127.0.0.1:9237` 开放调试端口。在打开的专用 Chrome 窗口中登录一次飞书。不要把日常 Chrome 的默认 Profile 直接交给采集器。

如果 Chrome 已在该端口运行，启动脚本只会提示“已运行”，不会再开实例。

### 3. 采集并生成报告

快速读取已经同步到本地的消息：

```bash
python3 collector/feishu_attendance_collector.py
node collector/summarize_attendance.js
```

输出文件：

- `.attendance-data/attendance-messages.json`：标准化的假勤消息
- `.attendance-data/attendance-report.json`：周期汇总与每日明细

`.attendance-data/` 已加入 `.gitignore`。在 Linux/WSL 中，采集器会尽量把目录权限设为 `0700`、文件权限设为 `0600`。

### 4. 以后使用 headless Chrome 静默刷新

先关闭同一个专用 Profile 的可见 Chrome，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File collector/start_chrome.ps1 -Headless
```

然后让临时 Messenger 标签页同步 20 秒；图片、字体和媒体资源会被屏蔽，标签页完成后自动关闭：

```bash
python3 collector/feishu_attendance_collector.py --refresh-seconds 20
node collector/summarize_attendance.js
```

这不会打开可见的飞书窗口。若只需要上次已同步的数据，省略 `--refresh-seconds`，通常数秒即可完成。

### 周期参数

默认行为与油猴 UI 一致：当月存在“考勤申请截止时间提醒”识别出的周期时使用该周期，否则使用自然月。

```bash
# 强制本自然月
node collector/summarize_attendance.js --period natural

# 使用消息中最新的封账周期
node collector/summarize_attendance.js --period detected

# 自定义周期
node collector/summarize_attendance.js \
  --period custom \
  --start 2026-06-25 \
  --end 2026-07-24
```

可以通过 `--config config.json` 覆盖班次、节假日等设置，通过 `--manual manual.json` 载入本地补充数组。两类文件都不要提交到公共仓库。

### 采集器边界

- 本地数据库必须至少同步过一次；需要最新记录时使用 headless 刷新模式。
- 飞书内部 SQLite 结构不是公开 API，飞书升级后可能需要同步更新采集器。
- CDP 端口等同于控制已登录浏览器，必须只绑定 `127.0.0.1`，不要暴露到局域网或公网。
- 采集器不会调用 `context.cookies()`，不会输出 Cookie、Authorization、Token、聊天 ID 或数据库 ID。

## 考勤周期

| 周期 | 说明 |
| --- | --- |
| 本自然月 | 当月 1 日至当月最后一天 |
| 消息识别周期 | 从“考勤申请截止时间提醒”中提取封账起止日期 |
| 自定义周期 | 手动指定开始日期与结束日期 |

当识别到覆盖当前月份的封账周期时，默认使用消息识别周期；否则默认使用本自然月。也可以设置“每月周期起始日”，快速生成固定跨月周期。

## 默认考勤规则

默认班次为弹性联动：

- 上班窗口：08:30–09:30
- 下班窗口：18:00–19:00
- 午休时间：12:00–13:30，不计入有效工时
- 次日 00:00–05:59 的下班卡归入前一考勤日

弹性联动会根据实际上班时间平移应下班时间。例如：

| 上班时间 | 应下班时间 |
| --- | --- |
| 08:30 | 18:00 |
| 09:10 | 18:40 |
| 09:30 | 19:00 |

同一天存在多条上班卡时取最早时间，多条下班卡时取最晚时间。机器人消息明确给出迟到、早退或缺卡结论时，以消息结论为优先依据。

### 半天请假

| 类型 | 上班窗口 | 下班窗口 | 正常净出勤 |
| --- | --- | --- | --- |
| 上午半天假 | 14:00–15:00 | 18:00–19:00，弹性联动 | 4 小时 |
| 下午半天假 | 08:30–09:30 | 14:00–15:00，弹性联动 | 4 小时 |

下午半天出勤会扣除 12:00–13:30 午休时间。

### 加班统计

加班从当天应下班时间之后开始计算。周期汇总包含：

- 加班总时间
- 加班天数
- 平均加班时间
- 平均工作时间
- 每日加班趋势

平均加班时间按实际发生加班的日期计算；平均工作时间按具有完整上下班卡且可计算工时的日期计算。

## 本地补充

每日明细支持以下补充类型：

- 全天请假
- 上午半天假
- 下午半天假
- 补卡
- 出差
- 外出或外勤
- 其他说明

补录的上班或下班时间会覆盖当天对应一侧的消息记录并重新计算。补充内容保存在当前飞书站点的 `localStorage` 中，可以随时编辑或删除。

## 数据与隐私

- 脚本代码不会上传考勤消息或统计结果。
- 考勤设置、解析记录、消息证据和本地补充仅保存在浏览器 `localStorage` 中。
- 本地采集器生成的数据只写入 `.attendance-data/`，不会上传，也不会纳入 Git。
- 本地采集器只复用 Chrome 登录态，不导出 Cookie、Authorization 或 Token。
- “清空数据”会清除解析记录与缓存，手工补充可在对应日期中单独删除。
- 所有汇总均由浏览器本地完成。

## 数据口径

- 封账提醒只用于识别考勤周期，不作为每日打卡记录。
- 只有时间而没有日期的消息，优先从飞书消息 ID 解析发送日期；无法确定日期时不自动归档。
- `No record notification` 按正文中明确写出的考勤日期归档。
- 只有单侧打卡且消息未明确报告缺卡时，标记为待核对。
- 没有消息的工作日默认标记为待核对，也可以在设置中改为缺卡。
- 统计结果用于个人核对，最终考勤结果以飞书假勤应用或管理员报表为准。

## 本地验证

JavaScript 解析测试无需安装项目依赖：

```bash
node --check feishu-attendance.user.js
node tests/parser.test.js
python3 -m unittest tests/test_collector.py -v
python3 -m py_compile collector/feishu_attendance_collector.py
node --check collector/summarize_attendance.js
```

UI 回归测试需要 Python Playwright 和本机 Chrome：

```bash
python3 tests/ui-debug.py
```

UI 测试覆盖响应式布局、键盘操作、跨会话缓存、自动定位、本地补充、封账周期、中英文消息解析和加班趋势。
