// App-wide formatting helpers (currency, quantities, percentages, dates). Framework-free and pure, so they are
// unit-tested directly (format.test.js) the same way dashboard/metrics.js is. Every function is defensive against
// missing/invalid input - never throwing, never rendering "NaN" or "Invalid Date" - so a page never has to guard
// against that itself before calling one of these.

const inrWhole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inrPrecise = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numberOneDecimal = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });

const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null; // Number(null) is 0 - never treat "no value" as zero
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Whole rupees, for large aggregate figures (estimated loss, savings, ...). Rounds to the nearest rupee.
export function formatInr(value) {
  const n = toFiniteNumber(value);
  return n === null ? '—' : `₹${inrWhole.format(Math.round(n))}`;
}

// Rupees and paise, for small per-unit figures (cost per serving/kg/piece, ...). Never rounds away the paise.
export function formatInrPrecise(value) {
  const n = toFiniteNumber(value);
  return n === null ? '—' : `₹${inrPrecise.format(n)}`;
}

// A plain quantity (servings, kg, pieces, meals, ...), grouped and rounded to at most one decimal place - never a
// long raw float such as "123.456789".
export function formatNumber(value) {
  const n = toFiniteNumber(value);
  return n === null ? '—' : numberOneDecimal.format(n);
}

// A percentage the caller already has on a 0-100 scale (this never multiplies by 100 itself, so a value that is
// already a percentage is never re-converted).
export function formatPercent(value, digits = 1) {
  const n = toFiniteNumber(value);
  return n === null ? '—' : `${n.toFixed(digits)}%`;
}

export function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "Just now" / "5m ago" / "3h ago" / "2d ago", falling back to a full date once it's more than a week old.
export function formatRelativeTime(value, now = Date.now()) {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return '—';
  const diffMs = Math.max(0, now - t);
  const minute = 60000;
  const hour = 3600000;
  const day = 86400000;
  if (diffMs < minute) return 'Just now';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return formatDateTime(value);
}

// "1 kitchen" / "2 kitchens"
export const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
