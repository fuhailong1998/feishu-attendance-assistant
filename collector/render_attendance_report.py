#!/usr/bin/env python3
"""Render a self-contained attendance report and open it in a browser."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path
from typing import Any

from attendance_common import atomic_write_private_text


ROOT = Path(__file__).resolve().parents[1]
COLLECTOR_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = ROOT / ".attendance-data" / "attendance-report.json"
DEFAULT_OUTPUT = ROOT / ".attendance-data" / "attendance-report.html"
TEMPLATE_PATH = COLLECTOR_DIR / "attendance_report_template.html"
STYLES_PATH = COLLECTOR_DIR / "attendance_report.css"
SCRIPT_PATH = COLLECTOR_DIR / "attendance_report.js"
PARSER_PATH = ROOT / "feishu-attendance.user.js"
DATA_PLACEHOLDER = "__ATTENDANCE_REPORT_DATA__"
STYLES_PLACEHOLDER = "__ATTENDANCE_REPORT_STYLES__"
SCRIPT_PLACEHOLDER = "__ATTENDANCE_REPORT_SCRIPT__"
PARSER_PLACEHOLDER = "__ATTENDANCE_PARSER_SCRIPT__"


class ReportError(RuntimeError):
    """Raised for invalid report data or rendering failures."""


def validate_report(report: Any) -> dict[str, Any]:
    if not isinstance(report, dict):
        raise ReportError("考勤报告必须是 JSON 对象。")
    if report.get("schema_version") != 1:
        raise ReportError("考勤报告版本无效或不受支持。")
    if not isinstance(report.get("rows"), list):
        raise ReportError("考勤报告缺少每日明细 rows。")
    if not isinstance(report.get("totals"), dict):
        raise ReportError("考勤报告缺少汇总 totals。")
    if not isinstance(report.get("period"), dict):
        raise ReportError("考勤报告缺少周期 period。")
    return report


def serialized_report_data(report: dict[str, Any]) -> str:
    """Serialize safely inside a script[type=application/json] element."""
    return (
        json.dumps(report, ensure_ascii=False, separators=(",", ":"))
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def read_asset(path: Path) -> str:
    try:
        return path.read_text("utf-8")
    except OSError as error:
        raise ReportError(f"无法读取报告资源：{path}") from error


def inline_script(path: Path) -> str:
    return re.sub(r"</script", r"<\\/script", read_asset(path), flags=re.IGNORECASE)


def render_report_html(report: dict[str, Any]) -> str:
    validate_report(report)
    template = read_asset(TEMPLATE_PATH)
    replacements = {
        DATA_PLACEHOLDER: serialized_report_data(report),
        STYLES_PLACEHOLDER: read_asset(STYLES_PATH),
        PARSER_PLACEHOLDER: inline_script(PARSER_PATH),
        SCRIPT_PLACEHOLDER: inline_script(SCRIPT_PATH),
    }
    for placeholder in replacements:
        if template.count(placeholder) != 1:
            raise ReportError(f"HTML 模板占位符数量无效：{placeholder}")
    pattern = re.compile("|".join(re.escape(value) for value in replacements))
    return pattern.sub(lambda match: replacements[match.group(0)], template)


def write_report_html(report: dict[str, Any], output: Path = DEFAULT_OUTPUT) -> Path:
    absolute = output.expanduser().resolve()
    atomic_write_private_text(absolute, render_report_html(report))
    return absolute


def load_report(path: Path) -> dict[str, Any]:
    try:
        report = json.loads(path.expanduser().resolve().read_text("utf-8"))
    except OSError as error:
        raise ReportError(f"无法读取考勤报告：{path}") from error
    except json.JSONDecodeError as error:
        raise ReportError(f"考勤报告不是有效 JSON：{path}") from error
    return validate_report(report)


def is_wsl() -> bool:
    if os.environ.get("WSL_DISTRO_NAME"):
        return True
    try:
        return "microsoft" in Path("/proc/version").read_text("utf-8").casefold()
    except OSError:
        return False


def detached_popen(command: list[str]) -> None:
    subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def open_report(path: Path) -> bool:
    absolute = path.expanduser().resolve()
    try:
        if sys.platform == "win32":
            os.startfile(str(absolute))  # type: ignore[attr-defined]
            return True
        if sys.platform == "darwin":
            detached_popen(["open", str(absolute)])
            return True
        if is_wsl():
            wslview = shutil.which("wslview")
            if wslview:
                detached_popen([wslview, str(absolute)])
                return True
            cmd_exe = shutil.which("cmd.exe")
            wslpath = shutil.which("wslpath")
            if cmd_exe and wslpath:
                converted = subprocess.run(
                    [wslpath, "-w", str(absolute)],
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=5,
                ).stdout.strip()
                detached_popen([cmd_exe, "/C", "start", "", converted])
                return True
        xdg_open = shutil.which("xdg-open")
        if xdg_open:
            detached_popen([xdg_open, str(absolute)])
            return True
        return bool(webbrowser.open_new_tab(absolute.as_uri()))
    except (OSError, subprocess.SubprocessError, webbrowser.Error):
        return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="将考勤 JSON 渲染为自包含 HTML 报告。")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help=f"输入 JSON（默认：{DEFAULT_INPUT}）")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help=f"输出 HTML（默认：{DEFAULT_OUTPUT}）")
    parser.add_argument("--no-open", action="store_true", help="生成后不打开浏览器")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        output = write_report_html(load_report(args.input), args.output)
    except ReportError as error:
        print(f"报告生成失败：{error}", file=sys.stderr)
        return 1
    print(f"HTML 报告：{output}")
    if not args.no_open and not open_report(output):
        print("未能自动打开浏览器，请手动打开上面的 HTML 文件。", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
