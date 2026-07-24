#!/usr/bin/env python3

import argparse
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "collector"))

import lark_cli_attendance_collector as collector  # noqa: E402


class LarkCliCollectorTests(unittest.TestCase):
    @staticmethod
    def pipeline_args(**overrides):
        values = {
            "cli": "lark-cli",
            "chat_id": "oc_private",
            "chat_pattern": collector.DEFAULT_CHAT_PATTERN,
            "start": "",
            "end": "",
            "page_size": 50,
            "max_pages": 0,
            "timeout": 60,
            "output": Path("/tmp/attendance-messages.json"),
            "node": "node",
            "report_json": Path("/tmp/attendance-report.json"),
            "report_html": Path("/tmp/attendance-report.html"),
            "report_period": "auto",
            "report_start": "",
            "report_end": "",
            "config": None,
            "manual": None,
            "no_approvals": False,
            "approval_cdp": collector.DEFAULT_APPROVAL_CDP,
            "use_approval_browser": False,
            "no_approval_details": False,
            "approval_profile": collector.DEFAULT_APPROVAL_PROFILE,
            "approval_chrome": "",
            "no_auto_approval_chrome": False,
            "approval_login_timeout": collector.APPROVAL_LOGIN_TIMEOUT_SECONDS,
            "now": "",
            "collect_only": False,
            "no_open": False,
            "quiet": True,
        }
        values.update(overrides)
        return argparse.Namespace(**values)

    def test_refreshable_user_token_is_allowed(self):
        with mock.patch.object(
            collector,
            "invoke_lark_cli",
            return_value={
                "available": True,
                "identity": "user",
                "tokenStatus": "needs_refresh",
            },
        ):
            self.assertEqual(collector.assert_user_ready("lark-cli", 60), "")

    def test_user_display_name_is_sanitized_for_private_report(self):
        with mock.patch.object(
            collector,
            "invoke_lark_cli",
            return_value={
                "available": True,
                "identity": "user",
                "tokenStatus": "ready",
                "onBehalfOf": {
                    "userName": "  测\n试用户\u0000  ",
                    "openId": "ou_private",
                },
            },
        ):
            self.assertEqual(
                collector.assert_user_ready("lark-cli", 60),
                "测 试用户",
            )

    def test_missing_approval_scope_has_exact_authorization_prompt(self):
        with mock.patch.object(
            collector,
            "invoke_lark_cli",
            return_value={
                "ok": True,
                "granted": [],
                "missing": [collector.APPROVAL_READ_SCOPE],
            },
        ):
            with self.assertRaises(collector.CollectorError) as raised:
                collector.assert_approval_scope("lark-cli", 60)
        message = str(raised.exception)
        self.assertIn(collector.APPROVAL_READ_SCOPE, message)
        self.assertIn(
            'lark-cli auth login --scope "approval:instance:read"',
            message,
        )

    def test_auto_chrome_reuses_existing_local_session(self):
        with (
            mock.patch.object(
                collector,
                "approval_cdp_websocket",
                return_value="ws://127.0.0.1:9238/devtools/browser/test",
            ),
            mock.patch.object(collector, "resolve_chrome_executable") as resolve,
        ):
            session = collector.ensure_approval_chrome(
                collector.DEFAULT_APPROVAL_CDP,
                collector.DEFAULT_APPROVAL_PROFILE,
            )
        self.assertFalse(session.started)
        self.assertEqual(session.endpoint, collector.DEFAULT_APPROVAL_CDP)
        resolve.assert_not_called()

    def test_auto_chrome_starts_private_profile_when_cdp_is_absent(self):
        process = mock.Mock()
        process.poll.return_value = None
        profile = Path("/tmp/private-approval-profile")
        with (
            mock.patch.object(
                collector,
                "approval_cdp_websocket",
                side_effect=[
                    collector.CollectorError("not running"),
                    "ws://127.0.0.1:9238/devtools/browser/test",
                ],
            ),
            mock.patch.object(
                collector,
                "resolve_chrome_executable",
                return_value="/usr/bin/google-chrome",
            ),
            mock.patch.object(
                collector,
                "prepare_approval_profile",
                return_value=profile,
            ),
            mock.patch.object(
                collector.subprocess,
                "Popen",
                return_value=process,
            ) as popen,
        ):
            session = collector.ensure_approval_chrome(
                collector.DEFAULT_APPROVAL_CDP,
                profile,
            )

        self.assertTrue(session.started)
        command = popen.call_args.args[0]
        self.assertIn("--remote-debugging-address=127.0.0.1", command)
        self.assertIn("--remote-debugging-port=9238", command)
        self.assertIn(f"--user-data-dir={profile}", command)
        self.assertNotIn("--headless", command)

    def test_auto_chrome_can_start_headless_for_terminal_qr(self):
        process = mock.Mock()
        process.poll.return_value = None
        profile = Path("/tmp/private-approval-profile")
        with (
            mock.patch.object(
                collector,
                "approval_cdp_websocket",
                side_effect=[
                    collector.CollectorError("not running"),
                    "ws://127.0.0.1:9238/devtools/browser/test",
                ],
            ),
            mock.patch.object(
                collector,
                "resolve_chrome_executable",
                return_value="/usr/bin/google-chrome",
            ),
            mock.patch.object(
                collector,
                "prepare_approval_profile",
                return_value=profile,
            ),
            mock.patch.object(
                collector.subprocess,
                "Popen",
                return_value=process,
            ) as popen,
        ):
            collector.ensure_approval_chrome(
                collector.DEFAULT_APPROVAL_CDP,
                profile,
                headless=True,
            )

        command = popen.call_args.args[0]
        self.assertIn("--headless=new", command)
        self.assertIn("--disable-gpu", command)

    def test_terminal_qr_has_quiet_border_and_no_disk_output(self):
        matrix = ["0" * 21 for _ in range(21)]
        rendered = collector.render_terminal_qr(
            matrix,
            ansi=False,
            border=4,
        )
        lines = rendered.splitlines()
        self.assertEqual(len(lines), 29)
        self.assertTrue(all(len(line) == 58 for line in lines))
        self.assertEqual(lines[0], "█" * 58)

    def test_login_page_detection_covers_feishu_and_oa(self):
        self.assertTrue(
            collector.approval_page_requires_login(
                "https://accounts.feishu.cn/accounts/page/login",
                "",
            )
        )
        self.assertTrue(
            collector.approval_page_requires_login(
                "https://i.thundersoft.com/error",
                "请先登录后查看审批",
            )
        )
        self.assertFalse(
            collector.approval_page_requires_login(
                (
                    "https://people.feishu.cn/people/approvals/"
                    "dashboard/applicant"
                ),
                "Start time 2026-07-13 AM End time 2026-07-13 PM",
            )
        )

    def test_people_tenant_host_uses_corehr_cookie_domain(self):
        self.assertEqual(
            collector.people_tenant_host_from_cookies(
                [
                    (".feishu.cn", "session"),
                    ("open.feishu.cn", "session"),
                    (
                        "thundersoft.feishu.cn",
                        "x-tt-env-corehr-approvals-web",
                    ),
                ]
            ),
            "thundersoft.feishu.cn",
        )
        self.assertEqual(
            collector.people_tenant_host_from_cookies(
                [(".feishu.cn", "session")]
            ),
            "",
        )

    def test_ephemeral_browser_cookies_are_strictly_allowlisted(self):
        cookies = collector.allowed_approval_browser_cookies(
            [
                {
                    "domain": "i.thundersoft.com",
                    "name": "session",
                    "value": "safe-in-memory",
                    "path": "/",
                    "secure": True,
                    "expires": -1,
                },
                {
                    "domain": "i.thundersoft.com.evil.example",
                    "name": "session",
                    "value": "must-be-rejected",
                },
            ]
        )
        self.assertEqual(len(cookies), 1)
        self.assertEqual(cookies[0]["domain"], "i.thundersoft.com")
        self.assertIsNone(cookies[0]["expires"])

    def test_expected_oa_oauth_consent_is_authorized(self):
        valid_url = (
            "https://accounts.feishu.cn/open-apis/authen/v1/index?"
            "private=query"
        )
        self.assertTrue(collector.approval_oauth_consent_page(valid_url))
        self.assertFalse(
            collector.approval_oauth_consent_page(
                "https://accounts.feishu.cn.evil.example/"
                "open-apis/authen/v1/index"
            )
        )
        button = mock.Mock()
        button.is_visible.return_value = True
        button.is_enabled.return_value = True
        role = mock.Mock()
        role.first = button
        page = mock.Mock(url=valid_url)
        page.get_by_role.return_value = role

        self.assertTrue(collector.authorize_approval_oauth_consent(page))
        page.get_by_role.assert_called_once_with(
            "button",
            name=collector.APPROVAL_OAUTH_AUTHORIZE_TEXT_RE,
        )
        button.click.assert_called_once_with(timeout=3000)

    def test_run_closes_only_the_chrome_it_started_on_failure(self):
        args = self.pipeline_args(use_approval_browser=True)
        process = mock.Mock()
        process.poll.return_value = None
        session = collector.ApprovalChromeSession(
            collector.DEFAULT_APPROVAL_CDP,
            process,
        )
        with (
            mock.patch.object(collector, "assert_user_ready"),
            mock.patch.object(collector, "assert_approval_scope"),
            mock.patch.object(
                collector,
                "ensure_approval_chrome",
                return_value=session,
            ),
            mock.patch.object(
                collector,
                "resolve_chat_id",
                return_value=("oc_x", "explicit"),
            ),
            mock.patch.object(
                collector,
                "fetch_chat_messages",
                return_value=([], 1, False),
            ),
            mock.patch.object(
                collector,
                "collect_approval_adjustments",
                side_effect=collector.CollectorError("test failure"),
            ),
            mock.patch.object(collector, "stop_approval_chrome") as stop,
        ):
            with self.assertRaises(collector.CollectorError):
                collector.run(args)
        stop.assert_called_once_with(session)

    def test_run_uses_direct_api_by_default_without_starting_chrome(self):
        args = self.pipeline_args()
        raw = [
            {
                "message_id": "private-message",
                "msg_type": "interactive",
                "create_time": "2026-07-23 09:00",
                "message_position": "1",
                "deleted": False,
                "content": '<card title="上班打卡成功!">正常</card>',
            }
        ]
        with tempfile.TemporaryDirectory() as directory:
            args.output = Path(directory) / "messages.json"
            with (
                mock.patch.object(collector, "assert_user_ready"),
                mock.patch.object(collector, "assert_approval_scope"),
                mock.patch.object(collector, "resolve_chat_id", return_value=("oc_x", "explicit")),
                mock.patch.object(
                    collector,
                    "fetch_chat_messages",
                    return_value=(raw, 1, False),
                ),
                mock.patch.object(
                    collector,
                    "collect_approval_adjustments",
                    return_value=collector.ApprovalCollection(True, []),
                ) as collect,
                mock.patch.object(collector, "ensure_approval_chrome") as ensure,
            ):
                collector.run(args)

        ensure.assert_not_called()
        self.assertEqual(
            collect.call_args.kwargs["approval_profile"],
            collector.DEFAULT_APPROVAL_PROFILE,
        )
        self.assertEqual(collect.call_args.kwargs["approval_cdp"], "")
        self.assertTrue(collect.call_args.kwargs["auto_login"])
        self.assertEqual(
            collect.call_args.kwargs["approval_login_cdp"],
            collector.DEFAULT_APPROVAL_CDP,
        )

    def test_run_reports_missing_scope_before_starting_chrome(self):
        args = self.pipeline_args(approval_cdp=collector.DEFAULT_APPROVAL_CDP)
        missing = collector.CollectorError(
            "缺少审批只读权限 approval:instance:read"
        )
        with (
            mock.patch.object(collector, "assert_user_ready"),
            mock.patch.object(
                collector,
                "assert_approval_scope",
                side_effect=missing,
            ),
            mock.patch.object(collector, "ensure_approval_chrome") as ensure,
        ):
            with self.assertRaisesRegex(
                collector.CollectorError,
                "approval:instance:read",
            ):
                collector.run(args)
        ensure.assert_not_called()

    def test_sanitize_and_normalize_interactive_message(self):
        raw = [
            {
                "chat_id": "must-not-be-exported",
                "message_id": "must-not-be-exported",
                "msg_type": "interactive",
                "create_time": "2026-07-23 09:24",
                "message_position": "281",
                "deleted": False,
                "content": (
                    '<card title="上班打卡成功!">\n'
                    "打卡方式：通过考勤机打卡\n"
                    "[查看详情](https://example.invalid/private?id=secret)\n"
                    "</card>"
                ),
            }
        ]
        messages = collector.normalize_messages(raw)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["date"], "2026-07-23")
        self.assertEqual(messages[0]["time"], "09:24")
        self.assertEqual(messages[0]["message_type"], 13)
        self.assertIn("上班打卡成功", messages[0]["text"])
        self.assertIn("查看详情", messages[0]["text"])
        serialized = json.dumps(messages, ensure_ascii=False)
        self.assertNotIn("example.invalid", serialized)
        self.assertNotIn("must-not-be-exported", serialized)

    def test_find_attendance_chats_paginates(self):
        responses = [
            {
                "ok": True,
                "data": {
                    "chats": [{"chat_id": "oc_other", "name": "普通会话"}],
                    "has_more": True,
                    "page_token": "next-page",
                },
            },
            {
                "ok": True,
                "data": {
                    "chats": [{"chat_id": "oc_attendance", "name": "Attendance Bot"}],
                    "has_more": False,
                    "page_token": "",
                },
            },
        ]
        with mock.patch.object(
            collector,
            "invoke_lark_cli",
            side_effect=responses,
        ) as invoke:
            matches = collector.find_attendance_chats(
                "lark-cli",
                collector.DEFAULT_CHAT_PATTERN,
                60,
            )
        self.assertEqual([chat["chat_id"] for chat in matches], ["oc_attendance"])
        self.assertEqual(invoke.call_count, 2)
        self.assertIn("--page-token", invoke.call_args_list[1].args[1])

    def test_fetch_chat_messages_paginates_and_deduplicates(self):
        first = {
            "message_id": "m1",
            "content": "上班打卡成功",
            "create_time": "2026-07-23 09:00",
        }
        second = {
            "message_id": "m2",
            "content": "下班打卡成功",
            "create_time": "2026-07-23 18:00",
        }
        responses = [
            {
                "ok": True,
                "data": {
                    "messages": [first],
                    "has_more": True,
                    "page_token": "next-page",
                },
            },
            {
                "ok": True,
                "data": {
                    "messages": [first, second],
                    "has_more": False,
                    "page_token": "",
                },
            },
        ]
        with mock.patch.object(
            collector,
            "invoke_lark_cli",
            side_effect=responses,
        ):
            messages, pages, truncated = collector.fetch_chat_messages(
                "lark-cli",
                "oc_attendance",
                50,
                60,
            )
        self.assertEqual([message["message_id"] for message in messages], ["m1", "m2"])
        self.assertEqual(pages, 2)
        self.assertFalse(truncated)

    def test_parse_patch_approval_uses_punch_side_and_overnight_date(self):
        instance = {
            "definition_name": "【我要补签】",
            "summaries": [],
        }
        detail = {
            "definition_name": "我要补签",
            "form": json.dumps(
                [
                    {
                        "id": "widgetRemedyGroupV2",
                        "type": "remedyGroupV2",
                        "value": [
                            {
                                "id": "widgetRemedyTime",
                                "name": "补签卡时间",
                                "type": "date",
                                "value": "2026-07-09T02:15:00+08:00",
                            },
                            {
                                "id": "widgetRemedyType",
                                "name": "补签卡类型",
                                "type": "radioV2",
                                "value": "下班卡",
                            },
                        ],
                    }
                ],
                ensure_ascii=False,
            ),
        }
        self.assertEqual(
            collector.parse_approval_adjustments(detail, instance),
            [
                {
                    "date": "2026-07-08",
                    "type": "patch",
                    "clockOut": "02:15",
                    "clockOutNextDay": True,
                    "note": "审批：我要补签",
                }
            ],
        )

    def test_patch_detail_parser_whitelists_fields_and_uses_target_date(self):
        raw = json.dumps(
            {
                "bqkrq": "2026-07-08",
                "remedy_time": "2026-07-09 02:15:00",
                "work_type": "2",
                "employee_id": "must-not-be-exported",
                "authStr": "secret-signature",
                "reason": "private reason",
            },
            ensure_ascii=False,
        )
        adjustment = collector.patch_adjustment_from_detail(raw, "我要补签")
        self.assertEqual(
            adjustment,
            {
                "date": "2026-07-08",
                "type": "patch",
                "clockOut": "02:15",
                "clockOutNextDay": True,
                "note": "审批：我要补签",
            },
        )
        serialized = json.dumps(adjustment, ensure_ascii=False)
        self.assertNotIn("must-not-be-exported", serialized)
        self.assertNotIn("secret-signature", serialized)
        self.assertNotIn("private reason", serialized)

    def test_patch_detail_parser_keeps_multiple_rows_and_deduplicates(self):
        values = [
            json.dumps(
                {
                    "bqkrq": "2026-04-06",
                    "remedy_time": "2026-04-06 10:00:00",
                    "work_type": 1,
                }
            ),
            json.dumps(
                {
                    "bqkrq": "2026-04-06",
                    "remedy_time": "2026-04-06 21:00:00",
                    "work_type": 2,
                }
            ),
        ]
        adjustments = collector.patch_adjustments_from_detail_values(
            [*values, values[0]],
            "我要补签",
        )
        self.assertEqual(len(adjustments), 2)
        self.assertEqual(adjustments[0]["clockIn"], "10:00")
        self.assertEqual(adjustments[1]["clockOut"], "21:00")

    def test_parse_leave_approval_expands_and_distinguishes_half_days(self):
        instance = {"definition_name": "休假申请流程", "summaries": []}
        detail = {
            "definition_name": "休假申请流程",
            "form": json.dumps(
                [
                    {
                        "id": "widgetLeaveGroupV2",
                        "type": "leaveGroupV2",
                        "value": [
                            {
                                "id": "widgetLeaveGroupStartTime",
                                "name": "开始时间",
                                "type": "date",
                                "value": "2026-07-08T13:30:00+08:00",
                            },
                            {
                                "id": "widgetLeaveGroupEndTime",
                                "name": "结束时间",
                                "type": "date",
                                "value": "2026-07-10T12:00:00+08:00",
                            },
                        ],
                    }
                ],
                ensure_ascii=False,
            ),
        }
        adjustments = collector.parse_approval_adjustments(detail, instance)
        self.assertEqual(
            [(item["date"], item["type"]) for item in adjustments],
            [
                ("2026-07-08", "leave-pm"),
                ("2026-07-09", "leave-full"),
                ("2026-07-10", "leave-am"),
            ],
        )

    def test_leave_page_halves_cover_full_partial_and_cross_day(self):
        cases = [
            (
                ("2026-07-13", "AM", "2026-07-13", "AM"),
                [("2026-07-13", "leave-am")],
            ),
            (
                ("2026-07-13", "PM", "2026-07-13", "PM"),
                [("2026-07-13", "leave-pm")],
            ),
            (
                ("2026-07-13", "AM", "2026-07-13", "PM"),
                [("2026-07-13", "leave-full")],
            ),
            (
                ("2026-07-13", "PM", "2026-07-15", "AM"),
                [
                    ("2026-07-13", "leave-pm"),
                    ("2026-07-14", "leave-full"),
                    ("2026-07-15", "leave-am"),
                ],
            ),
        ]
        for inputs, expected in cases:
            with self.subTest(inputs=inputs):
                adjustments = collector.leave_adjustments_from_halves(
                    *inputs,
                    "休假申请流程",
                )
                self.assertEqual(
                    [(item["date"], item["type"]) for item in adjustments],
                    expected,
                )

        self.assertEqual(
            collector.leave_adjustments_from_halves(
                "2026-07-13",
                "PM",
                "2026-07-13",
                "AM",
                "休假申请流程",
            ),
            [],
        )

    def test_leave_page_text_supports_english_and_chinese_labels(self):
        english = (
            "Start time\n2026-07-13 AM\n"
            "End time\n2026-07-13 PM\nDuration\n1 day"
        )
        chinese = "开始时间：2026-07-14 下午\n结束时间：2026-07-14 下午"
        self.assertEqual(
            collector.leave_adjustments_from_page_text(
                english,
                "休假申请流程",
            )[0]["type"],
            "leave-full",
        )
        self.assertEqual(
            collector.leave_adjustments_from_page_text(
                chinese,
                "休假申请流程",
            )[0]["type"],
            "leave-pm",
        )

    def test_people_leave_form_uses_structured_dates_and_halves(self):
        epoch = date(1970, 1, 1)
        start = str((date(2026, 7, 13) - epoch).days)
        end = str((date(2026, 7, 15) - epoch).days)
        form = {
            "fields": [
                {
                    "form_type": "custom_widget_leave_time",
                    "multi_values": {
                        "leave_time": {
                            "record_value": {
                                "field_values": [
                                    {
                                        "field_name": "start_date",
                                        "value": {
                                            "date_value": {"value": start}
                                        },
                                    },
                                    {
                                        "field_name": "start_half_day",
                                        "value": {
                                            "enum_value": {
                                                "name": {
                                                    "zh-CN": "下午",
                                                    "en-US": "Afternoon",
                                                }
                                            }
                                        },
                                    },
                                    {
                                        "field_name": "end_date",
                                        "value": {
                                            "date_value": {"value": end}
                                        },
                                    },
                                    {
                                        "field_name": "end_half_day",
                                        "value": {
                                            "enum_value": {
                                                "name": {
                                                    "en-US": "Morning",
                                                }
                                            }
                                        },
                                    },
                                    {
                                        "field_name": "private_reason",
                                        "value": {
                                            "text_value": {
                                                "value": "must-not-be-exported"
                                            }
                                        },
                                    },
                                ]
                            }
                        }
                    },
                }
            ]
        }
        adjustments = collector.leave_adjustments_from_people_form(
            json.dumps(form, ensure_ascii=False),
            "休假申请流程",
        )
        self.assertEqual(
            [(item["date"], item["type"]) for item in adjustments],
            [
                ("2026-07-13", "leave-pm"),
                ("2026-07-14", "leave-full"),
                ("2026-07-15", "leave-am"),
            ],
        )
        self.assertNotIn(
            "must-not-be-exported",
            json.dumps(adjustments, ensure_ascii=False),
        )

    def test_patch_api_payload_retains_only_whitelisted_detail_values(self):
        safe_value = json.dumps(
            {
                "bqkrq": "2026-07-08",
                "remedy_time": "2026-07-08 09:05:00",
                "work_type": "1",
                "reason": "private",
            }
        )
        payload = {
            "detail_1": {
                "rowDatas": {
                    "row_0": {
                        "field66222": {"value": safe_value},
                        "field99999": {"value": "must-not-be-read"},
                    }
                }
            }
        }
        self.assertEqual(
            collector.patch_values_from_oa_payload(
                payload,
                ["detail_1"],
            ),
            [safe_value],
        )
        self.assertEqual(
            collector.patch_detail_marks_from_oa_form(
                {
                    "tableInfo": {
                        "detail_1": {
                            "fieldinfomap": {
                                "66222": {"fieldlabel": "safe"}
                            }
                        },
                        "detail_2": {
                            "fieldinfomap": {
                                "99999": {"fieldlabel": "private"}
                            }
                        },
                    }
                }
            ),
            ["detail_1"],
        )

    def test_parse_travel_approval_includes_both_ends_and_middle_dates(self):
        instance = {"definition_name": "我的出差", "summaries": []}
        detail = {
            "definition_name": "我的出差",
            "form": json.dumps(
                [
                    {
                        "id": "tripDates",
                        "name": "出差日期",
                        "type": "dateInterval",
                        "value": {
                            "start": "2026-07-10T09:00:00+08:00",
                            "end": "2026-07-13T18:00:00+08:00",
                        },
                    }
                ],
                ensure_ascii=False,
            ),
        }
        adjustments = collector.parse_approval_adjustments(detail, instance)
        self.assertEqual(
            [item["date"] for item in adjustments],
            ["2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"],
        )
        self.assertTrue(all(item["type"] == "travel" for item in adjustments))

    def test_collect_approvals_only_uses_approved_target_flows_and_hides_ids(self):
        approved = {
            "instance_code": "private-approved-instance",
            "definition_name": "我要补签",
            "instance_status": "2",
            "summaries": [
                {"key": "补签卡类型", "value": "上班卡"},
                {"key": "补签卡时间", "value": "2026-07-08 09:05"},
            ],
        }
        responses = [
            {
                "ok": True,
                "data": {
                    "instances": [
                        approved,
                        {
                            "instance_code": "private-rejected-instance",
                            "definition_name": "我的出差",
                            "instance_status": "3",
                        },
                        {
                            "instance_code": "private-unrelated-instance",
                            "definition_name": "采购申请",
                            "instance_status": "2",
                        },
                    ],
                    "has_more": False,
                },
            },
            {
                "ok": True,
                "data": {
                    "instance_code": "private-approved-instance",
                    "definition_name": "我要补签",
                    "status": "APPROVED",
                    "reverted": False,
                    "form": "[]",
                },
            },
        ]
        with mock.patch.object(
            collector,
            "invoke_lark_cli",
            side_effect=responses,
        ) as invoke:
            approvals = collector.collect_approval_adjustments("lark-cli", 60)

        self.assertEqual(approvals.scanned_instances, 3)
        self.assertEqual(approvals.matched_instances, 2)
        self.assertEqual(approvals.approved_instances, 1)
        self.assertEqual(approvals.unparsed_instances, 0)
        self.assertEqual(approvals.adjustments[0]["clockIn"], "09:05")
        self.assertEqual(invoke.call_count, 2)
        payload = collector.build_payload(
            [],
            raw_message_count=0,
            pages=0,
            truncated=False,
            chat_lookup="name_pattern",
            start="",
            end="",
            approvals=approvals,
        )
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("private-approved-instance", serialized)
        self.assertNotIn("private-rejected-instance", serialized)
        self.assertNotIn("private-unrelated-instance", serialized)
        self.assertEqual(payload["source"]["approval_adjustments"], 1)

    def test_external_approvals_use_labeled_summary_dates_without_guessing_patch_time(self):
        responses = [
            {
                "ok": True,
                "data": {
                    "instances": [
                        {
                            "instance_code": "private-trip-code",
                            "instance_external_id": "private-trip-external-id",
                            "definition_name": "我的出差",
                            "instance_status": 2,
                            "summaries": [
                                {
                                    "key": "流程标题",
                                    "value": (
                                        "我的出差-申请日期2026-04-13"
                                        "（开始日期:2026-03-31, 结束日期:2026-04-08）"
                                    ),
                                }
                            ],
                        },
                        {
                            "instance_code": "private-patch-code",
                            "instance_external_id": "private-patch-external-id",
                            "definition_name": "我要补签",
                            "instance_status": 2,
                            "summaries": [
                                {
                                    "key": "流程标题",
                                    "value": "我要补签-2026-07-22",
                                },
                                {
                                    "key": "提单时间",
                                    "value": "2026-07-22 10:16:32",
                                },
                            ],
                        },
                    ],
                    "has_more": False,
                },
            }
        ]
        with mock.patch.object(
            collector,
            "invoke_lark_cli",
            side_effect=responses,
        ) as invoke:
            approvals = collector.collect_approval_adjustments("lark-cli", 60)

        self.assertEqual(invoke.call_count, 1, "三方审批不应误调用原生实例详情接口")
        self.assertEqual(approvals.unparsed_instances, 1)
        self.assertEqual(
            [item["date"] for item in approvals.adjustments],
            [
                "2026-03-31",
                "2026-04-01",
                "2026-04-02",
                "2026-04-03",
                "2026-04-04",
                "2026-04-05",
                "2026-04-06",
                "2026-04-07",
                "2026-04-08",
            ],
        )
        self.assertTrue(all(item["type"] == "travel" for item in approvals.adjustments))

    def test_external_approval_urls_are_strictly_allowlisted(self):
        valid_patch = (
            "https://larkapproval.thundersoft.com/sso/login?"
            "redirectUrl=https%3A%2F%2Fi.thundersoft.com%2Fspa%2Fworkflow%2F"
            "static4form%2Findex.html%23%2Fmain%2Fworkflow%2Freq%3Frequestid%3D1"
        )
        self.assertEqual(collector.patch_detail_url(valid_patch), valid_patch)
        self.assertEqual(
            collector.patch_detail_url(
                "https://larkapproval.thundersoft.com/sso/login?"
                "redirectUrl=https%3A%2F%2Fevil.example%2Fsteal"
            ),
            "",
        )
        self.assertTrue(
            collector.leave_detail_url(
                "https://people.feishu.cn/people/approvals/iframe/applicant?id=1"
            )
        )
        self.assertEqual(
            collector.leave_detail_url(
                "https://people.feishu.cn.evil.example/approvals/applicant"
            ),
            "",
        )
        with self.assertRaises(collector.CollectorError):
            collector.normalize_approval_cdp_endpoint("http://example.com:9238")

    def test_oa_oauth_redirect_is_treated_as_expired_login(self):
        response = mock.Mock(
            status_code=302,
            headers={
                "location": (
                    "https://open.feishu.cn/open-apis/authen/v1/index?"
                    "redirect_uri=private"
                )
            },
        )
        session = mock.Mock()
        session.get.return_value = response
        target = (
            "https://larkapproval.thundersoft.com/sso/login?"
            "redirectUrl=https%3A%2F%2Fi.thundersoft.com%2Fspa%2Fworkflow%2F"
            "static4form%2Findex.html%23%2Fmain%2Fworkflow%2Freq%3Frequestid%3D1"
        )
        with self.assertRaises(collector.ApprovalSessionError) as raised:
            collector.open_oa_approval_form(session, target, 60)
        self.assertEqual(raised.exception.status, "login_required")

    def test_leave_without_tenant_cookie_requires_login(self):
        instance = {
            "definition_name": "休假申请流程",
            "link": (
                "https://people.feishu.cn/people/approvals/iframe/applicant?"
                "id=process&node_id=node"
            ),
        }
        with self.assertRaises(collector.ApprovalSessionError) as raised:
            collector.fetch_leave_adjustments_http(
                mock.Mock(),
                "",
                instance,
                60,
            )
        self.assertEqual(raised.exception.status, "login_required")

    def test_external_patch_and_leave_details_complete_unparsed_instances(self):
        responses = [
            {
                "ok": True,
                "data": {
                    "instances": [
                        {
                            "instance_code": "private-patch-code",
                            "instance_external_id": "private-patch-external",
                            "definition_name": "我要补签",
                            "instance_status": 2,
                            "link": (
                                "https://larkapproval.thundersoft.com/sso/login?"
                                "redirectUrl=https%3A%2F%2Fi.thundersoft.com"
                            ),
                            "summaries": [],
                        },
                        {
                            "instance_code": "private-leave-code",
                            "instance_external_id": "private-leave-external",
                            "definition_name": "休假申请流程",
                            "instance_status": 2,
                            "link": (
                                "https://people.feishu.cn/people/approvals/"
                                "iframe/applicant?id=1"
                            ),
                            "summaries": [],
                        },
                    ],
                    "has_more": False,
                },
            }
        ]
        detail_result = collector.ExternalApprovalCollection(
            "ready",
            [
                {
                    "date": "2026-07-08",
                    "type": "patch",
                    "clockIn": "09:05",
                    "note": "审批：我要补签",
                },
                {
                    "date": "2026-07-13",
                    "type": "leave-full",
                    "note": "审批：休假申请流程",
                },
            ],
            parsed_instances=2,
        )
        with (
            mock.patch.object(
                collector,
                "invoke_lark_cli",
                side_effect=responses,
            ),
            mock.patch.object(
                collector,
                "collect_external_approval_adjustments",
                return_value=detail_result,
            ) as browser_details,
        ):
            approvals = collector.collect_approval_adjustments(
                "lark-cli",
                60,
                approval_cdp="http://127.0.0.1:9238",
            )

        self.assertEqual(approvals.unparsed_instances, 0)
        self.assertEqual(approvals.detail_collection_status, "ready")
        self.assertEqual(approvals.detail_instances_parsed, 2)
        self.assertEqual(len(approvals.adjustments), 2)
        browser_details.assert_called_once()
        self.assertEqual(
            browser_details.call_args.args[1],
            "http://127.0.0.1:9238",
        )

    def test_external_details_use_direct_api_when_profile_is_supplied(self):
        responses = [
            {
                "ok": True,
                "data": {
                    "instances": [
                        {
                            "instance_code": "private-patch-code",
                            "instance_external_id": "private-patch-external",
                            "definition_name": "我要补签",
                            "instance_status": 2,
                            "link": (
                                "https://larkapproval.thundersoft.com/sso/login?"
                                "redirectUrl=https%3A%2F%2Fi.thundersoft.com"
                            ),
                            "summaries": [],
                        }
                    ],
                    "has_more": False,
                },
            }
        ]
        direct_result = collector.ExternalApprovalCollection(
            "ready",
            [
                {
                    "date": "2026-07-08",
                    "type": "patch",
                    "clockIn": "09:05",
                    "note": "审批：我要补签",
                }
            ],
            parsed_instances=1,
            method="direct_api",
        )
        with (
            mock.patch.object(
                collector,
                "invoke_lark_cli",
                side_effect=responses,
            ),
            mock.patch.object(
                collector,
                "collect_external_approval_adjustments_http",
                return_value=direct_result,
            ) as direct_details,
            mock.patch.object(
                collector,
                "collect_external_approval_adjustments",
            ) as browser_details,
        ):
            approvals = collector.collect_approval_adjustments(
                "lark-cli",
                60,
                approval_profile=collector.DEFAULT_APPROVAL_PROFILE,
            )

        self.assertEqual(approvals.detail_collection_method, "direct_api")
        self.assertEqual(approvals.unparsed_instances, 0)
        direct_details.assert_called_once_with(
            mock.ANY,
            collector.DEFAULT_APPROVAL_PROFILE,
            60,
        )
        browser_details.assert_not_called()

    def test_direct_api_failure_preserves_safe_stage_reason(self):
        reason = "无法只读打开审批专用 Chrome Cookie 数据库。"
        with mock.patch.object(
            collector,
            "approval_http_session",
            side_effect=collector.ApprovalSessionError(
                "unavailable",
                reason,
            ),
        ):
            result = collector.collect_external_approval_adjustments_http(
                [{"definition_name": "我要补签"}],
                collector.DEFAULT_APPROVAL_PROFILE,
                60,
            )
        self.assertEqual(result.status, "unavailable")
        self.assertEqual(result.message, reason)

    def test_expired_direct_session_shows_qr_then_retries_once(self):
        responses = [
            {
                "ok": True,
                "data": {
                    "instances": [
                        {
                            "instance_code": "private-patch-code",
                            "instance_external_id": "private-patch-external",
                            "definition_name": "我要补签",
                            "instance_status": 2,
                            "link": (
                                "https://larkapproval.thundersoft.com/sso/login?"
                                "redirectUrl=https%3A%2F%2Fi.thundersoft.com%2F"
                                "spa%2Fworkflow%2Fstatic4form%2Findex.html%23%2F"
                                "main%2Fworkflow%2Freq%3Frequestid%3D1"
                            ),
                            "summaries": [],
                        }
                    ],
                    "has_more": False,
                },
            }
        ]
        expired = collector.ExternalApprovalCollection(
            "login_required",
            [],
            method="direct_api",
        )
        ready = collector.ExternalApprovalCollection(
            "ready",
            [
                {
                    "date": "2026-07-08",
                    "type": "patch",
                    "clockIn": "09:05",
                    "note": "审批：我要补签",
                }
            ],
            parsed_instances=1,
            method="direct_api",
        )
        refreshed_cookie = {
            "domain": "i.thundersoft.com",
            "name": "session",
            "value": "must-not-be-printed",
            "path": "/",
            "secure": True,
            "expires": None,
        }
        with (
            mock.patch.object(
                collector,
                "invoke_lark_cli",
                side_effect=responses,
            ),
            mock.patch.object(
                collector,
                "collect_external_approval_adjustments_http",
                side_effect=[expired, ready],
            ) as direct_details,
            mock.patch.object(
                collector,
                "establish_approval_web_session",
                return_value=collector.ApprovalSessionRefresh(
                    "ready",
                    (refreshed_cookie,),
                ),
            ) as login,
        ):
            approvals = collector.collect_approval_adjustments(
                "lark-cli",
                60,
                approval_profile=collector.DEFAULT_APPROVAL_PROFILE,
                auto_login=True,
                approval_login_cdp=collector.DEFAULT_APPROVAL_CDP,
            )

        self.assertEqual(direct_details.call_count, 2)
        self.assertEqual(
            direct_details.call_args_list[1].kwargs[
                "supplemental_cookies"
            ],
            (refreshed_cookie,),
        )
        login.assert_called_once()
        self.assertEqual(approvals.detail_collection_status, "ready")
        self.assertEqual(approvals.unparsed_instances, 0)
        self.assertEqual(len(approvals.adjustments), 1)
        self.assertTrue(approvals.detail_login_refreshed)
        self.assertNotIn(
            "must-not-be-printed",
            repr(
                collector.ApprovalSessionRefresh(
                    "ready",
                    (refreshed_cookie,),
                )
            ),
        )

    def test_run_does_not_persist_identity_or_chat_id(self):
        args = argparse.Namespace(
            cli="lark-cli",
            chat_id="oc_private",
            chat_pattern=collector.DEFAULT_CHAT_PATTERN,
            start="",
            end="",
            page_size=50,
            max_pages=0,
            timeout=60,
            output=None,
            quiet=True,
        )
        raw = [
            {
                "message_id": "private-message",
                "msg_type": "interactive",
                "create_time": "2026-07-23 09:00",
                "message_position": "1",
                "deleted": False,
                "content": '<card title="上班打卡成功!">正常</card>',
            }
        ]
        with tempfile.TemporaryDirectory() as directory:
            args.output = Path(directory) / "messages.json"
            with (
                mock.patch.object(collector, "assert_user_ready"),
                mock.patch.object(collector, "assert_approval_scope"),
                mock.patch.object(
                    collector,
                    "fetch_chat_messages",
                    return_value=(raw, 1, False),
                ),
                mock.patch.object(
                    collector,
                    "collect_approval_adjustments",
                    return_value=collector.ApprovalCollection(True, []),
                ),
            ):
                payload = collector.run(args)
            serialized = json.dumps(payload, ensure_ascii=False)
            self.assertNotIn("oc_private", serialized)
            self.assertNotIn("private-message", serialized)
            self.assertEqual(payload["source"]["method"], "lark-cli-user-im")
            self.assertEqual(json.loads(args.output.read_text("utf-8")), payload)

    def test_run_never_calls_lark_attendance_service(self):
        calls = []

        def fake_invoke(_cli, arguments, _timeout):
            calls.append(arguments)
            if arguments[0] == "whoami":
                return {
                    "available": True,
                    "identity": "user",
                    "tokenStatus": "ready",
                }
            if arguments[0] == "auth":
                return {
                    "ok": True,
                    "granted": [collector.APPROVAL_READ_SCOPE],
                    "missing": None,
                }
            if arguments[0] == "im":
                return {
                    "ok": True,
                    "data": {
                        "messages": [
                            {
                                "message_id": "private-message",
                                "msg_type": "interactive",
                                "create_time": "2026-07-23 09:00",
                                "message_position": "1",
                                "deleted": False,
                                "content": '<card title="上班打卡成功!">正常</card>',
                            }
                        ],
                        "has_more": False,
                    },
                }
            if arguments[0] == "approval":
                return {
                    "ok": True,
                    "data": {
                        "instances": [],
                        "has_more": False,
                    },
                }
            self.fail(f"出现未预期的 lark-cli 服务：{arguments[0]}")

        with tempfile.TemporaryDirectory() as directory:
            args = self.pipeline_args(
                output=Path(directory) / "messages.json",
            )
            with mock.patch.object(
                collector,
                "invoke_lark_cli",
                side_effect=fake_invoke,
            ):
                collector.run(args)

        self.assertEqual(
            [call[0] for call in calls],
            ["whoami", "auth", "im", "approval"],
        )
        self.assertFalse(any(call[0] == "attendance" for call in calls))

    def test_summarizer_receives_report_options(self):
        args = self.pipeline_args(
            report_period="custom",
            report_start="2026-06-25",
            report_end="2026-07-24",
            config=Path("/tmp/config.json"),
            manual=Path("/tmp/manual.json"),
            now="2026-07-23",
        )
        report = {
            "schema_version": 1,
            "period": {},
            "totals": {},
            "rows": [],
        }
        completed = mock.Mock(returncode=0, stdout="", stderr="")
        with (
            mock.patch.object(collector.subprocess, "run", return_value=completed) as invoke,
            mock.patch.object(collector, "load_report", return_value=report) as load,
        ):
            actual = collector.run_summarizer(args)

        self.assertIs(actual, report)
        command = invoke.call_args.args[0]
        self.assertEqual(command[:2], ["node", str(collector.SUMMARIZER)])
        self.assertIn("--quiet", command)
        self.assertEqual(command[command.index("--period") + 1], "custom")
        self.assertEqual(command[command.index("--start") + 1], "2026-06-25")
        self.assertEqual(command[command.index("--end") + 1], "2026-07-24")
        self.assertEqual(command[command.index("--config") + 1], "/tmp/config.json")
        self.assertEqual(command[command.index("--manual") + 1], "/tmp/manual.json")
        self.assertEqual(command[command.index("--now") + 1], "2026-07-23")
        load.assert_called_once_with(args.report_json)

    def test_summarizer_merges_approval_adjustments_into_travel_workdays(self):
        payload = {
            "schema_version": 1,
            "collected_at": "2026-07-14T12:00:00+08:00",
            "source": {
                "method": "test",
                "approval_collection_enabled": True,
                "approval_instances_matched": 1,
                "approval_instances_approved": 1,
                "approval_instances_unparsed": 0,
            },
            "messages": [],
            "approval_adjustments": [
                {
                    "date": date,
                    "type": "travel",
                    "note": "审批：我的出差",
                }
                for date in (
                    "2026-07-10",
                    "2026-07-11",
                    "2026-07-12",
                    "2026-07-13",
                )
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.json"
            output_path = Path(directory) / "report.json"
            input_path.write_text(
                json.dumps(payload, ensure_ascii=False),
                encoding="utf-8",
            )
            completed = subprocess.run(
                [
                    "node",
                    str(collector.SUMMARIZER),
                    "--input",
                    str(input_path),
                    "--output",
                    str(output_path),
                    "--period",
                    "custom",
                    "--start",
                    "2026-07-10",
                    "--end",
                    "2026-07-13",
                    "--now",
                    "2026-07-14",
                    "--quiet",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            report = json.loads(output_path.read_text("utf-8"))
        self.assertEqual(report["source"]["approval_adjustment_count"], 4)
        self.assertEqual(report["totals"]["travelWorkDays"], 2)
        self.assertEqual(report["totals"]["averageWorkDays"], 2)
        self.assertEqual(report["totals"]["averageWorkMinutes"], 8 * 60)

    def test_pipeline_generates_and_opens_html(self):
        args = self.pipeline_args()
        payload = {"source": {}, "messages": []}
        report = {
            "schema_version": 1,
            "period": {},
            "totals": {},
            "rows": [],
        }
        html_path = args.report_html.resolve()
        with (
            mock.patch.object(collector, "run", return_value=payload),
            mock.patch.object(collector, "run_summarizer", return_value=report),
            mock.patch.object(
                collector,
                "write_report_html",
                return_value=html_path,
            ) as render,
            mock.patch.object(collector, "open_report", return_value=True) as open_html,
        ):
            result = collector.run_pipeline(args)

        self.assertEqual(result.payload, payload)
        self.assertEqual(result.report, report)
        self.assertEqual(result.html_path, html_path)
        self.assertTrue(result.opened)
        render.assert_called_once_with(report, args.report_html)
        open_html.assert_called_once_with(html_path)

    def test_pipeline_no_open_skips_browser(self):
        args = self.pipeline_args(no_open=True)
        payload = {"source": {}, "messages": []}
        report = {
            "schema_version": 1,
            "period": {},
            "totals": {},
            "rows": [],
        }
        with (
            mock.patch.object(collector, "run", return_value=payload),
            mock.patch.object(collector, "run_summarizer", return_value=report),
            mock.patch.object(
                collector,
                "write_report_html",
                return_value=args.report_html,
            ),
            mock.patch.object(collector, "open_report") as open_html,
        ):
            result = collector.run_pipeline(args)

        self.assertFalse(result.opened)
        open_html.assert_not_called()

    def test_pipeline_adds_real_name_only_to_private_report(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.pipeline_args(
                report_json=Path(directory) / "report.json",
                report_html=Path(directory) / "report.html",
                no_open=True,
            )
            payload = {"source": {}, "messages": []}
            report = {
                "schema_version": 1,
                "period": {},
                "totals": {},
                "rows": [],
            }

            def fake_run(namespace):
                namespace._report_owner_name = "测试用户"
                return payload

            with (
                mock.patch.object(collector, "run", side_effect=fake_run),
                mock.patch.object(
                    collector,
                    "run_summarizer",
                    return_value=report,
                ),
                mock.patch.object(
                    collector,
                    "write_report_html",
                    return_value=args.report_html,
                ) as render,
            ):
                result = collector.run_pipeline(args)

            self.assertNotIn("owner_name", payload)
            self.assertEqual(result.report["owner_name"], "测试用户")
            self.assertEqual(
                json.loads(args.report_json.read_text("utf-8"))["owner_name"],
                "测试用户",
            )
            render.assert_called_once_with(result.report, args.report_html)

    def test_pipeline_shows_numbered_progress(self):
        args = self.pipeline_args(quiet=False, no_open=True)
        raw = [
            {
                "message_id": "private-message",
                "msg_type": "interactive",
                "create_time": "2026-07-23 09:00",
                "message_position": "1",
                "deleted": False,
                "content": '<card title="上班打卡成功!">正常</card>',
            }
        ]
        report = {
            "schema_version": 1,
            "period": {},
            "totals": {},
            "rows": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            args.output = Path(directory) / "messages.json"
            args.report_json = Path(directory) / "report.json"
            args.report_html = Path(directory) / "report.html"
            with (
                mock.patch.object(collector, "assert_user_ready"),
                mock.patch.object(collector, "assert_approval_scope"),
                mock.patch.object(
                    collector,
                    "resolve_chat_id",
                    return_value=("oc_x", "explicit"),
                ),
                mock.patch.object(
                    collector,
                    "fetch_chat_messages",
                    return_value=(raw, 1, False),
                ),
                mock.patch.object(
                    collector,
                    "collect_approval_adjustments",
                    return_value=collector.ApprovalCollection(True, []),
                ),
                mock.patch.object(
                    collector,
                    "run_summarizer",
                    return_value=report,
                ),
                redirect_stdout(io.StringIO()) as output,
            ):
                collector.run_pipeline(args)

        rendered = output.getvalue()
        for step in range(1, collector.PROGRESS_TOTAL_STEPS + 1):
            self.assertIn(f"[进度 {step}/8]", rendered)
        self.assertIn("读取 1 页、1 条原始消息", rendered)
        self.assertIn("处理完成（不打开浏览器）", rendered)


if __name__ == "__main__":
    unittest.main()
