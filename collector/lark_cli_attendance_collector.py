#!/usr/bin/env python3
"""Collect Feishu Attendance messages through an authenticated lark-cli user."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urljoin, urlparse
from urllib.request import urlopen

from attendance_common import (
    ATTENDANCE_TERMS,
    PUNCH_TERMS,
    TIME_ZONE,
    atomic_write_private,
    local_datetime,
)
from render_attendance_report import (
    ReportError,
    load_report,
    open_report,
    write_report_html,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / ".attendance-data" / "attendance-messages.json"
DEFAULT_REPORT_JSON = ROOT / ".attendance-data" / "attendance-report.json"
DEFAULT_REPORT_HTML = ROOT / ".attendance-data" / "attendance-report.html"
DEFAULT_APPROVAL_CDP = "http://127.0.0.1:9238"
DEFAULT_APPROVAL_PROFILE = ROOT / ".attendance-data" / "approval-chrome-profile"
APPROVAL_READ_SCOPE = "approval:instance:read"
APPROVAL_CHROME_START_TIMEOUT_SECONDS = 15
APPROVAL_LOGIN_TIMEOUT_SECONDS = 180
APPROVAL_HTTP_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
)
APPROVAL_COOKIE_HOST_SUFFIXES = (".feishu.cn", ".thundersoft.com")
APPROVAL_GENERIC_FEISHU_HOSTS = {
    "accounts.feishu.cn",
    "open.feishu.cn",
    "passport.feishu.cn",
    "people.feishu.cn",
    "www.feishu.cn",
}
APPROVAL_OA_HOSTS = {
    "larkapproval.thundersoft.com",
    "i.thundersoft.com",
}
APPROVAL_OA_FORM_PATH = "/spa/workflow/static4form/index.html"
APPROVAL_OA_PATCH_FIELD_ID = "66222"
APPROVAL_OA_PATCH_FIELD = "field66222"
APPROVAL_OA_COMMON_API_FIELDS = (
    "requestid",
    "workflowid",
    "nodeid",
    "formid",
    "isbill",
    "f_weaver_belongto_userid",
    "f_weaver_belongto_usertype",
    "authStr",
    "authSignatureStr",
    "signatureSecretKey",
    "signatureAttributesStr",
    "nodetype",
    "iscreate",
    "isfromtab",
    "isviewonly",
    "isaffirmance",
    "isshared",
    "iswfshare",
    "ismode",
    "modeid",
    "isagent",
    "beagenter",
    "toexcel",
    "creater",
    "needconfirm",
    "creatertype",
    "requestType",
    "isSelfAuth",
    "isprint",
    "wfmonitor",
    "isurger",
    "intervenorright",
    "isSubmitDirect",
    "selectNextFlow",
    "agentType",
    "agentorByAgentId",
    "layouttype",
    "freeNodeExtendNodeId",
    "apiResultCacheKey",
)
APPROVAL_OA_TOP_LEVEL_FIELDS = (
    "wfTestStr",
    "f_weaver_belongto_userid",
    "f_weaver_belongto_usertype",
)
CHROME_EXECUTABLE_CANDIDATES = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
)
SUMMARIZER = Path(__file__).resolve().with_name("summarize_attendance.js")
DEFAULT_CHAT_PATTERN = r"假勤|Attendance"
APPROVAL_FLOW_TYPES = {
    "我要补签": "patch",
    "休假申请流程": "leave",
    "我的出差": "travel",
}
APPROVAL_PAGE_SIZE = 100
APPROVAL_CLOCK_SPLIT_MINUTES = 14 * 60
APPROVAL_OVERNIGHT_CUTOFF_MINUTES = 6 * 60
PROGRESS_TOTAL_STEPS = 8
CHAT_ID_RE = re.compile(r"^oc_[A-Za-z0-9]+$")
CARD_OPEN_RE = re.compile(
    r"<card\b[^>]*\btitle=(['\"])(.*?)\1[^>]*>",
    re.IGNORECASE | re.DOTALL,
)
CARD_TAG_RE = re.compile(r"</?card\b[^>]*>", re.IGNORECASE)
MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\((?:<[^>]*>|[^)]*)\)")
RAW_URL_RE = re.compile(r"(?:https?|lark|feishu)://[^\s)>]+", re.IGNORECASE)
HTML_TAG_RE = re.compile(r"<[^>]+>")
MESSAGE_TYPE_CODES = {
    "text": 2,
    "post": 4,
    "interactive": 13,
}


class CollectorError(RuntimeError):
    """Raised for actionable lark-cli collector failures."""


@dataclass(frozen=True)
class PipelineResult:
    """Artifacts produced by the one-command collection pipeline."""

    payload: dict[str, Any]
    report: dict[str, Any] | None
    html_path: Path | None
    opened: bool


@dataclass(frozen=True)
class ApprovalCollection:
    """Privacy-safe approval adjustments and aggregate collection metadata."""

    enabled: bool
    adjustments: list[dict[str, Any]]
    pages: int = 0
    scanned_instances: int = 0
    matched_instances: int = 0
    approved_instances: int = 0
    unparsed_instances: int = 0
    detail_collection_status: str = "disabled"
    detail_instances_parsed: int = 0
    detail_collection_method: str = ""
    detail_collection_message: str = ""
    detail_login_refreshed: bool = False


@dataclass(frozen=True)
class ExternalApprovalCollection:
    """Privacy-safe results read from approved third-party business APIs."""

    status: str
    adjustments: list[dict[str, Any]]
    parsed_instances: int = 0
    method: str = ""
    message: str = ""


class ApprovalSessionError(RuntimeError):
    """An actionable failure while reusing the local approval web session."""

    def __init__(self, status: str, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class ApprovalChromeSession:
    """A reusable or collector-owned local Chrome debugging session."""

    endpoint: str
    process: subprocess.Popen[Any] | None = None

    @property
    def started(self) -> bool:
        return self.process is not None


@dataclass(frozen=True)
class ApprovalSessionRefresh:
    """Ephemeral browser login result; cookie values never leave memory."""

    status: str
    cookies: tuple[dict[str, Any], ...] = field(
        default_factory=tuple,
        repr=False,
    )


def show_progress(quiet: bool, step: int, message: str) -> None:
    if not quiet:
        print(
            f"[进度 {step}/{PROGRESS_TOTAL_STEPS}] {message}",
            flush=True,
        )


def show_progress_detail(quiet: bool, message: str) -> None:
    if not quiet:
        print(f"  └─ {message}", flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="读取飞书“假勤”私聊，生成考勤报告并在浏览器中打开。",
    )
    parser.add_argument("--cli", default="lark-cli", help="lark-cli 可执行文件（默认：lark-cli）")
    parser.add_argument(
        "--chat-id",
        default="",
        help="直接指定假勤会话 ID；省略时按会话名自动查找，ID 不会写入输出",
    )
    parser.add_argument(
        "--chat-pattern",
        default=DEFAULT_CHAT_PATTERN,
        help=f"自动查找会话名的正则表达式（默认：{DEFAULT_CHAT_PATTERN}）",
    )
    parser.add_argument("--start", default="", help="可选消息起始时间（ISO 8601）")
    parser.add_argument("--end", default="", help="可选消息结束时间（ISO 8601）")
    parser.add_argument("--page-size", type=int, default=50, help="每页消息数（默认：50，范围：1-50）")
    parser.add_argument(
        "--max-pages",
        type=int,
        default=0,
        help="最多读取页数；0 表示读取到最后一页（默认：0）",
    )
    parser.add_argument("--timeout", type=int, default=60, help="每次 lark-cli 调用超时秒数（默认：60）")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help=f"本地输出文件（默认：{DEFAULT_OUTPUT}）")
    parser.add_argument("--node", default="node", help="Node.js 可执行文件（默认：node）")
    parser.add_argument(
        "--report-json",
        type=Path,
        default=DEFAULT_REPORT_JSON,
        help=f"汇总 JSON 文件（默认：{DEFAULT_REPORT_JSON}）",
    )
    parser.add_argument(
        "--report-html",
        type=Path,
        default=DEFAULT_REPORT_HTML,
        help=f"可浏览 HTML 文件（默认：{DEFAULT_REPORT_HTML}）",
    )
    parser.add_argument(
        "--period",
        "--report-period",
        dest="report_period",
        choices=("auto", "natural", "detected", "custom"),
        default="auto",
        help="报告周期：auto、natural、detected 或 custom（默认：auto）",
    )
    parser.add_argument(
        "--period-start",
        "--report-start",
        dest="report_start",
        default="",
        help="自定义报告周期起始日期（YYYY-MM-DD）",
    )
    parser.add_argument(
        "--period-end",
        "--report-end",
        dest="report_end",
        default="",
        help="自定义报告周期结束日期（YYYY-MM-DD）",
    )
    parser.add_argument("--config", type=Path, default=None, help="可选班次配置 JSON")
    parser.add_argument("--manual", type=Path, default=None, help="可选本地补充 JSON")
    parser.add_argument(
        "--no-approvals",
        action="store_true",
        help="不读取“我要补签”“休假申请流程”“我的出差”审批记录",
    )
    parser.add_argument(
        "--approval-cdp",
        default=DEFAULT_APPROVAL_CDP,
        help=(
            "兼容模式读取三方审批详情的本机 Chrome CDP 地址"
            f"（默认：{DEFAULT_APPROVAL_CDP}）"
        ),
    )
    parser.add_argument(
        "--use-approval-browser",
        action="store_true",
        help=(
            "显式使用 Chrome 兼容模式读取审批详情；默认直接请求业务 API，"
            "网页登录过期时默认会在命令行显示二维码并自动恢复"
        ),
    )
    parser.add_argument(
        "--no-approval-details",
        action="store_true",
        help="只读取 lark-cli 审批摘要，不调用三方审批业务详情接口",
    )
    parser.add_argument(
        "--approval-profile",
        type=Path,
        default=DEFAULT_APPROVAL_PROFILE,
        help=f"审批专用 Chrome Profile（默认：{DEFAULT_APPROVAL_PROFILE}）",
    )
    parser.add_argument(
        "--approval-chrome",
        default="",
        help="Chrome/Chromium 可执行文件；省略时自动查找",
    )
    parser.add_argument(
        "--no-auto-approval-chrome",
        action="store_true",
        help=(
            "不自动启动审批专用 Chrome；兼容模式或二维码登录恢复时，"
            "要求 --approval-cdp 已经可连接"
        ),
    )
    parser.add_argument(
        "--approval-login-timeout",
        type=int,
        default=APPROVAL_LOGIN_TIMEOUT_SECONDS,
        help=(
            "审批二维码登录的最长等待秒数"
            f"（默认：{APPROVAL_LOGIN_TIMEOUT_SECONDS}）"
        ),
    )
    parser.add_argument("--now", default="", help="可选报告基准时间，主要用于复现或测试")
    parser.add_argument(
        "--collect-only",
        action="store_true",
        help="只采集消息，不生成或打开 HTML",
    )
    parser.add_argument("--no-open", action="store_true", help="生成 HTML 后不自动打开浏览器")
    parser.add_argument("--quiet", action="store_true", help="成功时不打印摘要")
    args = parser.parse_args()
    if not 1 <= args.page_size <= 50:
        parser.error("--page-size 必须在 1 到 50 之间")
    if args.max_pages < 0:
        parser.error("--max-pages 不能小于 0")
    if args.timeout <= 0:
        parser.error("--timeout 必须大于 0")
    if not 5 <= args.approval_login_timeout <= 600:
        parser.error("--approval-login-timeout 必须在 5 到 600 秒之间")
    if args.chat_id and not CHAT_ID_RE.fullmatch(args.chat_id):
        parser.error("--chat-id 格式无效")
    try:
        re.compile(args.chat_pattern, re.IGNORECASE)
    except re.error as error:
        parser.error(f"--chat-pattern 不是有效正则表达式：{error}")
    if args.report_period == "custom" and not (args.report_start and args.report_end):
        parser.error("--period custom 必须同时提供 --period-start 与 --period-end")
    return args


def invoke_lark_cli(cli: str, arguments: list[str], timeout: int) -> dict[str, Any]:
    command = [cli, *arguments]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError as error:
        raise CollectorError(f"找不到 lark-cli：{cli}") from error
    except subprocess.TimeoutExpired as error:
        raise CollectorError(f"lark-cli 调用超过 {timeout} 秒：{' '.join(arguments[:2])}") from error
    except OSError as error:
        raise CollectorError(f"无法启动 lark-cli：{error}") from error

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "未知错误").strip()
        if len(detail) > 600:
            detail = detail[:600] + "…"
        raise CollectorError(f"lark-cli 调用失败：{detail}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise CollectorError("lark-cli 没有返回有效 JSON。") from error
    if not isinstance(payload, dict):
        raise CollectorError("lark-cli 返回的 JSON 结构无效。")
    if payload.get("ok") is False:
        detail = payload.get("msg") or payload.get("message") or "请求未成功"
        raise CollectorError(f"lark-cli 请求失败：{detail}")
    return payload


def normalize_report_owner_name(value: Any) -> str:
    """Keep a short, single-line display name for the private local report."""
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()[:80].rstrip()


def assert_user_ready(cli: str, timeout: int) -> str:
    payload = invoke_lark_cli(cli, ["whoami", "--as", "user"], timeout)
    if not payload.get("available") or payload.get("tokenStatus") not in {
        "ready",
        "needs_refresh",
    }:
        raise CollectorError(
            "lark-cli 用户身份尚未登录或令牌不可用。\n"
            "请先执行：lark-cli auth login"
        )
    if payload.get("identity") != "user":
        raise CollectorError("lark-cli 当前无法使用用户身份。")
    on_behalf_of = payload.get("onBehalfOf")
    if not isinstance(on_behalf_of, dict):
        return ""
    return normalize_report_owner_name(on_behalf_of.get("userName"))


def assert_approval_scope(cli: str, timeout: int) -> None:
    """Fail before collection with one exact least-privilege authorization step."""
    command_hint = (
        f'lark-cli auth login --scope "{APPROVAL_READ_SCOPE}"'
    )
    try:
        payload = invoke_lark_cli(
            cli,
            [
                "auth",
                "check",
                "--scope",
                APPROVAL_READ_SCOPE,
                "--json",
            ],
            timeout,
        )
    except CollectorError as error:
        raise CollectorError(
            f"无法确认或尚未授予审批只读权限 {APPROVAL_READ_SCOPE}。\n"
            f"请执行：{command_hint}"
        ) from error
    granted = {
        str(scope)
        for scope in payload.get("granted") or []
        if isinstance(scope, str)
    }
    missing = {
        str(scope)
        for scope in payload.get("missing") or []
        if isinstance(scope, str)
    }
    if APPROVAL_READ_SCOPE not in granted or APPROVAL_READ_SCOPE in missing:
        raise CollectorError(
            f"缺少审批只读权限 {APPROVAL_READ_SCOPE}。\n"
            f"请执行：{command_hint}"
        )


def attendance_chat_matches(
    chats: list[dict[str, Any]],
    pattern: re.Pattern[str],
) -> list[dict[str, Any]]:
    return [
        chat
        for chat in chats
        if isinstance(chat, dict) and pattern.search(str(chat.get("name") or ""))
    ]


def find_attendance_chats(
    cli: str,
    chat_pattern: str,
    timeout: int,
) -> list[dict[str, Any]]:
    pattern = re.compile(chat_pattern, re.IGNORECASE)
    matches: list[dict[str, Any]] = []
    page_token = ""
    seen_tokens: set[str] = set()
    while True:
        arguments = [
            "im",
            "+chat-list",
            "--as",
            "user",
            "--types",
            "p2p",
            "--sort",
            "active_time",
            "--page-size",
            "100",
            "--format",
            "json",
        ]
        if page_token:
            arguments.extend(["--page-token", page_token])
        payload = invoke_lark_cli(cli, arguments, timeout)
        data = payload.get("data")
        if not isinstance(data, dict):
            raise CollectorError("lark-cli 会话列表缺少 data。")
        chats = data.get("chats")
        if not isinstance(chats, list):
            raise CollectorError("lark-cli 会话列表缺少 chats。")
        matches.extend(attendance_chat_matches(chats, pattern))
        if not data.get("has_more"):
            break
        next_token = str(data.get("page_token") or "")
        if not next_token or next_token in seen_tokens:
            raise CollectorError("lark-cli 会话列表分页标记无效。")
        seen_tokens.add(next_token)
        page_token = next_token
    return matches


def resolve_chat_id(args: argparse.Namespace) -> tuple[str, str]:
    if args.chat_id:
        return args.chat_id, "explicit"
    matches = find_attendance_chats(args.cli, args.chat_pattern, args.timeout)
    if not matches:
        raise CollectorError(
            f"没有找到名称匹配 /{args.chat_pattern}/i 的 P2P 会话；可用 --chat-id 明确指定。"
        )
    unique: dict[str, dict[str, Any]] = {}
    for chat in matches:
        chat_id = str(chat.get("chat_id") or "")
        if CHAT_ID_RE.fullmatch(chat_id):
            unique[chat_id] = chat
    if not unique:
        raise CollectorError("找到疑似假勤会话，但返回结果中没有有效 chat_id。")
    if len(unique) > 1:
        names = sorted({str(chat.get("name") or "未命名会话") for chat in unique.values()})
        raise CollectorError(
            f"找到多个匹配会话（{', '.join(names)}），请用 --chat-id 明确指定。"
        )
    return next(iter(unique)), "name_pattern"


def fetch_chat_messages(
    cli: str,
    chat_id: str,
    page_size: int,
    timeout: int,
    start: str = "",
    end: str = "",
    max_pages: int = 0,
) -> tuple[list[dict[str, Any]], int, bool]:
    messages: list[dict[str, Any]] = []
    seen_message_ids: set[str] = set()
    seen_tokens: set[str] = set()
    page_token = ""
    pages = 0
    truncated = False

    while True:
        arguments = [
            "im",
            "+chat-messages-list",
            "--as",
            "user",
            "--chat-id",
            chat_id,
            "--order",
            "desc",
            "--page-size",
            str(page_size),
            "--no-reactions",
            "--format",
            "json",
        ]
        if start:
            arguments.extend(["--start", start])
        if end:
            arguments.extend(["--end", end])
        if page_token:
            arguments.extend(["--page-token", page_token])

        payload = invoke_lark_cli(cli, arguments, timeout)
        data = payload.get("data")
        if not isinstance(data, dict):
            raise CollectorError("lark-cli 消息列表缺少 data。")
        page_messages = data.get("messages")
        if not isinstance(page_messages, list):
            raise CollectorError("lark-cli 消息列表缺少 messages。")
        pages += 1
        for message in page_messages:
            if not isinstance(message, dict):
                continue
            message_id = str(message.get("message_id") or "")
            dedupe_key = message_id or hashlib.sha256(
                json.dumps(message, ensure_ascii=False, sort_keys=True).encode("utf-8")
            ).hexdigest()
            if dedupe_key in seen_message_ids:
                continue
            seen_message_ids.add(dedupe_key)
            messages.append(message)

        has_more = bool(data.get("has_more"))
        if not has_more:
            break
        if max_pages and pages >= max_pages:
            truncated = True
            break
        next_token = str(data.get("page_token") or "")
        if not next_token or next_token in seen_tokens:
            raise CollectorError("lark-cli 消息列表分页标记无效。")
        seen_tokens.add(next_token)
        page_token = next_token

    return messages, pages, truncated


def sanitize_content(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False)
    text = html.unescape(value)
    text = CARD_OPEN_RE.sub(lambda match: f"{html.unescape(match.group(2)).strip()}\n", text)
    text = CARD_TAG_RE.sub("\n", text)
    text = MARKDOWN_LINK_RE.sub(lambda match: match.group(1), text)
    text = RAW_URL_RE.sub("", text)
    text = HTML_TAG_RE.sub(" ", text)
    text = text.replace("\\n", "\n")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def parse_cli_datetime(value: Any) -> datetime:
    text = str(value or "").strip()
    if not text:
        raise CollectorError("lark-cli 消息缺少 create_time。")
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        try:
            return local_datetime(float(text))
        except (OverflowError, OSError, ValueError) as error:
            raise CollectorError(f"无法解析 lark-cli 消息时间：{text}") from error
    for format_string in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, format_string).replace(tzinfo=TIME_ZONE)
        except ValueError:
            pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise CollectorError(f"无法解析 lark-cli 消息时间：{text}") from error
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=TIME_ZONE)
    return parsed.astimezone(TIME_ZONE)


def numeric_position(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0


def normalize_messages(raw_messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[tuple[datetime, dict[str, Any]]] = []
    for message in raw_messages:
        if message.get("deleted"):
            continue
        text = sanitize_content(message.get("content"))
        folded = text.casefold()
        if not text or not any(term.casefold() in folded for term in ATTENDANCE_TERMS):
            continue
        sent_at = parse_cli_datetime(message.get("create_time"))
        message_id = str(message.get("message_id") or "")
        digest_source = f"{message_id}\0{sent_at.isoformat()}\0{text}".encode("utf-8")
        message_type_name = str(message.get("msg_type") or "").casefold()
        item = {
            "key": hashlib.sha256(digest_source).hexdigest()[:24],
            "date": sent_at.strftime("%Y-%m-%d"),
            "time": sent_at.strftime("%H:%M"),
            "sent_at": sent_at.isoformat(),
            "message_type": MESSAGE_TYPE_CODES.get(message_type_name, 0),
            "text": text,
            "position": numeric_position(message.get("message_position")),
            "updated_at": sent_at.isoformat(),
        }
        normalized.append((sent_at, item))
    normalized.sort(key=lambda pair: (pair[0], pair[1]["position"], pair[1]["key"]))
    return [item for _, item in normalized]


def normalize_approval_flow_name(value: Any) -> str:
    """Normalize decorative brackets and whitespace around an approval name."""
    return re.sub(r"[\s【】\[\]（）()]+", "", str(value or ""))


def approval_flow_type(value: Any) -> str:
    normalized = normalize_approval_flow_name(value)
    for name, flow_type in APPROVAL_FLOW_TYPES.items():
        if normalized == normalize_approval_flow_name(name):
            return flow_type
    return ""


def approval_response_data(payload: dict[str, Any], operation: str) -> dict[str, Any]:
    data = payload.get("data")
    if not isinstance(data, dict):
        raise CollectorError(f"lark-cli {operation} 缺少 data。")
    return data


def fetch_initiated_approval_instances(
    cli: str,
    timeout: int,
) -> tuple[list[dict[str, Any]], int]:
    """Read every initiated approval instance visible to the current user."""
    instances: list[dict[str, Any]] = []
    seen_codes: set[str] = set()
    seen_tokens: set[str] = set()
    page_token = ""
    pages = 0
    while True:
        arguments = [
            "approval",
            "instances",
            "initiated",
            "--as",
            "user",
            "--locale",
            "zh-CN",
            "--page-size",
            str(APPROVAL_PAGE_SIZE),
            "--format",
            "json",
        ]
        if page_token:
            arguments.extend(["--page-token", page_token])
        payload = invoke_lark_cli(cli, arguments, timeout)
        data = approval_response_data(payload, "审批实例列表")
        page_instances = data.get("instances")
        if not isinstance(page_instances, list):
            raise CollectorError("lark-cli 审批实例列表缺少 instances。")
        pages += 1
        for instance in page_instances:
            if not isinstance(instance, dict):
                continue
            instance_code = str(instance.get("instance_code") or "")
            if not instance_code or instance_code in seen_codes:
                continue
            seen_codes.add(instance_code)
            instances.append(instance)
        if not data.get("has_more"):
            break
        next_token = str(data.get("page_token") or "")
        if not next_token or next_token in seen_tokens:
            raise CollectorError("lark-cli 审批实例列表分页标记无效。")
        seen_tokens.add(next_token)
        page_token = next_token
    return instances, pages


def fetch_approval_instance_detail(
    cli: str,
    instance_code: str,
    timeout: int,
) -> dict[str, Any]:
    payload = invoke_lark_cli(
        cli,
        [
            "approval",
            "instances",
            "get",
            "--as",
            "user",
            "--locale",
            "zh-CN",
            "--instance-code",
            instance_code,
            "--format",
            "json",
        ],
        timeout,
    )
    return approval_response_data(payload, "审批实例详情")


def decode_approval_form(value: Any) -> Any:
    decoded = value
    for _ in range(2):
        if not isinstance(decoded, str):
            break
        text = decoded.strip()
        if not text:
            return []
        try:
            decoded = json.loads(text)
        except json.JSONDecodeError:
            return []
    return decoded if isinstance(decoded, (list, dict)) else []


def flatten_approval_controls(value: Any) -> list[dict[str, Any]]:
    controls: list[dict[str, Any]] = []

    def visit(item: Any) -> None:
        if isinstance(item, list):
            for child in item:
                visit(child)
            return
        if not isinstance(item, dict):
            return
        if "value" in item and any(
            key in item for key in ("id", "custom_id", "name", "type")
        ):
            controls.append(item)
            visit(item.get("value"))
            return
        for child in item.values():
            visit(child)

    visit(value)
    return controls


def summary_controls(instance: dict[str, Any]) -> list[dict[str, Any]]:
    controls: list[dict[str, Any]] = []
    for summary in instance.get("summaries") or []:
        if not isinstance(summary, dict):
            continue
        key = str(summary.get("key") or "")
        controls.append(
            {
                "id": key,
                "name": key,
                "type": "summary",
                "value": summary.get("value"),
            }
        )
    return controls


def approval_control_label(control: dict[str, Any]) -> str:
    return " ".join(
        str(control.get(key) or "")
        for key in ("id", "custom_id", "name", "type")
    )


def scalar_approval_value(value: Any) -> str:
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    return ""


def parse_approval_datetime(value: Any) -> datetime | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)) or re.fullmatch(
        r"\d+(?:\.\d+)?", str(value).strip()
    ):
        try:
            parsed = local_datetime(float(value))
        except (OverflowError, OSError, ValueError):
            return None
        return parsed if 2015 <= parsed.year <= 2100 else None

    text = str(value).strip()
    if not text:
        return None
    normalized = (
        text.replace("年", "-")
        .replace("月", "-")
        .replace("日", " ")
        .replace("/", "-")
        .replace(".", "-")
        .replace("：", ":")
        .strip()
    )
    normalized = re.sub(r"\s+", " ", normalized)
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        parsed = None
        for format_string in (
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d %H:%M",
            "%Y-%m-%d",
        ):
            try:
                parsed = datetime.strptime(normalized, format_string)
                break
            except ValueError:
                pass
    if parsed is None or not 2015 <= parsed.year <= 2100:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=TIME_ZONE)
    return parsed.astimezone(TIME_ZONE)


APPROVAL_DATETIME_RE = re.compile(
    r"20\d{2}(?:[-/.年])\d{1,2}(?:[-/.月])\d{1,2}日?"
    r"(?:(?:T|\s+)\d{1,2}[:：]\d{2}(?::\d{2})?"
    r"(?:Z|[+-]\d{2}:?\d{2})?)?"
)


def approval_datetimes(value: Any) -> list[datetime]:
    values: list[datetime] = []
    if isinstance(value, dict):
        for child in value.values():
            values.extend(approval_datetimes(child))
    elif isinstance(value, list):
        for child in value:
            values.extend(approval_datetimes(child))
    else:
        direct = parse_approval_datetime(value)
        if direct is not None:
            values.append(direct)
        elif isinstance(value, str):
            for match in APPROVAL_DATETIME_RE.finditer(value):
                parsed = parse_approval_datetime(match.group(0))
                if parsed is not None:
                    values.append(parsed)
    unique: dict[str, datetime] = {}
    for parsed in values:
        unique[parsed.isoformat()] = parsed
    return list(unique.values())


def approval_context_text(controls: list[dict[str, Any]]) -> str:
    return " ".join(
        part
        for control in controls
        for part in (
            approval_control_label(control),
            scalar_approval_value(control.get("value")),
        )
        if part
    )


def control_datetimes(
    controls: list[dict[str, Any]],
    label_pattern: re.Pattern[str],
) -> list[datetime]:
    values: list[datetime] = []
    for control in controls:
        if label_pattern.search(approval_control_label(control)):
            values.extend(approval_datetimes(control.get("value")))
    return values


START_FIELD_RE = re.compile(
    r"(?:start|begin|from|开始|起始|出发|启程|去程)",
    re.IGNORECASE,
)
END_FIELD_RE = re.compile(
    r"(?:end|finish|to|结束|截止|返回|返程|归程)",
    re.IGNORECASE,
)
PATCH_TIME_FIELD_RE = re.compile(
    r"(?:remedy.*time|punch.*time|补签卡时间|补卡时间|打卡时间|补签时间)",
    re.IGNORECASE,
)
PATCH_TYPE_FIELD_RE = re.compile(
    r"(?:remedy.*type|punch.*type|补签卡类型|补卡类型|打卡类型)",
    re.IGNORECASE,
)
PATCH_DATE_FIELD_RE = re.compile(
    r"(?:remedy.*date|punch.*date|补签日期|补卡日期|打卡日期)",
    re.IGNORECASE,
)
LABELED_START_RE = re.compile(
    r"(?:开始日期|开始时间|起始日期|起始时间|出发日期|出发时间|start(?:\s*(?:date|time))?)"
    r"\s*[:：]?\s*"
    r"(20\d{2}(?:[-/.年])\d{1,2}(?:[-/.月])\d{1,2}日?"
    r"(?:(?:T|\s+)\d{1,2}[:：]\d{2}(?::\d{2})?"
    r"(?:Z|[+-]\d{2}:?\d{2})?)?)",
    re.IGNORECASE,
)
LABELED_END_RE = re.compile(
    r"(?:结束日期|结束时间|截止日期|截止时间|返回日期|返回时间|返程日期|返程时间|"
    r"end(?:\s*(?:date|time))?)"
    r"\s*[:：]?\s*"
    r"(20\d{2}(?:[-/.年])\d{1,2}(?:[-/.月])\d{1,2}日?"
    r"(?:(?:T|\s+)\d{1,2}[:：]\d{2}(?::\d{2})?"
    r"(?:Z|[+-]\d{2}:?\d{2})?)?)",
    re.IGNORECASE,
)


def approval_time_range(
    controls: list[dict[str, Any]],
) -> tuple[datetime | None, datetime | None]:
    for control in controls:
        text = scalar_approval_value(control.get("value"))
        start_match = LABELED_START_RE.search(text)
        end_match = LABELED_END_RE.search(text)
        if not start_match or not end_match:
            continue
        start = parse_approval_datetime(start_match.group(1))
        end = parse_approval_datetime(end_match.group(1))
        if start is not None and end is not None:
            return start, end

    for control in controls:
        value = control.get("value")
        if not isinstance(value, dict):
            continue
        starts = approval_datetimes(
            value.get("start")
            or value.get("start_time")
            or value.get("startTime")
            or value.get("begin")
        )
        ends = approval_datetimes(
            value.get("end")
            or value.get("end_time")
            or value.get("endTime")
            or value.get("finish")
        )
        if starts and ends:
            return starts[0], ends[-1]

    starts = control_datetimes(controls, START_FIELD_RE)
    ends = control_datetimes(controls, END_FIELD_RE)
    if starts and ends:
        return starts[0], ends[-1]

    all_values: list[datetime] = []
    for control in controls:
        all_values.extend(approval_datetimes(control.get("value")))
    if not all_values:
        return None, None
    if len(all_values) == 1:
        return all_values[0], all_values[0]
    return all_values[0], all_values[-1]


def date_keys_between(start: datetime, end: datetime) -> list[str]:
    start_date = start.date()
    end_date = end.date()
    if end_date < start_date or (end_date - start_date).days > 370:
        return []
    values: list[str] = []
    cursor = start_date
    while cursor <= end_date:
        values.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return values


def patch_side(controls: list[dict[str, Any]], moment: datetime) -> str:
    for control in controls:
        if not PATCH_TYPE_FIELD_RE.search(approval_control_label(control)):
            continue
        text = scalar_approval_value(control.get("value"))
        if re.search(r"(?:下班|签退|clock\s*out)", text, re.IGNORECASE):
            return "out"
        if re.search(r"(?:上班|签到|clock\s*in)", text, re.IGNORECASE):
            return "in"
    for control in controls:
        if not PATCH_TIME_FIELD_RE.search(approval_control_label(control)):
            continue
        text = f"{approval_control_label(control)} {scalar_approval_value(control.get('value'))}"
        if re.search(r"(?:下班|签退|clock\s*out)", text, re.IGNORECASE):
            return "out"
        if re.search(r"(?:上班|签到|clock\s*in)", text, re.IGNORECASE):
            return "in"
    return (
        "in"
        if moment.hour * 60 + moment.minute < APPROVAL_CLOCK_SPLIT_MINUTES
        else "out"
    )


def parse_patch_approval(
    controls: list[dict[str, Any]],
    flow_name: str,
) -> list[dict[str, Any]]:
    moments = control_datetimes(controls, PATCH_TIME_FIELD_RE)
    if not moments:
        date_values = control_datetimes(controls, PATCH_DATE_FIELD_RE)
        for control in controls:
            if not PATCH_TIME_FIELD_RE.search(approval_control_label(control)):
                continue
            clock_match = re.fullmatch(
                r"\s*(\d{1,2})[:：](\d{2})(?::\d{2})?\s*",
                scalar_approval_value(control.get("value")),
            )
            if not clock_match or not date_values:
                continue
            hour = int(clock_match.group(1))
            minute = int(clock_match.group(2))
            if hour > 23 or minute > 59:
                continue
            moments.append(
                date_values[0].replace(
                    hour=hour,
                    minute=minute,
                    second=0,
                    microsecond=0,
                )
            )
    if not moments:
        return []
    moment = moments[0]
    side = patch_side(controls, moment)
    date = moment.date()
    next_day = (
        side == "out"
        and moment.hour * 60 + moment.minute < APPROVAL_OVERNIGHT_CUTOFF_MINUTES
    )
    if next_day:
        date -= timedelta(days=1)
    adjustment: dict[str, Any] = {
        "date": date.isoformat(),
        "type": "patch",
        "note": f"审批：{flow_name}",
    }
    if side == "in":
        adjustment["clockIn"] = moment.strftime("%H:%M")
    else:
        adjustment["clockOut"] = moment.strftime("%H:%M")
        if next_day:
            adjustment["clockOutNextDay"] = True
    return [adjustment]


def same_day_leave_type(
    start: datetime,
    end: datetime,
    context: str,
) -> str:
    if re.search(r"(?:全天|整天|full\s*day)", context, re.IGNORECASE):
        return "leave-full"
    if re.search(r"(?:上午|早半天|a\.?m\.?)", context, re.IGNORECASE):
        return "leave-am"
    if re.search(r"(?:下午|晚半天|p\.?m\.?)", context, re.IGNORECASE):
        return "leave-pm"
    duration_minutes = max(0, int((end - start).total_seconds() // 60))
    partial_hint = bool(
        re.search(
            r"(?:半天|0[.]5\s*天|4\s*(?:小时|hours?))",
            context,
            re.IGNORECASE,
        )
    )
    if partial_hint or 0 < duration_minutes <= 6 * 60:
        if end.hour < 12 or (end.hour == 12 and end.minute == 0):
            return "leave-am"
        return "leave-pm" if start.hour >= 12 else "leave-am"
    return "leave-full"


def parse_leave_approval(
    controls: list[dict[str, Any]],
    flow_name: str,
) -> list[dict[str, Any]]:
    start, end = approval_time_range(controls)
    if start is None or end is None or end < start:
        return []
    date_keys = date_keys_between(start, end)
    if not date_keys:
        return []
    context = approval_context_text(controls)
    if len(date_keys) == 1:
        leave_types = [same_day_leave_type(start, end, context)]
    else:
        leave_types = ["leave-full"] * len(date_keys)
        if start.hour >= 12:
            leave_types[0] = "leave-pm"
        end_minutes = end.hour * 60 + end.minute
        if 0 < end_minutes <= 12 * 60:
            leave_types[-1] = "leave-am"
    return [
        {
            "date": date_key,
            "type": leave_type,
            "note": f"审批：{flow_name}",
        }
        for date_key, leave_type in zip(date_keys, leave_types)
    ]


def parse_travel_approval(
    controls: list[dict[str, Any]],
    flow_name: str,
) -> list[dict[str, Any]]:
    start, end = approval_time_range(controls)
    if start is None or end is None or end < start:
        return []
    return [
        {
            "date": date_key,
            "type": "travel",
            "note": f"审批：{flow_name}",
        }
        for date_key in date_keys_between(start, end)
    ]


def parse_approval_adjustments(
    detail: dict[str, Any],
    instance: dict[str, Any],
) -> list[dict[str, Any]]:
    flow_name = str(
        detail.get("definition_name")
        or instance.get("definition_name")
        or ""
    )
    flow_type = approval_flow_type(flow_name)
    if not flow_type:
        return []
    controls = flatten_approval_controls(decode_approval_form(detail.get("form")))
    controls.extend(summary_controls(instance))
    if flow_type == "patch":
        return parse_patch_approval(controls, flow_name)
    if flow_type == "leave":
        return parse_leave_approval(controls, flow_name)
    return parse_travel_approval(controls, flow_name)


def parse_approval_date(value: Any) -> date | None:
    match = re.match(r"\s*(20\d{2}-\d{2}-\d{2})(?:\s|$)", str(value or ""))
    if not match:
        return None
    try:
        parsed = date.fromisoformat(match.group(1))
    except ValueError:
        return None
    return parsed if 2015 <= parsed.year <= 2100 else None


def patch_adjustment_from_detail(
    value: Any,
    flow_name: str,
) -> dict[str, Any] | None:
    """Parse one OA patch row while retaining only attendance-safe fields."""
    decoded = value
    if isinstance(decoded, str):
        try:
            decoded = json.loads(decoded)
        except json.JSONDecodeError:
            return None
    if not isinstance(decoded, dict):
        return None

    target_date = parse_approval_date(decoded.get("bqkrq"))
    moment = parse_approval_datetime(decoded.get("remedy_time"))
    work_type = str(decoded.get("work_type") or "").strip()
    if target_date is None or moment is None or work_type not in {"1", "2"}:
        return None
    date_delta = (moment.date() - target_date).days
    if date_delta < 0 or date_delta > 1:
        return None

    adjustment: dict[str, Any] = {
        "date": target_date.isoformat(),
        "type": "patch",
        "note": f"审批：{flow_name}",
    }
    if work_type == "1":
        adjustment["clockIn"] = moment.strftime("%H:%M")
    else:
        adjustment["clockOut"] = moment.strftime("%H:%M")
        if date_delta == 1:
            adjustment["clockOutNextDay"] = True
    return adjustment


def patch_adjustments_from_detail_values(
    values: list[Any],
    flow_name: str,
) -> list[dict[str, Any]]:
    adjustments: list[dict[str, Any]] = []
    seen: set[str] = set()
    for value in values:
        adjustment = patch_adjustment_from_detail(value, flow_name)
        if adjustment is None:
            continue
        key = json.dumps(adjustment, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        adjustments.append(adjustment)
    return adjustments


def normalize_leave_half(value: Any) -> str:
    text = re.sub(r"[\s.]+", "", str(value or "")).upper()
    if text in {"AM", "上午", "MORNING"}:
        return "AM"
    if text in {"PM", "下午", "AFTERNOON"}:
        return "PM"
    return ""


def leave_adjustments_from_halves(
    start_date_value: Any,
    start_half_value: Any,
    end_date_value: Any,
    end_half_value: Any,
    flow_name: str,
) -> list[dict[str, Any]]:
    start_date = parse_approval_date(start_date_value)
    end_date = parse_approval_date(end_date_value)
    start_half = normalize_leave_half(start_half_value)
    end_half = normalize_leave_half(end_half_value)
    if (
        start_date is None
        or end_date is None
        or not start_half
        or not end_half
        or end_date < start_date
        or (end_date - start_date).days > 370
    ):
        return []

    if start_date == end_date:
        same_day_types = {
            ("AM", "AM"): "leave-am",
            ("PM", "PM"): "leave-pm",
            ("AM", "PM"): "leave-full",
        }
        leave_type = same_day_types.get((start_half, end_half))
        if not leave_type:
            return []
        return [
            {
                "date": start_date.isoformat(),
                "type": leave_type,
                "note": f"审批：{flow_name}",
            }
        ]

    dates: list[date] = []
    cursor = start_date
    while cursor <= end_date:
        dates.append(cursor)
        cursor += timedelta(days=1)
    leave_types = ["leave-full"] * len(dates)
    if start_half == "PM":
        leave_types[0] = "leave-pm"
    if end_half == "AM":
        leave_types[-1] = "leave-am"
    return [
        {
            "date": day.isoformat(),
            "type": leave_type,
            "note": f"审批：{flow_name}",
        }
        for day, leave_type in zip(dates, leave_types)
    ]


LEAVE_PAGE_START_RE = re.compile(
    r"(?:Start\s*time|开始\s*(?:时间|日期))\s*[:：]?\s*"
    r"(20\d{2}-\d{2}-\d{2})\s*(AM|PM|上午|下午)",
    re.IGNORECASE,
)
LEAVE_PAGE_END_RE = re.compile(
    r"(?:End\s*time|结束\s*(?:时间|日期))\s*[:：]?\s*"
    r"(20\d{2}-\d{2}-\d{2})\s*(AM|PM|上午|下午)",
    re.IGNORECASE,
)


def leave_adjustments_from_page_text(
    text: Any,
    flow_name: str,
) -> list[dict[str, Any]]:
    normalized = str(text or "").replace("\u00a0", " ")
    start_match = LEAVE_PAGE_START_RE.search(normalized)
    end_match = LEAVE_PAGE_END_RE.search(normalized)
    if not start_match or not end_match:
        return []
    return leave_adjustments_from_halves(
        start_match.group(1),
        start_match.group(2),
        end_match.group(1),
        end_match.group(2),
        flow_name,
    )


def safe_https_url(value: Any) -> Any:
    try:
        parsed = urlparse(str(value or "").strip())
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.casefold() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
    ):
        return None
    return parsed


def patch_detail_url(value: Any) -> str:
    """Return a validated OA SSO/detail URL, never an arbitrary approval link."""

    def valid_target(candidate: str) -> str:
        parsed = safe_https_url(candidate)
        if (
            parsed is None
            or parsed.hostname.casefold() != "i.thundersoft.com"
            or parsed.path != "/spa/workflow/static4form/index.html"
            or not parsed.fragment.startswith("/main/workflow/req")
        ):
            return ""
        return candidate

    link = str(value or "").strip()
    direct = valid_target(link)
    if direct:
        return direct
    wrapper = safe_https_url(link)
    if (
        wrapper is None
        or wrapper.hostname.casefold() != "larkapproval.thundersoft.com"
        or wrapper.path.rstrip("/") != "/sso/login"
    ):
        return ""
    query = parse_qs(wrapper.query, keep_blank_values=False)
    candidates = [
        candidate
        for key, values in query.items()
        if key.casefold() in {"redirecturl", "redirect_url"}
        for candidate in values
    ]
    for candidate in candidates:
        for decoded in (candidate, unquote(candidate)):
            target = valid_target(decoded)
            if target:
                return link
    return ""


def leave_detail_url(value: Any) -> str:
    link = str(value or "").strip()
    parsed = safe_https_url(link)
    if parsed is None:
        return ""
    hostname = parsed.hostname.casefold()
    if (
        not (hostname == "people.feishu.cn" or hostname.endswith(".feishu.cn"))
        or "/approvals/" not in parsed.path.casefold()
    ):
        return ""
    return link


def external_approval_detail_url(instance: dict[str, Any]) -> str:
    flow_type = approval_flow_type(instance.get("definition_name"))
    if flow_type == "patch":
        return patch_detail_url(instance.get("link"))
    if flow_type == "leave":
        return leave_detail_url(instance.get("link"))
    return ""


def chrome_safe_storage_password() -> bytes:
    """Read Chrome's local encryption password without exposing it."""
    try:
        import dbus
    except ImportError as error:
        raise ApprovalSessionError(
            "unavailable",
            "当前 Python 缺少 dbus，无法读取本机 Chrome 安全存储。",
        ) from error

    session_path: Any = None
    bus: Any = None
    try:
        bus = dbus.SessionBus()
        service = dbus.Interface(
            bus.get_object(
                "org.freedesktop.secrets",
                "/org/freedesktop/secrets",
            ),
            "org.freedesktop.Secret.Service",
        )
        unlocked, locked = service.SearchItems({"application": "chrome"})
        if not unlocked and locked:
            newly_unlocked, prompt = service.Unlock(locked)
            if str(prompt) not in {"", "/"}:
                raise ApprovalSessionError(
                    "login_required",
                    "桌面密钥环已锁定。",
                )
            unlocked = newly_unlocked
        if not unlocked:
            raise ApprovalSessionError(
                "login_required",
                "桌面密钥环中没有 Chrome 安全存储。",
            )
        _, session_path = service.OpenSession(
            "plain",
            dbus.String("", variant_level=1),
        )
        item = dbus.Interface(
            bus.get_object("org.freedesktop.secrets", unlocked[0]),
            "org.freedesktop.Secret.Item",
        )
        secret = bytes(item.GetSecret(session_path)[2])
        if not secret:
            raise ApprovalSessionError(
                "login_required",
                "Chrome 安全存储为空。",
            )
        return secret
    except ApprovalSessionError:
        raise
    except Exception as error:
        raise ApprovalSessionError(
            "unavailable",
            "无法从桌面密钥环读取 Chrome 安全存储。",
        ) from error
    finally:
        if session_path and bus is not None:
            try:
                dbus.Interface(
                    bus.get_object("org.freedesktop.secrets", session_path),
                    "org.freedesktop.Secret.Session",
                ).Close()
            except Exception:
                pass


