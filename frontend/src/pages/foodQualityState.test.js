import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, foodQualityReducer } from './foodQualityState.js';

test('initial state has no file, is idle, and shows no error', () => {
  assert.equal(initialState.hasValidFile, false);
  assert.equal(initialState.submitStatus, 'idle');
  assert.equal(initialState.result, null);
});

test('FILE_INVALID records the reason and clears any previous file/result', () => {
  const state = foodQualityReducer(initialState, { type: 'FILE_INVALID', message: 'Unsupported file type.' });
  assert.equal(state.fileError, 'Unsupported file type.');
  assert.equal(state.hasValidFile, false);
  assert.equal(state.result, null);
});

test('FILE_VALID records the chosen file and clears a previous error/result', () => {
  const withError = foodQualityReducer(initialState, { type: 'FILE_INVALID', message: 'too big' });
  const state = foodQualityReducer(withError, { type: 'FILE_VALID', fileName: 'plate.jpg' });
  assert.equal(state.hasValidFile, true);
  assert.equal(state.fileName, 'plate.jpg');
  assert.equal(state.fileError, '');
});

test('SUBMIT_START enters the loading state and clears stale result/error', () => {
  const selected = foodQualityReducer(initialState, { type: 'FILE_VALID', fileName: 'plate.jpg' });
  const state = foodQualityReducer(selected, { type: 'SUBMIT_START' });
  assert.equal(state.submitStatus, 'loading');
  assert.equal(state.result, null);
  assert.equal(state.error, '');
  assert.equal(state.hasValidFile, true); // still knows which file is selected while loading
});

test('SUBMIT_SUCCESS stores the result and leaves the success state', () => {
  const loading = foodQualityReducer(initialState, { type: 'SUBMIT_START' });
  const data = { classification: 'FRESH', confidence: 0.7, signals: [], recommendation: '', disclaimer: 'd' };
  const state = foodQualityReducer(loading, { type: 'SUBMIT_SUCCESS', data });
  assert.equal(state.submitStatus, 'success');
  assert.deepEqual(state.result, data);
});

test('SUBMIT_SUCCESS with an UNKNOWN classification is stored the same way - the UI decides how to render it', () => {
  const loading = foodQualityReducer(initialState, { type: 'SUBMIT_START' });
  const data = { classification: 'UNKNOWN', confidence: 0.2, signals: ['too small'], recommendation: 'inspect manually', disclaimer: 'd' };
  const state = foodQualityReducer(loading, { type: 'SUBMIT_SUCCESS', data });
  assert.equal(state.result.classification, 'UNKNOWN');
});

test('SUBMIT_ERROR records the message and clears any result', () => {
  const loading = foodQualityReducer(initialState, { type: 'SUBMIT_START' });
  const state = foodQualityReducer(loading, { type: 'SUBMIT_ERROR', message: 'Network error' });
  assert.equal(state.submitStatus, 'error');
  assert.equal(state.error, 'Network error');
  assert.equal(state.result, null);
});

test('CLEAR resets everything back to the initial state', () => {
  const loading = foodQualityReducer(initialState, { type: 'SUBMIT_START' });
  const success = foodQualityReducer(loading, { type: 'SUBMIT_SUCCESS', data: { classification: 'FRESH' } });
  const cleared = foodQualityReducer(success, { type: 'CLEAR' });
  assert.deepEqual(cleared, initialState);
});
