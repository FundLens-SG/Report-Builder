// Build the snapshot DOM from a derived data object, capture as PNG via
// html2canvas-pro. Mirrors src/template.html + src/renderer.py.

const fmt2 = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtPct1 = (n) => n.toFixed(1);
const fmtPct2 = (n) => n.toFixed(2);

// Escape user-supplied strings before we drop them into innerHTML.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
);


export function buildSnapshotElement(data) {
  const root = document.createElement('div');
  root.className = 'report';
  root.style.cssText = `
    width: 720px; padding: 28px 24px; background: #ffffff;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    color: #1a1a1a; -webkit-font-smoothing: antialiased;
    box-sizing: border-box;
  `;

  root.innerHTML = `
    ${header(data)}
    ${metricCards(data)}
    ${investmentJourney(data)}
    ${allocationSection(data)}
    ${holdingsTable(data)}
    ${strategyFooter(data)}
  `;
  return root;
}


export async function renderToPng(data) {
  // Each invocation owns its own node and removes only that node when done.
  // Concurrent renders (rapid bonus-toggle clicks) used to clobber each
  // other when we cleared `stage.innerHTML`, causing html2canvas to fail
  // with "Unable to find element in cloned iframe" mid-flight.
  const stage = document.getElementById('render-stage');
  const node = buildSnapshotElement(data);
  stage.appendChild(node);

  // Track the Chart and the captured canvas so we can free them in finally —
  // Chart.js holds a reference to its canvas in a global instance registry,
  // so without an explicit destroy() the canvas (and its retained pixel
  // buffer) survives DOM removal. Across a 40-file batch this leak alone
  // adds up to hundreds of MB and causes html2canvas to fail mid-flight on
  // memory-constrained machines.
  let chart = null;
  let captured = null;
  try {
    const canvas = node.querySelector('#alloc-donut');
    // eslint-disable-next-line no-undef
    chart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: data.holdingsEnriched.map(h => `${h.displayName} (${h.ticker})`),
        datasets: [{
          data: data.holdingsEnriched.map(h => Number(h.allocationPct.toFixed(4))),
          backgroundColor: data.holdingsEnriched.map(h => h.color),
          borderColor: 'transparent',
          borderWidth: 0,
        }],
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        cutout: '62%',
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    });

    await document.fonts.ready;
    // Give Chart.js a tick to commit the donut to the canvas
    await new Promise(r => setTimeout(r, 80));

    // eslint-disable-next-line no-undef
    captured = await html2canvas(node, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
    });

    return await new Promise((resolve) => captured.toBlob(blob => resolve(blob), 'image/png'));
  } finally {
    if (chart) {
      try { chart.destroy(); } catch (_e) { /* defensive */ }
    }
    if (captured) {
      // Force the html2canvas-produced canvas to release its backing store.
      try { captured.width = 0; captured.height = 0; } catch (_e) { /* defensive */ }
    }
    node.remove();
  }
}


// ---------- Section builders -------------------------------------------------

function header(d) {
  return `
  <div style="margin-bottom: 1.25rem; padding-bottom: 1rem; border-bottom: 0.5px solid rgba(0,0,0,0.08);">
    <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;">
      <div>
        <p style="font-size: 11px; color: #888780; margin: 0 0 4px 0; letter-spacing: 0.5px;">PORTFOLIO PERFORMANCE &amp; ALLOCATION SNAPSHOT</p>
        <h2 style="font-size: 18px; font-weight: 500; margin: 0 0 2px 0;">${esc(d.policyNamePretty)}</h2>
        <p style="font-size: 12px; color: #5f5e5a; margin: 0;">Policy ${esc(d.policyNumber)} · ${esc(d.customerName)} · As of ${esc(d.reportDate)}</p>
      </div>
      <div style="background: #e1f5ee; color: #0F6E56; font-size: 11px; padding: 4px 10px; border-radius: 8px; font-weight: 500; white-space: nowrap;">~${d.monthsInvested} months invested</div>
    </div>
  </div>`;
}

