import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatInrPrecise } from '../format';

const emptyForm = { name: '', unit: 'kg', costPerUnit: '', preparationCostPerUnit: '' };

export default function MenuItemsPage() {
  const { call } = useAuth();
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await call('/menu-items');
      setItems(data.menuItems);
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

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    try {
      const created = await call('/menu-items', {
        method: 'POST',
        body: {
          name: form.name,
          unit: form.unit,
          costPerUnit: form.costPerUnit === '' ? undefined : parseFloat(form.costPerUnit),
          preparationCostPerUnit: form.preparationCostPerUnit === '' ? undefined : parseFloat(form.preparationCostPerUnit),
        },
      });
      setForm(emptyForm);
      setMessage(`"${created.menuItem.name}" added. You can now log daily preparation for it.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <h1>Food Preparation — Menu Items</h1>
      <p className="muted">
        Define the dishes / raw materials your kitchen prepares, with per-unit cost so the platform can estimate
        financial loss when they're wasted.
      </p>

      <div className="card">
        <div className="card-header"><h2>Add Menu Item</h2></div>
        {error && <div className="alert alert-error">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}
        <form onSubmit={submit} className="form-row" style={{ alignItems: 'end' }}>
          <div className="field">
            <label>Name</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Unit</label>
            <input required value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="kg / plates / litres" />
          </div>
          <div className="field">
            <label>Cost per Unit (₹)</label>
            <input type="number" min="0" step="0.01" value={form.costPerUnit} onChange={(e) => setForm({ ...form, costPerUnit: e.target.value })} />
          </div>
          <div className="field">
            <label>Prep. Cost per Unit (₹)</label>
            <input type="number" min="0" step="0.01" value={form.preparationCostPerUnit} onChange={(e) => setForm({ ...form, preparationCostPerUnit: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="btn btn-primary">Add Item</button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="card-header"><h2>Menu Items ({items.length})</h2></div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No menu items yet — add one above to start logging daily preparation.</p>
        ) : (
          <table>
            <thead>
              <tr><th>ID</th><th>Name</th><th>Unit</th><th>Cost / Unit</th><th>Prep Cost / Unit</th></tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.id}</td>
                  <td>{item.name}</td>
                  <td>{item.unit}</td>
                  <td>{formatInrPrecise(item.cost_per_unit || 0)}</td>
                  <td>{formatInrPrecise(item.preparation_cost_per_unit || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
