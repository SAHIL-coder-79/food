import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { initialState, notificationReducer } from './notificationState';

// Single shared source of truth for "my notifications" (list + unread count), used by both the header bell and
// the NGO dashboard's activity card — so there is exactly one fetch/count implementation, not two. Every request
// goes through the existing, already-scoped GET/PATCH /api/notifications* endpoints (user-scoped server-side by
// req.user.id; this context never sees, and could not fetch, another user's notifications).

const NotificationContext = createContext(null);

const LIST_LIMIT = 100; // matches the recent-history size the NGO dashboard already fetched before this context existed

export function NotificationProvider({ children }) {
  const { call, isAuthenticated } = useAuth();
  const [state, dispatch] = useReducer(notificationReducer, initialState);
  const loadedForSession = useRef(false);

  const refresh = useCallback(async () => {
    dispatch({ type: 'FETCH_START' });
    try {
      const data = await call(`/notifications?limit=${LIST_LIMIT}`);
      dispatch({ type: 'FETCH_SUCCESS', notifications: data.notifications });
    } catch (err) {
      dispatch({ type: 'FETCH_ERROR', message: err.message });
    }
  }, [call]);

  useEffect(() => {
    if (isAuthenticated && !loadedForSession.current) {
      loadedForSession.current = true;
      refresh();
    }
    if (!isAuthenticated) loadedForSession.current = false;
  }, [isAuthenticated, refresh]);

  // Optimistic: the UI updates immediately; a failure reverts the local change and rethrows so the caller (the
  // bell) can show a specific "couldn't update" message instead of a full-page error.
  const markRead = useCallback(async (id) => {
    const previous = state.notifications;
    dispatch({ type: 'MARK_READ', id });
    try {
      await call(`/notifications/${id}/read`, { method: 'PATCH' });
    } catch (err) {
      dispatch({ type: 'FETCH_SUCCESS', notifications: previous });
      throw err;
    }
  }, [call, state.notifications]);

  const markAllRead = useCallback(async () => {
    const previous = state.notifications;
    dispatch({ type: 'MARK_ALL_READ' });
    try {
      await call('/notifications/read-all', { method: 'PATCH' });
    } catch (err) {
      dispatch({ type: 'FETCH_SUCCESS', notifications: previous });
      throw err;
    }
  }, [call, state.notifications]);

  const value = { ...state, refresh, markRead, markAllRead };
  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider');
  return ctx;
}
