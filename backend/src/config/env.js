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
};
