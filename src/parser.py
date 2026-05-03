"""Parse a Manulife Customer Investment Report PDF into a RawReport dataclass."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

import pdfplumber


@dataclass
class Holding:
    fund_full_name: str
    ticker: str
    asset_class: str
    sub_asset_class: str
    fund_value: float
    pnl_dollar: float
    pnl_pct: float


@dataclass
class RawReport:
    customer_name: str
    report_date: str
    policy_name: str
    policy_number: str
    policy_issue_date: str
    account_value: float
    policy_investment_cost: float
    total_pnl_dollar: float
    total_pnl_pct: float
    annualised_pnl_pct: float
    total_rider_premiums: float
    total_dividends_reinvested: float
    risk_profile: str
    cka_status: str
    cka_expiry: str
    holdings: list[Holding] = field(default_factory=list)


def _to_float(s: Optional[str]) -> float:
    if not s:
        return 0.0
    # Manulife wraps long numbers across cell rows, e.g. "3,326.3300\n0" really means 3326.33000.
    cleaned = re.sub(r"\s+", "", s).replace(",", "")
    return float(cleaned)


def _grab(text: str, pattern: str, default: Optional[str] = None, flags: int = 0) -> Optional[str]:
    m = re.search(pattern, text, flags)
    return m.group(1).strip() if m else default


def _grab_money(text: str, pattern: str) -> float:
    return _to_float(_grab(text, pattern))


def parse_pdf(pdf_path: str) -> RawReport:
    """Parse a Manulife PDF into a RawReport.

    The Manulife PDF uses a font where 'fi' ligatures sometimes drop in extraction
    ("Profit" -> "Proft", "figures" -> "fgures"). Patterns must tolerate both.
    """
    with pdfplumber.open(pdf_path) as pdf:
        pages_text = [p.extract_text() or "" for p in pdf.pages]
        # Only the first 3 pages carry policy data. The glossary on page 4
        # contains the same labels in different contexts (e.g. "...]-1} X 100\n
        # Annualised P&L (%) This reflects...") and would cause false-positive
        # matches if included.
        full_text = "\n".join(pages_text[:3])
        holdings = _parse_holdings_from_tables(pdf)

    # The Manulife PDF lays out Policy Info / P&L Summary in a two-column grid where the
    # value appears on the line ABOVE the label, with the second column's value tacked
    # onto the same line. Patterns are written to anchor on the label and look back.
    customer_name = _grab(full_text, r"^([A-Z][A-Z ]+[A-Z])\s+Manulife\s*\(Singapore\)", flags=re.MULTILINE)
    report_date = _grab(full_text, r"Customer Total Policy Holdings\s*\(as of (\d{1,2} \w+ \d{4})\)")
    policy_name = _grab(full_text, r"(Manulife InvestReady[^\n]+?Flexi\s+\d+)\s+SGD\s+[\d,]+\.\d{2}\s*\n[^\n]*Policy Name")
    policy_number = _grab(full_text, r"(\d{6,12})\s+SGD\s+[\d,]+\.\d{2}\s*\n[^\n]*Policy Number")
    policy_issue_date = _grab(full_text, r"(\d{2}/\d{2}/\d{4})\s+Total Rider Premiums\s*\n\s*Policy Issue Date")

    account_value = _grab_money(full_text, r"SGD\s+([\d,]+\.\d{2})\s*\n[^\n]*Account Value")
    policy_investment_cost = _grab_money(full_text, r"SGD\s+([\d,]+\.\d{2})\s*\n[^\n]*Policy Investment Cost")
    total_pnl_dollar = _grab_money(full_text, r"SGD\s+([\d,]+\.\d{2})\s*\n\s*Total P&L \(\$\)")
    total_rider_premiums = _grab_money(full_text, r"SGD\s+([\d,]+\.\d{2})\s*\n[^\n]*Total Rider Premiums")
    total_dividends_reinvested = _grab_money(full_text, r"SGD\s+([\d,]+\.\d{2})\s*\n\s*Total Dividends Reinvested")

    total_pnl_pct = float(_grab(full_text, r"^([\d.]+)\s*\n\s*Total P&L \(%\)", flags=re.MULTILINE) or 0)
    annualised_pnl_pct = float(_grab(full_text, r"^([\d.]+)\s*\n\s*Annualised P&L \(%\)", flags=re.MULTILINE) or 0)

    risk_profile = _grab(full_text, r"^(\w+)\s+Total Investment Value\s*\n\s*Risk Profile Questionnaire", flags=re.MULTILINE)
    cka_status = _grab(full_text, r"Customer Knowledge Assessment\s+(\w+)\s+Total Market Value")
    cka_expiry = _grab(
        full_text,
        r"Customer Knowledge Assessment[^\n]*\n\(Expiry date:\s+(\d{2}/\d{2}/\d{4})\)",
    )

    missing = [
        name for name, val in [
            ("customer_name", customer_name),
            ("report_date", report_date),
            ("policy_name", policy_name),
            ("policy_number", policy_number),
            ("policy_issue_date", policy_issue_date),
            ("risk_profile", risk_profile),
            ("cka_status", cka_status),
            ("cka_expiry", cka_expiry),
        ]
        if not val
    ]
    if missing:
        raise ValueError(f"Missing required fields in PDF: {', '.join(missing)}")
    if not holdings:
        raise ValueError("No fund holdings detected on page 3")

    return RawReport(
        customer_name=customer_name,
        report_date=report_date,
        policy_name=policy_name,
        policy_number=policy_number,
        policy_issue_date=policy_issue_date,
        account_value=account_value,
        policy_investment_cost=policy_investment_cost,
        total_pnl_dollar=total_pnl_dollar,
        total_pnl_pct=total_pnl_pct,
        annualised_pnl_pct=annualised_pnl_pct,
        total_rider_premiums=total_rider_premiums,
        total_dividends_reinvested=total_dividends_reinvested,
        risk_profile=risk_profile,
        cka_status=cka_status,
        cka_expiry=cka_expiry,
        holdings=holdings,
    )


_TICKER_RE = re.compile(r"\(([A-Z]{3,5})\)\s*$")


def _parse_holdings_from_tables(pdf) -> list[Holding]:
    """Extract Fund Holdings from page 3.

    Approach: locate the holdings table via its header row ("Fund Value", "Total P&L ($)",
    "Total P&L (%)"), record which column index each label sits at, then read each
    fund's data row by indexing those columns. This is more robust than positional
    "take the Nth numeric" because pdfplumber sometimes splits a single visual column
    into adjacent cells (which happens when a PDF has been edited with overlay text).
    """
    holdings: list[Holding] = []
    if len(pdf.pages) < 3:
        return holdings

    for page in pdf.pages[2:]:
        for table in page.extract_tables() or []:
            holdings.extend(_holdings_from_table(table))
        if holdings:
            break
    return holdings


_FIELD_LABELS = {
    "fund_value": ("fund value",),
    "pnl_dollar": ("total p&l\n($)", "total p&l ($)"),
    "pnl_pct": ("total p&l\n(%)", "total p&l (%)"),
}


def _holdings_from_table(table: list[list[Optional[str]]]) -> list[Holding]:
    if not table:
        return []

    column_map = _build_column_map(table[0])
    if not all(k in column_map for k in ("fund_value", "pnl_dollar", "pnl_pct")):
        return []

    out: list[Holding] = []
    pending_header: Optional[tuple[str, str]] = None
    for row in table[1:]:
        cells = [(c or "").strip() for c in row]
        if not any(cells):
            continue

        joined = " ".join(c for c in cells if c).replace("\n", " ").strip()
        m = _TICKER_RE.search(joined)
        if m and not _looks_like_data_row(cells):
            ticker = m.group(1)
            full_name = joined[: m.start()].strip().rstrip("(").strip()
            pending_header = (full_name, ticker)
            continue

        if pending_header and _looks_like_data_row(cells):
            holding = _build_holding(pending_header, cells, column_map)
            if holding:
                out.append(holding)
            pending_header = None

    return out


def _build_column_map(header_row: list[Optional[str]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for idx, raw in enumerate(header_row):
        if not raw:
            continue
        norm = raw.lower().strip()
        for field, labels in _FIELD_LABELS.items():
            if field in out:
                continue
            if any(label in norm for label in labels):
                out[field] = idx
    return out


_NUMERIC_RE = re.compile(r"[\d,]+\.\d+(?:\s*\d+)?")


def _looks_like_data_row(cells: list[str]) -> bool:
    """A data row contains at least three numeric-looking cells."""
    numeric = sum(1 for c in cells if _NUMERIC_RE.fullmatch(c.replace("\n", " ").strip()))
    return numeric >= 3


def _build_holding(header: tuple[str, str], cells: list[str], column_map: dict[str, int]) -> Optional[Holding]:
    full_name, ticker = header

    fund_value = _read_numeric(cells, column_map["fund_value"])
    pnl_dollar = _read_numeric(cells, column_map["pnl_dollar"])
    pnl_pct = _read_numeric(cells, column_map["pnl_pct"])
    if fund_value is None or pnl_dollar is None or pnl_pct is None:
        return None

    norm = [c.replace("\n", " ").strip() for c in cells]
    text_before_value = [c for i, c in enumerate(norm) if i < column_map["fund_value"] and c]
    if len(text_before_value) < 2:
        return None
    asset_class, sub_asset_class = text_before_value[0], text_before_value[1]

    return Holding(
        fund_full_name=full_name,
        ticker=ticker,
        asset_class=asset_class,
        sub_asset_class=sub_asset_class,
        fund_value=fund_value,
        pnl_dollar=pnl_dollar,
        pnl_pct=pnl_pct,
    )


def _read_numeric(cells: list[str], col_idx: int) -> Optional[float]:
    """Return the first numeric value at or after `col_idx`, skipping empty cells.

    pdfplumber sometimes splits a column into 2-3 sub-cells; the value sits in the
    first non-empty one. We scan forward at most a few cells from the header column.
    """
    for i in range(col_idx, min(col_idx + 4, len(cells))):
        cell = (cells[i] or "").replace("\n", " ").strip()
        if cell and _NUMERIC_RE.fullmatch(cell):
            return _to_float(cells[i])
    return None
