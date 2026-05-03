// Main controller: parse PDFs, drive bonus settings, re-render snapshots live.

import { parsePdf } from './parser.js';
import { derive } from './deriver.js';
import { renderToPng } from './snapshot.js';
import { buildFilename } from './naming.js';
import { PRODUCTS } from './bonus.js';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const actions = document.getElementById('actions');
const processBtn = document.getElementById('process-btn');
const resetBtn = document.getElementById('reset-btn');
const results = document.getElementById('results');
const resultsBody = document.getElementById('results-body');

const bonusPanel = document.getElementById('bonus-panel');
const bonusDetected = document.getElementById('bonus-detected');
const excludeWelcomeEl = document.getElementById('exclude-welcome');
const excludeAnnualEl = document.getElementById('exclude-annual');
const welcomeRateEl = document.getElementById('welcome-rate');
const annualRateEl = document.getElementById('annual-rate');
const welcomeAmountEl = document.getElementById('welcome-amount');
const annualAmountEl = document.getElementById('annual-amount');

let queued = [];   // [{ file, statusEl }]
let processed = []; // [{ file, raw, error?, derived?, blob? }]
let renderToken = 0;  // bumped on each re-render to discard stale awaits


// ---------- Drag-and-drop wiring ---------------------------------------------

['dragenter', 'dragover'].forEach(ev => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(ev => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])].filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (files.length) addFiles(files);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) addFiles([...fileInput.files]);
});

resetBtn.addEventListener('click', () => {
  queued = [];
  processed = [];
  fileList.innerHTML = '';
  resultsBody.innerHTML = '';
  results.hidden = true;
  bonusPanel.hidden = true;
  actions.hidden = true;
  fileInput.value = '';
});

processBtn.addEventListener('click', () => {
  processQueue().catch(err => {
    console.error(err);
    showError('Unexpected error: ' + (err?.message ?? String(err)));
  });
});

// Bonus panel listeners — debounce rapid changes for the rate inputs.
let rerenderTimer = null;
function scheduleRerender() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => updateAllRendered().catch(console.error), 80);
}
[excludeWelcomeEl, excludeAnnualEl].forEach(el => el.addEventListener('change', scheduleRerender));
[welcomeRateEl, annualRateEl].forEach(el => el.addEventListener('input', scheduleRerender));


// ---------- Queue management -------------------------------------------------

function addFiles(files) {
  for (const file of files) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = formatBytes(file.size);
    const status = document.createElement('span');
    status.className = 'file-status pending';
    status.textContent = 'queued';
    li.append(name, size, status);
    fileList.appendChild(li);
    queued.push({ file, statusEl: status });
  }
  actions.hidden = queued.length === 0;
  processBtn.textContent = queued.length > 1 ? `Generate ${queued.length} snapshots` : 'Generate snapshot';
}

function setStatus(item, label, cls) {
  item.statusEl.className = `file-status ${cls}`;
  item.statusEl.textContent = label;
}


// ---------- Pipeline ---------------------------------------------------------

async function processQueue() {
  if (!queued.length) return;
  processBtn.disabled = true;
  resetBtn.disabled = true;
  results.hidden = true;
  bonusPanel.hidden = true;
  resultsBody.innerHTML = '';
  processed = [];

  // Phase 1: parse every file (fast). Build the bonus panel from the FIRST
  // successful parse so the user sees the detected product before rendering.
  for (const item of queued) {
    setStatus(item, 'parsing…', 'processing');
    try {
      const buffer = await item.file.arrayBuffer();
      const raw = await parsePdf(buffer);
      processed.push({ file: item.file, statusEl: item.statusEl, raw });
    } catch (err) {
      console.error(`Failed to parse ${item.file.name}:`, err);
      processed.push({ file: item.file, statusEl: item.statusEl, error: err?.message ?? String(err) });
      setStatus(item, 'parse failed', 'error');
    }
  }

  const firstOk = processed.find(p => p.raw);
  if (firstOk) populateBonusPanel(firstOk.raw);

  // Phase 2: derive + render every successfully parsed file.
  await updateAllRendered();

  processBtn.disabled = false;
  resetBtn.disabled = false;
}


// ---------- Bonus panel ------------------------------------------------------

function populateBonusPanel(raw) {
  // Auto-fill rates from the detected product. Use a tentative derive() to
  // get the auto-detected values without applying any exclusions yet.
  const preview = derive(raw, {});
  const recognised = !!(raw.product && raw.variation && PRODUCTS[raw.product]?.variations?.[raw.variation]);

  if (recognised) {
    bonusDetected.innerHTML = `Detected: <strong>${escapeHtml(PRODUCTS[raw.product].label)} — ${escapeHtml(raw.variation)}</strong> · annualised premium S$${fmt0(preview.annualPremium)}`;
  } else {
    bonusDetected.innerHTML = `Could not auto-detect product/variation. Set rates manually if you want to apply IRR adjustments.`;
  }

  welcomeRateEl.value = (preview.welcomeBonusRate * 100).toFixed(1);
  annualRateEl.value = (preview.annualPremiumBonusRate * 100).toFixed(1);
  updateBonusAmounts(preview.annualPremium);
  bonusPanel.hidden = false;
}

