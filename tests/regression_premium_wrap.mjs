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

console.log('PASS report-builder premium inference, bonus, and fund-wrap regression');
