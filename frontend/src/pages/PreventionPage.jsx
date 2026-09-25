import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { buildPreventionView } from './preventionView';

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

export default function PreventionPage() {
  const { call } = useAuth();
  const [menuItems, setMenuItems] = useState([]);
  const [menuItemId, setMenuItemId] = useState('');
  const [targetDate, setTargetDate] = useState(todayStr());
  const [plannedQuantity, setPlannedQuantity] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [menuItemsLoading, setMenuItemsLoading] = useState(true);

  useEffect(() => {
    call('/menu-items').then((data) => {
      setMenuItems(data.menuItems);
      if (data.menuItems[0]) setMenuItemId(String(data.menuItems[0].id));
    }).catch((err) => setError(err.message)).finally(() => setMenuItemsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEvaluate = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setResult(null);
    try {
      const data = await call('/prevention/evaluate', {
        method: 'POST',
        body: { menuItemId: parseInt(menuItemId, 10), targetDate, plannedQuantity: parseFloat(plannedQuantity) },
      });
      setResult(data.data);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleStatus = async (status) => {
    setError('');
    try {
      await call(`/prevention/${result.recommendationId}/status`, { method: 'PATCH', body: { status } });
      setMessage(`Recommendation ${status}. This decision feeds the Learning phase later.`);
      setResult({ ...result, decided: status });
    } catch (err) {
      setError(err.message);
    }
  };

  const view = result ? buildPreventionView(result) : null;

  return (
    <div>
      <h1>Proactive Waste Prevention</h1>
      <p className="muted">
        Compares what you plan to prepare against the AI's predicted demand and flags overproduction risk before food
        is cooked.
      </p>

      <div className="card">
        {error && <div className="alert alert-error">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}
        {menuItemsLoading ? (
          <p className="muted">Loading…</p>
        ) : menuItems.length === 0 ? (
          <p className="muted">Add a menu item first.</p>
        ) : (
          <form onSubmit={handleEvaluate} className="form-row" style={{ alignItems: 'end' }}>
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
              <label>Planned Quantity</label>
              <input type="number" required min="0" value={plannedQuantity} onChange={(e) => setPlannedQuantity(e.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 0 auto' }}>
              <button className="btn btn-primary">Evaluate Risk</button>
            </div>
          </form>
        )}

        {view && (
          <div style={{ marginTop: 18 }}>
            <div className="card-header">
              <h2>Risk Level</h2>
              <span className={`badge ${view.riskBadgeClass}`}>{view.riskLevel}</span>
            </div>
            <div className="grid-2">
              <div className="stat"><div className="stat-label">Predicted Demand</div><div className="stat-value">{view.predictedQuantity}</div></div>
              <div className="stat">
                <div className="stat-label">Planned Quantity</div>
                <div className="stat-value">{view.plannedQuantity}</div>
                {view.rangePosition && (
                  <span className={`badge ${view.rangePosition.badgeClass}`} style={{ marginTop: 6, display: 'inline-block' }}>
                    {view.rangePosition.label}
                  </span>
                )}
              </div>
              <div className="stat"><div className="stat-label">Estimated Excess</div><div className="stat-value">{view.excess}</div></div>
              <div className="stat">
                <div className="stat-label">Confidence</div>
                <div className="stat-value">{view.confidencePercent}%</div>
                {view.confidenceIsHeuristic && (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>Heuristic reliability score, not a calibrated probability</div>
                )}
              </div>
            </div>

            {view.range ? (
              <p className="muted" style={{ marginTop: 12 }}>
                Expected demand range (approx. {view.range.coveragePercent}%): <strong>{view.range.low} – {view.range.high}</strong>, before the safety buffer.
              </p>
            ) : (
              <p className="muted" style={{ marginTop: 12 }}>
                No expected range is available for this forecast yet (not enough history for the statistical model).
              </p>
            )}

            {(result.riskLevel === 'MEDIUM' || result.riskLevel === 'HIGH') && (
              <div style={{ marginTop: 16 }}>
                <p>Recommendation: reduce preparation to <strong>{result.recommendedQuantity}</strong> units.</p>
                {result.decided ? (
                  <span className={`badge ${result.decided === 'approved' ? 'badge-success' : 'badge-danger'}`}>
                    {result.decided.toUpperCase()}
                  </span>
                ) : result.recommendationId ? (
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button className="btn btn-success" onClick={() => handleStatus('approved')}>Approve</button>
                    <button className="btn btn-danger" onClick={() => handleStatus('rejected')}>Reject</button>
                  </div>
                ) : (
                  <p className="muted">Recommendation could not be saved for follow-up.</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
