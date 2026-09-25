const {
    assessSpoilageRisk,
    classifyFoodCategory,
    CATEGORY_WINDOWS_HOURS,
    RISK_LEVELS,
    SpoilageInputError,
} = require('../src/ai/spoilageRisk');

const NOW = new Date('2026-03-10T12:00:00.000Z');
const MIN = 60000;
const minutesAgo = (m) => new Date(NOW.getTime() - m * MIN).toISOString();
const minutesFromNow = (m) => new Date(NOW.getTime() + m * MIN).toISOString();

// Rice at 25 C: 3h (180 min) window - easy numbers.
const rice = (extra = {}) => ({ foodType: 'Rice', ambientTemperatureC: 25, ...extra });
const assess = (input) => assessSpoilageRisk(input, NOW);

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, EXPIRED: 3 };

describe('spoilage risk - fresh food', () => {
    const result = assess(rice({ preparedTime: minutesAgo(10) }));

    it('classifies recently prepared food as LOW', () => {
        expect(result.riskLevel).toBe('LOW');
        expect(result.minutesRemaining).toBe(170);
    });

    it('estimates safe-until as preparation time plus the category window', () => {
        expect(result.estimatedSafeUntil).toBe(new Date(NOW.getTime() - 10 * MIN + 180 * MIN).toISOString());
        expect(result.estimatedSafeUntilSource).toBe('category_rule');
        expect(result.safeWindowHours).toBe(3);
    });

    it('is always labelled an estimate and never certifies safety', () => {
        expect(result.isEstimate).toBe(true);
        expect(result.disclaimer).toMatch(/not a food-safety certification/i);
        expect(result.reasons.join(' ')).toMatch(/not a guarantee/i);
        expect(result.confidence).toBeLessThan(1);
    });

    it('returns every documented field', () => {
        ['riskLevel', 'estimatedSafeUntil', 'confidence', 'reasons', 'factorsUsed', 'isEstimate'].forEach((key) => {
            expect(result).toHaveProperty(key);
        });
        expect(Array.isArray(result.reasons)).toBe(true);
        expect(Array.isArray(result.factorsUsed)).toBe(true);
    });
});

describe('spoilage risk - approaching expiry and expiry', () => {
    it.each([
        [10, 'LOW'],
        [89, 'LOW'], // just under 50% of the window
        [90, 'MEDIUM'], // 50%
        [100, 'MEDIUM'],
        [134, 'MEDIUM'], // just under 75%
        [135, 'HIGH'], // 75%
        [170, 'HIGH'],
        [175, 'HIGH'], // 5 minutes left
    ])('rice prepared %i minutes ago is %s', (age, expected) => {
        expect(assess(rice({ preparedTime: minutesAgo(age) })).riskLevel).toBe(expected);
    });

    it.each([[180], [181], [240], [1440]])('rice prepared %i minutes ago is EXPIRED', (age) => {
        const result = assess(rice({ preparedTime: minutesAgo(age) }));
        expect(result.riskLevel).toBe('EXPIRED');
        expect(result.minutesRemaining).toBeLessThanOrEqual(0);
        expect(result.reasons.join(' ')).toMatch(/beyond the estimated 3h window/);
    });

    it('treats the last 30 minutes as HIGH even for short windows', () => {
        // dairy at 25 C = 2h; prepared 95 minutes ago = 79% used and 25 min left
        expect(assess({ foodType: 'Curd rice with raita', ambientTemperatureC: 25, preparedTime: minutesAgo(95) }).riskLevel).toBe('HIGH');
    });

    it('does not tell staff to discard or block: expired advice asks for a check', () => {
        const result = assess(rice({ preparedTime: minutesAgo(300) }));
        expect(result.reasons.join(' ')).toMatch(/staff should check the food carefully/i);
    });
});

