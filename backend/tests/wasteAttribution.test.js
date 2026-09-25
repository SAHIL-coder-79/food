const { computeWasteAttribution } = require('../src/services/wasteAttributionService');

// Mon 2026-03-02, Tue 2026-03-03, Wed 2026-03-04
let nextItemId = 1;
const items = {};
function item(name, unit = 'kg') {
    if (!items[name]) items[name] = { id: nextItemId++, name, unit };
    return items[name];
}

function log(date, name, slot, prepared, leftover, consumed, unit) {
    const it = item(name, unit);
    return {
        log_date: date,
        meal_slot: slot,
        menu_item_id: it.id,
        menu_item_name: it.name,
        menu_item_unit: it.unit,
        quantity_prepared: prepared,
        quantity_leftover: leftover,
        quantity_consumed: consumed === undefined ? null : consumed,
    };
}

// prepared 500, waste 80 (16%), consumed 420
function sampleRows() {
    return [
        log('2026-03-02', 'Rice', 'LUNCH', 100, 20),
        log('2026-03-03', 'Rice', 'LUNCH', 100, 30),
        log('2026-03-04', 'Rice', 'LUNCH', 100, 10),
        log('2026-03-02', 'Dal', 'LUNCH', 50, 10),
        log('2026-03-03', 'Dal', 'LUNCH', 50, 5),
        log('2026-03-03', 'Dal', 'DINNER', 40, 5),
        log('2026-03-02', 'Roti', 'DINNER', 60, 0),
    ];
}

