import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import api from '../api';
import Logo from '../components/Logo';
import { fmt } from '../components/ui';
import { Bike, ShieldCheck, Wrench, MapPin, Zap, CreditCard, Menu, X, CheckCircle2, ArrowRight } from 'lucide-react';

const EMPTY_FILTERS = { make: '', model: '', condition: '' };
const MONTHS_PER_WEEK = 12 / 52;

function formatWeeksToMonths(totalWeeks) {
  const weeks = Number(totalWeeks || 0);
  if (!weeks) return 'Flexible term';
  const months = weeks * MONTHS_PER_WEEK;
  const roundedMonths = Number.isInteger(months) ? String(months) : months.toFixed(1).replace(/\.0$/, '');
  return `${roundedMonths} month${Number(roundedMonths) === 1 ? '' : 's'} (${weeks} week${weeks === 1 ? '' : 's'})`;
}

const METRICS = [
  { value: 'R850', label: 'per week', highlight: true },
  { value: '18', label: 'months to own', highlight: true },
  { value: 'R0', label: 'deposit', highlight: true },
];

const TRUST_ITEMS = [
  { icon: <ShieldCheck size={15} />, label: 'Fast approval flow' },
  { icon: <Wrench size={15} />, label: 'Free monthly servicing' },
  { icon: <MapPin size={15} />, label: 'Built for South African delivery work' },
];