def decrypt_chrome_cookie(
    encrypted: bytes,
    host: str,
    database_version: int,
    safe_storage_password: bytes,
) -> str:
    """Decrypt one Linux Chrome cookie and verify its host binding."""
    if encrypted[:3] not in {b"v10", b"v11"}:
        return ""
    try:
        from cryptography.hazmat.primitives.ciphers import (
            Cipher,
            algorithms,
            modes,
        )
    except ImportError as error:
        raise ApprovalSessionError(
            "unavailable",
            "当前 Python 缺少 cryptography，无法读取审批网页登录态。",
        ) from error

    passwords = [safe_storage_password]
    if safe_storage_password != b"peanuts":
        passwords.append(b"peanuts")
    for password in passwords:
        key = hashlib.pbkdf2_hmac(
            "sha1",
            password,
            b"saltysalt",
            1,
            16,
        )
        encrypted_payload = encrypted[3:]
        if not encrypted_payload or len(encrypted_payload) % 16:
            continue
        decryptor = Cipher(
            algorithms.AES(key),
            modes.CBC(b" " * 16),
        ).decryptor()
        padded = decryptor.update(encrypted_payload) + decryptor.finalize()
        padding = padded[-1] if padded else 0
        if (
            not 1 <= padding <= 16
            or not padded.endswith(bytes([padding]) * padding)
        ):
            continue
        plaintext = padded[:-padding]
        if database_version >= 24:
            host_digest = hashlib.sha256(host.encode("utf-8")).digest()
            if not plaintext.startswith(host_digest):
                continue
            plaintext = plaintext[len(host_digest) :]
        try:
            return plaintext.decode("utf-8")
        except UnicodeDecodeError:
            continue
    return ""


