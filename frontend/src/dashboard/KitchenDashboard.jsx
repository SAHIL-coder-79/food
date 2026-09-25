import React, { useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { combine, useResource } from './useResource';
import { addDays, dateString, formatInr, formatMinutes, formatNumber, formatPercent } from './format';
import { estimateLossAvoided, highRiskFood, rescueOpportunities, rescuePipeline, URGENT_MINUTES, wasteChange } from './metrics';
import { EmptyState, Kpi, LinkButton, MetricCard, Stage, StageStrip } from './ui';

// Kitchen dashboard. Every figure is read from the platform's own APIs (nothing is hardcoded or sampled):
//   demand       GET /forecasts/:id?persist=false     (read-only preview, saves nothing)
//   waste        GET /analytics/waste-attribution     (last 7 days and the 7 days before)
//   loss / CO2e  GET /financial-impact?period=weekly
//   accuracy     GET /analytics/forecast-performance
//   rescue       GET /surplus-listings, /surplus-listings/:id/spoilage-assessment, /organizations
const MAX_FORECAST_ROWS = 6;
const MAX_SPOILAGE_CHECKS = 5;

const TREND = {
  improving: { label: 'Improving', badge: 'badge-success' },
  stable: { label: 'Stable', badge: 'badge-neutral' },
  worsening: { label: 'Getting worse', badge: 'badge-danger' },
  insufficient_data: { label: 'Trend needs more days', badge: 'badge-neutral' },
};

// Insights that speak about a specific dish come first (the API also sends a general waste-rate insight).
const CONTRIBUTOR_INSIGHTS = ['top_waste_contributor', 'repeated_over_preparation'];
const contributorInsights = (waste) => {
  const specific = waste.insights.filter((i) => CONTRIBUTOR_INSIGHTS.includes(i.type));
  return (specific.length > 0 ? specific : waste.insights).slice(0, 2);
};

// Demand is forecast for the dishes a kitchen serves. Processing products and raw materials live in the same menu list
// but are not consumed meals; they are only forecast when the organization has no prepared-food items at all.
const forecastable = (items) => {
  const dishes = items.filter((i) => !i.item_type || i.item_type === 'prepared_food');
  return dishes.length > 0 ? dishes : items;
};

const unitOf = (waste) => (waste.meta && waste.meta.units && waste.meta.units.length === 1 ? waste.meta.units[0] : '');

export default function KitchenDashboard({ navigate }) {
  const { call } = useAuth();
  const go = (key) => (navigate ? () => navigate(key) : undefined);

  const today = useMemo(() => dateString(), []);
  const periods = useMemo(
    () => ({ from: addDays(today, -7), previousFrom: addDays(today, -15), previousTo: addDays(today, -8) }),
    [today]
  );

  // ---- data ---------------------------------------------------------------------------------------------------
  const menuItems = useResource(() => call('/menu-items').then((r) => r.menuItems), [call]);

  const forecasts = useResource(
    async () => {
      const items = forecastable(menuItems.data).slice(0, MAX_FORECAST_ROWS);
      const settled = await Promise.allSettled(items.map((item) => call(`/forecasts/${item.id}?targetDate=${today}&persist=false`)));
      return items.map((item, i) => (settled[i].status === 'fulfilled'
        ? { item, forecast: settled[i].value.data }
        : { item, error: (settled[i].reason && settled[i].reason.message) || 'unavailable' }));
    },
    [call, menuItems.data, today],
    { enabled: menuItems.status === 'ready' }
  );

  const wasteNow = useResource(() => call(`/analytics/waste-attribution?startDate=${periods.from}&endDate=${today}`).then((r) => r.data), [call, periods, today]);
  const wastePrevious = useResource(() => call(`/analytics/waste-attribution?startDate=${periods.previousFrom}&endDate=${periods.previousTo}`).then((r) => r.data), [call, periods]);
  const impact = useResource(() => call('/financial-impact?period=weekly').then((r) => r.data), [call]);
  const performance = useResource(() => call('/analytics/forecast-performance').then((r) => r.data), [call]);
  const listings = useResource(() => call('/surplus-listings?limit=200').then((r) => r.listings), [call]);
  // NGO names only decorate the pipeline; if the directory is unavailable the card still works ("An NGO").
  const ngos = useResource(() => call('/organizations?type=ngo&limit=100').then((r) => r.organizations).catch(() => []), [call]);

  const spoilage = useResource(
    async () => {
      const open = listings.data.filter((l) => l.status === 'Available').slice(0, MAX_SPOILAGE_CHECKS);
      const settled = await Promise.allSettled(open.map((l) => call(`/surplus-listings/${l.id}/spoilage-assessment`)));
      return open.map((listing, i) => (settled[i].status === 'fulfilled' ? { listing, assessment: settled[i].value.spoilageAssessment } : null)).filter(Boolean);
    },
    [call, listings.data],
    { enabled: listings.status === 'ready' }
  );

  // ---- card resources -----------------------------------------------------------------------------------------
  const demand = combine([menuItems, forecasts], (menu, rows) => ({ menuCount: forecastable(menu).length, rows }));
  const currentWaste = combine([wasteNow, impact], (waste, loss) => ({ waste, loss }));
  const reduction = combine([wasteNow, wastePrevious], (now, before) => wasteChange(now, before));
  const highRisk = combine([wasteNow, spoilage], (waste, checked) => ({
    items: highRiskFood(waste.patterns, checked),
    logs: waste.totals.logCount,
    listingsChecked: checked.length,
  }));
  const opportunities = combine([listings], (all) => rescueOpportunities(all));
  const pipeline = combine([listings, ngos], (all, directory) => rescuePipeline(all, directory));
  const lossAvoided = combine([performance, menuItems], (perf, menu) => estimateLossAvoided(perf.interventions.items, menu));

  return (
    <>
      <StageStrip />

      {/* 1. PREDICT ---------------------------------------------------------------------------------------- */}
      <Stage stageKey="predict" title="Predict" tagline="Expected demand for today, from each item's own history." action={<LinkButton onClick={go('forecast')}>Open forecast</LinkButton>}>
        <MetricCard
          wide
          title="Today's predicted demand"
          resource={demand}
          isEmpty={(d) => d.menuCount === 0}
          empty={<EmptyState title="No menu items yet" actionLabel="Add a menu item" onAction={go('menu-items')}>Forecasts are made per menu item. Add the dishes you cook, then log a few days of preparation and leftovers.</EmptyState>}
        >
          {({ menuCount, rows }) => {
            const first = rows.find((r) => r.forecast && r.forecast.keyFactors);
            const coverage = first && first.forecast.keyFactors.expected_range ? Math.round(first.forecast.keyFactors.expected_range.coverage * 100) : null;
            return (
              <>
                <table className="dash-table">
                  <thead><tr><th>Menu item</th><th className="num" style={{ textAlign: 'right' }}>Predicted</th><th>Expected range</th><th>Reliability</th><th>Basis</th></tr></thead>
                  <tbody>
                    {rows.map(({ item, forecast, error }) => {
                      if (!forecast) return <tr key={item.id}><td>{item.name}</td><td colSpan={4} className="muted">Forecast unavailable: {error}</td></tr>;
                      const range = forecast.keyFactors.expected_range;
                      const events = (forecast.keyFactors.event_context && forecast.keyFactors.event_context.target_events) || [];
                      const fallback = forecast.modelVersion === 'heuristic_fallback_v1';
                      return (
                        <tr key={item.id}>
                          <td>{item.name}{events.length > 0 && <> <span className="badge badge-info" title={events.map((e) => e.name).join(', ')}>Event today</span></>}</td>
                          <td className="num"><strong>{formatNumber(forecast.predictedQuantity)}</strong> <span className="muted">{item.unit}</span></td>
                          <td>{range ? `${formatNumber(range.low)} – ${formatNumber(range.high)}` : <span className="muted">not available</span>}</td>
                          <td title="A heuristic reliability score from data volume and stability, not a probability">{Math.round(forecast.confidenceScore * 100)}%</td>
                          <td>{fallback ? <span className="badge badge-warning" title={`Fewer than ${forecast.keyFactors.minimum_observations} days of history`}>Simple average</span> : <span className="badge badge-success">Statistical</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {menuCount > rows.length && <p className="dash-note">Showing {rows.length} of {menuCount} menu items.</p>}
                {first && (
                  <p className="dash-note">
                    Predictions include the {first.forecast.keyFactors.safety_buffer} safety buffer{coverage !== null && <>; ranges are approximate {coverage}% ranges of demand before that buffer</>}. Statistical model, not machine learning.
                  </p>
                )}
              </>
            );
          }}
        </MetricCard>
      </Stage>

      {/* 2. EXPLAIN ---------------------------------------------------------------------------------------- */}
      <Stage stageKey="explain" title="Explain" tagline="Where recent waste came from." action={<LinkButton onClick={go('waste-attribution')}>Open waste attribution</LinkButton>}>
        <MetricCard
          title="Current waste"
          hint={`${periods.from} to ${today}`}
          resource={currentWaste}
          isEmpty={({ waste }) => waste.totals.logCount === 0}
          empty={<EmptyState title="No daily logs in this period" actionLabel="Record today's log" onAction={go('daily-logs')}>Waste is calculated from the leftover quantity in your daily logs.</EmptyState>}
        >
          {({ waste, loss }) => (
            <>
              <div className="dash-cols">
                <Kpi value={formatNumber(waste.totals.wasteQuantity)} unit={unitOf(waste)} caption={`${waste.totals.wastePercentage === null ? '—' : formatPercent(waste.totals.wastePercentage)} of ${formatNumber(waste.totals.preparedQuantity)} prepared · ${waste.totals.logCount} log(s)`} />
                <Kpi value={formatInr(loss.totalEstimatedLoss)} caption="estimated loss from item costs" />
              </div>
              {waste.meta && waste.meta.mixedUnits && <p className="dash-note">Menu items use different units ({waste.meta.units.join(', ')}), so combined quantities are indicative only.</p>}
            </>
          )}
        </MetricCard>

        <MetricCard
          title="Top waste contributor"
          resource={wasteNow}
          action={<LinkButton onClick={go('root-cause')}>Find the cause</LinkButton>}
          isEmpty={(waste) => waste.topMenuItems.length === 0}
          empty={<EmptyState title="No waste contributor to show" tone="good">No leftover was recorded in this period, or there are no logs yet.</EmptyState>}
        >
          {(waste) => {
            const top = waste.topMenuItems[0];
            return (
              <>
                <Kpi value={top.name} caption={`${formatPercent(top.contributionPercentage, 0)} of recorded waste · ${formatNumber(top.wasteQuantity)} ${top.unit}`} />
                {contributorInsights(waste).length > 0 && (
                  <ul className="dash-list">
                    {contributorInsights(waste).map((insight) => <li key={insight.type}><span>{insight.message}</span></li>)}
                  </ul>
                )}
              </>
            );
          }}
        </MetricCard>
      </Stage>

      {/* 3. PREVENT ---------------------------------------------------------------------------------------- */}
      <Stage stageKey="prevent" title="Prevent" tagline="Spot risk before it becomes waste, and see whether waste is falling." action={<LinkButton onClick={go('prevention')}>Open prevention</LinkButton>}>
        <MetricCard
          title="High-risk food"
          hint="Repeated over-preparation and food whose spoilage risk is raised."
          resource={highRisk}
          isEmpty={({ items }) => items.length === 0}
          empty={
            highRisk.data && (highRisk.data.logs > 0 || highRisk.data.listingsChecked > 0)
              ? <EmptyState title="No high-risk food right now" tone="good">Nothing is being over-prepared repeatedly and no listed food has a raised spoilage risk.</EmptyState>
              : <EmptyState title="Not enough data yet">Risk appears once you have daily logs or listed surplus.</EmptyState>
          }
        >
          {({ items }) => (
            <>
              <ul className="dash-list">
                {items.slice(0, 5).map((item) => (
                  <li key={item.key}>
                    <span><strong>{item.title}</strong><div className="dash-list-detail">{item.detail}</div></span>
                    <span className={`badge ${item.level === 'HIGH' ? 'badge-danger' : 'badge-warning'}`}>{item.kind === 'spoilage' ? item.level : 'Recurring'}</span>
                  </li>
                ))}
              </ul>
              <p className="dash-note">Spoilage risk is an advisory estimate, not a food-safety guarantee.</p>
            </>
          )}
        </MetricCard>

        <MetricCard
          title="Waste reduction"
          hint={`Share of prepared food left over: ${periods.from} to ${today} vs ${periods.previousFrom} to ${periods.previousTo}`}
          resource={reduction}
          isEmpty={(change) => change.state === 'insufficient'}
          empty={<EmptyState title="Not enough data to compare yet" actionLabel="Open daily logs" onAction={go('daily-logs')}>Needs daily logs in both periods ({reduction.data ? reduction.data.reason : ''}).</EmptyState>}
        >
          {(change) => {
            const verdict = { down: ['less waste', 'badge-success'], up: ['more waste', 'badge-danger'], flat: ['no change', 'badge-neutral'] }[change.direction];
            return (
              <>
                <Kpi
                  value={change.changePct === null ? (change.direction === 'flat' ? '0%' : 'New') : `${Math.abs(change.changePct).toFixed(0)}%`}
                  unit={change.changePct === null && change.direction === 'up' ? 'waste after a waste-free week' : verdict[0]}
                  caption={`${formatPercent(change.ratePrevious)} → ${formatPercent(change.rateNow)} of prepared food left over`}
                />
                <span className={`badge ${verdict[1]}`}>{change.direction === 'down' ? 'Improving' : change.direction === 'up' ? 'Needs attention' : 'Steady'}</span>
                <p className="dash-note">Compared by rate, so a busier week is not mistaken for more waste.</p>
              </>
            );
          }}
        </MetricCard>
      </Stage>

      {/* 4. RESCUE ----------------------------------------------------------------------------------------- */}
      <Stage stageKey="rescue" title="Rescue & Redistribute" tagline="Get surplus to an NGO before it spoils." action={<LinkButton onClick={go('surplus')}>Open surplus</LinkButton>}>
        <MetricCard
          title="Rescue opportunities"
          resource={opportunities}
          isEmpty={(o) => o.count === 0}
          empty={<EmptyState title="No surplus is listed right now" actionLabel="List surplus" onAction={go('surplus')}>When food is left over, list it so nearby verified NGOs can collect it.</EmptyState>}
        >
          {(o) => (
            <>
              <Kpi value={o.count} unit={o.count === 1 ? 'listing waiting' : 'listings waiting'} caption={`${formatNumber(o.quantity)} units · soonest expires in ${formatMinutes(o.soonestMinutes)}`} />
              {o.urgentCount > 0 && <span className="badge badge-danger">{o.urgentCount} expiring within {formatMinutes(URGENT_MINUTES)}</span>}
            </>
          )}
        </MetricCard>

        <MetricCard
          title="NGO rescue status"
          hint="Your listings from the last 30 days."
          resource={pipeline}
          isEmpty={(p) => p.total === 0}
          empty={<EmptyState title="No listings in the last 30 days" actionLabel="List surplus" onAction={go('surplus')}>The status of each listing (available, claimed, collected) is tracked here.</EmptyState>}
        >
          {(p) => {
            const seg = (n) => `${(n / p.total) * 100}%`;
            return (
              <>
                <div className="dash-bar" role="img" aria-label={`${p.available} available, ${p.claimed} claimed, ${p.collected} collected, ${p.expired} expired`}>
                  <span className="seg-available" style={{ width: seg(p.available) }} />
                  <span className="seg-claimed" style={{ width: seg(p.claimed) }} />
                  <span className="seg-collected" style={{ width: seg(p.collected) }} />
                  <span className="seg-expired" style={{ width: seg(p.expired) }} />
                </div>
                <div className="dash-legend">
                  <span><i style={{ background: '#4a86b8' }} />Available {p.available}</span>
                  <span><i style={{ background: '#d69a2d' }} />Claimed {p.claimed}</span>
                  <span><i style={{ background: 'var(--success)' }} />Collected {p.collected}</span>
                  <span><i style={{ background: '#9aa8b5' }} />Expired {p.expired}</span>
                </div>
                {p.collected > 0 && <p className="dash-sub"><strong>{formatNumber(p.collectedQuantity)}</strong> units handed over to NGOs.</p>}
                {p.awaitingConfirmation.length > 0 && (
                  <>
                    <p className="dash-sub"><strong>Action needed:</strong> confirm pickup time</p>
                    <ul className="dash-list">
                      {p.awaitingConfirmation.slice(0, 3).map((l) => (
                        <li key={l.id}><span>{l.food} · {formatNumber(l.quantity)}<div className="dash-list-detail">claimed by {l.ngo}</div></span><LinkButton onClick={go('surplus')}>Confirm</LinkButton></li>
                      ))}
                    </ul>
                  </>
                )}
                {p.awaitingCollection.length > 0 && <p className="dash-sub">{p.awaitingCollection.length} listing(s) confirmed and waiting for the NGO to collect.</p>}
              </>
            );
          }}
        </MetricCard>
      </Stage>

      {/* 5. LEARN ------------------------------------------------------------------------------------------ */}
      <Stage stageKey="learn" title="Measure & Learn" tagline="Track what happened, and check whether the forecasts and recommendations worked." action={<LinkButton onClick={go('learning')}>Open learning</LinkButton>}>
        <MetricCard
          title="Forecast accuracy"
          resource={performance}
          action={<LinkButton onClick={go('forecast-accuracy')}>Details</LinkButton>}
          isEmpty={(p) => p.summary.evaluatedCount === 0 || p.summary.accuracyPercentage === null}
          empty={<EmptyState title="No forecast has been compared with an actual yet">Log what was actually consumed for days that were forecast, and accuracy appears here automatically.</EmptyState>}
        >
          {(p) => {
            const trend = TREND[p.trend.direction] || TREND.insufficient_data;
            const stored = p.summary.bySource.stored.evaluatedCount;
            const reconstructed = p.summary.bySource.reconstructed.evaluatedCount;
            return (
              <>
                <Kpi value={formatPercent(p.summary.accuracyPercentage)} caption={`over ${p.summary.evaluatedCount} item-day(s), ${p.period.startDate} to ${p.period.endDate}`} />
                <span className={`badge ${trend.badge}`}>{trend.label}</span>
                <ul className="dash-list">
                  {p.summary.rangeHitRate !== null && <li><span>Actual fell inside the expected range</span><strong>{formatPercent(p.summary.rangeHitRate, 0)}</strong></li>}
                  {p.summary.biasPercentage !== null && <li><span>Forecasts vs actual (incl. safety buffer)</span><strong>{p.summary.biasPercentage > 0 ? '+' : ''}{formatPercent(p.summary.biasPercentage)}</strong></li>}
                  <li><span>Saved forecasts · rebuilt from earlier logs</span><strong>{stored} · {reconstructed}</strong></li>
                </ul>
              </>
            );
          }}
        </MetricCard>

        <MetricCard
          title="Financial loss avoided"
          hint="Approved recommendations whose day now has an actual log."
          resource={lossAvoided}
          isEmpty={(r) => r.counted === 0}
          empty={<EmptyState title="No approved recommendation has an outcome yet" actionLabel="Open prevention" onAction={go('prevention')}>Approve a recommendation, then log what was actually prepared that day.</EmptyState>}
        >
          {(r) => (
            <>
              <Kpi value={formatInr(r.totalValue)} caption={`${formatNumber(r.totalUnits)} units prepared below the original plan · ${r.counted} approved recommendation(s)`} />
              <p className="dash-note">Estimate: original planned quantity minus what was actually prepared, valued at each item's ingredient and preparation cost.{r.withoutCost > 0 && ` ${r.withoutCost} item(s) have no cost set and add nothing.`}</p>
            </>
          )}
        </MetricCard>

        <MetricCard
          title="CO₂e impact"
          hint={`Since ${periods.from}`}
          resource={impact}
          action={<LinkButton onClick={go('financial')}>Details</LinkButton>}
        >
          {(data) => (
            <>
              <div className="dash-cols">
                <Kpi value={`${formatNumber(data.environmentalImpact.estimatedCo2eKg)} kg`} caption={`from leftover food · ${formatNumber(data.environmentalImpact.mealEquivalents)} meal equivalents`} />
                <Kpi value={`${formatNumber(data.rescued.co2eAvoidedKg)} kg`} caption={data.rescued.listingsCollected === 0 ? 'avoided by rescue: nothing collected yet' : `avoided by rescue · ${formatNumber(data.rescued.collectedQuantity)} units, ${formatNumber(data.rescued.mealEquivalents)} meals`} />
              </div>
              <p className="dash-note">Estimates from the platform's per-unit emission and meal factors; every unit is treated as 1 kg, so they are indicative when items use different units.</p>
            </>
          )}
        </MetricCard>
      </Stage>
    </>
  );
}
