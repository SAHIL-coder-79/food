import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatNumber } from '../format';

const CAUSE_LABELS = {
  no_waste: 'No Waste',
  insufficient_data: 'Insufficient Historical Data',
  over_preparation_vs_plan: 'Over-Preparation vs. Plan',
  forecast_overestimation: 'Forecast Overestimation',
  low_attendance: 'Lower Attendance Than Usual',
  low_consumption_rate: 'Low Consumption Rate (Unpopular Dish)',
  unexplained_variance: 'Unexplained Variance',
};

export default function RootCausePage() {
  const { call } = useAuth();
  const [logs, setLogs] = useState([]);
  const [dailyLogId, setDailyLogId] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(true);

  useEffect(() => {
    call('/daily-logs').then((data) => {
      setLogs(data.logs);
      if (data.logs[0]) setDailyLogId(String(data.logs[0].id));
    }).catch((err) => setError(err.message)).finally(() => setLogsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAnalysis = async (e) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);
    try {
      const data = await call(`/root-causes/${dailyLogId}`);
      setResult(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1>Root Cause Analysis</h1>
      <p className="muted">
        Explains *why* a specific day's leftover happened — over-preparation, forecast error, low attendance, or an
        unpopular dish — by comparing that log against the item's history.
      </p>

      <div className="card">
        {error && <div className="alert alert-error">{error}</div>}
        {logsLoading ? (
          <p className="muted">Loading…</p>
        ) : logs.length === 0 ? (
          <p className="muted">Record a daily log first.</p>
        ) : (
          <form onSubmit={runAnalysis} className="form-row" style={{ alignItems: 'end' }}>
            <div className="field">
              <label>Daily Log</label>
              <select value={dailyLogId} onChange={(e) => setDailyLogId(e.target.value)}>
                {logs.map((log) => (
                  <option key={log.id} value={log.id}>
                    #{log.id} — {log.menu_item_name} — {String(log.log_date).slice(0, 10)} ({log.meal_slot})
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 auto' }}>
              <button className="btn btn-primary" disabled={loading}>{loading ? 'Analyzing…' : 'Analyze'}</button>
            </div>
          </form>
        )}

        {result && (
          <div style={{ marginTop: 18 }}>
            <div className="card-header">
              <h2>{CAUSE_LABELS[result.cause] || result.cause}</h2>
              <span className="badge badge-info">Confidence {Math.round(result.confidenceScore * 100)}%</span>
            </div>
            <p><strong>Estimated Contribution to Waste:</strong> {formatNumber(result.estimatedContribution)} units</p>
            <h3>Supporting Metrics</h3>
            <table>
              <tbody>
                {Object.entries(result.supportingMetrics || {}).map(([key, value]) => (
                  <tr key={key}><td className="muted">{key.replace(/_/g, ' ')}</td><td>{typeof value === 'number' ? formatNumber(value) : String(value)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