function metricCards(d) {
  // Use red for losses, green for gains. The Manulife report itself shows
  // negatives plainly (e.g. "Total P&L ($) SGD -629.11") so we match that.
  const card = (label, big, sub, badge = '', negative = false) => {
    const color = negative ? '#A4262C' : '#0F6E56';
    return `
    <div style="background: #f5f4ee; border-radius: 8px; padding: 14px;">
      <p style="font-size: 11px; color: #5f5e5a; margin: 0 0 6px 0;">${label}${badge}</p>
      <p style="font-size: 22px; font-weight: 500; color: ${color}; margin: 0; line-height: 1.1;">${big}</p>
      <p style="font-size: 11px; color: #888780; margin: 6px 0 0 0;">${sub}</p>
    </div>`;
  };

  // When bonus exclusions are active, mark the affected cards so the reader
  // knows the figures aren't Manulife's stated numbers.
  const badge = d.adjustmentsActive
    ? ` <span style="background: #fff5e0; color: #8c6312; font-size: 9px; padding: 1px 5px; border-radius: 999px; margin-left: 4px; font-weight: 500;">ADJUSTED</span>`
    : '';

  return `
  <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 1.25rem;">
    ${card('Net gain', signedMoney(d.totalPnlDollar), `from S$${fmt0(d.policyInvestmentCost)} invested`, badge, d.totalPnlDollar < 0)}
    ${card('Total return', signedPct(d.totalPnlPct), 'absolute, since inception', badge, d.totalPnlPct < 0)}
    ${card('Annualised IRR', signedPct(d.annualisedPnlPct), 'per year', badge, d.annualisedPnlPct < 0)}
  </div>`;
}

function signedMoney(n) {
  if (n < 0) return `−S$${fmt2(Math.abs(n))}`;  // U+2212 minus, looks better than hyphen
  return `+S$${fmt2(n)}`;
}
function signedPct(n) {
  if (n < 0) return `−${fmtPct2(Math.abs(n))}%`;
  return `+${fmtPct2(n)}%`;
}

function investmentJourney(d) {
  const dots = Array.from({ length: d.flexiTerm }, (_, i) => {
    const filled = i < d.premiumsPaidCount;
    return filled
      ? `<span style="width: 8px; height: 8px; border-radius: 50%; background: #888780;"></span>`
      : `<span style="width: 8px; height: 8px; border-radius: 50%; background: #f5f4ee; border: 0.5px solid rgba(0,0,0,0.18); box-sizing: border-box;"></span>`;
  }).join('');

  const riderRow = d.totalRiderPremiums > 0
    ? `<div style="color: #888780;">Rider premiums: <span style="color: #5f5e5a;">S$${fmt2(d.totalRiderPremiums)}</span></div>`
    : '';
  // Welcome bonus + annual premium bonus are added (not compounded) on
  // first-year premium. Show them as one consolidated "First Year Bonus" row
  // in the report — the breakdown lives in the settings panel only.
  const totalBonusRate = (d.welcomeBonusRate || 0) + (d.annualPremiumBonusRate || 0);
  const firstYearBonusRow = d.totalBonusPrincipal > 0
    ? `<div style="color: #888780;">First Year Bonus (${fmtPct1(totalBonusRate * 100)}%): <span style="color: #5f5e5a;">S$${fmt2(d.totalBonusPrincipal)}</span></div>`
    : '';

  return `
  <div style="background: #ffffff; border: 0.5px solid rgba(0,0,0,0.08); border-radius: 12px; padding: 16px; margin-bottom: 1.25rem;">
    <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 14px;">
      <div>
        <p style="font-size: 11px; color: #5f5e5a; margin: 0;">Total premiums paid</p>
        <p style="font-size: 18px; font-weight: 500; margin: 2px 0 0 0;">S$${fmt2(d.policyInvestmentCost)}</p>
        <p style="font-size: 11px; color: #888780; margin: 4px 0 0 0;">Inception · ${esc(d.inceptionDatePretty)}</p>
        <div style="margin-top: 10px; padding-top: 10px; border-top: 0.5px solid rgba(0,0,0,0.08); font-size: 11px; line-height: 1.7;">
          <div style="color: #888780;">Annual premium: <span style="color: #1a1a1a; font-weight: 500;">S$${fmt2(d.annualPremium)}</span></div>
          ${riderRow}
          ${firstYearBonusRow}
          <div style="color: #888780;">Reinvested dividends: <span style="color: #5f5e5a;">S$${fmt2(d.totalDividendsReinvested)}</span></div>
        </div>
      </div>
      <div style="text-align: right;">
        <p style="font-size: 11px; color: #5f5e5a; margin: 0;">Account value <span style="background: #e1f5ee; color: #0F6E56; font-size: 10px; padding: 2px 6px; border-radius: 999px; margin-left: 4px; font-weight: 500;">NOW</span></p>
        <p style="font-size: 20px; font-weight: 500; margin: 2px 0 0 0; color: #0F6E56;">S$${fmt2(d.accountValue)}</p>
        <p style="font-size: 11px; color: #888780; margin: 4px 0 0 0;">As of ${esc(d.reportDate)}</p>
      </div>
    </div>
    <div style="position: relative; height: 12px; background: #f5f4ee; border-radius: 999px; overflow: hidden;">
      <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${d.capitalPct}%; background: #888780; border-radius: 999px;"></div>
      <div style="position: absolute; left: ${d.capitalPct}%; top: 0; bottom: 0; right: 0; background: ${d.inLoss ? '#A4262C' : '#1D9E75'}; border-radius: 999px;"></div>
    </div>
    <div style="display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; color: #888780;">
      <span><span style="display: inline-block; width: 8px; height: 8px; background: #888780; border-radius: 2px; margin-right: 4px; vertical-align: middle;"></span>Capital (${fmtPct1(d.capitalPct)}%)</span>
      ${d.inLoss
        ? `<span style="color: #A4262C;"><span style="display: inline-block; width: 8px; height: 8px; background: #A4262C; border-radius: 2px; margin-right: 4px; vertical-align: middle;"></span>Loss (${fmtPct1(d.lossPct)}% of premium)</span>`
        : `<span><span style="display: inline-block; width: 8px; height: 8px; background: #1D9E75; border-radius: 2px; margin-right: 4px; vertical-align: middle;"></span>Gains (${fmtPct1(d.gainsPct)}%)</span>`
      }
    </div>
    <div style="margin-top: 14px; padding-top: 10px; border-top: 0.5px solid rgba(0,0,0,0.08); display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 10.5px; color: #888780;">
      <span style="white-space: nowrap;">Premium term · Flexi ${d.flexiTerm}</span>
      <span style="display: flex; align-items: center; gap: 3px;">${dots}</span>
      <span style="white-space: nowrap;">${d.premiumsPaidCount} of ${d.flexiTerm} paid · <span style="color: #5f5e5a;">${d.premiumsRemaining} years remaining</span></span>
    </div>
  </div>`;
}

