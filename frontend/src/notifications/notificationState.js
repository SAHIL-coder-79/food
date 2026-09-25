// Pure notification state machine: no React, no fetch — so it is unit-testable exactly like dashboard/metrics.js.
// NotificationContext.jsx is the thin React wrapper that dispatches these actions from the real API calls.

export const initialState = { status: 'loading', notifications: [], unreadCount: 0, error: '' };

export function countUnread(notifications) {
  return notifications.filter((n) => !n.is_read).length;
}

export function notificationReducer(state, action) {
  switch (action.type) {
    case 'FETCH_START':
      return { ...state, status: 'loading', error: '' };
    case 'FETCH_SUCCESS':
      return { status: 'ready', notifications: action.notifications, unreadCount: countUnread(action.notifications), error: '' };
    case 'FETCH_ERROR':
      return { ...state, status: 'error', error: action.message || 'Something went wrong' };
    case 'MARK_READ': {
      const notifications = state.notifications.map((n) => (n.id === action.id ? { ...n, is_read: true } : n));
      return { ...state, notifications, unreadCount: countUnread(notifications) };
    }
    case 'MARK_ALL_READ': {
      const notifications = state.notifications.map((n) => ({ ...n, is_read: true }));
      return { ...state, notifications, unreadCount: 0 };
    }
    default:
      return state;
  }
}

// The type labels the backend uses (utils/constants.js NOTIFICATION_TYPES), in plain language.
const TYPE_LABELS = {
  SURPLUS_POSTED: 'New surplus posted',
  LISTING_CLAIMED: 'Listing claimed',
  PICKUP_CONFIRMED: 'Pickup confirmed',
  LISTING_COLLECTED: 'Listing collected',
  LISTING_EXPIRED: 'Listing expired',
  NGO_VERIFICATION_RESULT: 'Verification update',
};

// Raw backend row -> what the bell renders. A type this app doesn't recognise still renders (its own type as the
// label) rather than disappearing or throwing.
export function toView(notification) {
  return {
    id: notification.id,
    type: notification.type,
    label: TYPE_LABELS[notification.type] || notification.type,
    message: notification.message,
    createdAt: notification.created_at,
    unread: !notification.is_read,
  };
}

// "3", "27", "99+" - never an ugly/overflowing badge. null means "don't show a badge at all".
export function badgeText(count) {
  if (!count || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}
