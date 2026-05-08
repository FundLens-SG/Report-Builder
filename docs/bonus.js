// Manulife InvestReady welcome-bonus and annual-premium-bonus rate tables.
// Sources: official Manulife product brochures.
//
// Both bonuses are calculated as a percentage of the FIRST year's annualised
// basic premium (not compounded with each other). Per the brochure:
//   - Welcome Bonus = first 12 months regular basic premium × welcomeRate
//   - Annual Premium Bonus = first annual basic premium × annualPremiumRate
// Both are one-time, credited as additional units at policy inception.

export const PRODUCTS = {
  'InvestReady Growth': {
    label: 'Manulife InvestReady Growth',
    variations: {
      '15 Years Flexi 10': {
        welcomeTiers: [
          { min: 3600, max: 9599.99, rate: 0.150 },
          { min: 9600, max: Infinity, rate: 0.450 },
        ],
        annualPremium: 0.030,
      },
      '20 Years Flexi 10': {
        welcomeTiers: [
          { min: 2400, max: 9599.99, rate: 0.300 },
          { min: 9600, max: Infinity, rate: 0.600 },
        ],
        annualPremium: 0.030,
      },
    },
  },
  'InvestReady (III)': {
    label: 'Manulife InvestReady (III)',
    variations: {
      '5 Years Flexi 1': {
        welcomeTiers: [{ min: 25000, max: Infinity, rate: 0.058 }],
        annualPremium: 0.000,
      },
      '6 Years Flexi 2': {
        welcomeTiers: [{ min: 10000, max: Infinity, rate: 0.116 }],
        annualPremium: 0.000,
      },
      '7 Years Flexi 5': {
        welcomeTiers: [
          { min: 12000, max: 47999.99, rate: 0.070 },
          { min: 48000, max: Infinity, rate: 0.120 },
        ],
        annualPremium: 0.000,
      },
      '10 Years Flexi 3': {
        welcomeTiers: [
          { min: 6000, max: 9599.99, rate: 0.080 },
          { min: 9600, max: Infinity, rate: 0.150 },
        ],
        annualPremium: 0.020,
      },
      '10 Years Flexi 5': {
        welcomeTiers: [
          { min: 6000, max: 9599.99, rate: 0.100 },
          { min: 9600, max: Infinity, rate: 0.250 },
        ],
        annualPremium: 0.050,
      },
      '10 Years Flexi 8': {
        welcomeTiers: [
          { min: 6000, max: 9599.99, rate: 0.130 },
          { min: 9600, max: Infinity, rate: 0.300 },
        ],
        annualPremium: 0.050,
      },
      '13 Years Flexi 10': {
        welcomeTiers: [
          { min: 3600, max: 9599.99, rate: 0.150 },
          { min: 9600, max: Infinity, rate: 0.450 },
        ],
        annualPremium: 0.050,
      },
      // 20 Years Flexi 10 — confirmed by user. Same welcome tiering as
      // InvestReady Growth 20Y Flexi 10 (30% / 60%) but a higher annual
      // premium bonus rate (5% vs Growth's 3%).
      '20 Years Flexi 10': {
        welcomeTiers: [
          { min: 2400, max: 9599.99, rate: 0.300 },
          { min: 9600, max: Infinity, rate: 0.600 },
        ],
        annualPremium: 0.050,
      },
    },
  },
};


export function detectProductAndVariation(policyName) {
  if (!policyName) return { product: null, variation: null };

  let product = null;
  if (/InvestReady\s+Growth/i.test(policyName)) product = 'InvestReady Growth';
  else if (/InvestReady\s*\(?\s*III\s*\)?/i.test(policyName)) product = 'InvestReady (III)';

  const m = /(\d+)\s+Years?\s+Flexi\s+(\d+)/i.exec(policyName);
  const variation = m ? `${m[1]} Years Flexi ${m[2]}` : null;

  return { product, variation };
}


export function lookupBonusRates(product, variation, annualPremium) {
  const config = PRODUCTS[product]?.variations?.[variation];
  if (!config) {
    return { welcomeRate: 0, annualPremiumRate: 0, recognised: false };
  }
  const tier = config.welcomeTiers.find(
    t => annualPremium >= t.min && annualPremium <= t.max
  );
  return {
    welcomeRate: tier?.rate ?? 0,
    annualPremiumRate: config.annualPremium,
    recognised: true,
  };
}
