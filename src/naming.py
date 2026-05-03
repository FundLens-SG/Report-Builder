"""Build and sanitize output filenames."""

from __future__ import annotations

import re
from pathlib import Path


def build_filename(customer_name: str, policy_number: str, report_date: str) -> str:
    """Format: {Client Name} - Investment Snapshot - {Policy Number} - {Date}.png"""
    client = title_case_name(customer_name)
    date_str = format_date_for_filename(report_date)
    raw = f"{client} - Investment Snapshot - {policy_number} - {date_str}.png"
    return sanitize_filename(raw)


def title_case_name(name: str) -> str:
    """'JANE DOE LIM' -> 'Jane Doe Lim'."""
    return " ".join(word.capitalize() for word in (name or "").strip().split())


def format_date_for_filename(report_date: str) -> str:
    """'30 Apr 2026' -> '30 Apr 2026' (already filesystem-safe)."""
    return (report_date or "").strip()


def sanitize_filename(name: str) -> str:
    """Strip filesystem-unsafe chars. Keep spaces, hyphens, dots."""
    name = re.sub(r"[<>:\"/\\|?*]", "", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def ensure_unique(path: Path) -> Path:
    """If file exists, append (1), (2), etc."""
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    parent = path.parent
    n = 1
    while True:
        candidate = parent / f"{stem} ({n}){suffix}"
        if not candidate.exists():
            return candidate
        n += 1
