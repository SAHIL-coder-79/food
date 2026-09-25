'use strict';

/**
 * Context-aware statistical demand forecasting engine (pure: no I/O, no clock, no randomness).
 *
 * This is a statistical method, NOT machine learning. Given daily-log rows for one menu item and a
 * target date it produces:
 *
 *   demand estimate  = level (recency-weighted mean, half-life 14 days)
 *                      x weekday seasonal index (shrunk toward 1, needs >= 2 same-weekday days)
 *                      x trend multiplier (weighted least squares, significance-gated, capped 0.8-1.2)
 *   attendance est.  = per-person demand x expected headcount (needs >= 6 days with headcount)
 *   central estimate = inverse-variance blend of the two
 *   predictedQuantity = central estimate x 1.05 safety buffer
 *
 * Only observations dated strictly BEFORE the target date are used (leakage guard), and identical
 * inputs (in any row order) always give identical output.
 */

const MODEL_VERSION = 'stat_context_v2';
const FALLBACK_MODEL_VERSION = 'heuristic_fallback_v1';
const CONFIDENCE_TYPE = 'heuristic_reliability_score';

const CONSTANTS = Object.freeze({
    MIN_OBSERVATIONS: 3,
    MAX_OBSERVATIONS: 120,
    HALF_LIFE_DAYS: 14,
    WEEKDAY_SHRINKAGE: 2,
    WEEKDAY_MIN_OBSERVATIONS: 1,
    WEEKDAY_INDEX_MIN: 0.5,
    WEEKDAY_INDEX_MAX: 1.5,
    MIN_TREND_POINTS: 6,
    MIN_TREND_SPAN_DAYS: 5,
    MIN_TREND_EFFECTIVE_N: 4,
    TREND_T_FLOOR: 1,
    TREND_T_FULL: 2.5,
    TREND_MULTIPLIER_MIN: 0.8,
    TREND_MULTIPLIER_MAX: 1.2,
    MIN_ATTENDANCE_POINTS: 6,
    ATTENDANCE_WEIGHT_MIN: 0.1,
    ATTENDANCE_WEIGHT_MAX: 0.9,
    ATTENDANCE_WEIGHT_MAX_WEAK_EVIDENCE: 0.4,
    ATTENDANCE_MIN_HEADCOUNT_CV: 0.05,
    SAFETY_BUFFER: 0.05,
    RANGE_Z_80: 1.2816,
    MIN_RELATIVE_ERROR: 0.02,
    CONFIDENCE_FLOOR: 0.35,
    CONFIDENCE_SPAN: 0.6,
    FALLBACK_CONFIDENCE: 0.3,
    // Event context (optional): pseudo-observations pulling a learned event effect toward its declared/neutral prior.
    EVENT_PRIOR_STRENGTH: 2,
    EVENT_MIN_LEARNED_DAYS: 3,
    EVENT_FACTOR_MAX: 3,
    EVENT_RATIO_MAX: 5,
    // Sold-out (censored) demand. A day with nothing left over only tells us demand was AT LEAST what was consumed.
    SOLD_OUT_CONSUMED_TOLERANCE: 0.98, // a logged consumption below 98% of prepared means food is unaccounted for: not a clean sell-out
    CENSOR_MIN_INFORMATIVE_DAYS: 5, // days WITH leftover needed to believe that "no leftover" means "sold out", not "planned exactly"
    CENSOR_MAX_SOLD_OUT_SHARE: 0.5, // above this the normal days are too unrepresentative to estimate what sold-out days wanted
    CENSOR_MAX_UPLIFT: 0.25, // a single sold-out day is never lifted by more than 25% of what was actually consumed
    CENSOR_UNADJUSTED_SIGMA: 0.15, // extra relative uncertainty per unit share of sold-out days that could not be corrected
});

// Kinds of organization calendar events (kept in sync with the organization_events CHECK constraint).
const EVENT_TYPES = Object.freeze(['holiday', 'festival', 'exam', 'institutional_event', 'special_meal', 'closure']);

// How much the event adjustment is trusted, by evidence: relative uncertainty added to the forecast range and a
// confidence multiplier. 'learned' uncertainty is computed from the spread of the past ratios instead.
const EVENT_EVIDENCE = Object.freeze({
    learned: { sigma: null, quality: 1 },
    limited_history: { sigma: 0.15, quality: 0.95 },
    declared: { sigma: 0.25, quality: 0.9 },
    none: { sigma: 0.3, quality: 0.9 },
});

const C = CONSTANTS;
const DAY_MS = 86400000;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------------------------------------------------------------------------
// Small numeric / date helpers
// ---------------------------------------------------------------------------

function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    const r = Math.round(value * factor) / factor;
    return r === 0 ? 0 : r; // normalise -0
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function sum(values) {
    let total = 0;
    for (const v of values) total += v;
    return total;
}

// Order-independent mean (sorted before summing so float results never depend on row order).
function meanSorted(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sum(sorted) / sorted.length;
}

function weightedMean(values, weights) {
    let total = 0;
    let weightTotal = 0;
    for (let i = 0; i < values.length; i += 1) {
        total += values[i] * weights[i];
        weightTotal += weights[i];
    }
    return weightTotal > 0 ? total / weightTotal : 0;
}

function weightedCorrelation(a, b, weights) {
    const meanA = weightedMean(a, weights);
    const meanB = weightedMean(b, weights);
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let i = 0; i < a.length; i += 1) {
        saa += weights[i] * (a[i] - meanA) ** 2;
        sbb += weights[i] * (b[i] - meanB) ** 2;
        sab += weights[i] * (a[i] - meanA) * (b[i] - meanB);
    }
    if (saa <= 0 || sbb <= 0) return null;
    return sab / Math.sqrt(saa * sbb);
}

// Calendar days since 1970-01-01 for a 'YYYY-MM-DD' (or ISO datetime) string / Date; null if invalid.
// Timezone independent: only the calendar date is used.
function toDayNumber(value) {
    let year;
    let month;
    let day;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        year = value.getFullYear();
        month = value.getMonth() + 1;
        day = value.getDate();
    } else if (typeof value === 'string') {
        const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
        if (!match) return null;
        year = Number(match[1]);
        month = Number(match[2]);
        day = Number(match[3]);
    } else {
        return null;
    }
    const ms = Date.UTC(year, month - 1, day);
    const check = new Date(ms);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
        return null;
    }
    return ms / DAY_MS;
}

