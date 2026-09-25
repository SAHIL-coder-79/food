import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreventionView } from './preventionView.js';

// A representative real response from POST /api/prevention/evaluate (backend/src/ai/prevention.js).
const HIGH_RISK_RESULT = {
  predictedQuantity: 124.9,
  plannedQuantity: 198,
  excess: 73.1,
  riskLevel: 'HIGH',
  recommendedQuantity: 124.9,
  expectedRange: { low: 104.6, high: 133.4, coverage: 0.8, basis: 'demand_before_safety_buffer', safetyBufferPct: 5, note: "Approximate range from the model's own error, not a guarantee." },
  plannedVsExpectedRange: 'above_range',
  confidence: 0.75,
  confidenceType: 'heuristic_reliability_score',
  evidence: { reason: 'stub' },
  recommendationId: 1,
};

test('exposes predicted demand, planned quantity, excess and risk level exactly as the backend returned them', () => {
  const view = buildPreventionView(HIGH_RISK_RESULT);
  assert.equal(view.predictedQuantity, 124.9);
  assert.equal(view.plannedQuantity, 198);
  assert.equal(view.excess, 73.1);
  assert.equal(view.riskLevel, 'HIGH');
  assert.equal(view.riskBadgeClass, 'badge-danger');
  assert.equal(view.recommendedQuantity, 124.9);
});

test('renders the expected range using the backend-provided low/high/coverage, not a manufactured one', () => {
  const view = buildPreventionView(HIGH_RISK_RESULT);
  assert.deepEqual(view.range, { low: 104.6, high: 133.4, coveragePercent: 80, note: HIGH_RISK_RESULT.expectedRange.note });
});

test('maps plannedVsExpectedRange to a label and badge for each backend value', () => {
  assert.deepEqual(buildPreventionView({ ...HIGH_RISK_RESULT, plannedVsExpectedRange: 'above_range' }).rangePosition, { label: 'Above the expected range', badgeClass: 'badge-warning' });
  assert.deepEqual(buildPreventionView({ ...HIGH_RISK_RESULT, plannedVsExpectedRange: 'within_range' }).rangePosition, { label: 'Within the expected range', badgeClass: 'badge-success' });
  assert.deepEqual(buildPreventionView({ ...HIGH_RISK_RESULT, plannedVsExpectedRange: 'below_range' }).rangePosition, { label: 'Below the expected range', badgeClass: 'badge-info' });
});

test('has no range or range position when the backend returns none (short-history fallback forecast)', () => {
  const view = buildPreventionView({ ...HIGH_RISK_RESULT, expectedRange: null, plannedVsExpectedRange: null });
  assert.equal(view.range, null);
  assert.equal(view.rangePosition, null);
});

test('never invents a range position for an unrecognised backend value', () => {
  const view = buildPreventionView({ ...HIGH_RISK_RESULT, plannedVsExpectedRange: 'sideways' });
  assert.equal(view.rangePosition, null);
});

test('confidence is converted to a whole percentage and flagged as an uncalibrated heuristic', () => {
  const view = buildPreventionView(HIGH_RISK_RESULT);
  assert.equal(view.confidencePercent, 75); // 0.75 -> 75%, never 0.75%, and never re-multiplied
  assert.equal(view.confidenceIsHeuristic, true);
});

test('does not claim a heuristic score for an unrecognised confidenceType', () => {
  const view = buildPreventionView({ ...HIGH_RISK_RESULT, confidenceType: undefined });
  assert.equal(view.confidenceIsHeuristic, false);
  assert.equal(view.confidencePercent, 75); // the percentage itself is unaffected
});

test('a LOW risk result maps to the success badge, and MEDIUM to the warning badge', () => {
  assert.equal(buildPreventionView({ ...HIGH_RISK_RESULT, riskLevel: 'LOW' }).riskBadgeClass, 'badge-success');
  assert.equal(buildPreventionView({ ...HIGH_RISK_RESULT, riskLevel: 'MEDIUM' }).riskBadgeClass, 'badge-warning');
});
