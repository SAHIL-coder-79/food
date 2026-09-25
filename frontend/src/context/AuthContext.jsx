import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch } from '../api';

const AuthContext = createContext(null);

const STORAGE_KEY = 'foodshare.token';

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_KEY) || null);
  const [user, setUser] = useState(null);
  const [organization, setOrganization] = useState(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState('');

  const refreshMe = useCallback(async (activeToken) => {
    try {
      const data = await apiFetch('/auth/me', { token: activeToken });
      setUser(data.user);
      setOrganization(data.organization);
    } catch {
      // Token invalid/expired - clear it.
      localStorage.removeItem(STORAGE_KEY);
      setToken(null);
      setUser(null);
      setOrganization(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) refreshMe(token);
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (email, password) => {
    setError('');
    const data = await apiFetch('/auth/login', { method: 'POST', body: { email, password } });
    localStorage.setItem(STORAGE_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
    setOrganization(data.organization);
    return data;
  }, []);

  const registerOrganization = useCallback(async (payload) => {
    setError('');
    const data = await apiFetch('/auth/register-organization', { method: 'POST', body: payload });
    localStorage.setItem(STORAGE_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
    setOrganization(data.organization);
    return data;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setUser(null);
    setOrganization(null);
  }, []);

  const refreshOrganization = useCallback(async () => {
    if (!token) return;
    const data = await apiFetch('/organizations/me', { token });
    setOrganization(data.organization);
  }, [token]);

  const call = useCallback(
    (path, options = {}) => apiFetch(path, { ...options, token }),
    [token]
  );

  const value = {
    token,
    user,
    organization,
    loading,
    error,
    login,
    registerOrganization,
    logout,
    refreshOrganization,
    call,
    isAuthenticated: Boolean(token && user),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