export default function Landing() {
  const [bikes, setBikes] = useState([]);
  const [catalogFilters, setCatalogFilters] = useState({ makes: [], models: [], conditions: [] });
  const [bikeFilters, setBikeFilters] = useState(EMPTY_FILTERS);
  const [bikesLoading, setBikesLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [heroImageUrl, setHeroImageUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    setBikesLoading(true);

    api.get('/bikes/catalog', { params: bikeFilters })
      .then((r) => {
        if (cancelled) return;
        setBikes(Array.isArray(r.data?.bikes) ? r.data.bikes : []);
        setCatalogFilters({
          makes: Array.isArray(r.data?.filters?.makes) ? r.data.filters.makes : [],
          models: Array.isArray(r.data?.filters?.models) ? r.data.filters.models : [],
          conditions: Array.isArray(r.data?.filters?.conditions) ? r.data.filters.conditions : []
        });
        setHeroImageUrl(r.data?.hero_image_url || '');
      })
      .catch(() => {
        if (cancelled) return;
        setBikes([]);
        setCatalogFilters({ makes: [], models: [], conditions: [] });
        setHeroImageUrl('');
      })
      .finally(() => {
        if (!cancelled) setBikesLoading(false);
      });

    return () => { cancelled = true; };
  }, [bikeFilters.make, bikeFilters.model, bikeFilters.condition]);

  useEffect(() => {
    const handleResize = () => { if (window.innerWidth > 900) setMenuOpen(false); };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);
  const hasActiveFilters = Boolean(bikeFilters.make || bikeFilters.model || bikeFilters.condition);

  const updateFilter = (key, value) => {
    setBikeFilters((prev) => {
      if (key === 'make') return { ...prev, make: value, model: '' };
      return { ...prev, [key]: value };
    });
  };

  const resetFilters = () => setBikeFilters(EMPTY_FILTERS);

  return (
    <div className="landing">
      <header className="navbar landing-navbar">
        <Logo />
        <button className="nav-toggle" onClick={() => setMenuOpen((prev) => !prev)} aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen}>
          {menuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        <nav className={`landing-nav ${menuOpen ? 'open' : ''}`}>
          <a href="#how" onClick={closeMenu}>How it works</a>
          <a href="#bikes" onClick={closeMenu}>Bikes</a>
          <a href="#why" onClick={closeMenu}>Why us</a>
          <Link to="/fleet" onClick={closeMenu}>Fleet owners</Link>
          <Link to="/login" onClick={closeMenu}>Sign in</Link>
          <Link to="/signup" className="btn" onClick={closeMenu}>Apply now</Link>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="hero-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, border: '1px solid rgba(249,115,22,0.35)', background: 'rgba(249,115,22,0.10)', padding: '6px 14px', color: '#fdba74', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
            <CheckCircle2 size={14} style={{ color: '#f97316' }} /> No deposit · Monthly service included
          </div>

          <h1 style={{ lineHeight: 1.08 }}>
            Ride. Earn.{' '}
            <span style={{
              background: 'linear-gradient(135deg, #f97316 0%, #fbbf24 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text'
            }}>
              Own.
            </span>
          </h1>

          <p>Africa&apos;s smartest rent-to-own platform for delivery riders. No deposit, free monthly servicing, and full ownership of a brand-new motorbike in just 18 months.</p>

          <div className="hero-cta">
            <Link
              to="/signup"
              className="btn hero-cta-btn"
              style={{ boxShadow: '0 8px 32px rgba(249,115,22,0.35)', display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              Start your application
              <ArrowRight size={16} />
            </Link>
            <a href="#how" className="btn btn-secondary hero-cta-btn">How it works</a>
          </div>

          <div className="hero-metrics" style={{ display: 'flex', gap: 28, marginTop: 28 }}>
            {METRICS.map((m) => (
              <div key={m.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontSize: '2rem', fontWeight: 800, lineHeight: 1, background: 'linear-gradient(135deg, #f97316, #fbbf24)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
                  {m.value}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>{m.label}</div>
              </div>
            ))}
          </div>

          <div className="hero-trust-list" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 20 }}>
            {TRUST_ITEMS.map((t) => (
              <div
                key={t.label}
                className="hero-trust-item"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)', padding: '5px 12px', fontSize: 12 }}
              >
                <span style={{ color: '#2dd4bf' }}>{t.icon}</span>
                {t.label}
              </div>
            ))}
          </div>
        </div>

        <div className="hero-visual-wrap">
          <div className="hero-art" style={heroImageUrl ? { backgroundImage: `url("${heroImageUrl}")` } : undefined} />
          <div className="hero-floating-card" style={{ borderRadius: 20, border: '1px solid rgba(249,115,22,0.2)', boxShadow: '0 8px 40px rgba(0,0,0,0.25)' }}>
            <div className="badge badge-info">Popular rider plan</div>
            <strong>Own your bike after 78 weekly payments</strong>
            <div className="muted text-sm">Track payments, service bookings, location and ownership progress from your rider dashboard.</div>
          </div>
        </div>
      </section>

      <section id="how" className="section" style={{ background: 'var(--surface)' }}>
        <div className="section-head">
          <h2>How it works</h2>
          <div className="sub">Four simple steps from application to ownership</div>
        </div>
        <div className="grid grid-4">
          {[
            { n: '1', t: 'Apply online', d: 'Sign up, upload your ID and proof of address. Takes 5 minutes.', i: <Bike /> },
            { n: '2', t: 'Get approved', d: 'Our team reviews your application within 48 hours.', i: <ShieldCheck /> },
            { n: '3', t: 'Collect your bike', d: 'Sign the rent-to-own agreement and ride off the same day.', i: <Zap /> },
            { n: '4', t: 'Own it in 18 months', d: 'Pay R850 weekly. Free monthly service. Full ownership at the end.', i: <CreditCard /> }
          ].map((s) => (
            <div className="card landing-step-card" key={s.n}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(249,115,22,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f97316', marginBottom: 14 }}>{s.i}</div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#f97316', marginBottom: 6 }}>Step {s.n}</div>
              <h3 style={{ marginBottom: 6 }}>{s.t}</h3>
              <div className="muted text-sm">{s.d}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="bikes" className="section">
        <div className="section-head">
          <h2>Available bikes</h2>
          <div className="sub">Only bikes marked Ready to go appear here. Filter the fleet by make, model, and condition.</div>
        </div>

        <div className="landing-filter-bar card">
          <div className="landing-filter-copy">
            <strong>{bikesLoading ? 'Loading ready-to-go bikes…' : `${bikes.length} ready-to-go bike${bikes.length === 1 ? '' : 's'} available`}</strong>
            <div className="muted text-sm">Browse what is immediately available on the homepage before starting your application.</div>
          </div>
          <div className="landing-filter-controls">
            <div className="landing-filter-field">
              <label htmlFor="bike-filter-make" className="label">Make</label>
              <select id="bike-filter-make" value={bikeFilters.make} onChange={(e) => updateFilter('make', e.target.value)}>
                <option value="">All makes</option>
                {catalogFilters.makes.map((make) => <option key={make} value={make}>{make}</option>)}
              </select>
            </div>
            <div className="landing-filter-field">
              <label htmlFor="bike-filter-model" className="label">Model</label>
              <select id="bike-filter-model" value={bikeFilters.model} onChange={(e) => updateFilter('model', e.target.value)}>
                <option value="">All models</option>
                {catalogFilters.models.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            </div>
            <div className="landing-filter-field">
              <label htmlFor="bike-filter-condition" className="label">Condition</label>
              <select id="bike-filter-condition" value={bikeFilters.condition} onChange={(e) => updateFilter('condition', e.target.value)}>
                <option value="">All conditions</option>
                {catalogFilters.conditions.map((condition) => <option key={condition} value={condition}>{condition}</option>)}
              </select>
            </div>
            <button type="button" className="btn btn-secondary landing-filter-reset" onClick={resetFilters} disabled={!hasActiveFilters}>
              Clear filters
            </button>
          </div>
        </div>

        <div className="bike-grid">
          {bikesLoading ? <div className="card muted">Loading bikes…</div> : null}
          {!bikesLoading && bikes.length ? bikes.map((b) => (
            <div key={b.id} className="bike-card">
              <div className="img" style={{ backgroundImage: b.image_url ? `url("${b.image_url}")` : 'none' }} />
              <div className="body">
                <div className="flex-between bike-card-header">
                  <h3>{b.make} {b.model}</h3>
                  <span className="badge badge-info">{b.condition}</span>
                </div>
                <div className="bike-card-meta-row mt-2">
                  <span className="badge badge-success">Ready to go</span>
                  <span className="muted text-sm">{b.engine_cc}cc · {b.year || 'New'}</span>
                </div>
                <div className="flex-between mt-4 bike-card-footer">
                  <div>
                    <div className="price">{fmt(b.rental_weekly)}<span className="muted text-sm">/week</span></div>
                    <div className="muted text-xs">{formatWeeksToMonths(b.total_weeks)} to own</div>
                  </div>
                  <Link to="/signup" className="btn btn-sm bike-card-action" style={{ boxShadow: '0 4px 16px rgba(249,115,22,0.28)' }}>Apply</Link>
                </div>
              </div>
            </div>
          )) : null}
          {!bikesLoading && !bikes.length ? (
            <div className="card muted">No ready-to-go bikes match the selected filters right now.</div>
          ) : null}
        </div>
      </section>

      <section id="why" className="section" style={{ background: 'var(--surface)' }}>
        <div className="section-head">
          <h2>Why OnFleet</h2>
          <div className="sub">More than a rental — your partner to ownership</div>
        </div>
        <div className="grid grid-3">
          {[
            { i: <Wrench />, t: 'Free monthly service', d: 'Every bike is serviced free of charge every month while on agreement.' },
            { i: <MapPin />, t: 'GPS tracking', d: 'Every bike comes with GPS so you and we can keep your asset safe.' },
            { i: <ShieldCheck />, t: 'Insurance included', d: 'Comprehensive insurance is built into your weekly fee. No surprises.' },
            { i: <CreditCard />, t: 'Pay weekly in-app', d: 'Pay via Paystack, EFT or cash. Track every cent in real-time.' },
            { i: <Zap />, t: 'WhatsApp reminders', d: 'Never miss a payment with friendly automated reminders.' },
            { i: <Bike />, t: 'Real ownership', d: 'After 78 weekly payments, the bike is fully yours. No balloon payments.' }
          ].map((x, i) => (
            <div className="card landing-benefit-card" key={i}>
              <div style={{ color: '#f97316', marginBottom: 10, padding: '10px 0 0' }}>{x.i}</div>
              <h3>{x.t}</h3>
              <div className="muted text-sm mt-2">{x.d}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="section landing-final-cta">
        <h2>Ready to own your bike?</h2>
        <div className="sub">Join thousands of South African riders earning more, every day.</div>
        <div className="hero-cta" style={{ justifyContent: 'center' }}>
          <Link
            to="/signup"
            className="btn landing-final-cta-btn"
            style={{ boxShadow: '0 8px 32px rgba(249,115,22,0.35)', display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            Apply now — it&apos;s free
            <ArrowRight size={16} />
          </Link>
          <Link to="/fleet" className="btn btn-secondary landing-final-cta-btn">Fleet owners</Link>
        </div>
      </section>

      <footer className="footer landing-footer">
        <Logo />
        <div className="mt-3">© {new Date().getFullYear()} OnFleet Africa · Johannesburg, South Africa · WhatsApp 081 539 5612</div>
      </footer>

      <div className="mobile-cta-bar">
        <Link to="/login" className="btn btn-secondary btn-sm">Sign in</Link>
        <Link to="/signup" className="btn btn-sm">Apply now</Link>
      </div>
    </div>
  );
}
