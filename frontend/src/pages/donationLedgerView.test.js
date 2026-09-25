import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventLabel, shortHash, buildLedgerSummary, buildCertificateView, buildCertificateHtml } from './donationLedgerView.js';

test('eventLabel maps every documented event type to a readable label', () => {
  assert.equal(eventLabel('SURPLUS_CREATED'), 'Posted');
  assert.equal(eventLabel('SURPLUS_CLAIMED'), 'Claimed');
  assert.equal(eventLabel('PICKUP_CONFIRMED'), 'Pickup confirmed');
  assert.equal(eventLabel('SURPLUS_COLLECTED'), 'Collected');
  assert.equal(eventLabel('SURPLUS_EXPIRED'), 'Expired');
});

test('eventLabel falls back to the raw type for anything unrecognised, never throwing', () => {
  assert.equal(eventLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
});

test('shortHash truncates a real hash and shows a placeholder for none', () => {
  const hash = 'a'.repeat(64);
  assert.equal(shortHash(hash), 'aaaaaaaaaa…');
  assert.equal(shortHash(null), '—');
  assert.equal(shortHash(undefined), '—');
});

test('buildLedgerSummary returns null with no data yet', () => {
  assert.equal(buildLedgerSummary(null), null);
});

test('buildLedgerSummary reports event count, verification status and the latest event', () => {
  const ledger = {
    eventCount: 2,
    firstHash: 'a'.repeat(64),
    lastHash: 'b'.repeat(64),
    chainVerification: { valid: true },
    events: [
      { eventType: 'SURPLUS_CREATED', eventTimestamp: '2026-01-01T00:00:00.000Z' },
      { eventType: 'SURPLUS_CLAIMED', eventTimestamp: '2026-01-02T00:00:00.000Z' },
    ],
  };
  const summary = buildLedgerSummary(ledger);
  assert.equal(summary.eventCount, 2);
  assert.equal(summary.verified, true);
  assert.equal(summary.reason, null);
  assert.deepEqual(summary.latestEvent, { type: 'SURPLUS_CLAIMED', label: 'Claimed', timestamp: '2026-01-02T00:00:00.000Z' });
  assert.equal(summary.firstHashShort, `${'a'.repeat(10)}…`);
  assert.equal(summary.lastHashShort, `${'b'.repeat(10)}…`);
});

test('buildLedgerSummary surfaces the failure reason only when the chain is invalid', () => {
  const invalid = buildLedgerSummary({
    eventCount: 1,
    firstHash: 'a'.repeat(64),
    lastHash: 'a'.repeat(64),
    chainVerification: { valid: false, reason: 'tampered' },
    events: [{ eventType: 'SURPLUS_CREATED', eventTimestamp: '2026-01-01T00:00:00.000Z' }],
  });
  assert.equal(invalid.verified, false);
  assert.equal(invalid.reason, 'tampered');
});

test('buildLedgerSummary handles a listing with no events yet (empty state)', () => {
  const summary = buildLedgerSummary({ eventCount: 0, firstHash: null, lastHash: null, chainVerification: { valid: true }, events: [] });
  assert.equal(summary.eventCount, 0);
  assert.equal(summary.latestEvent, null);
  assert.equal(summary.firstHashShort, '—');
});

test('buildCertificateView returns null with no data yet', () => {
  assert.equal(buildCertificateView(null), null);
});

test('buildCertificateView passes through real values and marks financial impact available', () => {
  const view = buildCertificateView({
    certificateId: 'FSA-CERT-1-ABC123',
    listingId: 1,
    foodType: 'Rice',
    donorOrganization: { id: 1, name: 'Kitchen A' },
    receivingOrganization: { id: 2, name: 'NGO B' },
    quantityCollected: 8,
    collectedAt: '2026-01-01T00:00:00.000Z',
    financialImpact: { available: true, valueInr: 400 },
    environmentalImpact: { co2eAvoidedKg: 20, mealEquivalents: 20 },
    ledgerVerification: { valid: true, eventCount: 4 },
    generatedAt: '2026-01-02T00:00:00.000Z',
    disclaimer: 'FoodShare AI Prototype certificate...',
  });
  assert.equal(view.certificateId, 'FSA-CERT-1-ABC123');
  assert.equal(view.donorName, 'Kitchen A');
  assert.equal(view.receivingName, 'NGO B');
  assert.equal(view.financialAvailable, true);
  assert.equal(view.financialValueInr, 400);
  assert.equal(view.co2eAvoidedKg, 20);
  assert.equal(view.ledgerValid, true);
});

test('buildCertificateView never invents a financial value when the backend reports it unavailable', () => {
  const view = buildCertificateView({
    certificateId: 'FSA-CERT-2-DEF456',
    listingId: 2,
    donorOrganization: null,
    receivingOrganization: null,
    quantityCollected: 5,
    financialImpact: { available: false },
    environmentalImpact: { co2eAvoidedKg: 12.5, mealEquivalents: 12 },
    ledgerVerification: { valid: true, eventCount: 4 },
    disclaimer: 'd',
  });
  assert.equal(view.financialAvailable, false);
  assert.equal(view.financialValueInr, null);
  assert.equal(view.donorName, '—');
  assert.equal(view.receivingName, '—');
});

test('buildCertificateHtml produces a self-contained document mentioning the prototype disclaimer and certificate id', () => {
  const view = buildCertificateView({
    certificateId: 'FSA-CERT-1-ABC123',
    listingId: 1,
    foodType: 'Rice',
    donorOrganization: { id: 1, name: 'Kitchen A' },
    receivingOrganization: { id: 2, name: 'NGO B' },
    quantityCollected: 8,
    collectedAt: '2026-01-01T00:00:00.000Z',
    financialImpact: { available: true, valueInr: 400 },
    environmentalImpact: { co2eAvoidedKg: 20, mealEquivalents: 20 },
    ledgerVerification: { valid: true, eventCount: 4 },
    disclaimer: 'FoodShare AI Prototype certificate - not a legal certification.',
  });
  const html = buildCertificateHtml(view);
  assert.match(html, /FoodShare AI Prototype/);
  assert.match(html, /FSA-CERT-1-ABC123/);
  assert.match(html, /Kitchen A/);
  assert.match(html, /NGO B/);
  assert.match(html, /not a legal certification/);
  assert.match(html, /<!doctype html>/i);
});

test('buildCertificateHtml escapes HTML-significant characters from organization names', () => {
  const view = buildCertificateView({
    certificateId: 'FSA-CERT-1-XYZ',
    listingId: 1,
    foodType: 'Rice',
    donorOrganization: { id: 1, name: '<script>alert(1)</script>' },
    receivingOrganization: { id: 2, name: 'NGO & Co' },
    quantityCollected: 8,
    collectedAt: '2026-01-01T00:00:00.000Z',
    financialImpact: { available: false },
    environmentalImpact: { co2eAvoidedKg: 20, mealEquivalents: 20 },
    ledgerVerification: { valid: true, eventCount: 4 },
    disclaimer: 'd',
  });
  const html = buildCertificateHtml(view);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /NGO &amp; Co/);
});
