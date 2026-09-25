import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatDateTime, formatInr, formatInrPrecise, formatNumber, formatPercent, formatRelativeTime, plural } from './format.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');

// ---- relative / absolute time -----------------------------------------------------------------------------

test('formatRelativeTime buckets recent times as "just now" / minutes / hours / days', () => {
  assert.equal(formatRelativeTime('2026-09-24T11:59:40Z', NOW), 'Just now');
  assert.equal(formatRelativeTime('2026-09-24T11:55:00Z', NOW), '5m ago');
  assert.equal(formatRelativeTime('2026-09-24T09:00:00Z', NOW), '3h ago');
  assert.equal(formatRelativeTime('2026-09-22T12:00:00Z', NOW), '2d ago');
});

test('formatRelativeTime falls back to a full date once older than a week', () => {
  const result = formatRelativeTime('2026-09-01T12:00:00Z', NOW);
  assert.match(result, /Sep/);
  assert.match(result, /2026/);
  assert.doesNotMatch(result, /ago/);
});

test('formatRelativeTime never reports a negative age for a clock-skewed future timestamp', () => {
  assert.equal(formatRelativeTime('2026-09-24T12:05:00Z', NOW), 'Just now');
});

test('formatRelativeTime and formatDateTime show a placeholder for an invalid value, never "Invalid Date" or blank', () => {
  assert.equal(formatRelativeTime('not-a-date', NOW), '—');
  assert.equal(formatDateTime('not-a-date'), '—');
  assert.equal(formatDateTime(undefined), '—');
});

test('formatDateTime includes the day, month, year and a time', () => {
  const result = formatDateTime('2026-09-24T14:32:00Z');
  assert.match(result, /2026/);
  assert.match(result, /Sep/);
  assert.match(result, /\d/); // some time component is present
});

// ---- calendar date -------------------------------------------------------------------------------------------

test('formatDate renders a short, unambiguous day/month/year', () => {
  const result = formatDate('2026-01-05T00:00:00Z');
  assert.match(result, /2026/);
  assert.match(result, /Jan/);
});

test('formatDate shows a placeholder, not "Invalid Date", for bad input', () => {
  assert.equal(formatDate('not-a-date'), '—');
  assert.equal(formatDate(undefined), '—');
});

// ---- currency -----------------------------------------------------------------------------------------------

test('formatInr rounds to the nearest whole rupee with Indian digit grouping', () => {
  assert.equal(formatInr(123456), '₹1,23,456');
  assert.equal(formatInr(999.6), '₹1,000');
  assert.equal(formatInr(0), '₹0');
});

test('formatInrPrecise always shows exactly two decimal places, with the same digit grouping', () => {
  assert.equal(formatInrPrecise(2.5), '₹2.50');
  assert.equal(formatInrPrecise(123456.789), '₹1,23,456.79');
  assert.equal(formatInrPrecise(0), '₹0.00');
});

test('currency formatters show a placeholder rather than "₹NaN" for invalid input', () => {
  assert.equal(formatInr(undefined), '—');
  assert.equal(formatInr(NaN), '—');
  assert.equal(formatInrPrecise(null), '—');
  assert.equal(formatInrPrecise('abc'), '—');
});

// ---- plain quantities -----------------------------------------------------------------------------------------

test('formatNumber rounds a long decimal to at most one decimal place, with digit grouping', () => {
  assert.equal(formatNumber(123.456789), '123.5');
  assert.equal(formatNumber(1234.5), '1,234.5');
  assert.equal(formatNumber(0), '0');
});

test('formatNumber shows a placeholder for invalid input, never "NaN"', () => {
  assert.equal(formatNumber(undefined), '—');
  assert.equal(formatNumber('abc'), '—');
});

// ---- percentages -----------------------------------------------------------------------------------------------

test('formatPercent formats a value that is already a percentage (0-100 scale), never re-multiplying it', () => {
  assert.equal(formatPercent(82.5), '82.5%');
  assert.equal(formatPercent(0), '0.0%');
  assert.equal(formatPercent(-12.3), '-12.3%');
});

test('formatPercent supports a custom digit count', () => {
  assert.equal(formatPercent(82.5, 0), '83%');
  assert.equal(formatPercent(1.2345, 2), '1.23%');
});

test('formatPercent shows a placeholder for invalid input, never "NaN%"', () => {
  assert.equal(formatPercent(undefined), '—');
  assert.equal(formatPercent(null), '—');
});

// ---- pluralisation -----------------------------------------------------------------------------------------

test('plural picks the singular for exactly 1 and the plural otherwise', () => {
  assert.equal(plural(1, 'kitchen'), 'kitchen');
  assert.equal(plural(0, 'kitchen'), 'kitchens');
  assert.equal(plural(2, 'kitchen'), 'kitchens');
});

test('plural accepts an irregular plural form', () => {
  assert.equal(plural(1, 'child', 'children'), 'child');
  assert.equal(plural(3, 'child', 'children'), 'children');
});
