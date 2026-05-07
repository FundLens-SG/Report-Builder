// Mirrors src/deriver.py. Turns the raw parsed report into the data dict the
// snapshot template consumes (with all derived calculations).

import { lookupBonusRates } from './bonus.js';

const COLORS = ['#0F6E56', '#185FA5', '#D85A30', '#534AB7', '#BA7517', '#0C447C', '#993556'];

const ASSET_CLASS_LABELS = {
  'Global Equity': 'Global equity',
  'Asia Equity': 'Asia equity',
  'US Equity': 'US equity',
  'Emerging Markets Bond': 'EM bond',
  'Multi Asset': 'Multi-asset',
  'Asia Pacific Equity': 'Asia-Pacific equity',
  'European Equity': 'European equity',
  'Japan Equity': 'Japan equity',
  'Global Bond': 'Global bond',
  'Asia Bond': 'Asia bond',
};


/**
 * Derive the full data model for the snapshot template.
 *
 * @param {object} raw         Output of parsePdf()
 * @param {object} [options]   Bonus-exclusion adjustments
 * @param {boolean} [options.excludeWelcomeBonus=false]
 * @param {boolean} [options.excludeAnnualPremiumBonus=false]
 * @param {number}  [options.welcomeBonusRate]      Override auto-detected welcome rate (0-1)
 * @param {number}  [options.annualPremiumBonusRate] Override auto-detected annual rate (0-1)
 *
 * When either exclude flag is true, Net gain, Total return, Annualised IRR,
 * and the Capital/Gains bar are recomputed by adding the bonus dollar amounts
 * to the cost basis (treating bonuses as if they were premiums paid).
 */
