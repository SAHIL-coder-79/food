import React, { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../notifications/NotificationContext';
import { combine, useResource } from './useResource';
import { formatMinutes, formatNumber, plural } from './format';
import { feedSummary, notificationActivity, priorityBreakdown } from './metrics';
import { EmptyState, Kpi, LinkButton, MetricCard, Stage, StageStrip } from './ui';

// NGO dashboard: the RESCUE end of the loop. Figures come from the surplus feed, the rescue-priority ranking and the
// NGO's own notifications. Kitchens run predict / explain / prevent / learn, so those stages are shown but muted.
const LEVEL_BADGE = { CRITICAL: 'badge-danger', HIGH: 'badge-warning', MEDIUM: 'badge-warning', LOW: 'badge-success' };

export default function NgoDashboard({ navigate }) {
  const { call, organization, refreshOrganization } = useAuth();
  const go = (key) => (navigate ? () => navigate(key) : undefined);
  const verified = Boolean(organization && organization.verification_status === 'verified');

  // The organization record was loaded at login; refresh it so a verification granted since then shows up here.
  useEffect(() => {
    refreshOrganization().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const feed = useResource(() => call('/surplus-listings/feed').then((r) => r.listings), [call], { enabled: verified });
  const priorities = useResource(() => call('/rescue-priorities').then((r) => r.data), [call], { enabled: verified });
  // Shared with the header notification bell (NotificationContext) so there is one fetch/count implementation,
  // not a second one duplicated here.
  const notificationState = useNotifications();
  const notifications = { status: notificationState.status, data: notificationState.notifications, error: notificationState.error, reload: notificationState.refresh };

  const opportunities = combine([feed], (listings) => feedSummary(listings));
  const triage = combine([priorities], (listings) => priorityBreakdown(listings));
  const activity = combine([notifications], (list) => notificationActivity(list));

  return (
    <>
      <StageStrip dimmed={['predict', 'explain', 'prevent', 'learn']} />
      <div className="dash-banner" style={{ background: 'var(--info-bg)', color: 'var(--info)' }}>
        Kitchens predict, explain and prevent waste. Your part is <strong>Rescue</strong>: collecting the surplus that could not be avoided, before it spoils.
      </div>

      {!verified && (
        <div className="dash-banner dash-banner-warning" role="status">
          Your organization is <strong>{organization ? organization.verification_status : 'not verified'}</strong>. The surplus feed and rescue priorities open once a System Admin verifies it.
        </div>
      )}

      <Stage stageKey="rescue" title="Rescue & Redistribute" tagline="Surplus waiting for you, ranked by urgency." action={<LinkButton onClick={go('surplus')}>Open surplus feed</LinkButton>}>
        {verified ? (
          <>
            <MetricCard
              title="Rescue opportunities"
              hint="Available surplus inside your service area."
              resource={opportunities}
              isEmpty={(o) => o.count === 0}
              empty={<EmptyState title="No surplus available right now">New listings from nearby kitchens appear here, and you are notified when they are posted.</EmptyState>}
            >
              {(o) => (
                <Kpi
                  value={o.count}
                  unit={o.count === 1 ? 'listing available' : 'listings available'}
                  caption={`${formatNumber(o.quantity)} units${o.nearestKm !== null ? ` · nearest ${formatNumber(o.nearestKm)} km` : ''} · soonest expires in ${formatMinutes(o.soonestMinutes)}`}
                />
              )}
            </MetricCard>

            <MetricCard
              title="Rescue priority"
              hint="Ranked by time left and meals that would be saved."
              resource={triage}
              action={<LinkButton onClick={go('rescue-priority')}>Full ranking</LinkButton>}
              isEmpty={(t) => t.total === 0}
              empty={<EmptyState title="Nothing to triage">There are no active listings to rank.</EmptyState>}
            >
              {(t) => (
                <>
                  <div className="dash-cols">
                    <Kpi value={t.critical} caption="critical" />
                    <Kpi value={t.high} caption="high priority" />
                  </div>
                  <ul className="dash-list">
                    {t.top.map((l) => (
                      <li key={l.id}>
                        <span><strong>{l.food_type || 'Food item'}</strong> · {formatNumber(l.quantity)}<div className="dash-list-detail">{l.reason}</div></span>
                        <span className={`badge ${LEVEL_BADGE[l.priorityLevel] || 'badge-neutral'}`}>{l.priorityLevel}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </MetricCard>
          </>
        ) : (
          <MetricCard title="Rescue opportunities" resource={{ status: 'ready', data: null }} empty={null}>
            {() => <EmptyState title="Available after verification">Once verified, the listings near you and their rescue priority appear here.</EmptyState>}
          </MetricCard>
        )}

        <MetricCard
          title="Your rescue status"
          hint="From your recent notifications."
          resource={activity}
          isEmpty={(a) => a.total === 0}
          empty={<EmptyState title="No activity yet">Claims, pickup confirmations and completed collections show up here.</EmptyState>}
        >
          {(a) => (
            <>
              <div className="dash-cols">
                <Kpi value={a.collections} caption={`${plural(a.collections, 'collection')} completed`} />
                <Kpi value={a.pickupsConfirmed} caption={`${plural(a.pickupsConfirmed, 'pickup')} confirmed by kitchens`} />
              </div>
              <ul className="dash-list">
                <li><span>New surplus alerts</span><strong>{a.newSurplus}</strong></li>
                <li><span>Unread notifications</span><strong>{a.unread}</strong></li>
              </ul>
            </>
          )}
        </MetricCard>
      </Stage>
    </>
  );
}
