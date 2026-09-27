'use strict';

// A minimal, dependency-free, in-memory rate limiter for authentication-sensitive endpoints (login,
// registration). Deliberately simple: fixed time window, keyed by client IP, single process.
//
// Limitation (documented, not hidden): this is per-process, in-memory state. It is a real control for this app's
// current single-instance deployment, but it would NOT coordinate limits across multiple server instances behind
// a load balancer - a production deployment that scales horizontally would need a shared store (e.g. Redis)
// instead. Adding that is out of scope here; this keeps the implementation small enough to read end to end.
//
// Config is read from environment variables (see .env.example), with safe defaults, so limits can be tuned per
// environment without a code change.

function readIntEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Every limiter's hit-map, so tests can clear all of them between cases without reaching into each one by name.
const registry = [];

function sweepExpired(hits, now) {
    for (const [key, entry] of hits) {
        if (entry.resetAt <= now) hits.delete(key);
    }
}

/**
 * @param {number} windowMs fixed window length, in ms
 * @param {number} max the most requests one client (by IP) may make inside a window
 * @param {string} [message] returned in the 429 body
 * @param {(req) => string} [keyGenerator] defaults to the client's IP; overridable for tests
 */
function createRateLimiter({ windowMs, max, message, keyGenerator }) {
    const hits = new Map(); // key -> { count, resetAt }
    const getKey = keyGenerator || ((req) => req.ip);
    registry.push(hits);

    return function rateLimit(req, res, next) {
        const now = Date.now();
        const key = getKey(req) || 'unknown';
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        entry.count += 1;

        const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        res.set('RateLimit-Limit', String(max));
        res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
        res.set('RateLimit-Reset', String(retryAfterSeconds));

        if (entry.count > max) {
            res.set('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({ status: 'error', message: message || 'Too many requests. Please try again later.' });
        }

        // Bound memory in a long-running process without a background timer: sweep expired keys opportunistically
        // once the map has grown, instead of on every single request.
        if (hits.size > 1000 && hits.size % 200 === 0) sweepExpired(hits, now);

        next();
    };
}

// Login: brute-forcing a password is the primary risk this defends against.
const loginLimiter = createRateLimiter({
    windowMs: readIntEnv('AUTH_LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), // 15 minutes
    max: readIntEnv('AUTH_LOGIN_RATE_LIMIT_MAX', 10),
    message: 'Too many login attempts from this address. Please wait a while and try again.',
});

// Registration: cheap to abuse for spam/account creation if left unbounded.
const registerLimiter = createRateLimiter({
    windowMs: readIntEnv('AUTH_REGISTER_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000), // 1 hour
    max: readIntEnv('AUTH_REGISTER_RATE_LIMIT_MAX', 20),
    message: 'Too many registrations from this address. Please wait a while and try again.',
});

// Rescue notifications (Task 19): cheap to abuse into a message flood against real (mocked, for now) NGO
// contacts if left unbounded. The per-listing cooldown in services/rescueNotificationService.js is the more
// targeted duplicate-send guard; this is the general per-IP flood backstop, same shape as the two above.
const communicationLimiter = createRateLimiter({
    windowMs: readIntEnv('COMMUNICATION_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000), // 1 hour
    max: readIntEnv('COMMUNICATION_RATE_LIMIT_MAX', 20),
    message: 'Too many notification requests from this address. Please wait a while and try again.',
});

// Conversational assistant webhook (Task 20): protects against message spam, repeated confirmations and
// webhook flooding. Keyed by the message's own claimed sender id (falling back to IP) rather than the
// webhook caller's IP alone, so one noisy sender can't exhaust the limit for every other legitimate sender
// arriving through the same provider's shared webhook traffic.
const messagingWebhookLimiter = createRateLimiter({
    windowMs: readIntEnv('MESSAGING_RATE_LIMIT_WINDOW_MS', 60 * 1000), // 1 minute
    max: readIntEnv('MESSAGING_RATE_LIMIT_MAX', 30),
    message: 'Too many messages received from this sender. Please wait a moment and try again.',
    keyGenerator: (req) => (req.body && req.body.sender && req.body.sender.externalId) || req.ip,
});

// Test-only: clears every limiter's counters, so a test file that configures its own small limit for testing
// does not carry hits over between cases.
function resetAllRateLimiters() {
    registry.forEach((hits) => hits.clear());
}

module.exports = { createRateLimiter, loginLimiter, registerLimiter, communicationLimiter, messagingWebhookLimiter, resetAllRateLimiters };
