'use strict';

/**
 * Deterministic, offline mock FoodQualityProvider (see provider.js for the interface contract).
 *
 * This is NOT computer vision: it does not look at pixels, and it is not a food-safety judgement of any kind. It
 * derives a stable, reproducible result from the image bytes themselves (a fast hash seeds a small deterministic
 * PRNG), so the SAME uploaded image always gets the SAME classification/confidence/signals - useful for a
 * demo/offline environment where a real model is unavailable, while keeping the exact interface a real
 * MobileNetV2/EfficientNet-Lite provider would implement later (see provider.js).
 *
 * A very small/low-detail image (few bytes of actual image data) always returns UNKNOWN: there is deliberately no
 * code path that turns "barely any data" into a confident answer.
 */

const CLASSIFICATIONS = Object.freeze({ FRESH: 'FRESH', USE_SOON: 'USE_SOON', QUESTIONABLE: 'QUESTIONABLE', UNKNOWN: 'UNKNOWN' });

// Below this many bytes of actual image data, treat the image as too low-detail to assess confidently (a tiny
// solid-colour or near-blank image, for example) - independent of what the hash-based banding below would say.
const LOW_DETAIL_BYTES = 3000;

// Cumulative probability bands the seeded PRNG falls into (mock "model confidence distribution").
const BANDS = [
    { upTo: 0.35, classification: CLASSIFICATIONS.FRESH },
    { upTo: 0.65, classification: CLASSIFICATIONS.USE_SOON },
    { upTo: 0.85, classification: CLASSIFICATIONS.QUESTIONABLE },
    { upTo: 1.01, classification: CLASSIFICATIONS.UNKNOWN }, // remaining ~15%: a real model would not always be confident either
];

const CONFIDENCE_RANGE = {
    FRESH: [0.75, 0.95],
    USE_SOON: [0.55, 0.8],
    QUESTIONABLE: [0.5, 0.75],
    UNKNOWN: [0.15, 0.4], // low by definition - "unknown" is a low-confidence result, not a hidden guess
};

const SIGNAL_POOL = {
    FRESH: ['even colour and texture', 'no visible spoilage indicators', 'surface looks moist and fresh', 'appearance typical for this kind of food'],
    USE_SOON: ['slight surface drying', 'minor colour change at the edges', 'texture appears slightly altered', 'some visible moisture loss'],
    QUESTIONABLE: ['visible discoloration', 'surface appearance changed', 'possible texture change', 'spots or patches visible', 'unusual surface sheen'],
    UNKNOWN: ['image too small or low-detail to assess confidently', 'lighting or angle makes assessment unreliable', 'food is not clearly visible in the frame'],
};

const RECOMMENDATION = {
    FRESH: 'Food appears visually acceptable in this screening. Continue routine handling and monitoring.',
    USE_SOON: 'Consider using this item soon, or perform a manual quality inspection before deciding.',
    QUESTIONABLE: 'Recommend a manual quality check before deciding whether to prepare, serve or donate this food.',
    UNKNOWN: "The visual screening could not produce a confident result. Rely on manual inspection and your organization's standard food-safety judgement.",
};

function fnv1a(buffer) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < buffer.length; i += 1) {
        hash ^= buffer[i];
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

// mulberry32: the same small deterministic PRNG used elsewhere in this project wherever reproducible "randomness"
// is needed (see tests/helpers/forecastFixtures.js, scripts/demo/seedDemo.js) - no dependency, fast, seedable.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a += 0x6d2b79f5;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

function pickDistinct(pool, count, rng) {
    const remaining = pool.slice();
    const picked = [];
    for (let i = 0; i < count && remaining.length > 0; i += 1) {
        const index = Math.floor(rng() * remaining.length);
        picked.push(remaining.splice(index, 1)[0]);
    }
    return picked;
}

function classificationFor(rng) {
    const roll = rng();
    return BANDS.find((band) => roll < band.upTo).classification;
}

function assess({ buffer }) {
    const rng = mulberry32(fnv1a(buffer));
    const lowDetail = buffer.length < LOW_DETAIL_BYTES;
    const classification = lowDetail ? CLASSIFICATIONS.UNKNOWN : classificationFor(rng);

    const [low, high] = CONFIDENCE_RANGE[classification];
    const confidence = round(low + rng() * (high - low), 2);

    const signalCount = classification === CLASSIFICATIONS.UNKNOWN ? (lowDetail ? 1 : 2) : 2 + Math.floor(rng() * 2); // 2-3 signals
    const signals = pickDistinct(SIGNAL_POOL[classification], signalCount, rng);
    if (lowDetail && !signals.includes(SIGNAL_POOL.UNKNOWN[0])) signals.unshift(SIGNAL_POOL.UNKNOWN[0]);

    return {
        classification,
        confidence,
        signals,
        recommendation: RECOMMENDATION[classification],
    };
}

module.exports = { name: 'mock', assess, CLASSIFICATIONS };