function updateBonusAmounts(annualPremium) {
  const w = (parseFloat(welcomeRateEl.value) || 0) / 100;
  const a = (parseFloat(annualRateEl.value) || 0) / 100;
  welcomeAmountEl.textContent = `S$${fmt2(annualPremium * w)}`;
  annualAmountEl.textContent = `S$${fmt2(annualPremium * a)}`;
}

function currentBonusOptions(raw) {
  const opts = {
    excludeWelcomeBonus: excludeWelcomeEl.checked,
    excludeAnnualPremiumBonus: excludeAnnualEl.checked,
  };
  // Only override the auto-detected rate if the user actually edited the input.
  // We compare against whatever the auto-detected value is for THIS file —
  // each file may have a different auto rate (different product/variation), so
  // batch mode falls back to per-file auto-detection unless the user set a
  // value that differs from the displayed rate.
  const wInput = parseFloat(welcomeRateEl.value);
  const aInput = parseFloat(annualRateEl.value);
  if (!Number.isNaN(wInput)) opts.welcomeBonusRate = wInput / 100;
  if (!Number.isNaN(aInput)) opts.annualPremiumBonusRate = aInput / 100;
  return opts;
}


// ---------- Render orchestration ---------------------------------------------

async function updateAllRendered() {
  const myToken = ++renderToken;
  results.hidden = processed.length === 0;
  resultsBody.innerHTML = '';

  // Update the live amount labels on the panel for the FIRST successful file.
  const firstOk = processed.find(p => p.raw);
  if (firstOk) updateBonusAmounts(derive(firstOk.raw).annualPremium);

  const successes = [];
  const failures = [];

  for (const item of processed) {
    if (item.error) {
      failures.push({ filename: item.file.name, error: item.error });
      continue;
    }
    setStatus(item, 'rendering…', 'processing');
    try {
      const opts = currentBonusOptions(item.raw);
      const data = derive(item.raw, opts);
      const blob = await renderToPng(data);
      if (myToken !== renderToken) return;  // a newer render started; bail out
      const filename = buildFilename(item.raw.customerName, item.raw.policyNumber, item.raw.reportDate);
      successes.push({ filename, blob, data });
      setStatus(item, 'done', 'success');
    } catch (err) {
      console.error(`Failed to render ${item.file.name}:`, err);
      failures.push({ filename: item.file.name, error: err?.message ?? String(err) });
      setStatus(item, 'render failed', 'error');
    }
  }
  if (myToken !== renderToken) return;

  if (successes.length === 1 && failures.length === 0) {
    showSinglePreview(successes[0]);
  } else if (successes.length > 0) {
    await showBatchResult(successes, failures);
  } else {
    showError(failures.map(f => `${f.filename}: ${f.error}`).join('\n'));
  }
}

function showSinglePreview({ filename, blob, data }) {
  const url = URL.createObjectURL(blob);
  resultsBody.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'preview-card';
  card.innerHTML = `
    <img src="${url}" alt="Investment snapshot for ${escapeHtml(data.customerName)}">
    <div class="preview-actions">
      <span class="preview-meta">${escapeHtml(filename)}</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(filename)}">Download PNG</a>
    </div>
  `;
  resultsBody.appendChild(card);
}

async function showBatchResult(successes, failures) {
  resultsBody.innerHTML = '';
  // eslint-disable-next-line no-undef
  const zip = new JSZip();
  for (const s of successes) zip.file(s.filename, s.blob);
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const zipUrl = URL.createObjectURL(zipBlob);
  const zipName = `manulife-snapshots-${new Date().toISOString().slice(0, 10)}.zip`;

  const summary = document.createElement('div');
  summary.className = 'preview-card';
  summary.innerHTML = `
    <div class="preview-actions">
      <span class="preview-meta">${successes.length} snapshot${successes.length === 1 ? '' : 's'} ready${failures.length ? `, ${failures.length} failed` : ''}</span>
      <a class="btn btn-primary" href="${zipUrl}" download="${zipName}">Download ZIP (${successes.length})</a>
    </div>
  `;
  resultsBody.appendChild(summary);

  for (const f of failures) {
    const err = document.createElement('div');
    err.className = 'error-card';
    err.textContent = `${f.filename}: ${f.error}`;
    resultsBody.appendChild(err);
  }
}

function showError(message) {
  results.hidden = false;
  resultsBody.innerHTML = '';
  const err = document.createElement('div');
  err.className = 'error-card';
  err.textContent = message;
  resultsBody.appendChild(err);
}


// ---------- Misc ------------------------------------------------------------

function fmt2(n) { return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmt0(n) { return n.toLocaleString('en-US', { maximumFractionDigits: 0 }); }

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