def people_tenant_host_from_cookies(
    cookies: list[tuple[str, str]],
) -> str:
    """Choose a Feishu People tenant from valid, host-bound cookie metadata."""
    scores: dict[str, int] = {}
    for raw_host, raw_name in cookies:
        host = str(raw_host or "").casefold().lstrip(".")
        name = str(raw_name or "").casefold()
        if (
            not host.endswith(".feishu.cn")
            or host in APPROVAL_GENERIC_FEISHU_HOSTS
            or host.startswith("internal-api-")
        ):
            continue
        score = 1
        if name.startswith("x-tt-env-corehr-"):
            score += 100
        if name == "passport_app_access_token":
            score += 50
        scores[host] = scores.get(host, 0) + score
    if not scores:
        return ""
    return min(scores, key=lambda host: (-scores[host], host))


def allowed_approval_browser_cookies(
    cookies: list[dict[str, Any]],
) -> tuple[dict[str, Any], ...]:
    """Keep only request-cookie fields for the two approved domain families."""
    allowed: list[dict[str, Any]] = []
    for cookie in cookies:
        domain = str(cookie.get("domain") or "").casefold()
        name = str(cookie.get("name") or "")
        value = str(cookie.get("value") or "")
        if (
            not name
            or not value
            or any(character in name for character in "\r\n;")
            or not any(
                domain.endswith(suffix)
                for suffix in APPROVAL_COOKIE_HOST_SUFFIXES
            )
        ):
            continue
        raw_path = str(cookie.get("path") or "/")
        cookie_path = raw_path if raw_path.startswith("/") else "/"
        try:
            raw_expiry = float(cookie.get("expires") or 0)
        except (TypeError, ValueError):
            raw_expiry = 0
        allowed.append(
            {
                "domain": domain,
                "name": name,
                "value": value,
                "path": cookie_path,
                "secure": bool(cookie.get("secure")),
                "expires": int(raw_expiry) if raw_expiry > 0 else None,
            }
        )
    return tuple(allowed)


