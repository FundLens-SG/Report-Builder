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
const driveSaveBtn = document.getElementById('drive-save-btn');
const driveSaveLabel = document.getElementById('drive-save-label');
const driveLoadBtn = document.getElementById('drive-load-btn');
const deltaCardEl = document.getElementById('delta-card');

const renderToastEl = document.getElementById('render-toast');
const renderToastMsgEl = renderToastEl?.querySelector('.msg');

// Phase 9F — keep the latest preview blob + meta so the Drive Save
// button always saves the currently displayed report.
let lastPreviewBlob = null;
let lastPreviewMeta = null;
// Track every object URL we hand out so we can revoke previous ones when a
// new render lands. Without this, each batch leaks ~500 KB per snapshot
// (multiplied across re-renders triggered by bonus toggles) and the browser
// eventually starts failing renders on memory-constrained machines.
let lastPreviewUrl = null;
let lastSingleDownloadUrl = null;

const STATUS_LABELS = {
  queued: 'Queued',
  parsing: 'Parsing',
  rendering: 'Rendering',
  done: 'Done',
  failed: 'Failed',
};

// Each queue entry corresponds to ONE uploaded PDF. A single PDF may contain
// multiple policies (Manulife customer reports with two ILPs, etc.) — in that
// case `raws` holds an array of policy records and we render one PNG per
// policy. The file row stays "Done" once all of its policies have rendered.
let queue = [];           // [{ id, file, badgeEl, raws?, error? }]
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
  const firstParsed = queue.find(q => q.raws && q.raws.length);
  if (firstParsed) {
    const recognised = firstParsed.raws.find(r =>
      r.product && r.variation && PRODUCTS[r.product]?.variations?.[r.variation]
    );
    const target = recognised || firstParsed.raws[0];
    updateBonusAmounts(derive(target, {}).annualPremium);
  }
  // Show the toast IMMEDIATELY (during the 90 ms debounce window) so the
  // user sees acknowledgement of their click before the actual render
  // starts. Otherwise a 20-policy re-render reads as silence.
  showLoadingToast();
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(
    () => updateAllRendered({ trigger: 'rerender' }).catch(console.error),
    90,
  );
}

// ---------- Render toast -----------------------------------------------------
//
// One toast element with two states:
//   loading  → spinner + "Updating snapshots… X / Y"
//   success  → green check + "Successfully converted N PDFs → M Images"
//                          (or "Updated M snapshot(s)" on re-render)
// The success state auto-fades after a brief celebration window. A new
// loading call before the fade kicks in cancels the auto-hide cleanly.

let _toastHideTimer = null;

function setToastState(state, message) {
  if (!renderToastEl) return;
  // Clear any pending auto-hide so a quick toggle-after-success doesn't
  // accidentally hide the new loading toast mid-flight.
  clearTimeout(_toastHideTimer);
  _toastHideTimer = null;

  renderToastEl.classList.remove('is-loading', 'is-success');
  renderToastEl.classList.add(`is-${state}`);
  if (renderToastMsgEl && message) renderToastMsgEl.textContent = message;
  renderToastEl.hidden = false;
  // RAF so the `display:none -> block` flip lands before the opacity transition
  requestAnimationFrame(() => renderToastEl.classList.add('show'));
}

function showLoadingToast(progressText) {
  setToastState(
    'loading',
    progressText ? `Updating snapshots… ${progressText}` : 'Updating snapshots…'
  );
}

function showSuccessToast(message, autoHideMs = 2600) {
  setToastState('success', message);
  _toastHideTimer = setTimeout(hideRenderToast, autoHideMs);
}

function hideRenderToast() {
  if (!renderToastEl) return;
  clearTimeout(_toastHideTimer);
  _toastHideTimer = null;
  renderToastEl.classList.remove('show');
  setTimeout(() => {
    if (!renderToastEl.classList.contains('show')) renderToastEl.hidden = true;
  }, 240);
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
    queue.push({ id, file, li, badgeEl: li.querySelector('.badge') });
  }
  // Process the newly added files (existing 'done' files stay in the list).
  processNewFiles().catch(err => {
    console.error(err);
  });
}

