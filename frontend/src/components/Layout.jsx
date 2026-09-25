import React from 'react';
import { useAuth } from '../context/AuthContext';
import { PlateIcon } from '../pages/AuthPage';
import NotificationBell from './NotificationBell';

const ROLE_LABELS = {
  KITCHEN_STAFF: 'Kitchen Staff',
  KITCHEN_MANAGER: 'Kitchen Manager',
  NGO_COORDINATOR: 'NGO Coordinator',
  NGO_ADMIN: 'NGO Admin',
  SYSTEM_ADMIN: 'System Admin',
};

export default function Layout({ tabs, activeTab, onTabChange, children }) {
  const { user, organization, logout } = useAuth();

  return (
    <div className="app-shell">
      <div className="top-strip">
        <span>Smart Food Waste Management &amp; Redistribution Platform</span>
        <span className="tag">SIH Prototype — Not an official Government of India service</span>
      </div>

      <header className="main-header">
        <div className="emblem">
          <PlateIcon />
        </div>
        <div className="brand-text">
          <h1>Smart Food Waste Management Portal</h1>
          <p>Predict &middot; Explain &middot; Prevent &middot; Rescue &middot; Redistribute &middot; Measure &middot; Learn</p>
        </div>
        <div className="header-spacer" />
        <NotificationBell />
        <div className="user-box">
          <strong>{user?.name}</strong>
          <div>{ROLE_LABELS[user?.role] || user?.role}</div>
          <div>{organization?.name}</div>
        </div>
        <button className="btn btn-outline btn-sm" style={{ background: 'transparent', color: '#fff', borderColor: '#fff' }} onClick={logout}>
          Logout
        </button>
      </header>

      <nav className="nav-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={activeTab === tab.key ? 'active' : ''}
            onClick={() => onTabChange(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main className="app-body">{children}</main>

      <footer className="app-footer">
        Smart Food Waste Management &amp; Redistribution Platform — AI-powered prototype built for the Smart India Hackathon.
      </footer>
    </div>
  );
}
