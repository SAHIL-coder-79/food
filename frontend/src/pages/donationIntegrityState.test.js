import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, donationIntegrityReducer } from './donationIntegrityState.js';

test('initial state is idle with no ledger or certificate loaded', () => {
  assert.equal(initialState.ledgerStatus, 'idle');
  assert.equal(initialState.certificateStatus, 'idle');
  assert.equal(initialState.ledger, null);
  assert.equal(initialState.certificate, null);
});

test('LEDGER_LOADING enters the loading state and clears any previous error', () => {
  const state = donationIntegrityReducer(initialState, { type: 'LEDGER_LOADING' });
  assert.equal(state.ledgerStatus, 'loading');
  assert.equal(state.ledgerError, '');
});

test('LEDGER_SUCCESS stores the ledger data and leaves the ready state', () => {
  const loading = donationIntegrityReducer(initialState, { type: 'LEDGER_LOADING' });
  const data = { eventCount: 2, chainVerification: { valid: true } };
  const state = donationIntegrityReducer(loading, { type: 'LEDGER_SUCCESS', data });
  assert.equal(state.ledgerStatus, 'ready');
  assert.deepEqual(state.ledger, data);
});

test('LEDGER_ERROR records the message and clears any stale ledger data', () => {
  const loading = donationIntegrityReducer(initialState, { type: 'LEDGER_LOADING' });
  const state = donationIntegrityReducer(loading, { type: 'LEDGER_ERROR', message: 'Network error' });
  assert.equal(state.ledgerStatus, 'error');
  assert.equal(state.ledgerError, 'Network error');
  assert.equal(state.ledger, null);
});

test('certificate transitions are independent of ledger state', () => {
  const ledgerReady = donationIntegrityReducer(initialState, { type: 'LEDGER_SUCCESS', data: { eventCount: 1 } });
  const certLoading = donationIntegrityReducer(ledgerReady, { type: 'CERTIFICATE_LOADING' });
  assert.equal(certLoading.ledgerStatus, 'ready');
  assert.equal(certLoading.certificateStatus, 'loading');

  const certReady = donationIntegrityReducer(certLoading, { type: 'CERTIFICATE_SUCCESS', data: { certificateId: 'X' } });
  assert.equal(certReady.certificateStatus, 'ready');
  assert.deepEqual(certReady.certificate, { certificateId: 'X' });
  assert.equal(certReady.ledgerStatus, 'ready'); // untouched
});

test('CERTIFICATE_ERROR records the message and clears any stale certificate', () => {
  const loading = donationIntegrityReducer(initialState, { type: 'CERTIFICATE_LOADING' });
  const state = donationIntegrityReducer(loading, { type: 'CERTIFICATE_ERROR', message: 'Not collected yet' });
  assert.equal(state.certificateStatus, 'error');
  assert.equal(state.certificateError, 'Not collected yet');
  assert.equal(state.certificate, null);
});
