import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import MobileOnboardingPrompt from './components/MobileOnboardingPrompt';
import OfflineBanner from './components/OfflineBanner';
import AnalyticsTracker from './analytics';
import { canViewFleetSection, getDefaultFleetRoute, isAdminPortalRole } from './pages/fleet/access';

const Landing = lazy(() => import('./pages/Landing'));
const Login = lazy(() => import('./pages/Login'));
const Signup = lazy(() => import('./pages/Signup'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const FleetOwnerPilot = lazy(() => import('./pages/FleetOwnerPilot'));
const FleetOwnerWorkspace = lazy(() => import('./pages/FleetOwnerWorkspace'));
const FleetLogin = lazy(() => import('./pages/FleetLogin'));
const FleetSignup = lazy(() => import('./pages/FleetSignup'));
const FleetOwnerShell = lazy(() => import('./pages/fleet/FleetOwnerShell'));
const FleetDashboard = lazy(() => import('./pages/fleet/Dashboard'));
const FleetOwnerBikes = lazy(() => import('./pages/fleet/Bikes'));
const FleetOwnerAgreements = lazy(() => import('./pages/fleet/Agreements'));
const FleetAgreementDetail = lazy(() => import('./pages/fleet/AgreementDetail'));
const FleetOwnerPayments = lazy(() => import('./pages/fleet/Payments'));
const FleetOwnerRiders = lazy(() => import('./pages/fleet/Riders'));
const FleetOwnerHelp = lazy(() => import('./pages/fleet/Help'));
const FleetBilling = lazy(() => import('./pages/fleet/Billing'));
const FleetWallet = lazy(() => import('./pages/fleet/Wallet'));
const FleetCollections = lazy(() => import('./pages/fleet/Collections'));
const FleetHubs = lazy(() => import('./pages/fleet/Hubs'));
const FleetApiKeys = lazy(() => import('./pages/fleet/ApiKeys'));
const FleetTracking = lazy(() => import('./pages/fleet/Tracking'));
const FleetReports = lazy(() => import('./pages/fleet/Reports'));
const FleetTeam = lazy(() => import('./pages/fleet/Team'));
const RiderPortal = lazy(() => import('./pages/RiderPortal'));
const RiderShell = lazy(() => import('./pages/rider/RiderShell'));
const RiderDashboard = lazy(() => import('./pages/rider/Dashboard'));
const RiderAgreements = lazy(() => import('./pages/rider/Agreements'));
const RiderAgreementDetail = lazy(() => import('./pages/rider/AgreementDetail'));
const RiderApplication = lazy(() => import('./pages/rider/Application'));
const RiderProfile = lazy(() => import('./pages/rider/Profile'));
const RiderPayments = lazy(() => import('./pages/rider/Payments'));
const RiderNotifications = lazy(() => import('./pages/rider/Notifications'));
const PaymentCallback = lazy(() => import('./pages/rider/PaymentCallback'));

const AdminShell = lazy(() => import('./pages/admin/AdminShell'));
const AdminDashboard = lazy(() => import('./pages/admin/Dashboard'));
const AdminApplications = lazy(() => import('./pages/admin/Applications'));
const AdminApplicationDetail = lazy(() => import('./pages/admin/ApplicationDetail'));
const AdminAgreements = lazy(() => import('./pages/admin/Agreements'));
const AdminAgreementDetail = lazy(() => import('./pages/admin/AgreementDetail'));
const AdminBikes = lazy(() => import('./pages/admin/Bikes'));
const AdminBikeDetail = lazy(() => import('./pages/admin/BikeDetail'));
const AdminPayments = lazy(() => import('./pages/admin/Payments'));
const AdminNotifications = lazy(() => import('./pages/admin/Notifications'));
const AdminUsers = lazy(() => import('./pages/admin/Users'));
const AdminAuditLogs = lazy(() => import('./pages/admin/AuditLogs'));
const AdminClaims = lazy(() => import('./pages/admin/Claims'));
const AdminStrategyReport = lazy(() => import('./pages/admin/StrategyReport'));
const AdminImports = lazy(() => import('./pages/admin/Imports'));
const AdminFleetDashboard = lazy(() => import('./pages/admin/FleetDashboard'));
const AdminFleetOwners = lazy(() => import('./pages/admin/FleetOwners'));
const AdminFleetPayouts = lazy(() => import('./pages/admin/FleetPayouts'));
const AdminTracking = lazy(() => import('./pages/admin/Tracking'));
const AdminTrackingDashboard = lazy(() => import('./pages/admin/TrackingDashboard'));
const AdminLeads = lazy(() => import('./pages/admin/Leads'));
const AdminWorkshop = lazy(() => import('./pages/admin/Workshop'));
const WorkshopLogin = lazy(() => import('./pages/workshop/Login'));
const WorkshopShell = lazy(() => import('./pages/workshop/WorkshopShell'));
const WorkshopDashboard = lazy(() => import('./pages/workshop/Dashboard'));
const WorkshopJobCards = lazy(() => import('./pages/workshop/JobCards'));
const WorkshopJobCard = lazy(() => import('./pages/workshop/JobCard'));
const FleetImpersonate = lazy(() => import('./pages/fleet/FleetImpersonate'));
const FleetRiderApply = lazy(() => import('./pages/FleetRiderApply'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Terms = lazy(() => import('./pages/Terms'));
const ControlRoom = lazy(() => import('./pages/ControlRoom'));
const ControlRoomAlerts = lazy(() => import('./pages/ControlRoomAlerts'));

const WORKSHOP_ROLES = ['technician', 'admin', 'superadmin'];

// Each route's page component is its own lazily-fetched chunk (see the lazy()
// imports above) — this fallback fills the gap between navigating to a route
// and its chunk arriving. Kept intentionally minimal (no logo/animation) so
// it never looks like a competing loading state next to each page's own.
function RouteLoading() {
  return <div style={{ minHeight: '100vh', background: 'var(--bg)' }} />;
}

function PrivateRoute({ children, role }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to={role === 'fleet_owner' ? '/fleet/login' : '/login'} replace />;
  if (role === 'rider' && user.role !== 'rider') return <Navigate to={String(user.role || '').startsWith('fleet_owner_') ? '/fleet/app' : '/admin'} replace />;
  if (role === 'admin' && !['admin', 'superadmin'].includes(user.role)) return <Navigate to={String(user.role || '').startsWith('fleet_owner_') ? '/fleet/app' : '/dashboard'} replace />;
  if (role === 'fleet_owner' && !String(user.role || '').startsWith('fleet_owner_')) return <Navigate to={['admin', 'superadmin'].includes(user.role) ? '/admin' : '/dashboard'} replace />;
  if (role === 'workshop' && !WORKSHOP_ROLES.includes(user.role)) return <Navigate to="/login" replace />;
  if (role === 'control_room' && user.role !== 'control_room') return <Navigate to="/login" replace />;
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
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Landing />;
  if (user.role === 'technician') return <Navigate to="/workshop/app" replace />;
  if (user.role === 'control_room') return <Navigate to="/control-room" replace />;
  if (isAdminPortalRole(user.role)) return <Navigate to="/admin" replace />;
  if (String(user.role || '').startsWith('fleet_owner_')) return <Navigate to={getDefaultFleetRoute(user.role)} replace />;
  return <Navigate to="/dashboard" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <AnalyticsTracker />
      <OfflineBanner />
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/" element={<HomeRoute />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/fleet" element={<FleetOwnerPilot />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/rider-portal/:token" element={<RiderPortal />} />
          <Route path="/fleet/login" element={<FleetLogin />} />
          <Route path="/fleet/signup" element={<FleetSignup />} />
          <Route path="/fleet/impersonate" element={<FleetImpersonate />} />
          <Route path="/fleet/workspace" element={<FleetOwnerWorkspace />} />
          <Route path="/fleet/rider-apply/:slug" element={<FleetRiderApply />} />
          <Route path="/fleet/app" element={<PrivateRoute role="fleet_owner"><FleetOwnerShell /></PrivateRoute>}>
            <Route index element={<FleetRouteGate section="dashboard"><FleetDashboard /></FleetRouteGate>} />
            <Route path="bikes" element={<FleetRouteGate section="bikes"><FleetOwnerBikes /></FleetRouteGate>} />
            <Route path="tracking" element={<FleetRouteGate section="tracking"><FleetTracking /></FleetRouteGate>} />
            <Route path="agreements" element={<FleetRouteGate section="agreements"><FleetOwnerAgreements /></FleetRouteGate>} />
            <Route path="agreements/:id" element={<FleetRouteGate section="agreements"><FleetAgreementDetail /></FleetRouteGate>} />
            <Route path="payments" element={<FleetRouteGate section="payments"><FleetOwnerPayments /></FleetRouteGate>} />
            <Route path="riders" element={<FleetRouteGate section="riders"><FleetOwnerRiders /></FleetRouteGate>} />
            <Route path="wallet" element={<FleetRouteGate section="wallet"><FleetWallet /></FleetRouteGate>} />
            <Route path="billing" element={<FleetRouteGate section="billing"><FleetBilling /></FleetRouteGate>} />
            <Route path="collections" element={<FleetRouteGate section="collections"><FleetCollections /></FleetRouteGate>} />
            <Route path="hubs" element={<FleetRouteGate section="hubs"><FleetHubs /></FleetRouteGate>} />
            <Route path="api-keys" element={<FleetRouteGate section="api_keys"><FleetApiKeys /></FleetRouteGate>} />
            <Route path="reports" element={<FleetRouteGate section="reporting"><FleetReports /></FleetRouteGate>} />
            <Route path="team" element={<FleetRouteGate section="team"><FleetTeam /></FleetRouteGate>} />
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
            <Route path="fleet-payouts" element={<AdminFleetPayouts />} />
            <Route path="pilot" element={<Navigate to="/admin/leads" replace />} />
            <Route path="leads" element={<AdminLeads />} />
            <Route path="tracking" element={<AdminTracking />} />
            <Route path="tracking/dashboard" element={<AdminTrackingDashboard />} />
            <Route path="claims" element={<AdminClaims />} />
            <Route path="workshop" element={<AdminWorkshop />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="audit" element={<AdminAuditLogs />} />
          </Route>

          <Route path="/control-room" element={<PrivateRoute role="control_room"><ControlRoom /></PrivateRoute>}>
            <Route index element={<AdminTracking readOnly />} />
            <Route path="alerts" element={<ControlRoomAlerts />} />
          </Route>

          <Route path="/workshop/login" element={<WorkshopLogin />} />
          <Route path="/workshop/app" element={<PrivateRoute role="workshop"><WorkshopShell /></PrivateRoute>}>
            <Route index element={<WorkshopDashboard />} />
            <Route path="job-cards" element={<WorkshopJobCards />} />
            <Route path="job-cards/:id" element={<WorkshopJobCard />} />
          </Route>
        </Routes>
      </Suspense>
      <MobileOnboardingPrompt />
    </AuthProvider>
  );
}
