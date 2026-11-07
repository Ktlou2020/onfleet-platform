import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BRAND, Empty, Spinner, api, rand, reorderInto, useAuth, useCart, useFavourites, useLoc, useMeta, useToast } from '../lib.jsx';

function qs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
}

export function Heart({ storeId, name, className = '' }) {
  const { user } = useAuth();
  const { ids, toggle } = useFavourites();
  const navigate = useNavigate();
  const notify = useToast();
  const on = ids.has(storeId);
  const click = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user) return navigate('/login');
    if (user.role !== 'customer') return;
    const nowOn = await toggle(storeId);
    notify(nowOn ? `Saved ${name} to favourites` : `Removed ${name} from favourites`);
  };
  return (
    <button className={`heart ${on ? 'on' : ''} ${className}`} onClick={click} aria-pressed={on} aria-label={on ? `Remove ${name} from favourites` : `Save ${name} to favourites`}>
      {on ? '♥' : '♡'}
    </button>
  );
}

export function StoreCard({ s }) {
  return (
    <Link to={`/store/${s.slug}`} className={`store-card ${(!s.isOpen && !s.preorder) || s.delivers === false ? 'dim' : ''}`}>
      <div className="store-banner" style={{ background: `linear-gradient(135deg, ${s.accent}, ${s.accent}cc 60%, #0f2a1d)` }}>
        <Heart storeId={s.id} name={s.name} className="on-banner" />
        <span className="store-initial">{s.name[0]}</span>
        {!s.isOpen && <span className="tag tag-dark">{s.preorder ? `Pre-order · ${s.openLabel.replace('Opens ', 'opens ')}` : s.openLabel || 'Closed'}</span>}
        {s.isOpen && s.delivers === false && <span className="tag tag-dark">Too far</span>}
        {s.etaMinutes != null && s.isOpen && s.delivers !== false && <span className="eta-pill">{s.etaMinutes}–{s.etaMinutes + 10} min</span>}
      </div>
      <div className="store-body">
        <div className="row-between">
          <h3>{s.name}</h3>
          {s.rating && <span className="rating">★ {s.rating.toFixed(1)}</span>}
        </div>
        <p className="muted clamp">{s.description}</p>
        <p className="meta-line">
          {s.distanceKm != null && <span>{s.distanceKm} km</span>}
          {s.deliveryFeeCents != null && <span>{rand(s.deliveryFeeCents)} delivery</span>}
          <span>{s.productCount} items</span>
        </p>
      </div>
    </Link>
  );
}

// One product card. With `options` (a main product and its sizes or
// flavours) the customer picks one with chips, and price and stock follow.
export function ProductRow({ p: main, store, options }) {
  const { add, cart } = useCart();
  const notify = useToast();
  const choices = options && options.length > 1 ? options : null;
  const [chosen, setChosen] = useState(() => (choices ? (choices.find((o) => o.inStock) || choices[0]).id : main.id));
  const p = choices ? choices.find((o) => o.id === chosen) || main : main;
  const inCart = cart.items.find((i) => i.id === p.id)?.qty || 0;
  const onAdd = () => {
    if (cart.store && cart.store.id !== store.id && cart.items.length) {
      if (!window.confirm(`Your basket has items from ${cart.store.name}. Start a new basket from ${store.name}?`)) return;
    }
    add(store, { ...p, name: p.variantLabel ? `${p.name} (${p.variantLabel})` : p.name });
    notify(`Added ${p.name}${p.variantLabel ? ` (${p.variantLabel})` : ''}`);
  };
  return (
    <div className={`product ${!p.inStock ? 'dim' : ''}`}>
      {p.photoUrl || main.photoUrl
        ? <img className="product-photo" src={p.photoUrl || main.photoUrl} alt="" loading="lazy" width="72" height="72" />
        : <div className="product-icon">{p.category.icon}</div>}
      <div className="product-main">
        <h4>{p.featured && <span className="pick" title="Store pick">⭐ </span>}{p.name}{!choices && p.variantLabel ? <span className="muted"> · {p.variantLabel}</span> : null}</h4>
        {choices && (
          <div className="variant-chips" role="radiogroup" aria-label={`${main.name} options`}>
            {choices.map((o) => (
              <button key={o.id} type="button" role="radio" aria-checked={o.id === chosen} className={`chip ${o.id === chosen ? 'on' : ''} ${!o.inStock ? 'out' : ''}`} onClick={() => setChosen(o.id)}>
                {o.variantLabel || 'Standard'}
              </button>
            ))}
          </div>
        )}
        <p className="muted clamp">{p.description}</p>
        <div className="product-tags">
          {p.strainType && <span className="tag">{p.strainType}</span>}
          {p.thcPct != null && p.thcPct > 0 && <span className="tag">THC {p.thcPct}%</span>}
          {p.cbdPct != null && p.cbdPct > 0 && <span className="tag">CBD {p.cbdPct}{p.category.slug === 'cbd' ? '' : '%'}</span>}
          {p.inStock && p.stock <= 5 && <span className="tag tag-warn">Only {p.stock} left</span>}
          {store && store.name && !store.hideName && <span className="tag tag-store">{store.name}</span>}
        </div>
      </div>
      <div className="product-side">
        <strong>{rand(p.priceCents)}</strong>
        <span className="muted small">/{p.unit}</span>
        {p.inStock ? (
          <button className="btn btn-sm add-btn" onClick={onAdd} aria-label={`Add ${p.name}`}>{inCart ? `+ (${inCart})` : 'Add'}</button>
        ) : (
          <span className="tag">Sold out</span>
        )}
      </div>
    </div>
  );
}

