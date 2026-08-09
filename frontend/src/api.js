import axios from 'axios';
import { readCache, writeCache } from './offlineCache';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use((cfg) => {
  const token = sessionStorage.getItem('of_imp_token') || localStorage.getItem('of_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

api.interceptors.response.use(
  (r) => {
    if (r.config.method === 'get') writeCache(r.config.url, r.data);
    return r;
  },
  (err) => {
    // No err.response means the request never reached the server — offline
    // or a dropped connection, not an API error. Fall back to the last
    // successful response for this endpoint so the page shows stale data
    // instead of erroring out.
    if (!err.response && err.config?.method === 'get') {
      const cached = readCache(err.config.url);
      if (cached) {
        return Promise.resolve({ data: cached.data, status: 200, statusText: 'OK (cached)', headers: {}, config: err.config, fromCache: true, cachedAt: cached.cachedAt });
      }
    }
    if (err.response?.status === 402 && err.response.data?.code === 'SUBSCRIPTION_REQUIRED') {
      if (!window.location.pathname.endsWith('/billing')) {
        window.location.href = '/fleet/app/billing';
      }
      return Promise.reject(err);
    }
    if (err.response?.status === 401) {
      if (sessionStorage.getItem('of_imp_token')) {
        sessionStorage.removeItem('of_imp_token');
        sessionStorage.removeItem('of_imp_user');
        location.href = '/fleet/login';
        return Promise.reject(err);
      }
      let redirectTo = '/login';
      try {
        const storedUser = JSON.parse(localStorage.getItem('of_user') || 'null');
        if (location.pathname.startsWith('/fleet') || String(storedUser?.role || '').startsWith('fleet_owner_')) {
          redirectTo = '/fleet/login';
        }
      } catch (_) {
        if (location.pathname.startsWith('/fleet')) redirectTo = '/fleet/login';
      }

      localStorage.removeItem('of_token');
      localStorage.removeItem('of_user');
      if (location.pathname !== redirectTo && !location.pathname.startsWith(redirectTo + '/')) location.href = redirectTo;
    }
    return Promise.reject(err);
  }
);

export default api;
