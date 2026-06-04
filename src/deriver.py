"""Turn a RawReport into the full data dict the Jinja2 template expects."""

from __future__ import annotations

import re
from dataclasses import asdict
from datetime import date
from typing import Any

from dateutil.parser import parse as parse_date
from dateutil.relativedelta import relativedelta

from .parser import Holding, RawReport


COLORS = ["#0F6E56", "#185FA5", "#D85A30", "#534AB7", "#BA7517", "#0C447C", "#993556"]

SUB_ASSET_CLASS_LABELS = {
    "Global Equity": "Global equity",
    "Asia Equity": "Asia equity",
    "US Equity": "US equity",
    "Emerging Markets Bond": "EM bond",
    "Multi Asset": "Multi-asset",
    "Asia Pacific Equity": "Asia-Pacific equity",
    "European Equity": "European equity",
    "Japan Equity": "Japan equity",
    "Global Bond": "Global bond",
    "Asia Bond": "Asia bond",
}

EQUITY_KEYWORDS = ("equity",)


def derive(raw: RawReport) -> dict[str, Any]:
    is_single_premium = _is_single_premium_policy(raw.policy_name)
    flexi_term = 0 if is_single_premium else (_int_from(raw.policy_name, r"Flexi\s+(\d+)") or 10)
    policy_term_years = None if is_single_premium else (_int_from(raw.policy_name, r"(\d+)\s+Years?\s+Flexi") or flexi_term)

    issue_date = _parse_dmy(raw.policy_issue_date)
    report_date = parse_date(raw.report_date).date()

    months_invested = _months_between(issue_date, report_date)
    premiums_paid_count = 1 if is_single_premium else count_anniversaries_paid(issue_date, report_date)
    inferred = (
        {"annual_premium": raw.policy_investment_cost, "frequency": "single", "ambiguous": False}
        if is_single_premium
        else infer_annual_premium(
            raw.policy_investment_cost,
            issue_date,
            report_date,
            premiums_paid_count,
        )
    )
    annual_premium = inferred["annual_premium"]
    premium_frequency = inferred["frequency"]                # 'monthly' | 'annual'
    premium_frequency_ambiguous = inferred["ambiguous"]
    premiums_remaining = 0 if is_single_premium else max(0, flexi_term - premiums_paid_count)

    # capital_pct can exceed 100 when account < cost (a loss).
    # Clamp the visual representation to [0, 100] so the progress bar fills
    # sensibly, and surface a separate `loss_pct` for the legend label.
    raw_capital_pct = (
        (raw.policy_investment_cost / raw.account_value * 100) if raw.account_value else 0.0
    )
    in_loss = raw_capital_pct > 100
    capital_pct = min(100.0, raw_capital_pct)
    gains_pct = max(0.0, 100 - capital_pct)
    loss_pct = max(0.0, raw_capital_pct - 100) if in_loss else 0.0

    holdings_enriched = _enrich_holdings(raw.holdings, raw.account_value)
    fund_pnl_total = sum(h["pnl_dollar"] for h in holdings_enriched)

    equity_pct = sum(
        h["allocation_pct"] for h in holdings_enriched
        if any(kw in h["asset_class"].lower() or kw in h["sub_asset_class"].lower() for kw in EQUITY_KEYWORDS)
    )
    income_pct = max(0.0, 100 - equity_pct)

    return {
        "customer_name": raw.customer_name,
        "customer_name_title": _title_case_name(raw.customer_name),
        "report_date": raw.report_date,
        "policy_name": raw.policy_name,
        "policy_name_pretty": _prettify_policy_name(raw.policy_name),
        "policy_number": raw.policy_number,
        "policy_issue_date": raw.policy_issue_date,
        "inception_date_pretty": _pretty_date(raw.policy_issue_date),
        "account_value": raw.account_value,
        "policy_investment_cost": raw.policy_investment_cost,
        "total_pnl_dollar": raw.total_pnl_dollar,
        "total_pnl_pct": raw.total_pnl_pct,
        "annualised_pnl_pct": raw.annualised_pnl_pct,
        "total_rider_premiums": raw.total_rider_premiums,
        "total_dividends_reinvested": raw.total_dividends_reinvested,
        "total_dividends_paid_out": raw.total_dividends_paid_out,
        "total_partial_withdrawal": raw.total_partial_withdrawal,
        "risk_profile": raw.risk_profile,
        "risk_profile_expiry": raw.risk_profile_expiry,
        "risk_profile_expiry_pretty": _pretty_date(raw.risk_profile_expiry),
        "risk_profile_expired": _is_expired_dmy(raw.risk_profile_expiry, report_date),
        "cka_status": raw.cka_status,
        "cka_expiry": raw.cka_expiry,
        "cka_expiry_pretty": _pretty_date(raw.cka_expiry),
        "cka_expired": _is_expired_dmy(raw.cka_expiry, report_date),
        "is_single_premium": is_single_premium,
        "flexi_term": flexi_term,
        "policy_term_years": policy_term_years,
        "months_invested": months_invested,
        "premiums_paid_count": premiums_paid_count,
        "annual_premium": annual_premium,
        "premium_frequency": premium_frequency,
        "premium_frequency_ambiguous": premium_frequency_ambiguous,
        "premiums_remaining": premiums_remaining,
        "capital_pct": round(capital_pct, 1),
        "gains_pct": round(gains_pct, 1),
        "in_loss": in_loss,
        "loss_pct": round(loss_pct, 1),
        "holdings_enriched": holdings_enriched,
        "fund_pnl_total": fund_pnl_total,
        "equity_pct": round(equity_pct, 1),
        "income_pct": round(income_pct, 1),
    }


