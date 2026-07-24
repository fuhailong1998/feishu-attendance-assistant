#!/usr/bin/env python3
"""Render a local report in Chrome and audit responsive/interactivity states."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "collector"))

from render_attendance_report import write_report_html  # noqa: E402


CHINA_MAINLAND_2026_HOLIDAY_DATES = ", ".join(
    [f"2026-01-{day:02d}" for day in range(1, 4)]
    + [f"2026-02-{day:02d}" for day in range(15, 24)]
    + [f"2026-04-{day:02d}" for day in range(4, 7)]
    + [f"2026-05-{day:02d}" for day in range(1, 6)]
    + [f"2026-06-{day:02d}" for day in range(19, 22)]
    + [f"2026-09-{day:02d}" for day in range(25, 28)]
    + [f"2026-10-{day:02d}" for day in range(1, 8)]
)
CHINA_MAINLAND_2026_EXTRA_WORK_DATES = ", ".join(
    [
        "2026-01-04",
        "2026-02-14",
        "2026-02-28",
        "2026-05-09",
        "2026-09-20",
        "2026-10-10",
    ]
)


def fixture_report() -> dict:
    rows = []
    events = []
    start = date(2026, 7, 1)
    for offset in range(23):
        day = start + timedelta(days=offset)
        workday = day.weekday() < 5
        abnormal = workday and day.day in {3, 13}
        pending = workday and day.day in {7, 21}
        complete = workday and not pending
        overtime_minutes = (day.day % 4) * 25 if complete and not abnormal else 0
        clock_out_total = 18 * 60 + 30 + overtime_minutes
        clock_out = f"{clock_out_total // 60:02d}:{clock_out_total % 60:02d}"
        status = (
            "休息"
            if not workday
            else "迟到、早退"
            if abnormal
            else "待核对"
            if pending
            else "正常"
        )
        rows.append(
            {
                "date": day.isoformat(),
                "weekday": f"周{'一二三四五六日'[day.weekday()]}",
                "workday": workday,
                "clockIn": "09:12" if abnormal else "09:00" if complete else "—",
                "clockOut": "17:50" if abnormal else clock_out if complete else "—",
                "expectedOut": "18:12" if abnormal else "18:00" if workday else "—",
                "workDuration": "7小时8分" if abnormal else "8小时" if complete else "—",
                "workMinutes": 428 if abnormal else 480 if complete else None,
                "overtime": f"{overtime_minutes}分" if overtime_minutes else "0分",
                "overtimeMinutes": overtime_minutes,
                "duration": "8小时38分" if abnormal else "9小时30分" if complete else "—",
                "status": status,
                "abnormal": abnormal,
                "pending": pending,
                "manual": day.day == 9,
                "manualLabel": "本地补卡" if day.day == 9 else "",
                "evidenceCount": 2 if complete else 0,
            }
        )
        if complete:
            events.append(
                {
                    "date": day.isoformat(),
                    "inTimes": ["09:12" if abnormal else "09:00"],
                    "outTimes": ["17:50" if abnormal else clock_out],
                    "unknownTimes": [],
                    "flags": {
                        "late": abnormal,
                        "early": abnormal,
                    },
                    "text": f"{day.isoformat()} 测试打卡记录",
                }
            )
    events.append(
        {
            "date": "2026-06-03",
            "inTimes": ["09:05"],
            "outTimes": ["18:35"],
            "unknownTimes": [],
            "flags": {},
            "text": "2026-06-03 历史周期测试打卡记录",
        }
    )
    workdays = sum(row["workday"] for row in rows)
    attended = sum(row["workday"] and row["evidenceCount"] > 0 for row in rows)
    overtime_days = sum(row["overtimeMinutes"] > 0 for row in rows)
    overtime_minutes = sum(row["overtimeMinutes"] for row in rows)
    return {
        "schema_version": 1,
        "owner_name": "测试用户",
        "generated_at": "2026-07-23T08:00:00.000Z",
        "source": {
            "method": "lark-cli-user-im",
            "message_count": 38,
            "first_message_at": "2026-06-03 09:05",
            "last_message_at": "2026-07-23 18:30",
        },
        "period": {
            "mode": "detected",
            "start": rows[0]["date"],
            "end": rows[-1]["date"],
            "cycle": {
                "start": rows[0]["date"],
                "end": rows[-1]["date"],
                "cutoff": "2026-07-24 18:00",
            },
        },
        "detected_cycles": [
            {
                "start": "2026-06-01",
                "end": "2026-06-30",
                "cutoff": "2026-07-01 18:00",
            },
            {
                "start": rows[0]["date"],
                "end": rows[-1]["date"],
                "cutoff": "2026-07-24 18:00",
            },
        ],
        "parsed_event_count": 38,
        "manual_adjustment_count": 0,
        "manual_adjustments": [],
        "config": {
            "cycleStartDay": 1,
            "rangeStart": rows[0]["date"],
            "rangeEnd": rows[-1]["date"],
            "scheduleMode": "flex-linked",
            "workStart": "09:00",
            "workEnd": "18:00",
            "flexStartEarliest": "08:30",
            "flexStartLatest": "09:30",
            "flexEndEarliest": "18:00",
            "flexEndLatest": "19:00",
            "graceMinutes": 0,
            "workdays": [1, 2, 3, 4, 5],
            "holidayDates": CHINA_MAINLAND_2026_HOLIDAY_DATES,
            "extraWorkDates": CHINA_MAINLAND_2026_EXTRA_WORK_DATES,
            "officialCalendarVersion": "CN-2026",
            "noMessageAsMissing": False,
            "unknownSplitTime": "14:00",
            "overnightClockOutCutoff": "06:00",
        },
        "events": events,
        "totals": {
            "workdays": workdays,
            "attended": attended,
            "normal": attended - 2,
            "abnormal": 2,
            "pending": 2,
            "overtimeMinutes": overtime_minutes,
            "overtimeDays": overtime_days,
            "averageOvertimeMinutes": round(overtime_minutes / attended),
            "averageWorkMinutes": 474,
            "completeWorkDays": attended,
            "fullLeaveWorkDays": 0,
            "averageWorkDays": attended,
        },
        "rows": rows,
    }


def run() -> dict:
    chrome = (
        shutil.which("google-chrome")
        or shutil.which("google-chrome-stable")
        or shutil.which("chromium")
        or shutil.which("chromium-browser")
    )
    if not chrome:
        raise RuntimeError("没有找到可用于报告 UI 回归的 Chrome/Chromium")

    report = fixture_report()
    results = {}
    console_errors: list[str] = []
    page_errors: list[str] = []
    network_requests: list[str] = []
    screenshot_dir = ROOT / "test-results"
    screenshot_dir.mkdir(exist_ok=True)

    with tempfile.TemporaryDirectory() as directory:
        html_path = write_report_html(report, Path(directory) / "attendance-report.html")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=True,
                executable_path=chrome,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.on(
                "console",
                lambda message: (
                    console_errors.append(message.text)
                    if message.type == "error"
                    else None
                ),
            )
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on(
                "request",
                lambda request: (
                    network_requests.append(request.url)
                    if not request.url.startswith(("file:", "data:", "blob:"))
                    else None
                ),
            )

            for width, height in (
                (375, 844),
                (768, 900),
                (1024, 900),
                (1440, 1000),
            ):
                page.set_viewport_size({"width": width, "height": height})
                page.goto(html_path.as_uri(), wait_until="load")
                page.wait_for_function("window.__ATTENDANCE_REPORT_READY__ === true")
                page_width = page.evaluate("document.documentElement.scrollWidth")
                viewport_width = page.evaluate("window.innerWidth")
                assert page_width <= viewport_width
                assert page.locator("#fs-attendance-assistant").count() == 0
                assert page.title() == "测试用户的考勤报告"
                assert page.locator("#page-title").inner_text() == "测试用户的考勤报告"
                assert page.locator("#period-title").inner_text() == "切换周期"
                assert page.locator("[data-period-mode]").count() == 5
                assert page.locator("[data-period-mode='all']").inner_text() == "全部"
                assert "考勤周期" in page.locator("[data-period-mode='detected']").inner_text()
                assert page.locator("#period-apply").count() == 0
                assert page.locator("#detected-cycle-select option").count() == 2
                assert page.locator("#metric-grid .metric").count() == 8
                assert page.locator("#details-body tr").count() == len(report["rows"])
                assert "15 个完整出勤日" in page.locator("#chart-subtitle").inner_text()
                assert page.locator("#calculation-rules-title").inner_text() == "计算规则"
                assert page.evaluate(
                    """() => Boolean(
                      document.querySelector('#daily-details').compareDocumentPosition(
                        document.querySelector('.rules-card')
                      ) & Node.DOCUMENT_POSITION_FOLLOWING
                    )"""
                )
                assert (
                    page.locator(".calculation-rules").get_attribute("open")
                    is not None
                )
                rules_text = page.locator(".rules-card").inner_text()
                assert "加班总时长 ÷ 全部完整出勤日" in rules_text
                assert "全天请假和工作日出差固定计入 8 小时" in rules_text
                assert "0 加班日同样进入分母" in rules_text
                assert "周末出差、普通休息日和法定节假日不参与计算" in rules_text
                assert "法定节假日 33 天，额外工作日 6 天" in rules_text
                assert (
                    page.locator(
                        "#reconcile-type option[value='holiday']"
                    ).inner_text()
                    == "法定节假日"
                )
                assert page.locator("#overtime-chart").get_attribute("data-mode") == "candlestick"
                assert page.locator("#overtime-chart").get_attribute("data-gap-count") == "2"
                assert page.locator("#overtime-chart .chart-candle-point").count() == 15
                assert page.locator("#overtime-chart .chart-average-curve").count() > 0
                average_values = page.locator(
                    "#overtime-chart .chart-average-point"
                ).evaluate_all(
                    "points => points.map(point => Number(point.dataset.averageMinutes))"
                )
                assert len(set(average_values)) > 1
                assert average_values[-1] == report["totals"]["averageOvertimeMinutes"]
                results[str(width)] = {
                    "pageWidth": page_width,
                    "viewportWidth": viewport_width,
                    "metricCount": 8,
                    "rowCount": len(report["rows"]),
                }
                if width in {375, 1440}:
                    page.screenshot(
                        path=screenshot_dir / f"attendance-report-{width}.png",
                        full_page=True,
                    )

            page.locator("[data-period-mode='all']").click()
            page.wait_for_function(
                "document.querySelector('#hero-period').textContent === '2026-06-03 至 2026-07-23'"
                " && document.querySelector('#period-active').textContent.includes('全部数据')"
            )
            assert page.locator("#all-period-range").inner_text() == "2026-06-03 → 2026-07-23"
            assert page.locator("#details-body tr").count() == 51

            page.locator("[data-period-mode='detected']").click()
            page.locator("#detected-cycle-select").select_option("2026-06-01|2026-06-30")
            page.wait_for_function(
                "document.querySelector('#hero-period').textContent === '2026-06-01 至 2026-06-30'"
            )
            assert page.locator("#hero-period").inner_text() == "2026-06-01 至 2026-06-30"
            assert "考勤周期" in page.locator("#period-active").inner_text()
            assert page.locator("#details-body tr").count() == 30
            assert "09:05" in page.locator("#row-2026-06-03").inner_text()

            page.locator("[data-period-mode='natural']").click()
            page.locator("#natural-month").fill("2026-06")
            page.wait_for_function(
                "document.querySelector('#hero-period').textContent === '2026-06-01 至 2026-06-30'"
                " && document.querySelector('#period-active').textContent.includes('自然月')"
            )
            assert page.locator("#page-title").inner_text() == "测试用户的考勤报告"
            assert "自然月" in page.locator("#period-active").inner_text()
            assert page.locator("#details-body tr").count() == 30

            page.locator("[data-period-mode='cycle']").click()
            page.locator("#cycle-month").fill("2026-07")
            page.locator("#cycle-start-day").fill("26")
            page.wait_for_function(
                "document.querySelector('#hero-period').textContent === '2026-06-26 至 2026-07-25'"
                " && document.querySelector('#period-active').textContent.includes('固定起始日周期')"
            )
            assert page.locator("#hero-period").inner_text() == "2026-06-26 至 2026-07-25"
            assert "固定起始日周期" in page.locator("#period-active").inner_text()
            assert page.locator("#details-body tr").count() == 30

            page.locator("[data-period-mode='custom']").click()
            page.locator("#custom-period-start").fill("2026-07-03")
            page.locator("#custom-period-end").fill("2026-07-13")
            page.wait_for_function(
                "document.querySelector('#hero-period').textContent === '2026-07-03 至 2026-07-13'"
                " && document.querySelector('#period-active').textContent.includes('自定义周期')"
            )
            assert page.locator("#hero-period").inner_text() == "2026-07-03 至 2026-07-13"
            assert page.locator("#details-body tr").count() == 11

            page.locator("#custom-period-start").fill("2026-07-14")
            page.locator("#custom-period-end").fill("2026-07-13")
            page.wait_for_function(
                "document.querySelector('#period-error').textContent.includes('开始日期不能晚于结束日期')"
            )
            assert "开始日期不能晚于结束日期" in page.locator("#period-error").inner_text()
            assert page.locator("#hero-period").inner_text() == "2026-07-03 至 2026-07-13"

            page.locator("[data-period-mode='detected']").click()
            page.locator("#detected-cycle-select").select_option("2026-07-01|2026-07-23")
            page.wait_for_function(
                "document.querySelector('#hero-period').textContent === '2026-07-01 至 2026-07-23'"
            )
            assert page.locator("#details-body tr").count() == len(report["rows"])

            page.locator("[data-chart-mode='line']").click()
            assert page.locator("#overtime-chart").get_attribute("data-mode") == "line"
            assert page.locator("#chart-title").inner_text() == "每日加班趋势"
            assert page.locator("#overtime-chart .chart-daily-line").count() > 0
            assert page.locator("#overtime-chart .chart-average-curve").count() > 0
            assert (
                page.locator("[data-chart-mode='line']").get_attribute("aria-pressed")
                == "true"
            )
            page.locator("[data-chart-mode='candlestick']").click()
            assert page.locator("#overtime-chart").get_attribute("data-mode") == "candlestick"

            page.locator("#table-search").fill("不会匹配")
            page.locator("#show-attention").click()
            assert (
                page.locator("[data-filter='attention']").get_attribute("aria-pressed")
                == "true"
            )
            assert page.locator("#table-search").input_value() == ""
            assert page.locator("#details-body tr").count() == int(
                page.locator("#count-attention").inner_text()
            )
            assert page.locator("#details-body tr").count() == 4
            page.locator("#table-search").fill("2026-07-13")
            assert page.locator("#details-body tr").count() == 1
            page.locator("#table-search").fill("")
            page.locator("[data-filter='all']").click()

            order = page.locator("#toggle-order")
            order.click()
            assert "最早在前" in order.inner_text()
            assert page.locator("#details-body tr td strong").first.inner_text() == "2026-07-01"

            theme = page.locator("#theme-toggle")
            before = page.locator("html").get_attribute("data-theme")
            theme.click()
            after = page.locator("html").get_attribute("data-theme")
            assert before != after
            assert page.locator("#overtime-chart .chart-point").count() > 0

            page.locator("[data-reconcile-date='2026-07-21']").click()
            assert page.locator("#reconcile-dialog").is_visible()
            assert page.locator("#reconcile-evidence").get_attribute("open") is not None
            assert "没有解析到假勤消息" in page.locator("#reconcile-evidence-list").inner_text()
            page.locator("#reconcile-note").fill("已与飞书记录核对，原结果无误")
            page.locator("#reconcile-form button[type='submit']").click()
            assert not page.locator("#reconcile-dialog").is_visible()
            assert page.locator("#count-reviewed").inner_text() == "1"
            assert page.locator("#count-attention").inner_text() == "3"

            page.locator("[data-reconcile-date='2026-07-13']").click()
            assert page.locator("#reconcile-evidence-count").inner_text() == "1 条"
            page.locator("#reconcile-evidence summary").click()
            assert "测试打卡记录" in page.locator("#reconcile-evidence-list").inner_text()
            page.locator("#reconcile-type").select_option("patch")
            page.locator("#reconcile-clock-in").fill("09:00")
            page.locator("#reconcile-clock-out").fill("18:30")
            page.locator("#reconcile-note").fill("补卡审批通过")
            page.locator("#reconcile-form button[type='submit']").click()
            assert page.locator("#count-reviewed").inner_text() == "2"
            assert page.locator("#count-attention").inner_text() == "2"
            abnormal_metric = page.locator("#metric-grid .metric").nth(3).locator("strong").inner_text()
            assert abnormal_metric == "1"
            assert "已补卡" in page.locator("#row-2026-07-13").inner_text()
            assert "核对进度 2/4" in page.locator("#review-progress-chip").inner_text()

            page.locator("[data-period-mode='natural']").click()
            page.locator("#natural-month").fill("2026-07")
            page.wait_for_function(
                "document.querySelector('#hero-period').textContent === '2026-07-01 至 2026-07-31'"
                " && document.querySelector('#period-active').textContent.includes('自然月')"
            )
            assert page.locator("#count-reviewed").inner_text() == "2"
            assert "已补卡" in page.locator("#row-2026-07-13").inner_text()

            page.locator("[data-period-mode='detected']").click()
            page.locator("#detected-cycle-select").select_option("2026-06-01|2026-06-30")
            page.wait_for_function(
                "document.querySelector('#hero-period').textContent === '2026-06-01 至 2026-06-30'"
            )
            assert page.locator("#count-reviewed").inner_text() == "0"
            assert "已补卡" not in page.locator("#row-2026-06-13").inner_text()

            page.locator("#detected-cycle-select").select_option("2026-07-01|2026-07-23")
            page.wait_for_function(
                "document.querySelector('#hero-period').textContent === '2026-07-01 至 2026-07-23'"
            )
            assert page.locator("#count-reviewed").inner_text() == "2"
            assert "已补卡" in page.locator("#row-2026-07-13").inner_text()

            with page.expect_download() as download_info:
                page.locator("#export-manual").click()
            assert download_info.value.suggested_filename.startswith("考勤补充_")

            stored = page.evaluate(
                """() => Object.keys(localStorage)
                  .filter(key => key.startsWith('attendance-report:reconciliation:'))
                  .map(key => localStorage.getItem(key))
                  .join('\\n')"""
            )
            assert "2026-07-21" in stored
            assert "2026-07-13" in stored

            page.reload(wait_until="load")
            page.wait_for_function("window.__ATTENDANCE_REPORT_READY__ === true")
            assert page.locator("#count-reviewed").inner_text() == "2"
            assert "已补卡" in page.locator("#row-2026-07-13").inner_text()

            page.set_viewport_size({"width": 375, "height": 844})
            page.locator("[data-reconcile-date='2026-07-13']").click()
            dialog_box = page.locator("#reconcile-dialog").bounding_box()
            assert dialog_box
            assert dialog_box["width"] <= 375
            assert dialog_box["height"] <= 844
            page.screenshot(
                path=screenshot_dir / "attendance-report-reconcile-375.png",
                full_page=False,
            )
            page.locator("#reconcile-delete").click()
            assert page.locator("#count-reviewed").inner_text() == "1"
            abnormal_metric = page.locator("#metric-grid .metric").nth(3).locator("strong").inner_text()
            assert abnormal_metric == "2"

            page.locator("[data-reconcile-date='2026-07-09']").click()
            page.locator("#reconcile-type").select_option("holiday")
            assert "不进入平均加班和平均工时的分母" in page.locator(
                "#reconcile-hint"
            ).inner_text()
            page.locator("#reconcile-note").fill("法定节假日")
            page.locator("#reconcile-form button[type='submit']").click()
            holiday_row = page.locator("#row-2026-07-09")
            assert holiday_row.locator("td").nth(1).inner_text() == "法定节假日"
            assert holiday_row.locator("td").nth(5).inner_text() == "—"
            assert "法定节假日打卡" in holiday_row.locator("td").nth(7).inner_text()
            assert "14 个完整出勤日" in page.locator(
                "#metric-grid .metric"
            ).nth(6).locator("small").inner_text()
            assert "14 个计入均值日" in page.locator(
                "#metric-grid .metric"
            ).nth(7).locator("small").inner_text()
            assert "÷ 14 个完整出勤日" in page.locator(
                "#rule-overtime-current"
            ).inner_text()
            holiday_row.locator("[data-reconcile-date='2026-07-09']").click()
            page.locator("#reconcile-delete").click()
            assert page.locator("#count-reviewed").inner_text() == "1"

            migration_context = browser.new_context(
                viewport={"width": 1024, "height": 900}
            )
            migration_page = migration_context.new_page()
            migration_page.on(
                "console",
                lambda message: (
                    console_errors.append(message.text)
                    if message.type == "error"
                    else None
                ),
            )
            migration_page.on(
                "pageerror", lambda error: page_errors.append(str(error))
            )
            migration_page.goto(html_path.as_uri(), wait_until="load")
            migration_page.wait_for_function(
                "window.__ATTENDANCE_REPORT_READY__ === true"
            )
            legacy_key = (
                "attendance-report:reconciliation:1:"
                "2026-07-01:2026-07-23"
            )
            migration_page.evaluate(
                """([legacyKey, payload]) => {
                  localStorage.removeItem(
                    'attendance-report:reconciliation:2:global'
                  );
                  localStorage.setItem(legacyKey, JSON.stringify(payload));
                }""",
                [
                    legacy_key,
                    {
                        "version": 1,
                        "entries": [
                            {
                                "date": "2026-07-13",
                                "reviewed": True,
                                "outcome": "patch",
                                "adjustment": {
                                    "date": "2026-07-13",
                                    "type": "patch",
                                    "clockIn": "09:00",
                                    "clockOut": "18:30",
                                    "clockOutNextDay": False,
                                    "note": "旧缓存迁移",
                                },
                                "note": "旧缓存迁移",
                                "updatedAt": "2026-07-23T12:00:00.000Z",
                            }
                        ],
                    },
                ],
            )
            migration_page.reload(wait_until="load")
            migration_page.wait_for_function(
                "window.__ATTENDANCE_REPORT_READY__ === true"
            )
            assert migration_page.locator("#count-reviewed").inner_text() == "1"
            assert "已补卡" in migration_page.locator(
                "#row-2026-07-13"
            ).inner_text()
            migration_storage = migration_page.evaluate(
                """([legacyKey]) => ({
                  legacyPreserved: localStorage.getItem(legacyKey) !== null,
                  globalEntries: JSON.parse(
                    localStorage.getItem(
                      'attendance-report:reconciliation:2:global'
                    )
                  ).entries
                })""",
                [legacy_key],
            )
            assert migration_storage["legacyPreserved"] is True
            assert migration_storage["globalEntries"][0]["date"] == "2026-07-13"
            migration_context.close()
            browser.close()

    assert not console_errors, console_errors
    assert not page_errors, page_errors
    assert not network_requests, network_requests
    return {
        "responsive": results,
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "externalRequests": network_requests,
        "reconciliation": {
            "localPersistence": True,
            "crossPeriodSharing": True,
            "legacyMigration": True,
            "sameRuleRecalculation": True,
            "manualJsonExport": True,
        },
        "calculationRules": {
            "overtimeUsesAllCompleteAttendanceDays": True,
            "fullDayLeaveCreditsEightHours": True,
            "visibleOnPage": True,
        },
    }


if __name__ == "__main__":
    print(json.dumps(run(), ensure_ascii=False, indent=2))
