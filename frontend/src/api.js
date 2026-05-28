import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use((cfg) => {
  const token = localStorage.getItem('of_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 402 && err.response.data?.code === 'SUBSCRIPTION_REQUIRED') {
      if (!window.location.pathname.endsWith('/billing')) {
        window.location.href = '/fleet/app/billing';
      }
      return Promise.reject(err);
    }
    if (err.response?.status === 401) {
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
      if (!location.pathname.startsWith(redirectTo)) location.href = redirectTo;
    }
    return Promise.reject(err);
  }
);

export default api;
