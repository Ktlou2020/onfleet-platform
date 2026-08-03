import { useEffect } from 'react';

export default function FleetImpersonate() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const userRaw = params.get('user');

    if (!token) {
      window.location.href = '/fleet/login';
      return;
    }

    sessionStorage.setItem('of_imp_token', token);
    if (userRaw) {
      try { sessionStorage.setItem('of_imp_user', decodeURIComponent(userRaw)); } catch (_) {}
    }

    window.location.href = '/fleet/app';
  }, []);

  return null;
}
