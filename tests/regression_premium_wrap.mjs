import assert from 'node:assert/strict';

import { derive } from '../docs/deriver.js';
import { buildSnapshotElement } from '../docs/snapshot.js';
import { lookupBonusRates } from '../docs/bonus.js';

const longFundName = 'Manulife Global Fund - Global Multi-Asset Diversified Income Fund AA (SGD Hedged) MDIST (G)';

function makeInvestReady(overrides = {}) {
  return {
    customerName: 'Test Client',
    reportDate: '10 Feb 2026',
    policyName: 'Manulife InvestReady (III) 13 Years Flexi 10',
    policyNumber: 'T-001',
    policyIssueDate: '01/04/2024',
    accountValue: 23000,
    policyInvestmentCost: 19166.59,
    totalPnlDollar: 3833.41,
    totalPnlPct: 20,
    annualisedPnlPct: 10,
    totalRiderPremiums: 0,
    totalDividendsReinvested: 0,
    riskProfile: 'Balanced',
    ckaStatus: 'Pass',
    ckaExpiry: '01/04/2027',
    product: 'InvestReady (III)',
    variation: '13 Years Flexi 10',
    holdings: [{
      fundFullName: longFundName,
      ticker: 'MGF',
      assetClass: 'Multi Asset',
      subAssetClass: 'Multi Asset',
      fundValue: 23000,
      pnlDollar: 3833.41,
      pnlPct: 20,
    }],
    ...overrides,
  };
}

const monthlyInvestReady = makeInvestReady({
  customerName: 'ANG BEE NGOH',
  reportDate: '11 May 2026',
  policyName: 'Manulife InvestReady (III) 13 Years Flexi 10',
  policyNumber: '2451758266',
  policyIssueDate: '25/06/2024',
  policyInvestmentCost: 19166.63,
});

const data = derive(monthlyInvestReady);

assert.equal(data.annualPremium, 10000);
assert.equal(data.premiumFrequency, 'monthly');
assert.equal(data.premiumFrequencyAmbiguous, false);
assert.equal(lookupBonusRates('InvestReady (III)', '13 Years Flexi 10', data.annualPremium).welcomeRate, 0.45);
assert.equal(data.welcomeBonusRate, 0.45);
assert.equal(data.annualPremiumBonusRate, 0);
assert.equal(data.totalBonusPrincipal, 4500);

const annualInvestReady = makeInvestReady({
  customerName: 'TAN MEI LIAN',
  reportDate: '30 Apr 2026',
  policyIssueDate: '01/04/2024',
  policyInvestmentCost: 30000,
});
const annualData = derive(annualInvestReady);
assert.equal(annualData.annualPremium, 10000);
assert.equal(annualData.premiumFrequency, 'annual');
assert.equal(annualData.premiumFrequencyAmbiguous, false);
assert.equal(annualData.welcomeBonusRate, 0.45);
assert.equal(annualData.annualPremiumBonusRate, 0.05);

const boundaryInvestReady = makeInvestReady({
  reportDate: '01 Mar 2025',
  policyIssueDate: '01/04/2024',
  policyInvestmentCost: 10000,
});
const boundaryData = derive(boundaryInvestReady);
assert.equal(boundaryData.annualPremium, 10000);
assert.equal(boundaryData.premiumFrequency, 'annual');
assert.equal(boundaryData.premiumFrequencyAmbiguous, true);

globalThis.document = {
  createElement() {
    return { className: '', style: {}, innerHTML: '' };
  },
};

const node = buildSnapshotElement(data);
assert.match(node.innerHTML, /monthly-pay \(no annual bonus\)/);
assert.ok(node.innerHTML.includes(longFundName));
assert.match(node.innerHTML, /word-break:\s*break-word/);
assert.match(node.innerHTML, /overflow-wrap:\s*anywhere/);
assert.doesNotMatch(node.innerHTML, /text-overflow:\s*ellipsis;\s*white-space:\s*nowrap[^>]*>\s*Manulife Global Fund/);

const boundaryNode = buildSnapshotElement(boundaryData);
assert.match(boundaryNode.innerHTML, /monthly vs annual is indistinguishable/);

// Bonus-adjustment recompute must include cash already returned to the
// customer (paid-out dividends + partial withdrawals), matching Manulife's
// glossary formula. Earlier the recompute used accountValue / adjustedCost
// alone, which collapsed the adjusted IRR for any policy with paid-out
// dividends. Real-world case (ZHANG SHANNA, policy 2451138790, May 2026):
// $80K invested, $88,550.92 account value, $12,150.27 paid-out dividends,
// 1259 days, 10 Years Flexi 5 → 25% welcome-bonus excluded ($5,000 added
// to cost) should give adjusted IRR ~5.04% (NOT ~0.85% which is what the
// buggy formula returned).
const dividendPolicy = makeInvestReady({
  customerName: 'ZHANG SHANNA',
  reportDate: '14 May 2026',
  policyName: 'Manulife InvestReady (III) 10 Years Flexi 5',
  policyNumber: '2451138790',
  policyIssueDate: '02/12/2022',
  accountValue: 88550.92,
  policyInvestmentCost: 80000,
  totalPnlDollar: 20701.19,
  totalPnlPct: 25.88,
  annualisedPnlPct: 6.89,
  totalDividendsReinvested: 0,
  totalDividendsPaidOut: 12150.27,
  totalPartialWithdrawal: 0,
  variation: '10 Years Flexi 5',
});
const adjusted = derive(dividendPolicy, { excludeWelcomeBonus: true });
// welcomeBonus = 25% × $20K = $5,000; adjustedCost = $85,000.
// investmentValue = 88,550.92 + 12,150.27 = $100,701.19.
// totalPnlPct = (100701.19/85000 - 1) × 100 = 18.47.
// annualisedPnlPct = (1.18472^(365/1259) - 1) × 100 ≈ 5.04.
assert.equal(adjusted.welcomeBonusAmount, 5000);
assert.equal(adjusted.totalPnlDollar, 15701.19);
assert.equal(adjusted.totalPnlPct, 18.47);
assert.ok(
  Math.abs(adjusted.annualisedPnlPct - 5.04) < 0.05,
  `adjusted IRR should ~5.04% (paid-out dividends counted), got ${adjusted.annualisedPnlPct}`,
);

console.log('PASS report-builder premium inference, bonus, and fund-wrap regression');
