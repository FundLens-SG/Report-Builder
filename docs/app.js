// Main controller for the CKG-styled wrapper.
// Owns: file queue, drag-drop, bonus settings, live re-render.
// Delegates parsing/derivation/PNG rendering to the unchanged modules.

import { parsePdf } from './parser.js';
import { derive } from './deriver.js';
import { renderToPng } from './snapshot.js';
import { buildFilename } from './naming.js';
import { PRODUCTS } from './bonus.js';

// ---- DOM lookups ------------------------------------------------------------

const dropzone = document.getElementById('dropzone');
const dropzoneWrap = document.getElementById('dropzone-wrap');
const fileInput = document.getElementById('file-input');
const chooseBtn = document.getElementById('choose-btn');
const fileList = document.getElementById('file-list');

const adjustmentsBlock = document.getElementById('adjustments-block');
const detectedProductEl = document.getElementById('detected-product');
const detectedVariationLineEl = document.getElementById('detected-variation-line');
const detectedRatesEl = document.getElementById('detected-rates');
const excludeWelcomeEl = document.getElementById('exclude-welcome');
const excludeAnnualEl = document.getElementById('exclude-annual');
const welcomeRateEl = document.getElementById('welcome-rate');
const annualRateEl = document.getElementById('annual-rate');
const welcomeAmountEl = document.getElementById('welcome-amount');
const annualAmountEl = document.getElementById('annual-amount');

const resultSection = document.getElementById('result-section');
const resultCountEl = document.getElementById('result-count');
const previewImg = document.getElementById('snapshot-preview');
const previewFilenameEl = document.getElementById('preview-filename');
const downloadBtn = document.getElementById('download-btn');
const downloadLabel = document.getElementById('download-label');
const deltaCardEl = document.getElementById('delta-card');

const STATUS_LABELS = {
  queued: 'Queued',
  parsing: 'Parsing',
  rendering: 'Rendering',
  done: 'Done',
  failed: 'Failed',
};

let queue = [];           // [{ id, file, badgeEl, raw?, error? }]
let renderToken = 0;       // increments per re-render to discard stale awaits
let lastZipUrl = null;     // released between batch renders


// ---------- Drag-and-drop wiring ---------------------------------------------

['dragenter', 'dragover'].forEach(ev => {
  dropzoneWrap.addEventListener(ev, e => {
    e.preventDefault();
    dropzone.classList.add('dragging');
  });
});
['dragleave', 'drop'].forEach(ev => {
  dropzoneWrap.addEventListener(ev, e => {
    e.preventDefault();
    dropzone.classList.remove('dragging');
  });
});
dropzoneWrap.addEventListener('drop', e => {
  const files = [...(e.dataTransfer?.files ?? [])].filter(isPdf);
  if (files.length) addFiles(files);
});

chooseBtn.addEventListener('click', e => {
  e.preventDefault();
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) addFiles([...fileInput.files]);
  fileInput.value = '';
});


// ---------- Bonus panel listeners (live re-render) ---------------------------

let rerenderTimer = null;
function scheduleRerender() {
  // Sync rate-input editability with each toggle's checked state.
  welcomeRateEl.readOnly = !excludeWelcomeEl.checked;
  annualRateEl.readOnly = !excludeAnnualEl.checked;
  // Refresh the bonus-dollar labels immediately so they track the rate input
  // as the user types — only the (debounced) snapshot re-render is deferred.
  const firstOk = queue.find(q => q.raw);
  if (firstOk) {
    updateBonusAmounts(derive(firstOk.raw, {}).annualPremium);
  }
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => updateAllRendered().catch(console.error), 90);
}
[excludeWelcomeEl, excludeAnnualEl].forEach(el => el.addEventListener('change', scheduleRerender));
[welcomeRateEl, annualRateEl].forEach(el => el.addEventListener('input', scheduleRerender));


// ---------- File queue -------------------------------------------------------

function isPdf(file) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function addFiles(files) {
  for (const file of files) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const li = document.createElement('li');
    li.className = 'file-row';
    li.innerHTML = `
      <svg class="icn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      <span class="name"></span>
      <span class="size"></span>
      <span class="badge queued"><span class="dot"></span>Queued</span>
    `;
    li.querySelector('.name').textContent = file.name;
    li.querySelector('.size').textContent = formatBytes(file.size);
    fileList.appendChild(li);
    queue.push({ id, file, badgeEl: li.querySelector('.badge') });
  }
  // Process the newly added files (existing 'done' files stay in the list).
  processNewFiles().catch(err => {
    console.error(err);
  });
}

function setStatus(item, status) {
  item.badgeEl.className = `badge ${status}`;
  item.badgeEl.innerHTML = `<span class="dot"></span>${STATUS_LABELS[status] ?? status}`;
}

