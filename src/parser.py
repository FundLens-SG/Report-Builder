"""Parse a Manulife Customer Investment Report PDF into one or more RawReports.

A single PDF can contain multiple policies (one customer, two ILPs, etc.).
`parse_pdf()` returns a list — one entry per policy detected. For backward
compatibility, the legacy `parse_pdf_single()` returns just the first policy.
"""

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
    total_dividends_paid_out: float
    total_partial_withdrawal: float
    risk_profile: str
    risk_profile_expiry: str
    cka_status: str
    cka_expiry: str
    holdings: list[Holding] = field(default_factory=list)


# ---------- Helpers ----------------------------------------------------------

def _to_float(s: Optional[str]) -> float:
    if not s:
        return 0.0
    # Manulife wraps long numbers across cell rows: "3,326.3300\n0" means 3326.33000.
    cleaned = re.sub(r"\s+", "", s).replace(",", "")
    return float(cleaned)


def _grab(text: str, pattern: str, default: Optional[str] = None, flags: int = 0) -> Optional[str]:
    m = re.search(pattern, text, flags)
    return m.group(1).strip() if m else default


def _grab_first(text: str, patterns: list[str], flags: int = 0) -> Optional[str]:
    for p in patterns:
        v = _grab(text, p, flags=flags)
        if v:
            return v
    return None


def _grab_money_first(text: str, patterns: list[str], flags: int = 0) -> float:
    return _to_float(_grab_first(text, patterns, flags=flags))


# ---------- Page-level routing ----------------------------------------------

POLICY_HEADER_RE = re.compile(
    r"^[^\n]*?\(\s*\d{6,12}\s*\)\s+\(as of \d{1,2} \w+ \d{4}\)\s*$",
    re.MULTILINE,
)
POLICY_NUMBER_FIELD_RE = re.compile(
    r"Policy Number[ \t]+\d{6,12}|^\s*\d{6,12}[ \t]+SGD[ \t]+-?[\d,]+\.\d{2}\s*\n[^\n]*Policy Number",
    re.MULTILINE,
)


def _find_policy_blocks(pages_text: list[str]) -> list[tuple[int, int]]:
    """Return [(info_page_idx, holdings_page_idx)] for each policy detected.

    A page is a "policy info page" if it contains either:
      - the "<Product> (POLICYNUM) (as of DATE)" header line, OR
      - a "Policy Number <NNNN>" field (catches re-laid-out PDFs where the
        header policy number may have drifted).
    The holdings table is on the page that immediately follows.
    """
    blocks: list[tuple[int, int]] = []
    for i in range(1, len(pages_text)):
        text = pages_text[i]
        if not text:
            continue
        if POLICY_HEADER_RE.search(text) or POLICY_NUMBER_FIELD_RE.search(text):
            blocks.append((i, i + 1))
    return blocks


# ---------- Customer-level fields (shared across all policies) --------------