export default function Home({ searchMode, onAddress }) {
  const meta = useMeta();
  const { loc } = useLoc();
  const [params, setParams] = useSearchParams();
  const category = params.get('category') || '';
  const [q, setQ] = useState(params.get('q') || '');
  const [stores, setStores] = useState(null);
  const [results, setResults] = useState(null);
  const [sort, setSort] = useState('fastest');
  const [only, setOnly] = useState({ open: false, free: false });
  const [recent, setRecent] = useState([]);
  const { user } = useAuth();
  const { ids: favIds } = useFavourites();
  const cart = useCart();
  const notify = useToast();
  const navigate = useNavigate();

  // The last few stores this customer ordered from, newest first.
  useEffect(() => {
    if (user?.role !== 'customer' || searchMode) return;
    api('/orders').then((d) => {
      const seen = new Set();
      setRecent(d.orders.filter((o) => o.status === 'delivered' && !seen.has(o.store.id) && seen.add(o.store.id)).slice(0, 6));
    }).catch(() => {});
  }, [user?.id, user?.role, searchMode]);

  const again = async (o) => {
    try {
      const r = await reorderInto(o.id, cart);
      notify(r.missing.length ? `Added what's available — ${r.missing.map((m) => m.name).join(', ')} unavailable` : `Added your ${o.store.name} order to the basket`, r.missing.length ? 'bad' : 'ok');
      navigate('/checkout');
    } catch (e) { notify(e.message, 'bad'); }
  };

  const where = useMemo(() => ({ city: loc?.city, lat: loc?.lat, lng: loc?.lng, category }), [loc, category]);

  useEffect(() => {
    setStores(null);
    api(`/stores?${qs(where)}`).then((d) => setStores(d.stores)).catch(() => setStores([]));
  }, [where]);

  useEffect(() => {
    if (!searchMode && !q) { setResults(null); return undefined; }
    const t = setTimeout(() => {
      api(`/search?${qs({ ...where, q })}`).then((d) => setResults(d.results)).catch(() => setResults([]));
    }, 220);
    return () => clearTimeout(t);
  }, [q, where, searchMode]);

  const setCategory = (slug) => {
    const next = new URLSearchParams(params);
    if (slug === category || !slug) next.delete('category'); else next.set('category', slug);
    setParams(next, { replace: true });
  };

  const fastest = stores?.filter((s) => s.isOpen && s.delivers !== false)[0];
  const shown = useMemo(() => {
    if (!stores) return null;
    const list = stores.filter((x) => (!only.open || (x.isOpen && x.delivers !== false)) && (!only.free || (x.deliveryFeeCents ?? 99999) <= 3000));
    const by = {
      fastest: (a, b) => (b.isOpen - a.isOpen) || ((a.etaMinutes ?? 99) - (b.etaMinutes ?? 99)),
      rating: (a, b) => (b.isOpen - a.isOpen) || ((b.rating ?? 0) - (a.rating ?? 0)),
      nearest: (a, b) => (a.distanceKm ?? 99) - (b.distanceKm ?? 99),
    };
    return [...list].sort(by[sort]);
  }, [stores, sort, only]);
  const favStores = stores?.filter((x) => favIds.has(x.id)) || [];

  return (
    <div className="page">
      {!searchMode && (
        <section className="hero">
          <div>
            <p className="eyebrow">{loc ? `Delivering in ${meta?.cities.find((c) => c.slug === loc.city)?.name || 'your area'}` : 'Johannesburg · Cape Town · Durban · Pretoria'}</p>
            <h1>{BRAND.tagline}.</h1>
            <p className="hero-sub">
              Local stores, live tracking, and riders who check ID at the door.
              {fastest && <> Fastest right now: <strong>{fastest.name}</strong> in ~{fastest.etaMinutes} min.</>}
            </p>
            {!loc && <button className="btn btn-lg" onClick={onAddress}>📍 Set delivery address</button>}
          </div>
          <div className="hero-stats">
            <div><strong>{meta?.deliveryHours.open ?? 8}:00–{meta?.deliveryHours.close ?? 22}:00</strong><span>delivery hours</span></div>
            <div><strong>{meta ? rand(meta.fees.freeDeliveryOverCents) : 'R600'}+</strong><span>free delivery</span></div>
            <div><strong>Live</strong><span>rider tracking</span></div>
          </div>
        </section>
      )}

      {meta && !meta.deliveryHours.openNow && (
        <div className="banner">🌙 We're not delivering right now, but you can still order. We'll deliver from {meta.deliveryHours.open}:00, when deliveries start.</div>
      )}

      <div className="search-bar">
        <span>🔎</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products, e.g. papers, grinder, CBD oil" autoFocus={searchMode} aria-label="Search" />
        {q && <button className="link" onClick={() => setQ('')}>Clear</button>}
      </div>

      <div className="chips scroll">
        {meta?.categories.map((c) => (
          <button key={c.slug} className={`chip ${category === c.slug ? 'on' : ''}`} onClick={() => setCategory(c.slug)}>
            <span>{c.icon}</span> {c.name}
          </button>
        ))}
      </div>

      {results ? (
        <section>
          <h2 className="section-title">{q ? `Results for “${q}”` : 'Everything near you'}</h2>
          {results.length === 0 ? (
            <Empty icon="🔍" title="Nothing found">Try another word or category.</Empty>
          ) : (
            <div className="product-list">
              {results.map((p) => <ProductRow key={p.id} p={p} store={p.store} />)}
            </div>
          )}
        </section>
      ) : (
        <section>
          {!category && recent.length > 0 && (
            <>
              <h2 className="section-title">Order again</h2>
              <div className="again-row">
                {recent.map((o) => (
                  <div key={o.id} className="again-card">
                    <Link to={`/store/${o.store.slug}`} className="again-name" style={{ borderColor: o.store.accent }}>{o.store.name}</Link>
                    <p className="muted small clamp">{o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</p>
                    <button className="btn btn-sm" onClick={() => again(o)}>↻ Order again · {rand(o.totals.subtotalCents)}</button>
                  </div>
                ))}
              </div>
            </>
          )}
          {!category && favStores.length > 0 && (
            <>
              <h2 className="section-title">♥ Your favourites</h2>
              <div className="store-grid">{favStores.map((s) => <StoreCard key={`f${s.id}`} s={s} />)}</div>
            </>
          )}
          <div className="row-between list-head">
            <h2 className="section-title">{category ? `${meta?.categories.find((c) => c.slug === category)?.name} stores` : 'All stores near you'}</h2>
            <div className="sort-row">
              <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort stores">
                <option value="fastest">Fastest</option>
                <option value="rating">Top rated</option>
                <option value="nearest">Nearest</option>
              </select>
              <button className={`chip ${only.open ? 'on' : ''}`} onClick={() => setOnly((o) => ({ ...o, open: !o.open }))} aria-pressed={only.open}>Open now</button>
              <button className={`chip ${only.free ? 'on' : ''}`} onClick={() => setOnly((o) => ({ ...o, free: !o.free }))} aria-pressed={only.free}>Delivery under R30</button>
            </div>
          </div>
          {!shown ? <div className="center pad"><Spinner /></div> : shown.length === 0 ? (
            stores.length === 0
              ? <Empty icon="🏪" title="No stores here yet">We're onboarding stores in your city. Try another city or category.</Empty>
              : <Empty icon="🔍" title="No stores match">Try turning off a filter.</Empty>
          ) : (
            <div className="store-grid">{shown.map((s) => <StoreCard key={s.id} s={s} />)}</div>
          )}
        </section>
      )}

      {!searchMode && (
        <section className="promises">
          <div><span>⚡</span><h4>Fast</h4><p>Nearest store, nearest rider, dispatched automatically.</p></div>
          <div><span>📍</span><h4>Tracked</h4><p>Watch your rider on the map from store to door.</p></div>
          <div><span>🪪</span><h4>Responsible</h4><p>18+ only. ID verified at sign-up and checked again at the door.</p></div>
          <div><span>💳</span><h4>Clear pricing</h4><p>VAT-inclusive prices, fees shown before you pay.</p></div>
        </section>
      )}
    </div>
  );
}
