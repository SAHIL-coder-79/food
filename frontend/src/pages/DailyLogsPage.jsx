import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

const emptyForm = {
  menuItemId: '',
  logDate: todayStr(),
  mealSlot: 'LUNCH',
  quantityPlanned: '',
  quantityPrepared: '',
  headcount: '',
  quantityConsumed: '',
  quantityLeftover: '',
};

export default function DailyLogsPage() {
  const { call } = useAuth();
  const [menuItems, setMenuItems] = useState([]);
  const [logs, setLogs] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [itemsData, logsData] = await Promise.all([call('/menu-items'), call('/daily-logs')]);
      setMenuItems(itemsData.menuItems);
      setLogs(logsData.logs);
      if (!form.menuItemId && itemsData.menuItems[0]) {
        setForm((f) => ({ ...f, menuItemId: String(itemsData.menuItems[0].id) }));
      }
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

  const num = (v) => (v === '' ? undefined : parseFloat(v));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    try {
      await call('/daily-logs', {
        method: 'POST',
        body: {
          menuItemId: parseInt(form.menuItemId, 10),
          logDate: form.logDate,
          mealSlot: form.mealSlot,
          quantityPlanned: num(form.quantityPlanned),
          quantityPrepared: num(form.quantityPrepared),
          headcount: form.headcount === '' ? undefined : parseInt(form.headcount, 10),
          quantityConsumed: num(form.quantityConsumed),
          quantityLeftover: num(form.quantityLeftover),
        },
      });
      setMessage('Daily log recorded. Check the Forecast and Root Cause tabs to see the AI react to it.');
      setForm({ ...emptyForm, menuItemId: form.menuItemId });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) return <p className="muted">Loading…</p>;

  if (menuItems.length === 0) {
    return (
      <div>
        <h1>Food Preparation — Daily Logs</h1>
        <div className="alert alert-error">Add at least one menu item first (see the "Menu Items" tab).</div>
      </div>
    );
  }

  return (
    <div>
      <h1>Food Preparation — Daily Logs</h1>
      <p className="muted">
        Record what was planned, prepared, consumed and left over for each meal slot. This is the raw data every AI
        phase downstream (forecast, root cause, prevention, financial impact) learns from.
      </p>

      <div className="card">
        <div className="card-header"><h2>Log Today's Preparation</h2></div>
        {error && <div className="alert alert-error">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}
        <form onSubmit={submit}>
          <div className="form-row">
            <div className="field">
              <label>Menu Item</label>
              <select value={form.menuItemId} onChange={(e) => setForm({ ...form, menuItemId: e.target.value })}>
                {menuItems.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Date</label>
              <input type="date" value={form.logDate} onChange={(e) => setForm({ ...form, logDate: e.target.value })} />
            </div>
            <div className="field">
              <label>Meal Slot</label>
              <select value={form.mealSlot} onChange={(e) => setForm({ ...form, mealSlot: e.target.value })}>
                <option value="BREAKFAST">Breakfast</option>
                <option value="LUNCH">Lunch</option>
                <option value="SNACKS">Snacks</option>
                <option value="DINNER">Dinner</option>
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Planned Qty</label>
              <input type="number" min="0" value={form.quantityPlanned} onChange={(e) => setForm({ ...form, quantityPlanned: e.target.value })} />
            </div>
            <div className="field">
              <label>Prepared Qty</label>
              <input type="number" min="0" value={form.quantityPrepared} onChange={(e) => setForm({ ...form, quantityPrepared: e.target.value })} />
            </div>
            <div className="field">
              <label>Headcount</label>
              <input type="number" min="0" value={form.headcount} onChange={(e) => setForm({ ...form, headcount: e.target.value })} />
            </div>
            <div className="field">
              <label>Consumed Qty</label>
              <input type="number" min="0" value={form.quantityConsumed} onChange={(e) => setForm({ ...form, quantityConsumed: e.target.value })} />
            </div>
            <div className="field">
              <label>Leftover Qty (waste)</label>
              <input type="number" min="0" value={form.quantityLeftover} onChange={(e) => setForm({ ...form, quantityLeftover: e.target.value })} />
            </div>
          </div>
          <button className="btn btn-primary">Save Log</button>
        </form>
      </div>

      <div className="card">
        <div className="card-header"><h2>Recent Logs ({logs.length})</h2></div>
        {logs.length === 0 ? (
          <p className="muted">No logs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Item</th><th>Slot</th><th>Planned</th><th>Prepared</th><th>Consumed</th><th>Leftover</th><th>Log ID</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>{String(log.log_date).slice(0, 10)}</td>
                  <td>{log.menu_item_name}</td>
                  <td>{log.meal_slot}</td>
                  <td>{log.quantity_planned ?? '—'}</td>
                  <td>{log.quantity_prepared ?? '—'}</td>
                  <td>{log.quantity_consumed ?? '—'}</td>
                  <td>{Number(log.quantity_leftover || 0) > 0 ? <span className="badge badge-danger">{log.quantity_leftover}</span> : log.quantity_leftover ?? '—'}</td>
                  <td className="muted">#{log.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
