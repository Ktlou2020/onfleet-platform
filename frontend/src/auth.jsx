import { createContext, useContext, useState, useEffect } from 'react';
import api from './api';
import { trackAnalyticsEvent } from './analytics';

const AuthCtx = createContext();
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('of_user')); } catch { return null; }
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('of_token') && !user) {
      api.get('/auth/me').then(r => {
        setUser(r.data.user);
        localStorage.setItem('of_user', JSON.stringify(r.data.user));
      }).catch(() => {});
    }
  }, []);

  const login = async (email, password) => {
    try {
      const { data } = await api.post('/auth/login', { email, password });
      localStorage.setItem('of_token', data.token);
      localStorage.setItem('of_user', JSON.stringify(data.user));
      setUser(data.user);
      trackAnalyticsEvent('login_success', {
        login_role: data.user?.role || 'unknown',
        login_method: 'password'
      });
      return data.user;
    } catch (error) {
      trackAnalyticsEvent('login_failed', {
        login_method: 'password',
        error_message: error.response?.data?.error || 'Login failed'
      });
      throw error;
    }
  };

  const signup = async (payload) => {
    const isFormData = typeof FormData !== 'undefined' && payload instanceof FormData;
    try {
      const { data } = await api.post(isFormData ? '/auth/signup-complete' : '/auth/signup', payload, isFormData
        ? { headers: { 'Content-Type': 'multipart/form-data' } }
        : undefined);
      localStorage.setItem('of_token', data.token);
      localStorage.setItem('of_user', JSON.stringify(data.user));
      setUser(data.user);
      trackAnalyticsEvent('sign_up', {
        signup_type: isFormData ? 'rider_full_application' : 'rider_basic',
        user_role: data.user?.role || 'rider'
      });
      return data.user;
    } catch (error) {
      trackAnalyticsEvent('sign_up_failed', {
        signup_type: isFormData ? 'rider_full_application' : 'rider_basic',
        error_message: error.response?.data?.error || 'Sign up failed'
      });
      throw error;
    }
  };

  const signupFleet = async (payload) => {
    try {
      const { data } = await api.post('/auth/fleet/signup', payload);
      localStorage.setItem('of_token', data.token);
      localStorage.setItem('of_user', JSON.stringify(data.user));
      setUser(data.user);
      trackAnalyticsEvent('sign_up', {
        signup_type: 'fleet_owner',
        user_role: data.user?.role || 'fleet_owner_admin',
        organization_slug: data.user?.organization_slug || undefined
      });
      return data.user;
    } catch (error) {
      trackAnalyticsEvent('sign_up_failed', {
        signup_type: 'fleet_owner',
        error_message: error.response?.data?.error || 'Fleet signup failed'
      });
      throw error;
    }
  };

  const logout = () => {
    trackAnalyticsEvent('logout', { user_role: user?.role || 'unknown' });
    localStorage.removeItem('of_token');
    localStorage.removeItem('of_user');
    setUser(null);
  };

  return <AuthCtx.Provider value={{ user, login, signup, signupFleet, logout, loading }}>{children}</AuthCtx.Provider>;
}
