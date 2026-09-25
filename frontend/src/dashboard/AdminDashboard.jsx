import React from 'react';
import { useAuth } from '../context/AuthContext';
import { combine, useResource } from './useResource';
import { formatDate, plural } from './format';
import { organizationCounts, priorityBreakdown } from './metrics';
import { EmptyState, Kpi, LinkButton, MetricCard, Stage, StageStrip } from './ui';

// System-admin dashboard: oversight of the network that runs the loop (verification queue, organizations, and the
// platform-wide rescue backlog). Figures come from /organizations, /organizations/pending-ngos and /rescue-priorities.
export default function AdminDashboard({ navigate }) {
  const { call } = useAuth();
  const go = (key) => (navigate ? () => navigate(key) : undefined);

  const pending = useResource(() => call('/organizations/pending-ngos?limit=100').then((r) => r.organizations), [call]);
  const organizations = useResource(() => call('/organizations?limit=200').then((r) => r.organizations), [call]);
  const priorities = useResource(() => call('/rescue-priorities').then((r) => r.data), [call]);

  const network = combine([organizations], (list) => organizationCounts(list));
  const backlog = combine([priorities], (list) => priorityBreakdown(list));

  return (
    <>
      <StageStrip dimmed={['predict', 'explain', 'prevent', 'learn']} />
      <div className="dash-banner" style={{ background: 'var(--info-bg)', color: 'var(--info)' }}>
        Kitchens run predict, explain, prevent and learn. As System Admin you keep the <strong>Rescue</strong> network trustworthy: verify NGOs and watch the rescue backlog.
      </div>

      <Stage stageKey="rescue" title="Rescue & Redistribute" tagline="The network and the surplus waiting to be collected." action={<LinkButton onClick={go('rescue-priority')}>Open rescue priority</LinkButton>}>
        <MetricCard
          title="NGO verification queue"
          resource={pending}
          action={<LinkButton onClick={go('admin')}>Review</LinkButton>}
          isEmpty={(list) => list.length === 0}
          empty={<EmptyState title="No NGOs are waiting" tone="good">Every registered NGO has been reviewed.</EmptyState>}
        >
          {(list) => (
            <>
              <Kpi value={list.length} unit={list.length === 1 ? 'NGO awaiting review' : 'NGOs awaiting review'} />
              <ul className="dash-list">
                {list.slice(0, 4).map((org) => (
                  <li key={org.id}><span><strong>{org.name}</strong><div className="dash-list-detail">registered {formatDate(org.created_at)}</div></span></li>
                ))}
              </ul>
            </>
          )}
        </MetricCard>

        <MetricCard
          title="Network"
          resource={network}
          isEmpty={(n) => n.total === 0}
          empty={<EmptyState title="No organizations yet">Kitchens and NGOs appear here once they register.</EmptyState>}
        >
          {(n) => (
            <>
              <div className="dash-cols">
                <Kpi value={n.kitchens} caption={plural(n.kitchens, 'kitchen')} />
                <Kpi value={n.ngos} caption={`${plural(n.ngos, 'NGO')} · ${n.verifiedNgos} verified`} />
              </div>
              <ul className="dash-list">
                <li><span>Pending verification</span><strong>{n.pendingNgos}</strong></li>
                <li><span>Rejected</span><strong>{n.rejectedNgos}</strong></li>
              </ul>
            </>
          )}
        </MetricCard>

        <MetricCard
          title="Rescue backlog"
          hint="Available surplus across the platform."
          resource={backlog}
          isEmpty={(b) => b.total === 0}
          empty={<EmptyState title="No surplus is waiting" tone="good">There are no available listings right now.</EmptyState>}
        >
          {(b) => (
            <div className="dash-cols">
              <Kpi value={b.total} caption={plural(b.total, 'available listing')} />
              <Kpi value={b.critical} caption="critical priority" />
            </div>
          )}
        </MetricCard>
      </Stage>
    </>
  );
}
