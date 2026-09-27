const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const REQUIRED_VARS = ['DATABASE_URL', 'JWT_SECRET'];
const MIN_PRODUCTION_SECRET_LENGTH = 32;

function validateEnv() {
    if (process.env.NODE_ENV === 'test') {
        return; // tests provide their own env via tests/setup.js
    }

    const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variable(s): ${missing.join(', ')}. ` +
                'Copy .env.example to .env and fill in real values.'
        );
    }

    // A short signing secret can be brute-forced offline from any issued token.
    if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET.length < MIN_PRODUCTION_SECRET_LENGTH) {
        throw new Error(
            `JWT_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production. ` +
                "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
        );
    }

    // Task 21: if a deployment explicitly asks for the real Meta provider, it must actually be configured -
    // never silently fall back to the mock provider (which would look "successful" while quietly sending
    // nothing real anywhere). This fails fast at startup, the same way a missing DATABASE_URL does above.
    if (process.env.MESSAGING_ENABLED === 'true' && (process.env.MESSAGING_PROVIDER || 'mock') === 'meta') {
        const requiredMetaVars = [
            'META_WHATSAPP_VERIFY_TOKEN',
            'META_WHATSAPP_APP_SECRET',
            'META_WHATSAPP_ACCESS_TOKEN',
            'META_WHATSAPP_PHONE_NUMBER_ID',
        ];
        const missingMeta = requiredMetaVars.filter((key) => !process.env[key]);
        if (missingMeta.length > 0) {
            throw new Error(
                `MESSAGING_PROVIDER=meta requires the following environment variable(s), which are missing: ` +
                    `${missingMeta.join(', ')}. Set them in .env, or use MESSAGING_PROVIDER=mock for local/demo use.`
            );
        }
    }
}

validateEnv();

module.exports = {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 5000,
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    bcryptSaltRounds: Number(process.env.BCRYPT_SALT_ROUNDS) || 10,
    nearExpiryThresholdMinutes: Number(process.env.NEAR_EXPIRY_THRESHOLD_MINUTES) || 60,

    // Deterministic Rescue Route Planning (Task 18) - see ai/rescueRoutePlanner.js. All estimates, never a real
    // navigation/traffic feed; kept configurable rather than hard-coded so the assumption is visible and tunable.
    rescueRouteMaxStops: Number(process.env.RESCUE_ROUTE_MAX_STOPS) || 25,
    // Typical two/three-wheeler urban delivery speed in mixed traffic - a planning assumption, not a live estimate.
    rescueRouteAverageSpeedKmh: Number(process.env.RESCUE_ROUTE_AVERAGE_SPEED_KMH) || 25,
    // Time assumed spent at each stop loading the donation, added to the next leg's start time.
    rescueRoutePickupServiceMinutes: Number(process.env.RESCUE_ROUTE_PICKUP_SERVICE_MINUTES) || 10,
    // A stop whose estimated arrival is within this many minutes of its safe-until time (but not past it) is
    // flagged AT_RISK rather than SAFE, so a tight-but-technically-OK estimate still reads as a warning.
    rescueRouteAtRiskBufferMinutes: Number(process.env.RESCUE_ROUTE_AT_RISK_BUFFER_MINUTES) || 30,
    // When two candidate stops' safe-until times differ by more than this, the more urgent one is sequenced
    // first regardless of distance; otherwise the nearer stop wins. See rescueRoutePlanner.js selectNextStop.
    rescueRouteUrgencyTieBreakMinutes: Number(process.env.RESCUE_ROUTE_URGENCY_TIE_BREAK_MINUTES) || 45,

    // WhatsApp/SMS rescue notification (Task 19) - see integrations/communication/. Disabled by default: a
    // fresh clone/demo works with zero external credentials, and turning it on never requires anything beyond
    // this flag while only the mock provider exists.
    communicationEnabled: process.env.COMMUNICATION_ENABLED === 'true',
    communicationProvider: process.env.COMMUNICATION_PROVIDER || 'mock',
    communicationDefaultChannel: process.env.COMMUNICATION_DEFAULT_CHANNEL || 'whatsapp',
    // Placeholders for a future real provider (e.g. WhatsApp Cloud API). Never required, never logged, and
    // unused while COMMUNICATION_PROVIDER=mock - see integrations/communication/provider.js.
    communicationApiKey: process.env.COMMUNICATION_API_KEY || null,
    communicationApiUrl: process.env.COMMUNICATION_API_URL || null,
    // How many top-ranked NGO matches (see ai/ngoMatching.js) get notified for one rescue notification request -
    // an abuse/flood guard so a listing can never fan out to an unbounded number of recipients.
    rescueNotificationMaxRecipients: Number(process.env.RESCUE_NOTIFICATION_MAX_RECIPIENTS) || 10,
    // Minimum time between two notification sends for the SAME listing, regardless of who requests it.
    rescueNotificationCooldownMs: Number(process.env.RESCUE_NOTIFICATION_COOLDOWN_MS) || 5 * 60 * 1000,

    // FoodShare Conversational Assistant (Task 20) - see integrations/messaging/ and ai/conversationalAssistant/.
    // Disabled by default, exactly like the Task 19 communication layer: only the deterministic mock provider
    // exists, and the webhook/parsing/confirmation logic works fully offline with zero external credentials.
    messagingEnabled: process.env.MESSAGING_ENABLED === 'true',
    messagingProvider: process.env.MESSAGING_PROVIDER || 'mock',
    // Shared secret a provider's webhook call must present (see integrations/messaging/mockProvider.js
    // verifyWebhook). Left blank by default for frictionless local/mock testing; a real provider integration
    // would instead verify a cryptographic signature (e.g. Meta's X-Hub-Signature-256) - see the README.
    messagingWebhookSecret: process.env.MESSAGING_WEBHOOK_SECRET || '',
    // How long a pending "awaiting confirmation" (or "still collecting details") conversation stays alive
    // before it silently expires and the user has to start over.
    messagingSessionTtlMinutes: Number(process.env.MESSAGING_SESSION_TTL_MINUTES) || 10,
    messagingRateLimitMax: Number(process.env.MESSAGING_RATE_LIMIT_MAX) || 30,
    messagingRateLimitWindowMs: Number(process.env.MESSAGING_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    // A WhatsApp-linking code (see services/messagingIdentityService.js) is only valid to redeem for this long.
    messagingLinkRequestTtlMinutes: Number(process.env.MESSAGING_LINK_REQUEST_TTL_MINUTES) || 10,

    // Real Meta WhatsApp Cloud API (Task 21) - see integrations/messaging/metaProvider.js. Only used when
    // MESSAGING_PROVIDER=meta; every value here is server-side only and is never sent to the frontend, logged,
    // or returned in any API response. Never committed - see .env.example for placeholders only.
    // GET /api/messaging/webhook verification (hub.verify_token) - a value YOU choose and enter into the Meta
    // App Dashboard's webhook configuration; never hard-coded.
    metaWhatsappVerifyToken: process.env.META_WHATSAPP_VERIFY_TOKEN || '',
    // The Meta App's own secret, used to HMAC-SHA256-verify the X-Hub-Signature-256 header on every inbound
    // POST webhook - see the current Meta Graph API webhooks documentation for the exact mechanism.
    metaWhatsappAppSecret: process.env.META_WHATSAPP_APP_SECRET || '',
    // A System User or temporary access token for the WhatsApp Business Account, used as the Bearer token when
    // calling the Cloud API's own /messages endpoint to send a reply.
    metaWhatsappAccessToken: process.env.META_WHATSAPP_ACCESS_TOKEN || '',
    metaWhatsappPhoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || '',
    // Graph API version - kept configurable (never hard-coded elsewhere) since Meta regularly deprecates old
    // versions on a rolling schedule. Verify the current version at
    // https://developers.facebook.com/docs/graph-api/changelog before deploying.
    // v26.0 was Meta's current Graph API version at the time this integration was written (verified against
    // https://developers.facebook.com/docs/graph-api/changelog) - re-check before relying on this default.
    metaGraphApiVersion: process.env.META_WHATSAPP_GRAPH_API_VERSION || 'v26.0',

    // LOCAL DEVELOPMENT/DEMO ONLY - see services/messagingIdentityService.js's ensureDemoIdentityIfConfigured
    // and routes/messagingRoutes.js's /test/inbound. When set, the first message from an unrecognised sender
    // ARRIVING THROUGH THE TEST ENDPOINT ONLY (never the real /webhook) is auto-linked to this existing
    // FoodShare user, so the full report -> confirm -> real-surplus flow can be demoed with zero manual
    // linking. Never used when NODE_ENV=production, regardless of this being set. Not a real database id
    // hard-coded here - a plain integer you configure yourself, pointing at a demo kitchen user you created.
    testMessagingKitchenUserId: Number(process.env.TEST_MESSAGING_KITCHEN_USER_ID) || null,
};
