import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function pctVsAverage(index) {
  const pct = Math.round((index - 1) * 100);
  if (pct === 0) return 'in line with average';
  return `${pct > 0 ? '+' : ''}${pct}% vs weekly average`;
}

function SignalCard({ title, status, children }) {
  return (
    <div className="stat">
      <div className="stat-label" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span>{title}</span>
        <span className={`badge ${status === 'applied' ? 'badge-success' : 'badge-neutral'}`}>{status}</span>
      </div>
      <div style={{ fontSize: 14, marginTop: 6 }}>{children}</div>
    </div>
  );
}

const EVIDENCE_TEXT = {
  learned: 'learned from similar past days',
  limited_history: 'only a little history, so blended with a cautious prior',
  declared: 'from the expected impact you entered (no similar past days)',
  none: 'no similar past days and no expected impact, so nothing was changed',
};

function EventCard({ context }) {
  const adjustment = context.adjustment;
  const events = context.target_events || [];
  return (
    <SignalCard title="Events" status={context.applied ? 'applied' : 'not applied'}>
      {events.length > 0 ? (
        <>
          <strong>{events.map((e) => e.name || e.type).join(', ')}</strong>
          {adjustment ? (
            <div className="muted">
              ×{adjustment.factor} ({adjustment.effect_pct > 0 ? '+' : ''}{adjustment.effect_pct}%) — {EVIDENCE_TEXT[adjustment.evidence]}
              {adjustment.learned_from_days > 0 && <> ({adjustment.learned_from_days} similar day(s))</>}
              {adjustment.applied_to === 'demand_estimate_only' && <> · applied to the demand-history part only because you gave a headcount</>}
            </div>
          ) : (
            <div className="muted">Marked as no expected impact, so nothing was changed</div>
          )}
        </>
      ) : (
        <span className="muted">No event on this date</span>
      )}
      {context.history_event_days_excluded > 0 && (
        <div className="muted">{context.history_event_days_excluded} past event day(s) kept out of the baseline</div>
      )}
    </SignalCard>
  );
}

function soldOutText(censoring, quality) {
  if (censoring && censoring.sold_out_days > 0) {
    if (censoring.status === 'adjusted') {
      return `${censoring.sold_out_days} sold-out day(s) treated as "at least this much was wanted" and corrected (recency-weighted demand +${censoring.demand_lift_pct}%)`;
    }
    return `${censoring.sold_out_days} sold-out day(s) could not be corrected (${censoring.reason}) — demand may be understated, so the range is wider`;
  }
  if (quality.stockout_days > 0) return `${quality.stockout_days} day(s) with no leftover (demand may be under-recorded)`;
  return null;
}

function Explainability({ keyFactors }) {
  const { signals, forecast_confidence: confidence, history, data_quality: quality, expected_range: range, demand_censoring: censoring } = keyFactors;
  if (!signals) return null;

  const { historical_demand: demand, weekday, attendance, trend } = signals;

  return (
    <>
      <h3 style={{ marginTop: 18 }}>Why this forecast</h3>
      <div className="grid-2">
        <SignalCard title="Historical demand" status="applied">
          Recency-weighted demand: <strong>{demand.value}</strong> per day
          <div className="muted">
            {demand.observations} days of history (recent days count more; half-life {demand.half_life_days} days)
          </div>
        </SignalCard>

        <SignalCard title={`Weekday pattern (${weekday.weekday})`} status={weekday.active ? 'applied' : 'not applied'}>
          {weekday.active ? (
            <>
              <strong>{pctVsAverage(weekday.index)}</strong>
              <div className="muted">Based on {weekday.observations} past {weekday.weekday}(s)</div>
            </>
          ) : (
            <span className="muted">No {weekday.weekday} history yet, so no weekday adjustment</span>
          )}
        </SignalCard>

        <SignalCard title="Attendance" status={attendance.used ? 'applied' : 'not applied'}>
          {attendance.used ? (
            <>
              Expected headcount <strong>{attendance.expected_headcount}</strong>{' '}
              <span className="muted">({attendance.expected_headcount_source === 'provided' ? 'entered by you' : 'typical for this weekday'})</span>
              <div className="muted">
                {attendance.per_person_demand} per person · carries {Math.round(attendance.attendance_weight * 100)}% of the estimate
                {attendance.demand_headcount_correlation !== null && <> · demand/headcount correlation {attendance.demand_headcount_correlation}</>}
                {attendance.evidence === 'weak' && <> · headcount rarely varies, so treated cautiously</>}
                {attendance.outside_observed_range && <> · headcount is outside anything seen before</>}
              </div>
            </>
          ) : (
            <span className="muted">{attendance.reason}</span>
          )}
        </SignalCard>

        <SignalCard title="Trend" status={trend.applied ? 'applied' : 'not applied'}>
          {trend.applied ? (
            <>
              Demand is <strong>{trend.direction}</strong> ({trend.slope_pct_per_day}% per day) · multiplier ×{trend.multiplier}
            </>
          ) : (
            <span className="muted">No statistically clear trend{trend.eligible ? '' : ' (not enough history to tell)'}</span>
          )}
        </SignalCard>

        {keyFactors.event_context && <EventCard context={keyFactors.event_context} />}
      </div>

      {confidence && (
        <p className="muted" style={{ marginTop: 12 }}>
          Confidence factors — data volume {Math.round(confidence.components.data_volume * 100)}%, stability{' '}
          {Math.round(confidence.components.stability * 100)}%, recency {Math.round(confidence.components.recency * 100)}%, data
          quality {Math.round(confidence.components.data_quality * 100)}%. {confidence.note}
        </p>
      )}
      {range && (
        <p className="muted">
          Expected demand range (approx. {Math.round(range.coverage * 100)}%): <strong>{range.low} – {range.high}</strong>, before the 5% safety buffer.
        </p>
      )}
      <p className="muted">
        History {history.first_date} → {history.last_date} ({history.days_since_last_observation} day(s) before the target)
        {soldOutText(censoring, quality) && <> · {soldOutText(censoring, quality)}</>}
        {quality.invalid_rows_ignored > 0 && <> · {quality.invalid_rows_ignored} unusable log row(s) ignored</>}
        {' · '}Only data before the target date is used.
      </p>
    </>
  );
}

