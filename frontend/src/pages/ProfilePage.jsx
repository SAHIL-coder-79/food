import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

// A small, reusable "WhatsApp Notifications" panel - available to both kitchen and NGO users (kitchens use it
// to report surplus over chat; NGOs use it to receive rescue notifications over WhatsApp instead of only
// email). Only shows provider/enabled status and linked numbers - never a secret, token or credential.
function WhatsAppLinkingCard({ call }) {
  const [status, setStatus] = useState(null);
  const [identities, setIdentities] = useState([]);
  const [linkRequest, setLinkRequest] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [statusRes, identitiesRes] = await Promise.all([call('/messaging/status'), call('/messaging/identities/me')]);
      setStatus(statusRes.data);
      setIdentities(identitiesRes.data);
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

  const generateCode = async () => {
    setError('');
    setLinkRequest(null);
    try {
      const data = await call('/messaging/link-requests', { method: 'POST', body: { provider: status?.provider || 'mock', channel: 'whatsapp' } });
      setLinkRequest(data.data);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="card">
      <div className="card-header"><h2>WhatsApp Notifications</h2></div>
      {error && <div className="alert alert-error">{error}</div>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="muted">
            Provider: {status?.provider === 'meta' ? 'Meta WhatsApp Cloud API' : 'Demo / Mock'}
            {' — '}
            {status?.enabled ? 'enabled' : 'disabled'}
          </p>
          {identities.length === 0 ? (
            <p className="muted">No WhatsApp number linked yet.</p>
          ) : (
            <ul>
              {identities.map((id) => (
                <li key={id.id}>{id.externalUserId} ({id.provider}) {id.active ? '— active' : '— inactive'}</li>
              ))}
            </ul>
          )}
          <button type="button" className="btn btn-outline btn-sm" onClick={generateCode}>Generate Linking Code</button>
          {linkRequest && (
            <div className="alert alert-success" style={{ marginTop: 10 }}>
              <p><strong>Code: {linkRequest.code}</strong> (expires {new Date(linkRequest.expiresAt).toLocaleTimeString()})</p>
              <p className="muted" style={{ fontSize: 12.5 }}>{linkRequest.instructions}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function ProfilePage() {
  const { call, organization, refreshOrganization, user } = useAuth();
  const isNgo = organization?.type === 'ngo';
  const [form, setForm] = useState({
    name: '', pincode: '', latitude: '', longitude: '', service_radius_km: '', capacity_kg: '', preferred_food_types: '',
  });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (organization) {
      setForm({
        name: organization.name || '',
        pincode: organization.pincode || '',
        latitude: organization.latitude ?? '',
        longitude: organization.longitude ?? '',
        service_radius_km: organization.service_radius_km ?? '',
        capacity_kg: organization.capacity_kg ?? '',
        preferred_food_types: (organization.preferred_food_types || []).join(', '),
      });
    }
  }, [organization]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    try {
      const body = {
        name: form.name,
        pincode: form.pincode,
        latitude: form.latitude === '' ? null : parseFloat(form.latitude),
        longitude: form.longitude === '' ? null : parseFloat(form.longitude),
        service_radius_km: form.service_radius_km === '' ? null : parseFloat(form.service_radius_km),
      };
      if (isNgo) {
        body.capacity_kg = form.capacity_kg === '' ? null : parseFloat(form.capacity_kg);
        body.preferred_food_types = form.preferred_food_types
          ? form.preferred_food_types.split(',').map((s) => s.trim()).filter(Boolean)
          : [];
      }
      await call('/organizations/me', { method: 'PATCH', body });
      await refreshOrganization();
      setMessage('Organization profile updated.');
    } catch (err) {
      setError(err.message);
    }
  };

  if (!organization) return <p className="muted">Loading…</p>;

  return (
    <div>
      <h1>Organization Profile</h1>
      <p className="muted">
        Set your location and service radius so Smart NGO Matching and the surplus feed can find you. NGOs should
        also set capacity and preferred food categories.
      </p>

      <div className="card">
        <div className="card-header">
          <h2>{organization.name}</h2>
          <span className={`badge ${organization.verification_status === 'verified' ? 'badge-success' : organization.verification_status === 'pending' ? 'badge-warning' : 'badge-danger'}`}>
            {organization.verification_status}
          </span>
        </div>
        {isNgo && organization.verification_status === 'pending' && (
          <div className="alert" style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>
            Your organization is awaiting verification by a System Admin before you can view or claim surplus listings.
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}

        {(user?.role === 'KITCHEN_MANAGER' || user?.role === 'NGO_ADMIN') ? (
          <form onSubmit={submit}>
            <div className="form-row">
              <div className="field"><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div className="field"><label>Pincode</label><input value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value })} /></div>
            </div>
            <div className="form-row">
              <div className="field"><label>Latitude</label><input type="number" step="any" value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} /></div>
              <div className="field"><label>Longitude</label><input type="number" step="any" value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} /></div>
              <div className="field"><label>Service Radius (km)</label><input type="number" min="0" value={form.service_radius_km} onChange={(e) => setForm({ ...form, service_radius_km: e.target.value })} /></div>
            </div>
            {isNgo && (
              <div className="form-row">
                <div className="field"><label>Capacity (kg)</label><input type="number" min="0" value={form.capacity_kg} onChange={(e) => setForm({ ...form, capacity_kg: e.target.value })} /></div>
                <div className="field"><label>Preferred Food Types (comma separated)</label><input value={form.preferred_food_types} onChange={(e) => setForm({ ...form, preferred_food_types: e.target.value })} placeholder="Rice, Curry, Bakery" /></div>
              </div>
            )}
            <button className="btn btn-primary">Save Profile</button>
          </form>
        ) : (
          <p className="muted">Only the organization's manager/admin can edit this profile.</p>
        )}
      </div>

      <WhatsAppLinkingCard call={call} />
    </div>
  );
}
