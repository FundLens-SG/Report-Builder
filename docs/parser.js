// Parse a Manulife Customer Investment Report PDF in the browser via PDF.js.
// Returns an ARRAY of policy reports — one entry per policy detected.
// (A single PDF can contain multiple policies; e.g. one customer with both
// an InvestReady (III) and a Manulink Investor (II) - SRS policy.)
//
// Mirrors src/parser.py: same regex patterns, same field extraction.

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import { detectProductAndVariation } from './bonus.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';


export async function parsePdf(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pageTexts = [];
  const pageItems = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pageItems.push(content.items);
    pageTexts.push(reconstructText(content.items));
  }

  const customer = parseCustomerLevel(pageTexts[0] || '');
  const blocks = findPolicyBlocks(pageTexts);
  if (!blocks.length) {
    throw new Error('No policy section detected in PDF');
  }

  const policies = blocks.map(block => parsePolicyBlock(pageTexts, pageItems, block, customer));
  // Surface a per-policy error inline rather than throwing the whole batch.
  // Caller (app.js) only consumes successful policies; failures bubble up
  // through `_error` so the file row can show what went wrong.
  return policies;
}


// ---------- Page-level routing ------------------------------------------------

const POLICY_HEADER_RE = /^[^\n]*?\(\s*\d{6,12}\s*\)\s+\(as of \d{1,2} \w+ \d{4}\)\s*$/m;
const POLICY_NUMBER_FIELD_RE = /Policy Number[ \t]+\d{6,12}|^\s*\d{6,12}[ \t]+SGD[ \t]+-?[\d,]+\.\d{2}\s*\n[^\n]*Policy Number/m;

// A page is a "policy info page" if it has the "<Product> (POLICYNUM) (as of
// DATE)" header AND/OR a "Policy Number <NNNN>" field. We accept either form
// so that re-laid-out PDFs (e.g. the scrambled fixture, where the header
// policy number can drift during redaction) are still recognised. The
// corresponding holdings table is on the next page.
function findPolicyBlocks(pageTexts) {
  const blocks = [];
  for (let i = 1; i < pageTexts.length; i++) {
    const text = pageTexts[i];
    if (!text) continue;
    if (POLICY_HEADER_RE.test(text) || POLICY_NUMBER_FIELD_RE.test(text)) {
      blocks.push({ infoPage: i, holdingsPage: i + 1 });
    }
  }
  return blocks;
}


// ---------- Customer-level fields (shared across all policies) ---------------

