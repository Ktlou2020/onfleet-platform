import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BRAND, Spinner, useAuth, useCart, useLoc } from './lib.jsx';
import Home from './pages/Home.jsx';
import Store from './pages/Store.jsx';
import Checkout from './pages/Checkout.jsx';
import { Orders, Track } from './pages/Orders.jsx';
import Auth from './pages/Auth.jsx';
import Merchant from './pages/Merchant.jsx';
import Rider from './pages/Rider.jsx';
import Admin from './pages/Admin.jsx';
import Account from './pages/Account.jsx';
import AgeGate from './pages/AgeGate.jsx';
import { AddressSheet } from './pages/Address.jsx';

const HOME_FOR = { merchant: '/merchant', rider: '/rider', admin: '/admin', customer: '/' };

function Guard({ role, children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <div className="page center"><Spinner /></div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (role && user.role !== role) return <Navigate to={HOME_FOR[user.role]} replace />;
  return children;
}

function Header({ onAddress }) {
  const { user, signOut } = useAuth();
  const { count } = useCart();
  const { loc } = useLoc();
  const navigate = useNavigate();
  const customerSide = !user || user.role === 'customer';
  return (
    <header className="topbar">
      <Link to={user ? HOME_FOR[user.role] : '/'} className="logo" aria-label={`${BRAND.name} home`}>
        <span className="logo-mark">☁</span> {BRAND.name}
      </Link>
      {customerSide && (
        <button className="addr-pill" onClick={onAddress}>
          <span className="addr-label">Deliver to</span>
          <span className="addr-value">{loc?.label || 'Set your address'} ▾</span>
        </button>
      )}
      <nav className="top-actions">
        {customerSide && (
          <Link to="/checkout" className="cart-btn" aria-label={`Basket, ${count} items`}>
            🛒{count > 0 && <span className="badge">{count}</span>}
          </Link>
        )}
        {user ? (
          <>
            {user.role === 'customer' && <NavLink to="/orders" className="nav-link hide-sm">Orders</NavLink>}
            {user.role === 'customer' && <NavLink to="/account" className="nav-link hide-sm">Account</NavLink>}
            <button className="nav-link" onClick={() => { signOut(); navigate('/'); }}>Sign out</button>
          </>
        ) : (
          <Link to="/login" className="btn btn-sm">Sign in</Link>
        )}
      </nav>
    </header>
  );
}

function BottomNav() {
  const { user } = useAuth();
  const { count } = useCart();
  if (user && user.role !== 'customer') return null;
  return (
    <nav className="bottom-nav">
      <NavLink to="/" end>🏠<span>Home</span></NavLink>
      <NavLink to="/search">🔎<span>Search</span></NavLink>
      <NavLink to="/checkout">🛒<span>Basket{count ? ` (${count})` : ''}</span></NavLink>
      <NavLink to="/orders">📦<span>Orders</span></NavLink>
      <NavLink to={user ? '/account' : '/login'}>👤<span>{user ? 'Account' : 'Sign in'}</span></NavLink>
    </nav>
  );
}

export default function App() {
  const { loc } = useLoc();
  const [addressOpen, setAddressOpen] = useState(false);
  const [adultConfirmed, setAdultConfirmed] = useState(() => {
    try { return localStorage.getItem('cloud9.adult') === 'yes'; } catch { return false; }
  });
  const { pathname } = useLocation();
  // The rider app runs full-screen, like a native driver app.
  const fullScreen = pathname.startsWith('/rider');
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);

  if (!adultConfirmed) return <AgeGate onConfirm={() => setAdultConfirmed(true)} />;

  return (
    <div className="app">
      {!fullScreen && <Header onAddress={() => setAddressOpen(true)} />}
      <main>
        <Routes>
          <Route path="/" element={<Home onAddress={() => setAddressOpen(true)} />} />
          <Route path="/search" element={<Home searchMode onAddress={() => setAddressOpen(true)} />} />
          <Route path="/store/:slug" element={<Store />} />
          <Route path="/checkout" element={<Checkout onAddress={() => setAddressOpen(true)} />} />
          <Route path="/orders" element={<Guard role="customer"><Orders /></Guard>} />
          <Route path="/orders/:id" element={<Guard role="customer"><Track /></Guard>} />
          <Route path="/account" element={<Guard role="customer"><Account /></Guard>} />
          <Route path="/login" element={<Auth />} />
          <Route path="/merchant/*" element={<Guard role="merchant"><Merchant /></Guard>} />
          <Route path="/rider" element={<Guard role="rider"><Rider /></Guard>} />
          <Route path="/admin" element={<Guard role="admin"><Admin /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {!fullScreen && <footer className="footer">
        <p>{BRAND.name} · 18+ only · ID checked on every delivery · Please use responsibly</p>
        <p className="muted">Support: {BRAND.support}</p>
      </footer>}
      <BottomNav />
      {(addressOpen || (!loc && pathname === '/')) && <AddressSheet onClose={() => setAddressOpen(false)} />}
    </div>
  );
}
