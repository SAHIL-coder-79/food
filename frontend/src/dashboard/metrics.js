// Derivations for the dashboard cards. Every function takes API responses and returns numbers computed from them:
// nothing here (or in the components) is a demo value. When the data is not enough to say something honestly, a
// function returns a state such as 'insufficient' so the card can explain what is missing instead of showing a number.

const DAY_MS = 86400000;

// A listing counts as urgent when it has this many minutes (or fewer) left before its estimated safe-until time.
export const URGENT_MINUTES = 120;

// ---- waste reduction ------------------------------------------------------------------------------------------

// Compares the share of prepared food left over in two equally long periods (waste attribution `totals`).
// A rate, not a quantity, so busier and quieter weeks compare fairly.
export function wasteChange(current, previous) {
  const now = current && current.totals;
  const before = previous && previous.totals;
  if (!now || !before || !now.logCount || !before.logCount || now.wastePercentage === null || before.wastePercentage === null) {
    return { state: 'insufficient', reason: !now || !now.logCount ? 'no logs in the latest period' : 'no logs in the previous period' };
  }
  const rateNow = now.wastePercentage;
  const ratePrevious = before.wastePercentage;
  if (ratePrevious === 0) {
    return { state: 'ready', rateNow, ratePrevious, changePct: null, direction: rateNow === 0 ? 'flat' : 'up' };
  }
  const changePct = ((rateNow - ratePrevious) / ratePrevious) * 100;
  const direction = Math.abs(changePct) < 1 ? 'flat' : changePct < 0 ? 'down' : 'up';
  return { state: 'ready', rateNow, ratePrevious, changePct, direction };
}

// ---- financial loss avoided -----------------------------------------------------------------------------------

// For approved prevention recommendations whose day has an actual log: how much less was prepared than the
// ORIGINAL plan, valued at the menu item's own ingredient + preparation cost. It is an estimate of preparation
// avoided against the plan (it does not prove the recommendation was the reason).
export function estimateLossAvoided(interventionItems, menuItems) {
  const costById = new Map((menuItems || []).map((m) => [m.id, Number(m.cost_per_unit || 0) + Number(m.preparation_cost_per_unit || 0)]));
  let counted = 0;
  let totalUnits = 0;
  let totalValue = 0;
  let withoutCost = 0;
  (interventionItems || []).forEach((item) => {
    const prepared = item.actual && item.actual.preparedQuantity;
    if (item.managerAction !== 'approved' || prepared === null || prepared === undefined || item.originalPlannedQuantity === null || item.originalPlannedQuantity === undefined) return;
    const avoided = Math.max(0, item.originalPlannedQuantity - prepared);
    const unitCost = costById.get(item.menuItemId);
    counted += 1;
    totalUnits += avoided;
    if (!unitCost) withoutCost += 1;
    else totalValue += avoided * unitCost;
  });
  return { counted, totalUnits, totalValue, withoutCost };
}

// ---- rescue: own listings -------------------------------------------------------------------------------------

export function rescueOpportunities(listings, now = Date.now()) {
  const open = (listings || []).filter((l) => l.status === 'Available' && new Date(l.safe_until_time).getTime() > now);
  const minutes = open.map((l) => Math.round((new Date(l.safe_until_time).getTime() - now) / 60000));
  return {
    count: open.length,
    quantity: open.reduce((sum, l) => sum + Number(l.quantity || 0), 0),
    soonestMinutes: minutes.length ? Math.min(...minutes) : null,
    urgentCount: minutes.filter((m) => m <= URGENT_MINUTES).length,
  };
}