async function processNewFiles() {
  const pending = queue.filter(q => !q.raw && !q.error);
  if (!pending.length) return;

  for (const item of pending) {
    setStatus(item, 'parsing');
    try {
      const buffer = await item.file.arrayBuffer();
      item.raw = await parsePdf(buffer);
    } catch (err) {
      console.error(`Failed to parse ${item.file.name}:`, err);
      item.error = err?.message ?? String(err);
      setStatus(item, 'failed');
    }
  }

  populateBonusPanelFromFirst();
  await updateAllRendered();
}


// ---------- Bonus panel ------------------------------------------------------

function populateBonusPanelFromFirst() {
  const firstOk = queue.find(q => q.raw);
  if (!firstOk) return;

  const preview = derive(firstOk.raw, {});
  const recognised = !!(firstOk.raw.product && firstOk.raw.variation
    && PRODUCTS[firstOk.raw.product]?.variations?.[firstOk.raw.variation]);

  if (recognised) {
    detectedProductEl.textContent = PRODUCTS[firstOk.raw.product].label;
    detectedVariationLineEl.textContent = `${firstOk.raw.variation}  ·  S$${fmt0(preview.annualPremium)} annual`;
    detectedRatesEl.textContent = `${fmtPct1(preview.welcomeBonusRate * 100)}% · ${fmtPct1(preview.annualPremiumBonusRate * 100)}%`;
  } else {
    detectedProductEl.textContent = 'Not auto-detected';
    detectedVariationLineEl.textContent = 'Set the rates manually below';
    detectedRatesEl.textContent = '— · —';
  }

  // Auto-fill the rate inputs only on the FIRST populate so user overrides stick.
  if (!welcomeRateEl.dataset.touched) {
    welcomeRateEl.value = (preview.welcomeBonusRate * 100).toFixed(1);
    annualRateEl.value = (preview.annualPremiumBonusRate * 100).toFixed(1);
  }
  welcomeRateEl.readOnly = !excludeWelcomeEl.checked;
  annualRateEl.readOnly = !excludeAnnualEl.checked;
  updateBonusAmounts(preview.annualPremium);

  adjustmentsBlock.hidden = false;
}

function updateBonusAmounts(annualPremium) {
  const w = (parseFloat(welcomeRateEl.value) || 0) / 100;
  const a = (parseFloat(annualRateEl.value) || 0) / 100;
  welcomeAmountEl.textContent = `S$${fmt2(annualPremium * w)}`;
  annualAmountEl.textContent = `S$${fmt2(annualPremium * a)}`;
}

// Mark rate inputs as user-touched so we don't clobber overrides on subsequent populates.
[welcomeRateEl, annualRateEl].forEach(el => {
  el.addEventListener('input', () => { el.dataset.touched = '1'; });
});


// ---------- Render orchestration ---------------------------------------------

function currentBonusOptions() {
  const opts = {
    excludeWelcomeBonus: excludeWelcomeEl.checked,
    excludeAnnualPremiumBonus: excludeAnnualEl.checked,
  };
  const w = parseFloat(welcomeRateEl.value);
  const a = parseFloat(annualRateEl.value);
  if (!Number.isNaN(w)) opts.welcomeBonusRate = w / 100;
  if (!Number.isNaN(a)) opts.annualPremiumBonusRate = a / 100;
  return opts;
}

