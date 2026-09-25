import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

const DIRECTION_BADGE = { exact: 'badge-success', over: 'badge-warning', under: 'badge-danger' };
const DIRECTION_LABEL = { exact: 'Exact', over: 'Over', under: 'Under' };
const TREND_BADGE = { improving: 'badge-success', worsening: 'badge-danger', stable: 'badge-info', insufficient_data: 'badge-neutral' };
const TREND_LABEL = { improving: 'Improving', worsening: 'Getting worse', stable: 'Stable', insufficient_data: 'Not enough data yet' };

const fmtPct = (value) => (value === null || value === undefined ? '—' : `${value}%`);
const signed = (value) => (value === null || value === undefined ? '—' : `${value > 0 ? '+' : ''}${value}`);

function Bar({ percent, color = 'var(--gov-navy)', height = 10 }) {
  const width = Math.min(100, Math.max(0, percent || 0));
  return (
    <div style={{ background: '#e6ecf1', borderRadius: 4, height, flex: 1, minWidth: 50 }}>
      <div style={{ width: `${width}%`, background: color, height: '100%', borderRadius: 4 }} />
    </div>
  );
}

function PredictedVsActual({ predicted, actual }) {
  const max = Math.max(predicted || 0, actual || 0, 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 110 }}>
      <Bar percent={(predicted / max) * 100} height={6} />
      <Bar percent={((actual || 0) / max) * 100} color="var(--gov-gold)" height={6} />
    </div>
  );
}

