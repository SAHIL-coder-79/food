'use strict';

const dailyLogModel = require('../models/dailyLogModel');
const AppError = require('../utils/AppError');

// Waste attribution: explains WHERE an organization's recorded waste comes from, using only its own
// daily_logs / menu_items. Pure calculation + deterministic rule-based insights (no LLM, no
// randomness, no clock), so identical logs always give identical output.

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first

const TOP_N = 5;
const MAX_INSIGHTS = 5;
const OVER_PREPARATION_RATIO = 0.1; // a log is "over-prepared" when >= 10% of what was prepared was left over
const RECENT_LOG_WINDOW = 5;
const MIN_LOGS_FOR_PATTERN = 3;
const RECURRING_SHARE = 0.6; // over-prepared in >= 60% of the recent window
const MIN_LOGS_FOR_HOTSPOT = 2;
const HIGH_WASTE_RATE_PCT = 20;
const MIN_LOGS_FOR_RATE_INSIGHT = 3;

function round(value, decimals) {
    const factor = 10 ** decimals;
    const r = Math.round(value * factor) / factor;
    return r === 0 ? 0 : r;
}

function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

const fmt = (value) => String(round(value, 2));
const slotLabel = (slot) => slot.toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function normaliseRow(row) {
    const date = String(row.log_date).slice(0, 10);
    const [year, month, day] = date.split('-').map(Number);
    const prepared = Math.max(0, toNumber(row.quantity_prepared) ?? 0);
    const leftover = Math.max(0, toNumber(row.quantity_leftover) ?? 0);
    const loggedConsumed = toNumber(row.quantity_consumed);
    return {
        date,
        weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(), // calendar date only: timezone independent
        slot: String(row.meal_slot),
        itemId: row.menu_item_id,
        itemName: row.menu_item_name,
        unit: row.menu_item_unit,
        prepared,
        leftover,
        consumed: loggedConsumed !== null ? Math.max(0, loggedConsumed) : Math.max(0, prepared - leftover),
    };
}

const newAccumulator = () => ({ logCount: 0, prepared: 0, consumed: 0, waste: 0 });

function accumulate(acc, r) {
    acc.logCount += 1;
    acc.prepared += r.prepared;
    acc.consumed += r.consumed;
    acc.waste += r.leftover;
}

function summarise(acc, totalWaste) {
    return {
        logCount: acc.logCount,
        preparedQuantity: round(acc.prepared, 2),
        consumedQuantity: round(acc.consumed, 2),
        wasteQuantity: round(acc.waste, 2),
        wastePercentage: acc.prepared > 0 ? round((acc.waste / acc.prepared) * 100, 1) : null,
        averageWastePerLog: round(acc.waste / acc.logCount, 2),
        contributionPercentage: totalWaste > 0 ? round((acc.waste / totalWaste) * 100, 1) : 0,
    };
}

function isOverPrepared(r) {
    return r.prepared > 0 && r.leftover / r.prepared >= OVER_PREPARATION_RATIO;
}

