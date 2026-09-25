import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFile, buildResultView, MAX_FILE_BYTES, MIN_FILE_BYTES } from './foodQualityView.js';

test('validateFile rejects when no file is chosen', () => {
  const result = validateFile(null);
  assert.equal(result.ok, false);
  assert.match(result.message, /choose an image/i);
});

test('validateFile rejects an unsupported mime type', () => {
  const result = validateFile({ type: 'image/gif', size: 5000 });
  assert.equal(result.ok, false);
  assert.match(result.message, /unsupported file type/i);
});

test('validateFile rejects a file below the minimum size', () => {
  const result = validateFile({ type: 'image/png', size: MIN_FILE_BYTES - 1 });
  assert.equal(result.ok, false);
  assert.match(result.message, /empty or corrupted/i);
});

test('validateFile rejects a file over the maximum size', () => {
  const result = validateFile({ type: 'image/jpeg', size: MAX_FILE_BYTES + 1 });
  assert.equal(result.ok, false);
  assert.match(result.message, /too large/i);
});

test('validateFile accepts a well-formed jpeg/png/webp within bounds', () => {
  assert.equal(validateFile({ type: 'image/jpeg', size: 5000 }).ok, true);
  assert.equal(validateFile({ type: 'image/png', size: 5000 }).ok, true);
  assert.equal(validateFile({ type: 'image/webp', size: 5000 }).ok, true);
});

test('validateFile accepts a file exactly at each boundary', () => {
  assert.equal(validateFile({ type: 'image/png', size: MIN_FILE_BYTES }).ok, true);
  assert.equal(validateFile({ type: 'image/png', size: MAX_FILE_BYTES }).ok, true);
});

test('buildResultView returns null when there is no data yet', () => {
  assert.equal(buildResultView(null), null);
  assert.equal(buildResultView(undefined), null);
});

test('buildResultView maps every documented classification to a label and badge', () => {
  ['FRESH', 'USE_SOON', 'QUESTIONABLE', 'UNKNOWN'].forEach((classification) => {
    const view = buildResultView({ classification, confidence: 0.5, signals: ['a signal'], recommendation: 'do X', disclaimer: 'd' });
    assert.equal(typeof view.classificationLabel, 'string');
    assert.ok(view.classificationLabel.length > 0);
    assert.match(view.badgeClass, /^badge-/);
  });
});

test('buildResultView flags UNKNOWN distinctly from the other classifications', () => {
  const unknown = buildResultView({ classification: 'UNKNOWN', confidence: 0.2, signals: [], recommendation: '', disclaimer: '' });
  const fresh = buildResultView({ classification: 'FRESH', confidence: 0.8, signals: [], recommendation: '', disclaimer: '' });
  assert.equal(unknown.isUnknown, true);
  assert.equal(fresh.isUnknown, false);
});

test('buildResultView converts confidence to a whole-number percent, never fabricating one if absent', () => {
  assert.equal(buildResultView({ classification: 'FRESH', confidence: 0.837, signals: [], recommendation: '', disclaimer: '' }).confidencePercent, 84);
  assert.equal(buildResultView({ classification: 'FRESH', confidence: undefined, signals: [], recommendation: '', disclaimer: '' }).confidencePercent, null);
});

test('buildResultView passes through signals, recommendation, disclaimer and optional context untouched', () => {
  const view = buildResultView({
    classification: 'USE_SOON',
    confidence: 0.6,
    signals: ['slight discoloration', 'edges look dry'],
    recommendation: 'Use today; inspect manually before serving.',
    disclaimer: 'This is only a visual screening aid.',
    context: { dailyLogId: 4, menuItemName: 'Rice', logDate: '2026-09-24' },
  });
  assert.deepEqual(view.signals, ['slight discoloration', 'edges look dry']);
  assert.equal(view.recommendation, 'Use today; inspect manually before serving.');
  assert.equal(view.disclaimer, 'This is only a visual screening aid.');
  assert.deepEqual(view.context, { dailyLogId: 4, menuItemName: 'Rice', logDate: '2026-09-24' });
});

test('buildResultView defaults signals to an empty array if missing, never throwing', () => {
  const view = buildResultView({ classification: 'FRESH', confidence: 0.5 });
  assert.deepEqual(view.signals, []);
  assert.equal(view.context, null);
});
