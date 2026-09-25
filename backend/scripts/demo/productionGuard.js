'use strict';

const env = require('../../src/config/env');

// Fail-safe: the demo dataset includes an account with a fixed, publicly-documented password (see
// scripts/demo/README.md). That is fine for a development database a presenter controls, and must never be
// possible against a production one. Deliberately depends on nothing but the environment config, so it can run -
// and be tested - before any database or app module is even loaded.
function assertNotProduction(context = 'seed demo data') {
    if (env.nodeEnv === 'production') {
        throw new Error(
            `Refusing to ${context}: NODE_ENV is "production". The demo dataset (including a demo system-admin ` +
                'account with a password documented in scripts/demo/README.md) must never be created in a production ' +
                'environment. Point DATABASE_URL at a development database and run with a non-production NODE_ENV.'
        );
    }
}

module.exports = { assertNotProduction };
