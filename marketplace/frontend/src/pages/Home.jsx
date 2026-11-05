import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BRAND, Empty, Spinner, api, rand, useCart, useLoc, useMeta, useToast } from '../lib.jsx';

function qs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
}

export function StoreCard({ s }) {
  return (
    <Link to={`/store/${s.slug}`} className={`store-card ${!s.isOpen || s.delivers === false ? 'dim' : ''}`}>
      <div className="store-banner" style={{ background: `linear-gradient(135deg, ${s.accent}, ${s.accent}cc 60%, #0f2a1d)` }}>
        <span className="store-initial">{s.name[0]}</span>
        {!s.isOpen && <span className="tag tag-dark">Closed</span>}
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

export function ProductRow({ p, store }) {
  const { add, cart } = useCart();
  const notify = useToast();
  const inCart = cart.items.find((i) => i.id === p.id)?.qty || 0;
  const onAdd = () => {
    if (cart.store && cart.store.id !== store.id && cart.items.length) {
      if (!window.confirm(`Your basket has items from ${cart.store.name}. Start a new basket from ${store.name}?`)) return;
    }
    add(store, p);
    notify(`Added ${p.name}`);
  };
  return (
    <div className={`product ${!p.inStock ? 'dim' : ''}`}>
      <div className="product-icon">{p.category.icon}</div>
      <div className="product-main">
        <h4>{p.name}</h4>
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
        <div className="banner">🌙 Delivery is closed right now. You can browse — orders open again at {meta.deliveryHours.open}:00.</div>
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
          <h2 className="section-title">{category ? `${meta?.categories.find((c) => c.slug === category)?.name} stores` : 'Stores near you'}</h2>
          {!stores ? <div className="center pad"><Spinner /></div> : stores.length === 0 ? (
            <Empty icon="🏪" title="No stores here yet">We're onboarding stores in your city. Try another city or category.</Empty>
          ) : (
            <div className="store-grid">{stores.map((s) => <StoreCard key={s.id} s={s} />)}</div>
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