export default function ForecastPage() {
  const { call } = useAuth();
  const [menuItems, setMenuItems] = useState([]);
  const [menuItemId, setMenuItemId] = useState('');
  const [targetDate, setTargetDate] = useState(tomorrowStr());
  const [expectedHeadcount, setExpectedHeadcount] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    call('/menu-items').then((data) => {
      setMenuItems(data.menuItems);
      if (data.menuItems[0]) setMenuItemId(String(data.menuItems[0].id));
    }).catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runForecast = async (e) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);
    try {
      const headcountParam = expectedHeadcount ? `&expectedHeadcount=${encodeURIComponent(expectedHeadcount)}` : '';
      const data = await call(`/forecasts/${menuItemId}?targetDate=${targetDate}${headcountParam}`);
      setResult(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const keyFactors = result?.keyFactors || {};
  const isFallback = result?.modelVersion === 'heuristic_fallback_v1';
  const scalarFactors = Object.entries(keyFactors).filter(([, value]) => value === null || typeof value !== 'object');

  return (
    <div>
      <h1>Demand Forecast</h1>
      <p className="muted">
        Predicts how much of a menu item will be consumed on a given date from its own history: recent demand, weekday
        pattern, trend and attendance. It is a statistical model (not machine learning) and only uses data recorded
        before the target date.
      </p>

      <div className="card">
        {error && <div className="alert alert-error">{error}</div>}
        {menuItems.length === 0 ? (
          <p className="muted">Add a menu item first.</p>
        ) : (
          <form onSubmit={runForecast} className="form-row" style={{ alignItems: 'end' }}>
            <div className="field">
              <label>Menu Item</label>
              <select value={menuItemId} onChange={(e) => setMenuItemId(e.target.value)}>
                {menuItems.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Target Date</label>
              <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
            </div>
            <div className="field">
              <label>Expected Headcount (optional)</label>
              <input
                type="number"
                min="1"
                placeholder="if you know attendance"
                value={expectedHeadcount}
                onChange={(e) => setExpectedHeadcount(e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: '0 0 auto' }}>
              <button className="btn btn-primary" disabled={loading}>{loading ? 'Predicting…' : 'Predict Demand'}</button>
            </div>
          </form>
        )}

        {result && (
          <div style={{ marginTop: 18 }}>
            <div className="grid-2">
              <div className="stat">
                <div className="stat-label">Predicted Quantity</div>
                <div className="stat-value">{result.predictedQuantity}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Confidence Score</div>
                <div className="stat-value">{Math.round(result.confidenceScore * 100)}%</div>
                <div className="muted" style={{ fontSize: 12 }}>Reliability score from data volume and stability, not a probability</div>
              </div>
            </div>

            {keyFactors.reason && (
              <div className="alert" style={{ background: 'var(--info-bg)', color: 'var(--info)', marginTop: 14 }}>
                {keyFactors.reason}
              </div>
            )}

            {isFallback ? (
              <>
                <p className="muted">
                  {keyFactors.detail || 'Not enough history for the full model.'} Log more days for this item to unlock the
                  weekday, trend and attendance signals.
                </p>
                {keyFactors.event_context && <div className="grid-2"><EventCard context={keyFactors.event_context} /></div>}
              </>
            ) : (
              <Explainability keyFactors={keyFactors} />
            )}

            <details style={{ marginTop: 12 }}>
              <summary className="muted">Raw key factors</summary>
              <table>
                <tbody>
                  {scalarFactors.map(([key, value]) => (
                    <tr key={key}><td className="muted">{key.replace(/_/g, ' ')}</td><td>{String(value)}</td></tr>
                  ))}
                </tbody>
              </table>
            </details>
            <p className="muted" style={{ marginTop: 8 }}>
              Model: {result.modelVersion} {isFallback ? '(simple average of prepared quantity)' : '(statistical, not machine learning)'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
