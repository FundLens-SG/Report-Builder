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

ASSET_CLASS_LABELS = {
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
    flexi_term = _int_from(raw.policy_name, r"Flexi\s+(\d+)") or 10
    policy_term_years = _int_from(raw.policy_name, r"(\d+)\s+Years?\s+Flexi") or flexi_term

    issue_date = _parse_dmy(raw.policy_issue_date)
    report_date = parse_date(raw.report_date).date()

    months_invested = _months_between(issue_date, report_date)
    premiums_paid_count = count_anniversaries_paid(issue_date, report_date)
    annual_premium = (
        round(raw.policy_investment_cost / premiums_paid_count, 2) if premiums_paid_count else 0.0
    )
    premiums_remaining = max(0, flexi_term - premiums_paid_count)

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
        "risk_profile": raw.risk_profile,
        "cka_status": raw.cka_status,
        "cka_expiry": raw.cka_expiry,
        "cka_expiry_pretty": _pretty_date(raw.cka_expiry),
        "flexi_term": flexi_term,
        "policy_term_years": policy_term_years,
        "months_invested": months_invested,
        "premiums_paid_count": premiums_paid_count,
        "annual_premium": annual_premium,
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
        h["asset_class_label"] = ASSET_CLASS_LABELS.get(h["sub_asset_class"], h["sub_asset_class"])
    return items


def shorten_fund_name(full: str) -> str:
    """Shorten verbose Manulife fund names for the per-fund table.

    'Capital Group New Perspective Fund (LUX) Bh-SGD' -> 'Capital Group New Perspective'
    'Schroder Asian Growth Fund SGD' -> 'Schroder Asian Growth'
    'Neuberger Berman US MultiCap Opps SGD A Acc' -> 'Neuberger Berman US MultiCap'
    'Neuberger Berman EM Debt Hard Currency SGD A MD' -> 'Neuberger Berman EM Debt'
    'Manulife Global Fund - Global Multi-Asset Diversified Income Fund AA (SGD Hedged) MDIST (G)'
        -> 'Manulife Global Multi-Asset'
    """
    s = full.strip()
    s = re.sub(r"^Manulife Global Fund\s*-\s*Global\s+", "Manulife Global ", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+Fund\s*[-(].*$", "", s)
    s = re.sub(r"\s+Fund\s+[A-Z]{1,3}(?:\s+\w+)*.*$", "", s)
    s = re.sub(r"\s+Fund\s+SGD$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+Fund$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+Opps?\s+SGD.*$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+Hard Currency SGD.*$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+Diversifi?ed Income.*$", "", s, flags=re.IGNORECASE)
    return s.strip()
