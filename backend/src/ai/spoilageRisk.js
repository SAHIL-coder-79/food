'use strict';

/**
 * Rule-based spoilage-risk ESTIMATOR (pure: no I/O, no randomness; the current time is always passed in).
 *
 * IMPORTANT: this is an estimate built from rule-of-thumb holding windows for cooked food. It is NOT a
 * food-safety certification, never states that food is safe, and never blocks a donation on its own -
 * staff keep the final say (they can always supply their own safe-until time).
 *
 *   window   = base hours for the food category (at ~20-29 C)
 *              x temperature factor (missing temperature is treated as a WARM holding temperature)
 *              x large-quantity factor (big batches cool slowly)
 *   safe-until estimate = preparation time + window
 *   risk     = EXPIRED once the window has passed; HIGH from 75% of the window used (or <= 30 min left);
 *              MEDIUM from 50%; otherwise LOW. A declared (staff) safe-until time can only RAISE the
 *              risk (already passed -> EXPIRED, <= 30 min left -> at least HIGH), never lower it.
 */

const HOUR_MS = 3600000;
const MINUTE_MS = 60000;

const RISK_LEVELS = Object.freeze({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', EXPIRED: 'EXPIRED' });

const DISCLAIMER =
    'Estimate only, based on general rules of thumb. This is not a food-safety certification and does not mean the food is safe or unsafe. Staff must check the food and apply local food-safety rules.';

// Base holding window (hours) at roughly 20-29 C, cooked/ready-to-eat food.
const CATEGORY_WINDOWS_HOURS = Object.freeze({
    meat_fish_egg: 2,
    dairy_or_cream: 2,
    cooked_rice_grain: 3,
    fresh_raw: 3,
    unclassified: 3,
    curry_dal_gravy: 4,
    bread_or_flatbread: 6,
    fried_snack: 6,
    sweets_baked: 12,
    packaged_shelf_stable: 24,
});

const CATEGORY_LABELS = Object.freeze({
    meat_fish_egg: 'meat, fish or egg dishes',
    dairy_or_cream: 'dairy or cream-based food',
    cooked_rice_grain: 'cooked rice, grains or noodles',
    fresh_raw: 'fresh or raw food',
    unclassified: 'unrecognised food type',
    curry_dal_gravy: 'curries, dals and gravies',
    bread_or_flatbread: 'breads and flatbreads',
    fried_snack: 'fried snacks',
    sweets_baked: 'sweets and baked goods',
    packaged_shelf_stable: 'sealed or packaged food',
});

// Singular keywords; tokens are matched after stripping a trailing "s"/"es".
const CATEGORY_KEYWORDS = Object.freeze({
    meat_fish_egg: ['chicken', 'mutton', 'lamb', 'beef', 'pork', 'fish', 'prawn', 'shrimp', 'egg', 'keema', 'kebab', 'kabab', 'seafood', 'meat', 'nonveg', 'omelette', 'omelet'],
    dairy_or_cream: ['milk', 'curd', 'yogurt', 'yoghurt', 'dahi', 'raita', 'lassi', 'buttermilk', 'chaas', 'paneer', 'cheese', 'cream', 'kheer', 'custard', 'rabri', 'rasmalai', 'rasgulla', 'kulfi', 'pudding', 'khoa', 'mawa', 'milkshake'],
    cooked_rice_grain: ['rice', 'biryani', 'biriyani', 'pulao', 'pulav', 'pilaf', 'khichdi', 'khichri', 'pasta', 'noodle', 'chowmein', 'poha', 'upma', 'chawal', 'macaroni', 'porridge', 'daliya'],
    fresh_raw: ['salad', 'sprout', 'chaat', 'juice', 'fruit', 'coleslaw'],
    curry_dal_gravy: ['dal', 'daal', 'curry', 'sambar', 'sambhar', 'rasam', 'sabzi', 'sabji', 'subzi', 'gravy', 'soup', 'stew', 'rajma', 'chole', 'chana', 'kadhi', 'korma', 'masala', 'bhaji', 'vegetable'],
    bread_or_flatbread: ['roti', 'chapati', 'chapatti', 'phulka', 'paratha', 'parantha', 'naan', 'puri', 'poori', 'bread', 'bun', 'pav', 'dosa', 'idli', 'uttapam', 'thepla', 'kulcha'],
    fried_snack: ['samosa', 'pakora', 'pakoda', 'bhajia', 'bhajiya', 'vada', 'vadai', 'kachori', 'fries', 'cutlet', 'tikki', 'nugget'],
    sweets_baked: ['laddu', 'ladoo', 'halwa', 'jalebi', 'jamun', 'barfi', 'burfi', 'peda', 'sweet', 'mithai', 'cake', 'cookie', 'pastry', 'muffin', 'brownie'],
    packaged_shelf_stable: ['packaged', 'packet', 'sealed', 'biscuit', 'cracker', 'cereal', 'bottled', 'canned', 'tetra', 'wafer'],
});

const MIN_WINDOW_HOURS = 0.5;
const ASSUMED_TEMPERATURE_FACTOR = 0.85; // missing temperature -> assume a warm (30-35 C) holding temperature
const HIGH_FRACTION = 0.75;
const MEDIUM_FRACTION = 0.5;
const HIGH_REMAINING_MS = 30 * MINUTE_MS;
const DECLARED_DIFFERENCE_NOTE_MS = 15 * MINUTE_MS;

class SpoilageInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SpoilageInputError';
    }
}