def approval_http_session(
    profile: Path,
    supplemental_cookies: tuple[dict[str, Any], ...] = (),
) -> tuple[Any, str]:
    """Build an in-memory HTTP session from the dedicated Chrome profile."""
    try:
        import requests
    except ImportError as error:
        raise ApprovalSessionError(
            "unavailable",
            "当前 Python 缺少 requests，无法直接请求审批业务接口。",
        ) from error

    cookie_database = profile.expanduser().resolve() / "Default" / "Cookies"
    if not cookie_database.is_file():
        raise ApprovalSessionError(
            "login_required",
            "审批专用 Chrome Profile 尚未建立网页登录态。",
        )
    safe_storage_password = chrome_safe_storage_password()
    try:
        connection = sqlite3.connect(
            f"file:{cookie_database}?mode=ro",
            uri=True,
        )
    except sqlite3.Error as error:
        raise ApprovalSessionError(
            "unavailable",
            "无法只读打开审批专用 Chrome Cookie 数据库。",
        ) from error

    try:
        version_row = connection.execute(
            "SELECT value FROM meta WHERE key = 'version'"
        ).fetchone()
        database_version = int(version_row[0]) if version_row else 0
        rows = connection.execute(
            """
            SELECT host_key, path, name, value, encrypted_value,
                   is_secure, expires_utc
              FROM cookies
             WHERE host_key LIKE '%.feishu.cn'
                OR host_key LIKE '%.thundersoft.com'
            """
        ).fetchall()
    except (sqlite3.Error, TypeError, ValueError) as error:
        raise ApprovalSessionError(
            "unavailable",
            "审批专用 Chrome Cookie 数据库结构不可用。",
        ) from error
    finally:
        connection.close()

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": APPROVAL_HTTP_USER_AGENT,
            "Accept": "application/json, text/plain, */*",
        }
    )
    loaded_cookie_keys: list[tuple[str, str]] = []
    csrf_token = ""
    loaded = 0
    now = time.time()
    for (
        host,
        cookie_path,
        name,
        plaintext,
        encrypted,
        secure,
        expires_utc,
    ) in rows:
        normalized_host = str(host or "").casefold()
        if not any(
            normalized_host.endswith(suffix)
            for suffix in APPROVAL_COOKIE_HOST_SUFFIXES
        ):
            continue
        try:
            chrome_expiry = int(expires_utc or 0)
        except (TypeError, ValueError):
            chrome_expiry = 0
        expires = (
            int(chrome_expiry / 1_000_000 - 11_644_473_600)
            if chrome_expiry
            else None
        )
        if expires is not None and expires <= now:
            continue
        value = str(plaintext or "")
        if not value and encrypted:
            value = decrypt_chrome_cookie(
                bytes(encrypted),
                str(host),
                database_version,
                safe_storage_password,
            )
        if not value:
            continue
        session.cookies.set(
            str(name),
            value,
            domain=str(host),
            path=str(cookie_path or "/"),
            secure=bool(secure),
            expires=expires,
        )
        loaded_cookie_keys.append((str(host), str(name)))
        loaded += 1
        if name == "swp_csrf_token":
            csrf_token = value

    for cookie in supplemental_cookies:
        domain = str(cookie.get("domain") or "").casefold()
        name = str(cookie.get("name") or "")
        value = str(cookie.get("value") or "")
        if (
            not name
            or not value
            or not any(
                domain.endswith(suffix)
                for suffix in APPROVAL_COOKIE_HOST_SUFFIXES
            )
        ):
            continue
        session.cookies.set(
            name,
            value,
            domain=domain,
            path=str(cookie.get("path") or "/"),
            secure=bool(cookie.get("secure")),
            expires=cookie.get("expires"),
        )
        loaded_cookie_keys.append((domain, name))
        loaded += 1
        if name == "swp_csrf_token":
            csrf_token = value

    if not loaded:
        session.close()
        raise ApprovalSessionError(
            "login_required",
            "审批专用 Chrome Profile 中没有可用网页登录态。",
        )
    if csrf_token:
        session.headers["x-csrf-token"] = csrf_token
    tenant_host = people_tenant_host_from_cookies(loaded_cookie_keys)
    return session, tenant_host


