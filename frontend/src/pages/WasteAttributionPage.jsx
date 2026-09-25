import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

const INSIGHT_LABELS = {
  overall_waste_rate: 'Overall',
  no_waste: 'Overall',
  top_waste_contributor: 'Biggest contributor',
  peak_weekday_meal_slot: 'Peak day & meal',
  peak_weekday: 'Peak day',
  repeated_over_preparation: 'Repeated over-preparation',
  high_waste_rate_item: 'High waste rate',
};

const slotName = (slot) => slot.charAt(0) + slot.slice(1).toLowerCase();

function Bar({ percent }) {
  const width = Math.min(100, Math.max(0, percent || 0));
  return (
    <div style={{ background: '#e6ecf1', borderRadius: 4, height: 10, flex: 1, minWidth: 60 }}>
      <div style={{ width: `${width}%`, background: 'var(--gov-navy)', height: '100%', borderRadius: 4 }} />
    </div>
  );
}

function BarRow({ label, percent, detail }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
      <div style={{ width: 90, fontSize: 13 }}>{label}</div>
      <Bar percent={percent} />
      <div className="muted" style={{ width: 150, textAlign: 'right' }}>{detail}</div>
    </div>
  );
}

const fmtPct = (value) => (value === null || value === undefined ? '—' : `${value}%`);

export default function WasteAttributionPage() {
  const { call } = useAuth();
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (start, end) => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        if (start) params.set('startDate', start);
        if (end) params.set('endDate', end);
        const query = params.toString();
        const response = await call(`/analytics/waste-attribution${query ? `?${query}` : ''}`);
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
    load('', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilter = (e) => {
    e.preventDefault();
    load(startDate, endDate);
  };

  const clearFilter = () => {
    setStartDate('');
    setEndDate('');
    load('', '');
  };

  const isEmpty = data && data.totals.logCount === 0;

  return (
    <div>
      <h1>Waste Attribution</h1>
      <p className="muted">
        Where your recorded waste comes from: which dishes, meals and days contribute most, and where over-preparation keeps
        recurring. Waste is the leftover quantity recorded on your daily logs.
      </p>

      <div className="card">
        <form onSubmit={applyFilter} className="form-row" style={{ alignItems: 'end' }}>
          <div className="field">
            <label>From (optional)</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="field">
            <label>To (optional)</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '0 0 auto', display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={loading}>Apply</button>
            <button type="button" className="btn btn-outline" onClick={clearFilter} disabled={loading}>Clear</button>
          </div>
        </form>
        {error && <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      {loading && !data && <p className="muted">Loading…</p>}

      {isEmpty && (
        <div className="card">
          <p className="muted">
            No daily logs found{data.period.startDate || data.period.endDate ? ' for this date range' : ' yet'}. Record daily
            preparation and leftovers in the Daily Logs tab to see where waste comes from.
          </p>
        </div>
      )}

      {data && !isEmpty && (
        <>
          <div className="card">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14 }}>
              <div className="stat"><div className="stat-label">Total Waste</div><div className="stat-value">{data.totals.wasteQuantity}</div></div>
              <div className="stat"><div className="stat-label">Waste %</div><div className="stat-value">{fmtPct(data.totals.wastePercentage)}</div></div>
              <div className="stat"><div className="stat-label">Prepared</div><div className="stat-value">{data.totals.preparedQuantity}</div></div>
              <div className="stat"><div className="stat-label">Consumed</div><div className="stat-value">{data.totals.consumedQuantity}</div></div>
            </div>
            <p className="muted" style={{ marginTop: 10 }}>
              {data.totals.logCount} log(s) from {data.period.firstLogDate} to {data.period.lastLogDate}.
              {data.meta.mixedUnits && <> Your menu items use different units ({data.meta.units.join(', ')}), so combined quantities are indicative only.</>}
            </p>
          </div>

          {data.insights.length > 0 && (
            <div className="card">
              <div className="card-header"><h2>Insights</h2></div>
              {data.insights.map((insight, index) => (
                <div key={`${insight.type}-${index}`} style={{ display: 'flex', gap: 10, padding: '7px 0', borderTop: index ? '1px solid var(--border)' : 'none' }}>
                  <span className="badge badge-info" style={{ alignSelf: 'flex-start', whiteSpace: 'nowrap' }}>{INSIGHT_LABELS[insight.type] || 'Insight'}</span>
                  <span>{insight.message}</span>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <div className="card-header"><h2>Waste by Menu Item</h2></div>
            <table>
              <thead>
                <tr><th>Item</th><th>Waste</th><th>Waste %</th><th style={{ width: '38%' }}>Share of total waste</th></tr>
              </thead>
              <tbody>
                {data.byMenuItem.map((item) => (
                  <tr key={item.menuItemId}>
                    <td>{item.name}</td>
                    <td>{item.wasteQuantity} {item.unit}</td>
                    <td>{fmtPct(item.wastePercentage)}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Bar percent={item.contributionPercentage} />
                        <span style={{ width: 48, textAlign: 'right' }}>{item.contributionPercentage}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="card-header"><h2>By Weekday</h2></div>
              {data.byWeekday.map((day) => (
                <BarRow
                  key={day.weekday}
                  label={day.weekdayName}
                  percent={day.contributionPercentage}
                  detail={`${day.contributionPercentage}% · avg ${day.averageWastePerLog}/log`}
                />
              ))}
            </div>
            <div className="card">
              <div className="card-header"><h2>By Meal Slot</h2></div>
              {data.byMealSlot.map((slot) => (
                <BarRow
                  key={slot.mealSlot}
                  label={slotName(slot.mealSlot)}
                  percent={slot.contributionPercentage}
                  detail={`${slot.contributionPercentage}% · ${fmtPct(slot.wastePercentage)} wasted`}
                />
              ))}
            </div>
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="card-header"><h2>Repeated Over-Preparation</h2></div>
              {data.patterns.recurringOverPreparation.length === 0 ? (
                <p className="muted">No dish has been over-prepared repeatedly in its recent logs.</p>
              ) : (
                <table>
                  <thead><tr><th>Item</th><th>Recent logs over-prepared</th><th>Avg waste %</th></tr></thead>
                  <tbody>
                    {data.patterns.recurringOverPreparation.map((p) => (
                      <tr key={p.menuItemId}>
                        <td>{p.menuItemName}</td>
                        <td>{p.overPreparedLogCount} of {p.recentLogCount}</td>
                        <td>{fmtPct(p.averageWastePercentage)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted" style={{ marginTop: 8 }}>
                Over-prepared = {data.meta.definitions.overPreparedLog.charAt(0).toLowerCase() + data.meta.definitions.overPreparedLog.slice(1)}
              </p>
            </div>
            <div className="card">
              <div className="card-header"><h2>Weekday &amp; Meal Hotspots</h2></div>
              {data.patterns.weekdayMealSlotHotspots.length === 0 ? (
                <p className="muted">Hotspots appear once a weekday and meal has at least two logs with waste.</p>
              ) : (
                <table>
                  <thead><tr><th>Day &amp; meal</th><th>Avg waste / log</th><th>Logs</th></tr></thead>
                  <tbody>
                    {data.patterns.weekdayMealSlotHotspots.map((c) => (
                      <tr key={`${c.weekday}-${c.mealSlot}`}>
                        <td>{c.weekdayName} {slotName(c.mealSlot).toLowerCase()}</td>
                        <td>{c.averageWastePerLog}</td>
                        <td>{c.logCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
