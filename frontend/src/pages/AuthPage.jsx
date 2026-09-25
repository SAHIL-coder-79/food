import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';

const emptyRegister = {
  organizationName: '',
  organizationType: 'kitchen',
  pincode: '',
  latitude: '',
  longitude: '',
  serviceRadiusKm: '',
  name: '',
  email: '',
  password: '',
};

export default function AuthPage() {
  const { login, registerOrganization } = useAuth();
  const [mode, setMode] = useState('login');
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [registerForm, setRegisterForm] = useState(emptyRegister);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const submitLogin = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(loginForm.email, loginForm.password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitRegister = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setBusy(true);
    try {
      const payload = {
        ...registerForm,
        latitude: registerForm.latitude === '' ? undefined : parseFloat(registerForm.latitude),
        longitude: registerForm.longitude === '' ? undefined : parseFloat(registerForm.longitude),
        serviceRadiusKm: registerForm.serviceRadiusKm === '' ? undefined : parseFloat(registerForm.serviceRadiusKm),
      };
      const data = await registerOrganization(payload);
      if (data.organization?.verification_status === 'pending') {
        setInfo('NGO registered. A System Admin must verify your organization before you can view or claim surplus listings.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div className="emblem" style={{ margin: '0 auto 10px' }}>
            <PlateIcon />
          </div>
          <h1 style={{ color: 'var(--gov-navy-dark)' }}>Smart Food Waste Management</h1>
          <p className="muted">AI-Powered Redistribution Platform &middot; SIH Prototype</p>
        </div>

        <div className="auth-toggle">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Sign In
          </button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            Register Organization
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {info && <div className="alert alert-success">{info}</div>}

        {mode === 'login' ? (
          <form onSubmit={submitLogin}>
            <div className="field">
              <label>Email</label>
              <input
                type="email"
                required
                value={loginForm.email}
                onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                type="password"
                required
                value={loginForm.password}
                onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
              />
            </div>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
              {busy ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitRegister}>
            <div className="field">
              <label>Organization Type</label>
              <select
                value={registerForm.organizationType}
                onChange={(e) => setRegisterForm({ ...registerForm, organizationType: e.target.value })}
              >
                <option value="kitchen">Institutional Kitchen / Food Processing Unit</option>
                <option value="ngo">NGO / Food Bank / Shelter</option>
              </select>
            </div>
            <div className="field">
              <label>Organization Name</label>
              <input
                required
                value={registerForm.organizationName}
                onChange={(e) => setRegisterForm({ ...registerForm, organizationName: e.target.value })}
              />
            </div>
            <div className="form-row">
              <div className="field">
                <label>Pincode</label>
                <input
                  value={registerForm.pincode}
                  onChange={(e) => setRegisterForm({ ...registerForm, pincode: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Service Radius (km)</label>
                <input
                  type="number"
                  value={registerForm.serviceRadiusKm}
                  onChange={(e) => setRegisterForm({ ...registerForm, serviceRadiusKm: e.target.value })}
                />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Latitude</label>
                <input
                  type="number"
                  step="any"
                  value={registerForm.latitude}
                  onChange={(e) => setRegisterForm({ ...registerForm, latitude: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Longitude</label>
                <input
                  type="number"
                  step="any"
                  value={registerForm.longitude}
                  onChange={(e) => setRegisterForm({ ...registerForm, longitude: e.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label>Your Name (Admin/Manager)</label>
              <input
                required
                value={registerForm.name}
                onChange={(e) => setRegisterForm({ ...registerForm, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Email</label>
              <input
                type="email"
                required
                value={registerForm.email}
                onChange={(e) => setRegisterForm({ ...registerForm, email: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Password (min. 8 characters)</label>
              <input
                type="password"
                required
                minLength={8}
                value={registerForm.password}
                onChange={(e) => setRegisterForm({ ...registerForm, password: e.target.value })}
              />
            </div>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
              {busy ? 'Registering…' : 'Register & Continue'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export function PlateIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="#0b3d66" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="5.5" stroke="#c99a2e" strokeWidth="1.6" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="#0b3d66" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
