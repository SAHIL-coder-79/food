// Pure view-model builder for the Prevention page's "evaluate risk" result — the exact data contract
// backend/src/ai/prevention.js returns from POST /api/prevention/evaluate (predictedQuantity, plannedQuantity,
// excess, riskLevel, expectedRange, plannedVsExpectedRange, confidence, confidenceType). Framework-free, so it is
// unit-tested the same way dashboard/metrics.js and notifications/notificationState.js already are. It only
// reshapes backend-provided values for display - it never computes a range, a risk level or a confidence score
// itself.

const RISK_BADGE = { HIGH: 'badge-danger', MEDIUM: 'badge-warning', LOW: 'badge-success' };

const RANGE_POSITION = {
  above_range: { label: 'Above the expected range', badgeClass: 'badge-warning' },
  within_range: { label: 'Within the expected range', badgeClass: 'badge-success' },
  below_range: { label: 'Below the expected range', badgeClass: 'badge-info' },
};

export function buildPreventionView(result) {
  const range = result.expectedRange
    ? {
        low: result.expectedRange.low,
        high: result.expectedRange.high,
        coveragePercent: Math.round(result.expectedRange.coverage * 100),
        note: result.expectedRange.note,
      }
    : null;

  return {
    predictedQuantity: result.predictedQuantity,
    plannedQuantity: result.plannedQuantity,
    excess: result.excess,
    recommendedQuantity: result.recommendedQuantity,
    riskLevel: result.riskLevel,
    riskBadgeClass: RISK_BADGE[result.riskLevel] || 'badge-neutral',
    confidencePercent: Number.isFinite(result.confidence) ? Math.round(result.confidence * 100) : null,
    confidenceIsHeuristic: result.confidenceType === 'heuristic_reliability_score',
    range,
    rangePosition: RANGE_POSITION[result.plannedVsExpectedRange] || null,
  };
}