const round = (value, decimals) => {
    const factor = 10 ** decimals;
    const r = Math.round(value * factor) / factor;
    return r === 0 ? 0 : r;
};

function tokenize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/non[\s-]+veg/g, 'nonveg')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter(Boolean);
}

function tokenForms(token) {
    const forms = [token];
    if (token.endsWith('es')) forms.push(token.slice(0, -2));
    if (token.endsWith('s')) forms.push(token.slice(0, -1));
    return forms;
}

/**
 * Infers a coarse category from free-text food type. When several categories match (e.g. "dal rice"),
 * the most perishable (shortest window) wins, ties broken alphabetically - conservative and deterministic.
 */
function classifyFoodCategory(foodType) {
    const tokens = new Set(tokenize(foodType).flatMap(tokenForms));
    const matches = [];
    Object.entries(CATEGORY_KEYWORDS).forEach(([category, keywords]) => {
        const keyword = keywords.find((k) => tokens.has(k));
        if (keyword) matches.push({ category, keyword });
    });

    if (matches.length === 0) {
        return { category: 'unclassified', recognised: false, keyword: null, alternatives: [] };
    }
    matches.sort((a, b) => CATEGORY_WINDOWS_HOURS[a.category] - CATEGORY_WINDOWS_HOURS[b.category] || (a.category < b.category ? -1 : 1));
    return {
        category: matches[0].category,
        recognised: true,
        keyword: matches[0].keyword,
        alternatives: matches.slice(1).map((m) => m.category),
    };
}

function temperatureFactor(celsius) {
    if (celsius === null) return { factor: ASSUMED_TEMPERATURE_FACTOR, band: 'assumed warm', assumed: true };
    if (celsius >= 40) return { factor: 0.5, band: 'very hot', assumed: false };
    if (celsius >= 35) return { factor: 0.7, band: 'hot', assumed: false };
    if (celsius >= 30) return { factor: 0.85, band: 'warm', assumed: false };
    if (celsius >= 20) return { factor: 1, band: 'room temperature', assumed: false };
    if (celsius >= 10) return { factor: 1.3, band: 'cool', assumed: false };
    return { factor: 2, band: 'cold', assumed: false };
}

function quantityFactor(quantity) {
    if (quantity === null) return 1;
    if (quantity >= 200) return 0.8;
    if (quantity >= 50) return 0.9;
    return 1;
}

function optionalDate(value, name) {
    if (value === undefined || value === null || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new SpoilageInputError(`${name} is not a valid date/time`);
    return date;
}

function optionalNumber(value, name) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new SpoilageInputError(`${name} must be a number`);
    return n;
}

