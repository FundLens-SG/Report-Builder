// Main controller: wires the drag-drop UI to the parse -> derive -> render pipeline.

import { parsePdf } from './parser.js';
import { derive } from './deriver.js';
import { renderToPng } from './snapshot.js';
import { buildFilename } from './naming.js';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const actions = document.getElementById('actions');
const processBtn = document.getElementById('process-btn');
const resetBtn = document.getElementById('reset-btn');
const results = document.getElementById('results');
const resultsBody = document.getElementById('results-body');

let queued = [];  // [{ file, status, statusEl, holding }]


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
  fileList.innerHTML = '';
  resultsBody.innerHTML = '';
  results.hidden = true;
  actions.hidden = true;
  fileInput.value = '';
});

processBtn.addEventListener('click', () => {
  processQueue().catch(err => {
    console.error(err);
    showError('Unexpected error: ' + (err?.message ?? String(err)));
  });
});


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
  resultsBody.innerHTML = '';

  const successes = [];
  const failures = [];

  for (const item of queued) {
    setStatus(item, 'parsing…', 'processing');
    try {
      const buffer = await item.file.arrayBuffer();
      const raw = await parsePdf(buffer);
      const data = derive(raw);
      setStatus(item, 'rendering…', 'processing');
      const blob = await renderToPng(data);
      const filename = buildFilename(raw.customerName, raw.policyNumber, raw.reportDate);
      successes.push({ filename, blob, data });
      setStatus(item, 'done', 'success');
    } catch (err) {
      console.error(`Failed to process ${item.file.name}:`, err);
      failures.push({ filename: item.file.name, error: err?.message ?? String(err) });
      setStatus(item, 'failed', 'error');
    }
  }

  results.hidden = false;
  if (successes.length === 1 && failures.length === 0) {
    showSinglePreview(successes[0]);
  } else if (successes.length > 0) {
    await showBatchResult(successes, failures);
  } else {
    showError(failures.map(f => `${f.filename}: ${f.error}`).join('\n'));
  }

  processBtn.disabled = false;
  resetBtn.disabled = false;
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
  for (const s of successes) {
    zip.file(s.filename, s.blob);
  }
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