function parseCustomerLevel(page1Text) {
  // Customer-name patterns. The character class is intentionally generous —
  // Singaporean names regularly include a parenthesised Chinese alias
  // ("TAN SAN SAN (CHEN SHANSHAN)"), hyphens, periods (initials), and
  // commas. We greedy-match across the line and let the trailing
  // [A-Z\)] anchor pull the regex back to the last uppercase character or
  // closing paren before the required " Manulife (Singapore)" terminator,
  // so the alias is preserved without engulfing whitespace into the name.
  const customerName = grabFirst(page1Text, [
    /^([A-Z][A-Z ()\-.,]*[A-Z)])[ \t]+Manulife[ \t]*\(Singapore\)/m,
    /Manulife[ \t]*\(Singapore\)[ \t]+Pte\.[ \t]*Ltd\.[^\n]*\n[ \t]*([A-Z][A-Z ()\-.,]*[A-Z)])[ \t]*\n/,
  ]);
  const reportDate = grabFirst(page1Text, [
    /Customer Total Policy Holdings\s*\(as of (\d{1,2} \w+ \d{4})\)/,
  ]);
  // Risk profile values can be multi-word ("Moderately Aggressive", "Not
  // Done", "Pending Review") — the original `\w+` only captured "Moderately"
  // and missed the rest. We accept letters + spaces, lazily, stopping at
  // the closing `(Expiry date: …)` paren or end of line.
  const riskProfile = grabFirst(page1Text, [
    /Risk Profile Questionnaire[ \t]+([A-Za-z][A-Za-z ]*?)(?=[ \t]*\(Expiry|[ \t]*\n|$)/,
    /^([A-Za-z][A-Za-z ]*?)[ \t]+Total Investment Value\s*\n\s*Risk Profile Questionnaire/m,
    /Risk Profile Questionnaire\s*\n[ \t]*([A-Za-z][A-Za-z ]+?)(?=[ \t]*\n)/,
  ]);
  const ckaStatus = grabFirst(page1Text, [
    /Customer Knowledge Assessment[ \t]+(\w+)[ \t]+Total Market Value/,
    /Customer Knowledge Assessment[ \t]+(\w+)/,
  ]);
  // First "(Expiry date: ...)" after CKA. JS dotall via `[\s\S]`.
  const ckaExpiry = grabFirst(page1Text, [
    /Customer Knowledge Assessment[\s\S]*?\(Expiry date:\s+(\d{2}\/\d{2}\/\d{4})\)/,
  ]);

  // Only customerName + reportDate are TRULY required — without them we
  // can't build the filename or header. Everything else (riskProfile, CKA
  // status, CKA expiry) is footer-only metadata that the snapshot can
  // gracefully omit. Failing the parse for those just means a 20-PDF
  // batch fails 18 PDFs because the bottom-of-card footnote can't render
  // exactly as planned, which is the wrong tradeoff.
  const required = { customerName, reportDate };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing customer-level fields in PDF: ${missing.join(', ')}`);
  }
  return {
    customerName,
    reportDate,
    riskProfile: riskProfile ? riskProfile.trim() : '',
    ckaStatus: ckaStatus || '',
    ckaExpiry: ckaExpiry || '',
  };
}


// ---------- Per-policy parser ------------------------------------------------

function parsePolicyBlock(pageTexts, pageItems, block, customer) {
  // Use only the policy's info page for regex matching — searching the
  // whole document would let one policy's value match another policy's
  // label (e.g. policy 2's Account Value matched against policy 1's row).
  const text = pageTexts[block.infoPage] || '';

  // `[ \t]+` matches inline whitespace ONLY — it must NOT cross newlines.
  // Bare `\s+` would jump to the next line and grab the wrong field's value.
  const policyName = grabFirst(text, [
    // Original Manulife layout (PDF.js): "Policy Name <name> Account Value SGD ..."
    /Policy Name[ \t]+(.+?)[ \t]+Account Value[ \t]+SGD/,
    // Re-laid-out / pdfplumber layout: name on previous line, then "Policy Name" label
    /^([^\n]+?)[ \t]+SGD[ \t]+-?[\d,]+\.\d{2}\s*\n[^\n]*Policy Name/m,
  ]);
  const policyNumber = grabFirst(text, [
    /Policy Number[ \t]+(\d{6,12})/,
    /(\d{6,12})[ \t]+SGD[ \t]+-?[\d,]+\.\d{2}\s*\n[^\n]*Policy Number/,
  ]);
  const policyIssueDate = grabFirst(text, [
    /Policy Issue Date[ \t]+(\d{2}\/\d{2}\/\d{4})/,
    /(\d{2}\/\d{2}\/\d{4})[ \t]+Total Rider Premiums\s*\n\s*Policy Issue Date/,
    /^[ \t]*(\d{2}\/\d{2}\/\d{4})\s*\n\s*Policy Issue Date/m,
  ]);

  const accountValue = grabMoneyFirst(text, [
    /Account Value[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})/,
    /SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n[^\n]*Account Value/,
  ]);
  const policyInvestmentCost = grabMoneyFirst(text, [
    /Policy Investment Cost\*?[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})/,
    /SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n[^\n]*Policy Investment Cost/,
  ]);
  const totalPnlDollar = grabMoneyFirst(text, [
    /Total P&L \(\$\)[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})/,
    /SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n\s*Total P&L \(\$\)/,
  ]);
  const totalRiderPremiums = grabMoneyFirst(text, [
    /Total Rider Premiums[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})/,
    /SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n[^\n]*Total Rider Premiums/,
  ]);
  const totalDividendsReinvested = grabMoneyFirst(text, [
    /Total Dividends Reinvested[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})/,
    /SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n\s*Total Dividends Reinvested/,
  ]);
  // Cash that's already left the policy. Manulife's Annualised P&L formula
  // counts both as "investment value" alongside Account Value, so we need
  // them whenever we recompute P&L locally (e.g. bonus-exclusion adjustments).
  // Without them, a policy that has paid out cash dividends shows a
  // collapsed adjusted IRR — the cash that already returned to the customer
  // stops counting as a return.
  const totalDividendsPaidOut = grabMoneyFirst(text, [
    /Total Dividends Paid Out\*?[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})/,
    /SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n\s*Total Dividends Paid Out/,
  ]);
  const totalPartialWithdrawal = grabMoneyFirst(text, [
    /Total Partial Withdrawal\*?[ \t]+SGD[ \t]+(-?[\d,]+\.\d{2})/,
    /SGD[ \t]+(-?[\d,]+\.\d{2})\s*\n\s*Total Partial Withdrawal/,
  ]);

  const totalPnlPct = parseFloat(grabFirst(text, [
    /Total P&L \(%\)[ \t]+(-?[\d.]+)/,
    /^(-?[\d.]+)\s*\n\s*Total P&L \(%\)/m,
  ]) || '0');
  const annualisedPnlPct = parseFloat(grabFirst(text, [
    /Annualised P&L \(%\)[ \t]+(-?[\d.]+)/,
    /^(-?[\d.]+)\s*\n\s*Annualised P&L \(%\)/m,
  ]) || '0');

  const required = { policyName, policyNumber, policyIssueDate };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing policy fields on page ${block.infoPage + 1}: ${missing.join(', ')}`);
  }

  const holdings = parseHoldingsFromPageItems(pageItems[block.holdingsPage]);
  if (!holdings.length) {
    throw new Error(`No fund holdings detected on page ${block.holdingsPage + 1}`);
  }

  const { product, variation } = detectProductAndVariation(policyName);

  return {
    ...customer,
    policyName,
    policyNumber,
    policyIssueDate,
    accountValue,
    policyInvestmentCost,
    totalPnlDollar,
    totalPnlPct,
    annualisedPnlPct,
    totalRiderPremiums,
    totalDividendsReinvested,
    totalDividendsPaidOut,
    totalPartialWithdrawal,
    holdings,
    product,
    variation,
  };
}


