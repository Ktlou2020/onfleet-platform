import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import InstallPrompt from './components/InstallPrompt';
import AnalyticsTracker from './analytics';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import FleetOwnerPilot from './pages/FleetOwnerPilot';
import FleetOwnerWorkspace from './pages/FleetOwnerWorkspace';
import FleetLogin from './pages/FleetLogin';
import FleetSignup from './pages/FleetSignup';
import FleetOwnerShell from './pages/fleet/FleetOwnerShell';
import FleetDashboard from './pages/fleet/Dashboard';
import FleetOwnerBikes from './pages/fleet/Bikes';
import FleetOwnerAgreements from './pages/fleet/Agreements';
import FleetOwnerPayments from './pages/fleet/Payments';
import FleetOwnerRiders from './pages/fleet/Riders';
import FleetOwnerHelp from './pages/fleet/Help';
import RiderShell from './pages/rider/RiderShell';
import RiderDashboard from './pages/rider/Dashboard';
import RiderAgreements from './pages/rider/Agreements';
import RiderAgreementDetail from './pages/rider/AgreementDetail';
import RiderApplication from './pages/rider/Application';
import RiderProfile from './pages/rider/Profile';
import RiderPayments from './pages/rider/Payments';
import RiderNotifications from './pages/rider/Notifications';
import PaymentCallback from './pages/rider/PaymentCallback';

import AdminShell from './pages/admin/AdminShell';
import AdminDashboard from './pages/admin/Dashboard';
import AdminApplications from './pages/admin/Applications';
import AdminApplicationDetail from './pages/admin/ApplicationDetail';
import AdminAgreements from './pages/admin/Agreements';
import AdminAgreementDetail from './pages/admin/AgreementDetail';
import AdminBikes from './pages/admin/Bikes';
import AdminBikeDetail from './pages/admin/BikeDetail';
import AdminPayments from './pages/admin/Payments';
import AdminNotifications from './pages/admin/Notifications';
import AdminUsers from './pages/admin/Users';
import AdminAuditLogs from './pages/admin/AuditLogs';
import AdminStrategyReport from './pages/admin/StrategyReport';
import AdminImports from './pages/admin/Imports';
import AdminFleetDashboard from './pages/admin/FleetDashboard';
import AdminFleetOwners from './pages/admin/FleetOwners';
import FleetRiderApply from './pages/FleetRiderApply';
import { canViewFleetSection, getDefaultFleetRoute, isAdminPortalRole } from './pages/fleet/access';

function PrivateRoute({ children, role }) {
  const { user } = useAuth();
  if (!user) return <Navigate to={role === 'fleet_owner' ? '/fleet/login' : '/login'} replace />;
  if (role === 'rider' && user.role !== 'rider') return <Navigate to={String(user.role || '').startsWith('fleet_owner_') ? '/fleet/app' : '/admin'} replace />;
  if (role === 'admin' && !['admin', 'superadmin'].includes(user.role)) return <Navigate to={String(user.role || '').startsWith('fleet_owner_') ? '/fleet/app' : '/dashboard'} replace />;
  if (role === 'fleet_owner' && !String(user.role || '').startsWith('fleet_owner_')) return <Navigate to={['admin', 'superadmin'].includes(user.role) ? '/admin' : '/dashboard'} replace />;
  return children;
}

function FleetRouteGate({ section, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/fleet/login" replace />;
  if (!canViewFleetSection(user.role, section)) {
    return <Navigate to={getDefaultFleetRoute(user.role)} replace />;
  }
  return children;
}

function HomeRoute() {
  const { user } = useAuth();
  if (!user) return <Landing />;
  if (isAdminPortalRole(user.role)) return <Navigate to="/admin" replace />;
  if (String(user.role || '').startsWith('fleet_owner_')) return <Navigate to={getDefaultFleetRoute(user.role)} replace />;
  return <Navigate to="/dashboard" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <AnalyticsTracker />
      <Routes>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/fleet" element={<FleetOwnerPilot />} />
        <Route path="/fleet/login" element={<FleetLogin />} />
        <Route path="/fleet/signup" element={<FleetSignup />} />
        <Route path="/fleet/workspace" element={<FleetOwnerWorkspace />} />
        <Route path="/fleet/rider-apply/:slug" element={<FleetRiderApply />} />
        <Route path="/fleet/app" element={<PrivateRoute role="fleet_owner"><FleetOwnerShell /></PrivateRoute>}>
          <Route index element={<FleetRouteGate section="dashboard"><FleetDashboard /></FleetRouteGate>} />
          <Route path="bikes" element={<FleetRouteGate section="bikes"><FleetOwnerBikes /></FleetRouteGate>} />
          <Route path="agreements" element={<FleetRouteGate section="agreements"><FleetOwnerAgreements /></FleetRouteGate>} />
          <Route path="payments" element={<FleetRouteGate section="payments"><FleetOwnerPayments /></FleetRouteGate>} />
          <Route path="riders" element={<FleetRouteGate section="riders"><FleetOwnerRiders /></FleetRouteGate>} />
          <Route path="help" element={<FleetRouteGate section="help"><FleetOwnerHelp /></FleetRouteGate>} />
        </Route>

        <Route path="/" element={<PrivateRoute role="rider"><RiderShell /></PrivateRoute>}>
          <Route path="dashboard" element={<RiderDashboard />} />
          <Route path="agreements" element={<RiderAgreements />} />
          <Route path="agreements/:id" element={<RiderAgreementDetail />} />
          <Route path="application" element={<RiderApplication />} />
          <Route path="kyc" element={<Navigate to="/application" replace />} />
          <Route path="payments" element={<RiderPayments />} />
          <Route path="notifications" element={<RiderNotifications />} />
          <Route path="profile" element={<RiderProfile />} />
          <Route path="payments/callback" element={<PaymentCallback />} />
        </Route>

        <Route path="/admin" element={<PrivateRoute role="admin"><AdminShell /></PrivateRoute>}>
          <Route index element={<AdminDashboard />} />
          <Route path="applications" element={<AdminApplications />} />
          <Route path="applications/:id" element={<AdminApplicationDetail />} />
          <Route path="agreements" element={<AdminAgreements />} />
          <Route path="agreements/:id" element={<AdminAgreementDetail />} />
          <Route path="bikes" element={<AdminBikes />} />
          <Route path="bikes/:id" element={<AdminBikeDetail />} />
          <Route path="payments" element={<AdminPayments />} />
          <Route path="notifications" element={<AdminNotifications />} />
          <Route path="imports" element={<AdminImports />} />
          <Route path="strategy" element={<AdminStrategyReport />} />
          <Route path="fleet-dashboard" element={<AdminFleetDashboard />} />
          <Route path="fleet-owners" element={<AdminFleetOwners />} />
          <Route path="pilot" element={<Navigate to="/admin/fleet-dashboard" replace />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="kyc" element={<Navigate to="/admin/applications" replace />} />
          <Route path="audit" element={<AdminAuditLogs />} />
        </Route>
      </Routes>
      <InstallPrompt />
    </AuthProvider>
  );
}