function setStatus(item, status, errorMessage) {
  item.badgeEl.className = `badge ${status}`;
  item.badgeEl.innerHTML = `<span class="dot"></span>${STATUS_LABELS[status] ?? status}`;
  // Surface the failure reason via the badge tooltip so the user can hover
  // to see exactly what went wrong (e.g. "Missing required fields ..."),
  // instead of guessing why a row is red.
  if (status === 'failed' && errorMessage) {
    item.badgeEl.title = errorMessage;
  } else {
    item.badgeEl.removeAttribute('title');
  }
}

// Remove the file's row from the list once it reaches a terminal state. The
// `raws` data stays in `queue` so re-renders (bonus toggles) still work; we
// only detach the visible <li>. This keeps the list short across long
// sessions where the user uploads many batches in sequence.
const REMOVE_DELAY_MS = 1500;  // long enough to read "Done"
function scheduleRowRemoval(item) {
  if (item.removalScheduled) return;
  item.removalScheduled = true;
  setTimeout(() => {
    if (!item.li || !item.li.parentNode) return;
    item.li.classList.add('fading-out');
    setTimeout(() => {
      if (item.li && item.li.parentNode) item.li.remove();
    }, 250);
  }, REMOVE_DELAY_MS);
}

async function processNewFiles() {
  const pending = queue.filter(q => !q.raws && !q.error);
  if (!pending.length) return;

  for (const item of pending) {
    setStatus(item, 'parsing');
    try {
      const buffer = await item.file.arrayBuffer();
      item.raws = await parsePdf(buffer);
      if (!item.raws.length) throw new Error('No policies detected');
    } catch (err) {
      console.error(`Failed to parse ${item.file.name}:`, err);
      item.error = err?.message ?? String(err);
      setStatus(item, 'failed', item.error);
      scheduleRowRemoval(item);
    }
  }

  populateBonusPanelFromFirst();
  await updateAllRendered({ trigger: 'parse' });
}

// Each policy across all parsed PDFs becomes its own render target. Used by
// updateAllRendered + populateBonusPanelFromFirst.
function allParsedPolicies() {
  const out = [];
  for (const item of queue) {
    if (!item.raws) continue;
    for (const raw of item.raws) {
      out.push({ item, raw });
    }
  }
  return out;
}


// ---------- Bonus panel ------------------------------------------------------