def _parse_customer_level(page1_text: str) -> dict:
    # Customer name: handle parenthesised Chinese aliases ("TAN SAN SAN
    # (CHEN SHANSHAN)"), hyphens, periods, commas. Greedy match anchored on
    # the trailing " Manulife (Singapore)" terminator pulls the regex back
    # to the last uppercase or `)` before the terminator.
    customer_name = _grab_first(
        page1_text,
        [
            r"^([A-Z][A-Z ()\-.,]*[A-Z)])[ \t]+Manulife[ \t]*\(Singapore\)",
            r"Manulife[ \t]*\(Singapore\)[ \t]+Pte\.[ \t]*Ltd\.[^\n]*\n[ \t]*([A-Z][A-Z ()\-.,]*[A-Z)])[ \t]*\n",
        ],
        flags=re.MULTILINE,
    )
    report_date = _grab(
        page1_text,
        r"Customer Total Policy Holdings\s*\(as of (\d{1,2} \w+ \d{4})\)",
    )
    # Multi-word risk-profile values ("Moderately Aggressive", "Not Done")
    # plus a fallback for the value-on-next-line layout.
    risk_profile = _grab_first(page1_text, [
        r"Risk Profile Questionnaire[ \t]+([A-Za-z][A-Za-z ]*?)(?=[ \t]*\(Expiry|[ \t]*\n|$)",
        r"^([A-Za-z][A-Za-z ]*?)[ \t]+Total Investment Value\s*\n\s*Risk Profile Questionnaire",
        r"Risk Profile Questionnaire\s*\n[ \t]*([A-Za-z][A-Za-z ]+?)(?=[ \t]*\n)",
    ], flags=re.MULTILINE)
    cka_status = _grab_first(page1_text, [
        r"Customer Knowledge Assessment[ \t]+(\w+)[ \t]+Total Market Value",
        r"Customer Knowledge Assessment[ \t]+(\w+)",
    ])
    cka_expiry = _grab(
        page1_text,
        r"Customer Knowledge Assessment[\s\S]*?\(Expiry date:\s+(\d{2}/\d{2}/\d{4})\)",
    )
    risk_profile_expiry = _grab(
        page1_text,
        r"Risk Profile Questionnaire[\s\S]*?\(Expiry date:\s+(\d{2}/\d{2}/\d{4})\)",
    )

    # Only customer_name + report_date are TRULY required — without them we
    # can't build the filename or header. Risk profile / CKA fields are
    # footer-only metadata; the snapshot omits them gracefully when missing
    # so we don't fail the whole parse over a cosmetic disclosure line.
    missing = [name for name, val in [
        ("customer_name", customer_name),
        ("report_date", report_date),
    ] if not val]
    if missing:
        raise ValueError(f"Missing customer-level fields in PDF: {', '.join(missing)}")

    return dict(
        customer_name=customer_name,
        report_date=report_date,
        risk_profile=(risk_profile or "").strip(),
        risk_profile_expiry=risk_profile_expiry or "",
        cka_status=cka_status or "",
        cka_expiry=cka_expiry or "",
    )


# ---------- Per-policy parser -----------------------------------------------

def _parse_policy_block(
    pages_text: list[str],
    pdf,
    block: tuple[int, int],
    customer: dict,
) -> RawReport:
    info_idx, holdings_idx = block
    text = pages_text[info_idx] if info_idx < len(pages_text) else ""

    # `[ \t]+` matches inline whitespace ONLY — must NOT cross newlines.
    # Bare `\s+` would jump to the next line and grab the wrong field's value
    # (e.g. for Policy Investment Cost, latch onto the SGD on the row above).
    policy_name = _grab_first(text, [
        r"Policy Name[ \t]+(.+?)[ \t]+Account Value[ \t]+SGD",
        r"^([^\n]+?)[ \t]+SGD[ \t]+-?[\d,]+\.\d{2}\s*\n[^\n]*Policy Name",
    ], flags=re.MULTILINE)
    policy_number = _grab_first(text, [
        r"Policy Number[ \t]+(\d{6,12})",
        r"(\d{6,12})[ \t]+SGD[ \t]+-?[\d,]+\.\d{2}\s*\n[^\n]*Policy Number",
    ])
    policy_issue_date = _grab_first(text, [
        r"Policy Issue Date[ \t]+(\d{2}/\d{2}/\d{4})",
        r"(\d{2}/\d{2}/\d{4})[ \t]+Total Rider Premiums\s*\n\s*Policy Issue Date",
        r"^[ \t]*(\d{2}/\d{2}/\d{4})\s*\n\s*Policy Issue Date",
    ], flags=re.MULTILINE)

    account_value = _grab_money_first(text, [
        r"Account Value[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})",
        r"SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n[^\n]*Account Value",
    ])
    policy_investment_cost = _grab_money_first(text, [
        r"Policy Investment Cost\*?[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})",
        r"SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n[^\n]*Policy Investment Cost",
    ])
    total_pnl_dollar = _grab_money_first(text, [
        r"Total P&L \(\$\)[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})",
        r"SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n\s*Total P&L \(\$\)",
    ])
    total_rider_premiums = _grab_money_first(text, [
        r"Total Rider Premiums[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})",
        r"SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n[^\n]*Total Rider Premiums",
    ])
    total_dividends_reinvested = _grab_money_first(text, [
        r"Total Dividends Reinvested[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})",
        r"SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n\s*Total Dividends Reinvested",
    ])
    total_dividends_paid_out = _grab_money_first(text, [
        r"Total Dividends Paid Out\*?[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})",
        r"SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n\s*Total Dividends Paid Out",
    ])
    total_partial_withdrawal = _grab_money_first(text, [
        r"Total Partial Withdrawal\*?[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})",
        r"SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n\s*Total Partial Withdrawal",
    ])

    total_pnl_pct = float(_grab_first(text, [
        r"Total P&L \(%\)[ \t]+(-?[\d.]+)",
        r"^(-?[\d.]+)\s*\n\s*Total P&L \(%\)",
    ], flags=re.MULTILINE) or 0)
    annualised_pnl_pct = float(_grab_first(text, [
        r"Annualised P&L \(%\)[ \t]+(-?[\d.]+)",
        r"^(-?[\d.]+)\s*\n\s*Annualised P&L \(%\)",
    ], flags=re.MULTILINE) or 0)

    missing = [name for name, val in [
        ("policy_name", policy_name),
        ("policy_number", policy_number),
        ("policy_issue_date", policy_issue_date),
    ] if not val]
    if missing:
        raise ValueError(
            f"Missing policy fields on page {info_idx + 1}: {', '.join(missing)}"
        )

    holdings = (
        _holdings_from_page(pdf.pages[holdings_idx])
        if holdings_idx < len(pdf.pages)
        else []
    )
    if not holdings:
        raise ValueError(f"No fund holdings detected on page {holdings_idx + 1}")

    return RawReport(
        customer_name=customer["customer_name"],
        report_date=customer["report_date"],
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
        total_dividends_paid_out=total_dividends_paid_out,
        total_partial_withdrawal=total_partial_withdrawal,
        risk_profile=customer["risk_profile"],
        risk_profile_expiry=customer["risk_profile_expiry"],
        cka_status=customer["cka_status"],
        cka_expiry=customer["cka_expiry"],
        holdings=holdings,
    )


