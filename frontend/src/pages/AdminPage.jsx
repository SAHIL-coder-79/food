import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatDate } from '../format';

export default function AdminPage() {
  const { call } = useAuth();
  const [pending, setPending] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await call('/organizations/pending-ngos');
      setPending(data.organizations);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (id, verificationStatus) => {
    setError('');
    setMessage('');
    try {
      await call(`/organizations/${id}/verify`, { method: 'PATCH', body: { verificationStatus } });
      setMessage(`Organization #${id} ${verificationStatus}.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <h1>NGO Verification Queue</h1>
      <p className="muted">NGOs cannot view the surplus feed or claim listings until a System Admin verifies them.</p>

      <div className="card">
        {error && <div className="alert alert-error">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}
        {loading ? (
          <p className="muted">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="muted">No NGOs awaiting verification.</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Pincode</th><th>Registered</th><th>Actions</th></tr></thead>
            <tbody>
              {pending.map((org) => (
                <tr key={org.id}>
                  <td>{org.name}</td>
                  <td>{org.pincode || '—'}</td>
                  <td>{formatDate(org.created_at)}</td>
                  <td style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-success btn-sm" onClick={() => decide(org.id, 'verified')}>Verify</button>
                    <button className="btn btn-danger btn-sm" onClick={() => decide(org.id, 'rejected')}>Reject</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
