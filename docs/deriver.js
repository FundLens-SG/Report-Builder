// Mirrors src/deriver.py. Turns the raw parsed report into the data dict the
// snapshot template consumes (with all derived calculations).

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


export function derive(raw) {
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

  const capitalPct = raw.accountValue
    ? (raw.policyInvestmentCost / raw.accountValue) * 100
    : 0;
  const gainsPct = Math.max(0, 100 - capitalPct);

  const holdingsEnriched = enrichHoldings(raw.holdings, raw.accountValue);
  const fundPnlTotal = holdingsEnriched.reduce((s, h) => s + h.pnlDollar, 0);

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
    totalPnlDollar: raw.totalPnlDollar,
    totalPnlPct: raw.totalPnlPct,
    annualisedPnlPct: raw.annualisedPnlPct,
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
    holdingsEnriched,
    fundPnlTotal,
    equityPct: round1(equityPct),
    incomePct: round1(incomePct),
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
