import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import api from '../api';
import Logo from '../components/Logo';
import { fmt } from '../components/ui';
import { Bike, ShieldCheck, Wrench, MapPin, Zap, CreditCard, Menu, X, CheckCircle2 } from 'lucide-react';

export default function Landing() {
  const [bikes, setBikes] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    api.get('/bikes/catalog').then((r) => setBikes(r.data.bikes)).catch(() => {});
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 900) setMenuOpen(false);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);

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
          <Link to="/login" onClick={closeMenu}>Sign in</Link>
          <Link to="/signup" className="btn" onClick={closeMenu}>Apply now</Link>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="hero-pill"><CheckCircle2 size={14} /> No deposit · Monthly service included</div>
          <h1>Ride. Earn. <span>Own.</span></h1>
          <p>Africa&apos;s smartest rent-to-own platform for delivery riders. No deposit, free monthly servicing, and full ownership of a brand-new motorbike in just 18 months.</p>
          <div className="hero-cta">
            <Link to="/signup" className="btn hero-cta-btn">Start your application</Link>
            <a href="#how" className="btn btn-secondary hero-cta-btn">How it works</a>
          </div>
          <div className="hero-metrics">
            <div className="hero-metric">
              <div className="text-2xl font-bold" style={{ color: 'var(--primary-light)' }}>R850</div>
              <div className="muted text-sm">per week</div>
            </div>
            <div className="hero-metric">
              <div className="text-2xl font-bold" style={{ color: 'var(--primary-light)' }}>18</div>
              <div className="muted text-sm">months to own</div>
            </div>
            <div className="hero-metric">
              <div className="text-2xl font-bold" style={{ color: 'var(--primary-light)' }}>R0</div>
              <div className="muted text-sm">deposit</div>
            </div>
          </div>
          <div className="hero-trust-list">
            <div className="hero-trust-item"><ShieldCheck size={16} /> Fast approval flow</div>
            <div className="hero-trust-item"><Wrench size={16} /> Free monthly servicing</div>
            <div className="hero-trust-item"><MapPin size={16} /> Built for South African delivery work</div>
          </div>
        </div>
        <div className="hero-visual-wrap">
          <div className="hero-art" />
          <div className="hero-floating-card">
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
              <div style={{ width: 44, height: 44, borderRadius: 10, background: 'rgba(30,136,209,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary-light)', marginBottom: 12 }}>{s.i}</div>
              <div className="muted text-xs mb-2">STEP {s.n}</div>
              <h3>{s.t}</h3>
              <div className="muted text-sm mt-2">{s.d}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="bikes" className="section">
        <div className="section-head">
          <h2>Available bikes</h2>
          <div className="sub">Built for the South African hustle. Engineered to endure.</div>
        </div>
        <div className="bike-grid">
          {bikes.length ? bikes.map((b) => (
            <div key={b.id} className="bike-card">
              <div className="img" style={{ backgroundImage: b.image_url ? `url("${b.image_url}")` : 'none' }} />
              <div className="body">
                <div className="flex-between bike-card-header">
                  <h3>{b.make} {b.model}</h3>
                  <span className="badge badge-info">{b.condition}</span>
                </div>
                <div className="muted text-sm mt-1">{b.engine_cc}cc · {b.year || 'New'}</div>
                <div className="flex-between mt-4 bike-card-footer">
                  <div>
                    <div className="price">{fmt(b.rental_weekly)}<span className="muted text-sm">/week</span></div>
                    <div className="muted text-xs">{b.total_weeks} weeks to own</div>
                  </div>
                  <Link to="/signup" className="btn btn-sm bike-card-action">Apply</Link>
                </div>
              </div>
            </div>
          )) : <div className="card muted">Loading bikes…</div>}
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
              <div style={{ color: 'var(--primary-light)', marginBottom: 10 }}>{x.i}</div>
              <h3>{x.t}</h3>
              <div className="muted text-sm mt-2">{x.d}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="section landing-final-cta">
        <h2>Ready to own your bike?</h2>
        <div className="sub">Join thousands of South African riders earning more, every day.</div>
        <Link to="/signup" className="btn landing-final-cta-btn">Apply now — it&apos;s free</Link>
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
