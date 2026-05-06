import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import api from '../api';
import Logo from '../components/Logo';
import { fmt } from '../components/ui';
import { Bike, ShieldCheck, Wrench, MapPin, Zap, CreditCard } from 'lucide-react';

export default function Landing() {
  const [bikes, setBikes] = useState([]);
  useEffect(() => { api.get('/bikes/catalog').then(r => setBikes(r.data.bikes)).catch(() => {}); }, []);

  return (
    <div className="landing">
      <header className="navbar">
        <Logo />
        <nav>
          <a href="#how">How it works</a>
          <a href="#bikes">Bikes</a>
          <a href="#why">Why us</a>
          <Link to="/login">Sign in</Link>
          <Link to="/signup" className="btn">Apply now</Link>
        </nav>
      </header>

      <section className="hero">
        <div>
          <h1>Ride. Earn. <span>Own.</span></h1>
          <p>Africa's smartest rent-to-own platform for delivery riders. No deposit, free monthly servicing, and full ownership of a brand-new motorbike in just 18 months.</p>
          <div className="hero-cta">
            <Link to="/signup" className="btn">Start your application</Link>
            <a href="#how" className="btn btn-secondary">How it works</a>
          </div>
          <div style={{ marginTop: 32, display: 'flex', gap: 32 }}>
            <div><div className="text-2xl font-bold" style={{ color: 'var(--primary-light)' }}>R850</div><div className="muted text-sm">per week</div></div>
            <div><div className="text-2xl font-bold" style={{ color: 'var(--primary-light)' }}>18</div><div className="muted text-sm">months to own</div></div>
            <div><div className="text-2xl font-bold" style={{ color: 'var(--primary-light)' }}>R0</div><div className="muted text-sm">deposit</div></div>
          </div>
        </div>
        <div className="hero-art" />
      </section>

      <section id="how" className="section" style={{ background: 'var(--surface)' }}>
        <h2>How it works</h2>
        <div className="sub">Four simple steps from application to ownership</div>
        <div className="grid grid-4">
          {[
            { n: '1', t: 'Apply online', d: 'Sign up, upload your ID and proof of address. Takes 5 minutes.', i: <Bike /> },
            { n: '2', t: 'Get approved', d: 'Our team reviews your application within 48 hours.', i: <ShieldCheck /> },
            { n: '3', t: 'Collect your bike', d: 'Sign the rent-to-own agreement and ride off the same day.', i: <Zap /> },
            { n: '4', t: 'Own it in 18 months', d: 'Pay R850 weekly. Free monthly service. Full ownership at the end.', i: <CreditCard /> }
          ].map(s => (
            <div className="card" key={s.n}>
              <div style={{ width: 44, height: 44, borderRadius: 10, background: 'rgba(30,136,209,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary-light)', marginBottom: 12 }}>{s.i}</div>
              <div className="muted text-xs mb-2">STEP {s.n}</div>
              <h3>{s.t}</h3>
              <div className="muted text-sm mt-2">{s.d}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="bikes" className="section">
        <h2>Available bikes</h2>
        <div className="sub">Built for the South African hustle. Engineered to endure.</div>
        <div className="bike-grid">
          {bikes.length ? bikes.map(b => (
            <div key={b.id} className="bike-card">
              <div className="img" style={{ backgroundImage: b.image_url ? `url("${b.image_url}")` : 'none' }} />
              <div className="body">
                <div className="flex-between">
                  <h3>{b.make} {b.model}</h3>
                  <span className="badge badge-info">{b.condition}</span>
                </div>
                <div className="muted text-sm mt-1">{b.engine_cc}cc · {b.year || 'New'}</div>
                <div className="flex-between mt-4">
                  <div>
                    <div className="price">{fmt(b.rental_weekly)}<span className="muted text-sm">/week</span></div>
                    <div className="muted text-xs">{b.total_weeks} weeks to own</div>
                  </div>
                  <Link to="/signup" className="btn btn-sm">Apply</Link>
                </div>
              </div>
            </div>
          )) : <div className="muted">Loading bikes…</div>}
        </div>
      </section>

      <section id="why" className="section" style={{ background: 'var(--surface)' }}>
        <h2>Why OnFleet</h2>
        <div className="sub">More than a rental — your partner to ownership</div>
        <div className="grid grid-3">
          {[
            { i: <Wrench />, t: 'Free monthly service', d: 'Every bike is serviced free of charge every month while on agreement.' },
            { i: <MapPin />, t: 'GPS tracking', d: 'Every bike comes with GPS so you and we can keep your asset safe.' },
            { i: <ShieldCheck />, t: 'Insurance included', d: 'Comprehensive insurance is built into your weekly fee. No surprises.' },
            { i: <CreditCard />, t: 'Pay weekly in-app', d: 'Pay via Paystack, EFT or cash. Track every cent in real-time.' },
            { i: <Zap />, t: 'WhatsApp reminders', d: 'Never miss a payment with friendly automated reminders.' },
            { i: <Bike />, t: 'Real ownership', d: 'After 78 weekly payments, the bike is fully yours. No balloon payments.' }
          ].map((x, i) => (
            <div className="card" key={i}>
              <div style={{ color: 'var(--primary-light)', marginBottom: 10 }}>{x.i}</div>
              <h3>{x.t}</h3>
              <div className="muted text-sm mt-2">{x.d}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="section" style={{ textAlign: 'center' }}>
        <h2>Ready to own your bike?</h2>
        <div className="sub">Join thousands of South African riders earning more, every day.</div>
        <Link to="/signup" className="btn">Apply now — it's free</Link>
      </section>

      <footer className="footer">
        <Logo />
        <div className="mt-3">© {new Date().getFullYear()} OnFleet Africa · Johannesburg, South Africa · WhatsApp 081 539 5612</div>
      </footer>
    </div>
  );
}