def parse_pdf(pdf_path: str) -> list[RawReport]:
    """Parse a Manulife PDF into a list of RawReports — one per policy."""
    with pdfplumber.open(pdf_path) as pdf:
        pages_text = [p.extract_text() or "" for p in pdf.pages]
        customer = _parse_customer_level(pages_text[0] if pages_text else "")
        blocks = _find_policy_blocks(pages_text)
        if not blocks:
            raise ValueError("No policy section detected in PDF")
        return [_parse_policy_block(pages_text, pdf, b, customer) for b in blocks]


def parse_pdf_single(pdf_path: str) -> RawReport:
    """Backward-compatible wrapper — returns the first policy in the PDF."""
    policies = parse_pdf(pdf_path)
    return policies[0]


# ---------- Holdings parsing -------------------------------------------------

_TICKER_RE = re.compile(r"\(([A-Z][A-Z0-9]*(?:\s+[A-Z][A-Z0-9]*)*)\)\s*$")
_NUMERIC_RE = re.compile(r"-?[\d,]+\.\d+(?:\s*\d+)?")
_FIELD_LABELS = {
    "fund_value": ("fund value",),
    "pnl_dollar": ("total p&l\n($)", "total p&l ($)"),
    "pnl_pct": ("total p&l\n(%)", "total p&l (%)"),
}


def _holdings_from_page(page) -> list[Holding]:
    """Extract Holdings from a single page's tables."""
    out: list[Holding] = []
    for table in page.extract_tables() or []:
        out.extend(_holdings_from_table(table))
        if out:
            break
    return out


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
        if m and not _looks_like_data_row(cells) and not _is_table_header_like(joined):
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
        for field_name, labels in _FIELD_LABELS.items():
            if field_name in out:
                continue
            if any(label in norm for label in labels):
                out[field_name] = idx
    return out


def _looks_like_data_row(cells: list[str]) -> bool:
    """A data row contains at least three numeric-looking cells."""
    numeric = sum(1 for c in cells if _NUMERIC_RE.fullmatch(c.replace("\n", " ").strip()))
    return numeric >= 3


def _is_table_header_like(text: str) -> bool:
    return bool(re.search(
        r"Fund Holdings|Asset Class|Sub-?Asset|Fund Value|NAV|Units|Total P&L|Paid Out|Reinvested",
        text,
        re.IGNORECASE,
    ))


def _build_holding(
    header: tuple[str, str],
    cells: list[str],
    column_map: dict[str, int],
) -> Optional[Holding]:
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

    pdfplumber sometimes splits a column into 2-3 sub-cells; the value sits in
    the first non-empty one. We scan forward at most a few cells.
    """
    for i in range(col_idx, min(col_idx + 4, len(cells))):
        cell = (cells[i] or "").replace("\n", " ").strip()
        if cell and _NUMERIC_RE.fullmatch(cell):
            return _to_float(cells[i])
    return None
