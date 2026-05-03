// Parse a Manulife Customer Investment Report PDF in the browser via PDF.js.
// Mirrors src/parser.py: same regex patterns, same field extraction.

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';

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
  // Only the first 3 pages carry policy data. Pages 4+ (glossary, disclaimers)
  // contain the same labels in different contexts (e.g. "...]-1} X 100\n
  // Annualised P&L (%) This reflects...") and would cause false-positive matches.
  const fullText = pageTexts.slice(0, 3).join('\n');

  // Each field has a list of regex patterns tried in order. Different PDF text
  // extractors reorder Manulife's two-column layout differently — pdfplumber
  // tends to put values above labels, PDF.js often puts values after labels on
  // the same line — so we accept either form.
  const customerName = grabFirst(fullText, [
    /^([A-Z][A-Z ]+[A-Z])\s+Manulife\s*\(Singapore\)/m,
  ]);
  const reportDate = grabFirst(fullText, [
    /Customer Total Policy Holdings\s*\(as of (\d{1,2} \w+ \d{4})\)/,
  ]);
  const policyName = grabFirst(fullText, [
    /(Manulife InvestReady[^\n]+?Flexi\s+\d+)\s+SGD\s+[\d,]+\.\d{2}\s*\n[^\n]*Policy Name/,
    /Policy Name\s+(Manulife InvestReady[^\n]+?Flexi\s+\d+)/,
  ]);
  const policyNumber = grabFirst(fullText, [
    /(\d{6,12})\s+SGD\s+[\d,]+\.\d{2}\s*\n[^\n]*Policy Number/,
    /Policy Number\s+(\d{6,12})/,
  ]);
  const policyIssueDate = grabFirst(fullText, [
    /(\d{2}\/\d{2}\/\d{4})\s+Total Rider Premiums\s*\n\s*Policy Issue Date/,
    /^\s*(\d{2}\/\d{2}\/\d{4})\s*\n\s*Policy Issue Date/m,
    /Policy Issue Date\s+(\d{2}\/\d{2}\/\d{4})/,
  ]);

  const accountValue = grabMoneyFirst(fullText, [
    /SGD\s+([\d,]+\.\d{2})\s*\n[^\n]*Account Value/,
    /Account Value\s+SGD\s+([\d,]+\.\d{2})/,
  ]);
  const policyInvestmentCost = grabMoneyFirst(fullText, [
    /SGD\s+([\d,]+\.\d{2})\s*\n[^\n]*Policy Investment Cost/,
    /Policy Investment Cost\*?\s+SGD\s+([\d,]+\.\d{2})/,
  ]);
  const totalPnlDollar = grabMoneyFirst(fullText, [
    /SGD\s+([\d,]+\.\d{2})\s*\n\s*Total P&L \(\$\)/,
    /Total P&L \(\$\)\s+SGD\s+([\d,]+\.\d{2})/,
  ]);
  const totalRiderPremiums = grabMoneyFirst(fullText, [
    /SGD\s+([\d,]+\.\d{2})\s*\n[^\n]*Total Rider Premiums/,
    /Total Rider Premiums\s+SGD\s+([\d,]+\.\d{2})/,
  ]);
  const totalDividendsReinvested = grabMoneyFirst(fullText, [
    /SGD\s+([\d,]+\.\d{2})\s*\n\s*Total Dividends Reinvested/,
    /Total Dividends Reinvested\s+SGD\s+([\d,]+\.\d{2})/,
  ]);

  const totalPnlPct = parseFloat(grabFirst(fullText, [
    /^([\d.]+)\s*\n\s*Total P&L \(%\)/m,
    /Total P&L \(%\)\s+([\d.]+)/,
  ]) || '0');
  const annualisedPnlPct = parseFloat(grabFirst(fullText, [
    /^([\d.]+)\s*\n\s*Annualised P&L \(%\)/m,
    /Annualised P&L \(%\)\s+([\d.]+)/,
  ]) || '0');

  const riskProfile = grabFirst(fullText, [
    /^(\w+)\s+Total Investment Value\s*\n\s*Risk Profile Questionnaire/m,
    /Risk Profile Questionnaire\s+(\w+)/,
  ]);
  const ckaStatus = grabFirst(fullText, [
    /Customer Knowledge Assessment\s+(\w+)\s+Total Market Value/,
    /Customer Knowledge Assessment\s+(\w+)/,
  ]);
  // Two "(Expiry date: ...)" lines exist (CKA + Risk Profile). The first one
  // after "Customer Knowledge Assessment" is the CKA expiry. Use a non-greedy
  // dotall match — JS regex needs the `s` flag for `.` to match newlines.
  const ckaExpiry = grabFirst(fullText, [
    /Customer Knowledge Assessment[\s\S]*?\(Expiry date:\s+(\d{2}\/\d{2}\/\d{4})\)/,
  ]);

  const required = { customerName, reportDate, policyName, policyNumber, policyIssueDate, riskProfile, ckaStatus, ckaExpiry };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing required fields in PDF: ${missing.join(', ')}`);
  }

  const holdings = parseHoldings(pageItems);
  if (!holdings.length) {
    throw new Error('No fund holdings detected on page 3');
  }

  return {
    customerName, reportDate, policyName, policyNumber, policyIssueDate,
    accountValue, policyInvestmentCost, totalPnlDollar, totalPnlPct, annualisedPnlPct,
    totalRiderPremiums, totalDividendsReinvested,
    riskProfile, ckaStatus, ckaExpiry,
    holdings,
  };
}


// ---------- Text reconstruction ------------------------------------------------

// PDF.js gives us text items with transform matrices. To get pdfplumber-style
// line-based text, we cluster items by y-coordinate and sort within each line by x.
function reconstructText(items) {
  if (!items.length) return '';
  // Each item: { str, transform: [a,b,c,d,tx,ty], width, ... }
  // ty is the baseline y (PDF coord, origin at bottom-left).
  const placed = items.map(it => ({
    str: it.str,
    x: it.transform[4],
    y: it.transform[5],
    h: it.height || it.transform[3] || 10,
  })).filter(it => it.str !== undefined);

  // Group into lines by y-coordinate (within ~ half line height tolerance)
  placed.sort((a, b) => b.y - a.y);  // top to bottom
  const lines = [];
  const tolerance = 3;  // px
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
const NUMERIC_RE = /^[\d,]+\.\d+(?:\s*\d+)?$/;

function parseHoldings(pageItems) {
  // PDF.js gives us word-level items, not pre-grouped cells. We:
  //   1. Cluster items into rows by y-coordinate
  //   2. Walk rows: header rows end with "(TICKER)", data rows have ≥5 numerics
  //   3. For each data row, also pick up wrap-text from the row immediately
  //      below (e.g. "Fixed Income\nRegional" splits across two y-rows)
  //   4. Within the data row, cluster non-numeric words into x-position
  //      "columns" — typically gives 2 columns: asset class + sub-asset class
  for (let p = 2; p < pageItems.length && p < 5; p++) {
    const items = pageItems[p];
    if (!items?.length) continue;
    const rows = clusterIntoRows(items);
    const holdings = extractHoldingsFromRows(rows);
    if (holdings.length) return holdings;
  }
  return [];
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
  return rows;
}

function extractHoldingsFromRows(rows) {
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
      // Look one row down for wrap-text (e.g. NEMD splits "Fixed Income"
      // across data row + "Regional" on the next visual row).
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

      const holding = buildHoldingFromRow(pendingHeader, row, wrapTexts);
      if (holding) out.push(holding);
      pendingHeader = null;
    }
  }
  return out;
}

function buildHoldingFromRow(header, row, wrapTexts) {
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

  // Cluster words into columns by x-proximity (gap > 25px starts a new column).
  // Within asset/sub-asset class words, the largest legitimate within-column
  // gap I've seen is ~23px ("Markets Bond"); the smallest between-column gap
  // is ~27px ("Assets" -> "Multi"). 25 splits cleanly.
  allTexts.sort((a, b) => a.x - b.x);
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

  // Within each cluster, restore reading order: data row first (higher y),
  // wrap row second (lower y); within each row, left-to-right by x.
  const groupTexts = clusters.map(c => {
    c.items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    return cleanupColumnText(c.items.map(it => it.text).join(' '));
  });

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

function cleanupColumnText(s) {
  // PDF.js splits "Mixed/Multi-Assets" into ["Mixed/", "Multi-", "Assets"];
  // when joined with spaces we get "Mixed/ Multi- Assets". Collapse the
  // spaces that follow a hyphen or slash so the canonical form is restored.
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
