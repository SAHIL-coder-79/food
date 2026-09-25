import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatNumber } from '../format';

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

export default function ProcessingPage() {
  const { call } = useAuth();
  const [products, setProducts] = useState([]);
  const [batches, setBatches] = useState([]);
  const [productForm, setProductForm] = useState({ name: '', unit: 'kg', item_type: 'raw_material', cost_per_unit: '' });
  const [batchForm, setBatchForm] = useState({ product_id: '', log_date: todayStr(), batch_number: '', input_quantity: '', output_quantity: '', rejects_quantity: '' });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [p, b] = await Promise.all([call('/processing/products'), call('/processing/batches')]);
      setProducts(p.data);
      setBatches(b.data);
      if (!batchForm.product_id && p.data[0]) setBatchForm((f) => ({ ...f, product_id: String(p.data[0].id) }));
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

  const addProduct = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    try {
      const created = await call('/processing/products', {
        method: 'POST',
        body: { ...productForm, cost_per_unit: productForm.cost_per_unit === '' ? 0 : parseFloat(productForm.cost_per_unit) },
      });
      setMessage(`"${created.data.name}" added. You can now log a production batch for it.`);
      setProductForm({ name: '', unit: 'kg', item_type: 'raw_material', cost_per_unit: '' });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const logBatch = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    try {
      await call('/processing/batches', {
        method: 'POST',
        body: {
          product_id: parseInt(batchForm.product_id, 10),
          log_date: batchForm.log_date,
          batch_number: batchForm.batch_number,
          input_quantity: parseFloat(batchForm.input_quantity),
          output_quantity: parseFloat(batchForm.output_quantity || 0),
          rejects_quantity: parseFloat(batchForm.rejects_quantity || 0),
        },
      });
      setMessage('Batch logged. Rejects are tracked as waste for Financial Impact.');
      setBatchForm({ ...batchForm, batch_number: '', input_quantity: '', output_quantity: '', rejects_quantity: '' });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <h1>Processing Unit Operations</h1>
      <p className="muted">Track raw materials/products and log production batches — input, yield and rejects.</p>
      {error && <div className="alert alert-error">{error}</div>}
      {message && <div className="alert alert-success">{message}</div>}

      <div className="grid-2">
        <div className="card">
          <div className="card-header"><h2>Products / Raw Materials</h2></div>
          <form onSubmit={addProduct} className="form-row" style={{ alignItems: 'end' }}>
            <div className="field"><label>Name</label><input required value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} /></div>
            <div className="field"><label>Unit</label><input required value={productForm.unit} onChange={(e) => setProductForm({ ...productForm, unit: e.target.value })} /></div>
            <div className="field">
              <label>Type</label>
              <select value={productForm.item_type} onChange={(e) => setProductForm({ ...productForm, item_type: e.target.value })}>
                <option value="raw_material">Raw material</option>
                <option value="finished_product">Finished product</option>
              </select>
            </div>
            <div className="field"><label>Cost/Unit</label><input type="number" min="0" value={productForm.cost_per_unit} onChange={(e) => setProductForm({ ...productForm, cost_per_unit: e.target.value })} /></div>
            <div className="field" style={{ flex: '0 0 auto' }}><button className="btn btn-primary btn-sm">Add</button></div>
          </form>
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Unit</th></tr></thead>
            <tbody>
              {products.map((p) => (<tr key={p.id}><td>{p.name}</td><td>{p.item_type}</td><td>{p.unit}</td></tr>))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-header"><h2>Log Production Batch</h2></div>
          {loading ? (
            <p className="muted">Loading…</p>
          ) : products.length === 0 ? (
            <p className="muted">Add a product first.</p>
          ) : (
            <form onSubmit={logBatch}>
              <div className="field">
                <label>Product</label>
                <select value={batchForm.product_id} onChange={(e) => setBatchForm({ ...batchForm, product_id: e.target.value })}>
                  {products.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                </select>
              </div>
              <div className="form-row">
                <div className="field"><label>Date</label><input type="date" value={batchForm.log_date} onChange={(e) => setBatchForm({ ...batchForm, log_date: e.target.value })} /></div>
                <div className="field"><label>Batch #</label><input value={batchForm.batch_number} onChange={(e) => setBatchForm({ ...batchForm, batch_number: e.target.value })} /></div>
              </div>
              <div className="form-row">
                <div className="field"><label>Input Qty</label><input type="number" required min="0" value={batchForm.input_quantity} onChange={(e) => setBatchForm({ ...batchForm, input_quantity: e.target.value })} /></div>
                <div className="field"><label>Output Qty</label><input type="number" min="0" value={batchForm.output_quantity} onChange={(e) => setBatchForm({ ...batchForm, output_quantity: e.target.value })} /></div>
                <div className="field"><label>Rejects</label><input type="number" min="0" value={batchForm.rejects_quantity} onChange={(e) => setBatchForm({ ...batchForm, rejects_quantity: e.target.value })} /></div>
              </div>
              <button className="btn btn-primary">Log Batch</button>
            </form>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h2>Batches ({batches.length})</h2></div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : batches.length === 0 ? (
          <p className="muted">No batches logged yet.</p>
        ) : (
          <table>
            <thead><tr><th>Date</th><th>Product</th><th>Batch #</th><th>Input</th><th>Output</th><th>Rejects</th></tr></thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{String(b.log_date).slice(0, 10)}</td>
                  <td>{b.product_name}</td>
                  <td>{b.batch_number || '—'}</td>
                  <td>{formatNumber(b.quantity_prepared)}</td>
                  <td>{formatNumber(b.output_quantity)}</td>
                  <td>{Number(b.quantity_leftover || 0) > 0 ? <span className="badge badge-danger">{formatNumber(b.quantity_leftover)}</span> : formatNumber(b.quantity_leftover)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
