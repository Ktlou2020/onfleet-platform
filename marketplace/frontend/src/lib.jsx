import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// ---- Brand: change the name here and it changes everywhere ---------------
export const BRAND = {
  name: 'Cloud 9',
  tagline: 'Delivered to your door in minutes',
  support: 'help@cloud9.africa',
};

// ---- API ------------------------------------------------------------------
const TOKEN_KEY = 'cloud9.token';
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
export const getToken = () => safe(() => localStorage.getItem(TOKEN_KEY));

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const rand = (cents) => `R${(cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export const STATUS = {
  pending_payment: { label: 'Awaiting payment', step: 0 },
  scheduled: { label: 'Scheduled', step: 0 },
  placed: { label: 'Order placed', step: 1 },
  accepted: { label: 'Store accepted', step: 2 },
  preparing: { label: 'Being packed', step: 2 },
  ready: { label: 'Ready for pickup', step: 3 },
  picked_up: { label: 'On the way', step: 4 },
  delivered: { label: 'Delivered', step: 5 },
  cancelled: { label: 'Cancelled', step: -1 },
  rejected: { label: 'Store declined', step: -1 },
  rider_assigned: { label: 'Rider assigned', step: -1 },
  rider_at_store: { label: 'Rider is at the store', step: -1 },
  rider_arrived: { label: 'Rider is outside', step: -1 },
  returned: { label: 'Returned to store', step: -1 },
};

// ---- Auth -----------------------------------------------------------------
const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    api('/me').then((d) => setUser(d.user)).catch(() => safe(() => localStorage.removeItem(TOKEN_KEY))).finally(() => setReady(true));
  }, []);

  const signIn = useCallback(({ token, user: u }) => {
    safe(() => localStorage.setItem(TOKEN_KEY, token));
    setUser(u);
  }, []);
  const signOut = useCallback(() => {
    safe(() => localStorage.removeItem(TOKEN_KEY));
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, setUser, ready, signIn, signOut }), [user, ready, signIn, signOut]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
export const useAuth = () => useContext(AuthCtx);

// ---- Location: where the customer wants things delivered ----------------
const LOC_KEY = 'cloud9.location';
const LocCtx = createContext(null);

export function LocationProvider({ children }) {
  const [loc, setLocState] = useState(() => safe(() => JSON.parse(localStorage.getItem(LOC_KEY)), null));
  const setLoc = useCallback((l) => {
    setLocState(l);
    safe(() => localStorage.setItem(LOC_KEY, JSON.stringify(l)));
  }, []);
  return <LocCtx.Provider value={{ loc, setLoc }}>{children}</LocCtx.Provider>;
}
export const useLoc = () => useContext(LocCtx);

// ---- Basket: one store at a time, like every serious delivery app -------
const CART_KEY = 'cloud9.cart';
const CartCtx = createContext(null);

export function CartProvider({ children }) {
  const [cart, setCart] = useState(() => safe(() => JSON.parse(localStorage.getItem(CART_KEY)), null) || { store: null, items: [] });
  useEffect(() => { safe(() => localStorage.setItem(CART_KEY, JSON.stringify(cart))); }, [cart]);

  const add = useCallback((store, product, qty = 1) => {
    setCart((c) => {
      const base = c.store?.id === store.id ? c : { store: { id: store.id, name: store.name, slug: store.slug }, items: [] };
      const found = base.items.find((i) => i.id === product.id);
      const items = found
        ? base.items.map((i) => (i.id === product.id ? { ...i, qty: Math.min(i.qty + qty, 20, product.stock) } : i))
        : [...base.items, { id: product.id, name: product.name, priceCents: product.priceCents, qty: Math.min(qty, product.stock), icon: product.category.icon }];
      return { ...base, items };
    });
  }, []);
  const setQty = useCallback((id, qty) => setCart((c) => {
    const items = qty <= 0 ? c.items.filter((i) => i.id !== id) : c.items.map((i) => (i.id === id ? { ...i, qty: Math.min(qty, 20) } : i));
    return items.length ? { ...c, items } : { store: null, items: [] };
  }), []);
  const clear = useCallback(() => setCart({ store: null, items: [] }), []);

  const count = cart.items.reduce((n, i) => n + i.qty, 0);
  const subtotal = cart.items.reduce((n, i) => n + i.qty * i.priceCents, 0);
  return <CartCtx.Provider value={{ cart, add, setQty, clear, count, subtotal }}>{children}</CartCtx.Provider>;
}
export const useCart = () => useContext(CartCtx);

// ---- Small hooks ----------------------------------------------------------
// Platform settings, fetched once and shared (maps, fees, delivery hours).
let metaPromise = null;
let metaValue = null;
export function useMeta() {
  const [meta, setMeta] = useState(metaValue);
  useEffect(() => {
    if (metaValue) return;
    metaPromise = metaPromise || api('/meta').then((m) => { metaValue = m; return m; }).catch((e) => { metaPromise = null; throw e; });
    metaPromise.then(setMeta).catch(() => {});
  }, []);
  return meta;
}

// Live order: Server-Sent Events, with a poll as a fallback.
export function useLiveOrder(id) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let es;
    let poll;
    api(`/orders/${id}`).then((d) => setOrder(d.order)).catch((e) => setError(e.message));
    if (typeof EventSource !== 'undefined') {
      es = new EventSource(`/api/orders/${id}/stream?token=${encodeURIComponent(getToken() || '')}`);
      es.onmessage = (e) => setOrder(JSON.parse(e.data));
      es.onerror = () => {
        es.close();
        poll = setInterval(() => api(`/orders/${id}`).then((d) => setOrder(d.order)).catch(() => {}), 5000);
      };
    }
    return () => { es?.close(); clearInterval(poll); };
  }, [id]);
  return { order, setOrder, error };
}

export function Spinner() {
  return <div className="spinner" role="status" aria-label="Loading" />;
}

export function Empty({ icon, title, children }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Toast({ msg, onDone }) {
  useEffect(() => {
    if (!msg) return undefined;
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [msg, onDone]);
  if (!msg) return null;
  return <div className={`toast ${msg.type || ''}`} role="status">{msg.text}</div>;
}

const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [msg, setMsg] = useState(null);
  const notify = useCallback((text, type) => setMsg({ text, type, at: Date.now() }), []);
  return (
    <ToastCtx.Provider value={notify}>
      {children}
      <Toast msg={msg} onDone={() => setMsg(null)} />
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---- Favourite stores: one set for the whole app -------------------------
const FavCtx = createContext({ ids: new Set(), toggle: () => {}, ready: false });

export function FavouritesProvider({ children }) {
  const { user } = useAuth();
  const [ids, setIds] = useState(new Set());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (user?.role !== 'customer') { setIds(new Set()); setReady(true); return; }
    api('/me/favourites').then((d) => setIds(new Set(d.stores.map((s) => s.id)))).catch(() => {}).finally(() => setReady(true));
  }, [user?.id, user?.role]);
  const toggle = useCallback(async (storeId) => {
    const on = ids.has(storeId);
    setIds((s) => { const n = new Set(s); if (on) n.delete(storeId); else n.add(storeId); return n; });
    try {
      await api(`/me/favourites/${storeId}`, { method: on ? 'DELETE' : 'PUT' });
    } catch {
      setIds((s) => { const n = new Set(s); if (on) n.add(storeId); else n.delete(storeId); return n; });
    }
    return !on;
  }, [ids]);
  return <FavCtx.Provider value={{ ids, toggle, ready }}>{children}</FavCtx.Provider>;
}
export const useFavourites = () => useContext(FavCtx);

// Rebuild a basket from a past order. Returns what couldn't be added.
export async function reorderInto(orderId, cart) {
  const d = await api(`/orders/${orderId}/reorder`);
  const ok = d.items.filter((i) => i.available);
  if (!ok.length) throw new Error('Nothing from that order is available right now');
  cart.clear();
  for (const i of ok) cart.add(d.store, { id: i.productId, name: i.name, priceCents: i.priceCents, stock: i.stock, category: i.category }, i.qty);
  return { store: d.store, missing: d.items.filter((i) => !i.available), reduced: ok.filter((i) => i.reduced) };
}

export function kmBetween(a, b) {
  const R = 6371;
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// "Fri 08:00" style label for a scheduled delivery time, in SAST.
export function deliveryTimeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const t = new Date(d.getTime() + 2 * 3600e3);
  const n = new Date(Date.now() + 2 * 3600e3);
  const hhmm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const days = Math.round((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())) / 864e5);
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : t.toLocaleDateString('en-ZA', { weekday: 'long', timeZone: 'UTC' });
  return `${day} at ${hhmm}`;
}