// ---------- Text reconstruction ------------------------------------------------

// PDF.js gives us text items with transform matrices. To get pdfplumber-style
// line-based text, we cluster items by y-coordinate and sort within each line by x.
function reconstructText(items) {
  if (!items.length) return '';
  const placed = items.map(it => ({
    str: it.str,
    x: it.transform[4],
    y: it.transform[5],
    h: it.height || it.transform[3] || 10,
  })).filter(it => it.str !== undefined);

  placed.sort((a, b) => b.y - a.y);  // top to bottom
  const lines = [];
  const tolerance = 3;
  for (const it of placed) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= tolerance) {
      last.items.push(it);
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }

  return lines.map(line => {
    line.items.sort((a, b) => a.x - b.x);
    let out = '';
    let prevEnd = null;
    for (const it of line.items) {
      if (prevEnd !== null && it.x - prevEnd > 1.5) out += ' ';
      out += it.str;
      prevEnd = it.x + estimateWidth(it.str, it.h);
    }
    return out.replace(/\s+/g, ' ').trim();
  }).join('\n');
}

function estimateWidth(str, h) {
  return str.length * h * 0.5;
}


// ---------- Holdings parsing --------------------------------------------------

const TICKER_RE = /\(([A-Z]{3,5})\)\s*$/;
// Numeric cells can be negative (e.g. "-170.11" P&L) and may include trailing
// digits that pdfplumber/PDF.js wrap onto the next line ("3,326.3300\n0").
const NUMERIC_RE = /^-?[\d,]+\.\d+(?:\s*\d+)?$/;


function parseHoldingsFromPageItems(items) {
  if (!items?.length) return [];
  const rows = clusterIntoRows(items);
  const subAssetX = findSubAssetColumnX(rows);
  return extractHoldingsFromRows(rows, subAssetX);
}