describe('spoilage risk - food categories', () => {
    it.each([
        ['Chicken Biryani', 'meat_fish_egg'],
        ['Non-veg thali', 'meat_fish_egg'],
        ['Boiled Eggs', 'meat_fish_egg'],
        ['Fish curry', 'meat_fish_egg'],
        ['Curd', 'dairy_or_cream'],
        ['Paneer Butter Masala', 'dairy_or_cream'],
        ['Kheer', 'dairy_or_cream'],
        ['Veg Biryani', 'cooked_rice_grain'],
        ['Steamed rice', 'cooked_rice_grain'],
        ['Hakka Noodles', 'cooked_rice_grain'],
        ['Fruit salad', 'fresh_raw'],
        ['Dal Tadka', 'curry_dal_gravy'],
        ['Mixed vegetable sabzi', 'curry_dal_gravy'],
        ['Chapatis', 'bread_or_flatbread'],
        ['Butter Roti', 'bread_or_flatbread'],
        ['Samosas', 'fried_snack'],
        ['Gulab Jamun', 'sweets_baked'],
        ['Packaged biscuits', 'packaged_shelf_stable'],
        ['Mystery Platter', 'unclassified'],
        ['', 'unclassified'],
    ])('"%s" is classified as %s', (foodType, expected) => {
        expect(classifyFoodCategory(foodType).category).toBe(expected);
    });

    it('picks the most perishable category when several match (conservative)', () => {
        expect(classifyFoodCategory('Dal rice').category).toBe('cooked_rice_grain'); // 3h beats curry's 4h
        expect(classifyFoodCategory('Chicken biryani').category).toBe('meat_fish_egg'); // 2h beats rice's 3h
        const multi = classifyFoodCategory('Paneer masala');
        expect(multi.category).toBe('dairy_or_cream');
        expect(multi.alternatives).toContain('curry_dal_gravy');
    });

    it('is case and punctuation insensitive', () => {
        expect(classifyFoodCategory('  CHICKEN-Biryani!! ').category).toBe('meat_fish_egg');
    });

    it('gives perishable categories shorter windows than stable ones', () => {
        const w = CATEGORY_WINDOWS_HOURS;
        expect(w.meat_fish_egg).toBeLessThan(w.cooked_rice_grain);
        expect(w.cooked_rice_grain).toBeLessThan(w.curry_dal_gravy);
        expect(w.curry_dal_gravy).toBeLessThan(w.bread_or_flatbread);
        expect(w.bread_or_flatbread).toBeLessThan(w.sweets_baked);
        expect(w.sweets_baked).toBeLessThan(w.packaged_shelf_stable);
    });

    it('applies the category window: same prep time, different foods, different safe-until and risk', () => {
        const prep = minutesAgo(150); // 2.5h ago at 25 C
        const chicken = assess({ foodType: 'Chicken curry', ambientTemperatureC: 25, preparedTime: prep });
        const riceResult = assess({ foodType: 'Rice', ambientTemperatureC: 25, preparedTime: prep });
        const dal = assess({ foodType: 'Dal', ambientTemperatureC: 25, preparedTime: prep });
        const roti = assess({ foodType: 'Roti', ambientTemperatureC: 25, preparedTime: prep });
        const biscuits = assess({ foodType: 'Packaged biscuits', ambientTemperatureC: 25, preparedTime: prep });

        expect(chicken.riskLevel).toBe('EXPIRED'); // 2h window, 150 min elapsed
        expect(riceResult.riskLevel).toBe('HIGH'); // 3h window, 83% used
        expect(dal.riskLevel).toBe('MEDIUM'); // 4h window, 62% used
        expect(roti.riskLevel).toBe('LOW'); // 6h window, 42% used
        expect(biscuits.riskLevel).toBe('LOW'); // 24h window
        expect(new Date(biscuits.estimatedSafeUntil) > new Date(roti.estimatedSafeUntil)).toBe(true);
        expect(new Date(roti.estimatedSafeUntil) > new Date(dal.estimatedSafeUntil)).toBe(true);
        expect(new Date(dal.estimatedSafeUntil) > new Date(riceResult.estimatedSafeUntil)).toBe(true);
        expect(new Date(riceResult.estimatedSafeUntil) > new Date(chicken.estimatedSafeUntil)).toBe(true);
    });

    it('uses a cautious default window and lower confidence for unrecognised food', () => {
        const unknown = assess({ foodType: 'Mystery Platter', ambientTemperatureC: 25, preparedTime: minutesAgo(10) });
        const known = assess({ foodType: 'Rice', ambientTemperatureC: 25, preparedTime: minutesAgo(10) });
        expect(unknown.category).toBe('unclassified');
        expect(unknown.safeWindowHours).toBe(3);
        expect(unknown.reasons[0]).toMatch(/was not recognised/);
        expect(unknown.confidence).toBeLessThan(known.confidence);
    });
});

