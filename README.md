# 飞书假勤考勤助手

从飞书【假勤】消息生成个人考勤报告，并自动补充已通过的补签、休假和出差审批。
所有数据都在本机处理。

## 快速开始

需要 Python 3.11+、Node.js 18+、已安装并登录的 `lark-cli`。审批网页登录失效时，
还需要系统 Chrome 和 Python Playwright。

```bash
git clone https://github.com/fuhailong1998/feishu-attendance-assistant.git
cd feishu-attendance-assistant
python3 -m pip install -r requirements-collector.txt
lark-cli auth login
./attendance
```

如果缺少审批只读权限，程序会给出唯一需要执行的授权命令：

```bash
lark-cli auth login --scope "approval:instance:read"
```

授权后重新运行 `./attendance`。不需要考勤 API 权限：上下班打卡始终来自【假勤】
消息。

## 能做什么

- 自动查找并分页读取【假勤】会话
- 解析打卡、迟到、早退、缺卡和封账周期
- 补充【我要补签】【休假申请流程】【我的出差】中已通过的记录
- 区分全天、上午半天和下午半天请假
- 内置中国大陆 2026 年法定节假日和调休上班日
- 单独统计周末/法定节假日完整打卡的加班天数
- 生成以当前用户真实姓名命名的独立 HTML 报告
- 支持周期切换、每日核对、搜索、CSV/JSON 导出和加班图表

生成过程显示 `[进度 1/8]` 到 `[进度 8/8]`。审批网页登录过期时，同一条命令会在
终端显示二维码；扫码后自动继续，无需改用其他命令或常驻 Chrome。

## 输出

文件都写入 `.attendance-data/`：

| 文件 | 内容 |
| --- | --- |
| `attendance-messages.json` | 标准化假勤消息 |
| `attendance-report.json` | 周期汇总与每日明细 |
| `attendance-report.html` | 可直接打开的单文件报告 |

报告默认自动打开；服务器、CDN 和联网资源都不是必需的。没有待处理记录时，不显示
“需要核对”入口；有待处理记录时，入口数量与“待处理”筛选结果一致。每日明细的
“来源”消息数量可点击查看当天原始识别依据。

网页核对结果保存在浏览器本地。会影响计算的补充项可导出为 JSON，并通过
`--manual` 在下次生成时复用。

## 计算口径

- 默认弹性上班窗口为 08:30–09:30，下班窗口为 18:00–19:00，午休
  12:00–13:30 不计工时。
- 同一天取最早上班卡和最晚下班卡；次日 00:00–05:59 的下班卡归前一考勤日。
- 普通休息日和法定节假日不计应出勤、工时或平均值；上下班卡完整时单独计 1 个
  周末/节假日加班日，不计算加班时长。
- 平均加班 = 加班总时长 ÷ 全部完整出勤日；0 加班日也进入分母。
- 全天请假不进入平均工时的分子或分母；工作日出差按 8 小时计入，周末出差不计入。
- 半天假默认纳入平均工时，按“4 小时请假额度 + 实际半天有效工时”计算；可在逐日
  补充/核对时取消勾选。
- 出差起止日期及中间日期都会补入报告。

法定节假日数据来自[国务院办公厅 2026 年部分节假日安排](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)，
运行时不会联网查询。详细公式也显示在报告最下方的“计算规则”中。

## 常用选项

```bash
# 只生成，不打开浏览器
./attendance --no-open

# 不读取审批
./attendance --no-approvals

# 只读取审批摘要，不访问补签/休假详情
./attendance --no-approval-details

# 自定义周期
./attendance \
  --period custom \
  --period-start 2026-06-25 \
  --period-end 2026-07-24

# 复用网页导出的补充
./attendance --manual 考勤补充.json
```

完整参数见：

```bash
./attendance --help
```

## 登录状态

`lark-cli` 用户令牌与审批网页 Profile 相互独立。

只清除审批网页登录、保留 `lark-cli` 登录：

```bash
gio trash -- .attendance-data/approval-chrome-profile
```

只清除 `lark-cli` 登录：

```bash
lark-cli auth logout
```

删除审批 Profile 不会删除报告或考勤数据；下次运行时会重新创建，并在需要时显示
二维码。

## Tampermonkey 模式

不使用命令行时，可安装
[`feishu-attendance.user.js`](https://raw.githubusercontent.com/fuhailong1998/feishu-attendance-assistant/main/feishu-attendance.user.js)：

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开上面的脚本链接并确认安装。
3. 进入飞书 Messenger，点击右下角“考勤汇总”。

旧版 Chrome/SQLite 采集器仍保留在 `collector/feishu_attendance_collector.py`。

## 隐私

- `.attendance-data/` 已被 Git 忽略；目录和文件尽量使用 `0700` / `0600` 权限。
- 不保存令牌、会话 ID、消息 ID、审批 ID 或审批原始表单。
- 允许域名的 Cookie 只在进程内存中临时使用，不打印、不写入报告。
- 最终私有报告只额外保存当前用户显示姓名，用于报告标题。
- 统计仅供个人核对，最终结果以飞书考勤后台为准。

## 开发验证

```bash
node --check feishu-attendance.user.js
node --check collector/summarize_attendance.js
node --check collector/attendance_report.js
node tests/parser.test.js
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

浏览器 UI 回归需要 Python Playwright 和本机 Chrome：

```bash
python3 tests/ui-debug.py
python3 tests/report-ui-debug.py
```