async function updateAllRendered() {
  const myToken = ++renderToken;
  const okItems = queue.filter(q => q.raw);
  if (!okItems.length) {
    resultSection.hidden = true;
    return;
  }

  const successes = [];
  for (const item of okItems) {
    setStatus(item, 'rendering');
    try {
      const opts = currentBonusOptions();
      const data = derive(item.raw, opts);
      const blob = await renderToPng(data);
      if (myToken !== renderToken) return;  // newer render started
      successes.push({ item, blob, data });
      setStatus(item, 'done');
    } catch (err) {
      // If a newer render started, html2canvas can fail mid-flight when its
      // cloned iframe loses the now-removed node. That's not a real parse
      // failure — silently abort this stale pass and let the newer one run.
      if (myToken !== renderToken) return;
      console.error(`Failed to render ${item.file.name}:`, err);
      item.error = err?.message ?? String(err);
      setStatus(item, 'failed');
    }
  }
  if (myToken !== renderToken) return;
  if (!successes.length) {
    resultSection.hidden = true;
    return;
  }

  // Preview is always the FIRST successful file.
  const first = successes[0];
  const filename = buildFilename(first.item.raw.customerName, first.item.raw.policyNumber, first.item.raw.reportDate);
  const url = URL.createObjectURL(first.blob);
  previewImg.src = url;
  previewFilenameEl.textContent = filename;

  if (successes.length === 1) {
    downloadBtn.href = url;
    downloadBtn.download = filename;
    downloadLabel.textContent = 'Download PNG';
    resultCountEl.textContent = 'PNG ready · 1 of 1';
  } else {
    if (lastZipUrl) URL.revokeObjectURL(lastZipUrl);
    // eslint-disable-next-line no-undef
    const zip = new JSZip();
    for (const s of successes) {
      const fname = buildFilename(s.item.raw.customerName, s.item.raw.policyNumber, s.item.raw.reportDate);
      zip.file(fname, s.blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    lastZipUrl = URL.createObjectURL(zipBlob);
    const zipName = `manulife-snapshots-${new Date().toISOString().slice(0, 10)}.zip`;
    downloadBtn.href = lastZipUrl;
    downloadBtn.download = zipName;
    downloadLabel.textContent = `Download ZIP (${successes.length})`;
    resultCountEl.textContent = `PNG ready · ${successes.length} of ${queue.length}`;
  }

  buildDeltaCard(first.item.raw, first.data);
  resultSection.hidden = false;
}


// ---------- Delta card -------------------------------------------------------

function buildDeltaCard(raw, adjustedData) {
  const adjusted = adjustedData.adjustmentsActive;
  const customer = adjustedData.customerNameTitle || raw.customerName || 'this customer';
  const productLabel = adjustedData.product
    ? (PRODUCTS[adjustedData.product]?.label ?? adjustedData.product)
    : 'the policy';

  if (!adjusted) {
    deltaCardEl.innerHTML = `
      <div class="delta-kicker" style="color: var(--ink-3);">
        ${sparkSvg()}
        <span>Snapshot ready</span>
      </div>
      <h4>Customer view of <em>${esc(customer)}'s</em> ${esc(productLabel)} policy, as of ${esc(raw.reportDate)}.</h4>
      <div class="delta-rows">
        ${unadjRow('Net gain', `+S$${fmt2(raw.totalPnlDollar)}`)}
        ${unadjRow('Total return', `+${fmtPct2(raw.totalPnlPct)}%`)}
        ${unadjRow('Annualised IRR', `+${fmtPct2(raw.annualisedPnlPct)}%`)}
      </div>
      <p class="delta-foot">Toggle <b>Exclude Welcome Bonus</b> or <b>Exclude Annual Premium Bonus</b> in the panel above to see the figures net of marketing incentives — the snapshot updates live.</p>
    `;
    return;
  }

  const baseline = derive(raw, {});
  const excludedDescriptor = describeExclusion(adjustedData);

  deltaCardEl.innerHTML = `
    <div class="delta-kicker">
      ${sparkSvg()}
      <span>Adjusted view</span>
      <span class="pill">${esc(excludedDescriptor.pill)}</span>
    </div>
    <h4>Excluding ${esc(excludedDescriptor.short)} drops <em>annualised IRR</em> from ${fmtPct2(baseline.annualisedPnlPct)}% to ${fmtPct2(adjustedData.annualisedPnlPct)}%.</h4>
    <div class="delta-rows">
      ${deltaRow('Annualised IRR', `+${fmtPct2(baseline.annualisedPnlPct)}%`, `+${fmtPct2(adjustedData.annualisedPnlPct)}%`, true)}
      ${deltaRow('Total return', `+${fmtPct2(baseline.totalPnlPct)}%`, `+${fmtPct2(adjustedData.totalPnlPct)}%`)}
      ${deltaRow('Net gain', `+S$${fmt2(baseline.totalPnlDollar)}`, `+S$${fmt2(adjustedData.totalPnlDollar)}`)}
    </div>
    <p class="delta-foot">${esc(excludedDescriptor.foot)} The snapshot shows an amber <b>ADJUSTED</b> pill on each metric card so it's clear at a glance.</p>
  `;
}

function unadjRow(label, value) {
  return `
    <div class="delta-row">
      <span class="lbl">${label}</span>
      <span class="nums"><span class="to">${value}</span></span>
    </div>
  `;
}

function deltaRow(label, from, to, dim = false) {
  return `
    <div class="delta-row${dim ? ' dim' : ''}">
      <span class="lbl">${label}</span>
      <span class="nums">
        <span class="from">${from}</span>
        <span class="arrow">→</span>
        <span class="to">${to}</span>
      </span>
    </div>
  `;
}

function describeExclusion(d) {
  const w = d.excludeWelcomeBonus && d.welcomeBonusAmount > 0;
  const a = d.excludeAnnualPremiumBonus && d.annualPremiumBonusAmount > 0;
  if (w && a) {
    return {
      pill: 'BOTH BONUSES EXCLUDED',
      short: 'the welcome and annual premium bonuses',
      foot: 'Both bonuses are treated as cost basis instead of premium paid.',
    };
  }
  if (w) {
    return {
      pill: 'WELCOME BONUS EXCLUDED',
      short: 'the welcome bonus',
      foot: 'The welcome bonus is treated as cost basis instead of premium paid.',
    };
  }
  return {
    pill: 'ANNUAL PREMIUM BONUS EXCLUDED',
    short: 'the annual premium bonus',
    foot: 'The annual premium bonus is treated as cost basis instead of premium paid.',
  };
}

function sparkSvg() {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.5 5.5l2 2M16.5 16.5l2 2M5.5 18.5l2-2M16.5 7.5l2-2"/></svg>`;
}


// ---------- Formatters ------------------------------------------------------

function fmt2(n) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmt0(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtPct1(n) { return Number(n || 0).toFixed(1); }
function fmtPct2(n) { return Number(n || 0).toFixed(2); }

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
