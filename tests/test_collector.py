#!/usr/bin/env python3

import json
import sqlite3
import stat
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "collector"))

import feishu_attendance_collector as collector  # noqa: E402


def card_content(title: str, body: str) -> str:
    body_json = {
        "header": {"title": {"tag": "plain_text", "content": title}},
        "elements": [
            {"tag": "div", "text": {"tag": "lark_md", "content": body}},
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "查看详情"},
                        "url": "https://example.invalid/private",
                    }
                ],
            },
        ],
    }
    return json.dumps(
        {"cardContent": {"jsonBody": json.dumps(body_json, ensure_ascii=False)}},
        ensure_ascii=False,
    )


def message_database() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute(
        "CREATE TABLE message ("
        "id TEXT PRIMARY KEY, chatId TEXT NOT NULL, type INTEGER NOT NULL, "
        "content TEXT NOT NULL, createTime REAL NOT NULL, position REAL NOT NULL, "
        "updateTime REAL NOT NULL, isDeleted INTEGER NOT NULL, isRecalled INTEGER NOT NULL"
        ")"
    )
    return connection


class CollectorTests(unittest.TestCase):
    def test_message_text_flattens_card_without_urls_or_structural_tags(self):
        text = collector.message_text(card_content("上班打卡成功!", "打卡方式：通过考勤机打卡"))
        self.assertIn("上班打卡成功", text)
        self.assertIn("打卡方式：通过考勤机打卡", text)
        self.assertIn("查看详情", text)
        self.assertNotIn("example.invalid", text)
        self.assertNotIn("plain_text", text)
        self.assertNotIn("lark_md", text)

    def test_choose_attendance_chat_and_collect_normalized_messages(self):
        connection = message_database()
        timestamp = datetime(2026, 7, 22, 9, 24, tzinfo=collector.TIME_ZONE).timestamp()
        rows = [
            (
                "message-1",
                "attendance-chat",
                13,
                card_content("上班打卡成功!", "打卡方式：通过考勤机打卡"),
                timestamp,
                1,
                timestamp,
                0,
                0,
            ),
            (
                "message-2",
                "attendance-chat",
                13,
                card_content("上班打卡提醒", "快到上班时间了，别忘了打卡"),
                timestamp + 60,
                2,
                timestamp + 60,
                0,
                0,
            ),
            (
                "message-3",
                "other-chat",
                2,
                json.dumps({"text": "普通聊天"}, ensure_ascii=False),
                timestamp,
                1,
                timestamp,
                0,
                0,
            ),
        ]
        connection.executemany(
            "INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        selected, chat_id, summary = collector.choose_attendance_chat([connection])
        self.assertIs(selected, connection)
        self.assertEqual(chat_id, "attendance-chat")
        self.assertEqual(summary["clock_in_messages"], 1)
        messages = collector.collect_messages(connection, chat_id)
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]["date"], "2026-07-22")
        self.assertEqual(messages[0]["time"], "09:24")
        self.assertNotIn("message-1", json.dumps(messages, ensure_ascii=False))
        self.assertIn("上班打卡提醒", messages[1]["text"])
        connection.close()

    def test_private_output_does_not_export_identifiers(self):
        payload = {
            "schema_version": 1,
            "source": {
                "credentials_exported": False,
                "chat_identifier_exported": False,
                "database_identifier_exported": False,
            },
            "messages": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "private" / "messages.json"
            collector.atomic_write_private(output, payload)
            self.assertEqual(json.loads(output.read_text("utf-8")), payload)
            if sys.platform != "win32":
                self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
