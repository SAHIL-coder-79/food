import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatInr, formatNumber } from '../format';

export default function SimulatorPage() {
  const { call } = useAuth();
  const [menuItems, setMenuItems] = useState([]);
  const [menuItemId, setMenuItemId] = useState('');
  const [targetDate, setTargetDate] = useState(new Date().toISOString().split('T')[0]);
  const [proposedQuantity, setProposedQuantity] = useState(100);
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

  const run = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await call('/simulations/run', {
        method: 'POST',
        body: { menuItemId: parseInt(menuItemId, 10), targetDate, proposedQuantity: parseFloat(proposedQuantity) },
      });
      setResult(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1>What-If Simulator</h1>
      <p className="muted">Run a hypothetical preparation scenario without touching real records — every figure below is an estimate.</p>

      <div className="card">
        {error && <div className="alert alert-error">{error}</div>}
        {menuItems.length === 0 ? (
          <p className="muted">Add a menu item first.</p>
        ) : (
          <form onSubmit={run} className="form-row" style={{ alignItems: 'end' }}>
            <div className="field">
              <label>Menu Item</label>
              <select value={menuItemId} onChange={(e) => setMenuItemId(e.target.value)}>
                {menuItems.map((item) => (<option key={item.id} value={item.id}>{item.name}</option>))}
              </select>
            </div>
            <div className="field">
              <label>Target Date</label>
              <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
            </div>
            <div className="field">
              <label>Proposed Prep Quantity</label>
              <input type="number" min="0" value={proposedQuantity} onChange={(e) => setProposedQuantity(e.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 0 auto' }}>
              <button className="btn btn-primary" disabled={loading}>{loading ? 'Simulating…' : 'Run Simulation'}</button>
            </div>
          </form>
        )}

        {result && (
          <div style={{ marginTop: 18 }}>
            <div className="grid-2">
              <div className="stat"><div className="stat-label">Predicted Demand</div><div className="stat-value">{formatNumber(result.predictedDemand)}</div></div>
              {result.estimatedSurplus > 0 ? (
                <div className="stat"><div className="stat-label">Estimated Surplus (Waste Risk)</div><div className="stat-value">{formatNumber(result.estimatedSurplus)}</div></div>
              ) : (
                <div className="stat"><div className="stat-label">Shortage Risk</div><div className="stat-value">{formatNumber(result.estimatedShortageRisk)}</div></div>
              )}
              <div className="stat"><div className="stat-label">Financial Waste</div><div className="stat-value">{formatInr(result.financialWaste)}</div></div>
              <div className="stat"><div className="stat-label">CO₂e Emissions</div><div className="stat-value">{formatNumber(result.environmentalImpact.co2eEmissionsKg)} kg</div></div>
            </div>
            <p className="muted" style={{ marginTop: 10 }}>Meal-equivalents lost: {formatNumber(result.environmentalImpact.mealEquivalents)}</p>
          </div>
        )}
      </div>
    </div>
  );
}