def count_anniversaries_paid(issue_date: date, report_date: date) -> int:
    """Inception itself counts as the first premium."""
    if report_date < issue_date:
        return 0
    years_diff = relativedelta(report_date, issue_date).years
    next_anniv = issue_date + relativedelta(years=years_diff)
    if report_date >= next_anniv:
        return years_diff + 1
    return years_diff


def infer_annual_premium(
    total_paid: float, issue_date: date, report_date: date, anniversaries: int
) -> dict[str, Any]:
    """Infer the policy's annual premium and the inferred payment frequency.

    The PDF doesn't state the premium frequency, so we back it out by trying
    both interpretations:

      ANNUAL  - one premium per anniversary year. Annual = total / anniversaries.
      MONTHLY - one premium at inception then every month after.
                Monthly rate = total / (months_elapsed + 1); annual = rate * 12.

    Real-world Manulife premiums are multiples of $100 (often $500 / $1,000),
    so we pick whichever interpretation lands closer to a clean $100 multiple.
    Monthly only wins when its residual is BOTH <= $5 AND > $5 better than
    annual's. Bias toward annual on near-ties (more common case).
    Use completed monthly payment intervals here; the display month count
    rounds partial months up, which is too generous for payment counts.

    Genuine ambiguity exists at 12 / 24 / 36-month boundaries — at those
    moments an annual-pay $10K and a monthly-pay $833.33 client both produce
    the same total_paid. The math can't tell them apart. We return the
    annual interpretation (safer for the bonus calc) and set
    ambiguous=True so the snapshot can render a disclaimer.

    Returns: {'annual_premium': float, 'frequency': 'monthly'|'annual',
              'ambiguous': bool}
    """
    if total_paid <= 0:
        return {"annual_premium": 0.0, "frequency": "annual", "ambiguous": False}

    annual_est = total_paid / anniversaries if anniversaries > 0 else 0.0

    months_elapsed = _full_months_between(issue_date, report_date)
    monthly_payments = months_elapsed + 1
    monthly_annual_est = (
        (total_paid / monthly_payments) * 12 if monthly_payments > 0 else 0.0
    )

    annual_residual = _residual_from_hundred(annual_est)
    monthly_residual = _residual_from_hundred(monthly_annual_est)

    if (
        monthly_annual_est > 0
        and monthly_residual <= 5
        and monthly_residual < annual_residual - 5
    ):
        return {
            "annual_premium": float(round(monthly_annual_est / 100) * 100),
            "frequency": "monthly",
            "ambiguous": False,
        }

    ambiguous = (
        annual_est > 0
        and monthly_annual_est > 0
        and annual_residual <= 5
        and monthly_residual <= 5
        and abs(annual_est - monthly_annual_est) <= 5
    )
    # Snap to the nearest $100 when within $5 — absorbs sub-cent drift like
    # $9,999.96 → $10,000. Preserve unusual values (e.g. $10,250) verbatim.
    clean_annual = (
        float(round(annual_est / 100) * 100) if annual_residual <= 5
        else round(annual_est, 2)
    )

    return {
        "annual_premium": clean_annual,
        "frequency": "annual",
        "ambiguous": ambiguous,
    }