def approval_response_json(response: Any, operation: str) -> dict[str, Any]:
    """Validate a business API response without including sensitive payloads."""
    if response.status_code in {401, 403}:
        raise ApprovalSessionError(
            "login_required",
            f"{operation}的网页登录态已过期。",
        )
    if response.status_code != 200:
        raise ApprovalSessionError(
            "unavailable",
            f"{operation}返回 HTTP {response.status_code}。",
        )
    try:
        payload = response.json()
    except (TypeError, ValueError) as error:
        content_type = str(response.headers.get("content-type") or "").casefold()
        status = "login_required" if "html" in content_type else "unavailable"
        raise ApprovalSessionError(
            status,
            f"{operation}没有返回有效 JSON。",
        ) from error
    if not isinstance(payload, dict):
        raise ApprovalSessionError(
            "unavailable",
            f"{operation}返回结构无效。",
        )
    return payload


def patch_request_id(value: Any) -> str:
    """Extract only a numeric OA request ID from an allowlisted detail URL."""
    link = patch_detail_url(value)
    if not link:
        return ""
    parsed = urlparse(link)
    targets = [link]
    if parsed.hostname.casefold() == "larkapproval.thundersoft.com":
        targets = [
            candidate
            for key, values in parse_qs(parsed.query).items()
            if key.casefold() in {"redirecturl", "redirect_url"}
            for candidate in values
        ]
    for target in targets:
        for decoded in (target, unquote(target)):
            detail = urlparse(decoded)
            query = detail.fragment.split("?", 1)[1] if "?" in detail.fragment else ""
            request_id = (parse_qs(query).get("requestid") or [""])[0]
            if re.fullmatch(r"\d{1,30}", request_id):
                return request_id
    return ""


def open_oa_approval_form(
    session: Any,
    value: Any,
    timeout: int,
) -> Any:
    """Follow only the known OA hosts to establish a short-lived SSO session."""
    current = patch_detail_url(value)
    if not current:
        raise ApprovalSessionError(
            "unavailable",
            "补签审批跳转链接不在允许范围内。",
        )
    for _ in range(5):
        parsed = safe_https_url(current)
        if parsed is None:
            raise ApprovalSessionError(
                "unavailable",
                "补签审批重定向超出允许范围。",
            )
        hostname = parsed.hostname.casefold()
        if hostname not in APPROVAL_OA_HOSTS:
            if (
                hostname in {"open.feishu.cn", "accounts.feishu.cn"}
                and any(
                    marker in parsed.path.casefold()
                    for marker in ("/authen/", "/accounts/", "/passport/")
                )
            ):
                raise ApprovalSessionError(
                    "login_required",
                    "补签审批需要重新完成飞书网页登录。",
                )
            raise ApprovalSessionError(
                "unavailable",
                "补签审批重定向超出允许范围。",
            )
        try:
            response = session.get(
                current,
                allow_redirects=False,
                timeout=timeout,
                headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"},
            )
        except Exception as error:
            raise ApprovalSessionError(
                "unavailable",
                "补签审批 SSO 请求失败。",
            ) from error
        if response.status_code in {301, 302, 303, 307, 308}:
            location = str(response.headers.get("location") or "")
            if not location:
                raise ApprovalSessionError(
                    "unavailable",
                    "补签审批 SSO 缺少重定向地址。",
                )
            current = urljoin(current, location)
            continue
        final = safe_https_url(current)
        if response.status_code in {401, 403}:
            raise ApprovalSessionError(
                "login_required",
                "公司 OA 网页登录态已过期。",
            )
        if (
            response.status_code != 200
            or final is None
            or final.hostname.casefold() != "i.thundersoft.com"
            or final.path != APPROVAL_OA_FORM_PATH
        ):
            raise ApprovalSessionError(
                "login_required",
                "公司 OA 网页登录态不可用。",
            )
        response.url = current
        return response
    raise ApprovalSessionError(
        "unavailable",
        "补签审批 SSO 重定向次数过多。",
    )


def patch_values_from_oa_payload(
    payload: dict[str, Any],
    detail_marks: list[str],
) -> list[Any]:
    """Retain only the whitelisted OA patch field values."""
    values: list[Any] = []
    for detail_mark in detail_marks:
        detail = payload.get(detail_mark)
        if not isinstance(detail, dict):
            continue
        rows = detail.get("rowDatas")
        if not isinstance(rows, dict):
            continue
        for row in rows.values():
            if not isinstance(row, dict):
                continue
            field = row.get(APPROVAL_OA_PATCH_FIELD)
            if isinstance(field, dict):
                values.append(field.get("value"))
    return values


def patch_detail_marks_from_oa_form(
    payload: dict[str, Any],
) -> list[str]:
    table_info = payload.get("tableInfo")
    if not isinstance(table_info, dict):
        return []
    return [
        key
        for key, value in table_info.items()
        if (
            key.startswith("detail_")
            and isinstance(value, dict)
            and APPROVAL_OA_PATCH_FIELD_ID
            in (value.get("fieldinfomap") or {})
        )
    ]