function dayNumberToDate(dayNumber) {
    return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(dayNumber) {
    return (((dayNumber + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
}

// Returns a normalised 'YYYY-MM-DD' string, or null when the value is not a real calendar date.
function normalizeTargetDate(value) {
    if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(value.trim())) return null;
    const day = toDayNumber(value);
    return day === null ? null : dayNumberToDate(day);
}

// ---------------------------------------------------------------------------
// Observation extraction (leakage guard lives here)
// ---------------------------------------------------------------------------

function demandOf(row) {
    const logged = num(row.quantity_consumed);
    let value = logged !== null ? logged : num(row.consumed);
    if (value === null) {
        const prepared = num(row.quantity_prepared);
        if (prepared !== null) value = prepared - (num(row.quantity_leftover) ?? 0);
    }
    return value !== null && value >= 0 ? value : null;
}

// A clean sell-out: food was prepared, none was left, and every prepared unit is accounted for as consumed.
// (A logged consumption clearly below the prepared quantity means the rest was wasted or mis-logged, so demand
// was not necessarily cut short.)
function isSoldOut(row, prepared, leftover) {
    if (prepared === null || !(prepared > 0) || leftover === null || leftover !== 0) return false;
    const logged = num(row.quantity_consumed);
    return logged === null || logged >= prepared * C.SOLD_OUT_CONSUMED_TOLERANCE;
}

function extractObservations(rows, targetDay) {
    const stats = { rowsReceived: 0, invalidRows: 0, futureRowsExcluded: 0, usableRows: 0, preparedValues: [], demandValues: [] };
    const byDay = new Map();

    for (const row of Array.isArray(rows) ? rows : []) {
        stats.rowsReceived += 1;
        if (!row || typeof row !== 'object') {
            stats.invalidRows += 1;
            continue;
        }
        const day = toDayNumber(row.log_date);
        if (day === null) {
            stats.invalidRows += 1;
            continue;
        }
        // Leakage guard: nothing dated on or after the target date may influence the forecast.
        if (day >= targetDay) {
            stats.futureRowsExcluded += 1;
            continue;
        }
        const demand = demandOf(row);
        if (demand === null) {
            stats.invalidRows += 1;
            continue;
        }

        stats.usableRows += 1;
        stats.demandValues.push(demand);
        const prepared = num(row.quantity_prepared);
        if (prepared !== null && prepared >= 0) stats.preparedValues.push(prepared);
        const leftover = num(row.quantity_leftover);
        const planned = num(row.quantity_planned);
        const headcount = num(row.headcount);

        let entry = byDay.get(day);
        if (!entry) {
            entry = { day, demands: [], headcounts: [], stockout: false, soldOutLogs: 0, withLeftoverLogs: 0, logs: 0, plannedSum: 0, plannedDemandSum: 0 };
            byDay.set(day, entry);
        }
        entry.logs += 1;
        entry.demands.push(demand);
        if (headcount !== null && headcount > 0) entry.headcounts.push(headcount);
        // 'stockout' (any log with prepared food and no leftover) is the long-standing data-quality signal. A CLEAN
        // sell-out is stricter and is the only thing the sold-out correction acts on.
        if (prepared !== null && prepared > 0 && leftover !== null && leftover === 0) entry.stockout = true;
        if (isSoldOut(row, prepared, leftover)) entry.soldOutLogs += 1;
        if (prepared !== null && prepared > 0 && leftover !== null && leftover > 0) entry.withLeftoverLogs += 1;
        if (planned !== null && planned > 0) {
            entry.plannedSum += planned;
            entry.plannedDemandSum += demand;
        }
    }

    const observations = [...byDay.values()]
        .sort((a, b) => a.day - b.day)
        .map((entry) => ({
            day: entry.day,
            y: meanSorted(entry.demands), // one value per day: multiple meal-slot logs are averaged (per-serving demand)
            h: entry.headcounts.length ? meanSorted(entry.headcounts) : null,
            stockout: entry.stockout,
            soldOut: entry.soldOutLogs > 0, // at least one meal-slot log was a clean sell-out
            soldOutShare: entry.soldOutLogs / entry.logs, // share of that day's meal-slot logs that sold out
            hasLeftoverEvidence: !entry.stockout && entry.withLeftoverLogs > 0, // a normal day whose leftover was recorded > 0
            logs: entry.logs,
            plannedSum: entry.plannedSum,
            plannedDemandSum: entry.plannedDemandSum,
        }))
        .slice(-C.MAX_OBSERVATIONS);

    return { observations, stats };
}

// ---------------------------------------------------------------------------
// Series estimator: level x weekday index x significance-gated trend
// ---------------------------------------------------------------------------

function estimateSeries(points, targetDay) {
    const n = points.length;
    const values = points.map((p) => p.value);
    // Recency weights only matter relatively (every use normalises them), so for an extremely distant target date
    // shift all ages by a common amount: otherwise 0.5 ** (age / 14) underflows to exactly 0 for every observation
    // (after ~40 years) and the whole forecast silently collapses to 0. Zero shift for any realistic horizon.
    const ageShift = Math.max(0, Math.min(...points.map((p) => targetDay - p.day)) - 100 * C.HALF_LIFE_DAYS);
    const weights = points.map((p) => 0.5 ** ((targetDay - p.day - ageShift) / C.HALF_LIFE_DAYS));
    const weightTotal = sum(weights);
    const neff = (weightTotal * weightTotal) / sum(weights.map((w) => w * w));
    const overall = weightedMean(values, weights);
    const targetWeekday = weekdayOf(targetDay);

    let rawSpread = 0;
    for (let i = 0; i < n; i += 1) rawSpread += weights[i] * (values[i] - overall) ** 2;
    const rawCv = overall > 0 ? Math.sqrt(rawSpread / weightTotal) / overall : 0;

    // Weekday seasonal indices, shrunk toward 1; only "active" with >= 2 observations of that weekday.
    const counts = new Array(7).fill(0);
    const index = new Array(7).fill(1);
    const active = new Array(7).fill(false);
    const rawMeans = new Array(7).fill(null);
    points.forEach((p) => {
        counts[weekdayOf(p.day)] += 1;
    });
    for (let wd = 0; wd < 7; wd += 1) {
        if (counts[wd] === 0) continue;
        const subsetValues = [];
        const subsetWeights = [];
        points.forEach((p, i) => {
            if (weekdayOf(p.day) === wd) {
                subsetValues.push(values[i]);
                subsetWeights.push(weights[i]);
            }
        });
        rawMeans[wd] = weightedMean(subsetValues, subsetWeights);
        if (overall > 0 && counts[wd] >= C.WEEKDAY_MIN_OBSERVATIONS) {
            const raw = rawMeans[wd] / overall;
            const shrunk = (counts[wd] * raw + C.WEEKDAY_SHRINKAGE) / (counts[wd] + C.WEEKDAY_SHRINKAGE);
            index[wd] = clamp(shrunk, C.WEEKDAY_INDEX_MIN, C.WEEKDAY_INDEX_MAX);
            active[wd] = true;
        }
    }

    // De-seasonalise, then fit a recency-weighted line through the de-seasonalised values.
    const z = points.map((p, i) => values[i] / index[weekdayOf(p.day)]);
    const x = points.map((p) => p.day - targetDay); // negative: days before the target
    const zbar = weightedMean(z, weights);
    const xbar = weightedMean(x, weights);
    const span = points[n - 1].day - points[0].day;

    let slope = 0;
    let t = 0;
    let lambda = 0;
    const eligible = n >= C.MIN_TREND_POINTS && span >= C.MIN_TREND_SPAN_DAYS && neff >= C.MIN_TREND_EFFECTIVE_N;
    if (eligible) {
        let sxx = 0;
        let sxz = 0;
        for (let i = 0; i < n; i += 1) {
            sxx += weights[i] * (x[i] - xbar) ** 2;
            sxz += weights[i] * (x[i] - xbar) * (z[i] - zbar);
        }
        if (sxx > 0) {
            slope = sxz / sxx;
            let ssRes = 0;
            for (let i = 0; i < n; i += 1) {
                ssRes += weights[i] * (z[i] - zbar - slope * (x[i] - xbar)) ** 2;
            }
            const sigma2 = (ssRes / weightTotal) * (neff / (neff - 2));
            const se = Math.sqrt(sigma2 / (neff * (sxx / weightTotal)));
            if (se > 0) t = slope / se;
            else t = slope === 0 ? 0 : Math.sign(slope) * Infinity;
            lambda = clamp((Math.abs(t) - C.TREND_T_FLOOR) / (C.TREND_T_FULL - C.TREND_T_FLOOR), 0, 1);
        }
    }

    let trendMultiplier = 1;
    if (zbar > 0 && lambda > 0) {
        const adjusted = zbar + lambda * slope * (0 - xbar);
        trendMultiplier = clamp(adjusted / zbar, C.TREND_MULTIPLIER_MIN, C.TREND_MULTIPLIER_MAX);
    }
    const deseasonalForecast = zbar * trendMultiplier;

    // Residual dispersion around the model actually used (level + weekday indices + gated trend),
    // corrected for the effective degrees of freedom those fitted terms consumed (in-sample
    // residuals otherwise understate out-of-sample error).
    let ssModel = 0;
    for (let i = 0; i < n; i += 1) {
        ssModel += weights[i] * (z[i] - (zbar + lambda * slope * (x[i] - xbar))) ** 2;
    }
    let dfUsed = 1 + lambda;
    for (let wd = 0; wd < 7; wd += 1) {
        if (active[wd]) dfUsed += counts[wd] / (counts[wd] + C.WEEKDAY_SHRINKAGE);
    }
    const sigmaZ = Math.sqrt((ssModel / weightTotal) * (neff / Math.max(neff - dfUsed, 1)));
    const relSigma = zbar > 0 ? sigmaZ / zbar : 0;

    return {
        n,
        neff,
        weightedMean: overall,
        rawCv,
        residualDf: Math.max(neff - dfUsed, 1),
        level: zbar,
        forecast: deseasonalForecast * index[targetWeekday],
        relSigma,
        weekday: {
            index: index[targetWeekday],
            observations: counts[targetWeekday],
            active: active[targetWeekday],
            weightedMean: rawMeans[targetWeekday],
        },
        trend: {
            slopePerDay: slope,
            slopePct: zbar > 0 ? slope / zbar : 0,
            t,
            lambda,
            multiplier: trendMultiplier,
            eligible,
        },
        weights,
        // The fitted baseline (level x trend x weekday index) for any calendar day; used to measure how far
        // event days deviated from a normal day.
        fitAt: (day) => Math.max(0, zbar + lambda * slope * (day - targetDay - xbar)) * index[weekdayOf(day)],
    };
}

// ---------------------------------------------------------------------------
// Event context: organization calendar events (optional)
// ---------------------------------------------------------------------------

function toTimeMs(value) {
    if (value === null || value === undefined || value === '') return NaN;
    return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

// Normalises the events an organization has recorded into those a forecast for targetDay may use:
//   - dated on or before the target date (later events are irrelevant);
//   - known by the end of the target day: an event entered AFTER the target date could have been added
//     because of what happened, so it is never used to (re)build that day's forecast.
// Sorted and de-duplicated, so the result never depends on input order.
function prepareEvents(events, targetDay) {
    const seen = new Set();
    const known = [];
    (Array.isArray(events) ? events : []).forEach((raw) => {
        if (!raw || typeof raw !== 'object') return;
        const day = toDayNumber(raw.event_date ?? raw.date);
        const type = raw.event_type ?? raw.type;
        if (day === null || day > targetDay || typeof type !== 'string' || type === '') return;
        const createdMs = toTimeMs(raw.created_at ?? raw.createdAt);
        if (!Number.isNaN(createdMs) && createdMs >= (targetDay + 1) * DAY_MS) return;
        const name = String(raw.name ?? '').trim();
        const key = `${day}|${type}|${name}`;
        if (seen.has(key)) return;
        seen.add(key);
        known.push({ day, type, name, impactPct: num(raw.expected_impact_pct ?? raw.expectedImpactPct) });
    });
    return known.sort((a, b) => a.day - b.day || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// A day's "signature" is the sorted set of event types that could change demand (impact 0 = informational only).
function signatureOf(events) {
    return [...new Set(events.filter((e) => e.impactPct !== 0).map((e) => e.type))].sort().join('+');
}

// Product of the declared impacts on a day; null when none of its events declared one.
function declaredFactorOf(events) {
    const declared = events.filter((e) => e.impactPct !== null && e.impactPct !== 0);
    if (declared.length === 0) return null;
    return declared.reduce((product, e) => product * clamp(1 + e.impactPct / 100, 0, C.EVENT_FACTOR_MAX), 1);
}

/**
 * How demand on the target date is expected to differ from a normal day because of its event(s).
 * Learned from past days with the same event signature (ratio of actual demand to the baseline fitted on
 * NON-event days), shrunk toward the declared expected impact (or neutral when none was declared).
 */
function computeEventAdjustment({ targetEvents, excludedEventObs, pastEventDays, demand }) {
    const signature = signatureOf(targetEvents);
    const declared = declaredFactorOf(targetEvents);
    const ratios = [];
    excludedEventObs.forEach((obs) => {
        if (signatureOf(pastEventDays.get(obs.day)) !== signature) return;
        const fit = demand.fitAt(obs.day);
        if (!(fit > 0)) return;
        ratios.push(clamp(obs.y / fit, 0, C.EVENT_RATIO_MAX));
    });

    const k = ratios.length;
    const ratioSum = sum(ratios);
    const m = C.EVENT_PRIOR_STRENGTH;
    let factor;
    let evidence;
    if (declared !== null) {
        factor = (ratioSum + m * declared) / (k + m);
        evidence = k >= C.EVENT_MIN_LEARNED_DAYS ? 'learned' : k > 0 ? 'limited_history' : 'declared';
    } else if (k >= C.EVENT_MIN_LEARNED_DAYS) {
        factor = ratioSum / k;
        evidence = 'learned';
    } else if (k > 0) {
        factor = (ratioSum + m) / (k + m);
        evidence = 'limited_history';
    } else {
        factor = 1;
        evidence = 'none';
    }
    factor = clamp(factor, 0, C.EVENT_FACTOR_MAX);

    let sigma = EVENT_EVIDENCE[evidence].sigma;
    if (sigma === null) {
        const meanRatio = ratioSum / k;
        const spread = Math.sqrt(sum(ratios.map((r) => (r - meanRatio) ** 2)) / k);
        sigma = Math.max(0.05, spread / Math.sqrt(k));
    }
    return {
        factor,
        evidence,
        signature,
        declaredFactor: declared,
        learnedFactor: k > 0 ? ratioSum / k : null,
        learnedFromDays: k,
        sigma,
        quality: EVENT_EVIDENCE[evidence].quality,
    };
}

function describeEventAdjustment(adjustment, factorText) {
    const declaredText = adjustment.declaredFactor === null ? '' : `, blended with the expected x${round(adjustment.declaredFactor, 2)}`;
    switch (adjustment.evidence) {
        case 'learned':
            return `${adjustment.learnedFromDays} similar past day(s) ran about x${round(adjustment.learnedFactor, 2)} of a normal day${declaredText}; applied x${factorText}.`;
        case 'limited_history':
            return `Only ${adjustment.learnedFromDays} similar past day(s), so the adjustment leans on ${adjustment.declaredFactor === null ? 'a neutral prior' : 'the expected impact'}; applied x${factorText}.`;
        case 'declared':
            return `No similar past days, so the expected impact was applied (x${factorText}).`;
        default:
            return 'No similar past days and no expected impact was given, so no adjustment was made (the event is noted only).';
    }
}

// ---------------------------------------------------------------------------
// Sold-out (censored) demand
// ---------------------------------------------------------------------------

// Complementary error function (Numerical Recipes erfcc, relative error < 1.2e-7 for every x, including the tails).
function erfc(x) {
    const z = Math.abs(x);
    const t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
        + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
}

// Hazard of the standard normal at a: pdf(a) / P(Z > a), i.e. E[Z | Z > a].
function normalHazard(a) {
    const z = clamp(a, -30, 30);
    return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI) / (0.5 * erfc(z / Math.SQRT2));
}

/**
 * A day that sold out only shows that demand was AT LEAST what was consumed, so treating the consumed quantity
 * as the full demand systematically under-forecasts. This lifts each sold-out day to the demand expected GIVEN it
 * reached at least what was consumed (a one-sided truncated-normal mean around what a normal day looks like).
 *
 * Deliberately conservative:
 *   - only when sold-out days can be told apart from exact planning (enough normal days that DID record leftover);
 *   - only when sold-out days are a minority (otherwise the normal days are not representative);
 *   - the "normal" level is fitted on the non-sold-out days only, so a sold-out day can never lift itself;
 *   - a day is never lowered, and never lifted by more than CENSOR_MAX_UPLIFT of what was consumed;
 *   - on multi-slot days the lift is scaled by the share of slots that actually sold out.
 * Uses only the observations it is given (already limited to days before the target date).
 */
function adjustSoldOutDemand(observations, targetDay) {
    const soldOut = observations.filter((o) => o.soldOut);
    const base = {
        soldOutDays: soldOut.length,
        // No leftover but food unaccounted for (logged consumption well below prepared): not a clean sell-out, left as recorded.
        unconfirmedDays: observations.filter((o) => o.stockout && !o.soldOut).length,
        adjustedDays: 0,
        status: 'none_detected',
        reason: null,
    };
    if (soldOut.length === 0) return { observations, info: base };

    const normal = observations.filter((o) => !o.stockout);
    const withLeftover = normal.filter((o) => o.hasLeftoverEvidence).length;
    let reason = null;
    if (withLeftover < C.CENSOR_MIN_INFORMATIVE_DAYS) {
        reason = `Only ${withLeftover} normal day(s) recorded leftover food (${C.CENSOR_MIN_INFORMATIVE_DAYS} needed), so a day with no leftover cannot be told apart from exact planning.`;
    } else if (soldOut.length / observations.length > C.CENSOR_MAX_SOLD_OUT_SHARE) {
        reason = `${soldOut.length} of ${observations.length} days sold out, too many to estimate what they would have needed from the remaining days.`;
    }
    if (reason) return { observations, info: { ...base, status: 'not_adjusted', reason } };

    const baseline = estimateSeries(normal.map((o) => ({ day: o.day, value: o.y })), targetDay);
    const sigmaRelative = Math.max(baseline.relSigma, C.MIN_RELATIVE_ERROR);
    let adjustedDays = 0;
    const adjusted = observations.map((o) => {
        if (!o.soldOut || !(o.y > 0)) return o;
        const fit = baseline.fitAt(o.day);
        if (!(fit > 0)) return o;
        const sigma = sigmaRelative * fit;
        const expected = fit + sigma * normalHazard((o.y - fit) / sigma);
        const lift = Math.min(Math.max(expected - o.y, 0), o.y * C.CENSOR_MAX_UPLIFT) * o.soldOutShare;
        if (!(lift > 0)) return o;
        adjustedDays += 1;
        return { ...o, y: o.y + lift, yObserved: o.y };
    });
    if (adjustedDays === 0) {
        return { observations, info: { ...base, status: 'not_adjusted', reason: 'The normal days give no positive demand level to correct toward.' } };
    }
    return { observations: adjusted, info: { ...base, status: 'adjusted', adjustedDays } };
}

// ---------------------------------------------------------------------------
// Attendance signal: per-person demand x expected headcount
// ---------------------------------------------------------------------------

function estimateAttendance(observations, targetDay, expectedHeadcount, demandEstimate) {
    const withHeadcount = observations.filter((o) => o.h !== null && o.h > 0);
    if (withHeadcount.length < C.MIN_ATTENDANCE_POINTS) {
        return {
            used: false,
            headcountObservations: withHeadcount.length,
            reason: `Not enough attendance history (${withHeadcount.length} of the required ${C.MIN_ATTENDANCE_POINTS} days have a headcount)`,
            providedIgnored: expectedHeadcount !== null,
        };
    }

    const headcountEstimate = estimateSeries(withHeadcount.map((o) => ({ day: o.day, value: o.h })), targetDay);
    const perPersonEstimate = estimateSeries(withHeadcount.map((o) => ({ day: o.day, value: o.y / o.h })), targetDay);

    const provided = expectedHeadcount !== null;
    const headcountForTarget = provided ? expectedHeadcount : headcountEstimate.forecast;
    const attendanceForecast = perPersonEstimate.forecast * headcountForTarget;
    if (!Number.isFinite(attendanceForecast) || attendanceForecast < 0) {
        return { used: false, headcountObservations: withHeadcount.length, reason: 'Attendance estimate was not usable', providedIgnored: provided };
    }

    // Relative error of each estimator; a known (provided) headcount carries no headcount uncertainty.
    const sigmaDemand = Math.max(demandEstimate.relSigma, C.MIN_RELATIVE_ERROR);
    const sigmaPerPerson = Math.max(perPersonEstimate.relSigma, C.MIN_RELATIVE_ERROR);
    const sigmaHeadcount = provided ? 0 : Math.max(headcountEstimate.relSigma, C.MIN_RELATIVE_ERROR);
    const varianceDemand = sigmaDemand ** 2;
    const varianceAttendance = sigmaPerPerson ** 2 + sigmaHeadcount ** 2;

    const strongEvidence = headcountEstimate.rawCv >= C.ATTENDANCE_MIN_HEADCOUNT_CV;
    const maxWeight = strongEvidence ? C.ATTENDANCE_WEIGHT_MAX : C.ATTENDANCE_WEIGHT_MAX_WEAK_EVIDENCE;
    const weight = clamp(varianceDemand / (varianceDemand + varianceAttendance), C.ATTENDANCE_WEIGHT_MIN, maxWeight);

    const headcounts = withHeadcount.map((o) => o.h);
    const correlation = weightedCorrelation(
        withHeadcount.map((o) => o.y),
        headcounts,
        headcountEstimate.weights
    );

    return {
        used: true,
        forecast: attendanceForecast,
        weight,
        sigma: Math.sqrt(varianceAttendance),
        expectedHeadcount: headcountForTarget,
        source: provided ? 'provided' : 'historical_weekday_pattern',
        perPerson: perPersonEstimate.forecast,
        correlation,
        evidence: strongEvidence ? 'strong' : 'weak',
        headcountObservations: withHeadcount.length,
        outsideObservedRange: provided && (headcountForTarget < Math.min(...headcounts) || headcountForTarget > Math.max(...headcounts)),
    };
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

function computeConfidence({ neff, relativeError, gapDays, stockoutFraction, invalidFraction, outsideObservedRange, eventQuality = 1 }) {
    const dataVolume = Math.min(1, neff / 20);
    const stability = Math.exp(-relativeError / 0.25);
    const recency = 1 / (1 + Math.max(0, gapDays - 3) / 14);
    let dataQuality = 1 - 0.5 * stockoutFraction - 0.5 * invalidFraction;
    if (outsideObservedRange) dataQuality *= 0.85;
    dataQuality *= eventQuality; // 1 unless an event on the target date makes the estimate less certain
    dataQuality = clamp(dataQuality, 0, 1);

    const quality = dataVolume * stability * recency * dataQuality;
    const score = clamp(C.CONFIDENCE_FLOOR + C.CONFIDENCE_SPAN * quality, C.CONFIDENCE_FLOOR, C.CONFIDENCE_FLOOR + C.CONFIDENCE_SPAN);
    return {
        score: round(score, 2),
        components: {
            data_volume: round(dataVolume, 2),
            stability: round(stability, 2),
            recency: round(recency, 2),
            data_quality: round(dataQuality, 2),
        },
    };
}

// ---------------------------------------------------------------------------
// Public: fallback + main forecast
// ---------------------------------------------------------------------------

function leakageGuard(targetDate, stats) {
    return {
        cutoff: `only observations dated before ${targetDate} are used`,
        future_rows_excluded: stats.futureRowsExcluded,
    };
}

function describeTargetEvents(targetEvents) {
    return targetEvents.map((e) => ({ type: e.type, name: e.name, expected_impact_pct: e.impactPct }));
}

function buildFallback(targetDate, observationCount, stats, targetEvents = []) {
    const source = stats.preparedValues.length > 0 ? stats.preparedValues : stats.demandValues;
    const average = source.length > 0 ? sum(source) / source.length : 0;
    const keyFactors = {
        reason: 'Insufficient historical data',
        data_points: stats.usableRows,
        detail: `Only ${observationCount} usable day(s) of history before ${targetDate}; at least ${C.MIN_OBSERVATIONS} are needed for the context-aware model, so the average prepared quantity is returned.`,
        method: 'average_prepared_quantity',
        minimum_observations: C.MIN_OBSERVATIONS,
        data_quality: { rows_received: stats.rowsReceived, invalid_rows_ignored: stats.invalidRows },
        forecast_confidence: {
            score: C.FALLBACK_CONFIDENCE,
            type: CONFIDENCE_TYPE,
            calibrated: false,
            note: 'Fixed low score used while there is too little history for the context-aware model - not a probability, and no expected range is available.',
        },
        leakage_guard: leakageGuard(targetDate, stats),
    };
    if (targetEvents.length > 0) {
        keyFactors.event_context = {
            target_events: describeTargetEvents(targetEvents),
            applied: false,
            note: 'The target date has an event, but there is not enough history to apply event context.',
        };
    }
    return {
        predictedQuantity: round(average, 1),
        confidenceScore: C.FALLBACK_CONFIDENCE,
        modelVersion: FALLBACK_MODEL_VERSION,
        keyFactors,
    };
}

function describeWeekday(estimate, weekdayName) {
    if (estimate.weekday.active) {
        const pct = Math.round(Math.abs(estimate.weekday.index - 1) * 100);
        if (pct === 0) return `${weekdayName} demand is in line with the weekly average`;
        return `${weekdayName}s run ${pct}% ${estimate.weekday.index > 1 ? 'above' : 'below'} the weekly average`;
    }
    return `not enough ${weekdayName} history (${estimate.weekday.observations} day(s)) for a weekday adjustment`;
}

function buildForecast(rows, targetDate, options = {}) {
    const target = normalizeTargetDate(targetDate);
    if (!target) {
        throw new Error('Invalid targetDate: expected a real calendar date in YYYY-MM-DD format');
    }
    const targetDay = toDayNumber(target);
    const { observations: allObservations, stats } = extractObservations(rows, targetDay);

    // Optional organization events. With none that are relevant, everything below is exactly the plain model.
    const knownEvents = prepareEvents(options && options.events, targetDay);
    const targetEvents = knownEvents.filter((e) => e.day === targetDay);
    const impactfulTargetEvents = targetEvents.filter((e) => e.impactPct !== 0);
    const pastEventDays = new Map();
    knownEvents
        .filter((e) => e.day < targetDay && e.impactPct !== 0)
        .forEach((e) => {
            if (!pastEventDays.has(e.day)) pastEventDays.set(e.day, []);
            pastEventDays.get(e.day).push(e);
        });

    // Event days are not "normal" days: keep them out of the baseline (level/weekday/trend/attendance) so they do
    // not distort forecasts for ordinary days - unless that would leave too little baseline history.
    let observations = allObservations;
    let excludedEventObs = [];
    let exclusionSkipped = false;
    const eventObs = allObservations.filter((o) => pastEventDays.has(o.day));
    if (eventObs.length > 0) {
        const baseline = allObservations.filter((o) => !pastEventDays.has(o.day));
        if (baseline.length >= C.MIN_OBSERVATIONS) {
            observations = baseline;
            excludedEventObs = eventObs;
        } else {
            exclusionSkipped = true;
        }
    }

    if (observations.length < C.MIN_OBSERVATIONS) {
        return buildFallback(target, observations.length, stats, targetEvents);
    }

    const providedHeadcount = num(options && options.expectedHeadcount);
    const expectedHeadcount = providedHeadcount !== null && providedHeadcount > 0 ? providedHeadcount : null;

    // Sold-out days only show demand was AT LEAST what was consumed: correct for that when the evidence allows it.
    const soldOutCorrection = options && options.adjustForSoldOut === false
        ? {
            observations,
            info: {
                soldOutDays: observations.filter((o) => o.soldOut).length,
                unconfirmedDays: observations.filter((o) => o.stockout && !o.soldOut).length,
                adjustedDays: 0,
                status: observations.some((o) => o.soldOut) ? 'not_adjusted' : 'none_detected',
                reason: 'Sold-out correction was switched off.',
            },
        }
        : adjustSoldOutDemand(observations, targetDay);
    const observedObservations = observations;
    observations = soldOutCorrection.observations;
    const censoring = soldOutCorrection.info;

    const demand = estimateSeries(observations.map((o) => ({ day: o.day, value: o.y })), targetDay);
    const attendance = estimateAttendance(observations, targetDay, expectedHeadcount, demand);

    const demandForecast = demand.forecast;
    const baselineCentral = attendance.used
        ? (1 - attendance.weight) * demandForecast + attendance.weight * attendance.forecast
        : demandForecast;

    // Event adjustment for the target date (only when its event(s) can change demand).
    const eventAdjustment = impactfulTargetEvents.length > 0
        ? computeEventAdjustment({ targetEvents: impactfulTargetEvents, excludedEventObs, pastEventDays, demand })
        : null;
    let central = baselineCentral;
    let eventAppliedTo = null;
    if (eventAdjustment && eventAdjustment.factor !== 1) {
        if (attendance.used && attendance.source === 'provided') {
            // A headcount supplied for the day already reflects the event's attendance effect: apply the event
            // factor to the demand-history part only, to avoid counting it twice.
            central = (1 - attendance.weight) * demandForecast * eventAdjustment.factor + attendance.weight * attendance.forecast;
            eventAppliedTo = 'demand_estimate_only';
        } else {
            central = baselineCentral * eventAdjustment.factor;
            eventAppliedTo = 'full_estimate';
        }
    }
    const predicted = central * (1 + C.SAFETY_BUFFER);

    const sigmaDemand = Math.max(demand.relSigma, C.MIN_RELATIVE_ERROR);
    const sigmaBlend = attendance.used
        ? (1 - attendance.weight) * sigmaDemand + attendance.weight * Math.max(attendance.sigma, C.MIN_RELATIVE_ERROR)
        : sigmaDemand;
    let relativeError = sigmaBlend * Math.sqrt(1 + 1 / demand.neff);
    if (eventAdjustment) relativeError = Math.sqrt(relativeError ** 2 + eventAdjustment.sigma ** 2);

    // Sold-out days add uncertainty: corrected ones by how much was imputed, uncorrected ones because demand on
    // them is known to be under-recorded (the more of the recent history they make up, the wider the range).
    let censorSigma = 0;
    let censorLiftPct = 0;
    if (censoring.status === 'adjusted' && censoring.adjustedDays > 0) {
        const lifts = observations.map((o) => o.y - (o.yObserved ?? o.y));
        if (demand.weightedMean > 0) censorSigma = Math.sqrt(weightedMean(lifts.map((l) => l * l), demand.weights)) / demand.weightedMean;
        const observedMean = weightedMean(observedObservations.map((o) => o.y), demand.weights);
        if (observedMean > 0) censorLiftPct = (demand.weightedMean / observedMean - 1) * 100;
    } else if (censoring.status === 'not_adjusted') {
        censorSigma = C.CENSOR_UNADJUSTED_SIGMA * weightedMean(observations.map((o) => (o.soldOut ? 1 : 0)), demand.weights);
    }
    if (censorSigma > 0) relativeError = Math.sqrt(relativeError ** 2 + censorSigma ** 2);
    // Student-t style widening (Cornish-Fisher) so short histories get honestly wider ranges.
    const z = C.RANGE_Z_80;
    const rangeQuantile = z + (z ** 3 + z) / (4 * demand.residualDf);
    const halfWidth = rangeQuantile * relativeError * central;

    const lastDay = observations[observations.length - 1].day;
    const firstDay = observations[0].day;
    const gapDays = targetDay - lastDay;
    const stockoutDays = observations.filter((o) => o.stockout).length;
    const multiLogDays = observations.filter((o) => o.logs > 1).length;
    const validRows = stats.usableRows;
    const confidence = computeConfidence({
        neff: demand.neff,
        relativeError,
        gapDays,
        stockoutFraction: stockoutDays / observations.length,
        invalidFraction: stats.invalidRows / Math.max(validRows + stats.invalidRows, 1),
        outsideObservedRange: Boolean(attendance.used && attendance.outsideObservedRange),
        eventQuality: eventAdjustment ? eventAdjustment.quality : 1,
    });

    const targetWeekdayName = WEEKDAY_NAMES[weekdayOf(targetDay)];
    const trendApplied = demand.trend.lambda > 0 && demand.trend.multiplier !== 1;
    const trendDirection = trendApplied ? (demand.trend.multiplier > 1 ? 'rising' : 'falling') : 'flat';

    const plannedTotal = sum(observations.map((o) => o.plannedSum));
    const plannedDemandTotal = sum(observations.map((o) => o.plannedDemandSum));

    const reasonParts = [
        `Based on ${observations.length} day(s) of history (${dayNumberToDate(firstDay)} to ${dayNumberToDate(lastDay)}).`,
        `Recency-weighted demand is ${round(demand.weightedMean, 1)} per day; ${describeWeekday(demand, targetWeekdayName)}.`,
        trendApplied
            ? `Demand is ${trendDirection} (${round(demand.trend.slopePct * 100, 2)}% per day), trend multiplier x${round(demand.trend.multiplier, 2)}.`
            : 'No statistically clear trend, so none is applied.',
    ];
    if (attendance.used) {
        reasonParts.push(
            `Attendance signal (${attendance.source === 'provided' ? 'expected' : 'typical'} headcount ${round(attendance.expectedHeadcount, 0)}, ${round(attendance.perPerson, 2)} per person) carries ${Math.round(attendance.weight * 100)}% weight.`
        );
    } else if (attendance.providedIgnored) {
        reasonParts.push(`The expected headcount was not used: ${attendance.reason}.`);
    }

    if (censoring.status === 'adjusted' && censoring.adjustedDays > 0) {
        reasonParts.push(
            `${censoring.adjustedDays} sold-out day(s) were treated as a lower bound on demand (nothing was left over), raising recency-weighted demand by ${round(censorLiftPct, 1)}%.`
        );
    } else if (censoring.status === 'not_adjusted') {
        reasonParts.push(`${censoring.soldOutDays} sold-out day(s) could not be corrected: ${censoring.reason} Demand may be understated, so the range is widened.`);
    }

    const eventContextRelevant = targetEvents.length > 0 || excludedEventObs.length > 0 || exclusionSkipped;
    if (targetEvents.length > 0) {
        reasonParts.push(`The target date has ${targetEvents.length} event(s): ${targetEvents.map((e) => `${e.name || e.type} (${e.type})`).join(', ')}.`);
        if (eventAdjustment) {
            reasonParts.push(describeEventAdjustment(eventAdjustment, round(eventAdjustment.factor, 2)));
            if (eventAppliedTo === 'demand_estimate_only') {
                reasonParts.push('Because an expected headcount was provided, the event factor was applied to the demand-history part only.');
            }
        } else {
            reasonParts.push('The event(s) are marked as having no expected impact, so no adjustment was made.');
        }
    }
    if (excludedEventObs.length > 0) {
        reasonParts.push(`${excludedEventObs.length} past event day(s) were left out of the baseline so they do not distort normal days.`);
    } else if (exclusionSkipped) {
        reasonParts.push('Past event days were kept in the baseline because too few normal days would remain without them.');
    }
    reasonParts.push(`Central estimate ${round(central, 1)}; ${round(predicted, 1)} including the 5% safety buffer.`);

    const keyFactors = {
        // Legacy keys (same meaning as stat_weighted_ma_v1) kept for API/evidence compatibility.
        recent_avg: round(demand.weightedMean, 1),
        weekday_avg: round(demand.weekday.weightedMean ?? demand.weightedMean, 1),
        trend_multiplier: round(demand.trend.multiplier, 2),
        safety_buffer: '5%',
        data_points_used: observations.length,

        reason: reasonParts.join(' '),
        method: 'Statistical: recency-weighted level x weekday index x gated weighted-regression trend, blended with an attendance-based per-person estimate. Not machine learning.',
        central_estimate: round(central, 1),
        expected_range: {
            low: round(Math.max(0, central - halfWidth), 1),
            high: round(central + halfWidth, 1),
            coverage: 0.8,
            basis: 'demand_before_safety_buffer', // predictedQuantity = central estimate x 1.05; this range excludes that buffer
            note: censoring.status === 'not_adjusted'
                ? 'Approximate 80% range for demand (before the safety buffer), widened because sold-out days could not be corrected.'
                : 'Approximate 80% range for demand (before the safety buffer).',
        },
        demand_censoring: {
            status: censoring.status,
            sold_out_days: censoring.soldOutDays,
            unconfirmed_zero_leftover_days: censoring.unconfirmedDays,
            adjusted_days: censoring.adjustedDays,
            demand_lift_pct: round(censorLiftPct, 1),
            reason: censoring.reason,
            note: 'A day with no leftover only shows demand was at least what was consumed. When enough normal days recorded leftover, such days are lifted (capped) toward the demand they likely had; otherwise they are left as recorded and the range is widened.',
        },
        signals: {
            historical_demand: {
                value: round(demand.weightedMean, 1),
                observations: observations.length,
                effective_observations: round(demand.neff, 1),
                half_life_days: C.HALF_LIFE_DAYS,
            },
            weekday: {
                weekday: targetWeekdayName,
                index: round(demand.weekday.index, 3),
                observations: demand.weekday.observations,
                active: demand.weekday.active,
                weekday_mean: demand.weekday.weightedMean === null ? null : round(demand.weekday.weightedMean, 1),
            },
            attendance: attendance.used
                ? {
                    used: true,
                    expected_headcount: round(attendance.expectedHeadcount, 1),
                    expected_headcount_source: attendance.source,
                    per_person_demand: round(attendance.perPerson, 3),
                    attendance_weight: round(attendance.weight, 2),
                    demand_headcount_correlation: attendance.correlation === null ? null : round(attendance.correlation, 2),
                    evidence: attendance.evidence,
                    headcount_observations: attendance.headcountObservations,
                    outside_observed_range: attendance.outsideObservedRange,
                }
                : {
                    used: false,
                    headcount_observations: attendance.headcountObservations,
                    reason: attendance.reason,
                },
            trend: {
                direction: trendDirection,
                applied: trendApplied,
                multiplier: round(demand.trend.multiplier, 2),
                slope_pct_per_day: round(demand.trend.slopePct * 100, 2),
                significance_t: Number.isFinite(demand.trend.t) ? round(demand.trend.t, 2) : null,
                eligible: demand.trend.eligible,
            },
        },
        forecast_confidence: {
            score: confidence.score,
            components: confidence.components,
            type: CONFIDENCE_TYPE,
            calibrated: false,
            note: 'Heuristic reliability score from data volume, stability, recency and data quality - not a calibrated probability.',
        },
        history: {
            first_date: dayNumberToDate(firstDay),
            last_date: dayNumberToDate(lastDay),
            span_days: lastDay - firstDay,
            days_since_last_observation: gapDays,
        },
        data_quality: {
            rows_received: stats.rowsReceived,
            invalid_rows_ignored: stats.invalidRows,
            stockout_days: stockoutDays,
            multi_log_days_averaged: multiLogDays,
            plan_vs_demand_ratio: plannedDemandTotal > 0 ? round(plannedTotal / plannedDemandTotal, 2) : null,
        },
        leakage_guard: leakageGuard(target, stats),
    };

    if (eventContextRelevant) {
        keyFactors.event_context = {
            target_events: describeTargetEvents(targetEvents),
            applied: Boolean(eventAdjustment && eventAdjustment.factor !== 1),
            history_event_days_excluded: excludedEventObs.length,
            exclusion_skipped_insufficient_baseline: exclusionSkipped,
            adjustment: eventAdjustment
                ? {
                    factor: round(eventAdjustment.factor, 3),
                    effect_pct: round((eventAdjustment.factor - 1) * 100, 1),
                    evidence: eventAdjustment.evidence,
                    event_signature: eventAdjustment.signature,
                    declared_factor: eventAdjustment.declaredFactor === null ? null : round(eventAdjustment.declaredFactor, 3),
                    learned_factor: eventAdjustment.learnedFactor === null ? null : round(eventAdjustment.learnedFactor, 3),
                    learned_from_days: eventAdjustment.learnedFromDays,
                    baseline_estimate: round(baselineCentral, 1),
                    applied_to: eventAppliedTo,
                }
                : null,
        };
    }

    return {
        predictedQuantity: round(predicted, 1),
        confidenceScore: confidence.score,
        modelVersion: MODEL_VERSION,
        keyFactors,
    };
}

// ---------------------------------------------------------------------------
// Baseline: the previous stat_weighted_ma_v1 / heuristic_fallback_v1 algorithm, ported unchanged
// (pure, and given the same leakage-free rows) so new vs old can be compared like-for-like.
// ---------------------------------------------------------------------------

function computeLegacyForecast(rows, targetDate) {
    const target = normalizeTargetDate(targetDate);
    if (!target) throw new Error('Invalid targetDate');
    const targetDay = toDayNumber(target);

    const logs = (Array.isArray(rows) ? rows : [])
        .map((row) => ({
            day: toDayNumber(row && row.log_date),
            prepared: num(row && row.quantity_prepared),
            consumed: num(row && row.consumed),
        }))
        .filter((log) => log.day !== null && log.day < targetDay)
        .sort((a, b) => b.day - a.day)
        .slice(0, 30);

    if (logs.length < 3) {
        const fallback = logs.length > 0 ? logs.reduce((s, log) => s + (log.prepared || 0), 0) / logs.length : 0;
        return {
            predictedQuantity: Math.round(fallback * 10) / 10,
            confidenceScore: 0.3,
            modelVersion: FALLBACK_MODEL_VERSION,
            keyFactors: { reason: 'Insufficient historical data', data_points: logs.length },
        };
    }

    const consumedOf = (log) => log.consumed || 0;
    const recentLogs = logs.slice(0, 5);
    const recentAvg = recentLogs.reduce((s, log) => s + consumedOf(log), 0) / recentLogs.length;

    const targetWeekday = weekdayOf(targetDay);
    const weekdayLogs = logs.filter((log) => weekdayOf(log.day) === targetWeekday);
    let weekdayAvg = recentAvg;
    if (weekdayLogs.length > 0) {
        weekdayAvg = weekdayLogs.reduce((s, log) => s + consumedOf(log), 0) / weekdayLogs.length;
    }

    let trendMultiplier = 1.0;
    if (logs.length >= 6) {
        const current3 = logs.slice(0, 3).reduce((s, log) => s + consumedOf(log), 0) / 3;
        const previous3 = logs.slice(3, 6).reduce((s, log) => s + consumedOf(log), 0) / 3;
        if (previous3 > 0) {
            const ratio = current3 / previous3;
            if (ratio > 1.2) trendMultiplier = 1.2;
            else if (ratio < 0.8) trendMultiplier = 0.8;
            else trendMultiplier = ratio;
        }
    }

    const predicted = (recentAvg * 0.4 + weekdayAvg * 0.6) * trendMultiplier * 1.05;
    const confidence = Math.min(0.95, 0.4 + logs.length * 0.01 + weekdayLogs.length * 0.02);
    return {
        predictedQuantity: Math.round(predicted * 10) / 10,
        confidenceScore: Math.round(confidence * 100) / 100,
        modelVersion: 'stat_weighted_ma_v1',
        keyFactors: {
            recent_avg: Math.round(recentAvg * 10) / 10,
            weekday_avg: Math.round(weekdayAvg * 10) / 10,
            trend_multiplier: Math.round(trendMultiplier * 100) / 100,
            safety_buffer: '5%',
            data_points_used: logs.length,
        },
    };
}

/**
 * The expected demand range of a forecast, in one clear shape for API consumers (forecast endpoint, prevention).
 * Numbers are demand BEFORE the 5% safety buffer that predictedQuantity includes; null for the fallback forecast,
 * which has no range. It is an approximate range from the model's own error, not a guarantee.
 */
function expectedRangeOf(forecast) {
    const range = forecast && forecast.keyFactors && forecast.keyFactors.expected_range;
    if (!range || !Number.isFinite(range.low) || !Number.isFinite(range.high)) return null;
    return {
        low: range.low,
        high: range.high,
        coverage: range.coverage,
        basis: 'demand_before_safety_buffer',
        safetyBufferPct: C.SAFETY_BUFFER * 100,
        note: 'Approximate range from the model\'s own error, not a guarantee. predictedQuantity is the central estimate plus the safety buffer.',
    };
}

module.exports = {
    MODEL_VERSION,
    FALLBACK_MODEL_VERSION,
    CONFIDENCE_TYPE,
    CONSTANTS,
    EVENT_TYPES,
    buildForecast,
    expectedRangeOf,
    computeLegacyForecast,
    normalizeTargetDate,
};