def _residual_from_hundred(v: float) -> float:
    return abs(v - round(v / 100) * 100)


def _full_months_between(start: date, end: date) -> int:
    """Completed monthly payment intervals between two dates."""
    if end < start:
        return 0
    rd = relativedelta(end, start)
    return max(0, rd.years * 12 + rd.months)


def _int_from(text: str, pattern: str) -> int | None:
    m = re.search(pattern, text or "")
    return int(m.group(1)) if m else None


def _parse_dmy(s: str) -> date:
    return parse_date(s, dayfirst=True).date()


def _months_between(start: date, end: date) -> int:
    """Calendar months elapsed, rounded up when more than half the month has passed."""
    if end < start:
        return 0
    rd = relativedelta(end, start)
    months = rd.years * 12 + rd.months
    if rd.days >= 15:
        months += 1
    return months


def _title_case_name(name: str) -> str:
    return " ".join(w.capitalize() for w in (name or "").strip().split())


def _pretty_date(s: str) -> str:
    """'18/08/2026' -> '18 Aug 2026'."""
    if not s:
        return ""
    try:
        d = _parse_dmy(s)
    except (ValueError, TypeError):
        return s
    return d.strftime("%d %b %Y")


def _prettify_policy_name(name: str) -> str:
    """'Manulife InvestReady (III) 13 Years Flexi 10' -> 'Manulife InvestReady (III) — 13 Years Flexi 10'."""
    return re.sub(r"\(III\)\s+", "(III) — ", name or "")


def _is_single_premium_policy(policy_name: str) -> bool:
    return bool(re.search(r"Manulink\s+Investor\s*\(II\)\s*-\s*SRS", policy_name or "", re.IGNORECASE))


def _is_expired_dmy(s: str, report_date: date) -> bool:
    if not s:
        return False
    try:
        return _parse_dmy(s) < report_date
    except (ValueError, TypeError):
        return False


def _enrich_holdings(holdings: list[Holding], account_value: float) -> list[dict]:
    items = sorted(
        (asdict(h) for h in holdings),
        key=lambda h: h["fund_value"],
        reverse=True,
    )
    for i, h in enumerate(items):
        h["allocation_pct"] = (h["fund_value"] / account_value * 100) if account_value else 0.0
        h["color"] = COLORS[i % len(COLORS)]
        h["display_name"] = shorten_fund_name(h["fund_full_name"])
        h["sub_asset_class_label"] = SUB_ASSET_CLASS_LABELS.get(h["sub_asset_class"], h["sub_asset_class"])
    return items


def shorten_fund_name(full: str) -> str:
    """Display the fund name EXACTLY as Manulife wrote it.

    This function used to "shorten" the verbose name by stripping
    share-class / hedge / distribution suffixes — but every iteration of
    that lost meaningful descriptors (Hard Currency, Diversified Income,
    Opps, …) and the user reasonably wants the canonical name preserved.
    The only thing we do here is patch up PDF.js word-level extraction
    artefacts so compound words don't render with a stray space:

        'Bh- SGD'      -> 'Bh-SGD'
        'Multi- Asset' -> 'Multi-Asset'
        'H2- SGD'      -> 'H2-SGD'

    Real separator dashes (' - ') are preserved verbatim because
    'Manulife Global Fund - Global Multi-Asset Diversified Income Fund
    AA (SGD Hedged) MDIST (G)' is the canonical name as printed in the
    PDF and that's exactly what the report should display.
    """
    s = full.strip()
    # Re-fuse only when the dash/slash is glued to the preceding token —
    # PDF.js artefact signature is no-space-before / space-after. Real
    # separator dashes (' - ') stay intact because they have spaces on
    # both sides.
    s = re.sub(r"(\S[\/\-])\s+(\S)", r"\1\2", s)
    return s.strip()
