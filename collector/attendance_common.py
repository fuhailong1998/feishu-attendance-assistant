#!/usr/bin/env python3
"""Shared helpers for attendance message collectors."""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


TIME_ZONE = ZoneInfo("Asia/Shanghai")
ATTENDANCE_TERMS = (
    "假勤",
    "考勤",
    "打卡",
    "缺卡",
    "漏卡",
    "迟到",
    "早退",
    "旷工",
    "补卡",
    "外勤",
    "请假",
    "出差",
    "无需打卡",
    "上班打卡成功",
    "下班打卡成功",
    "考勤申请截止时间提醒",
    "Clocked in successfully",
    "Clocked out successfully",
    "Attendance reminder",
    "Attendance requests closing soon",
    "No record notification",
    "Missing punch",
    "Weekly Report",
    "Monthly Report",
)
PUNCH_TERMS = (
    "上班打卡成功",
    "下班打卡成功",
    "Clocked in successfully",
    "Clocked out successfully",
)


def local_datetime(timestamp: float) -> datetime:
    """Convert second, millisecond, microsecond, or nanosecond epoch values."""
    numeric = float(timestamp or 0)
    while abs(numeric) > 10_000_000_000:
        numeric /= 1000
    return datetime.fromtimestamp(numeric, tz=TIME_ZONE)


def range_label(timestamp: float) -> str:
    return local_datetime(timestamp).strftime("%Y-%m-%d %H:%M") if timestamp else "—"


def atomic_write_private(path: Path, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    atomic_write_private_text(path, data)


def atomic_write_private_text(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(data)
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    temporary.replace(path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
