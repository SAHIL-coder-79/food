import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatDateTime, formatNumber } from '../format';
import { buildRouteView } from '../pages/rescueRouteView';

// Lets an NGO batch several of its own claimed listings into one deterministic pickup route. This is a
// planning estimate only - straight-line distance, one configurable average speed, no live traffic or GPS.
export default function RescueRouteBuilder({ eligibleListings }) {
  const { call } = useAuth();
  const [selected, setSelected] = useState(() => new Set());
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error
  const [route, setRoute] = useState(null);
  const [error, setError] = useState('');

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const buildRoute = async () => {
    setError('');
    setStatus('loading');
    try {
      const data = await call('/rescue-routes/preview', { method: 'POST', body: { listingIds: [...selected] } });
      setRoute(data.data);
      setStatus('ready');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  };

  const foodTypeById = new Map(eligibleListings.map((l) => [l.id, l.food_type]));
  const view = buildRouteView(route);

  if (eligibleListings.length === 0) {
    return null;
  }

  return (
    <div className="card">
      <div className="card-header"><h2>Rescue Route Planning</h2></div>
      <p className="muted">
        Select claimed pickups to batch into one route. This produces a deterministic planning estimate - straight-line
        distances and one average speed assumption, not live navigation or real road traffic.
      </p>

      <table>
        <thead><tr><th></th><th>ID</th><th>Food</th><th>Qty</th><th>Status</th></tr></thead>
        <tbody>
          {eligibleListings.map((l) => (
            <tr key={l.id}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(l.id)}
                  disabled={l.status !== 'Claimed'}
                  onChange={() => toggle(l.id)}
                />
              </td>
              <td>#{l.id}</td>
              <td>{l.food_type}</td>
              <td>{formatNumber(l.quantity)} kg</td>
              <td>{l.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" className="btn btn-primary" disabled={selected.size === 0 || status === 'loading'} onClick={buildRoute}>
          {status === 'loading' ? 'Building Route…' : `Build Rescue Route (${selected.size} selected)`}
        </button>
        {selected.size === 0 && <span className="muted">Select at least one claimed pickup to build a route.</span>}
      </div>

      {status === 'error' && (
        <div className="alert alert-error" style={{ marginTop: 12 }}>
          {error} <button type="button" className="btn btn-outline btn-sm" onClick={buildRoute} style={{ marginLeft: 8 }}>Retry</button>
        </div>
      )}

      {view && (
        <div style={{ marginTop: 16 }}>
          <div className="card-header"><h3 style={{ margin: 0 }}>Rescue Route</h3></div>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Estimated planning route only - straight-line distance and a fixed average speed assumption, not real-time
            navigation, live traffic, or GPS tracking.
          </p>

          {view.routeLevelWarnings.length > 0 && (
            <div className="alert alert-error" style={{ marginBottom: 10 }}>
              {view.routeLevelWarnings.map((message, i) => <div key={i}>{message}</div>)}
            </div>
          )}

          {view.isEmpty ? (
            <p className="muted">No stops could be routed (see warnings above).</p>
          ) : (
            <>
              <p><strong>Origin:</strong> {view.originLabel}</p>
              <table>
                <thead>
                  <tr>
                    <th>#</th><th>Listing</th><th>Food</th><th>Qty</th><th>Distance</th><th>Cumulative</th>
                    <th>Est. Arrival</th><th>Safe Until</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {view.stops.map((stop) => (
                    <React.Fragment key={stop.listingId}>
                      <tr>
                        <td>{stop.sequence}</td>
                        <td>#{stop.listingId}</td>
                        <td>{foodTypeById.get(stop.listingId) || '—'}</td>
                        <td>{formatNumber(stop.quantity)} kg</td>
                        <td>{stop.distanceFromPreviousKm != null ? `${formatNumber(stop.distanceFromPreviousKm)} km` : '—'}</td>
                        <td>{stop.cumulativeDistanceKm != null ? `${formatNumber(stop.cumulativeDistanceKm)} km` : '—'}</td>
                        <td>{formatDateTime(stop.estimatedArrivalTime)}</td>
                        <td>{formatDateTime(stop.safeUntilTime)}</td>
                        <td><span className={`badge ${stop.badgeClass}`}>{stop.statusLabel}</span></td>
                      </tr>
                      {stop.warningMessage && (
                        <tr>
                          <td colSpan={9} className="muted" style={{ fontSize: 12 }}>{stop.warningMessage}</td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
              <div className="grid-2" style={{ marginTop: 10 }}>
                <div className="stat"><div className="stat-label">Total Distance</div><div className="stat-value">{formatNumber(view.totalDistanceKm)} km</div></div>
                <div className="stat"><div className="stat-label">Estimated Travel Time</div><div className="stat-value">{view.estimatedTravelMinutes} min</div></div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