describe('spoilage risk - temperature and quantity', () => {
    const base = { foodType: 'Rice', preparedTime: minutesAgo(30) };

    it.each([
        [40, 1.5],
        [35, 2.1],
        [30, 2.55],
        [25, 3],
        [15, 3.9],
        [5, 6],
    ])('holding temperature %i C gives a %s h window for rice', (temperature, hours) => {
        expect(assess({ ...base, ambientTemperatureC: temperature }).safeWindowHours).toBe(hours);
    });

    it('a hotter environment shortens safe-until and never lowers the risk', () => {
        const prep = minutesAgo(100);
        const cool = assess({ foodType: 'Rice', ambientTemperatureC: 15, preparedTime: prep });
        const room = assess({ foodType: 'Rice', ambientTemperatureC: 25, preparedTime: prep });
        const hot = assess({ foodType: 'Rice', ambientTemperatureC: 40, preparedTime: prep });
        expect(new Date(cool.estimatedSafeUntil) > new Date(room.estimatedSafeUntil)).toBe(true);
        expect(new Date(room.estimatedSafeUntil) > new Date(hot.estimatedSafeUntil)).toBe(true);
        expect(RANK[cool.riskLevel]).toBeLessThanOrEqual(RANK[room.riskLevel]);
        expect(RANK[room.riskLevel]).toBeLessThanOrEqual(RANK[hot.riskLevel]);
        expect(hot.riskLevel).toBe('EXPIRED'); // 100 min > 90 min window
    });

    it('shortens the window for large quantities', () => {
        expect(assess({ ...rice({ preparedTime: minutesAgo(30) }), quantity: 10 }).safeWindowHours).toBe(3);
        expect(assess({ ...rice({ preparedTime: minutesAgo(30) }), quantity: 60 }).safeWindowHours).toBe(2.7);
        const large = assess({ ...rice({ preparedTime: minutesAgo(30) }), quantity: 300 });
        expect(large.safeWindowHours).toBe(2.4);
        expect(large.reasons.join(' ')).toMatch(/large quantity/i);
    });

    it('clamps absurd temperatures instead of failing', () => {
        expect(assess({ ...base, ambientTemperatureC: 500 }).safeWindowHours).toBe(1.5);
        expect(assess({ ...base, ambientTemperatureC: -500 }).safeWindowHours).toBe(6);
    });
});

describe('spoilage risk - preparation-time effects', () => {
    it('moves estimated safe-until one-for-one with preparation time', () => {
        const earlier = assess(rice({ preparedTime: minutesAgo(60) }));
        const later = assess(rice({ preparedTime: minutesAgo(30) }));
        expect(new Date(later.estimatedSafeUntil) - new Date(earlier.estimatedSafeUntil)).toBe(30 * MIN);
        expect(later.safeWindowHours).toBe(earlier.safeWindowHours);
        expect(later.minutesRemaining - earlier.minutesRemaining).toBe(30);
    });

    it('never lowers the risk as food gets older', () => {
        const ages = [0, 5, 30, 60, 90, 120, 135, 160, 175, 179, 180, 300, 1000];
        const ranks = ages.map((age) => RANK[assess(rice({ preparedTime: minutesAgo(age) })).riskLevel]);
        for (let i = 1; i < ranks.length; i += 1) {
            expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
        }
        expect(ranks[0]).toBe(RANK.LOW);
        expect(ranks[ranks.length - 1]).toBe(RANK.EXPIRED);
    });

    it('treats a preparation time in the future as just prepared', () => {
        const result = assess(rice({ preparedTime: minutesFromNow(20) }));
        expect(result.riskLevel).toBe('LOW');
        expect(result.reasons.join(' ')).toMatch(/in the future/);
    });
});