export default function ForecastAccuracyPage() {
  const { call } = useAuth();
  const [menuItems, setMenuItems] = useState([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [menuItemId, setMenuItemId] = useState('');
  const [savedOnly, setSavedOnly] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (filters) => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        if (filters.startDate) params.set('startDate', filters.startDate);
        if (filters.endDate) params.set('endDate', filters.endDate);
        if (filters.menuItemId) params.set('menuItemId', filters.menuItemId);
        if (filters.savedOnly) params.set('source', 'stored');
        const query = params.toString();
        const response = await call(`/analytics/forecast-performance${query ? `?${query}` : ''}`);
        setData(response.data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [call]
  );

  useEffect(() => {
    call('/menu-items').then((res) => setMenuItems(res.menuItems)).catch(() => {});
    load({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = (e) => {
    e.preventDefault();
    load({ startDate, endDate, menuItemId, savedOnly });
  };

  const clear = () => {
    setStartDate('');
    setEndDate('');
    setMenuItemId('');
    setSavedOnly(false);
    load({});
  };

  const summary = data?.summary;
  const hasEvaluated = summary && summary.evaluatedCount > 0;

  return (
    <div>
      <h1>Forecast Accuracy &amp; Learning</h1>
      <p className="muted">
        Closes the loop: each forecast is compared with what was actually consumed, so you can see how accurate it is, whether
        it is improving, and whether following the AI's prevention advice paid off. Only information available before each
        target date is ever used.
      </p>

      <div className="card">
        <form onSubmit={apply} className="form-row" style={{ alignItems: 'end' }}>
          <div className="field">
            <label>From (optional)</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="field">
            <label>To (optional)</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Menu item</label>
            <select value={menuItemId} onChange={(e) => setMenuItemId(e.target.value)}>
              <option value="">All items</option>
              {menuItems.map((item) => (<option key={item.id} value={item.id}>{item.name}</option>))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 auto', display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={loading}>Apply</button>
            <button type="button" className="btn btn-outline" onClick={clear} disabled={loading}>Clear</button>
          </div>
        </form>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontWeight: 400 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={savedOnly} onChange={(e) => setSavedOnly(e.target.checked)} />
          Only forecasts that were saved before the outcome (exclude "reconstructed" ones)
        </label>
        {data && (
          <p className="muted" style={{ marginTop: 8 }}>
            Showing {data.period.startDate} to {data.period.endDate}{data.period.defaulted ? ' (last 90 days)' : ''}.
          </p>
        )}
        {error && <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      {loading && !data && <p className="muted">Loading…</p>}

      {data && (
        <>
          <div className="card">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14 }}>
              <div className="stat"><div className="stat-label">Accuracy</div><div className="stat-value">{fmtPct(summary.accuracyPercentage)}</div></div>
              <div className="stat"><div className="stat-label">Avg error / item-day</div><div className="stat-value">{summary.mae ?? '—'}</div></div>
              <div className="stat">
                <div className="stat-label">Bias</div>
                <div className="stat-value">{summary.biasPercentage === null ? '—' : `${signed(summary.biasPercentage)}%`}</div>
                <div className="muted">{summary.biasPercentage === null ? '' : summary.biasPercentage > 0 ? 'over-predicts' : summary.biasPercentage < 0 ? 'under-predicts' : 'balanced'}</div>
              </div>
              <div className="stat"><div className="stat-label">Compared</div><div className="stat-value">{summary.evaluatedCount}</div></div>
            </div>
            <p className="muted" style={{ marginTop: 10 }}>
              {summary.overpredictedCount} over · {summary.underpredictedCount} under · {summary.exactCount} exact
              {summary.rangeHitRate !== null && <> · actual fell inside the expected range {summary.rangeHitRate}% of the time</>}
              {summary.pendingCount > 0 && <> · {summary.pendingCount} awaiting an actual log</>}
              {summary.missingActualCount > 0 && <> · {summary.missingActualCount} past forecast(s) never logged</>}
              {' · '}{summary.bySource.stored.evaluatedCount} saved, {summary.bySource.reconstructed.evaluatedCount} reconstructed
            </p>
          </div>

          {data.insights.length > 0 && (
            <div className="card">
              <div className="card-header"><h2>Insights</h2></div>
              {data.insights.map((insight, index) => (
                <div key={`${insight.type}-${index}`} style={{ padding: '6px 0', borderTop: index ? '1px solid var(--border)' : 'none' }}>{insight.message}</div>
              ))}
            </div>
          )}

          {hasEvaluated && (
            <div className="card">
              <div className="card-header">
                <h2>Improvement Trend</h2>
                <span className={`badge ${TREND_BADGE[data.trend.direction]}`}>{TREND_LABEL[data.trend.direction]}</span>
              </div>
              {data.trend.direction === 'insufficient_data' ? (
                <p className="muted">At least {data.trend.minimumRecords} compared forecasts are needed to judge a trend (currently {data.trend.evaluatedCount}).</p>
              ) : (
                <p className="muted">Forecast error: {data.trend.olderWape}% in the earlier half → {data.trend.newerWape}% in the most recent half ({signed(data.trend.changePoints)} points).</p>
              )}
              {data.weekly.map((week) => (
                <div key={week.weekStart} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                  <div style={{ width: 110, fontSize: 13 }}>Week of {week.weekStart.slice(5)}</div>
                  <Bar percent={week.accuracyPercentage} />
                  <div className="muted" style={{ width: 150, textAlign: 'right' }}>{fmtPct(week.accuracyPercentage)} · {week.evaluatedCount} compared</div>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <h2>Predicted vs Actual</h2>
              <span className="muted">
                <span style={{ color: 'var(--gov-navy)' }}>■</span> predicted &nbsp;
                <span style={{ color: 'var(--gov-gold)' }}>■</span> actual
              </span>
            </div>
            {data.records.length === 0 ? (
              <p className="muted">Nothing to show for this period yet.</p>
            ) : (
              <table>
                <thead>
                  <tr><th>Date</th><th>Item</th><th>Predicted</th><th>Actual</th><th></th><th>Error</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {data.records.map((record) => (
                    <tr key={`${record.menuItemId}-${record.targetDate}`}>
                      <td>{record.targetDate}</td>
                      <td>{record.menuItemName}</td>
                      <td>
                        {record.forecast.predictedQuantity}{' '}
                        {record.forecast.source === 'reconstructed' && <span className="badge badge-neutral" title="Recomputed from earlier logs only">recon.</span>}
                      </td>
                      <td>{record.actual ? record.actual.consumedQuantity : '—'}</td>
                      <td>{record.actual && <PredictedVsActual predicted={record.forecast.predictedQuantity} actual={record.actual.consumedQuantity} />}</td>
                      <td>
                        {record.error
                          ? <>{signed(record.error.error)}{record.error.percentageError !== null && <span className="muted"> ({signed(record.error.percentageError)}%)</span>}</>
                          : '—'}
                      </td>
                      <td>
                        {record.error
                          ? <span className={`badge ${DIRECTION_BADGE[record.error.direction]}`}>{DIRECTION_LABEL[record.error.direction]}</span>
                          : <span className="badge badge-neutral">{record.status === 'awaiting_actual' ? 'Awaiting actual' : 'No actual logged'}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {data.recordsTruncated && <p className="muted" style={{ marginTop: 8 }}>Showing the most recent {data.records.length} records; the metrics above include all of them.</p>}
          </div>

          {data.byMenuItem.length > 0 && (
            <div className="card">
              <div className="card-header"><h2>By Menu Item</h2></div>
              <table>
                <thead><tr><th>Item</th><th>Compared</th><th>Accuracy</th><th>Avg error</th><th>Bias</th></tr></thead>
                <tbody>
                  {data.byMenuItem.map((item) => (
                    <tr key={item.menuItemId}>
                      <td>{item.name}</td>
                      <td>{item.evaluatedCount}</td>
                      <td>{fmtPct(item.accuracyPercentage)}</td>
                      <td>{item.mae} {item.unit}</td>
                      <td>{item.biasPercentage === null ? '—' : `${signed(item.biasPercentage)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <h2>Intervention Outcomes</h2>
              {data.interventions.summary.averageEffectivenessScore !== null && (
                <span className="badge badge-info">Average effectiveness {data.interventions.summary.averageEffectivenessScore}</span>
              )}
            </div>
            {data.interventions.items.length === 0 ? (
              <p className="muted">No approved or rejected prevention recommendations in this period. Decide on a recommendation in the Prevention tab to start tracking outcomes.</p>
            ) : (
              <>
                <p className="muted">
                  {data.interventions.summary.decidedCount} decided · {data.interventions.summary.evaluatedCount} scored
                  {data.interventions.summary.pendingEvaluationCount > 0 && <> · {data.interventions.summary.pendingEvaluationCount} ready to score (run the Learning tab)</>}
                  {data.interventions.summary.awaitingActualCount > 0 && <> · {data.interventions.summary.awaitingActualCount} awaiting the actual log</>}
                  {data.interventions.summary.positiveOutcomeShare !== null && <> · {data.interventions.summary.positiveOutcomeShare}% had a positive outcome</>}
                </p>
                <table>
                  <thead>
                    <tr><th>Date</th><th>Item</th><th>Decision</th><th>AI advised / original plan</th><th>Forecast</th><th>Actual (prepared / used / left)</th><th>Effectiveness</th></tr>
                  </thead>
                  <tbody>
                    {data.interventions.items.map((item) => (
                      <tr key={item.recommendationId}>
                        <td>{item.targetDate}</td>
                        <td>{item.menuItemName}</td>
                        <td><span className={`badge ${item.managerAction === 'approved' ? 'badge-success' : 'badge-danger'}`}>{item.managerAction}</span></td>
                        <td>{item.recommendedQuantity ?? '—'} / {item.originalPlannedQuantity ?? '—'}</td>
                        <td>{item.forecast.linked ? item.forecast.predictedQuantity : <span className="muted">not linked</span>}</td>
                        <td>
                          {item.actual
                            ? `${item.actual.preparedQuantity ?? '—'} / ${item.actual.consumedQuantity} / ${item.actual.leftoverQuantity ?? '—'}`
                            : <span className="muted">awaiting actual</span>}
                        </td>
                        <td>
                          {item.outcome.evaluated
                            ? <span className={`badge ${item.outcome.effectivenessScore > 0 ? 'badge-success' : 'badge-danger'}`}>{item.outcome.effectivenessScore}</span>
                            : <span className="muted">{item.actual ? 'not scored yet' : '—'}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
