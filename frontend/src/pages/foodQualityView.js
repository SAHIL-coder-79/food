// Pure helpers for the Food Quality Check feature: client-side file validation and shaping the backend's
// screening response for display. No DOM/File API dependency - `file` only needs `.size`/`.type`, so this is
// testable with plain objects and works the same for a real File selected in the browser.

export const SUPPORTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Mirrors backend/src/ai/foodQuality/service.js's MIN_IMAGE_BYTES/MAX_IMAGE_BYTES so a bad file is rejected
// immediately, before spending a network round trip on it.
export const MIN_FILE_BYTES = 16;
export const MAX_FILE_BYTES = 300000;

export function validateFile(file) {
  if (!file) {
    return { ok: false, message: 'Choose an image first.' };
  }
  if (!SUPPORTED_MIME_TYPES.includes(file.type)) {
    return { ok: false, message: 'Unsupported file type. Please choose a JPEG, PNG or WEBP image.' };
  }
  if (file.size < MIN_FILE_BYTES) {
    return { ok: false, message: 'That image file looks empty or corrupted. Please choose another.' };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, message: `Image is too large (max ${Math.round(MAX_FILE_BYTES / 1024)} KB) - please use a smaller or more compressed photo.` };
  }
  return { ok: true, message: '' };
}

const CLASSIFICATION_LABEL = {
  FRESH: 'Looks fresh',
  USE_SOON: 'Use soon',
  QUESTIONABLE: 'Looks questionable',
  UNKNOWN: 'Could not assess',
};

const CLASSIFICATION_BADGE = {
  FRESH: 'badge-success',
  USE_SOON: 'badge-warning',
  QUESTIONABLE: 'badge-danger',
  UNKNOWN: 'badge-neutral',
};

// Shapes the API's { classification, confidence, signals, recommendation, disclaimer, provider, imageFormat,
// context? } into a display-ready object. Never invents a value the backend did not return.
export function buildResultView(data) {
  if (!data) return null;
  const classification = data.classification;
  return {
    classification,
    classificationLabel: CLASSIFICATION_LABEL[classification] || classification,
    badgeClass: CLASSIFICATION_BADGE[classification] || 'badge-neutral',
    confidencePercent: Number.isFinite(data.confidence) ? Math.round(data.confidence * 100) : null,
    signals: Array.isArray(data.signals) ? data.signals : [],
    recommendation: data.recommendation || '',
    disclaimer: data.disclaimer || '',
    isUnknown: classification === 'UNKNOWN',
    context: data.context || null,
  };
}
