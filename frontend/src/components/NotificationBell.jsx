import React, { useEffect, useRef, useState } from 'react';
import { useNotifications } from '../notifications/NotificationContext';
import { badgeText, toView } from '../notifications/notificationState';
import { formatDateTime, formatRelativeTime } from '../format';

const TYPE_BADGE = {
  SURPLUS_POSTED: 'badge-info',
  LISTING_CLAIMED: 'badge-warning',
  PICKUP_CONFIRMED: 'badge-info',
  LISTING_COLLECTED: 'badge-success',
  LISTING_EXPIRED: 'badge-neutral',
  NGO_VERIFICATION_RESULT: 'badge-success',
};

function BellIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

// Header notification bell + dropdown panel. Reads/writes only through NotificationContext, which itself only
// calls the existing, already user-scoped /api/notifications endpoints — this component never fetches, filters
// or displays anything belonging to another user or organization.
export default function NotificationBell() {
  const { status, notifications, unreadCount, error, refresh, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onEscape = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const toggle = () => {
    setActionError('');
    setOpen((prev) => !prev);
  };

  const handleMarkRead = async (id) => {
    setActionError('');
    setBusyId(id);
    try {
      await markRead(id);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleMarkAllRead = async () => {
    setActionError('');
    try {
      await markAllRead();
    } catch (err) {
      setActionError(err.message);
    }
  };

  const badge = badgeText(unreadCount);

  return (
    <div className="notif-bell-wrap" ref={wrapRef}>
      <button
        type="button"
        className="notif-bell-btn"
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={badge ? `Notifications, ${unreadCount} unread` : 'Notifications'}
      >
        <BellIcon />
        {badge && <span className="notif-badge">{badge}</span>}
      </button>

      {open && (
        <div className="notif-panel" role="menu">
          <div className="notif-panel-head">
            <strong>Notifications</strong>
            {unreadCount > 0 && (
              <button type="button" className="notif-link" onClick={handleMarkAllRead}>Mark all read</button>
            )}
          </div>

          {actionError && <div className="alert alert-error notif-inline-alert">{actionError}</div>}

          {status === 'loading' ? (
            <div className="dash-skeleton notif-empty">
              <span /><span /><span />
            </div>
          ) : status === 'error' ? (
            <div className="notif-empty">
              <p className="muted">Could not load notifications: {error}</p>
              <button type="button" className="btn btn-outline btn-sm" onClick={refresh}>Retry</button>
            </div>
          ) : notifications.length === 0 ? (
            <div className="notif-empty"><p className="muted">You have no notifications yet.</p></div>
          ) : (
            <ul className="notif-list">
              {notifications.map((raw) => {
                const n = toView(raw);
                return (
                  <li key={n.id} className={n.unread ? 'is-unread' : ''}>
                    <div className="notif-item-top">
                      <span className={`badge ${TYPE_BADGE[n.type] || 'badge-neutral'}`}>{n.label}</span>
                      <span className="notif-time" title={formatDateTime(n.createdAt)}>{formatRelativeTime(n.createdAt)}</span>
                    </div>
                    <p className="notif-message">{n.message}</p>
                    {n.unread && (
                      <button type="button" className="notif-link" disabled={busyId === n.id} onClick={() => handleMarkRead(n.id)}>
                        {busyId === n.id ? 'Marking…' : 'Mark as read'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
