import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatInr, formatNumber } from '../format';

export default function FinancialImpactPage() {
  const { call } = useAuth();
  const [period, setPeriod] = useState('weekly');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError('');
    call(`/financial-impact?period=${period}`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  return (
    <div>
      <h1>Financial &amp; Environmental Impact</h1>
      <p className="muted">
        Estimated monetary loss from leftover food, using each menu item's configured ingredient + preparation cost.
      </p>

      <div className="card">
        <div className="card-header">
          <h2>Loss Summary</h2>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 'auto' }}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {loading && !data ? (
          <p className="muted">Loading…</p>
        ) : data ? (
          <>
            <p className="muted">All figures are estimates based on configured item costs.</p>
            <div className="grid-2">
              <div className="stat"><div className="stat-label">Estimated Loss</div><div className="stat-value">{formatInr(data.totalEstimatedLoss)}</div></div>
              <div className="stat"><div className="stat-label">Potential Savings if Waste Eliminated</div><div className="stat-value">{formatInr(data.breakdown.potentialSavings)}</div></div>
            </div>

            <div className="grid-2" style={{ marginTop: 18 }}>
              <div>
                <h3>Loss by Menu Item</h3>
                {Object.keys(data.breakdown.lossByItem).length === 0 ? (
                  <p className="muted">No waste logged for this period.</p>
                ) : (
                  <table>
                    <tbody>
                      {Object.entries(data.breakdown.lossByItem).sort((a, b) => b[1] - a[1]).map(([item, loss]) => (
                        <tr key={item}><td>{item}</td><td style={{ textAlign: 'right' }}>{formatInr(loss)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <h3>Loss by Date</h3>
                {Object.keys(data.breakdown.lossByDate).length === 0 ? (
                  <p className="muted">No waste logged for this period.</p>
                ) : (
                  <table>
                    <tbody>
                      {Object.entries(data.breakdown.lossByDate).sort((a, b) => b[0].localeCompare(a[0])).map(([date, loss]) => (
                        <tr key={date}><td>{date}</td><td style={{ textAlign: 'right' }}>{formatInr(loss)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {data.environmentalImpact && (
              <>
                <h3 style={{ marginTop: 18 }}>Environmental impact of leftover food</h3>
                <div className="grid-2">
                  <div className="stat"><div className="stat-label">Estimated CO₂e</div><div className="stat-value">{formatNumber(data.environmentalImpact.estimatedCo2eKg)} kg</div></div>
                  <div className="stat"><div className="stat-label">Meal equivalents left over</div><div className="stat-value">{formatNumber(data.environmentalImpact.mealEquivalents)}</div></div>
                </div>
              </>
            )}

            {data.rescued && (
              <>
                <h3 style={{ marginTop: 18 }}>Surplus rescued by NGOs</h3>
                {data.rescued.listingsCollected === 0 ? (
                  <p className="muted">No surplus was collected by an NGO in this period.</p>
                ) : (
                  <div className="grid-2">
                    <div className="stat"><div className="stat-label">Collected ({data.rescued.listingsCollected} listing(s))</div><div className="stat-value">{formatNumber(data.rescued.collectedQuantity)}</div></div>
                    <div className="stat"><div className="stat-label">Meal equivalents · CO₂e</div><div className="stat-value">{formatNumber(data.rescued.mealEquivalents)} · {formatNumber(data.rescued.co2eAvoidedKg)} kg</div></div>
                  </div>
                )}
                <p className="muted">{data.rescued.note}</p>
              </>
            )}

            <div className="alert" style={{ background: 'var(--info-bg)', color: 'var(--info)', marginTop: 18 }}>
              Environmental figures are estimates that treat every unit as 1 kg (2.5 kg CO₂e and 0.4 kg per meal), so
              they are only indicative when menu items use different units.
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
