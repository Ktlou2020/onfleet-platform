import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function FleetImpersonate() {
  const nav = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const userRaw = params.get('user');

    if (!token) {
      nav('/fleet/login', { replace: true });
      return;
    }

    sessionStorage.setItem('of_imp_token', token);
    if (userRaw) {
      try { sessionStorage.setItem('of_imp_user', decodeURIComponent(userRaw)); } catch (_) {}
    }

    nav('/fleet/app', { replace: true });
  }, []);

  return null;
}