function allocationSection(d) {
  const legend = d.holdingsEnriched.map(h => `
    <div style="display: flex; align-items: center; gap: 8px;">
      <span style="width: 10px; height: 10px; border-radius: 2px; background: ${h.color}; flex-shrink: 0;"></span>
      <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(h.displayName)} (${esc(h.ticker)})</span>
      <span style="font-weight: 500;">${fmtPct2(h.allocationPct)}%</span>
    </div>
  `).join('');

  return `
  <div style="margin-bottom: 1.25rem;">
    <h3 style="font-size: 14px; font-weight: 500; margin: 0 0 10px 0; color: #5f5e5a;">Portfolio allocation</h3>
    <div style="display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 16px; align-items: center;">
      <div style="position: relative; width: 220px; height: 220px;">
        <canvas id="alloc-donut" width="220" height="220"></canvas>
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px; font-size: 12px;">${legend}</div>
    </div>
  </div>`;
}

function holdingsTable(d) {
  const cellColor = (n) => (n < 0 ? '#A4262C' : '#0F6E56');
  const signMoney = (n) => (n < 0 ? `−${fmt2(Math.abs(n))}` : `+${fmt2(n)}`);
  const signPct = (n) => (n < 0 ? `−${fmtPct2(Math.abs(n))}%` : `+${fmtPct2(n)}%`);

  const rows = d.holdingsEnriched.map(h => `
    <tr style="border-bottom: 0.5px solid rgba(0,0,0,0.08);">
      <td style="padding: 10px 6px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="width: 8px; height: 8px; border-radius: 2px; background: ${h.color}; flex-shrink: 0;"></span>
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(h.displayName)}</span>
        </div>
      </td>
      <td style="padding: 10px 6px; color: #5f5e5a;">${esc(h.assetClassLabel)}</td>
      <td style="padding: 10px 6px; text-align: right;">${fmt2(h.fundValue)}</td>
      <td style="padding: 10px 6px; text-align: right; color: ${cellColor(h.pnlDollar)}; font-weight: 500;">${signMoney(h.pnlDollar)}</td>
      <td style="padding: 10px 6px; text-align: right; color: ${cellColor(h.pnlPct)}; font-weight: 500;">${signPct(h.pnlPct)}</td>
    </tr>
  `).join('');

  return `
  <div style="margin-bottom: 1.25rem;">
    <h3 style="font-size: 14px; font-weight: 500; margin: 0 0 10px 0; color: #5f5e5a;">Per-fund performance</h3>
    <table style="width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed;">
      <thead>
        <tr style="border-bottom: 0.5px solid rgba(0,0,0,0.18);">
          <th style="text-align: left; padding: 8px 6px; font-weight: 500; color: #5f5e5a; width: 38%;">Fund</th>
          <th style="text-align: left; padding: 8px 6px; font-weight: 500; color: #5f5e5a; width: 18%;">Asset class</th>
          <th style="text-align: right; padding: 8px 6px; font-weight: 500; color: #5f5e5a; width: 18%;">Value (SGD)</th>
          <th style="text-align: right; padding: 8px 6px; font-weight: 500; color: #5f5e5a; width: 14%;">P&amp;L ($)</th>
          <th style="text-align: right; padding: 8px 6px; font-weight: 500; color: #5f5e5a; width: 12%;">P&amp;L (%)</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
        <tr>
          <td style="padding: 10px 6px; font-weight: 500;">Total</td>
          <td></td>
          <td style="padding: 10px 6px; text-align: right; font-weight: 500;">${fmt2(d.accountValue)}</td>
          <td style="padding: 10px 6px; text-align: right; color: ${cellColor(d.fundPnlTotal)}; font-weight: 500;">${signMoney(d.fundPnlTotal)}</td>
          <td style="padding: 10px 6px; text-align: right; color: ${cellColor(d.fundPnlTotal)}; font-weight: 500;">—</td>
        </tr>
      </tbody>
    </table>
    <p style="font-size: 10px; color: #888780; margin: 6px 0 0 0;">Fund-level P&amp;L sums to ${signMoney(d.fundPnlTotal)}. Policy-level P&amp;L of ${signMoney(d.totalPnlDollar)} also reflects reinvested dividends and unit-price movement at the policy layer.${minorHoldingsLine(d)}</p>
  </div>`;
}