describe('spoilage risk - missing optional data', () => {
    it('works with only a food type and preparation time, listing what was not provided', () => {
        const result = assess({ foodType: 'Rice', preparedTime: minutesAgo(10) });
        expect(result.riskLevel).toBe('LOW');
        expect(result.factorsNotProvided).toEqual(['ambient_temperature', 'quantity']);
        expect(result.factorsUsed.map((f) => f.factor)).toEqual(['food_category', 'current_time', 'preparation_time']);
    });

    it('assumes a warm temperature when none is given (conservative)', () => {
        const missing = assess({ foodType: 'Rice', preparedTime: minutesAgo(10) });
        const room = assess({ foodType: 'Rice', ambientTemperatureC: 25, preparedTime: minutesAgo(10) });
        expect(missing.safeWindowHours).toBe(2.55);
        expect(missing.safeWindowHours).toBeLessThan(room.safeWindowHours);
        expect(missing.reasons.join(' ')).toMatch(/warm temperature was assumed/);
    });

    it('lowers confidence as inputs go missing, and never reaches certainty', () => {
        const full = assess({ foodType: 'Rice', quantity: 10, ambientTemperatureC: 25, preparedTime: minutesAgo(10) });
        const noTemp = assess({ foodType: 'Rice', quantity: 10, preparedTime: minutesAgo(10) });
        const unknownNoTemp = assess({ foodType: 'Mystery', preparedTime: minutesAgo(10) });
        const noPrep = assess({ foodType: 'Rice', ambientTemperatureC: 25, safeUntilTime: minutesFromNow(120) });
        expect(full.confidence).toBe(0.9);
        expect(noTemp.confidence).toBe(0.85);
        expect(unknownNoTemp.confidence).toBe(0.6);
        expect(noPrep.confidence).toBe(0.65);
        expect(full.confidence).toBeGreaterThan(noTemp.confidence);
        expect(noTemp.confidence).toBeGreaterThan(unknownNoTemp.confidence);
        [full, noTemp, unknownNoTemp, noPrep].forEach((r) => expect(r.confidence).toBeLessThanOrEqual(0.9));
    });

    it('falls back to the declared safe-until time when there is no preparation time', () => {
        const result = assess(rice({ safeUntilTime: minutesFromNow(240) }));
        expect(result.estimatedSafeUntilSource).toBe('declared_safe_until');
        expect(result.estimatedSafeUntil).toBe(minutesFromNow(240));
        expect(result.factorsNotProvided).toContain('preparation_time');
        expect(result.riskLevel).toBe('LOW');
        expect(result.reasons.join(' ')).toMatch(/preparation time was not provided/i);
    });

    it.each([
        [240, 'LOW'],
        [80, 'MEDIUM'], // 44% of the 3h window left
        [40, 'HIGH'], // 22% left
        [20, 'HIGH'], // <= 30 minutes
        [-5, 'EXPIRED'],
    ])('declared safe-until %i minutes from now (no prep time) is %s', (offset, expected) => {
        expect(assess(rice({ safeUntilTime: minutesFromNow(offset) })).riskLevel).toBe(expected);
    });

    it('requires at least a preparation time or a declared safe-until time', () => {
        expect(() => assess({ foodType: 'Rice' })).toThrow(SpoilageInputError);
        expect(() => assess({ foodType: 'Rice', preparedTime: '', safeUntilTime: null })).toThrow(/preparedTime and\/or safeUntilTime/);
    });

    it('rejects malformed inputs with a clear error', () => {
        expect(() => assess({ foodType: 'Rice', preparedTime: 'yesterday-ish' })).toThrow(/preparedTime is not a valid date/);
        expect(() => assess({ foodType: 'Rice', preparedTime: minutesAgo(5), ambientTemperatureC: 'hot' })).toThrow(/ambientTemperatureC must be a number/);
        expect(() => assessSpoilageRisk({ foodType: 'Rice', preparedTime: minutesAgo(5) }, undefined)).toThrow(SpoilageInputError);
    });

    it('ignores a non-positive or missing quantity', () => {
        const result = assess({ foodType: 'Rice', ambientTemperatureC: 25, preparedTime: minutesAgo(5), quantity: 0 });
        expect(result.factorsNotProvided).toContain('quantity');
        expect(result.safeWindowHours).toBe(3);
    });
});

