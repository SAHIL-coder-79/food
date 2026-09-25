'use strict';

const dailyLogModel = require('../../models/dailyLogModel');
const AppError = require('../../utils/AppError');
const { getProvider } = require('./provider');

// Decision-support only: this screening NEVER creates, blocks or approves a surplus listing or a daily log by
// itself. It is a standalone, advisory read - exactly like the existing spoilage-risk estimate - that a kitchen
// may optionally consult before deciding what to do with an item.
const DISCLAIMER =
    'This is an automated VISUAL SCREENING AID only, not a food-safety certification or guarantee. It cannot ' +
    'detect bacteria, pathogens, allergens or hidden spoilage, and it does not confirm whether food is safe or ' +
    "unsafe to eat. Always use manual inspection and your organization's food-safety procedures before deciding " +
    'to prepare, serve, donate or discard food.';

const SUPPORTED_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const MIN_IMAGE_BYTES = 16; // shorter than this cannot even contain a recognisable image header
// Deliberately small: this is a lightweight screening aid, not a place to accept full-resolution photos. The
// frontend asks for/validates a compact photo before sending; ~300 KB is generous for a small JPEG/PNG thumbnail.
const MAX_IMAGE_BYTES = Number(process.env.FOOD_QUALITY_MAX_IMAGE_BYTES) > 0 ? Number(process.env.FOOD_QUALITY_MAX_IMAGE_BYTES) : 300000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// Recognises a small, fixed set of image formats from their own bytes (magic numbers) - the declared mimeType is
// checked too (fast, clear error for an obviously wrong content type), but this is the authoritative check: a
// client cannot get arbitrary bytes treated as an image just by lying about mimeType.
function sniffImageFormat(buffer) {
    if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
}

function decodeImage({ imageBase64, mimeType }) {
    if (typeof mimeType !== 'string' || !SUPPORTED_MIME_TYPES.includes(mimeType)) {
        throw new AppError(400, `mimeType must be one of: ${SUPPORTED_MIME_TYPES.join(', ')}`);
    }
    if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
        throw new AppError(400, 'imageBase64 is required');
    }
    const cleaned = imageBase64.replace(/\s+/g, '');
    if (!BASE64_PATTERN.test(cleaned)) {
        throw new AppError(400, 'imageBase64 must be valid base64-encoded image data');
    }

    const buffer = Buffer.from(cleaned, 'base64');
    if (buffer.length < MIN_IMAGE_BYTES) {
        throw new AppError(400, 'Image data is too small to be a valid image');
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new AppError(400, `Image is too large (max ${Math.round(MAX_IMAGE_BYTES / 1024)} KB) - please use a smaller or more compressed photo`);
    }

    const format = sniffImageFormat(buffer);
    if (!format) {
        throw new AppError(400, 'The image data does not look like a supported image format (JPEG, PNG or WEBP)');
    }
    return { buffer, format };
}

// Optional context: a kitchen may screen a photo against a specific daily log it already recorded (e.g. today's
// leftover of a menu item), the same optional-linkage pattern surplus listings already use for dailyLogId.
// Organization-scoped: a log that exists but belongs to another organization is refused exactly like every other
// cross-organization access in this app (403, not a silent 404 that would hint at whether the id exists).
async function loadContext(actingUser, dailyLogId) {
    if (dailyLogId === undefined || dailyLogId === null) return null;
    const log = await dailyLogModel.findById(dailyLogId);
    if (!log) {
        throw new AppError(404, 'Daily log not found');
    }
    if (log.kitchen_org_id !== actingUser.organizationId) {
        throw new AppError(403, 'You do not have permission to perform this action');
    }
    return { dailyLogId: log.id, menuItemName: log.menu_item_name, logDate: log.log_date };
}

/**
 * Screens one food image and returns a decision-support (never decision-making) result. Nothing is persisted:
 * the image is decoded, assessed, and discarded within this call - the existing application has no image storage,
 * and this feature does not add any.
 */
async function screenFoodImage(actingUser, payload) {
    const { buffer, format } = decodeImage(payload);
    const context = await loadContext(actingUser, payload.dailyLogId);

    const provider = getProvider();
    const result = provider.assess({ buffer, format });

    const response = {
        classification: result.classification,
        confidence: result.confidence,
        signals: result.signals,
        recommendation: result.recommendation,
        disclaimer: DISCLAIMER,
        provider: provider.name,
        imageFormat: format,
    };
    if (context) response.context = context;
    return response;
}

module.exports = {
    screenFoodImage,
    decodeImage,
    sniffImageFormat,
    DISCLAIMER,
    SUPPORTED_MIME_TYPES,
    MIN_IMAGE_BYTES,
    MAX_IMAGE_BYTES,
};
