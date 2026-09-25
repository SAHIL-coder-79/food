// Formatting helpers used by the dashboard. The generic ones (currency, quantities, percentages, calendar dates,
// pluralisation) are app-wide concerns and live in ../format.js; they are re-exported here so every existing
// import of './format' in this folder keeps working unchanged. Only the dashboard-specific date-arithmetic and
// "time remaining" helpers are defined here.
export { formatInr, formatInrPrecise, formatNumber, formatPercent, formatDate, plural } from '../format.js';

const pad = (n) => String(n).padStart(2, '0');

// Local calendar date as YYYY-MM-DD (the same "today" the kitchen's daily logs use).
export function dateString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return dateString(new Date(y, m - 1, d + days));
}

// "2 h 5 min", "45 min", "expired"
export function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  if (minutes <= 0) return 'expired';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function minutesUntil(isoTime, now = Date.now()) {
  const t = new Date(isoTime).getTime();
  return Number.isNaN(t) ? null : Math.round((t - now) / 60000);
}
