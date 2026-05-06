import { createContext, useContext, useState, useEffect } from 'react';
import api from './api';

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
    const { data } = await api.post('/auth/login', { email, password });
    localStorage.setItem('of_token', data.token);
    localStorage.setItem('of_user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  };

  const signup = async (payload) => {
    const { data } = await api.post('/auth/signup', payload);
    localStorage.setItem('of_token', data.token);
    localStorage.setItem('of_user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  };

  const logout = () => {
    localStorage.removeItem('of_token');
    localStorage.removeItem('of_user');
    setUser(null);
  };

  return <AuthCtx.Provider value={{ user, login, signup, logout, loading }}>{children}</AuthCtx.Provider>;
}
