#!/usr/bin/env python3

import stat
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "collector"))

import render_attendance_report as renderer  # noqa: E402


def sample_report() -> dict:
    return {
        "schema_version": 1,
        "owner_name": "测试用户",
        "generated_at": "2026-07-23T08:00:00.000Z",
        "source": {
            "method": "lark-cli-user-im",
            "message_count": 2,
        },
        "period": {
            "mode": "custom",
            "start": "2026-07-01",
            "end": "2026-07-02",
            "cycle": None,
        },
        "parsed_event_count": 2,
        "manual_adjustment_count": 1,
        "manual_adjustments": [],
        "config": {
            "rangeStart": "2026-07-01",
            "rangeEnd": "2026-07-02",
            "scheduleMode": "fixed",
            "workStart": "09:00",
            "workEnd": "18:00",
            "graceMinutes": 0,
            "workdays": [1, 2, 3, 4, 5],
            "holidayDates": "",
            "extraWorkDates": "",
            "noMessageAsMissing": False,
            "unknownSplitTime": "14:00",
            "overnightClockOutCutoff": "06:00",
        },
        "events": [
            {
                "date": "2026-07-01",
                "inTimes": ["09:00"],
                "outTimes": ["18:30"],
                "unknownTimes": [],
                "flags": {},
                "text": "上班及下班打卡",
            }
        ],
        "totals": {
            "workdays": 2,
            "attended": 1,
            "normal": 1,
            "abnormal": 0,
            "pending": 1,
            "overtimeMinutes": 30,
            "overtimeDays": 1,
            "averageOvertimeMinutes": 30,
            "averageWorkMinutes": 510,
            "completeWorkDays": 1,
        },
        "rows": [
            {
                "date": "2026-07-01",
                "weekday": "周三",
                "workday": True,
                "clockIn": "09:00",
                "clockOut": "18:30",
                "expectedOut": "18:00",
                "workDuration": "8小时",
                "workMinutes": 480,
                "overtime": "30分",
                "overtimeMinutes": 30,
                "duration": "9小时30分",
                "status": "正常",
                "abnormal": False,
                "pending": False,
                "manual": True,
                "manualLabel": "</script><script>window.pwned=true</script>",
                "evidenceCount": 2,
            },
            {
                "date": "2026-07-02",
                "weekday": "周四",
                "workday": True,
                "clockIn": "—",
                "clockOut": "—",
                "expectedOut": "—",
                "workDuration": "—",
                "workMinutes": None,
                "overtime": "—",
                "overtimeMinutes": 0,
                "duration": "—",
                "status": "待核对",
                "abnormal": False,
                "pending": True,
                "manual": False,
                "manualLabel": "",
                "evidenceCount": 0,
            },
        ],
    }


class ReportRendererTests(unittest.TestCase):
    def test_renders_single_file_and_escapes_embedded_json(self):
        rendered = renderer.render_report_html(sample_report())
        self.assertNotIn(renderer.DATA_PLACEHOLDER, rendered)
        self.assertNotIn(renderer.STYLES_PLACEHOLDER, rendered)
        self.assertNotIn(renderer.PARSER_PLACEHOLDER, rendered)
        self.assertNotIn(renderer.SCRIPT_PLACEHOLDER, rendered)
        self.assertIn("__FEISHU_ATTENDANCE_PARSER_ONLY__", rendered)
        self.assertIn("window.__ATTENDANCE_REPORT_READY__", rendered)
        self.assertIn('"owner_name":"测试用户"', rendered)
        self.assertNotIn("xxx的考勤报告", rendered)
        self.assertIn(".attention-card[hidden]", rendered)
        self.assertIn('<option value="holiday">法定节假日</option>', rendered)
        self.assertLess(
            rendered.index('id="daily-details"'),
            rendered.index('aria-labelledby="calculation-rules-title"'),
        )
        self.assertIn("法定节假日不参与计算", rendered)
        self.assertIn("\\u003c/script\\u003e", rendered)
        self.assertNotIn(
            "</script><script>window.pwned=true</script>",
            rendered,
        )
        self.assertNotIn("<script src=", rendered)
        self.assertNotIn("<link rel=\"stylesheet\"", rendered)

    def test_writes_private_html_file(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "nested" / "report.html"
            actual = renderer.write_report_html(sample_report(), output)
            self.assertEqual(actual, output.resolve())
            self.assertTrue(actual.read_text("utf-8").startswith("<!doctype html>"))
            self.assertEqual(stat.S_IMODE(actual.stat().st_mode), 0o600)

    def test_report_text_cannot_trigger_a_second_placeholder_pass(self):
        report = sample_report()
        report["rows"][0]["manualLabel"] = renderer.SCRIPT_PLACEHOLDER
        rendered = renderer.render_report_html(report)
        self.assertIn(
            f'"manualLabel":"{renderer.SCRIPT_PLACEHOLDER}"',
            rendered,
        )

    def test_rejects_unknown_report_schema(self):
        report = sample_report()
        report["schema_version"] = 2
        with self.assertRaisesRegex(renderer.ReportError, "版本"):
            renderer.render_report_html(report)


if __name__ == "__main__":
    unittest.main()