// Where the kitchen's recent listings stand in the rescue pipeline, with the NGO names the API provides.
export function rescuePipeline(listings, ngos, { now = Date.now(), windowDays = 30 } = {}) {
  const ngoName = new Map((ngos || []).map((n) => [n.id, n.name]));
  const recent = (listings || []).filter((l) => now - new Date(l.created_at).getTime() <= windowDays * DAY_MS);
  const count = (status) => recent.filter((l) => l.status === status).length;
  const collected = recent.filter((l) => l.status === 'Collected');
  return {
    total: recent.length,
    available: count('Available'),
    claimed: count('Claimed'),
    collected: collected.length,
    expired: count('Expired'),
    collectedQuantity: collected.reduce((sum, l) => sum + Number(l.quantity || 0), 0),
    awaitingConfirmation: recent
      .filter((l) => l.status === 'Claimed' && !l.confirmed_pickup_time)
      .map((l) => ({ id: l.id, food: l.food_type, quantity: Number(l.quantity), ngo: ngoName.get(l.claimed_by_ngo_id) || 'An NGO' })),
    awaitingCollection: recent
      .filter((l) => l.status === 'Claimed' && l.confirmed_pickup_time)
      .map((l) => ({ id: l.id, food: l.food_type, quantity: Number(l.quantity), ngo: ngoName.get(l.claimed_by_ngo_id) || 'An NGO' })),
  };
}

// ---- high-risk food -------------------------------------------------------------------------------------------

const RISK_ORDER = { HIGH: 0, MEDIUM: 1 };

// Two real signals: menu items that keep being over-prepared (waste attribution patterns), and listed food whose
// estimated spoilage risk is raised (spoilage assessment of each available listing).
export function highRiskFood(patterns, spoilage) {
  const overPrepared = ((patterns && patterns.recurringOverPreparation) || []).map((p) => ({
    kind: 'over_preparation',
    key: `prep-${p.menuItemId}`,
    title: p.menuItemName,
    detail: `over-prepared in ${p.overPreparedLogCount} of its last ${p.recentLogCount} logs${p.averageWastePercentage !== null ? `, about ${p.averageWastePercentage}% left over` : ''}`,
    level: 'MEDIUM',
  }));
  const spoiling = (spoilage || [])
    .filter((s) => s.assessment && Object.prototype.hasOwnProperty.call(RISK_ORDER, s.assessment.riskLevel))
    .map((s) => ({
      kind: 'spoilage',
      key: `spoil-${s.listing.id}`,
      title: s.listing.food_type,
      detail: `${s.assessment.riskLevel.toLowerCase()} spoilage risk, ${s.assessment.minutesRemaining} min left on the estimated safe window`,
      level: s.assessment.riskLevel,
    }));
  return [...spoiling, ...overPrepared].sort((a, b) => (RISK_ORDER[a.level] ?? 2) - (RISK_ORDER[b.level] ?? 2));
}

// ---- NGO / admin ----------------------------------------------------------------------------------------------

export function priorityBreakdown(listings) {
  const list = listings || [];
  const by = (level) => list.filter((l) => l.priorityLevel === level).length;
  return { total: list.length, critical: by('CRITICAL'), high: by('HIGH'), medium: by('MEDIUM'), low: by('LOW'), top: list.slice(0, 3) };
}

export function feedSummary(listings, now = Date.now()) {
  const list = listings || [];
  const distances = list.map((l) => l.distance_km).filter((d) => d !== null && d !== undefined);
  const minutes = list.map((l) => Math.round((new Date(l.safe_until_time).getTime() - now) / 60000));
  return {
    count: list.length,
    quantity: list.reduce((sum, l) => sum + Number(l.quantity || 0), 0),
    nearestKm: distances.length ? Math.min(...distances) : null,
    soonestMinutes: minutes.length ? Math.min(...minutes) : null,
  };
}

export function notificationActivity(notifications) {
  const list = notifications || [];
  const count = (type) => list.filter((n) => n.type === type).length;
  return {
    total: list.length,
    unread: list.filter((n) => !n.is_read).length,
    newSurplus: count('SURPLUS_POSTED'),
    pickupsConfirmed: count('PICKUP_CONFIRMED'),
    collections: count('LISTING_COLLECTED'),
    claims: count('LISTING_CLAIMED'),
  };
}

export function organizationCounts(organizations) {
  const list = organizations || [];
  const ngos = list.filter((o) => o.type === 'ngo');
  return {
    total: list.length,
    kitchens: list.filter((o) => o.type === 'kitchen').length,
    ngos: ngos.length,
    verifiedNgos: ngos.filter((o) => o.verification_status === 'verified').length,
    pendingNgos: ngos.filter((o) => o.verification_status === 'pending').length,
    rejectedNgos: ngos.filter((o) => o.verification_status === 'rejected').length,
  };
}
