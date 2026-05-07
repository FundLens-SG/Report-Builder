// Main controller for the CKG-styled wrapper.
// Owns: file queue, drag-drop, bonus settings, live re-render.
// Delegates parsing/derivation/PNG rendering to the unchanged modules.

import { parsePdf } from './parser.js';
import { derive } from './deriver.js';
import { renderToPng } from './snapshot.js';
import { buildFilename } from './naming.js';
import { PRODUCTS, lookupBonusRates } from './bonus.js';

// ---- DOM lookups ------------------------------------------------------------

const dropzone = document.getElementById('dropzone');
const dropzoneWrap = document.getElementById('dropzone-wrap');
const fileInput = document.getElementById('file-input');
const chooseBtn = document.getElementById('choose-btn');
const fileList = document.getElementById('file-list');

const adjustmentsBlock = document.getElementById('adjustments-block');
const detectedSummaryEl = document.getElementById('detected-summary');
const excludeWelcomeEl = document.getElementById('exclude-welcome');
const excludeAnnualEl = document.getElementById('exclude-annual');
const welcomeTotalEl = document.getElementById('welcome-total-amount');
const annualTotalEl = document.getElementById('annual-total-amount');

const previewNavBar = document.getElementById('preview-nav-bar');
const prevPreviewBtn = document.getElementById('prev-preview');
const nextPreviewBtn = document.getElementById('next-preview');
const previewCounterEl = document.getElementById('preview-counter');
const carouselEl = document.getElementById('snapshot-carousel');
const carouselStripEl = document.getElementById('carousel-strip');

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
// Per-group bonus listeners are wired up dynamically inside renderBonusGroups
// — see the `change` / `input` delegation on the bonus-groups container.


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

  renderBonusGroups();
  await updateAllRendered({ trigger: 'parse' });
}

// Each policy across all parsed PDFs becomes its own render target.
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


// ---------- Bonus panel: global toggles, per-policy auto rates --------------
//
// Two GLOBAL checkboxes apply to every uploaded policy. Each policy still
// uses ITS OWN auto-detected rates from the bonus.js tables (welcome rate
// is tiered by annual premium, annual-premium rate is fixed per variation),
// so a 20-policy / 3-product batch toggles correctly with one click.
//
// Products without published rates contribute 0 % — toggling has no effect
// on those policies. The detected-summary above the toggles spells out
// exactly what the rates are per variant so the user can see what each
// click is going to do.

function annualPremiumFor(raw) {
  return derive(raw, {}).annualPremium;
}

// Group policies by (product, variation) for the read-only summary panel.
// Recognised products → "Manulife InvestReady (III) · 13 Years Flexi 10" with
// rates. Unrecognised → grouped by policyName so distinct ones (Manulink vs
// SRS) don't collapse together.
function detectedGroups() {
  const groups = new Map();
  for (const item of queue) {
    if (!item.raws) continue;
    for (const raw of item.raws) {
      const recognised = !!(raw.product && raw.variation
        && PRODUCTS[raw.product]?.variations?.[raw.variation]);
      const key = recognised
        ? `auto::${raw.product}::${raw.variation}`
        : `manual::${raw.policyName || 'Unknown'}`;
      if (!groups.has(key)) {
        groups.set(key, {
          recognised,
          product: raw.product,
          variation: raw.variation,
          policyName: raw.policyName,
          policies: [],
        });
      }
      groups.get(key).policies.push(raw);
    }
  }
  return groups;
}

function renderDetectedSummary() {
  const groups = detectedGroups();
  if (!groups.size) {
    adjustmentsBlock.hidden = true;
    return;
  }
  adjustmentsBlock.hidden = false;

  const totalPolicies = [...groups.values()].reduce((s, g) => s + g.policies.length, 0);
  const rows = [...groups.values()].map(grp => {
    const title = grp.recognised
      ? `${PRODUCTS[grp.product].label} · ${esc(grp.variation)}`
      : esc(grp.policyName || 'Unrecognised product');
    const pill = grp.recognised
      ? '<span class="pill detected">DETECTED</span>'
      : '<span class="pill manual">MANUAL</span>';
    // Welcome rate is tiered by annual premium, so policies in the same
    // (product, variation) group COULD land in different tiers. We use the
    // first policy's tier as the representative rate for the summary; the
    // actual render still computes the tier per-policy so each one gets the
    // correct number applied.
    const repPolicy = grp.policies[0];
    const auto = grp.recognised
      ? lookupBonusRates(grp.product, grp.variation, annualPremiumFor(repPolicy))
      : { welcomeRate: 0, annualPremiumRate: 0, recognised: false };
    const rates = grp.recognised
      ? `${(auto.welcomeRate * 100).toFixed(1)}% · ${(auto.annualPremiumRate * 100).toFixed(1)}%`
      : '<span class="none">no published bonus</span>';
    return `
      <li class="detected-summary-row">
        <span class="count">${grp.policies.length}</span>
        <span class="name">${title}</span>
        ${pill}
        <span class="rates">${rates}</span>
      </li>
    `;
  }).join('');

  detectedSummaryEl.innerHTML = `
    <p class="detected-summary-title">Detected products · ${totalPolicies} polic${totalPolicies === 1 ? 'y' : 'ies'} total</p>
    <ul class="detected-summary-list">${rows}</ul>
  `;
}