function minorHoldingsLine(d) {
  // Only surface the note when at least one switched-out leftover position
  // exists, otherwise skip entirely. The exact count is useful (clients
  // recognise "1 minor position" vs. "3 minor positions" intuitively).
  if (!d.minorHoldings?.length) return '';
  const n = d.minorHoldings.length;
  const valueStr = `S$${fmt2(d.minorHoldingsValue)}`;
  const pnlStr = d.minorHoldingsPnl < 0
    ? `−S$${fmt2(Math.abs(d.minorHoldingsPnl))}`
    : `+S$${fmt2(d.minorHoldingsPnl)}`;
  return `<br>Plus ${n} minor position${n === 1 ? '' : 's'} (${valueStr} value, ${pnlStr} P&amp;L) from earlier fund switches — hidden for clarity.`;
}

function strategyFooter(d) {
  let adjustmentNote = '';
  if (d.adjustmentsActive) {
    const excludedAmount =
      (d.excludeWelcomeBonus ? d.welcomeBonusAmount : 0) +
      (d.excludeAnnualPremiumBonus ? d.annualPremiumBonusAmount : 0);
    const excludedRate =
      (d.excludeWelcomeBonus ? d.welcomeBonusRate : 0) +
      (d.excludeAnnualPremiumBonus ? d.annualPremiumBonusRate : 0);
    if (excludedAmount > 0) {
      adjustmentNote = `<br>Net gain, total return, and annualised IRR exclude First Year Bonus (S$${fmt2(excludedAmount)} @ ${fmtPct1(excludedRate * 100)}%) treated as cost basis.`;
    }
  }

  return `
  <div style="background: #f5f4ee; border-radius: 8px; padding: 14px;">
    <p style="font-size: 11px; color: #888780; margin: 0 0 6px 0; letter-spacing: 0.5px;">STRATEGY &amp; POSITIONING</p>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 12px;">
      <div>
        <p style="font-weight: 500; margin: 0 0 2px 0;">Equity-led growth</p>
        <p style="color: #5f5e5a; margin: 0; line-height: 1.5;">${fmtPct1(d.equityPct)}% in equities for capital appreciation.</p>
      </div>
      <div>
        <p style="font-weight: 500; margin: 0 0 2px 0;">Income &amp; diversification</p>
        <p style="color: #5f5e5a; margin: 0; line-height: 1.5;">${fmtPct1(d.incomePct)}% in bonds and multi-asset for yield and stability.</p>
      </div>
    </div>
    <p style="font-size: 10px; color: #888780; margin: 10px 0 0 0; padding-top: 8px; border-top: 0.5px solid rgba(0,0,0,0.08);">${footerMetaLine(d)}${adjustmentNote}</p>
  </div>`;
}

// Builds the bottom-of-card meta line. Each component (risk profile, CKA,
// disclaimer) is appended only when the underlying field is non-empty so a
// PDF that's missing the optional advisory fields doesn't render as
// "Risk profile:  · CKA:  (expiry )".
function footerMetaLine(d) {
  const parts = [];
  if (d.riskProfile) parts.push(`Risk profile: ${esc(d.riskProfile)}`);
  if (d.ckaStatus) {
    parts.push(d.ckaExpiryPretty
      ? `CKA: ${esc(d.ckaStatus)} (expiry ${esc(d.ckaExpiryPretty)})`
      : `CKA: ${esc(d.ckaStatus)}`);
  }
  parts.push('Past performance is not indicative of future performance.');
  return parts.join(' · ');
}
