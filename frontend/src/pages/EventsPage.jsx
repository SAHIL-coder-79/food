import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

const EVENT_TYPES = [
  { value: 'holiday', label: 'Holiday' },
  { value: 'festival', label: 'Festival' },
  { value: 'exam', label: 'Exam' },
  { value: 'institutional_event', label: 'Institutional event' },
  { value: 'special_meal', label: 'Special meal' },
  { value: 'closure', label: 'Closure' },
];
const TYPE_LABEL = Object.fromEntries(EVENT_TYPES.map((t) => [t.value, t.label]));

const emptyForm = { eventDate: '', eventType: 'festival', name: '', description: '', expectedImpactPct: '' };

function impactBadge(pct) {
  if (pct === null || pct === undefined) return <span className="muted">not specified</span>;
  if (pct === 0) return <span className="badge badge-neutral">no effect</span>;
  return <span className={`badge ${pct > 0 ? 'badge-warning' : 'badge-info'}`}>{pct > 0 ? '+' : ''}{pct}%</span>;
}

export default function EventsPage() {
  const { call, user } = useAuth();
  const canEdit = user?.role === 'KITCHEN_MANAGER';
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await call('/events');
      setEvents(data.events);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    try {
      const body = { eventDate: form.eventDate, eventType: form.eventType, name: form.name };
      if (form.description.trim()) body.description = form.description.trim();
      if (form.expectedImpactPct !== '') body.expectedImpactPct = parseFloat(form.expectedImpactPct);
      await call('/events', { method: 'POST', body });
      setForm(emptyForm);
      setMessage('Event added. Forecasts for that date will now take it into account.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (id) => {
    setError('');
    setMessage('');
    try {
      await call(`/events/${id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <h1>Calendar Events</h1>
      <p className="muted">
        Holidays, festivals, exams, closures and special meals for your organization. They are optional context for demand
        forecasts: the model learns from similar past event days you have recorded, and uses an expected impact only as a
        starting point when it has no history for that kind of event. Past event days are also kept out of the baseline so
        they don't distort ordinary days. Only events entered before a date are used to forecast it.
      </p>

      {canEdit && (
        <div className="card">
          <div className="card-header"><h2>Add Event</h2></div>
          {error && <div className="alert alert-error">{error}</div>}
          {message && <div className="alert alert-success">{message}</div>}
          <form onSubmit={submit}>
            <div className="form-row">
              <div className="field">
                <label>Date</label>
                <input type="date" required value={form.eventDate} onChange={(e) => setForm({ ...form, eventDate: e.target.value })} />
              </div>
              <div className="field">
                <label>Type</label>
                <select value={form.eventType} onChange={(e) => setForm({ ...form, eventType: e.target.value })}>
                  {EVENT_TYPES.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
                </select>
              </div>
              <div className="field">
                <label>Name</label>
                <input required maxLength={255} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Annual Day" />
              </div>
              <div className="field">
                <label>Expected demand change % (optional)</label>
                <input
                  type="number"
                  min="-100"
                  max="500"
                  step="any"
                  value={form.expectedImpactPct}
                  onChange={(e) => setForm({ ...form, expectedImpactPct: e.target.value })}
                  placeholder="+30, -50, -100 for closed"
                />
              </div>
            </div>
            <div className="field">
              <label>Description (optional)</label>
              <input maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <button className="btn btn-primary">Add Event</button>
          </form>
        </div>
      )}
      {!canEdit && error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        <div className="card-header"><h2>Events ({events.length})</h2></div>
        {!canEdit && <p className="muted">Only a kitchen manager can add or remove events.</p>}
        {loading ? (
          <p className="muted">Loading…</p>
        ) : events.length === 0 ? (
          <p className="muted">No events recorded. Forecasts work normally without them.</p>
        ) : (
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Name</th><th>Expected change</th><th>Notes</th>{canEdit && <th></th>}</tr></thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{event.eventDate}</td>
                  <td>{TYPE_LABEL[event.eventType] || event.eventType}</td>
                  <td>{event.name}</td>
                  <td>{impactBadge(event.expectedImpactPct)}</td>
                  <td className="muted">{event.description || '—'}</td>
                  {canEdit && <td><button className="btn btn-outline btn-sm" onClick={() => remove(event.id)}>Remove</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
