#!/usr/bin/env python3
"""Drive the userscript fixture in a real Chrome window and audit key UI states."""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_URL = (ROOT / "tests" / "browser-fixture.html").as_uri()
EMPTY_FIXTURE_URL = (ROOT / "tests" / "empty-chat-fixture.html").as_uri()
CYCLE_FIXTURE_URL = (ROOT / "tests" / "cycle-fixture.html").as_uri()
MESSAGE_SHAPES_FIXTURE_URL = (ROOT / "tests" / "message-shapes-fixture.html").as_uri()
OTHER_CHAT_FIXTURE_URL = (ROOT / "tests" / "other-chat-fixture.html").as_uri()
FIXED_JULY_DATE_SCRIPT = """
(() => {
  const NativeDate = Date;
  const fixed = new NativeDate(2026, 6, 22, 12, 0, 0).getTime();
  class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  }
  FixedDate.parse = NativeDate.parse;
  FixedDate.UTC = NativeDate.UTC;
  window.Date = FixedDate;
})();
"""
FIXED_AUGUST_DATE_SCRIPT = FIXED_JULY_DATE_SCRIPT.replace("2026, 6, 22", "2026, 7, 1")


def dimensions(locator):
    return locator.evaluate(
        """element => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        })"""
    )


def run() -> dict:
    console_errors: list[str] = []
    page_errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=False,
            executable_path="/usr/bin/google-chrome",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
        page.add_init_script(FIXED_JULY_DATE_SCRIPT)
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto(FIXTURE_URL, wait_until="load")

        host = page.locator("#fs-attendance-assistant")
        panel = host.locator("#panel")
        main = host.locator("main")
        status = host.locator("#scanStatus")
        status.wait_for(state="visible")
        page.wait_for_function(
            "document.querySelector('#result').textContent.includes('扫描完成')",
            timeout=15000,
        )

        desktop = {
            "panel": dimensions(panel),
            "main": dimensions(main),
            "rows": host.locator("tbody tr").count(),
            "dangerPills": host.locator(".status-pill.danger").count(),
            "schedule": host.locator("#scheduleChip").inner_text(),
            "status": status.inner_text(),
            "order": host.locator("#orderLabel").inner_text(),
            "firstDate": host.locator("tbody tr td strong").first.inner_text(),
            "trendTitle": host.locator("#overtimeTrendHeading").inner_text(),
            "trendPoints": host.locator(".chart-point").count(),
            "trendAvailablePoints": host.locator(".chart-point:not(.gap)").count(),
            "trendLines": host.locator(".chart-line").count(),
        }
        assert desktop["panel"]["scrollWidth"] == desktop["panel"]["clientWidth"]
        assert desktop["main"]["scrollWidth"] == desktop["main"]["clientWidth"]
        assert desktop["rows"] == 2
        assert desktop["dangerPills"] == 2
        assert "08:30–09:30" in desktop["schedule"]
        assert "次日 00:00–05:59" in desktop["schedule"]
        assert desktop["order"] == "近期在前"
        assert desktop["firstDate"] == "2026-07-02"
        assert desktop["trendTitle"] == "加班趋势"
        assert desktop["trendPoints"] == 2
        assert desktop["trendAvailablePoints"] == 2
        assert desktop["trendLines"] >= 1
        host.locator(".chart-point").first.focus()
        tooltip = host.locator("#overtimeTooltip")
        assert tooltip.evaluate("element => element.classList.contains('open')")
        assert "2026-07-01" in tooltip.inner_text()
        assert "0小时4分" in tooltip.inner_text()
        panel.focus()
        assert not tooltip.evaluate("element => element.classList.contains('open')")
        host.locator("#toggleOrder").click()
        assert host.locator("#orderLabel").inner_text() == "最早在前"
        assert host.locator("tbody tr td strong").first.inner_text() == "2026-07-01"
        host.locator("#toggleOrder").click()
        page.screenshot(path="/tmp/attendance-browser-desktop.png")

        cache_context = browser.new_context(viewport={"width": 1100, "height": 850})
        cache_context.add_init_script(FIXED_JULY_DATE_SCRIPT)
        cache_source_page = cache_context.new_page()
        cache_source_page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        cache_source_page.on("pageerror", lambda error: page_errors.append(str(error)))
        cache_source_page.goto(FIXTURE_URL, wait_until="load")
        cache_source_page.wait_for_function(
            "document.querySelector('#result').textContent.includes('扫描完成')",
            timeout=15000,
        )
        cached_page = cache_context.new_page()
        cached_page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        cached_page.on("pageerror", lambda error: page_errors.append(str(error)))
        cached_page.goto(EMPTY_FIXTURE_URL, wait_until="load")
        cached_host = cached_page.locator("#fs-attendance-assistant")
        cached_host.locator("#fab").click()
        cached_status = cached_host.locator("#scanStatus").inner_text()
        assert "当前不是「假勤」会话" in cached_status
        assert "本地缓存载入 4 条" in cached_status
        assert "本地缓存 4 条" in cached_host.locator(".cache-pill").inner_text()
        assert cached_host.locator("#scanHistoryLabel").inner_text() == "定位并扫描「假勤」"
        cached_july2 = cached_host.locator("tbody tr:has([data-edit-date='2026-07-02']) td")
        assert cached_july2.nth(2).inner_text().strip() == "09:40"
        assert cached_july2.nth(3).inner_text().strip() == "18:00"
        cached_host.locator("#panel").screenshot(path="/tmp/attendance-browser-cross-chat-cache.png")
        cache_context.close()

        rule = host.locator("details.rule-card")
        rule.locator("summary").click()
        assert rule.get_attribute("open") is not None
        assert host.locator("#flexScheduleFields").is_visible()
        host.locator("#scheduleMode").select_option("fixed")
        assert host.locator("#fixedScheduleFields").is_visible()
        assert not host.locator("#flexScheduleFields").is_visible()
        host.locator("#scheduleMode").select_option("flex-linked")
        page.screenshot(path="/tmp/attendance-browser-settings.png")

        page.keyboard.press("Escape")
        assert not host.locator("#backdrop").evaluate("element => element.classList.contains('open')")
        assert host.locator("#fab").get_attribute("aria-expanded") == "false"
        host.locator("#fab").click()
        assert host.locator("#backdrop").evaluate("element => element.classList.contains('open')")
        page.wait_for_timeout(50)
        assert host.evaluate("element => element.shadowRoot.activeElement?.id") == "panel"

        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(150)
        mobile = {
            "viewport": page.viewport_size,
            "panel": dimensions(panel),
            "main": dimensions(main),
            "primaryButton": host.locator("#scanHistory").bounding_box(),
            "dateInput": host.locator("#rangeStart").bounding_box(),
            "closeButton": host.locator("#close").bounding_box(),
            "trendScroll": dimensions(host.locator(".trend-scroll")),
        }
        viewport_width = mobile["viewport"]["width"]
        assert viewport_width - 20 <= mobile["panel"]["clientWidth"] <= viewport_width
        assert mobile["panel"]["scrollWidth"] == mobile["panel"]["clientWidth"]
        assert mobile["main"]["scrollWidth"] == mobile["main"]["clientWidth"]
        assert mobile["primaryButton"] and mobile["primaryButton"]["width"] > 300
        assert mobile["dateInput"] and mobile["dateInput"]["width"] > 300
        assert mobile["primaryButton"]["height"] >= 44
        assert mobile["dateInput"]["height"] >= 44
        assert mobile["closeButton"] and mobile["closeButton"]["width"] >= 44
        assert mobile["trendScroll"]["scrollWidth"] > mobile["trendScroll"]["clientWidth"]
        host.locator(".trend-card").scroll_into_view_if_needed()
        page.wait_for_timeout(80)
        page.screenshot(path="/tmp/attendance-browser-mobile.png")

        responsive = {}
        for width, height in ((320, 844), (375, 844), (414, 896), (768, 900), (1024, 900), (1440, 1000)):
            page.set_viewport_size({"width": width, "height": height})
            page.wait_for_timeout(80)
            responsive[str(width)] = {
                "panel": dimensions(panel),
                "main": dimensions(main),
            }
            assert responsive[str(width)]["panel"]["scrollWidth"] == responsive[str(width)]["panel"]["clientWidth"]
            assert responsive[str(width)]["main"]["scrollWidth"] == responsive[str(width)]["main"]["clientWidth"]

        locator_context = browser.new_context(viewport={"width": 1100, "height": 850})
        locator_context.add_init_script(FIXED_JULY_DATE_SCRIPT)
        locator_page = locator_context.new_page()
        locator_page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        locator_page.on("pageerror", lambda error: page_errors.append(str(error)))
        locator_page.goto(OTHER_CHAT_FIXTURE_URL, wait_until="load")
        locator_host = locator_page.locator("#fs-attendance-assistant")
        locator_host.locator("#fab").click()
        assert locator_host.locator("#scanHistoryLabel").inner_text() == "定位并扫描「假勤」"
        locator_host.locator("#rangeStart").fill("2026-07-01")
        locator_host.locator("#rangeEnd").fill("2026-07-01")
        locator_host.locator("#scanHistory").click()
        locator_page.wait_for_function("window.__attendanceConversationClicked === true", timeout=5000)
        locator_page.wait_for_function(
            "document.querySelector('#fs-attendance-assistant').shadowRoot.querySelector('#scanStatus').textContent.includes('扫描完成')",
            timeout=15000,
        )
        locator_cache = locator_page.evaluate("localStorage.getItem('fs-attendance-assistant:events:v1')")
        locator_row = locator_host.locator("tbody tr:has([data-edit-date='2026-07-01']) td")
        auto_locator = {
            "clicked": locator_page.evaluate("window.__attendanceConversationClicked"),
            "clockIn": locator_row.nth(2).inner_text().strip(),
            "clockOut": locator_row.nth(3).inner_text().strip(),
            "overtime": locator_row.nth(6).inner_text().strip(),
            "cache": locator_cache,
        }
        assert auto_locator["clockIn"] == "09:00"
        assert auto_locator["clockOut"] == "19:30"
        assert auto_locator["overtime"] == "1小时"
        assert '"events"' in auto_locator["cache"]

        locator_page.reload(wait_until="load")
        locator_host = locator_page.locator("#fs-attendance-assistant")
        locator_host.locator("#fab").click()
        assert "当前不是「假勤」会话" in locator_host.locator("#scanStatus").inner_text()
        assert "本地缓存载入 2 条" in locator_host.locator("#scanStatus").inner_text()
        assert locator_host.locator("tbody tr:has([data-edit-date='2026-07-01']) td").nth(3).inner_text().strip() == "19:30"
        locator_context.close()

        manual_context = browser.new_context(viewport={"width": 1200, "height": 900})
        manual_context.add_init_script(FIXED_JULY_DATE_SCRIPT)
        manual_page = manual_context.new_page()
        manual_page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        manual_page.on("pageerror", lambda error: page_errors.append(str(error)))
        manual_page.goto(FIXTURE_URL, wait_until="load")
        manual_page.wait_for_function(
            "document.querySelector('#result').textContent.includes('扫描完成')",
            timeout=15000,
        )
        manual_host = manual_page.locator("#fs-attendance-assistant")
        july2_row = manual_host.locator("tbody tr:has([data-edit-date='2026-07-02'])")
        july2_row.locator("[data-edit-date='2026-07-02']").click()
        manual_dialog = manual_host.locator("#manualDialog")
        assert manual_dialog.is_visible()
        manual_host.locator("#manualType").select_option("leave-pm")
        manual_host.locator("#manualClockIn").fill("09:00")
        manual_host.locator("#manualClockOut").fill("14:30")
        manual_host.locator("#manualNote").fill("下午请假审批已通过")
        manual_host.locator("#manualForm button[type='submit']").click()
        assert not manual_dialog.is_visible()
        july2_cells = july2_row.locator("td")
        manual_saved = {
            "clockIn": july2_cells.nth(2).inner_text().strip(),
            "clockOut": july2_cells.nth(3).inner_text().strip(),
            "expectedOut": july2_cells.nth(4).inner_text().strip(),
            "work": july2_cells.nth(5).inner_text().strip(),
            "overtime": july2_cells.nth(6).inner_text().strip(),
            "status": july2_cells.nth(8).inner_text().strip(),
            "source": july2_cells.nth(9).inner_text().strip(),
            "storage": manual_page.evaluate("localStorage.getItem('fs-attendance-assistant:manual:v1')"),
        }
        assert manual_saved["clockIn"] == "09:00"
        assert manual_saved["clockOut"] == "14:30"
        assert manual_saved["expectedOut"] == "14:30"
        assert manual_saved["work"] == "4小时"
        assert manual_saved["overtime"] == "—"
        assert "下午半天假" in manual_saved["status"]
        assert "半天出勤正常" in manual_saved["status"]
        assert "下午半天假" in manual_saved["source"]
        assert "下午请假审批已通过" in manual_saved["storage"]

        manual_page.reload(wait_until="load")
        manual_page.wait_for_function(
            "document.querySelector('#result').textContent.includes('扫描完成')",
            timeout=15000,
        )
        manual_host = manual_page.locator("#fs-attendance-assistant")
        persisted_row = manual_host.locator("tbody tr:has([data-edit-date='2026-07-02'])")
        assert "下午半天假" in persisted_row.locator("td").nth(9).inner_text()
        manual_page.set_viewport_size({"width": 390, "height": 844})
        persisted_row.locator("[data-edit-date='2026-07-02']").click()
        dialog_box = manual_host.locator("#manualDialog").bounding_box()
        assert dialog_box and dialog_box["width"] <= 366 and dialog_box["height"] <= 820
        manual_page.screenshot(path="/tmp/attendance-browser-manual.png")
        manual_host.locator("#deleteManual").click()
        assert not manual_host.locator("#manualDialog").is_visible()
        assert manual_page.evaluate("localStorage.getItem('fs-attendance-assistant:manual:v1')") == "[]"
        assert "下午半天假" not in manual_host.locator("tbody tr:has([data-edit-date='2026-07-02']) td").nth(9).inner_text()
        manual_context.close()

        empty_page = browser.new_page(viewport={"width": 1024, "height": 768})
        empty_page.add_init_script(FIXED_JULY_DATE_SCRIPT)
        empty_page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        empty_page.on("pageerror", lambda error: page_errors.append(str(error)))
        empty_page.goto(EMPTY_FIXTURE_URL, wait_until="load")
        empty_host = empty_page.locator("#fs-attendance-assistant")
        empty_host.locator("#fab").click()
        empty_status = empty_host.locator("#scanStatus").inner_text()
        assert "当前不是「假勤」会话" in empty_status
        assert empty_host.locator("#detectedCycle").is_disabled()
        empty_page.close()

        cycle_page = browser.new_page(viewport={"width": 1024, "height": 900})
        cycle_page.add_init_script(FIXED_JULY_DATE_SCRIPT)
        cycle_page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        cycle_page.on("pageerror", lambda error: page_errors.append(str(error)))
        cycle_page.goto(CYCLE_FIXTURE_URL, wait_until="load")
        cycle_host = cycle_page.locator("#fs-attendance-assistant")
        cycle_host.locator("#fab").click()
        cycle_page.wait_for_timeout(120)
        cycle_data = {
            "rangeStart": cycle_host.locator("#rangeStart").input_value(),
            "rangeEnd": cycle_host.locator("#rangeEnd").input_value(),
            "pressed": cycle_host.locator("#detectedCycle").get_attribute("aria-pressed"),
            "disabled": cycle_host.locator("#detectedCycle").is_disabled(),
            "hint": cycle_host.locator("#cycleSourceText").inner_text(),
            "status": cycle_host.locator("#scanStatus").inner_text(),
        }
        assert cycle_data["rangeStart"] == "2026-06-25"
        assert cycle_data["rangeEnd"] == "2026-07-24"
        assert cycle_data["pressed"] == "true"
        assert not cycle_data["disabled"]
        assert "06/25–07/24" in cycle_data["hint"]
        assert "解析 0 条" in cycle_data["status"]

        expected_natural = cycle_page.evaluate(
            """() => {
              const now = new Date();
              const pad = value => String(value).padStart(2, '0');
              const format = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
              return [format(new Date(now.getFullYear(), now.getMonth(), 1)), format(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
            }"""
        )
        cycle_host.locator("#naturalMonth").click()
        cycle_host.locator("#scanCurrent").click()
        assert cycle_host.locator("#rangeStart").input_value() == expected_natural[0]
        assert cycle_host.locator("#rangeEnd").input_value() == expected_natural[1]
        assert cycle_host.locator("#naturalMonth").get_attribute("aria-pressed") == "true"
        cycle_host.locator("#detectedCycle").click()
        assert cycle_host.locator("#rangeStart").input_value() == "2026-06-25"
        assert cycle_host.locator("#rangeEnd").input_value() == "2026-07-24"
        cycle_host.locator("#panel").screenshot(path="/tmp/attendance-browser-cycle.png")
        cycle_page.close()

        historical_page = browser.new_page(viewport={"width": 1024, "height": 768})
        historical_page.add_init_script(FIXED_AUGUST_DATE_SCRIPT)
        historical_page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        historical_page.on("pageerror", lambda error: page_errors.append(str(error)))
        historical_page.goto(CYCLE_FIXTURE_URL, wait_until="load")
        historical_host = historical_page.locator("#fs-attendance-assistant")
        historical_host.locator("#fab").click()
        historical_cycle = {
            "rangeStart": historical_host.locator("#rangeStart").input_value(),
            "rangeEnd": historical_host.locator("#rangeEnd").input_value(),
            "naturalPressed": historical_host.locator("#naturalMonth").get_attribute("aria-pressed"),
            "detectedDisabled": historical_host.locator("#detectedCycle").is_disabled(),
            "hint": historical_host.locator("#cycleSourceText").inner_text(),
        }
        assert historical_cycle["rangeStart"] == "2026-08-01"
        assert historical_cycle["rangeEnd"] == "2026-08-31"
        assert historical_cycle["naturalPressed"] == "true"
        assert not historical_cycle["detectedDisabled"]
        assert "历史机器人周期" in historical_cycle["hint"]
        historical_page.close()

        shapes_page = browser.new_page(viewport={"width": 1200, "height": 900})
        shapes_page.add_init_script(FIXED_JULY_DATE_SCRIPT)
        shapes_page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        shapes_page.on("pageerror", lambda error: page_errors.append(str(error)))
        shapes_page.goto(MESSAGE_SHAPES_FIXTURE_URL, wait_until="load")
        shapes_host = shapes_page.locator("#fs-attendance-assistant")
        shapes_host.locator("#fab").click()
        shapes_page.wait_for_timeout(120)
        shape_rows = shapes_host.evaluate(
            r"""host => Object.fromEntries([...host.shadowRoot.querySelectorAll('tbody tr')].map(row => {
              const cells = [...row.querySelectorAll('td')].map(cell => cell.textContent.trim().replace(/\s+/g, ' '));
              return [cells[0].slice(0, 10), {clockIn: cells[2], clockOut: cells[3], status: cells[8], sources: cells[9]}];
            }))"""
        )
        shape_messages = {
            "rangeStart": shapes_host.locator("#rangeStart").input_value(),
            "rangeEnd": shapes_host.locator("#rangeEnd").input_value(),
            "status": shapes_host.locator("#scanStatus").inner_text(),
            "jun25": shape_rows["2026-06-25"],
            "jun30": shape_rows["2026-06-30"],
            "jul1": shape_rows["2026-07-01"],
            "jul20": shape_rows["2026-07-20"],
            "jul21": shape_rows["2026-07-21"],
            "jul22": shape_rows["2026-07-22"],
            "trendAvailablePoints": shapes_host.locator(".chart-point:not(.gap)").count(),
        }
        assert shape_messages["rangeStart"] == "2026-06-25"
        assert shape_messages["rangeEnd"] == "2026-07-24"
        assert shape_messages["jun25"]["clockIn"] == "08:52"
        assert shape_messages["jun25"]["clockOut"] == "19:18"
        assert shape_messages["jul1"]["clockIn"] == "09:12"
        assert shape_messages["jul1"]["clockOut"] == "20:06"
        assert shape_messages["jul21"]["clockIn"] == "08:58"
        assert shape_messages["jul21"]["clockOut"] == "21:16"
        assert shape_messages["jul21"]["sources"] == "2 条", "同一消息的 wrapper 不能被重复解析"
        assert shape_messages["jul22"]["clockIn"] == "09:07"
        assert shape_messages["jul22"]["clockOut"] == "—", "没有下班消息时不能生成下班时间"
        assert shape_messages["jul22"]["sources"] == "1 条"
        assert "进行中" in shape_messages["jul22"]["status"]
        assert shape_messages["jul20"]["sources"] == "—", "Yesterday 消息不能重复归入 7 月 20 日"
        assert "缺上班卡" in shape_messages["jun30"]["status"]
        assert "解析 8 条" in shape_messages["status"]
        assert shape_messages["trendAvailablePoints"] == 3
        shapes_page.close()

        browser.close()
        assert not console_errors, f"console errors: {console_errors}"
        assert not page_errors, f"page errors: {page_errors}"
        return {
            "desktop": desktop,
            "mobile": mobile,
            "responsive": responsive,
            "crossConversationCacheStatus": cached_status,
            "autoLocateAttendance": auto_locator,
            "manualPersistence": manual_saved,
            "emptyChatStatus": empty_status,
            "detectedCycle": cycle_data,
            "historicalCycleFallback": historical_cycle,
            "messageShapeDates": shape_messages,
            "consoleErrors": console_errors,
            "pageErrors": page_errors,
            "screenshots": [
                "/tmp/attendance-browser-desktop.png",
                "/tmp/attendance-browser-settings.png",
                "/tmp/attendance-browser-mobile.png",
                "/tmp/attendance-browser-cycle.png",
                "/tmp/attendance-browser-manual.png",
                "/tmp/attendance-browser-cross-chat-cache.png",
            ],
        }


if __name__ == "__main__":
    print(json.dumps(run(), ensure_ascii=False, indent=2))