// Per-policy options for the deriver. The two booleans come from the global
// toggles; rates are deliberately NOT supplied here so derive() falls back
// to its own per-policy auto-lookup (which uses raw.product + raw.variation
// + this policy's actual annualPremium tier).
function bonusOptionsForPolicy(_raw) {
  return {
    excludeWelcomeBonus: excludeWelcomeEl.checked,
    excludeAnnualPremiumBonus: excludeAnnualEl.checked,
  };
}

// Wire the global toggles. The handlers re-render the entire batch with
// fresh per-policy rates picked up from the rate tables.
excludeWelcomeEl.addEventListener('change', () => {
  refreshBonusTotals();
  scheduleRerender();
});
excludeAnnualEl.addEventListener('change', () => {
  refreshBonusTotals();
  scheduleRerender();
});

function refreshBonusTotals() {
  // Show the total welcome / annual bonus dollars across all uploaded
  // policies — informational, doesn't depend on the checkbox state. Helps
  // the user see what's at stake before they tick.
  const policies = allParsedPolicies();
  if (!policies.length) {
    welcomeTotalEl.textContent = '—';
    annualTotalEl.textContent = '—';
    return;
  }
  let welcomeSum = 0, annualSum = 0;
  for (const { raw } of policies) {
    const ap = annualPremiumFor(raw);
    const auto = lookupBonusRates(raw.product, raw.variation, ap);
    welcomeSum += ap * (auto.welcomeRate || 0);
    annualSum += ap * (auto.annualPremiumRate || 0);
  }
  welcomeTotalEl.textContent = `S$${fmt0(welcomeSum)} total`;
  annualTotalEl.textContent = `S$${fmt0(annualSum)} total`;
}

function renderBonusGroups() {
  // Kept as a single function name so the rest of the file (processNewFiles)
  // doesn't change; it now drives the simpler detected-summary panel.
  renderDetectedSummary();
  refreshBonusTotals();
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
      const opts = bonusOptionsForPolicy(raw);
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
    teardownPreviewUrls();
    currentSuccesses = [];
    return;
  }

  // Hand the freshly rendered batch to the preview/carousel layer. It owns
  // URL lifecycles, current-index clamping, thumbnail rendering, and the
  // delta card refresh. Must be awaited — the ZIP build inside is async
  // and the success toast fires off the same updateAllRendered() return.
  await installSuccesses(successes, policies.length);

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


// ---------- Preview navigation + thumbnail carousel --------------------------
//
// Owns the rendered-snapshot URL lifecycle and the user's current selection.
// installSuccesses() takes the array produced by updateAllRendered and:
//   1. Revokes every URL handed out on the previous pass (preview, ZIP, all
//      thumbnails) so we don't leak ~500 KB per blob across re-renders.
//   2. Mints fresh URLs for each new blob.
//   3. Clamps the previously-selected index so it survives a re-render
//      losing or gaining policies.
//   4. Builds the carousel + nav bar.
//   5. Calls setCurrentPreview() to wire the main preview, download button,
//      and delta card to the active snapshot.

let currentSuccesses = [];          // [{ item, raw, blob, data, url, filename }]
let currentPreviewIndex = 0;
let lastPolicyKey = null;           // raw -> stable key, used to keep selection across re-renders

// Anchor the selection to the queue item's stable id PLUS the policy number,
// so uploading the same PDF twice (or a multi-policy PDF) gives each
// snapshot a distinct key. The queue id is generated when the user drops
// the file and survives re-renders.
function policyKey(item, raw) {
  return `${item?.id || 'unknown'}::${raw?.policyNumber || ''}`;
}

function teardownPreviewUrls() {
  // Revoke EVERY blob URL we've ever handed to the preview / thumbnails /
  // single-download / ZIP. Without this each re-render leaks ~500 KB per
  // policy; on a 20-policy batch the leaked footprint matches the live one
  // every toggle, and Chrome eventually starts failing renders mid-flight.
  for (const s of currentSuccesses) {
    if (s.url) URL.revokeObjectURL(s.url);
  }
  if (lastSingleDownloadUrl) URL.revokeObjectURL(lastSingleDownloadUrl);
  lastSingleDownloadUrl = null;
  if (lastZipUrl) URL.revokeObjectURL(lastZipUrl);
  lastZipUrl = null;
  // lastPreviewUrl is always one of the per-success urls — it's already revoked
  // by the loop above, so just clear the pointer.
  lastPreviewUrl = null;
}

