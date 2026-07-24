#!/usr/bin/env python3
"""Collect Feishu Attendance bot messages from an authenticated Chrome session.

The collector never reads or exports cookies, authorization headers, or tokens. It
executes inside the authenticated Feishu origin through CDP, snapshots the local
WASM/SQLite message database from IndexedDB, and queries the snapshot in memory.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sqlite3
import sys
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import urlopen

from playwright.sync_api import Browser, Page, sync_playwright

from attendance_common import (
    ATTENDANCE_TERMS,
    PUNCH_TERMS,
    TIME_ZONE,
    atomic_write_private,
    local_datetime,
    range_label,
)


DEFAULT_CDP = "http://127.0.0.1:9237"
DEFAULT_ORIGIN = "https://thundersoft.feishu.cn"
DEFAULT_OUTPUT = Path(".attendance-data/attendance-messages.json")
HUMAN_TEXT_RE = re.compile(
    r"[\u3400-\u9fff]|"
    r"(?:attendance|clock|check|record|punch|work|leave|overtime|shift|detail)",
    re.IGNORECASE,
)
URL_RE = re.compile(r"^(?:https?|lark|feishu)://", re.IGNORECASE)


class CollectorError(RuntimeError):
    """Raised for actionable local collector failures."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="复用已登录 Chrome 会话，直接读取飞书本地 IM 数据库中的假勤消息。",
    )
    parser.add_argument("--cdp", default=DEFAULT_CDP, help=f"Chrome CDP 地址（默认：{DEFAULT_CDP}）")
    parser.add_argument("--origin", default=DEFAULT_ORIGIN, help=f"飞书租户 origin（默认：{DEFAULT_ORIGIN}）")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help=f"本地输出文件（默认：{DEFAULT_OUTPUT}）")
    parser.add_argument(
        "--refresh-seconds",
        type=int,
        default=0,
        help="先在临时标签页静默同步 Messenger 的秒数；0 表示只读本地缓存（默认：0）",
    )
    parser.add_argument("--quiet", action="store_true", help="成功时不打印摘要")
    return parser.parse_args()


def cdp_websocket_url(cdp_http: str) -> str:
    endpoint = cdp_http.rstrip("/") + "/json/version"
    try:
        with urlopen(endpoint, timeout=5) as response:
            payload = json.load(response)
    except Exception as error:  # pragma: no cover - platform-dependent details
        raise CollectorError(
            f"无法连接 Chrome CDP：{cdp_http}。请先启动专用 Chrome 并开启远程调试端口。"
        ) from error
    websocket_url = payload.get("webSocketDebuggerUrl")
    if not websocket_url:
        raise CollectorError("Chrome CDP 未返回 webSocketDebuggerUrl。")
    return str(websocket_url)


def same_origin(url: str, origin: str) -> bool:
    left = urlparse(url)
    right = urlparse(origin)
    return left.scheme == right.scheme and left.netloc == right.netloc


def acquire_origin_page(browser: Browser, origin: str) -> tuple[Page, bool]:
    if not browser.contexts:
        raise CollectorError("Chrome 中没有可用的浏览器上下文。")
    context = browser.contexts[0]
    for page in context.pages:
        if same_origin(page.url, origin):
            return page, False

    page = context.new_page()
    check_url = origin.rstrip("/") + "/suite/passport/auth/is_logged_in/"
    try:
        page.goto(check_url, wait_until="domcontentloaded", timeout=30_000)
    except Exception as error:
        page.close()
        raise CollectorError(f"无法打开飞书同源登录检查页：{check_url}") from error
    return page, True


def refresh_im_cache(browser: Browser, origin: str, seconds: int) -> None:
    if seconds <= 0:
        return
    if seconds > 300:
        raise CollectorError("--refresh-seconds 不能超过 300。")
    context = browser.contexts[0]
    page = context.new_page()
    page.route(
        "**/*",
        lambda route: route.abort()
        if route.request.resource_type in {"image", "media", "font"}
        else route.continue_(),
    )
    try:
        page.goto(
            origin.rstrip("/") + "/next/messenger",
            wait_until="domcontentloaded",
            timeout=60_000,
        )
        page.wait_for_timeout(seconds * 1000)
    except Exception as error:
        raise CollectorError("静默刷新 Messenger 失败；可改用只读本地缓存模式。") from error
    finally:
        if not page.is_closed():
            page.close()


def assert_authenticated(page: Page, origin: str) -> None:
    result = page.evaluate(
        """
        async (url) => {
          try {
            const response = await fetch(url, {credentials: 'include', cache: 'no-store'});
            if (!response.ok) return {ok: false, status: response.status};
            const data = await response.json();
            return {ok: Boolean(data?.is_logged), status: response.status};
          } catch (error) {
            return {ok: false, status: 0, error: error?.name || 'FetchError'};
          }
        }
        """,
        origin.rstrip("/") + "/suite/passport/auth/is_logged_in/",
    )
    if not result.get("ok"):
        raise CollectorError("专用 Chrome 会话尚未登录飞书，或登录已过期。")