export function derive(raw, options = {}) {
  const flexiTerm = intFrom(raw.policyName, /Flexi\s+(\d+)/) ?? 10;
  const policyTermYears = intFrom(raw.policyName, /(\d+)\s+Years?\s+Flexi/) ?? flexiTerm;

  const issueDate = parseDmy(raw.policyIssueDate);
  const reportDate = parseFlexibleDate(raw.reportDate);

  const monthsInvested = monthsBetween(issueDate, reportDate);
  const premiumsPaidCount = countAnniversariesPaid(issueDate, reportDate);
  const annualPremium = premiumsPaidCount
    ? round2(raw.policyInvestmentCost / premiumsPaidCount)
    : 0;
  const premiumsRemaining = Math.max(0, flexiTerm - premiumsPaidCount);

  // Auto-detect bonus rates from the product/variation; allow caller overrides.
  // For unrecognised products (e.g. Manulink Investor (II) - SRS) we treat the
  // bonus rates as zero and IGNORE any caller overrides — the panel rates are
  // configured for the *recognised* policy and shouldn't bleed onto Manulink
  // policies in the same PDF, where there is no equivalent first-year bonus.
  const auto = lookupBonusRates(raw.product, raw.variation, annualPremium);
  const welcomeBonusRate = auto.recognised
    ? (options.welcomeBonusRate ?? auto.welcomeRate)
    : 0;
  const annualPremiumBonusRate = auto.recognised
    ? (options.annualPremiumBonusRate ?? auto.annualPremiumRate)
    : 0;
  const welcomeBonusAmount = round2(annualPremium * welcomeBonusRate);
  const annualPremiumBonusAmount = round2(annualPremium * annualPremiumBonusRate);

  const excludeWelcome = !!options.excludeWelcomeBonus;
  const excludeAnnual = !!options.excludeAnnualPremiumBonus;
  const excludedBonusAmount =
    (excludeWelcome ? welcomeBonusAmount : 0) +
    (excludeAnnual ? annualPremiumBonusAmount : 0);
  const adjustmentsActive = excludedBonusAmount > 0;

  // Adjusted cost = real cost + bonuses we treat as cost. When no exclusions,
  // adjustedCost === policyInvestmentCost and the metric values fall back to
  // the PDF's stated numbers (preserves what Manulife officially reported).
  const adjustedCost = raw.policyInvestmentCost + excludedBonusAmount;

  let totalPnlDollar = raw.totalPnlDollar;
  let totalPnlPct = raw.totalPnlPct;
  let annualisedPnlPct = raw.annualisedPnlPct;
  if (adjustmentsActive && raw.accountValue && adjustedCost > 0) {
    totalPnlDollar = round2(raw.accountValue - adjustedCost);
    totalPnlPct = round2((raw.accountValue / adjustedCost - 1) * 100);
    const days = Math.max(1, daysBetween(issueDate, reportDate));
    annualisedPnlPct = round2(
      (Math.pow(raw.accountValue / adjustedCost, 365 / days) - 1) * 100
    );
  }

  // capitalPct can exceed 100 when account value is below cost (a loss).
  // Clamp the visual representation to [0, 100] so the progress bar fills
  // sensibly, and surface a separate `lossPct` for the legend label.
  const rawCapitalPct = raw.accountValue
    ? (adjustedCost / raw.accountValue) * 100
    : 0;
  const inLoss = rawCapitalPct > 100;
  const capitalPct = Math.min(100, rawCapitalPct);
  const gainsPct = Math.max(0, 100 - capitalPct);
  const lossPct = inLoss ? rawCapitalPct - 100 : 0;

  const allEnriched = enrichHoldings(raw.holdings, raw.accountValue);
  // Manulife reports per-fund Total P&L as a CUMULATIVE figure that includes
  // realised gains from switch-outs. So a fund the customer largely switched
  // away from can show a tiny current Fund Value sitting next to a P&L
  // figure many multiples larger — accurate per Manulife's accounting, but
  // confusing in a one-page summary aimed at clients.
  //
  // Heuristic: a holding is "leftover" from a fund switch when both
  //   - it's currently <0.5% of the account value, AND
  //   - its absolute P&L is at least as large as its current value.
  // We split such positions out into `minorHoldings`; the snapshot template
  // hides them from the donut and the per-fund table and surfaces a compact
  // footnote line so the visible rows tell a coherent story.
  const isLeftoverSwitch = (h) =>
    h.allocationPct < 0.5 && Math.abs(h.pnlDollar) > h.fundValue;
  const holdingsEnriched = allEnriched.filter(h => !isLeftoverSwitch(h));
  const minorHoldings = allEnriched.filter(isLeftoverSwitch);

  // Re-color the visible holdings in their (now contiguous) order so the
  // colours stay paired with the visual ranking on screen.
  holdingsEnriched.forEach((h, i) => { h.color = COLORS[i % COLORS.length]; });

  const minorHoldingsValue = minorHoldings.reduce((s, h) => s + h.fundValue, 0);
  const minorHoldingsPnl = minorHoldings.reduce((s, h) => s + h.pnlDollar, 0);

  // fundPnlTotal still includes minor positions — it must reconcile with
  // Manulife's "Grand Total" P&L line, which sums every fund regardless of
  // current size.
  const fundPnlTotal = allEnriched.reduce((s, h) => s + h.pnlDollar, 0);

  // Estimate the market gain on the bonus units themselves.
  // Bonuses were credited as units in the funds at inception. Their growth
  // since then ≈ (basic-premium return rate) × bonus principal. This makes
  // the gap between policy-level Net gain and the per-fund P&L total
  // explicit (the fund table only sums P&L on basic-premium allocations).
  const totalBonusPrincipal = welcomeBonusAmount + annualPremiumBonusAmount;
  const basicPremiumReturnRate = raw.policyInvestmentCost > 0
    ? fundPnlTotal / raw.policyInvestmentCost
    : 0;
  const bonusGrowthEstimate = round2(totalBonusPrincipal * basicPremiumReturnRate);

  const equityPct = holdingsEnriched
    .filter(h => /equity/i.test(h.assetClass) || /equity/i.test(h.subAssetClass))
    .reduce((s, h) => s + h.allocationPct, 0);
  const incomePct = Math.max(0, 100 - equityPct);

  return {
    customerName: raw.customerName,
    customerNameTitle: titleCaseName(raw.customerName),
    reportDate: raw.reportDate,
    policyName: raw.policyName,
    policyNamePretty: prettifyPolicyName(raw.policyName),
    policyNumber: raw.policyNumber,
    policyIssueDate: raw.policyIssueDate,
    inceptionDatePretty: prettyDate(raw.policyIssueDate),
    accountValue: raw.accountValue,
    policyInvestmentCost: raw.policyInvestmentCost,
    totalPnlDollar,
    totalPnlPct,
    annualisedPnlPct,
    totalRiderPremiums: raw.totalRiderPremiums,
    totalDividendsReinvested: raw.totalDividendsReinvested,
    riskProfile: raw.riskProfile,
    ckaStatus: raw.ckaStatus,
    ckaExpiry: raw.ckaExpiry,
    ckaExpiryPretty: prettyDate(raw.ckaExpiry),
    flexiTerm,
    policyTermYears,
    monthsInvested,
    premiumsPaidCount,
    annualPremium,
    premiumsRemaining,
    capitalPct: round1(capitalPct),
    gainsPct: round1(gainsPct),
    inLoss,
    lossPct: round1(lossPct),
    holdingsEnriched,
    minorHoldings,
    minorHoldingsValue,
    minorHoldingsPnl,
    fundPnlTotal,
    equityPct: round1(equityPct),
    incomePct: round1(incomePct),
    // Bonus context (consumed by the template footnote)
    product: raw.product,
    variation: raw.variation,
    welcomeBonusRate,
    annualPremiumBonusRate,
    welcomeBonusAmount,
    annualPremiumBonusAmount,
    totalBonusPrincipal,
    bonusGrowthEstimate,
    excludeWelcomeBonus: excludeWelcome,
    excludeAnnualPremiumBonus: excludeAnnual,
    adjustmentsActive,
  };
}


