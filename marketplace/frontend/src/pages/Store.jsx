import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Empty, Spinner, api, rand, useCart, useLoc } from '../lib.jsx';
import { ProductRow } from './Home.jsx';

export default function Store() {
  const { slug } = useParams();
  const { loc } = useLoc();
  const { cart, count, subtotal } = useCart();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');

  useEffect(() => {
    const p = loc ? `?lat=${loc.lat}&lng=${loc.lng}` : '';
    api(`/stores/${slug}${p}`).then(setData).catch((e) => setError(e.message));
  }, [slug, loc]);

  const groups = useMemo(() => {
    if (!data) return [];
    const by = new Map();
    for (const p of data.products) {
      if (cat !== 'all' && p.category.slug !== cat) continue;
      if (q && !`${p.name} ${p.description}`.toLowerCase().includes(q.toLowerCase())) continue;
      if (!by.has(p.category.slug)) by.set(p.category.slug, { ...p.category, items: [] });
      by.get(p.category.slug).items.push(p);
    }
    return [...by.values()];
  }, [data, cat, q]);

  if (error) return <div className="page"><Empty icon="🏪" title="Store not found"><Link to="/">Back to stores</Link></Empty></div>;
  if (!data) return <div className="page center pad"><Spinner /></div>;
  const s = data.store;
  const cats = [...new Map(data.products.map((p) => [p.category.slug, p.category])).values()];

  return (
    <div className="page">
      <section className="store-hero" style={{ background: `linear-gradient(135deg, ${s.accent}, #0f2a1d)` }}>
        <Link to="/" className="back">← Stores</Link>
        <h1>{s.name}</h1>
        <p>{s.description}</p>
        <div className="store-facts">
          {s.rating && <span>★ {s.rating.toFixed(1)} ({s.ratingCount})</span>}
          {s.etaMinutes != null && <span>⏱ {s.etaMinutes}–{s.etaMinutes + 10} min</span>}
          {s.deliveryFeeCents != null && <span>🛵 {rand(s.deliveryFeeCents)}</span>}
          {s.distanceKm != null && <span>📍 {s.distanceKm} km</span>}
          <span>{s.isOpen ? '🟢 Open' : '🔴 Closed'}</span>
        </div>
        {s.delivers === false && <p className="banner warn">This store doesn't deliver to your address. Choose a closer store or change your address.</p>}
      </section>

      <div className="sticky-tools">
        <div className="search-bar compact">
          <span>🔎</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${s.name}`} aria-label="Search this store" />
        </div>
        <div className="chips scroll">
          <button className={`chip ${cat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}>All</button>
          {cats.map((c) => <button key={c.slug} className={`chip ${cat === c.slug ? 'on' : ''}`} onClick={() => setCat(c.slug)}>{c.icon} {c.name}</button>)}
        </div>
      </div>

      {groups.length === 0 ? <Empty icon="🔍" title="No matching products" /> : groups.map((g) => (
        <section key={g.slug}>
          <h2 className="section-title">{g.icon} {g.name}</h2>
          <div className="product-list">{g.items.map((p) => <ProductRow key={p.id} p={p} store={{ ...s, hideName: true }} />)}</div>
        </section>
      ))}

      {data.reviews.length > 0 && (
        <section>
          <h2 className="section-title">What customers say</h2>
          <div className="reviews">
            {data.reviews.map((r, i) => (
              <div key={i} className="review"><strong>{'★'.repeat(r.rating)}</strong> <span className="muted">{r.name}</span>{r.comment && <p>{r.comment}</p>}</div>
            ))}
          </div>
        </section>
      )}

      {count > 0 && cart.store?.id === s.id && (
        <Link to="/checkout" className="float-cart">
          <span className="badge-in">{count}</span> View basket <strong>{rand(subtotal)}</strong>
        </Link>
      )}
    </div>
  );
}
