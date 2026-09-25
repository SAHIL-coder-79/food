'use strict';

/**
 * FoodQualityProvider interface.
 *
 * A provider is any module exporting:
 *   { name: string, assess({ buffer, format }) => { classification, confidence, signals, recommendation } }
 *
 *   - buffer: a Buffer of the image bytes. Already validated by service.js (a supported, size-bounded image) by
 *     the time a provider sees it - a provider should not need to re-validate size/format.
 *   - format: 'jpeg' | 'png' | 'webp', sniffed from the bytes themselves (never the client's declared mimeType).
 *   - classification: one of 'FRESH' | 'USE_SOON' | 'QUESTIONABLE' | 'UNKNOWN'.
 *   - confidence: a number in [0, 1]. Never a claim of certainty; a real provider's own model score.
 *   - signals: an array of short, plain-language visual observations that led to the classification.
 *   - recommendation: a short, non-alarming, advisory sentence. Never "reject" or "approve" the food outright -
 *     this is a decision-support signal for a human, not an automated accept/reject gate.
 *   - Must be side-effect free: no network calls, no writes, no reliance on the clock or on external state, so
 *     the same image always produces the same result (this is what "deterministic" means here).
 *   - Must return UNKNOWN, with a correspondingly low confidence and an explanatory signal, whenever it cannot
 *     confidently assess the image - never fabricate a confident answer to avoid returning UNKNOWN.
 *
 * Today only a deterministic mock provider exists (mockProvider.js), suited to this offline/demo environment: no
 * model download, no GPU, no external dependency. A real provider (e.g. a MobileNetV2/EfficientNet-Lite model
 * loaded once at startup) could implement this exact same interface later - service.js and the API layer would
 * not need to change, only PROVIDERS below and the FOOD_QUALITY_PROVIDER environment variable.
 */

const PROVIDERS = {
    mock: require('./mockProvider'),
};

function getProvider(name) {
    const key = name || process.env.FOOD_QUALITY_PROVIDER || 'mock';
    const provider = PROVIDERS[key];
    if (!provider) {
        throw new Error(`Unknown food quality provider: "${key}" (available: ${Object.keys(PROVIDERS).join(', ')})`);
    }
    return provider;
}

module.exports = { getProvider, PROVIDERS };