function populateBonusPanelFromFirst() {
  // Use the first policy that has a recognised product, falling back to the
  // first policy of the first parsed PDF. Multi-policy PDFs typically include
  // a Manulink/SRS variant alongside an InvestReady variant — we prefer the
  // recognised one so the bonus panel actually has detected rates to show.
  const policies = allParsedPolicies();
  if (!policies.length) return;
  const recognisedFirst = policies.find(({ raw }) =>
    raw.product && raw.variation && PRODUCTS[raw.product]?.variations?.[raw.variation]
  );
  const target = (recognisedFirst || policies[0]).raw;

  const preview = derive(target, {});
  const recognised = !!(target.product && target.variation
    && PRODUCTS[target.product]?.variations?.[target.variation]);

  if (recognised) {
    detectedProductEl.textContent = PRODUCTS[target.product].label;
    detectedVariationLineEl.textContent = `${target.variation}  ·  S$${fmt0(preview.annualPremium)} annual`;
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

async function updateAllRendered({ trigger = 'rerender' } = {}) {
  const myToken = ++renderToken;
  const policies = allParsedPolicies();
  if (!policies.length) {
    resultSection.hidden = true;
    hideRenderToast();
    return;
  }

  // Show the loading toast with progress straight away. Single-policy passes
  // skip the "0 / 1" suffix to avoid noise — they're fast enough that the
  // success state lands within the 600 ms minimum dwell.
  showLoadingToast(policies.length > 1 ? `0 / ${policies.length}` : null);
  const loadingShownAt = performance.now();

  // Render every policy across every uploaded PDF. A file row goes to "Done"
  // only after its last policy has rendered (or any policy fails).
  const renderedByItem = new Map();  // queue item -> { ok: int, fail: int }
  const successes = [];
  let renderedCount = 0;
  for (const { item, raw } of policies) {
    setStatus(item, 'rendering');
    try {
      const opts = currentBonusOptions();
      const data = derive(raw, opts);
      const blob = await renderToPng(data);
      if (myToken !== renderToken) return;  // newer render started; new pass owns the toast
      successes.push({ item, raw, blob, data });
      const tally = renderedByItem.get(item) || { ok: 0, fail: 0 };
      tally.ok += 1; renderedByItem.set(item, tally);
      try { window.ckgTrackReportConverted && window.ckgTrackReportConverted(raw, data); } catch (_e) {}
    } catch (err) {
      // html2canvas can fail mid-flight when a newer render started — that
      // throws because the cloned iframe loses the removed node. Not a real
      // parse failure: silently abort the stale pass.
      if (myToken !== renderToken) return;
      console.error(`Failed to render ${item.file.name} (policy ${raw.policyNumber}):`, err);
      const tally = renderedByItem.get(item) || { ok: 0, fail: 0 };
      tally.fail += 1; renderedByItem.set(item, tally);
      if (!item.error) item.error = err?.message ?? String(err);
    }
    renderedCount += 1;
    if (myToken === renderToken && policies.length > 1) {
      showLoadingToast(`${renderedCount} / ${policies.length}`);
    }
  }
  if (myToken !== renderToken) return;

  // Update each file row's badge to reflect aggregate success across its
  // policies, then remove the row from the list once it has settled.
  for (const [item, tally] of renderedByItem) {
    const failed = tally.fail > 0 && tally.ok === 0;
    setStatus(item, failed ? 'failed' : 'done', failed ? item.error : undefined);
    scheduleRowRemoval(item);
  }
  if (!successes.length) {
    resultSection.hidden = true;
    return;
  }

  // Preview is the FIRST successful policy (first PDF, first policy).
  const first = successes[0];
  const firstFilename = buildFilename(first.raw.customerName, first.raw.policyNumber, first.raw.reportDate);
  if (lastPreviewUrl) URL.revokeObjectURL(lastPreviewUrl);
  const firstUrl = URL.createObjectURL(first.blob);
  lastPreviewUrl = firstUrl;
  previewImg.src = firstUrl;
  previewFilenameEl.textContent = firstFilename;

  // Phase 9F — remember the latest preview for the Save-to-Drive button.
  lastPreviewBlob = first.blob;
  lastPreviewMeta = {
    clientName:  first.raw.customerName || '',
    reportTitle: first.data?.product || '',
    reportId:    first.raw.policyNumber || '',
    date:        first.raw.reportDate || '',
  };
  if (driveSaveBtn) driveSaveBtn.disabled = false;

  // Free the previous single-download URL before assigning a new one, and
  // free the ZIP URL before building a new ZIP — without this each batch
  // leaks ~20 MB of blob storage that the browser can't reclaim until the
  // page is reloaded.
  if (lastSingleDownloadUrl) URL.revokeObjectURL(lastSingleDownloadUrl);
  lastSingleDownloadUrl = null;
  if (lastZipUrl) URL.revokeObjectURL(lastZipUrl);
  lastZipUrl = null;

  if (successes.length === 1) {
    downloadBtn.href = firstUrl;
    downloadBtn.download = firstFilename;
    downloadLabel.textContent = 'Download PNG';
    resultCountEl.textContent = 'PNG ready · 1 of 1';
    lastSingleDownloadUrl = firstUrl;
  } else {
    // eslint-disable-next-line no-undef
    const zip = new JSZip();
    for (const s of successes) {
      const fname = buildFilename(s.raw.customerName, s.raw.policyNumber, s.raw.reportDate);
      zip.file(fname, s.blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    lastZipUrl = URL.createObjectURL(zipBlob);
    const zipName = `manulife-snapshots-${new Date().toISOString().slice(0, 10)}.zip`;
    downloadBtn.href = lastZipUrl;
    downloadBtn.download = zipName;
    downloadLabel.textContent = `Download ZIP (${successes.length})`;
    resultCountEl.textContent = `PNG ready · ${successes.length} of ${policies.length}`;
  }

  buildDeltaCard(first.raw, first.data);
  resultSection.hidden = false;

  // Last non-preempted pass: swap the toast into its success state and let
  // it auto-fade. Earlier passes that got overtaken by a newer toggle bailed
  // at `myToken !== renderToken` without touching the toast, so the newer
  // pass naturally owns it through to here.
  //
  // Wording reflects the trigger:
  //   parse    → "Successfully converted N PDFs → M Images"  (initial upload)
  //   rerender → "Updated M snapshot(s)"                      (bonus toggle)
  const nPdfs = countDistinctPdfs(successes);
  const nImages = successes.length;
  const successMsg = trigger === 'parse'
    ? `Successfully converted ${nPdfs} PDF${nPdfs === 1 ? '' : 's'} → ${nImages} Image${nImages === 1 ? '' : 's'}`
    : `Updated ${nImages} snapshot${nImages === 1 ? '' : 's'}`;

  // Enforce a minimum dwell on the loading toast so very fast renders
  // (≤200 ms) don't flash and disappear before the user registers them.
  const minLoadingMs = 600;
  const elapsed = performance.now() - loadingShownAt;
  const wait = Math.max(0, minLoadingMs - elapsed);
  setTimeout(() => {
    if (myToken === renderToken) showSuccessToast(successMsg);
  }, wait);
}

function countDistinctPdfs(successes) {
  const seen = new Set();
  for (const s of successes) seen.add(s.item);
  return seen.size;
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
        ${unadjRow('Net gain', signedMoney(raw.totalPnlDollar))}
        ${unadjRow('Total return', signedPct(raw.totalPnlPct))}
        ${unadjRow('Annualised IRR', signedPct(raw.annualisedPnlPct))}
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
      ${deltaRow('Annualised IRR', signedPct(baseline.annualisedPnlPct), signedPct(adjustedData.annualisedPnlPct), true)}
      ${deltaRow('Total return', signedPct(baseline.totalPnlPct), signedPct(adjustedData.totalPnlPct))}
      ${deltaRow('Net gain', signedMoney(baseline.totalPnlDollar), signedMoney(adjustedData.totalPnlDollar))}
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
// Use U+2212 ('−') for losses — better visual rhythm than the ASCII hyphen.
function signedMoney(n) { return n < 0 ? `−S$${fmt2(Math.abs(n))}` : `+S$${fmt2(n)}`; }
function signedPct(n)   { return n < 0 ? `−${fmtPct2(Math.abs(n))}%` : `+${fmtPct2(n)}%`; }

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

// ── Phase 9F — Google Drive save/load wiring ─────────────────────
// drive.js loads first and exposes window.ckgDriveSave / ckgDriveLoad.
// Both are no-ops if the user isn't signed into the hub at ckgtools.com.
function setSaveState(label, disabled) {
  if (driveSaveLabel) driveSaveLabel.textContent = label;
  if (driveSaveBtn)   driveSaveBtn.disabled = !!disabled;
}

if (driveSaveBtn) {
  driveSaveBtn.disabled = true;  // becomes enabled once a preview exists
  driveSaveBtn.addEventListener('click', async () => {
    if (!lastPreviewBlob) return;
    if (typeof window.ckgDriveSave !== 'function') {
      console.warn('[Drive] ckgDriveSave unavailable — drive.js failed to load');
      return;
    }
    setSaveState('Saving…', true);
    try {
      const out = await window.ckgDriveSave(lastPreviewBlob, lastPreviewMeta || {});
      if (out && out.id) {
        setSaveState('Saved to Drive', true);
        setTimeout(() => setSaveState('Save to Drive', false), 2400);
      } else {
        setSaveState('Save failed', false);
        setTimeout(() => setSaveState('Save to Drive', false), 2400);
      }
    } catch (e) {
      console.error('[Drive] save threw:', e);
      setSaveState('Save failed', false);
      setTimeout(() => setSaveState('Save to Drive', false), 2400);
    }
  });
}

if (driveLoadBtn) {
  driveLoadBtn.addEventListener('click', async () => {
    if (typeof window.ckgDriveLoad !== 'function') {
      console.warn('[Drive] ckgDriveLoad unavailable — drive.js failed to load');
      return;
    }
    await window.ckgDriveLoad(({ blob, name }) => {
      // Display the loaded image in the preview area. We don't replace
      // the report data — this is a "quick look" surface for previously
      // saved snapshots. User can re-render to get the live data view.
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      previewImg.src = url;
      if (previewFilenameEl) previewFilenameEl.textContent = name || 'loaded-from-drive.png';
      if (resultSection) resultSection.hidden = false;
      // Hand the new blob to the download button so the user can re-save.
      if (downloadBtn) {
        downloadBtn.href = url;
        downloadBtn.download = name || 'report.png';
        if (downloadLabel) downloadLabel.textContent = 'Download PNG';
      }
      // Replace the in-memory blob so a follow-up Save-to-Drive saves
      // this loaded image rather than the previous render.
      lastPreviewBlob = blob;
      lastPreviewMeta = { clientName: '', reportTitle: '', reportId: '', date: '' };
    });
  });
}
