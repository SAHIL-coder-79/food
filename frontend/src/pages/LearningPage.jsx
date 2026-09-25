import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

export default function LearningPage() {
  const { call } = useAuth();
  const [targetDate, setTargetDate] = useState(todayStr());
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const run = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    setResults(null);
    try {
      const data = await call('/learning/evaluate', { method: 'POST', body: { targetDate } });
      setResults(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1>Intervention Outcome &amp; Learning</h1>
      <p className="muted">
        Closes the loop: compares what actually happened on a date against approved/rejected Prevention
        recommendations, scoring whether the AI's advice was effective. This is what lets the platform improve over
        time.
      </p>

      <div className="card">
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={run} className="form-row" style={{ alignItems: 'end' }}>
          <div className="field">
            <label>Date to Evaluate</label>
            <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="btn btn-primary" disabled={loading}>{loading ? 'Evaluating…' : 'Evaluate Interventions'}</button>
          </div>
        </form>

        {results && (
          results.length === 0 ? (
            <p className="muted" style={{ marginTop: 14 }}>
              No approved/rejected prevention recommendations with a matching daily log were found for this date.
              Use the Prevention tab to evaluate and decide on a recommendation for this date first.
            </p>
          ) : (
            <table style={{ marginTop: 14 }}>
              <thead><tr><th>Recommendation</th><th>Manager Action</th><th>Effectiveness Score</th></tr></thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.recommendationId}>
                    <td>#{r.recommendationId}</td>
                    <td><span className={`badge ${r.managerAction === 'approved' ? 'badge-success' : 'badge-danger'}`}>{r.managerAction}</span></td>
                    <td>{r.effectivenessScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  );
}