// The Asset Class / Sub-Asset Class columns are TEXT columns with no numeric
// anchor of their own, so we can't infer the boundary from the data row alone.
// Without a header anchor we fell back to a fixed 25 px x-gap heuristic, which
// silently dropped any fund whose asset class spanned 3+ words (e.g. "Fixed
// Income Global") because every inter-word gap was <25 px and the whole row
// collapsed into a single column → `clusters.length < 2` → row discarded.
// Anchoring on the header's "Sub-Asset" token gives us a stable column boundary
// that doesn't depend on how wide the asset-class text happens to be.
//
// PDF.js fragments text at hyphens, so "Sub-Asset" arrives as either two
// tokens ["Sub-", "Asset"] or one ["Sub-Asset"]. We match all three forms
// ("Sub", "Sub-", "Sub-Asset"). To avoid latching onto a data-row substring,
// we require the matched row to also contain a preceding "Asset" token — that
// only happens in the column-header row that reads "Asset Class Sub-Asset
// Class …".
function findSubAssetColumnX(rows) {
  for (const row of rows) {
    const sub = row.find(c => /^Sub-?(Asset)?$/i.test(c.text));
    if (!sub) continue;
    const hasLeadingAsset = row.some(c => c.text === 'Asset' && c.x < sub.x);
    if (hasLeadingAsset) return sub.x;
  }
  return null;
}

function clusterIntoRows(items) {
  const placed = items.map(it => ({
    text: (it.str || '').trim(),
    x: it.transform[4],
    y: it.transform[5],
  })).filter(it => it.text);

  placed.sort((a, b) => b.y - a.y);
  const rows = [];
  const tolerance = 3;
  for (const it of placed) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].y - it.y) <= tolerance) last.push(it);
    else rows.push([it]);
  }
  rows.forEach(r => r.sort((a, b) => a.x - b.x));
  return rows.map(mergeSplitNumbers);
}

// PDF.js sometimes splits long numbers across adjacent text items. Two
// patterns we've observed in real Manulife reports:
//
//   "13,737" + ".79"          decimal-fragment split   (NEMD pol 1)
//   "187"   + ",200.00"       comma-group split         (MGMD pol 3)
//   "187"   + ",200" + ".00"  both at once (rare)
//
// Glue them back together so the downstream numeric regex sees a single
// token. We run multiple passes until convergence so a three-way split
// folds correctly: "187" → "187,200" → "187,200.00".
function mergeSplitNumbers(row) {
  let prev = row;
  for (let pass = 0; pass < 4; pass++) {
    const next = mergeSplitNumbersOnce(prev);
    if (next.length === prev.length) return next;
    prev = next;
  }
  return prev;
}

function mergeSplitNumbersOnce(row) {
  const out = [];
  for (let i = 0; i < row.length; i++) {
    const cur = row[i];
    const next = row[i + 1];
    if (
      next
      // cur ends with a digit — could be the head of a number
      && /\d$/.test(cur.text)
      // next is a continuation: a decimal fragment ".<digits>" OR a
      // thousand group ",<digits>{3}…". The {3,} guard avoids gluing
      // unrelated comma-prefixed text accidentally.
      && (/^\.\d/.test(next.text) || /^,\d{3}\b/.test(next.text))
      // and the two pieces are visually close — PDF.js artefact, not two
      // unrelated columns side by side
      && (next.x - cur.x) < 30
    ) {
      out.push({ ...cur, text: cur.text + next.text });
      i++;
    } else {
      out.push(cur);
    }
  }
  return out;
}