describe('spoilage risk - declared (staff) safe-until time can only raise the risk', () => {
    const fresh = minutesAgo(10); // LOW on its own

    it('does not lower the estimate when staff declare a much later time, but says so', () => {
        const result = assess(rice({ preparedTime: fresh, safeUntilTime: minutesFromNow(600) }));
        expect(result.riskLevel).toBe('LOW');
        expect(result.estimatedSafeUntil).toBe(new Date(NOW.getTime() - 10 * MIN + 180 * MIN).toISOString());
        expect(result.reasons.join(' ')).toMatch(/later than this estimate/);
        expect(result.reasons.join(' ')).toMatch(/does not lower the estimated risk/);
        expect(result.factorsUsed.map((f) => f.factor)).toContain('declared_safe_until');
    });

    it('never lowers an EXPIRED estimate either', () => {
        const result = assess(rice({ preparedTime: minutesAgo(400), safeUntilTime: minutesFromNow(600) }));
        expect(result.riskLevel).toBe('EXPIRED');
    });

    it('raises to EXPIRED when the declared time has already passed', () => {
        const result = assess(rice({ preparedTime: fresh, safeUntilTime: minutesAgo(5) }));
        expect(result.riskLevel).toBe('EXPIRED');
        expect(result.reasons.join(' ')).toMatch(/declared safe-until time has already passed/);
    });

    it('raises to at least HIGH when the declared time is within 30 minutes', () => {
        const result = assess(rice({ preparedTime: fresh, safeUntilTime: minutesFromNow(20) }));
        expect(result.riskLevel).toBe('HIGH');
    });

    it('notes an earlier declared time without changing the risk band', () => {
        const result = assess(rice({ preparedTime: fresh, safeUntilTime: minutesFromNow(60) }));
        expect(result.riskLevel).toBe('LOW');
        expect(result.reasons.join(' ')).toMatch(/earlier than this estimate/);
    });
});

describe('spoilage risk - determinism and wording', () => {
    const input = { foodType: 'Chicken Biryani', quantity: 80, ambientTemperatureC: 32, preparedTime: minutesAgo(70), safeUntilTime: minutesFromNow(90) };

    it('returns identical output for identical input', () => {
        const first = assess(input);
        for (let i = 0; i < 5; i += 1) {
            expect(assess(input)).toEqual(first);
        }
        expect(JSON.stringify(assess(input))).toBe(JSON.stringify(first));
    });

    it('does not depend on property order or on Date/Date-string input form', () => {
        const reordered = {
            safeUntilTime: new Date(input.safeUntilTime),
            preparedTime: new Date(input.preparedTime),
            ambientTemperatureC: String(input.ambientTemperatureC),
            quantity: String(input.quantity),
            foodType: input.foodType,
        };
        expect(assess(reordered)).toEqual(assess(input));
    });

    it('does not read the clock, randomness or the environment', () => {
        const realNow = Date.now;
        const realRandom = Math.random;
        Date.now = () => { throw new Error('clock used'); };
        Math.random = () => { throw new Error('randomness used'); };
        try {
            expect(() => assess(input)).not.toThrow();
        } finally {
            Date.now = realNow;
            Math.random = realRandom;
        }
    });

    it('changes only with the supplied time', () => {
        const later = assessSpoilageRisk(input, new Date(NOW.getTime() + 30 * MIN));
        expect(later.estimatedSafeUntil).toBe(assess(input).estimatedSafeUntil);
        expect(later.minutesRemaining).toBe(assess(input).minutesRemaining - 30);
    });

    it.each(Object.values(RISK_LEVELS))('never claims food is safe (%s wording)', (level) => {
        const ages = { LOW: 10, MEDIUM: 100, HIGH: 150, EXPIRED: 400 };
        const result = assess(rice({ preparedTime: minutesAgo(ages[level]) }));
        expect(result.riskLevel).toBe(level);
        const text = `${result.reasons.join(' ')} ${result.disclaimer}`;
        expect(text).not.toMatch(/safe to (eat|consume|serve)/i);
        expect(text).not.toMatch(/(is|are) (definitely|certainly|completely|100%) safe/i);
        expect(text).not.toMatch(/\bcertified\b/i);
        expect(result.isEstimate).toBe(true);
    });
});
