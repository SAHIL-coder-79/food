import React, { useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import KitchenDashboard from '../dashboard/KitchenDashboard';
import NgoDashboard from '../dashboard/NgoDashboard';
import AdminDashboard from '../dashboard/AdminDashboard';

// Landing page after login. The role decides which dashboard is shown; every dashboard reads real data from the
// same APIs the other tabs use, and `navigate` jumps to a tab that exists for the signed-in role.
export default function DashboardPage({ navigate }) {
  const { user, organization } = useAuth();
  const [refreshCount, setRefreshCount] = useState(0);
  const today = useMemo(
    () => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    []
  );

  let View = KitchenDashboard;
  if (user.role === 'NGO_COORDINATOR' || user.role === 'NGO_ADMIN') View = NgoDashboard;
  else if (user.role === 'SYSTEM_ADMIN') View = AdminDashboard;

  return (
    <div>
      <div className="dash-hero">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">
            {organization ? `${organization.name} · ` : ''}{today}
          </p>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setRefreshCount((n) => n + 1)}>
          Refresh data
        </button>
      </div>
      {/* Remounting reloads every card, each with its own loading state. */}
      <View key={refreshCount} navigate={navigate} />
    </div>
  );
}