async function installSuccesses(successes, totalPoliciesAttempted) {
  // Step 1: free old URLs before allocating new ones.
  teardownPreviewUrls();

  // Step 2: enrich each success with its persistent objectURL + display name.
  currentSuccesses = successes.map(s => {
    const url = URL.createObjectURL(s.blob);
    const filename = buildFilename(s.raw.customerName, s.raw.policyNumber, s.raw.reportDate);
    return { ...s, url, filename };
  });

  // Step 3: try to keep the user on the same policy across re-renders. If
  // the previous selection's policy is still in the new batch, re-anchor.
  // Otherwise default to the first.
  let nextIndex = 0;
  if (lastPolicyKey) {
    const found = currentSuccesses.findIndex(s => policyKey(s.item, s.raw) === lastPolicyKey);
    if (found >= 0) nextIndex = found;
  }
  currentPreviewIndex = nextIndex;

  // Step 4: build the ZIP (multi-policy only) — used by the Download button
  // when there's more than one snapshot.
  if (currentSuccesses.length > 1) {
    // eslint-disable-next-line no-undef
    const zip = new JSZip();
    for (const s of currentSuccesses) zip.file(s.filename, s.blob);
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    lastZipUrl = URL.createObjectURL(zipBlob);
  }

  // Step 5: render the carousel (only visible when >1 snapshot).
  renderCarousel();

  // Step 6: header counter — "PNG ready · 14 of 20".
  resultCountEl.textContent = `PNG ready · ${currentSuccesses.length} of ${totalPoliciesAttempted}`;

  // Step 7: set the active preview / download / delta card.
  setCurrentPreview(currentPreviewIndex);
  resultSection.hidden = false;
}

function setCurrentPreview(index) {
  if (!currentSuccesses.length) return;
  const clamped = Math.max(0, Math.min(currentSuccesses.length - 1, index));
  currentPreviewIndex = clamped;
  const s = currentSuccesses[clamped];
  lastPolicyKey = policyKey(s.item, s.raw);

  // Preview image + filename.
  previewImg.src = s.url;
  previewFilenameEl.textContent = s.filename;
  lastPreviewUrl = s.url;

  // Save-to-Drive context refers to the currently displayed snapshot.
  lastPreviewBlob = s.blob;
  lastPreviewMeta = {
    clientName:  s.raw.customerName || '',
    reportTitle: s.data?.product || '',
    reportId:    s.raw.policyNumber || '',
    date:        s.raw.reportDate || '',
  };
  if (driveSaveBtn) driveSaveBtn.disabled = false;

  // Download button: single PDF → individual PNG, multi → ZIP of all.
  if (currentSuccesses.length === 1) {
    downloadBtn.href = s.url;
    downloadBtn.download = s.filename;
    downloadLabel.textContent = 'Download PNG';
    lastSingleDownloadUrl = s.url;
  } else {
    downloadBtn.href = lastZipUrl;
    downloadBtn.download = `manulife-snapshots-${new Date().toISOString().slice(0, 10)}.zip`;
    downloadLabel.textContent = `Download ZIP (${currentSuccesses.length})`;
  }

  // Nav bar: hide when there's only one snapshot, otherwise update counter
  // and disabled-state for prev/next at the boundaries.
  if (currentSuccesses.length > 1) {
    previewNavBar.hidden = false;
    previewCounterEl.textContent = `${clamped + 1} of ${currentSuccesses.length}`;
    prevPreviewBtn.disabled = clamped === 0;
    nextPreviewBtn.disabled = clamped === currentSuccesses.length - 1;
  } else {
    previewNavBar.hidden = true;
  }

  // Highlight the active thumbnail and scroll it into view.
  for (const t of carouselStripEl.children) {
    t.classList.toggle('active', Number(t.dataset.index) === clamped);
  }
  const activeThumb = carouselStripEl.children[clamped];
  if (activeThumb) {
    activeThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  // Delta card reflects the SELECTED snapshot, not always the first.
  buildDeltaCard(s.raw, s.data);
}

function renderCarousel() {
  carouselStripEl.innerHTML = '';
  if (currentSuccesses.length <= 1) {
    carouselEl.hidden = true;
    return;
  }
  carouselEl.hidden = false;
  for (let i = 0; i < currentSuccesses.length; i++) {
    const s = currentSuccesses[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'carousel-thumb';
    btn.dataset.index = String(i);
    const shortLabel = s.raw.customerName
      ? s.raw.customerName.split(/\s+/).slice(0, 2).join(' ')
      : `Policy ${i + 1}`;
    btn.innerHTML = `
      <img src="${s.url}" alt="Snapshot ${i + 1}" loading="lazy">
      <span class="thumb-label">${esc(shortLabel)}</span>
    `;
    btn.addEventListener('click', () => setCurrentPreview(i));
    carouselStripEl.appendChild(btn);
  }
}

prevPreviewBtn.addEventListener('click', () => setCurrentPreview(currentPreviewIndex - 1));
nextPreviewBtn.addEventListener('click', () => setCurrentPreview(currentPreviewIndex + 1));

// Keyboard arrows navigate the carousel — except when the user is typing in
// an input/textarea (don't fight the browser's caret movement).
document.addEventListener('keydown', (e) => {
  if (currentSuccesses.length < 2) return;
  if (e.target.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    setCurrentPreview(currentPreviewIndex - 1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    setCurrentPreview(currentPreviewIndex + 1);
  }
});


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
