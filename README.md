# 飞书假勤考勤助手

一个从飞书「假勤」会话生成个人考勤报告的本地工具。推荐运行一条 Python
命令，通过 `lark-cli` 读取消息、生成独立 HTML 报告并直接在浏览器中打开；
也可以继续使用飞书网页版中的 Tampermonkey UI。

## 功能

- 自动定位飞书「假勤」会话并读取可访问消息
- 支持全部数据、历史考勤周期、任意自然月、固定起始日周期和自定义起止日期
- 识别上下班打卡、迟到、早退、缺卡等中英文消息
- 支持弹性联动、固定班次和独立弹性区间
- 支持法定节假日、全天请假、半天请假、补卡、出差、外出与备注补充
- 统计加班总时间、平均加班时间和平均工作时间
- 支持每日加班 K 线与趋势图切换，默认显示绿涨红跌 K 线，并叠加累计平均加班变化曲线
- 复制考勤摘要或导出 CSV
- 生成无需服务器、无需联网的单文件 HTML 报告，并自动用默认浏览器打开
- 使用当前登录用户的显示姓名生成“姓名的考勤报告”标题
- 可在 HTML 中逐日核对、补卡或标记请假/出差，并立即按同一套规则重新计算
- 跨会话缓存已解析记录，刷新页面后仍可查看
- 推荐本地采集器：通过 `lark-cli` 用户身份分页读取假勤私聊，并复用专用
  Chrome Profile 的本地登录态，直接请求公司 OA / 飞书 People 接口补充审批数据
- 回退本地采集器：复用已登录 Chrome，从飞书本地 SQLite 读取消息，不依赖 DOM 滚动

## 适用环境

- 推荐采集模式：已完成用户登录的 `lark-cli`、Python 3.11+、Node.js 18+；
  自动读取三方审批详情需要 `requests`、`cryptography` 和 Linux 桌面密钥环。
  Google Chrome 与 Python Playwright 只在首次建立/刷新网页登录态或显式启用兼容模式时使用
- 网页 UI 模式：Chrome、Edge 或 Firefox、Tampermonkey
- 网页 UI 仅匹配 `https://thundersoft.feishu.cn/next/messenger`、尾部带 `/` 的地址及其会话子路由

旧版 Chrome/SQLite 采集器另外需要 Google Chrome 和 Python Playwright。

Tampermonkey 脚本不会在其他飞书页面或域名运行。

## 安装

### lark-cli 采集模式

确认 `lark-cli whoami` 的用户身份可用。读取审批补充时只需要
`approval:instance:read`；考勤打卡数据始终来自【假勤】消息，不调用飞书考勤 API。
安装采集依赖：

```bash
python3 -m pip install -r requirements-collector.txt
```

网页登录态有效时，默认运行不会启动 Chrome。程序从专用 Profile 只读解密所需
Cookie，仅在当前进程内存中使用，并直接调用审批业务接口。首次使用或登录过期时，
同一条命令会临时启动后台无界面 Chrome，把飞书登录二维码直接显示在终端；扫码确认
后自动关闭 Chrome、重试接口并继续生成报告。Playwright 连接系统 Chrome，不需要
执行 `playwright install`。若使用 `--no-approval-details`，消息与审批摘要采集仍
只依赖 Python 标准库。考勤规则复用油猴脚本的解析核心，因此仍需要 Node.js。

### 网页 UI 在线安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 [`feishu-attendance.user.js`](https://raw.githubusercontent.com/fuhailong1998/feishu-attendance-assistant/main/feishu-attendance.user.js)。
3. 在 Tampermonkey 安装页面确认安装。
4. 登录飞书网页版并进入 Messenger，页面右下角会显示“考勤汇总”。

### 网页 UI 手动安装

1. 在 Tampermonkey 管理面板中新建脚本。
2. 删除示例内容。
3. 复制仓库中 [`feishu-attendance.user.js`](./feishu-attendance.user.js) 的完整内容并保存。

## 使用