def fetch_patch_adjustments_http(
    session: Any,
    instance: dict[str, Any],
    timeout: int,
) -> list[dict[str, Any]]:
    """Read patch rows from the OA business APIs without launching Chrome."""
    request_id = patch_request_id(instance.get("link"))
    if not request_id:
        return []
    form_response = open_oa_approval_form(
        session,
        instance.get("link"),
        timeout,
    )
    final_url = (
        urlparse(str(form_response.url or ""))
        ._replace(fragment="")
        .geturl()
    )
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://i.thundersoft.com",
        "Referer": final_url,
    }
    try:
        base_response = session.post(
            "https://i.thundersoft.com/api/workflow/reqform/loadForm",
            data={"requestid": request_id},
            headers=headers,
            timeout=timeout,
        )
    except Exception as error:
        raise ApprovalSessionError(
            "unavailable",
            "补签审批表单接口请求失败。",
        ) from error
    base = approval_response_json(base_response, "补签审批表单接口")
    params = base.get("params")
    if not isinstance(params, dict):
        return []
    detail_marks = patch_detail_marks_from_oa_form(base)
    if not detail_marks:
        return []
    common_params = {
        key: params[key]
        for key in APPROVAL_OA_COMMON_API_FIELDS
        if key in params
    }
    body: dict[str, Any] = {
        "requestid": params.get("requestid") or request_id,
        "detailmark": ",".join(detail_marks),
        "reqParams": json.dumps(
            common_params,
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    }
    for key in APPROVAL_OA_TOP_LEVEL_FIELDS:
        if key in params:
            body[key] = params[key]
    try:
        detail_response = session.post(
            "https://i.thundersoft.com/api/workflow/reqform/detailData",
            data=body,
            headers=headers,
            timeout=timeout,
        )
    except Exception as error:
        raise ApprovalSessionError(
            "unavailable",
            "补签审批明细接口请求失败。",
        ) from error
    detail = approval_response_json(detail_response, "补签审批明细接口")
    values = patch_values_from_oa_payload(detail, detail_marks)
    return patch_adjustments_from_detail_values(
        values,
        str(instance.get("definition_name") or "我要补签"),
    )


def people_leave_date(value: Any) -> date | None:
    """Decode a Feishu People date stored as Unix epoch days or ISO text."""
    text = str(value or "").strip()
    if re.fullmatch(r"\d{5}", text):
        try:
            parsed = date(1970, 1, 1) + timedelta(days=int(text))
        except (OverflowError, ValueError):
            return None
        return parsed if 2015 <= parsed.year <= 2100 else None
    return parse_approval_date(text)


def people_value_content(value: Any, value_type: str) -> Any:
    if not isinstance(value, dict):
        return None
    typed = value.get(value_type)
    if not isinstance(typed, dict):
        return None
    return typed.get("value")


def leave_adjustments_from_people_form(
    value: Any,
    flow_name: str,
) -> list[dict[str, Any]]:
    """Parse only People leave dates and AM/PM fields from a form instance."""
    decoded = value
    if isinstance(decoded, str):
        try:
            decoded = json.loads(decoded)
        except json.JSONDecodeError:
            return []
    if not isinstance(decoded, dict):
        return []
    for field in decoded.get("fields") or []:
        if not isinstance(field, dict):
            continue
        multi_values = field.get("multi_values")
        if not isinstance(multi_values, dict):
            continue
        leave_time = multi_values.get("leave_time")
        if not isinstance(leave_time, dict):
            continue
        record = leave_time.get("record_value")
        if not isinstance(record, dict):
            continue
        values: dict[str, dict[str, Any]] = {}
        for item in record.get("field_values") or []:
            if not isinstance(item, dict):
                continue
            field_name = str(item.get("field_name") or "")
            field_value = item.get("value")
            if field_name and isinstance(field_value, dict):
                values[field_name] = field_value
        start_date = people_leave_date(
            people_value_content(values.get("start_date"), "date_value")
        )
        end_date = people_leave_date(
            people_value_content(values.get("end_date"), "date_value")
        )

        def half(field_name: str) -> str:
            enum_value = values.get(field_name, {}).get("enum_value")
            if not isinstance(enum_value, dict):
                return ""
            names = enum_value.get("name")
            candidates = [
                names.get("zh-CN") if isinstance(names, dict) else "",
                names.get("en-US") if isinstance(names, dict) else "",
                enum_value.get("value"),
            ]
            for candidate in candidates:
                normalized = normalize_leave_half(candidate)
                if normalized:
                    return normalized
            return ""

        if start_date is None or end_date is None:
            return []
        return leave_adjustments_from_halves(
            start_date.isoformat(),
            half("start_half_day"),
            end_date.isoformat(),
            half("end_half_day"),
            flow_name,
        )
    return []


def fetch_leave_adjustments_http(
    session: Any,
    tenant_host: str,
    instance: dict[str, Any],
    timeout: int,
) -> list[dict[str, Any]]:
    """Read structured leave dates from the Feishu People business API."""
    link = leave_detail_url(instance.get("link"))
    parsed = safe_https_url(link)
    if parsed is None:
        return []
    query = parse_qs(parsed.query)
    process_id = (query.get("id") or [""])[0]
    node_id = (query.get("node_id") or [""])[0]
    approver_id = (query.get("approver_id") or [""])[0]
    if not tenant_host:
        raise ApprovalSessionError(
            "login_required",
            "休假审批需要重新完成飞书网页登录。",
        )
    if (
        not tenant_host.endswith(".feishu.cn")
        or not process_id
        or not node_id
    ):
        return []
    api_url = (
        f"https://{tenant_host}/people/api/approval_center/process/detail"
    )
    referer = urlparse(link)._replace(netloc=tenant_host).geturl()
    try:
        response = session.get(
            api_url,
            params={
                "approver_id": approver_id,
                "node_id": node_id,
                "process_id": process_id,
                "with_form_instance": "true",
            },
            headers={"Referer": referer},
            timeout=timeout,
        )
    except Exception as error:
        raise ApprovalSessionError(
            "unavailable",
            "休假审批详情接口请求失败。",
        ) from error
    payload = approval_response_json(response, "休假审批详情接口")
    if payload.get("success") is False:
        message = str(payload.get("msg") or "")
        status = (
            "login_required"
            if re.search(r"登录|login|auth", message, re.IGNORECASE)
            else "unavailable"
        )
        raise ApprovalSessionError(status, "休假审批详情接口返回失败。")
    data = payload.get("data")
    if not isinstance(data, dict):
        return []
    return leave_adjustments_from_people_form(
        data.get("form_instance"),
        str(instance.get("definition_name") or "休假申请流程"),
    )


def collect_external_approval_adjustments_http(
    instances: list[dict[str, Any]],
    approval_profile: Path,
    timeout: int,
    supplemental_cookies: tuple[dict[str, Any], ...] = (),
) -> ExternalApprovalCollection:
    """Call the approved OA/People APIs with an in-memory local web session."""
    if not instances:
        return ExternalApprovalCollection(
            "not_needed",
            [],
            method="direct_api",
        )
    try:
        session, tenant_host = approval_http_session(
            approval_profile,
            supplemental_cookies,
        )
    except ApprovalSessionError as error:
        return ExternalApprovalCollection(
            error.status,
            [],
            method="direct_api",
            message=str(error),
        )

    adjustments: list[dict[str, Any]] = []
    parsed_instances = 0
    try:
        for instance in instances:
            flow_type = approval_flow_type(instance.get("definition_name"))
            try:
                if flow_type == "patch":
                    parsed = fetch_patch_adjustments_http(
                        session,
                        instance,
                        timeout,
                    )
                elif flow_type == "leave":
                    parsed = fetch_leave_adjustments_http(
                        session,
                        tenant_host,
                        instance,
                        timeout,
                    )
                else:
                    parsed = []
            except ApprovalSessionError as error:
                return ExternalApprovalCollection(
                    error.status,
                    adjustments,
                    parsed_instances,
                    method="direct_api",
                    message=str(error),
                )
            if parsed:
                parsed_instances += 1
                adjustments.extend(parsed)
    finally:
        session.close()
    return ExternalApprovalCollection(
        "ready",
        adjustments,
        parsed_instances,
        method="direct_api",
    )


def normalize_approval_cdp_endpoint(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        parsed = urlparse(text)
        port = parsed.port or 80
    except ValueError as error:
        raise CollectorError("审批详情 CDP 地址无效。") from error
    if (
        parsed.scheme.casefold() != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
        or not 1 <= port <= 65535
    ):
        raise CollectorError("审批详情 CDP 只允许使用本机 HTTP 地址。")
    return f"http://127.0.0.1:{port}"


def approval_cdp_websocket(endpoint: str) -> str:
    base = normalize_approval_cdp_endpoint(endpoint)
    if not base:
        raise CollectorError("审批详情 CDP 未启用。")
    port = urlparse(base).port
    try:
        with urlopen(f"{base}/json/version", timeout=2) as response:
            payload = json.load(response)
    except Exception as error:
        raise CollectorError("无法连接审批详情专用 Chrome。") from error
    websocket = str(payload.get("webSocketDebuggerUrl") or "")
    try:
        parsed = urlparse(websocket)
        websocket_port = parsed.port
    except ValueError as error:
        raise CollectorError("审批详情 Chrome 返回了无效连接地址。") from error
    if (
        parsed.scheme != "ws"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or websocket_port != port
        or not parsed.path.startswith("/devtools/browser/")
    ):
        raise CollectorError("审批详情 Chrome 返回了非本机连接地址。")
    return websocket


def resolve_chrome_executable(value: Any = "") -> str:
    requested = str(value or "").strip()
    if requested:
        candidate = Path(requested).expanduser()
        if candidate.parent != Path("."):
            resolved = candidate.resolve()
            if resolved.is_file() and os.access(resolved, os.X_OK):
                return str(resolved)
            raise CollectorError(f"指定的 Chrome 不可执行：{candidate}")
        executable = shutil.which(requested)
        if executable:
            return executable
        raise CollectorError(f"找不到指定的 Chrome：{requested}")
    for name in CHROME_EXECUTABLE_CANDIDATES:
        executable = shutil.which(name)
        if executable:
            return executable
    raise CollectorError(
        "找不到 Google Chrome/Chromium；请安装浏览器，"
        "或用 --approval-chrome 指定可执行文件。"
    )


def prepare_approval_profile(value: Path) -> Path:
    profile = value.expanduser().resolve()
    try:
        profile.mkdir(mode=0o700, parents=True, exist_ok=True)
        private_root = (ROOT / ".attendance-data").resolve()
        if profile.is_relative_to(private_root):
            profile.chmod(0o700)
    except OSError as error:
        raise CollectorError(f"无法创建审批专用 Chrome Profile：{profile}") from error
    if not profile.is_dir():
        raise CollectorError(f"审批专用 Chrome Profile 不是目录：{profile}")
    return profile


def ensure_approval_chrome(
    endpoint: str,
    profile: Path,
    chrome: str = "",
    auto_start: bool = True,
    headless: bool = False,
) -> ApprovalChromeSession:
    normalized_endpoint = normalize_approval_cdp_endpoint(endpoint)
    if not normalized_endpoint:
        raise CollectorError(
            "审批详情 CDP 未配置；请使用默认配置，"
            "或通过 --no-approval-details 跳过详情。"
        )
    try:
        approval_cdp_websocket(normalized_endpoint)
        return ApprovalChromeSession(normalized_endpoint)
    except CollectorError:
        pass
    if not auto_start:
        raise CollectorError(
            f"未检测到审批专用 Chrome：{normalized_endpoint}。\n"
            "请启动它，或移除 --no-auto-approval-chrome 让采集器自动启动。"
        )

    executable = resolve_chrome_executable(chrome)
    profile_path = prepare_approval_profile(profile)
    port = urlparse(normalized_endpoint).port
    command = [
        executable,
        "--remote-debugging-address=127.0.0.1",
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile_path}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if headless:
        command.extend(["--headless=new", "--disable-gpu"])
    command.append("about:blank")
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except OSError as error:
        raise CollectorError(f"无法启动审批专用 Chrome：{error}") from error

    deadline = time.monotonic() + APPROVAL_CHROME_START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        try:
            approval_cdp_websocket(normalized_endpoint)
            return ApprovalChromeSession(normalized_endpoint, process)
        except CollectorError:
            time.sleep(0.25)
    try:
        process.terminate()
        process.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        try:
            process.kill()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
    raise CollectorError(
        "审批专用 Chrome 启动失败。请确认专用 Profile 没有被其他 Chrome "
        "占用；兼容模式还需要可用的图形桌面。"
    )


def stop_approval_chrome(session: ApprovalChromeSession | None) -> None:
    if session is None or session.process is None or session.process.poll() is not None:
        return
    try:
        session.process.terminate()
        session.process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        try:
            session.process.kill()
            session.process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
    except OSError:
        pass


APPROVAL_LOGIN_TEXT_RE = re.compile(
    r"(?:请先登录|扫码登录|登录飞书|登录账号|授权登录|"
    r"\bsign\s*in\b|\blog\s*in\b|\bscan\s+(?:the\s+)?qr\b|\bauthorize\b)",
    re.IGNORECASE,
)
APPROVAL_QR_REFRESH_TEXT_RE = re.compile(
    r"(?:刷新二维码|二维码.*(?:失效|过期)|"
    r"refresh\s+(?:the\s+)?qr\s*code|qr\s*code.*expired)",
    re.IGNORECASE,
)
APPROVAL_OAUTH_AUTHORIZE_TEXT_RE = re.compile(
    r"^(?:authorize|授权|确认授权|允许|同意)$",
    re.IGNORECASE,
)


def approval_page_requires_login(current_url: Any, visible_text: Any) -> bool:
    parsed = safe_https_url(current_url)
    if parsed is not None:
        path = parsed.path.casefold()
        hostname = parsed.hostname.casefold()
        if (
            any(marker in path for marker in ("/login", "/passport", "/accounts"))
            or hostname.startswith(("accounts.", "passport.", "login."))
        ):
            return True
    return bool(APPROVAL_LOGIN_TEXT_RE.search(str(visible_text or "")[:8000]))


def render_terminal_qr(
    matrix: list[str],
    *,
    ansi: bool = True,
    border: int = 4,
) -> str:
    """Render a QR module matrix without persisting its one-time payload."""
    size = len(matrix)
    if (
        size < 21
        or (size - 21) % 4
        or border < 2
        or any(len(row) != size or set(row) - {"0", "1"} for row in matrix)
    ):
        raise ValueError("二维码矩阵无效。")

    padded = ["0" * (size + border * 2) for _ in range(border)]
    padded.extend("0" * border + row + "0" * border for row in matrix)
    padded.extend(["0" * (size + border * 2) for _ in range(border)])

    if not ansi:
        return "\n".join(
            "".join("  " if value == "1" else "██" for value in row)
            for row in padded
        )

    if len(padded) % 2:
        padded.append("0" * len(padded[0]))
    characters = {
        ("0", "0"): " ",
        ("1", "0"): "▀",
        ("0", "1"): "▄",
        ("1", "1"): "█",
    }
    return "\n".join(
        "\033[30;107m"
        + "".join(
            characters[(top[column], bottom[column])]
            for column in range(len(top))
        )
        + "\033[0m"
        for top, bottom in zip(padded[0::2], padded[1::2])
    )


def approval_login_qr_matrix(page: Any) -> list[str]:
    """Recover the exact QR modules from Feishu's in-page canvas."""
    canvas = page.locator(".new-scan-qrcode-container canvas").first
    try:
        if not canvas.is_visible():
            return []
        result = canvas.evaluate(
            """
            (canvas) => {
              const width = canvas.width;
              const height = canvas.height;
              if (width !== height || width < 21) return null;
              const pixels = canvas
                .getContext("2d")
                .getImageData(0, 0, width, height).data;
              const bit = (size, row, column) => {
                const x = Math.min(
                  width - 1,
                  Math.floor((column + 0.5) * width / size),
                );
                const y = Math.min(
                  height - 1,
                  Math.floor((row + 0.5) * height / size),
                );
                const offset = (y * width + x) * 4;
                return (
                  pixels[offset] + pixels[offset + 1] + pixels[offset + 2]
                  < 384
                ) ? "1" : "0";
              };
              const expectedFinderBit = (row, column) => (
                row === 0 || row === 6 || column === 0 || column === 6
                || (row >= 2 && row <= 4 && column >= 2 && column <= 4)
              ) ? "1" : "0";
              let best = null;
              for (let size = 21; size <= 177 && size <= width; size += 4) {
                let score = 0;
                for (const [top, left] of [
                  [0, 0],
                  [0, size - 7],
                  [size - 7, 0],
                ]) {
                  for (let row = 0; row < 7; row += 1) {
                    for (let column = 0; column < 7; column += 1) {
                      if (
                        bit(size, top + row, left + column)
                        !== expectedFinderBit(row, column)
                      ) {
                        score += 1;
                      }
                    }
                  }
                }
                if (best === null || score < best.score) {
                  best = {size, score};
                }
              }
              if (best === null || best.score > 3) return null;
              const rows = [];
              for (let row = 0; row < best.size; row += 1) {
                let value = "";
                for (let column = 0; column < best.size; column += 1) {
                  value += bit(best.size, row, column);
                }
                rows.push(value);
              }
              return rows;
            }
            """
        )
    except Exception:
        return []
    if (
        not isinstance(result, list)
        or not result
        or any(not isinstance(row, str) for row in result)
    ):
        return []
    try:
        render_terminal_qr(result)
    except ValueError:
        return []
    return result


def activate_approval_qr_login(page: Any, timeout_ms: int) -> bool:
    """Switch Feishu's account-login card to its QR-login face."""
    canvas = page.locator(".new-scan-qrcode-container canvas").first
    try:
        if canvas.is_visible():
            return True
    except Exception:
        pass
    switch = page.locator(".login-qr-switch-box").first
    try:
        switch.wait_for(state="visible", timeout=min(timeout_ms, 10_000))
        box = switch.bounding_box()
        if not box:
            return False
        page.mouse.click(
            box["x"] + max(1, box["width"] - 20),
            box["y"] + min(20, max(1, box["height"] / 2)),
        )
        canvas.wait_for(state="visible", timeout=min(timeout_ms, 10_000))
        return True
    except Exception:
        return False


def refresh_expired_approval_qr(page: Any) -> bool:
    """Click Feishu's expired-code overlay without changing login mode."""
    try:
        refresh = page.get_by_text(APPROVAL_QR_REFRESH_TEXT_RE).first
        if not refresh.is_visible():
            return False
        refresh.click(force=True, timeout=2000)
        page.wait_for_timeout(700)
        return True
    except Exception:
        return False


def approval_oauth_consent_page(current_url: Any) -> bool:
    parsed = safe_https_url(current_url)
    return bool(
        parsed is not None
        and parsed.hostname.casefold() == "accounts.feishu.cn"
        and parsed.path.rstrip("/").casefold()
        == "/open-apis/authen/v1/index"
    )


def authorize_approval_oauth_consent(page: Any) -> bool:
    """Confirm only the expected Feishu OAuth consent screen."""
    try:
        if not approval_oauth_consent_page(page.url):
            return False
        button = page.get_by_role(
            "button",
            name=APPROVAL_OAUTH_AUTHORIZE_TEXT_RE,
        ).first
        if not button.is_visible() or not button.is_enabled():
            return False
        button.click(timeout=3000)
        page.wait_for_timeout(700)
        return True
    except Exception:
        return False


def approval_qr_login_available(page: Any) -> bool:
    for selector in (
        ".new-scan-qrcode-container canvas",
        ".login-qr-switch-box",
    ):
        try:
            locator = page.locator(selector).first
            if locator.is_visible():
                return True
        except Exception:
            continue
    return False


def approval_login_target_ready(page: Any, flow_type: str) -> bool:
    try:
        current_url = page.url
        visible_text = page.locator("body").inner_text(timeout=1000)
    except Exception:
        return False
    if approval_page_requires_login(current_url, visible_text):
        return False
    parsed = safe_https_url(current_url)
    if parsed is None:
        return False
    hostname = parsed.hostname.casefold()
    path = parsed.path.casefold()
    if flow_type == "patch":
        return (
            hostname == "i.thundersoft.com"
            and path == APPROVAL_OA_FORM_PATH.casefold()
        )
    if flow_type == "leave":
        return (
            (hostname == "people.feishu.cn" or hostname.endswith(".feishu.cn"))
            and "/approvals/" in path
        )
    return False


def establish_approval_web_session(
    instances: list[dict[str, Any]],
    approval_profile: Path,
    approval_cdp: str,
    timeout: int,
    login_timeout: int = APPROVAL_LOGIN_TIMEOUT_SECONDS,
    *,
    chrome: str = "",
    auto_start: bool = True,
    quiet: bool = False,
) -> ApprovalSessionRefresh:
    """Establish approval cookies through a headless, terminal-QR login."""
    targets: dict[str, str] = {}
    for instance in instances:
        flow_type = approval_flow_type(instance.get("definition_name"))
        target = external_approval_detail_url(instance)
        if flow_type in {"leave", "patch"} and target and flow_type not in targets:
            targets[flow_type] = target
    if not targets:
        return ApprovalSessionRefresh("not_needed")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise ApprovalSessionError(
            "unavailable",
            "当前 Python 缺少 Playwright，无法恢复审批网页登录。",
        ) from error

    chrome_session: ApprovalChromeSession | None = None
    pages: list[Any] = []
    stage = "启动审批登录恢复"
    try:
        chrome_session = ensure_approval_chrome(
            approval_cdp,
            approval_profile,
            chrome=chrome,
            auto_start=auto_start,
            headless=True,
        )
        show_progress_detail(
            quiet,
            "登录恢复："
            + (
                "已启动后台无界面 Chrome"
                if chrome_session.started
                else "已复用本机审批 Chrome"
            ),
        )
        stage = "连接审批登录浏览器"
        websocket = approval_cdp_websocket(chrome_session.endpoint)
        timeout_ms = min(max(timeout, 5), 30) * 1000
        login_timeout_seconds = min(max(login_timeout, 5), 600)
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(
                websocket,
                timeout=timeout_ms,
            )
            if not browser.contexts:
                raise ApprovalSessionError(
                    "unavailable",
                    "审批登录浏览器没有可用上下文。",
                )
            context = browser.contexts[0]
            page = context.new_page()
            pages.append(page)
            for flow_type in ("leave", "patch"):
                target = targets.get(flow_type)
                if not target:
                    continue
                flow_label = (
                    "飞书 People 休假"
                    if flow_type == "leave"
                    else "公司 OA 补签"
                )
                show_progress_detail(
                    quiet,
                    f"登录恢复：检查{flow_label}会话",
                )
                stage = f"打开{flow_label}审批页"
                try:
                    page.goto(
                        target,
                        wait_until="domcontentloaded",
                        timeout=timeout_ms,
                    )
                except Exception:
                    pass
                page.wait_for_timeout(1200)

                deadline = time.monotonic() + login_timeout_seconds
                qr_activated = False
                last_qr_fingerprint = ""
                pending_qr_fingerprint = ""
                pending_qr_since = 0.0
                saw_qr = False
                while time.monotonic() < deadline:
                    if approval_login_target_ready(page, flow_type):
                        show_progress_detail(
                            quiet,
                            f"登录恢复：{flow_label}会话可用",
                        )
                        break
                    if approval_oauth_consent_page(page.url):
                        stage = "确认公司 OA 飞书授权"
                        if authorize_approval_oauth_consent(page):
                            show_progress_detail(
                                quiet,
                                "登录恢复：已确认公司 OA 审批连接器授权",
                            )
                            page.wait_for_timeout(800)
                            continue
                    if (
                        not qr_activated
                        and approval_qr_login_available(page)
                    ):
                        stage = "切换飞书二维码登录"
                        qr_activated = activate_approval_qr_login(
                            page,
                            min(timeout_ms, 5000),
                        )
                    if qr_activated and refresh_expired_approval_qr(page):
                        pending_qr_fingerprint = ""
                        pending_qr_since = 0.0
                    matrix = (
                        approval_login_qr_matrix(page)
                        if qr_activated
                        else []
                    )
                    if matrix:
                        fingerprint = hashlib.sha256(
                            "".join(matrix).encode("ascii")
                        ).hexdigest()
                        if fingerprint != last_qr_fingerprint:
                            now = time.monotonic()
                            if fingerprint != pending_qr_fingerprint:
                                pending_qr_fingerprint = fingerprint
                                pending_qr_since = now
                                page.wait_for_timeout(500)
                                continue
                            if now - pending_qr_since < 0.8:
                                page.wait_for_timeout(500)
                                continue
                            if saw_qr:
                                print(
                                    "\n审批登录二维码已刷新，请扫描新二维码：",
                                    flush=True,
                                )
                            else:
                                print(
                                    "\n审批网页登录已过期。"
                                    "请使用飞书手机端扫描并在手机上确认：",
                                    flush=True,
                                )
                            print(
                                render_terminal_qr(
                                    matrix,
                                    ansi=sys.stdout.isatty(),
                                ),
                                flush=True,
                            )
                            print(
                                f"等待扫码确认（最长 {login_timeout_seconds} 秒）…",
                                flush=True,
                            )
                            saw_qr = True
                            last_qr_fingerprint = fingerprint
                            pending_qr_fingerprint = ""
                            pending_qr_since = 0.0
                    page.wait_for_timeout(500)
                else:
                    if saw_qr:
                        return ApprovalSessionRefresh("login_required")
                    raise ApprovalSessionError(
                        "unavailable",
                        f"{flow_label}页面未进入可识别的详情、授权或二维码登录状态。",
                    )
                if saw_qr:
                    show_progress_detail(
                        quiet,
                        "登录恢复：扫码确认成功",
                    )
            ephemeral_cookies = allowed_approval_browser_cookies(
                context.cookies()
            )
            show_progress_detail(
                quiet,
                f"登录恢复：已取得 {len(ephemeral_cookies)} 个"
                "允许域名的临时会话 Cookie（仅内存使用）",
            )
            show_progress_detail(quiet, "登录恢复：审批网页会话已就绪")
            return ApprovalSessionRefresh("ready", ephemeral_cookies)
    except ApprovalSessionError:
        raise
    except CollectorError as error:
        raise ApprovalSessionError(
            "unavailable",
            f"{stage}失败：{error}",
        ) from error
    except Exception as error:
        raise ApprovalSessionError(
            "unavailable",
            f"{stage}失败（{type(error).__name__}）。",
        ) from error
    finally:
        started_chrome = bool(
            chrome_session is not None and chrome_session.started
        )
        for page in pages:
            try:
                page.close(run_before_unload=False)
            except Exception:
                pass
        stop_approval_chrome(chrome_session)
        if started_chrome:
            show_progress_detail(
                quiet,
                "登录恢复：后台无界面 Chrome 已关闭",
            )


def collect_external_approval_adjustments(
    instances: list[dict[str, Any]],
    approval_cdp: str,
    timeout: int,
    login_timeout: int = APPROVAL_LOGIN_TIMEOUT_SECONDS,
) -> ExternalApprovalCollection:
    """Read only whitelisted patch/leave fields from an authenticated browser."""
    if not instances:
        return ExternalApprovalCollection("not_needed", [], method="browser")
    if not approval_cdp:
        return ExternalApprovalCollection("disabled", [], method="browser")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return ExternalApprovalCollection("unavailable", [], method="browser")

    timeout_ms = min(max(timeout, 5), 30) * 1000
    login_timeout_ms = min(max(login_timeout, 5), 600) * 1000
    try:
        websocket = approval_cdp_websocket(approval_cdp)
        adjustments: list[dict[str, Any]] = []
        parsed_instances = 0
        authentication_required = False
        long_waited_flows: set[str] = set()
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(
                websocket,
                timeout=timeout_ms,
            )
            try:
                if not browser.contexts:
                    return ExternalApprovalCollection(
                        "unavailable",
                        [],
                        method="browser",
                    )
                context = browser.contexts[0]
                for instance in instances:
                    target_url = external_approval_detail_url(instance)
                    if not target_url:
                        continue
                    page = context.new_page()
                    parsed: list[dict[str, Any]] = []
                    flow_name = str(instance.get("definition_name") or "")
                    flow_type = approval_flow_type(flow_name)
                    wait_timeout_ms = (
                        login_timeout_ms
                        if flow_type not in long_waited_flows
                        else timeout_ms
                    )
                    long_waited_flows.add(flow_type)
                    try:
                        try:
                            page.goto(
                                target_url,
                                wait_until="domcontentloaded",
                                timeout=timeout_ms,
                            )
                        except Exception:
                            pass
                        if flow_type == "patch":
                            rows = page.locator('input[id^="field66222_"]')
                            rows.first.wait_for(
                                state="attached",
                                timeout=wait_timeout_ms,
                            )
                            values = rows.evaluate_all(
                                "(elements) => elements.map((element) => element.value)"
                            )
                            parsed = patch_adjustments_from_detail_values(
                                values,
                                flow_name,
                            )
                        elif flow_type == "leave":
                            page.wait_for_function(
                                "() => /(?:Start\\s*time|开始\\s*(?:时间|日期))/i"
                                ".test(document.body?.innerText || '')",
                                timeout=wait_timeout_ms,
                            )
                            parsed = leave_adjustments_from_page_text(
                                page.locator("body").inner_text(timeout=timeout_ms),
                                flow_name,
                            )
                    except Exception:
                        parsed = []
                        try:
                            visible_text = page.locator("body").inner_text(timeout=1000)
                        except Exception:
                            visible_text = ""
                        authentication_required = (
                            authentication_required
                            or approval_page_requires_login(page.url, visible_text)
                        )
                    finally:
                        try:
                            page.close(run_before_unload=False)
                        except Exception:
                            pass
                    if authentication_required and not parsed:
                        break
                    if parsed:
                        parsed_instances += 1
                        adjustments.extend(parsed)
            finally:
                try:
                    browser.close()
                except Exception:
                    pass
    except Exception:
        return ExternalApprovalCollection("unavailable", [], method="browser")
    status = "login_required" if authentication_required else "ready"
    return ExternalApprovalCollection(
        status,
        adjustments,
        parsed_instances,
        method="browser",
    )


def collect_approval_adjustments(
    cli: str,
    timeout: int,
    approval_cdp: str = "",
    approval_profile: Path | None = None,
    approval_login_timeout: int = APPROVAL_LOGIN_TIMEOUT_SECONDS,
    *,
    auto_login: bool = False,
    approval_login_cdp: str = DEFAULT_APPROVAL_CDP,
    approval_chrome: str = "",
    approval_auto_start: bool = True,
    quiet: bool = True,
) -> ApprovalCollection:
    show_progress_detail(quiet, "审批：读取当前用户发起的审批实例")
    try:
        instances, pages = fetch_initiated_approval_instances(cli, timeout)
    except CollectorError as error:
        if "approval:instance:read" in str(error):
            raise CollectorError(
                "读取审批记录需要用户只读权限 approval:instance:read；"
                '请执行 lark-cli auth login --scope "approval:instance:read" 完成授权，'
                "或临时使用 --no-approvals。"
            ) from error
        raise

    matched = [
        instance
        for instance in instances
        if approval_flow_type(instance.get("definition_name"))
    ]
    approved = [
        instance
        for instance in matched
        if str(instance.get("instance_status") or "") in {"2", "APPROVED"}
    ]
    show_progress_detail(
        quiet,
        f"审批：扫描 {len(instances)} 个实例，"
        f"匹配 {len(matched)} 个目标流程，其中 {len(approved)} 个已通过",
    )
    adjustments: list[dict[str, Any]] = []
    unparsed = 0
    login_refreshed = False
    unresolved_external: list[dict[str, Any]] = []
    for instance in approved:
        instance_code = str(instance.get("instance_code") or "")
        if not instance_code:
            unparsed += 1
            continue
        if instance.get("instance_external_id"):
            detail = {
                "definition_name": instance.get("definition_name"),
                "status": "APPROVED",
                "reverted": False,
                "form": "[]",
            }
        else:
            detail = fetch_approval_instance_detail(cli, instance_code, timeout)
            if detail.get("reverted") or str(detail.get("status") or "") != "APPROVED":
                continue
        parsed = parse_approval_adjustments(detail, instance)
        if not parsed:
            if (
                instance.get("instance_external_id")
                and approval_flow_type(instance.get("definition_name"))
                in {"patch", "leave"}
            ):
                unresolved_external.append(instance)
                continue
            unparsed += 1
            continue
        adjustments.extend(parsed)
    if approval_cdp:
        show_progress_detail(quiet, "审批：使用 Chrome 兼容模式读取补签/休假详情")
        details = collect_external_approval_adjustments(
            unresolved_external,
            approval_cdp,
            timeout,
            login_timeout=approval_login_timeout,
        )
    elif approval_profile is not None:
        show_progress_detail(quiet, "审批：直接请求公司 OA / 飞书 People 详情接口")
        details = collect_external_approval_adjustments_http(
            unresolved_external,
            approval_profile,
            timeout,
        )
        if details.status == "login_required" and auto_login:
            show_progress_detail(
                quiet,
                "审批：网页登录态需要恢复，启动自动登录流程",
            )
            login_message = ""
            refreshed_cookies: tuple[dict[str, Any], ...] = ()
            try:
                login_result = establish_approval_web_session(
                    unresolved_external,
                    approval_profile,
                    approval_login_cdp,
                    timeout,
                    login_timeout=approval_login_timeout,
                    chrome=approval_chrome,
                    auto_start=approval_auto_start,
                    quiet=quiet,
                )
                login_status = login_result.status
                refreshed_cookies = login_result.cookies
            except ApprovalSessionError as error:
                login_status = error.status
                login_message = str(error)
            if login_status == "ready":
                login_refreshed = True
                show_progress_detail(
                    quiet,
                    "审批：网页会话恢复完成，重试详情接口",
                )
                details = collect_external_approval_adjustments_http(
                    unresolved_external,
                    approval_profile,
                    timeout,
                    supplemental_cookies=refreshed_cookies,
                )
            else:
                details = ExternalApprovalCollection(
                    login_status,
                    details.adjustments,
                    details.parsed_instances,
                    method="direct_api",
                    message=(
                        login_message
                        or (
                            details.message
                            if login_status == "login_required"
                            else "审批网页登录恢复失败。"
                        )
                    ),
                )
    else:
        details = ExternalApprovalCollection("disabled", [])
    if details.status in {"ready", "not_needed"}:
        show_progress_detail(
            quiet,
            f"审批：详情接口完成，解析 {details.parsed_instances} 个补签/休假实例",
        )
    adjustments.extend(details.adjustments)
    unparsed += max(0, len(unresolved_external) - details.parsed_instances)
    return ApprovalCollection(
        enabled=True,
        adjustments=adjustments,
        pages=pages,
        scanned_instances=len(instances),
        matched_instances=len(matched),
        approved_instances=len(approved),
        unparsed_instances=unparsed,
        detail_collection_status=details.status,
        detail_instances_parsed=details.parsed_instances,
        detail_collection_method=details.method,
        detail_collection_message=details.message,
        detail_login_refreshed=login_refreshed,
    )


def build_payload(
    messages: list[dict[str, Any]],
    raw_message_count: int,
    pages: int,
    truncated: bool,
    chat_lookup: str,
    start: str,
    end: str,
    approvals: ApprovalCollection | None = None,
) -> dict[str, Any]:
    approval_collection = approvals or ApprovalCollection(False, [])
    approval_adjustments = approval_collection.adjustments
    folded_messages = [str(message["text"]).casefold() for message in messages]
    return {
        "schema_version": 1,
        "collected_at": datetime.now(timezone.utc).astimezone(TIME_ZONE).isoformat(),
        "source": {
            "method": "lark-cli-user-im",
            "credentials_exported": False,
            "identity_exported": False,
            "chat_identifier_exported": False,
            "message_identifier_exported": False,
            "database_identifier_exported": False,
            "approval_identifier_exported": False,
            "approval_form_exported": False,
            "chat_lookup": chat_lookup,
            "requested_start": start,
            "requested_end": end,
            "pages": pages,
            "pagination_truncated": truncated,
            "raw_message_count": raw_message_count,
            "matching_messages": len(messages),
            "clock_in_messages": sum(
                any(term.casefold() in text for term in PUNCH_TERMS[0::2])
                for text in folded_messages
            ),
            "clock_out_messages": sum(
                any(term.casefold() in text for term in PUNCH_TERMS[1::2])
                for text in folded_messages
            ),
            "first_message_at": (
                f"{messages[0]['date']} {messages[0]['time']}" if messages else "—"
            ),
            "last_message_at": (
                f"{messages[-1]['date']} {messages[-1]['time']}" if messages else "—"
            ),
            "approval_collection_enabled": approval_collection.enabled,
            "approval_flow_names": list(APPROVAL_FLOW_TYPES),
            "approval_pages": approval_collection.pages,
            "approval_instances_scanned": approval_collection.scanned_instances,
            "approval_instances_matched": approval_collection.matched_instances,
            "approval_instances_approved": approval_collection.approved_instances,
            "approval_instances_unparsed": approval_collection.unparsed_instances,
            "approval_detail_collection_status": (
                approval_collection.detail_collection_status
            ),
            "approval_detail_collection_method": (
                approval_collection.detail_collection_method
            ),
            "approval_detail_instances_parsed": (
                approval_collection.detail_instances_parsed
            ),
            "approval_detail_login_refreshed": (
                approval_collection.detail_login_refreshed
            ),
            "approval_adjustments": len(approval_adjustments),
        },
        "messages": messages,
        "approval_adjustments": approval_adjustments,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    quiet = bool(getattr(args, "quiet", False))
    show_progress(quiet, 1, "检查 lark-cli 用户登录状态")
    owner_name = assert_user_ready(args.cli, args.timeout)
    setattr(
        args,
        "_report_owner_name",
        owner_name if isinstance(owner_name, str) else "",
    )
    show_progress_detail(
        quiet,
        "lark-cli 用户登录可用"
        + (f"（{owner_name}）" if owner_name else ""),
    )
    approvals_disabled = getattr(args, "no_approvals", False)
    details_enabled = (
        not getattr(args, "no_approval_details", False)
        and not approvals_disabled
    )
    use_approval_browser = (
        details_enabled
        and getattr(args, "use_approval_browser", False)
    )
    approval_cdp = (
        getattr(args, "approval_cdp", DEFAULT_APPROVAL_CDP)
        if use_approval_browser
        else ""
    )
    approval_profile = (
        None
        if not details_enabled or use_approval_browser
        else getattr(args, "approval_profile", DEFAULT_APPROVAL_PROFILE)
    )
    show_progress(quiet, 2, "检查审批只读权限")
    if approvals_disabled:
        show_progress_detail(quiet, "已按 --no-approvals 跳过审批权限检查")
    else:
        assert_approval_scope(args.cli, args.timeout)
        show_progress_detail(
            quiet,
            f"最小只读权限 {APPROVAL_READ_SCOPE} 已授权",
        )

    chrome_session: ApprovalChromeSession | None = None
    try:
        show_progress(quiet, 3, "定位并读取【假勤】消息")
        chat_id, chat_lookup = resolve_chat_id(args)
        raw_messages, pages, truncated = fetch_chat_messages(
            args.cli,
            chat_id,
            args.page_size,
            args.timeout,
            start=args.start,
            end=args.end,
            max_pages=args.max_pages,
        )
        messages = normalize_messages(raw_messages)
        show_progress_detail(
            quiet,
            f"读取 {pages} 页、{len(raw_messages)} 条原始消息，"
            f"识别 {len(messages)} 条考勤消息",
        )
        show_progress(quiet, 4, "读取并解析补签、休假与出差审批")
        if use_approval_browser:
            chrome_session = ensure_approval_chrome(
                approval_cdp,
                getattr(args, "approval_profile", DEFAULT_APPROVAL_PROFILE),
                chrome=getattr(args, "approval_chrome", ""),
                auto_start=not getattr(
                    args,
                    "no_auto_approval_chrome",
                    False,
                ),
            )
            approval_cdp = chrome_session.endpoint
            show_progress_detail(
                quiet,
                (
                    "已启动可见审批 Chrome 兼容模式"
                    if chrome_session.started
                    else "已复用审批 Chrome 兼容模式"
                ),
            )
        approvals = (
            ApprovalCollection(False, [])
            if approvals_disabled
            else collect_approval_adjustments(
                args.cli,
                args.timeout,
                approval_cdp=approval_cdp,
                approval_profile=approval_profile,
                approval_login_timeout=getattr(
                    args,
                    "approval_login_timeout",
                    APPROVAL_LOGIN_TIMEOUT_SECONDS,
                ),
                auto_login=details_enabled and not use_approval_browser,
                approval_login_cdp=getattr(
                    args,
                    "approval_cdp",
                    DEFAULT_APPROVAL_CDP,
                ),
                approval_chrome=getattr(args, "approval_chrome", ""),
                approval_auto_start=not getattr(
                    args,
                    "no_auto_approval_chrome",
                    False,
                ),
                quiet=quiet,
            )
        )
        if approvals_disabled:
            show_progress_detail(quiet, "已按 --no-approvals 跳过审批采集")
        else:
            show_progress_detail(
                quiet,
                f"审批补充完成：{approvals.approved_instances} 个已通过实例，"
                f"展开 {len(approvals.adjustments)} 条逐日补充",
            )
        if details_enabled and approvals.detail_collection_status == "unavailable":
            reason = (
                approvals.detail_collection_message
                or "审批详情处理阶段返回 unavailable，未提供具体原因。"
            )
            raise CollectorError(f"审批详情处理失败：{reason}")
        if details_enabled and approvals.detail_collection_status == "login_required":
            reason = (
                approvals.detail_collection_message
                or "审批网页登录未在等待时间内完成确认。"
            )
            raise CollectorError(f"{reason} 请重新运行同一条命令。")
        if not messages and not approvals.adjustments:
            raise CollectorError("假勤会话中没有提取到可识别的考勤消息。")
        payload = build_payload(
            messages,
            raw_message_count=len(raw_messages),
            pages=pages,
            truncated=truncated,
            chat_lookup=chat_lookup,
            start=args.start,
            end=args.end,
            approvals=approvals,
        )
        show_progress(quiet, 5, "保存标准化采集结果")
        atomic_write_private(args.output, payload)
        show_progress_detail(
            quiet,
            f"已保存 {args.output.expanduser().resolve()}",
        )
        return payload
    finally:
        stop_approval_chrome(chrome_session)
        if (
            chrome_session is not None
            and chrome_session.started
            and not quiet
        ):
            show_progress_detail(
                quiet,
                "审批专用 Chrome 已关闭，登录 Profile 已保留",
            )


def run_summarizer(args: argparse.Namespace) -> dict[str, Any]:
    command = [
        args.node,
        str(SUMMARIZER),
        "--input",
        str(args.output),
        "--output",
        str(args.report_json),
        "--period",
        args.report_period,
        "--quiet",
    ]
    if args.report_period == "custom":
        command.extend(["--start", args.report_start, "--end", args.report_end])
    if args.config:
        command.extend(["--config", str(args.config)])
    if args.manual:
        command.extend(["--manual", str(args.manual)])
    if args.now:
        command.extend(["--now", args.now])

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=max(30, args.timeout),
        )
    except FileNotFoundError as error:
        raise CollectorError(f"找不到 Node.js：{args.node}") from error
    except subprocess.TimeoutExpired as error:
        raise CollectorError("本地考勤汇总超时。") from error
    except OSError as error:
        raise CollectorError(f"无法启动本地考勤汇总：{error}") from error

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "未知错误").strip()
        if len(detail) > 600:
            detail = detail[:600] + "…"
        raise CollectorError(detail)
    try:
        return load_report(args.report_json)
    except ReportError as error:
        raise CollectorError(str(error)) from error


def run_pipeline(args: argparse.Namespace) -> PipelineResult:
    quiet = bool(getattr(args, "quiet", False))
    payload = run(args)
    if args.collect_only:
        show_progress(quiet, 8, "采集完成（已按 --collect-only 跳过报告生成）")
        return PipelineResult(payload, None, None, False)
    show_progress(quiet, 6, "计算考勤周期与汇总指标")
    report = run_summarizer(args)
    owner_name = normalize_report_owner_name(
        getattr(args, "_report_owner_name", ""),
    )
    if owner_name:
        report = {**report, "owner_name": owner_name}
        atomic_write_private(args.report_json, report)
    show_progress_detail(
        quiet,
        f"汇总完成：生成 {len(report.get('rows') or [])} 条每日明细",
    )
    show_progress(quiet, 7, "生成自包含 HTML 考勤报告")
    try:
        html_path = write_report_html(report, args.report_html)
    except ReportError as error:
        raise CollectorError(str(error)) from error
    show_progress_detail(quiet, f"HTML 已写入 {html_path}")
    show_progress(
        quiet,
        8,
        "处理完成"
        + ("（不打开浏览器）" if args.no_open else "，正在打开报告"),
    )
    opened = False if args.no_open else open_report(html_path)
    if not args.no_open:
        show_progress_detail(
            quiet,
            "报告已在默认浏览器中打开"
            if opened
            else "未能自动打开报告，但 HTML 已成功生成",
        )
    return PipelineResult(payload, report, html_path, opened)


def main() -> int:
    args = parse_args()
    try:
        result = run_pipeline(args)
    except CollectorError as error:
        print(f"处理失败：{error}", file=sys.stderr)
        return 1
    except Exception as error:  # pragma: no cover - defensive CLI boundary
        print(f"处理失败：{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    if not args.quiet:
        source = result.payload["source"]
        print(
            f"采集完成：{len(result.payload['messages'])} 条假勤消息，"
            f"范围 {source['first_message_at']} 至 {source['last_message_at']}。"
        )
        if source["approval_collection_enabled"]:
            print(
                "审批补充："
                f"{source['approval_instances_approved']} 个已通过实例，"
                f"展开为 {source['approval_adjustments']} 条逐日补充。"
            )
            if source["approval_detail_collection_status"] == "ready":
                if (
                    source.get("approval_detail_collection_method")
                    == "direct_api"
                ):
                    if source.get("approval_detail_login_refreshed"):
                        print(
                            "审批详情：已通过后台无界面 Chrome 恢复网页登录，"
                            "随后直接请求公司 OA / 飞书 People 接口，解析 "
                            f"{source['approval_detail_instances_parsed']} "
                            "个补签/休假实例；后台 Chrome 已关闭。"
                        )
                    else:
                        print(
                            "审批详情："
                            "已直接请求公司 OA / 飞书 People 接口，解析 "
                            f"{source['approval_detail_instances_parsed']} "
                            "个补签/休假实例；未启动 Chrome。"
                        )
                else:
                    print(
                        "审批详情："
                        f"已从专用登录会话解析 "
                        f"{source['approval_detail_instances_parsed']} "
                        "个补签/休假实例。"
                    )
            elif source["approval_detail_collection_status"] == "unavailable":
                print(
                    "警告：未能读取审批详情；"
                    "补签/休假详情未自动计入。"
                )
            if source["approval_instances_unparsed"]:
                print(
                    "警告："
                    f"{source['approval_instances_unparsed']} 个已通过审批未识别出日期或时间，"
                    "未自动计入。"
                )
        if source["pagination_truncated"]:
            print("警告：已达到 --max-pages，输出只包含部分历史消息。")
        print(f"消息文件：{args.output.expanduser().resolve()}")
        if result.report is not None and result.html_path is not None:
            period = result.report["period"]
            print(
                f"报告完成：{period['start']} 至 {period['end']}，"
                f"HTML：{result.html_path}"
            )
            if args.no_open:
                print("已按 --no-open 跳过打开浏览器。")
            elif result.opened:
                print("已在默认浏览器中打开。")
            else:
                print("未能自动打开浏览器，请手动打开上面的 HTML 文件。")
        print(
            "未导出令牌、会话 ID、消息 ID、审批 ID 或原始审批表单；"
            "最终私有报告仅写入当前用户显示姓名。"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
