// Mirrors src/naming.py.

export function buildFilename(customerName, policyNumber, reportDate) {
  const client = titleCaseName(customerName);
  const dateStr = (reportDate || '').trim();
  const raw = `${client} - Investment Snapshot - ${policyNumber} - ${dateStr}.png`;
  return sanitizeFilename(raw);
}

export function titleCaseName(name) {
  return (name || '').trim().split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function sanitizeFilename(name) {
  return (name || '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
