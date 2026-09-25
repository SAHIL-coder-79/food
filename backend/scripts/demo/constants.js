'use strict';

// Shared between seedDemo.js and resetDemo.js so the two can never drift apart: whatever the seed script tags as
// demo data, the reset script recognises by the exact same marker.
//
// Every demo organization's name starts with DEMO_ORG_PREFIX, and every demo user's email ends in
// DEMO_EMAIL_DOMAIN — a reserved TLD (RFC 2606 ".test"), so it can never collide with a real address. That is the
// ONLY thing that identifies demo data; nothing else in the schema is touched or special-cased for it.

const DEMO_ORG_PREFIX = '[DEMO] ';
const DEMO_EMAIL_DOMAIN = 'demo.foodshareai.test';
const DEMO_PASSWORD = 'Demo@12345'; // fixed and documented in scripts/demo/README.md, so a presenter can log in as anyone
const DEMO_ADMIN_EMAIL = `admin@${DEMO_EMAIL_DOMAIN}`;

module.exports = { DEMO_ORG_PREFIX, DEMO_EMAIL_DOMAIN, DEMO_PASSWORD, DEMO_ADMIN_EMAIL };