def snapshot_candidate_databases(page: Page) -> list[dict[str, Any]]:
    """Return only SQLite blobs containing punch-success text.

    Database names stay inside the page. They are intentionally not returned.
    """

    return page.evaluate(
        """
        async (terms) => {
          if (typeof indexedDB.databases !== 'function') {
            throw new Error('IndexedDB databases() is unavailable');
          }
          const decoder = new TextDecoder('utf-8', {fatal: false});
          const infos = await indexedDB.databases();
          const names = infos
            .map((item) => item.name)
            .filter((name) => /^[0-9a-f]{32}$/i.test(name || ''));
          const results = [];
          for (const name of names) {
            const db = await new Promise((resolve, reject) => {
              const request = indexedDB.open(name);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            try {
              if (!db.objectStoreNames.length) continue;
              const storeName = db.objectStoreNames[0];
              const store = db.transaction(storeName, 'readonly').objectStore(storeName);
              const values = await new Promise((resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              for (const value of values) {
                let bytes = null;
                if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
                else if (ArrayBuffer.isView(value)) {
                  bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                }
                if (!bytes || bytes.byteLength < 16) continue;
                if (!decoder.decode(bytes.subarray(0, 16)).startsWith('SQLite format 3')) continue;
                const text = decoder.decode(bytes);
                if (!terms.some((term) => text.includes(term))) continue;
                const pieces = [];
                for (let offset = 0; offset < bytes.length; offset += 0x8000) {
                  pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
                }
                results.push({bytes: bytes.byteLength, base64: btoa(pieces.join(''))});
              }
            } finally {
              db.close();
            }
          }
          return results;
        }
        """,
        list(PUNCH_TERMS),
    )


def sqlite_from_bytes(blob: bytes) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    if not hasattr(connection, "deserialize"):
        connection.close()
        raise CollectorError("需要 Python 3.11+（sqlite3.Connection.deserialize 不可用）。")
    try:
        connection.deserialize(blob)
        check = connection.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise CollectorError("飞书消息 SQLite 快照校验失败。")
        return connection
    except Exception:
        connection.close()
        raise


def table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    safe_table = table.replace('"', '""')
    return {str(row[1]) for row in connection.execute(f'PRAGMA table_info("{safe_table}")')}