function shuffled(rows) {
    const copy = rows.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = (i * 7 + 3) % (i + 1);
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

describe('waste attribution - empty data', () => {
    it('returns a sensible, fully shaped empty result', () => {
        const result = computeWasteAttribution([], { startDate: '2026-03-01', endDate: null });
        expect(result.totals).toEqual({ logCount: 0, preparedQuantity: 0, consumedQuantity: 0, wasteQuantity: 0, wastePercentage: null });
        expect(result.byMenuItem).toEqual([]);
        expect(result.byMealSlot).toEqual([]);
        expect(result.byWeekday).toEqual([]);
        expect(result.topMenuItems).toEqual([]);
        expect(result.topMealSlots).toEqual([]);
        expect(result.patterns).toEqual({ recurringOverPreparation: [], weekdayMealSlotHotspots: [] });
        expect(result.insights).toEqual([]);
        expect(result.period).toEqual({ startDate: '2026-03-01', endDate: null, firstLogDate: null, lastLogDate: null });
        expect(result.meta.mixedUnits).toBe(false);
    });

    it('treats non-array input as empty', () => {
        expect(computeWasteAttribution(undefined).totals.logCount).toBe(0);
    });
});

describe('waste attribution - totals', () => {
    const result = computeWasteAttribution(sampleRows());

    it('calculates prepared, consumed, waste and waste percentage', () => {
        expect(result.totals).toEqual({ logCount: 7, preparedQuantity: 500, consumedQuantity: 420, wasteQuantity: 80, wastePercentage: 16 });
    });

    it('reports the period covered by the logs', () => {
        expect(result.period.firstLogDate).toBe('2026-03-02');
        expect(result.period.lastLogDate).toBe('2026-03-04');
    });

    it('prefers the logged consumed quantity over prepared minus leftover', () => {
        const r = computeWasteAttribution([log('2026-03-02', 'Rice', 'LUNCH', 100, 20, 70)]);
        expect(r.totals.consumedQuantity).toBe(70);
        const derived = computeWasteAttribution([log('2026-03-02', 'Rice', 'LUNCH', 100, 20)]);
        expect(derived.totals.consumedQuantity).toBe(80);
    });

    it('treats missing quantities as zero and leaves the percentage null when nothing was prepared', () => {
        const r = computeWasteAttribution([log('2026-03-02', 'Rice', 'LUNCH', null, null)]);
        expect(r.totals.preparedQuantity).toBe(0);
        expect(r.totals.wasteQuantity).toBe(0);
        expect(r.totals.wastePercentage).toBeNull();
        expect(r.insights).toEqual([]);
    });

    it('says so when no waste was recorded', () => {
        const r = computeWasteAttribution([log('2026-03-02', 'Rice', 'LUNCH', 100, 0), log('2026-03-03', 'Rice', 'LUNCH', 100, 0)]);
        expect(r.totals.wastePercentage).toBe(0);
        expect(r.insights).toHaveLength(1);
        expect(r.insights[0].type).toBe('no_waste');
        expect(r.topMenuItems).toEqual([]);
    });
});

describe('waste attribution - by menu item', () => {
    const result = computeWasteAttribution(sampleRows());

    it('attributes waste to each menu item, ranked by waste', () => {
        expect(result.byMenuItem.map((i) => i.name)).toEqual(['Rice', 'Dal', 'Roti']);
        const rice = result.byMenuItem[0];
        expect(rice).toMatchObject({ name: 'Rice', unit: 'kg', logCount: 3, preparedQuantity: 300, consumedQuantity: 240, wasteQuantity: 60, wastePercentage: 20 });
        expect(result.byMenuItem[1]).toMatchObject({ name: 'Dal', wasteQuantity: 20, preparedQuantity: 140 });
        expect(result.byMenuItem[2]).toMatchObject({ name: 'Roti', wasteQuantity: 0, wastePercentage: 0 });
    });

    it('lists only waste-producing items as top items', () => {
        expect(result.topMenuItems.map((i) => i.name)).toEqual(['Rice', 'Dal']);
    });

    it('limits top items to five', () => {
        const rows = Array.from({ length: 8 }, (_, i) => log('2026-03-02', `Item${i}`, 'LUNCH', 100, 10 + i));
        const r = computeWasteAttribution(rows);
        expect(r.topMenuItems).toHaveLength(5);
        expect(r.topMenuItems[0].name).toBe('Item7');
    });
});

describe('waste attribution - contribution percentages', () => {
    it("computes each item's share of total waste", () => {
        const { byMenuItem } = computeWasteAttribution(sampleRows());
        expect(byMenuItem.map((i) => i.contributionPercentage)).toEqual([75, 25, 0]);
    });

    it('sums to ~100% across items, slots and weekdays', () => {
        const rows = [
            log('2026-03-02', 'A', 'LUNCH', 90, 7),
            log('2026-03-03', 'B', 'DINNER', 80, 13),
            log('2026-03-04', 'C', 'SNACKS', 70, 9),
            log('2026-03-05', 'A', 'LUNCH', 60, 4),
        ];
        const r = computeWasteAttribution(rows);
        const total = (list) => list.reduce((s, x) => s + x.contributionPercentage, 0);
        expect(Math.abs(total(r.byMenuItem) - 100)).toBeLessThan(0.3);
        expect(Math.abs(total(r.byMealSlot) - 100)).toBeLessThan(0.3);
        expect(Math.abs(total(r.byWeekday) - 100)).toBeLessThan(0.3);
    });

    it('is 0 (not NaN) for everything when there is no waste', () => {
        const r = computeWasteAttribution([log('2026-03-02', 'Rice', 'LUNCH', 100, 0)]);
        expect(r.byMenuItem[0].contributionPercentage).toBe(0);
        expect(r.byMealSlot[0].contributionPercentage).toBe(0);
    });
});

describe('waste attribution - meal slot', () => {
    const { byMealSlot, topMealSlots } = computeWasteAttribution(sampleRows());

    it('attributes waste to each meal slot, ranked by waste', () => {
        expect(byMealSlot.map((s) => s.mealSlot)).toEqual(['LUNCH', 'DINNER']);
        expect(byMealSlot[0]).toMatchObject({ mealSlot: 'LUNCH', logCount: 5, wasteQuantity: 75, preparedQuantity: 400, wastePercentage: 18.8, averageWastePerLog: 15 });
        expect(byMealSlot[1]).toMatchObject({ mealSlot: 'DINNER', logCount: 2, wasteQuantity: 5, wastePercentage: 5 });
        expect(byMealSlot[0].contributionPercentage).toBeCloseTo(93.8, 1);
    });

    it('lists top waste-producing slots', () => {
        expect(topMealSlots.map((s) => s.mealSlot)).toEqual(['LUNCH', 'DINNER']);
    });

    it('keeps processing batches as their own slot', () => {
        const r = computeWasteAttribution([log('2026-03-02', 'Flour', 'BATCH', 100, 5)]);
        expect(r.byMealSlot[0].mealSlot).toBe('BATCH');
    });
});

describe('waste attribution - weekday', () => {
    const { byWeekday } = computeWasteAttribution(sampleRows());

    it('attributes waste by calendar weekday in Monday-first order, only for days with logs', () => {
        expect(byWeekday.map((d) => d.weekdayName)).toEqual(['Monday', 'Tuesday', 'Wednesday']);
        expect(byWeekday[0]).toMatchObject({ weekday: 1, wasteQuantity: 30, preparedQuantity: 210, logCount: 3 });
        expect(byWeekday[1]).toMatchObject({ weekday: 2, wasteQuantity: 40, preparedQuantity: 190, logCount: 3, averageWastePerLog: 13.33 });
        expect(byWeekday[2]).toMatchObject({ weekday: 3, wasteQuantity: 10 });
        expect(byWeekday.map((d) => d.contributionPercentage)).toEqual([37.5, 50, 12.5]);
    });

    it('puts Sunday last', () => {
        const r = computeWasteAttribution([log('2026-03-01', 'Rice', 'LUNCH', 100, 5), log('2026-03-02', 'Rice', 'LUNCH', 100, 5)]);
        expect(r.byWeekday.map((d) => d.weekdayName)).toEqual(['Monday', 'Sunday']);
    });

    it('finds the weekday + meal-slot hotspots (needs at least 2 logs per cell)', () => {
        const { patterns } = computeWasteAttribution(sampleRows());
        expect(patterns.weekdayMealSlotHotspots[0]).toEqual({
            weekday: 2, weekdayName: 'Tuesday', mealSlot: 'LUNCH', logCount: 2, wasteQuantity: 35, averageWastePerLog: 17.5,
        });
        expect(patterns.weekdayMealSlotHotspots.every((c) => c.logCount >= 2)).toBe(true);
    });
});

describe('waste attribution - recurring over-preparation', () => {
    it('flags items over-prepared in most of their recent logs', () => {
        const { patterns } = computeWasteAttribution(sampleRows());
        expect(patterns.recurringOverPreparation.map((p) => p.menuItemName)).toEqual(['Rice', 'Dal']);
        expect(patterns.recurringOverPreparation[0]).toMatchObject({
            type: 'repeated_over_preparation', recentLogCount: 3, overPreparedLogCount: 3, overPreparationThresholdPercentage: 10, averageWastePercentage: 20,
        });
    });

    it('only looks at the most recent five logs', () => {
        const rows = [];
        for (let i = 0; i < 8; i += 1) {
            // first 3 days heavily over-prepared, last 5 well managed
            rows.push(log(`2026-03-0${i + 1}`, 'Dal', 'LUNCH', 100, i < 3 ? 40 : 0));
        }
        expect(computeWasteAttribution(rows).patterns.recurringOverPreparation).toEqual([]);
    });

    it('needs at least 3 logs and a majority of recent logs over-prepared', () => {
        expect(computeWasteAttribution([log('2026-03-01', 'Dal', 'LUNCH', 100, 40), log('2026-03-02', 'Dal', 'LUNCH', 100, 40)]).patterns.recurringOverPreparation).toEqual([]);
        const mixed = [
            log('2026-03-01', 'Dal', 'LUNCH', 100, 40),
            log('2026-03-02', 'Dal', 'LUNCH', 100, 0),
            log('2026-03-03', 'Dal', 'LUNCH', 100, 0),
            log('2026-03-04', 'Dal', 'LUNCH', 100, 0),
            log('2026-03-05', 'Dal', 'LUNCH', 100, 40),
        ];
        expect(computeWasteAttribution(mixed).patterns.recurringOverPreparation).toEqual([]);
    });

    it('does not count small leftovers below the 10% threshold as over-preparation', () => {
        const rows = ['01', '02', '03', '04'].map((d) => log(`2026-03-${d}`, 'Dal', 'LUNCH', 100, 9));
        expect(computeWasteAttribution(rows).patterns.recurringOverPreparation).toEqual([]);
    });
});

describe('waste attribution - deterministic insights', () => {
    const result = computeWasteAttribution(sampleRows());

    it('produces explainable rule-based sentences, capped at five', () => {
        expect(result.insights.map((i) => i.type)).toEqual([
            'overall_waste_rate',
            'top_waste_contributor',
            'peak_weekday_meal_slot',
            'repeated_over_preparation',
            'repeated_over_preparation',
        ]);
        expect(result.insights[0].message).toBe('16% of prepared food was left over (80 of 500 prepared across 7 logs).');
        expect(result.insights[1].message).toBe('Rice contributed 75% of recorded waste (60 kg).');
        expect(result.insights[2].message).toBe('Tuesday lunch has the highest average waste (17.5 per log across 2 logs).');
        expect(result.insights[3].message).toBe('Rice shows repeated over-preparation: 3 of its last 3 logs had 10% or more left over.');
        expect(result.insights.length).toBeLessThanOrEqual(5);
        result.insights.forEach((i) => {
            expect(typeof i.message).toBe('string');
            expect(i.evidence).toBeDefined();
        });
    });

    it('falls back to a weekday-level insight when no weekday+slot cell has enough logs', () => {
        const r = computeWasteAttribution([log('2026-03-02', 'Rice', 'LUNCH', 100, 20), log('2026-03-02', 'Dal', 'DINNER', 100, 30)]);
        const types = r.insights.map((i) => i.type);
        expect(types).toContain('peak_weekday');
        expect(types).not.toContain('peak_weekday_meal_slot');
        expect(r.insights.find((i) => i.type === 'peak_weekday').message).toBe('Monday has the highest average waste (25 per log across 2 logs).');
    });

    it('flags a high waste-rate item', () => {
        const rows = [
            log('2026-03-01', 'Curry', 'LUNCH', 100, 25),
            log('2026-03-02', 'Curry', 'LUNCH', 100, 5),
            log('2026-03-03', 'Curry', 'LUNCH', 100, 40),
        ];
        const insight = computeWasteAttribution(rows).insights.find((i) => i.type === 'high_waste_rate_item');
        expect(insight.message).toBe('Curry has the highest waste rate: 23.3% of what is prepared is left over.');
    });

    it('notes when menu items use different units', () => {
        const r = computeWasteAttribution([log('2026-03-02', 'Rice', 'LUNCH', 100, 20, undefined, 'kg'), log('2026-03-02', 'Tea', 'SNACKS', 50, 5, undefined, 'litres')]);
        expect(r.meta.mixedUnits).toBe(true);
        expect(r.meta.units).toEqual(['kg', 'litres']);
        expect(r.insights[0].message).toMatch(/different units/);
    });

    it('is deterministic: same logs in any order give identical output', () => {
        const baseline = computeWasteAttribution(sampleRows());
        expect(computeWasteAttribution(sampleRows())).toEqual(baseline);
        expect(computeWasteAttribution(shuffled(sampleRows()))).toEqual(baseline);
        expect(JSON.stringify(computeWasteAttribution(shuffled(sampleRows())))).toBe(JSON.stringify(baseline));
    });

    it('breaks ties deterministically', () => {
        const rows = [log('2026-03-02', 'Beta', 'LUNCH', 100, 10), log('2026-03-02', 'Alpha', 'DINNER', 100, 10)];
        const r = computeWasteAttribution(rows);
        expect(r.byMenuItem.map((i) => i.name)).toEqual(['Alpha', 'Beta']);
        expect(r.byMealSlot.map((s) => s.mealSlot)).toEqual(['DINNER', 'LUNCH']);
    });
});
