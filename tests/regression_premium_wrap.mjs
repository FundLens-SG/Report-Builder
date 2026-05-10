import assert from 'node:assert/strict';

import { derive } from '../docs/deriver.js';
import { buildSnapshotElement } from '../docs/snapshot.js';

const longFundName = 'Manulife Global Fund - Global Multi-Asset Diversified Income Fund AA (SGD Hedged) MDIST (G)';

const monthlyInvestReady = {
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
};

const data = derive(monthlyInvestReady);

assert.equal(data.annualPremium, 10000);
assert.equal(data.premiumFrequency, 'monthly');
assert.equal(data.premiumFrequencyAmbiguous, false);
assert.equal(data.welcomeBonusRate, 0.45);
assert.equal(data.annualPremiumBonusRate, 0);
assert.equal(data.totalBonusPrincipal, 4500);

globalThis.document = {
  createElement() {
    return { className: '', style: {}, innerHTML: '' };
  },
};

const node = buildSnapshotElement(data);
assert.ok(node.innerHTML.includes(longFundName));
assert.match(node.innerHTML, /word-break:\s*break-word/);
assert.match(node.innerHTML, /overflow-wrap:\s*anywhere/);
assert.doesNotMatch(node.innerHTML, /text-overflow:\s*ellipsis;\s*white-space:\s*nowrap[^>]*>\s*Manulife Global Fund/);

console.log('PASS report-builder monthly premium and fund-wrap regression');