def find_message_databases(candidates: Iterable[dict[str, Any]]) -> list[sqlite3.Connection]:
    connections: list[sqlite3.Connection] = []
    for candidate in candidates:
        raw = base64.b64decode(candidate["base64"], validate=True)
        connection = sqlite_from_bytes(raw)
        tables = {
            str(row[0])
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        columns = table_columns(connection, "message") if "message" in tables else set()
        required = {"id", "chatId", "content", "createTime", "position"}
        if required.issubset(columns):
            connections.append(connection)
        else:
            connection.close()
    return connections


def choose_attendance_chat(
    connections: Iterable[sqlite3.Connection],
) -> tuple[sqlite3.Connection, str, dict[str, Any]]:
    matches: list[tuple[int, float, sqlite3.Connection, str, dict[str, Any]]] = []
    where = " OR ".join("content LIKE ?" for _ in PUNCH_TERMS)
    params = tuple(f"%{term}%" for term in PUNCH_TERMS)
    for connection in connections:
        query = (
            "SELECT chatId, COUNT(*), MIN(createTime), MAX(createTime), "
            "SUM(content LIKE '%上班打卡成功%'), "
            "SUM(content LIKE '%下班打卡成功%') "
            f"FROM message WHERE ({where}) AND isDeleted=0 GROUP BY chatId"
        )
        for row in connection.execute(query, params):
            summary = {
                "matching_messages": int(row[1] or 0),
                "clock_in_messages": int(row[4] or 0),
                "clock_out_messages": int(row[5] or 0),
                "first_timestamp": float(row[2] or 0),
                "last_timestamp": float(row[3] or 0),
            }
            matches.append((summary["matching_messages"], summary["last_timestamp"], connection, str(row[0]), summary))
    if not matches:
        raise CollectorError("本地 IM 数据库中没有找到“假勤”的成功打卡消息。")
    matches.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return matches[0][2], matches[0][3], matches[0][4]


def maybe_json(value: str) -> Any | None:
    stripped = value.strip()
    if not stripped or stripped[0] not in "{[":
        return None
    try:
        return json.loads(stripped)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None


def walk_human_strings(value: Any, output: list[str], depth: int = 0) -> None:
    if depth > 14:
        return
    if isinstance(value, dict):
        for child in value.values():
            walk_human_strings(child, output, depth + 1)
        return
    if isinstance(value, list):
        for child in value:
            walk_human_strings(child, output, depth + 1)
        return
    if not isinstance(value, str):
        return

    nested = maybe_json(value)
    if nested is not None:
        walk_human_strings(nested, output, depth + 1)
        return
    text = re.sub(r"<[^>]+>", " ", value)
    text = text.replace("\\n", "\n")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text or URL_RE.match(text) or not HUMAN_TEXT_RE.search(text):
        return
    if not output or output[-1] != text:
        output.append(text)


def message_text(content: str) -> str:
    try:
        payload = json.loads(content)
    except (TypeError, ValueError, json.JSONDecodeError):
        return str(content or "").strip()

    card = payload.get("cardContent") if isinstance(payload, dict) else None
    preferred: Any = card
    if isinstance(card, dict) and isinstance(card.get("jsonBody"), str):
        preferred = maybe_json(card["jsonBody"]) or card
    texts: list[str] = []
    walk_human_strings(preferred, texts)
    if not texts:
        walk_human_strings(payload, texts)

    deduplicated: list[str] = []
    seen: set[str] = set()
    for text in texts:
        key = re.sub(r"\s+", " ", text).strip()
        if key in seen:
            continue
        seen.add(key)
        deduplicated.append(text)
    return "\n".join(deduplicated)


def collect_messages(
    connection: sqlite3.Connection,
    chat_id: str,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT id, type, content, createTime, position, updateTime "
        "FROM message WHERE chatId=? AND isDeleted=0 AND isRecalled=0 "
        "ORDER BY position, createTime, id",
        (chat_id,),
    )
    messages: list[dict[str, Any]] = []
    for message_id, message_type, content, create_time, position, update_time in rows:
        text = message_text(str(content or ""))
        if not text or not any(term.casefold() in text.casefold() for term in ATTENDANCE_TERMS):
            continue
        sent_at = local_datetime(float(create_time or 0))
        digest_source = f"{message_id}\0{create_time}\0{text}".encode("utf-8")
        messages.append({
            "key": hashlib.sha256(digest_source).hexdigest()[:24],
            "date": sent_at.strftime("%Y-%m-%d"),
            "time": sent_at.strftime("%H:%M"),
            "sent_at": sent_at.isoformat(),
            "message_type": int(message_type or 0),
            "text": text,
            "position": float(position or 0),
            "updated_at": local_datetime(float(update_time or create_time or 0)).isoformat(),
        })
    return messages


def run(args: argparse.Namespace) -> dict[str, Any]:
    origin = args.origin.rstrip("/")
    if urlparse(origin).scheme != "https" or not urlparse(origin).netloc:
        raise CollectorError("--origin 必须是完整 HTTPS origin。")

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(cdp_websocket_url(args.cdp))
        page: Page | None = None
        temporary_page = False
        connections: list[sqlite3.Connection] = []
        try:
            refresh_im_cache(browser, origin, max(0, args.refresh_seconds))
            page, temporary_page = acquire_origin_page(browser, origin)
            assert_authenticated(page, origin)
            candidates = snapshot_candidate_databases(page)
            connections = find_message_databases(candidates)
            if not connections:
                raise CollectorError("找到考勤文本，但没有找到包含 message 表的飞书 SQLite 数据库。")
            connection, chat_id, database_summary = choose_attendance_chat(connections)
            messages = collect_messages(connection, chat_id)
            if not messages:
                raise CollectorError("已定位“假勤”会话，但未提取到可识别的考勤卡片。")
        finally:
            for connection in connections:
                connection.close()
            if temporary_page and page and not page.is_closed():
                page.close()
            browser.close()

    payload = {
        "schema_version": 1,
        "collected_at": datetime.now(timezone.utc).astimezone(TIME_ZONE).isoformat(),
        "source": {
            "origin": origin,
            "method": "authenticated-cdp-indexeddb-sqlite",
            "credentials_exported": False,
            "chat_identifier_exported": False,
            "database_identifier_exported": False,
            "refresh_seconds": max(0, args.refresh_seconds),
            "matching_messages": database_summary["matching_messages"],
            "clock_in_messages": database_summary["clock_in_messages"],
            "clock_out_messages": database_summary["clock_out_messages"],
            "first_message_at": range_label(database_summary["first_timestamp"]),
            "last_message_at": range_label(database_summary["last_timestamp"]),
        },
        "messages": messages,
    }
    atomic_write_private(args.output, payload)
    return payload


def main() -> int:
    args = parse_args()
    try:
        payload = run(args)
    except CollectorError as error:
        print(f"采集失败：{error}", file=sys.stderr)
        return 1
    except Exception as error:  # pragma: no cover - defensive CLI boundary
        print(f"采集失败：{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    if not args.quiet:
        source = payload["source"]
        print(
            f"采集完成：{len(payload['messages'])} 条假勤消息，"
            f"范围 {source['first_message_at']} 至 {source['last_message_at']}。"
        )
        print(f"本地文件：{args.output}")
        print("未导出 Cookie、Authorization、Token、会话 ID 或数据库 ID。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
