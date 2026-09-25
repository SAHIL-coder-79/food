import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, countUnread, initialState, notificationReducer, toView } from './notificationState.js';

const unread = (id, overrides = {}) => ({ id, user_id: 1, type: 'SURPLUS_POSTED', message: `msg ${id}`, is_read: false, created_at: '2026-09-24T10:00:00Z', ...overrides });
const read = (id, overrides = {}) => unread(id, { is_read: true, ...overrides });

// ---- unread count -----------------------------------------------------------------------------------------

test('countUnread counts only notifications with is_read false', () => {
  assert.equal(countUnread([]), 0);
  assert.equal(countUnread([read(1), read(2)]), 0);
  assert.equal(countUnread([unread(1), read(2), unread(3)]), 2);
});

test('badgeText hides a zero/negative count and caps large counts at "99+"', () => {
  assert.equal(badgeText(0), null);
  assert.equal(badgeText(-1), null);
  assert.equal(badgeText(undefined), null);
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(42), '42');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
  assert.equal(badgeText(1000), '99+');
});

// ---- rendering (view model) --------------------------------------------------------------------------------

test('toView maps a raw notification row to a display-ready shape, unread when is_read is false', () => {
  const view = toView(unread(5, { type: 'LISTING_CLAIMED', message: 'Surplus listing #5 has been claimed by an NGO.' }));
  assert.deepEqual(view, {
    id: 5, type: 'LISTING_CLAIMED', label: 'Listing claimed',
    message: 'Surplus listing #5 has been claimed by an NGO.', createdAt: '2026-09-24T10:00:00Z', unread: true,
  });
});

test('toView marks a read notification as not unread, and keeps the original message untouched', () => {
  const view = toView(read(6, { message: 'Your NGO registration has been verified.', type: 'NGO_VERIFICATION_RESULT' }));
  assert.equal(view.unread, false);
  assert.equal(view.label, 'Verification update');
  assert.equal(view.message, 'Your NGO registration has been verified.');
});

test('toView never hides or throws on a type the frontend does not recognise', () => {
  const view = toView(unread(7, { type: 'SOMETHING_NEW' }));
  assert.equal(view.label, 'SOMETHING_NEW');
  assert.equal(view.unread, true);
});

// ---- empty state --------------------------------------------------------------------------------------------

test('an empty notification list has zero unread and no view rows', () => {
  assert.equal(countUnread([]), 0);
  assert.deepEqual([].map(toView), []);
});

// ---- reducer: loading / success / error / mark-read / mark-all-read ------------------------------------------

test('initial state is loading, with no notifications and no unread', () => {
  assert.deepEqual(initialState, { status: 'loading', notifications: [], unreadCount: 0, error: '' });
});

test('FETCH_START resets a previous error and goes back to loading, keeping the old list', () => {
  const errored = { status: 'error', notifications: [read(1)], unreadCount: 0, error: 'boom' };
  const next = notificationReducer(errored, { type: 'FETCH_START' });
  assert.deepEqual(next, { status: 'loading', notifications: [read(1)], unreadCount: 0, error: '' });
});

test('FETCH_SUCCESS replaces the list and recomputes the unread count', () => {
  const next = notificationReducer(initialState, { type: 'FETCH_SUCCESS', notifications: [unread(1), unread(2), read(3)] });
  assert.equal(next.status, 'ready');
  assert.equal(next.notifications.length, 3);
  assert.equal(next.unreadCount, 2);
  assert.equal(next.error, '');
});

test('FETCH_ERROR surfaces the failure message and does not silently show an empty list as success', () => {
  const next = notificationReducer(initialState, { type: 'FETCH_ERROR', message: 'network down' });
  assert.equal(next.status, 'error');
  assert.equal(next.error, 'network down');
  assert.equal(next.notifications, initialState.notifications); // untouched, not wiped to []
});

test('FETCH_ERROR without a message still lands in a sane, non-empty error state', () => {
  const next = notificationReducer(initialState, { type: 'FETCH_ERROR' });
  assert.equal(next.status, 'error');
  assert.equal(next.error, 'Something went wrong');
});

test('MARK_READ flips exactly one notification to read and recomputes the unread count', () => {
  const ready = { status: 'ready', notifications: [unread(1), unread(2), unread(3)], unreadCount: 3, error: '' };
  const next = notificationReducer(ready, { type: 'MARK_READ', id: 2 });
  assert.equal(next.unreadCount, 2);
  assert.deepEqual(next.notifications.map((n) => [n.id, n.is_read]), [[1, false], [2, true], [3, false]]);
});

test('MARK_READ for an id that does not exist changes nothing', () => {
  const ready = { status: 'ready', notifications: [unread(1)], unreadCount: 1, error: '' };
  const next = notificationReducer(ready, { type: 'MARK_READ', id: 999 });
  assert.deepEqual(next.notifications, ready.notifications);
  assert.equal(next.unreadCount, 1);
});

test('MARK_ALL_READ clears every unread notification at once', () => {
  const ready = { status: 'ready', notifications: [unread(1), read(2), unread(3)], unreadCount: 2, error: '' };
  const next = notificationReducer(ready, { type: 'MARK_ALL_READ' });
  assert.equal(next.unreadCount, 0);
  assert.ok(next.notifications.every((n) => n.is_read === true));
  assert.equal(next.notifications.length, 3);
});

test('an unknown action leaves the state exactly as it was', () => {
  const ready = { status: 'ready', notifications: [unread(1)], unreadCount: 1, error: '' };
  assert.deepEqual(notificationReducer(ready, { type: 'NOT_A_REAL_ACTION' }), ready);
});
