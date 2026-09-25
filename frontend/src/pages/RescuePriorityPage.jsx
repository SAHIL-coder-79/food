import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

const LEVEL_BADGE = { CRITICAL: 'badge-danger', HIGH: 'badge-warning', MEDIUM: 'badge-warning', LOW: 'badge-success' };

export default function RescuePriorityPage() {
  const { call } = useAuth();
  const [listings, setListings] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    call('/rescue-priorities')
      .then((data) => setListings(data.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h1>Rescue Priority Ranking</h1>
      <p className="muted">
        Currently-available surplus listings, ranked by urgency (time left before it's unsafe) and impact
        (meal-equivalents rescued). Verified NGOs see the listings inside their own service area; system admins see all
        of them. Use this as the triage view for where to send pickups first.
      </p>

      <div className="card">
        {error && <div className="alert alert-error">{error}</div>}
        {loading ? (
          <p className="muted">Loading…</p>
        ) : listings.length === 0 ? (
          <p className="muted">No active surplus listings right now.</p>
        ) : (
          <table>
            <thead><tr><th>Food</th><th>Qty</th><th>Priority</th><th>Urgency</th><th>Impact</th><th>Why</th></tr></thead>
            <tbody>
              {listings.map((l) => (
                <tr key={l.id}>
                  <td>{l.food_type || 'Food item'}</td>
                  <td>{l.quantity} kg</td>
                  <td><span className={`badge ${LEVEL_BADGE[l.priorityLevel] || 'badge-neutral'}`}>{l.priorityLevel} ({l.priorityScore})</span></td>
                  <td>{l.urgencyScore}</td>
                  <td>{l.impactScore}</td>
                  <td className="muted">{l.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