1. 点击页面右下角的“考勤汇总”。
2. 选择统计周期并确认班次设置。
3. 点击“自动加载并扫描”。
4. 在每日明细中核对打卡记录与异常状态。
5. 对请假、补卡等情况使用“补充”进行本地标记。
6. 查看汇总，并按需切换加班 K 线或趋势图；也可复制摘要、导出 CSV。

当前不在「假勤」会话时，脚本会从左侧已加载的会话列表中定位「假勤」并切换。英文界面支持 `Attendance` 和 `Attendance Bot`。首次扫描后，解析结果会保存在当前飞书站点的本地缓存中，可以在其他 Messenger 会话中直接查看。

## 推荐：使用 lark-cli 采集

`lark-cli` 可以直接以当前用户身份列出 P2P 会话并读取消息，不需要打开飞书
Messenger 或安装 Tampermonkey。补签和休假的三方审批摘要没有完整业务日期，采集器
会用 `lark-cli` 返回的跳转链接，复用专用 Chrome Profile 中已经存在的网页登录态，
直接请求公司 OA / 飞书 People 的详情接口。Cookie 只在进程内存中解密和使用，不会
写入输出；项目只保存标准化后的考勤文本及审批日期/时间，不会将令牌、会话 ID 或
消息 ID 写入输出文件。最终私有报告会写入当前登录用户的显示姓名，用于报告标题。

### 1. 一条命令生成报告

```bash
cd feishu-attendance-assistant
./attendance
```

这条命令会自动：

1. 检查 `lark-cli` 用户登录状态。
2. 用 `lark-cli auth check` 检查最小只读权限 `approval:instance:read`；如果缺少，
   直接显示需要执行的授权命令并停止，不会自行扩大权限。
3. 从 `.attendance-data/approval-chrome-profile` 只读加载网页登录态，并直接请求
   公司 OA 的补签接口和飞书 People 的休假接口；登录过期时在终端显示二维码，扫码
   后自动恢复并继续。
4. 采集【假勤】消息和审批补充、生成 HTML 并打开报告。

运行期间会按 `[进度 1/8]` 到 `[进度 8/8]` 显示登录检查、权限检查、假勤消息、
审批详情、结果保存、汇总计算和 HTML 生成状态。审批阶段还会显示 People 会话、
公司 OA 授权、二维码等待、接口重试及后台 Chrome 关闭等子步骤；`--quiet` 可关闭
非必要进度，但需要扫码时仍会显示二维码。

缺少审批只读权限时会提示：

```text
请执行：lark-cli auth login --scope "approval:instance:read"
```

完成授权后重新运行 `./attendance` 即可。这里不需要申请考勤权限；所有原始上下班
打卡仍只来自【假勤】消息。

如果首次使用或网页登录已过期，不需要换命令。`./attendance` 会直接在当前终端显示
飞书二维码；使用飞书手机端扫码并确认后，程序会自动检测登录成功、补齐公司 OA /
飞书 People 会话并继续。二维码是一次性的，只显示在终端，不会保存到磁盘；等待
期间失效时会自动刷新并输出新码。后续登录态有效时仍直接请求接口，也不会启动
Chrome 窗口。

公司 OA 可能只签发浏览器会话期 Cookie。自动恢复时，采集器只把允许的
`.feishu.cn` / `.thundersoft.com` Cookie 在当前进程内存中临时交给后续
`requests` 请求，后台 Chrome 随即关闭；Cookie 值不会打印、写入报告或保存为额外
文件。

#### 清除登录状态

`lark-cli` 用户令牌和审批网页 Profile 是两套独立登录状态。只清除审批网页状态、
保留 `lark-cli` 登录时，请先确保没有正在运行的采集命令，再在仓库根目录执行：

```bash
gio trash -- .attendance-data/approval-chrome-profile
```

也可以通过文件管理器把该目录移入回收站。报告、考勤数据和 `lark-cli` 登录不会受到
影响；下次运行 `./attendance` 时会重新创建 Profile，并在需要时显示登录二维码。
若要单独清除 `lark-cli` 用户令牌，执行：

```bash
lark-cli auth logout
```

如果文件在复制后失去可执行权限，执行一次 `chmod +x attendance`；也可以直接运行：