function extractHoldingsFromRows(rows, subAssetX) {
  const out = [];
  let pendingHeader = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const flat = row.map(c => c.text).join(' ').trim();
    const hasNumeric = row.some(c => NUMERIC_RE.test(c.text));

    const m = TICKER_RE.exec(flat);
    if (m && !hasNumeric) {
      pendingHeader = {
        ticker: m[1],
        fullName: flat.slice(0, m.index).replace(/\s*\(?\s*$/, '').trim(),
      };
      continue;
    }

    const nums = row.filter(c => NUMERIC_RE.test(c.text));
    if (pendingHeader && nums.length >= 5) {
      const wrapTexts = [];
      const next = rows[i + 1];
      if (next) {
        const dy = Math.abs(row[0].y - next[0].y);
        const nextNums = next.filter(c => NUMERIC_RE.test(c.text));
        const nextTexts = next.filter(c => !NUMERIC_RE.test(c.text));
        if (dy <= 15 && nextTexts.length > 0 && nextNums.length <= 1) {
          for (const t of nextTexts) wrapTexts.push({ ...t });
        }
      }

      const holding = buildHoldingFromRow(pendingHeader, row, wrapTexts, subAssetX);
      if (holding) out.push(holding);
      pendingHeader = null;
    }
  }
  return out;
}

function buildHoldingFromRow(header, row, wrapTexts, subAssetX) {
  const nums = row.filter(c => NUMERIC_RE.test(c.text)).sort((a, b) => a.x - b.x);
  if (nums.length < 5) return null;

  const fundValue = toFloat(nums[0].text);
  const pnlDollar = toFloat(nums[3].text);
  const pnlPct = toFloat(nums[4].text);

  const firstNumX = nums[0].x;
  const dataTexts = row
    .filter(c => !NUMERIC_RE.test(c.text) && c.x < firstNumX - 5)
    .map(c => ({ ...c }));
  const allTexts = [...dataTexts, ...wrapTexts.filter(c => c.x < firstNumX - 5)];
  if (allTexts.length < 2) return null;
  allTexts.sort((a, b) => a.x - b.x);

  const groupTexts = subAssetX != null
    ? splitByAnchor(allTexts, subAssetX)
    : splitByGap(allTexts);
  if (!groupTexts) return null;

  return {
    fundFullName: header.fullName,
    ticker: header.ticker,
    assetClass: groupTexts[0],
    subAssetClass: groupTexts[1],
    fundValue,
    pnlDollar,
    pnlPct,
  };
}

// Header-anchored split: anything left of the Sub-Asset Class column header's x
// is Asset Class, anything from there up to the first numeric is Sub-Asset
// Class. Small (-2 px) tolerance absorbs PDF.js sub-pixel drift so an item
// starting fractionally before the anchor still lands in the right column.
function splitByAnchor(allTexts, subAssetX) {
  const assetItems = allTexts.filter(t => t.x < subAssetX - 2);
  const subAssetItems = allTexts.filter(t => t.x >= subAssetX - 2);
  if (!assetItems.length || !subAssetItems.length) return null;
  return [
    cleanupColumnText(assetItems.map(t => t.text).join(' ')),
    cleanupColumnText(subAssetItems.map(t => t.text).join(' ')),
  ];
}

// Legacy gap-based fallback used only when the header anchor can't be located
// (e.g. a re-laid-out PDF where the "Sub-Asset" token doesn't appear). Splits
// at the first inter-word gap >25 px. This is the heuristic that silently
// dropped Fixed Income Global rows before the anchor was added.
function splitByGap(allTexts) {
  const clusters = [];
  for (const t of allTexts) {
    const last = clusters[clusters.length - 1];
    if (last && t.x - last.maxX <= 25) {
      last.items.push(t);
      last.maxX = Math.max(last.maxX, t.x);
    } else {
      clusters.push({ items: [t], maxX: t.x });
    }
  }
  if (clusters.length < 2) return null;
  return clusters.map(c => {
    c.items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    return cleanupColumnText(c.items.map(it => it.text).join(' '));
  });
}

function cleanupColumnText(s) {
  return s.replace(/([\/\-])\s+/g, '$1').replace(/\s+/g, ' ').trim();
}


// ---------- Helpers -----------------------------------------------------------

function grabFirst(text, regexes) {
  for (const re of regexes) {
    const m = re.exec(text);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function grabMoneyFirst(text, regexes) {
  const v = grabFirst(text, regexes);
  return v ? toFloat(v) : 0;
}

function toFloat(s) {
  // Manulife wraps long numbers across cell rows: "3,326.3300\n0" means 3326.33000.
  return parseFloat(String(s).replace(/\s+/g, '').replace(/,/g, ''));
}