function formatDuration(ms) {
    const totalMinutes = Math.round(Math.abs(ms) / MINUTE_MS);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes}m`;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

const RISK_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, EXPIRED: 3 };
const raiseTo = (current, candidate) => (RISK_ORDER[candidate] > RISK_ORDER[current] ? candidate : current);

const RISK_STATEMENTS = {
    LOW: 'Estimated spoilage risk is low at this point. This is not a guarantee that the food is safe.',
    MEDIUM: 'Estimated spoilage risk is moderate; arrange quick pickup and have staff check the food before handing it over.',
    HIGH: 'Estimated spoilage risk is high because the estimated window is nearly used up; staff should check the food before handing it over.',
    EXPIRED: 'The estimated window has passed; staff should check the food carefully before deciding whether it can still be donated.',
};

/**
 * @param {Object} input { foodType, quantity?, preparedTime?, safeUntilTime? (declared by staff), ambientTemperatureC? }
 * @param {Date|string|number} now the assessment time (injected so results are reproducible)
 */
function assessSpoilageRisk(input, now) {
    const data = input || {};
    const nowDate = optionalDate(now, 'now');
    if (!nowDate) throw new SpoilageInputError('The assessment time is required');

    const preparedAt = optionalDate(data.preparedTime, 'preparedTime');
    const declared = optionalDate(data.safeUntilTime, 'safeUntilTime');
    if (!preparedAt && !declared) {
        throw new SpoilageInputError('Provide preparedTime and/or safeUntilTime so spoilage risk can be estimated');
    }

    let ambient = optionalNumber(data.ambientTemperatureC, 'ambientTemperatureC');
    if (ambient !== null) ambient = Math.min(60, Math.max(-30, ambient));
    const quantityRaw = optionalNumber(data.quantity, 'quantity');
    const quantity = quantityRaw !== null && quantityRaw > 0 ? quantityRaw : null;

    const category = classifyFoodCategory(data.foodType);
    const baseHours = CATEGORY_WINDOWS_HOURS[category.category];
    const temperature = temperatureFactor(ambient);
    const qtyFactor = quantityFactor(quantity);
    const windowMs = Math.round(Math.max(MIN_WINDOW_HOURS, baseHours * temperature.factor * qtyFactor) * HOUR_MS);
    const windowHours = round(windowMs / HOUR_MS, 2);

    const reasons = [];
    const foodLabel = String(data.foodType || '').trim();

    // 1. category
    if (category.recognised) {
        let text = `Food type "${foodLabel}" was matched to ${CATEGORY_LABELS[category.category]} (keyword "${category.keyword}"), with a base window of ${baseHours}h at room temperature.`;
        if (category.alternatives.length > 0) text += ' Several categories matched, so the most perishable one was used.';
        reasons.push(text);
    } else {
        reasons.push(`Food type "${foodLabel}" was not recognised, so a cautious default window of ${baseHours}h was used.`);
    }

    // 2. temperature
    if (temperature.assumed) {
        reasons.push(`No holding temperature was provided, so a warm temperature was assumed (window x${temperature.factor}).`);
    } else {
        reasons.push(`Holding temperature ${ambient}°C (${temperature.band}) changes the window by x${temperature.factor}.`);
    }

    // 3. quantity
    if (qtyFactor !== 1) {
        reasons.push(`A large quantity (${quantity}) cools slowly, so the window was shortened by x${qtyFactor}.`);
    }

    // 4. timing + classification
    let riskLevel;
    let estimatedSafeUntil;
    let estimatedSafeUntilSource;
    let minutesRemaining;

    if (preparedAt) {
        estimatedSafeUntil = new Date(preparedAt.getTime() + windowMs);
        estimatedSafeUntilSource = 'category_rule';
        const elapsedMs = Math.max(0, nowDate.getTime() - preparedAt.getTime());
        const remainingMs = estimatedSafeUntil.getTime() - nowDate.getTime();
        minutesRemaining = Math.round(remainingMs / MINUTE_MS);
        const usedFraction = elapsedMs / windowMs;

        if (preparedAt.getTime() > nowDate.getTime()) {
            reasons.push('The preparation time is in the future, so elapsed time was treated as zero.');
        }
        if (remainingMs <= 0) {
            riskLevel = RISK_LEVELS.EXPIRED;
            reasons.push(`Prepared ${formatDuration(elapsedMs)} ago, which is beyond the estimated ${windowHours}h window.`);
        } else {
            if (remainingMs <= HIGH_REMAINING_MS || usedFraction >= HIGH_FRACTION) riskLevel = RISK_LEVELS.HIGH;
            else if (usedFraction >= MEDIUM_FRACTION) riskLevel = RISK_LEVELS.MEDIUM;
            else riskLevel = RISK_LEVELS.LOW;
            reasons.push(`Prepared ${formatDuration(elapsedMs)} ago; about ${formatDuration(remainingMs)} remain of the estimated ${windowHours}h window (${Math.round(usedFraction * 100)}% used).`);
        }
    } else {
        estimatedSafeUntil = declared;
        estimatedSafeUntilSource = 'declared_safe_until';
        const remainingMs = declared.getTime() - nowDate.getTime();
        minutesRemaining = Math.round(remainingMs / MINUTE_MS);
        reasons.push('The preparation time was not provided, so the estimate relies only on the declared safe-until time.');
        if (remainingMs <= 0) {
            riskLevel = RISK_LEVELS.EXPIRED;
        } else if (remainingMs <= HIGH_REMAINING_MS || remainingMs / windowMs <= 0.25) {
            riskLevel = RISK_LEVELS.HIGH;
        } else if (remainingMs / windowMs <= 0.5) {
            riskLevel = RISK_LEVELS.MEDIUM;
        } else {
            riskLevel = RISK_LEVELS.LOW;
        }
        if (remainingMs > 0) reasons.push(`About ${formatDuration(remainingMs)} remain until the declared safe-until time.`);
    }

    // 5. a declared (staff) safe-until time can only raise the risk, never lower it
    if (preparedAt && declared) {
        const declaredRemainingMs = declared.getTime() - nowDate.getTime();
        const differenceMs = declared.getTime() - estimatedSafeUntil.getTime();
        if (declaredRemainingMs <= 0) {
            riskLevel = raiseTo(riskLevel, RISK_LEVELS.EXPIRED);
            reasons.push('The declared safe-until time has already passed.');
        } else if (declaredRemainingMs <= HIGH_REMAINING_MS) {
            riskLevel = raiseTo(riskLevel, RISK_LEVELS.HIGH);
            reasons.push(`Only ${formatDuration(declaredRemainingMs)} remain until the declared safe-until time.`);
        }
        if (differenceMs > DECLARED_DIFFERENCE_NOTE_MS) {
            reasons.push(`The declared safe-until time is ${formatDuration(differenceMs)} later than this estimate. The estimate is deliberately conservative; the declared time remains a staff decision and does not lower the estimated risk.`);
        } else if (differenceMs < -DECLARED_DIFFERENCE_NOTE_MS) {
            reasons.push(`The declared safe-until time is ${formatDuration(differenceMs)} earlier than this estimate.`);
        }
    }

    reasons.push(RISK_STATEMENTS[riskLevel]);

    // confidence: how much of the input the estimate actually rests on (never above 0.9, never certain)
    let confidence = 0.3;
    if (category.recognised) confidence += 0.25;
    if (preparedAt) confidence += 0.3;
    if (ambient !== null) confidence += 0.1;
    confidence = round(Math.min(0.9, confidence), 2);

    const factorsUsed = [
        { factor: 'food_category', value: category.category, effect: `base window ${baseHours}h${category.recognised ? '' : ' (default for unrecognised food)'}` },
        { factor: 'current_time', value: nowDate.toISOString(), effect: 'used to measure elapsed and remaining time' },
    ];
    const factorsNotProvided = [];
    if (preparedAt) factorsUsed.push({ factor: 'preparation_time', value: preparedAt.toISOString(), effect: 'start of the estimated window' });
    else factorsNotProvided.push('preparation_time');
    if (ambient !== null) factorsUsed.push({ factor: 'ambient_temperature', value: ambient, effect: `window x${temperature.factor} (${temperature.band})` });
    else factorsNotProvided.push('ambient_temperature');
    if (quantity !== null) factorsUsed.push({ factor: 'quantity', value: quantity, effect: qtyFactor === 1 ? 'no adjustment' : `window x${qtyFactor}` });
    else factorsNotProvided.push('quantity');
    if (declared) factorsUsed.push({ factor: 'declared_safe_until', value: declared.toISOString(), effect: preparedAt ? 'can only raise the estimated risk' : 'only time basis available' });

    return {
        riskLevel,
        estimatedSafeUntil: estimatedSafeUntil.toISOString(),
        estimatedSafeUntilSource,
        minutesRemaining,
        confidence,
        reasons,
        factorsUsed,
        factorsNotProvided,
        isEstimate: true,
        category: category.category,
        safeWindowHours: windowHours,
        assessedAt: nowDate.toISOString(),
        disclaimer: DISCLAIMER,
    };
}

module.exports = {
    RISK_LEVELS,
    DISCLAIMER,
    CATEGORY_WINDOWS_HOURS,
    SpoilageInputError,
    classifyFoodCategory,
    assessSpoilageRisk,
};