```bash
python3 collector/lark_cli_attendance_collector.py
```

报告是完全自包含的本地文件，不会加载 CDN、字体或其他外部资源。

采集器会从按活跃时间排序的 P2P 会话中自动查找名称匹配
`假勤|Attendance` 的会话，以每页 50 条完整分页，并按原有格式写入：

- `.attendance-data/attendance-messages.json`：标准化的假勤消息
- `.attendance-data/attendance-report.json`：周期汇总与每日明细
- `.attendance-data/attendance-report.html`：可直接浏览、打印和导出 CSV 的单文件报告

同时会读取当前用户已发起且已通过的 `我要补签`、`休假申请流程`、`我的出差`
实例。`我的出差` 摘要中的起止日期会展开为包含首尾的逐日记录；工作日按 8 小时
计入工时，周末和法定节假日不进入平均值分母。对于三方业务接口，采集器严格限定可访问
域名、路径和重定向目标，并只提取以下白名单字段：

- `我要补签`：补签卡日期、实际补签卡时间、上班卡/下班卡类型
- `休假申请流程`：开始日期及 AM/PM、结束日期及 AM/PM

同一天 AM–AM 记上午半天、PM–PM 记下午半天、AM–PM 记全天；跨日休假会正确拆分
首尾半天及中间全天。三方审批原始表单、审批 ID、人员、事由、附件、链接及页面登录
凭据均不会写入本地文件。

如果名称匹配到多个会话，采集器会停止并要求明确指定，不会猜测：

```bash
./attendance --chat-id oc_xxx
```

`chat_id` 只用于当前 API 请求，不会写入输出。也可以限制拉取时间范围：

```bash
./attendance \
  --start 2026-06-01T00:00:00+08:00 \
  --end 2026-08-01T00:00:00+08:00
```

省略起止时间时会读取完整可访问历史。使用 `--max-pages` 可以限制请求页数，但生成的
报告可能不完整，输出元数据中的 `pagination_truncated` 会标记这种情况。

在自动化或无图形界面的环境中，只生成报告而不打开浏览器：

```bash
./attendance --no-open
```

如果只想更新原始消息文件，可使用 `--collect-only`。
如果暂时不读取审批摘要，可使用 `--no-approvals`；报告将只使用假勤消息和本地补充。
如果不需要补签/休假详情，可以用 `--no-approval-details` 只读取审批摘要。
`--use-approval-browser` 仅用于显式启用可见 Chrome 兼容模式；通常无需使用。此时可通过
`--approval-cdp http://127.0.0.1:端口` 指定另一个本机端口，或使用
`--no-auto-approval-chrome` 要求复用已经运行的专用 Chrome。

### 2. 直接在网页核对

打开报告后，可以通过“开始核对”、右侧“重点日期”，或每日明细最后一列的“核对”
按钮直接处理。核对窗口会同时展示当天打卡、当前结论和用于解析的假勤消息依据：

- 原记录无误：只标记为已核对，不改变考勤结果
- 补卡或更正时间：覆盖当天对应一侧打卡并重新计算异常、工时和加班
- 全天/半天请假、出差、外出或外勤：按油猴脚本的相同规则重新计算
- 其他说明：保留核对备注，但不自动消除机器人异常

“需要核对”提示、按钮和“待处理”筛选使用同一组未核对日期；没有待处理记录时，
提示会隐藏并显示明确的空状态，不会跳入 0 条结果。报告标题会使用当前
`lark-cli` 登录用户的显示姓名；无法取得姓名时回退为“我的考勤报告”。

报告顶部可以直接切换统计周期，不需要重新运行采集命令：

- “全部”按当前 HTML 内全部可用数据的最早和最晚日期统计
- “考勤周期”列出当前 HTML 中从封账消息识别出的全部历史周期
- “自然月”可以选择任意历史月份
- “固定起始日”按归属月份和每月 1–28 日的起始日生成跨月周期
- “自定义”可以直接填写任意开始日期与结束日期

选择周期或日期后会立即用报告内保存的全部已解析消息和油猴脚本同一套计算核心重算，
不需要再点击确认按钮。若所选
周期早于本地消息覆盖范围，页面会明确提示该段历史可能不完整。

