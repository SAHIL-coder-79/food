import { useState } from 'react';
import './App.css';
import { AuthProvider, useAuth } from './context/AuthContext';
import { NotificationProvider } from './notifications/NotificationContext';
import AuthPage from './pages/AuthPage';
import Layout from './components/Layout';
import DashboardPage from './pages/DashboardPage';
import MenuItemsPage from './pages/MenuItemsPage';
import DailyLogsPage from './pages/DailyLogsPage';
import ForecastPage from './pages/ForecastPage';
import ForecastAccuracyPage from './pages/ForecastAccuracyPage';
import EventsPage from './pages/EventsPage';
import RootCausePage from './pages/RootCausePage';
import WasteAttributionPage from './pages/WasteAttributionPage';
import PreventionPage from './pages/PreventionPage';
import SurplusPage from './pages/SurplusPage';
import RescuePriorityPage from './pages/RescuePriorityPage';
import FinancialImpactPage from './pages/FinancialImpactPage';
import SimulatorPage from './pages/SimulatorPage';
import ProcessingPage from './pages/ProcessingPage';
import LearningPage from './pages/LearningPage';
import ProfilePage from './pages/ProfilePage';
import AdminPage from './pages/AdminPage';
import MessagingAssistantDevPage from './pages/MessagingAssistantDevPage';

const KITCHEN_TABS = [
  { key: 'dashboard', label: 'Dashboard', component: DashboardPage },
  { key: 'menu-items', label: 'Menu Items', component: MenuItemsPage },
  { key: 'daily-logs', label: 'Daily Logs', component: DailyLogsPage },
  { key: 'forecast', label: 'Forecast', component: ForecastPage },
  { key: 'forecast-accuracy', label: 'Forecast Accuracy', component: ForecastAccuracyPage },
  { key: 'events', label: 'Events', component: EventsPage },
  { key: 'root-cause', label: 'Root Cause', component: RootCausePage },
  { key: 'waste-attribution', label: 'Waste Attribution', component: WasteAttributionPage },
  { key: 'prevention', label: 'Prevention', component: PreventionPage },
  { key: 'processing', label: 'Processing', component: ProcessingPage },
  { key: 'surplus', label: 'Surplus', component: SurplusPage },
  { key: 'financial', label: 'Financial Impact', component: FinancialImpactPage },
  { key: 'simulator', label: 'Simulator', component: SimulatorPage },
  { key: 'learning', label: 'Learning', component: LearningPage },
  { key: 'messaging-dev', label: 'WhatsApp Assistant (Dev)', component: MessagingAssistantDevPage },
  { key: 'profile', label: 'Profile', component: ProfilePage },
];

const NGO_TABS = [
  { key: 'dashboard', label: 'Dashboard', component: DashboardPage },
  { key: 'surplus', label: 'Surplus Feed', component: SurplusPage },
  { key: 'rescue-priority', label: 'Rescue Priority', component: RescuePriorityPage },
  { key: 'profile', label: 'Profile', component: ProfilePage },
];

const ADMIN_TABS = [
  { key: 'dashboard', label: 'Dashboard', component: DashboardPage },
  { key: 'admin', label: 'NGO Verification', component: AdminPage },
  { key: 'rescue-priority', label: 'Rescue Priority (Global)', component: RescuePriorityPage },
];

function tabsForRole(role) {
  if (role === 'NGO_COORDINATOR' || role === 'NGO_ADMIN') return NGO_TABS;
  if (role === 'SYSTEM_ADMIN') return ADMIN_TABS;
  return KITCHEN_TABS; // KITCHEN_STAFF, KITCHEN_MANAGER
}

function Dashboard() {
  const { user } = useAuth();
  const tabs = tabsForRole(user.role);
  const [activeTab, setActiveTab] = useState(tabs[0].key);
  const ActiveComponent = tabs.find((t) => t.key === activeTab)?.component || tabs[0].component;
  // A dashboard link may only open a tab this role actually has.
  const navigate = (key) => {
    if (tabs.some((t) => t.key === key)) {
      setActiveTab(key);
      window.scrollTo({ top: 0 });
    }
  };

  return (
    <NotificationProvider>
      <Layout tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab}>
        <ActiveComponent navigate={navigate} />
      </Layout>
    </NotificationProvider>
  );
}

function Shell() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return isAuthenticated ? <Dashboard /> : <AuthPage />;
}

function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

export default App;