// ---------- Calculation helpers ----------------------------------------------

function countAnniversariesPaid(issueDate, reportDate) {
  if (reportDate < issueDate) return 0;
  let years = reportDate.getFullYear() - issueDate.getFullYear();
  const nextAnniv = new Date(issueDate);
  nextAnniv.setFullYear(issueDate.getFullYear() + years);
  if (reportDate >= nextAnniv) return years + 1;
  return years;
}

function daysBetween(start, end) {
  const ms = end.getTime() - start.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function monthsBetween(start, end) {
  if (end < start) return 0;
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  // Round up when more than half the trailing month has passed (matches Python deriver).
  const trailingDays = (end.getDate() - start.getDate() + 31) % 31;
  if (trailingDays >= 15) months += 1;
  return Math.max(0, months);
}


// ---------- Holdings enrichment ----------------------------------------------

function enrichHoldings(holdings, accountValue) {
  const sorted = [...holdings].sort((a, b) => b.fundValue - a.fundValue);
  return sorted.map((h, i) => ({
    ...h,
    allocationPct: accountValue ? (h.fundValue / accountValue) * 100 : 0,
    color: COLORS[i % COLORS.length],
    displayName: shortenFundName(h.fundFullName),
    assetClassLabel: ASSET_CLASS_LABELS[h.subAssetClass] ?? h.subAssetClass,
  }));
}

export function shortenFundName(full) {
  let s = (full || '').trim();
  // PDF.js may have left a stray space inside compound words like "Bh- SGD"
  // or "Multi- Asset" because it tokenizes word-by-word. Re-fuse them.
  s = s.replace(/([\/\-])\s+/g, '$1');
  s = s.replace(/^Manulife Global Fund\s*-\s*Global\s+/i, 'Manulife Global ');
  s = s.replace(/\s+Fund\s*[-(].*$/, '');
  s = s.replace(/\s+Fund\s+[A-Z]{1,3}(?:\s+\w+)*.*$/, '');
  s = s.replace(/\s+Fund\s+SGD$/i, '');
  s = s.replace(/\s+Fund$/i, '');
  s = s.replace(/\s+Opps?\s+SGD.*$/i, '');
  s = s.replace(/\s+Hard Currency SGD.*$/i, '');
  s = s.replace(/\s+Diversifi?ed Income.*$/i, '');
  return s.trim();
}


// ---------- Date helpers ------------------------------------------------------

function parseDmy(s) {
  // "01/04/2024" -> Date
  const [d, m, y] = s.split('/').map(Number);
  return new Date(y, m - 1, d);
}

function parseFlexibleDate(s) {
  // "30 Apr 2026" or "01/04/2024" or "2026-04-30"
  const trimmed = s.trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) return parseDmy(trimmed);
  const d = new Date(trimmed);
  if (!isNaN(d)) return d;
  throw new Error(`Unparseable date: ${s}`);
}

function prettyDate(s) {
  if (!s) return '';
  try {
    const d = parseDmy(s);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return s;
  }
}


// ---------- Misc helpers ------------------------------------------------------

function intFrom(text, re) {
  const m = re.exec(text || '');
  return m ? parseInt(m[1], 10) : null;
}

function titleCaseName(name) {
  return (name || '').trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function prettifyPolicyName(name) {
  return (name || '').replace(/\(III\)\s+/, '(III) — ');
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