核对结果按考勤日期保存在当前浏览器本地，同一天的补卡、请假和核对状态会在所有
重叠周期中共享。旧版按周期保存的本地记录会自动合并迁移，原缓存不会被删除。
再次打开或重新生成报告时会继续生效，不会上传到服务器。点击“导出补充 JSON”
可以备份会影响考勤计算的补充项，也可以
在命令行中复用：

```bash
./attendance \
  --manual ~/Downloads/考勤补充_2026-06-25_2026-07-24.json
```

网页中的“原记录无误”标记只用于个人核对进度，不会伪装成考勤补充写入导出文件。

### 3. 周期和本地补充

周期参数可以直接传给同一条 Python 命令：

```bash
# 强制本自然月
./attendance --period natural

# 使用消息中最新的封账周期
./attendance --period detected

# 自定义周期
./attendance \
  --period custom \
  --period-start 2026-06-25 \
  --period-end 2026-07-24
```

可以通过 `--config config.json` 覆盖班次、节假日等设置，通过
`--manual manual.json` 载入本地补充数组。两类文件都不要提交到公共仓库。

默认配置已按[国务院办公厅 2026 年部分节假日安排](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)
内置中国大陆 33 个放假日和 6 个调休上班日。油猴脚本升级后会将这些日期与已有
设置合并一次；“法定节假日”和“调休上班日”字段仍可编辑，调休上班日优先。
运行时不会联网查询节假日。

## 回退：Chrome/SQLite 本地采集

无法使用 `lark-cli` 时，可以使用旧版 Chrome/SQLite 采集器。它不解析页面 DOM，也不复制 Cookie 或 Token；Chrome 自己保管登录态，采集器通过本机 CDP 进入同源上下文，读取飞书 Rust/WASM IM 引擎写入 IndexedDB 的 SQLite 快照，再复用油猴脚本的同一套考勤解析规则生成报告。

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
python3 collector/render_attendance_report.py
```

输出文件：

- `.attendance-data/attendance-messages.json`：标准化的假勤消息
- `.attendance-data/attendance-report.json`：周期汇总与每日明细
- `.attendance-data/attendance-report.html`：可直接浏览的单文件报告

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
python3 collector/render_attendance_report.py
```

这不会打开可见的飞书窗口。若只需要上次已同步的数据，省略 `--refresh-seconds`，通常数秒即可完成。

### Chrome 模式的周期参数

默认行为和周期参数与前面的 `lark-cli` 模式相同。

### 采集器边界

- 本地数据库必须至少同步过一次；需要最新记录时使用 headless 刷新模式。
- 飞书内部 SQLite 结构不是公开 API，飞书升级后可能需要同步更新采集器。
- CDP 端口等同于控制已登录浏览器，必须只绑定 `127.0.0.1`，不要暴露到局域网或公网。
- 采集器不会调用 `context.cookies()`，不会输出 Cookie、Authorization、Token、聊天 ID 或数据库 ID。

## 考勤周期

| 周期 | 说明 |
| --- | --- |
| 本自然月 | 当月 1 日至当月最后一天 |
| 考勤周期 | 从“考勤申请截止时间提醒”中提取封账起止日期 |
| 自定义周期 | 手动指定开始日期与结束日期 |

当识别到覆盖当前月份的封账周期时，默认使用考勤周期；否则默认使用本自然月。也可以设置“每月周期起始日”，快速生成固定跨月周期。

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
- 每日加班 K 线与趋势图（默认 K 线）

平均值统一使用以下口径，最终四舍五入到分钟：

- 普通休息日和法定节假日即使存在打卡，也只保留每日明细，不计入“有记录”、
  应出勤、工时、加班或任何平均值。
- `平均加班 = 加班总时长 ÷ 全部完整出勤日`。完整出勤日必须有完整上下班卡，
  加班为 0 的日期同样进入分母；全天请假、法定节假日、缺卡和休息日不进入该分母。
