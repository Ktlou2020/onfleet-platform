import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import InstallPrompt from './components/InstallPrompt';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
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

function PrivateRoute({ children, role }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (role === 'rider' && user.role !== 'rider') return <Navigate to="/admin" replace />;
  if (role === 'admin' && !['admin', 'superadmin'].includes(user.role)) return <Navigate to="/dashboard" replace />;
  return children;
}

function HomeRoute() {
  const { user } = useAuth();
  if (!user) return <Landing />;
  if (['admin', 'superadmin'].includes(user.role)) return <Navigate to="/admin" replace />;
  return <Navigate to="/dashboard" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />

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
          <Route path="users" element={<AdminUsers />} />
          <Route path="kyc" element={<Navigate to="/admin/applications" replace />} />
          <Route path="audit" element={<AdminAuditLogs />} />
        </Route>
      </Routes>
      <InstallPrompt />
    </AuthProvider>
  );
}