function compareText(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function emptyResult(period) {
    return {
        period: { ...period, firstLogDate: null, lastLogDate: null },
        totals: { logCount: 0, preparedQuantity: 0, consumedQuantity: 0, wasteQuantity: 0, wastePercentage: null },
        byMenuItem: [],
        byMealSlot: [],
        byWeekday: [],
        topMenuItems: [],
        topMealSlots: [],
        patterns: { recurringOverPreparation: [], weekdayMealSlotHotspots: [] },
        insights: [],
        meta: metaFor([]),
    };
}

function metaFor(units) {
    return {
        mixedUnits: units.length > 1,
        units,
        definitions: {
            waste: 'Recorded leftover quantity (quantity_leftover) on daily logs.',
            wastePercentage: 'Waste as a percentage of the quantity prepared.',
            overPreparedLog: `A log where at least ${OVER_PREPARATION_RATIO * 100}% of the prepared quantity was left over.`,
            recurringOverPreparation: `A menu item over-prepared in at least ${RECURRING_SHARE * 100}% of its last ${RECENT_LOG_WINDOW} logs (minimum ${MIN_LOGS_FOR_PATTERN} logs).`,
        },
    };
}

function buildInsights({ totals, byMenuItem, hotspotCandidates, weekdayCandidates, recurring, mixedUnits }) {
    const insights = [];

    if (totals.preparedQuantity > 0 && totals.wasteQuantity === 0) {
        return [{ type: 'no_waste', message: 'No leftover was recorded in this period.', evidence: { logCount: totals.logCount } }];
    }

    if (totals.wastePercentage !== null) {
        insights.push({
            type: 'overall_waste_rate',
            message: `${totals.wastePercentage}% of prepared food was left over (${fmt(totals.wasteQuantity)} of ${fmt(totals.preparedQuantity)} prepared across ${plural(totals.logCount, 'log')}).${mixedUnits ? ' Menu items use different units, so combined quantities are indicative only.' : ''}`,
            evidence: { wastePercentage: totals.wastePercentage, wasteQuantity: totals.wasteQuantity, preparedQuantity: totals.preparedQuantity },
        });
    }

    const top = byMenuItem.find((item) => item.wasteQuantity > 0);
    if (top) {
        insights.push({
            type: 'top_waste_contributor',
            message: `${top.name} contributed ${Math.round(top.contributionPercentage)}% of recorded waste (${fmt(top.wasteQuantity)} ${top.unit}).`,
            evidence: { menuItemId: top.menuItemId, contributionPercentage: top.contributionPercentage, wasteQuantity: top.wasteQuantity },
        });
    }

    const rankCells = (cells) =>
        cells
            .filter((c) => c.acc.logCount >= MIN_LOGS_FOR_HOTSPOT && c.acc.waste > 0)
            .map((c) => ({ ...c, average: c.acc.waste / c.acc.logCount }))
            .sort((a, b) => b.average - a.average || b.acc.waste - a.acc.waste || a.order - b.order || compareText(a.slot || '', b.slot || ''));

    const peakCell = rankCells(hotspotCandidates)[0];
    if (peakCell) {
        insights.push({
            type: 'peak_weekday_meal_slot',
            message: `${WEEKDAY_NAMES[peakCell.weekday]} ${slotLabel(peakCell.slot)} has the highest average waste (${fmt(peakCell.average)} per log across ${plural(peakCell.acc.logCount, 'log')}).`,
            evidence: { weekday: peakCell.weekday, mealSlot: peakCell.slot, averageWastePerLog: round(peakCell.average, 2), logCount: peakCell.acc.logCount },
        });
    } else {
        const peakDay = rankCells(weekdayCandidates)[0];
        if (peakDay) {
            insights.push({
                type: 'peak_weekday',
                message: `${WEEKDAY_NAMES[peakDay.weekday]} has the highest average waste (${fmt(peakDay.average)} per log across ${plural(peakDay.acc.logCount, 'log')}).`,
                evidence: { weekday: peakDay.weekday, averageWastePerLog: round(peakDay.average, 2), logCount: peakDay.acc.logCount },
            });
        }
    }

    recurring.slice(0, 2).forEach((pattern) => {
        insights.push({
            type: 'repeated_over_preparation',
            message: `${pattern.menuItemName} shows repeated over-preparation: ${pattern.overPreparedLogCount} of its last ${plural(pattern.recentLogCount, 'log')} had ${pattern.overPreparationThresholdPercentage}% or more left over.`,
            evidence: {
                menuItemId: pattern.menuItemId,
                overPreparedLogCount: pattern.overPreparedLogCount,
                recentLogCount: pattern.recentLogCount,
                averageWastePercentage: pattern.averageWastePercentage,
            },
        });
    });

    const highRate = byMenuItem
        .filter((item) => item.logCount >= MIN_LOGS_FOR_RATE_INSIGHT && item.wastePercentage !== null && item.wastePercentage >= HIGH_WASTE_RATE_PCT)
        .sort((a, b) => b.wastePercentage - a.wastePercentage || compareText(a.name, b.name) || a.menuItemId - b.menuItemId)[0];
    if (highRate) {
        insights.push({
            type: 'high_waste_rate_item',
            message: `${highRate.name} has the highest waste rate: ${highRate.wastePercentage}% of what is prepared is left over.`,
            evidence: { menuItemId: highRate.menuItemId, wastePercentage: highRate.wastePercentage, logCount: highRate.logCount },
        });
    }

    return insights.slice(0, MAX_INSIGHTS);
}

/**
 * @param {Array} rows daily-log rows: { log_date, meal_slot, menu_item_id, menu_item_name, menu_item_unit,
 *                                       quantity_prepared, quantity_consumed, quantity_leftover }
 * @param {Object} [period] { startDate, endDate } echoed back (null = unbounded)
 */
function computeWasteAttribution(rows, period = {}) {
    const requestedPeriod = { startDate: period.startDate || null, endDate: period.endDate || null };
    if (!Array.isArray(rows) || rows.length === 0) return emptyResult(requestedPeriod);

    // Sort so results never depend on input order.
    const logs = rows
        .map(normaliseRow)
        .sort((a, b) => compareText(a.date, b.date) || a.itemId - b.itemId || compareText(a.slot, b.slot));

    const totalsAcc = newAccumulator();
    const items = new Map();
    const slots = new Map();
    const weekdays = new Map();
    const cells = new Map();
    const itemLogs = new Map();
    const unitSet = new Set();

    logs.forEach((r) => {
        accumulate(totalsAcc, r);
        unitSet.add(r.unit);

        if (!items.has(r.itemId)) items.set(r.itemId, { itemId: r.itemId, name: r.itemName, unit: r.unit, acc: newAccumulator() });
        accumulate(items.get(r.itemId).acc, r);

        if (!slots.has(r.slot)) slots.set(r.slot, { slot: r.slot, acc: newAccumulator() });
        accumulate(slots.get(r.slot).acc, r);

        if (!weekdays.has(r.weekday)) weekdays.set(r.weekday, { weekday: r.weekday, acc: newAccumulator() });
        accumulate(weekdays.get(r.weekday).acc, r);

        const cellKey = `${r.weekday}|${r.slot}`;
        if (!cells.has(cellKey)) cells.set(cellKey, { weekday: r.weekday, slot: r.slot, acc: newAccumulator() });
        accumulate(cells.get(cellKey).acc, r);

        if (!itemLogs.has(r.itemId)) itemLogs.set(r.itemId, []);
        itemLogs.get(r.itemId).push(r);
    });

    const totalWaste = totalsAcc.waste;
    const totals = {
        logCount: totalsAcc.logCount,
        preparedQuantity: round(totalsAcc.prepared, 2),
        consumedQuantity: round(totalsAcc.consumed, 2),
        wasteQuantity: round(totalWaste, 2),
        wastePercentage: totalsAcc.prepared > 0 ? round((totalWaste / totalsAcc.prepared) * 100, 1) : null,
    };

    const byMenuItem = [...items.values()]
        .sort((a, b) => b.acc.waste - a.acc.waste || compareText(a.name, b.name) || a.itemId - b.itemId)
        .map((item) => ({ menuItemId: item.itemId, name: item.name, unit: item.unit, ...summarise(item.acc, totalWaste) }));

    const byMealSlot = [...slots.values()]
        .sort((a, b) => b.acc.waste - a.acc.waste || compareText(a.slot, b.slot))
        .map((s) => ({ mealSlot: s.slot, ...summarise(s.acc, totalWaste) }));

    const byWeekday = WEEKDAY_DISPLAY_ORDER.filter((d) => weekdays.has(d)).map((d) => ({
        weekday: d,
        weekdayName: WEEKDAY_NAMES[d],
        ...summarise(weekdays.get(d).acc, totalWaste),
    }));

    const topMenuItems = byMenuItem
        .filter((i) => i.wasteQuantity > 0)
        .slice(0, TOP_N)
        .map((i) => ({ menuItemId: i.menuItemId, name: i.name, unit: i.unit, wasteQuantity: i.wasteQuantity, contributionPercentage: i.contributionPercentage }));
    const topMealSlots = byMealSlot
        .filter((s) => s.wasteQuantity > 0)
        .slice(0, TOP_N)
        .map((s) => ({ mealSlot: s.mealSlot, wasteQuantity: s.wasteQuantity, contributionPercentage: s.contributionPercentage }));

    const orderOf = (weekday) => WEEKDAY_DISPLAY_ORDER.indexOf(weekday);
    const cellCandidates = [...cells.values()].map((c) => ({ ...c, order: orderOf(c.weekday) }));
    const weekdayCandidates = [...weekdays.values()].map((w) => ({ ...w, order: orderOf(w.weekday) }));

    const weekdayMealSlotHotspots = cellCandidates
        .filter((c) => c.acc.logCount >= MIN_LOGS_FOR_HOTSPOT && c.acc.waste > 0)
        .sort((a, b) => b.acc.waste / b.acc.logCount - a.acc.waste / a.acc.logCount || b.acc.waste - a.acc.waste || a.order - b.order || compareText(a.slot, b.slot))
        .slice(0, TOP_N)
        .map((c) => ({
            weekday: c.weekday,
            weekdayName: WEEKDAY_NAMES[c.weekday],
            mealSlot: c.slot,
            logCount: c.acc.logCount,
            wasteQuantity: round(c.acc.waste, 2),
            averageWastePerLog: round(c.acc.waste / c.acc.logCount, 2),
        }));

    const recurringOverPreparation = [...itemLogs.entries()]
        .filter(([, entries]) => entries.length >= MIN_LOGS_FOR_PATTERN)
        .map(([itemId, entries]) => {
            const window = entries.slice(-RECENT_LOG_WINDOW);
            const over = window.filter(isOverPrepared).length;
            const preparedSum = window.reduce((s, r) => s + r.prepared, 0);
            const leftoverSum = window.reduce((s, r) => s + r.leftover, 0);
            return {
                type: 'repeated_over_preparation',
                menuItemId: itemId,
                menuItemName: items.get(itemId).name,
                unit: items.get(itemId).unit,
                recentLogCount: window.length,
                overPreparedLogCount: over,
                overPreparationThresholdPercentage: OVER_PREPARATION_RATIO * 100,
                averageWastePercentage: preparedSum > 0 ? round((leftoverSum / preparedSum) * 100, 1) : null,
            };
        })
        .filter((p) => p.overPreparedLogCount / p.recentLogCount >= RECURRING_SHARE)
        .sort(
            (a, b) =>
                b.overPreparedLogCount / b.recentLogCount - a.overPreparedLogCount / a.recentLogCount ||
                (b.averageWastePercentage ?? 0) - (a.averageWastePercentage ?? 0) ||
                compareText(a.menuItemName, b.menuItemName) ||
                a.menuItemId - b.menuItemId
        );

    const units = [...unitSet].sort(compareText);
    const insights = buildInsights({
        totals,
        byMenuItem,
        hotspotCandidates: cellCandidates,
        weekdayCandidates,
        recurring: recurringOverPreparation,
        mixedUnits: units.length > 1,
    });

    return {
        period: { ...requestedPeriod, firstLogDate: logs[0].date, lastLogDate: logs[logs.length - 1].date },
        totals,
        byMenuItem,
        byMealSlot,
        byWeekday,
        topMenuItems,
        topMealSlots,
        patterns: { recurringOverPreparation, weekdayMealSlotHotspots },
        insights,
        meta: metaFor(units),
    };
}

// Always scoped to the authenticated user's own organization - no organization id is ever accepted
// from the client.
async function getWasteAttribution(actingUser, { startDate, endDate } = {}) {
    if (!actingUser.organizationId) {
        throw new AppError(403, 'This account is not associated with an organization');
    }
    const rows = await dailyLogModel.listForAnalytics(actingUser.organizationId, { startDate, endDate });
    return computeWasteAttribution(rows, { startDate, endDate });
}

module.exports = { computeWasteAttribution, getWasteAttribution };
