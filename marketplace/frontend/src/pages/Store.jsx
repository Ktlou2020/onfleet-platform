import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Empty, Spinner, api, rand, useCart, useLoc, useMeta } from '../lib.jsx';
import { Heart, ProductRow } from './Home.jsx';

export default function Store() {
  const { slug } = useParams();
  const { loc } = useLoc();
  const { cart, count, subtotal } = useCart();
  const meta = useMeta();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');

  useEffect(() => {
    const p = loc ? `?lat=${loc.lat}&lng=${loc.lng}` : '';
    api(`/stores/${slug}${p}`).then(setData).catch((e) => setError(e.message));
  }, [slug, loc]);

  // Sizes and flavours sit on their main product's card.
  const families = useMemo(() => {
    if (!data) return [];
    const byRoot = new Map();
    for (const p of data.products) {
      const root = p.variantOf || p.id;
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(p);
    }
    return [...byRoot.values()].map((list) => {
      const main = list.find((p) => !p.variantOf) || list[0];
      return { main, options: [main, ...list.filter((p) => p !== main)] };
    });
  }, [data]);

  const groups = useMemo(() => {
    const by = new Map();
    for (const f of families) {
      const p = f.main;
      if (cat !== 'all' && p.category.slug !== cat) continue;
      if (q && !f.options.some((o) => `${o.name} ${o.description} ${o.variantLabel || ''}`.toLowerCase().includes(q.toLowerCase()))) continue;
      if (!by.has(p.category.slug)) by.set(p.category.slug, { ...p.category, items: [] });
      by.get(p.category.slug).items.push(f);
    }
    return [...by.values()];
  }, [families, cat, q]);
  const picks = families.filter((f) => f.options.some((o) => o.featured));

  if (error) return <div className="page"><Empty icon="🏪" title="Store not found"><Link to="/">Back to stores</Link></Empty></div>;
  if (!data) return <div className="page center pad"><Spinner /></div>;
  const s = data.store;
  const cats = [...new Map(data.products.map((p) => [p.category.slug, p.category])).values()];

  return (
    <div className="page">
      <section className="store-hero" style={{ background: `linear-gradient(135deg, ${s.accent}, #0f2a1d)` }}>
        <Link to="/" className="back">← Stores</Link>
        <div className="row-between"><h1>{s.name}</h1><Heart storeId={s.id} name={s.name} className="on-hero" /></div>
        <p>{s.description}</p>
        <div className="store-facts">
          {s.rating && <span>★ {s.rating.toFixed(1)} ({s.ratingCount})</span>}
          {s.etaMinutes != null && <span>⏱ {s.etaMinutes}–{s.etaMinutes + 10} min</span>}
          {s.deliveryFeeCents != null && <span>🛵 {rand(s.deliveryFeeCents)}</span>}
          {s.distanceKm != null && <span>📍 {s.distanceKm} km</span>}
          <span>{s.isOpen ? `🟢 ${s.openLabel || 'Open'}` : `🔴 ${s.openLabel || 'Closed'}`}</span>
        </div>
        {s.delivers === false && <p className="banner warn">This store doesn't deliver to your address. Choose a closer store or change your address.</p>}
        {s.preorder && <p className="banner">🕘 {s.name} {s.openLabel.replace('Opens', 'opens')}. Order now and we'll deliver when it opens.</p>}
        {!s.preorder && s.isOpen && meta && !meta.deliveryHours.openNow && <p className="banner">🌙 Deliveries start at {meta.deliveryHours.open}:00. Order now and we'll deliver then.</p>}
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

      {data.promos?.map((p) => (
        <div key={p.code} className="promo-banner">🏷️ <span>Use <code>{p.code}</code> at checkout — {p.description}</span></div>
      ))}
      {cat === 'all' && !q && picks.length > 0 && (
        <section>
          <h2 className="section-title">⭐ Store picks</h2>
          <div className="product-list">{picks.map((f) => <ProductRow key={`pick-${f.main.id}`} p={f.main} options={f.options} store={{ ...s, hideName: true }} />)}</div>
        </section>
      )}
      {groups.length === 0 ? <Empty icon="🔍" title="No matching products" /> : groups.map((g) => (
        <section key={g.slug}>
          <h2 className="section-title">{g.icon} {g.name}</h2>
          <div className="product-list">{g.items.map((f) => <ProductRow key={f.main.id} p={f.main} options={f.options} store={{ ...s, hideName: true }} />)}</div>
        </section>
      ))}

      {data.reviews.length > 0 && (
        <section>
          <h2 className="section-title">What customers say</h2>
          <div className="reviews">
            {data.reviews.map((r, i) => (
              <div key={i} className="review"><strong>{'★'.repeat(r.rating)}</strong> <span className="muted">{r.name}</span>{r.comment && <p>{r.comment}</p>}{r.reply && <p className="muted small">↳ <b>{s.name}:</b> {r.reply}</p>}</div>
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
