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
  const inferred = inferAnnualPremium(
    raw.policyInvestmentCost,
    issueDate,
    reportDate,
    premiumsPaidCount,
  );
  const annualPremium = inferred.annualPremium;
  const premiumFrequency = inferred.frequency;             // 'monthly' | 'annual'
  const premiumFrequencyAmbiguous = inferred.ambiguous;     // true at 12/24/36-mo boundaries
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
  let annualPremiumBonusRate = auto.recognised
    ? (options.annualPremiumBonusRate ?? auto.annualPremiumRate)
    : 0;

  // Manulife rule: the InvestReady (III) annual premium bonus is paid only
  // when premiums are collected ANNUALLY. Monthly-pay clients forfeit it
  // entirely (the welcome bonus still applies). InvestReady Growth's 3 %
  // annual bonus is unconditional — it stays even on monthly-pay because
  // there's no first-year clawback. Only zero it out when we're CONFIDENT
  // the policy is monthly; in the ambiguous (12/24/36-month boundary) case
  // we leave the bonus in and surface a disclaimer to the user instead.
  if (raw.product === 'InvestReady (III)'
      && premiumFrequency === 'monthly'
      && !premiumFrequencyAmbiguous) {
    annualPremiumBonusRate = 0;
  }

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
    // Frequency context (consumed by the snapshot for the disclaimer line)
    premiumFrequency,
    premiumFrequencyAmbiguous,
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

// The PDF doesn't state the premium payment frequency (monthly / quarterly /
// annual), so we have to infer it from the math. Two interpretations are
// possible for any (totalPaid, monthsElapsed, anniversaries) triple:
//
//   ANNUAL  — premium collected once per anniversary year.
//             count = anniversaries (incl. inception)
//             rate  = totalPaid / count          ← already the annual premium
//
//   MONTHLY — premium collected at inception then every month after.
//             count = monthsElapsed + 1          (inception is a payment date)
//             rate  = totalPaid / count          ← monthly rate
//             annualised = rate × 12
//
// Real-world Manulife premiums are multiples of $100 (often $500 / $1,000),
// so pick whichever interpretation lands closer to a clean $100 multiple.
// A bug we hit in the wild: a monthly $833.33 / $10,000-a-year policy was
// mis-inferred as 2 annual installments of $9,583.32, dropping the welcome
// bonus from the upper tier (45 %) to the lower tier (15 %) and roughly
// halving the displayed first-year bonus.
//
// Bias toward annual on near-ties — annual is the more common case and the
// PDF's structure (premium paid by anniversary) leans that way too. The
// monthly inference only wins when it's BOTH very clean (≤ $5 from a $100
// multiple) AND meaningfully cleaner than the annual one (by > $5).
// Use completed monthly payment intervals here; the display month count
// rounds partial months up, which is too generous for payment counts.
//
// Genuine ambiguity exists when totalPaid happens to equal `annual × N` for
// both interpretations — i.e. when monthlyPayments is itself a multiple of
// 12 (months elapsed = 11, 23, 35, ...). At those boundaries an annual-pay
// $10K and a monthly-pay $833.33 client both produce the same totalPaid.
// We can't disambiguate, so we return frequency='annual' (the safer default
// for the bonus calc) and set ambiguous=true so the snapshot can warn.
//
// Returns: { annualPremium, frequency: 'monthly'|'annual', ambiguous: bool }
function inferAnnualPremium(totalPaid, issueDate, reportDate, anniversaries) {
  if (totalPaid <= 0) {
    return { annualPremium: 0, frequency: 'annual', ambiguous: false };
  }

  const annualEst = anniversaries > 0 ? totalPaid / anniversaries : 0;

  const monthsElapsed = fullMonthsBetween(issueDate, reportDate);
  const monthlyPayments = monthsElapsed + 1;
  const monthlyAnnualEst = monthlyPayments > 0
    ? (totalPaid / monthlyPayments) * 12
    : 0;

  const annualResidual = residualFromHundred(annualEst);
  const monthlyResidual = residualFromHundred(monthlyAnnualEst);

  // Monthly inference is the clear winner.
  if (monthlyAnnualEst > 0
      && monthlyResidual <= 5
      && monthlyResidual < annualResidual - 5) {
    // Round to the nearest $100 to absorb sub-cent drift in the per-payment
    // math (e.g. $833.331 × 12 = $9,999.97 → $10,000).
    return {
      annualPremium: Math.round(monthlyAnnualEst / 100) * 100,
      frequency: 'monthly',
      ambiguous: false,
    };
  }

  // Both interpretations land on the SAME clean number (within a few dollars).
  // This is the 12/24/36-month-boundary case — math can't tell the two apart.
  const ambiguous = (
    annualEst > 0 && monthlyAnnualEst > 0
    && annualResidual <= 5 && monthlyResidual <= 5
    && Math.abs(annualEst - monthlyAnnualEst) <= 5
  );
  // When the annual estimate is itself within $5 of a clean $100 multiple,
  // snap to that multiple — absorbs sub-cent drift like $9,999.96 → $10,000.
  // Otherwise preserve the exact value (e.g. an unusual $10,250 stays put).
  const cleanAnnual = annualResidual <= 5
    ? Math.round(annualEst / 100) * 100
    : round2(annualEst);

  return {
    annualPremium: cleanAnnual,
    frequency: 'annual',
    ambiguous,
  };
}

function residualFromHundred(v) {
  return Math.abs(v - Math.round(v / 100) * 100);
}

function fullMonthsBetween(start, end) {
  if (end < start) return 0;
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
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

// Display the fund name EXACTLY as Manulife wrote it in the PDF — share
// class, currency, hedge markers, distribution codes and all. The only
// thing this function does is patch up PDF.js word-level extraction
// artefacts so compound words don't render with a stray space:
//   "Bh- SGD"      → "Bh-SGD"
//   "Multi- Asset" → "Multi-Asset"
//   "H2- SGD"      → "H2-SGD"
// We deliberately preserve real separator dashes ("Manulife Global Fund - …")
// because they're part of the canonical name. Earlier versions of this
// function tried to "shorten" the name by stripping share-class tails;
// that lost meaningful descriptors (Hard Currency, Diversified Income, Opps)
// and ended up trimming things the user wanted preserved. The user's
// reasonable expectation: type the full name exactly as the report shows it.
export function shortenFundName(full) {
  let s = (full || '').trim();
  // Re-fuse only when the dash/slash is glued to the preceding token
  // (PDF.js artefact signature: no space before, space after). Real
  // separator dashes — " - " — have spaces on both sides and stay intact.
  s = s.replace(/(\S[\/\-])\s+(\S)/g, '$1$2');
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