- 全天请假和工作日出差固定按 8 小时计入工时，不计加班，也不计作完整出勤日。
- `平均工时 =（完整出勤有效工时 + 全天请假/工作日出差 × 8 小时）÷
  （完整出勤日 + 全天请假日 + 工作日出差日）`。周末出差、普通休息日和法定节假日
  不参与平均工时计算。

独立 HTML 报告和油猴界面都在每日明细之后、页面最下方提供“计算规则”区。

每根 K 线比较两个真实数据：开盘值是前一个有效出勤日的加班时长，收盘值是当日加班时长。绿色空心 K 线与 `▲` 表示增加，红色实心 K 线与 `▼` 表示减少，灰色横线表示持平。首个有效日以自身作为基线；缺少完整上下班卡的日期显示为空缺，并跳过该日期继续寻找上一个有效日，不推测任何打卡时间。

K 线横轴只排列具有完整上下班卡的有效数据，采用紧凑柱距并连接前一根收盘与下一根开盘；连续日期使用实线，跨缺卡日期使用虚线，在保持连续关系的同时明确标出数据缺口。趋势图仍保留完整日期轴。

点击图表右上角的“K 线 / 趋势图”可即时切换。趋势图按日期连接当日加班时长，遇到缺少完整上下班卡的日期会断开；切换只在当前页面会话中保持，重新加载脚本时仍默认显示 K 线。

独立 HTML 报告会在两种图表上叠加橙色“累计平均加班”曲线：每个点表示截至
当天的加班总时长除以截至当天的全部完整出勤日，因此 0 加班日也会影响曲线，
最后一个点与周期概览中的“平均加班”一致。

## 本地补充

每日明细支持以下补充类型：

- 法定节假日
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
- `lark-cli` 采集器不保存令牌、会话 ID、消息 ID、审批 ID、审批原始表单或消息中的
  链接；最终权限为 `0600` 的私有报告只额外保存当前登录用户的显示姓名。
- 审批详情读取只连接 `127.0.0.1` 的专用 Chrome，只访问允许的飞书 People/公司 OA
  详情路径；允许域名的 Cookie 只在内存中临时读取和使用，不打印或持久化，也不读取
  或导出人员、事由与附件。
- 独立 HTML 中的核对结果只保存在浏览器本地，可按需导出补充 JSON。
- 本地采集器只复用 Chrome 登录态，不导出 Cookie、Authorization 或 Token。
- “清空数据”会清除解析记录与缓存，手工补充可在对应日期中单独删除。
- 所有汇总均由浏览器本地完成。

## 数据口径

- 封账提醒只用于识别考勤周期，不作为每日打卡记录。
- 只有时间而没有日期的消息，优先从飞书消息 ID 解析发送日期；无法确定日期时不自动归档。
- `No record notification` 按正文中明确写出的考勤日期归档。
- 只有单侧打卡且消息未明确报告缺卡时，标记为待核对。
- 没有消息的工作日默认标记为待核对，也可以在设置中改为缺卡。
- 普通休息日或法定节假日的打卡只用于明细核对，不进入任何出勤汇总。
- 统计结果用于个人核对，最终考勤结果以飞书假勤应用或管理员报表为准。

## 本地验证

JavaScript 解析测试无需安装项目依赖：

```bash
node --check feishu-attendance.user.js
node tests/parser.test.js
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 -m py_compile \
  collector/attendance_common.py \
  collector/lark_cli_attendance_collector.py \
  collector/feishu_attendance_collector.py \
  collector/render_attendance_report.py
node --check collector/summarize_attendance.js
node --check collector/attendance_report.js
```

UI 回归测试需要 Python Playwright 和本机 Chrome：

```bash
python3 tests/ui-debug.py
python3 tests/report-ui-debug.py
```

油猴 UI 测试覆盖响应式布局、键盘操作、跨会话缓存、自动定位、本地补充、
封账周期、中英文消息解析，以及加班 K 线与趋势图切换。独立报告测试覆盖
四档响应式宽度、筛选、搜索、排序、深浅色主题、逐日核对、同规则重新计算、
刷新后持久化、补充 JSON 导出，以及无外部网络请求。
