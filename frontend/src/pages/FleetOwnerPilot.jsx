import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Menu, X, Phone, MessageCircle, ArrowRight } from 'lucide-react';
import Logo from '../components/Logo';
import axios from 'axios';

const WHATSAPP_NUMBER = '27815395612';
const PHONE_DISPLAY   = '+27 81 539 5612';
const PHONE_DIAL      = '+27815395612';

const PROBLEMS = [
  {
    title: 'Chasing payments on WhatsApp',
    text: 'You send a message. They say "tomorrow". Tomorrow comes and you send another one. The bike is still out there making someone else money.',
  },
  {
    title: 'No record of who owes what',
    text: "A spreadsheet, maybe a notebook. Nobody's sure which version is right. A rider disputes a payment and you can't prove either way.",
  },
  {
    title: 'A rider stops paying and disappears',
    text: "You don't know where the bike is. You can't immobilise it. You're chasing R15,000 worth of metal with no leverage.",
  },
];

const STEPS = [
  {
    n: '01',
    title: 'Add your bikes and riders',
    text: 'Upload your fleet and link each bike to a rider. Takes less than five minutes per bike.',
  },
  {
    n: '02',
    title: 'Set the agreement',
    text: 'Choose a weekly payment amount and total weeks. The platform builds the payment schedule automatically.',
  },
  {
    n: '03',
    title: 'Payments collected and tracked automatically',
    text: "Paystack debits the rider's card each week. Funds land in your Fleet Wallet. You see every transaction.",
  },
  {
    n: '04',
    title: 'Falls behind? Immobilise in one tap',
    text: "Open the app, find the bike, tap Immobilise. The bike won't start until the rider is back on track.",
  },
];

const FEATURES = [
  {
    title: 'Fleet dashboard',
    text: "All your bikes, riders, and money in one place. See what's standing, what's moving, and what's overdue.",
  },
  {
    title: 'Rider agreements',
    text: 'Each rider has a digital contract with a start date, weekly amount, and full payment schedule. No more WhatsApp threads.',
  },
  {
    title: 'Automatic payment collection',
    text: 'Set up a Paystack debit once. The weekly payment runs itself — you just watch the money come in.',
  },
  {
    title: 'Remote immobilisation',
    text: "If a rider falls behind, cut the ignition from your phone. The bike won't start until they're up to date.",
  },
  {
    title: 'Payment history per rider',
    text: "See exactly what each rider has paid, what they owe, and when it's due. No guesswork.",
  },
  {
    title: 'Fleet wallet & collections',
    text: "Track your collections, see overdue balances at a glance, and issue payment links directly to riders.",
  },
];

const TIERS = [
  {
    key: 'small',
    name: 'Starter',
    bikes: '1–6 bikes',
    price: 'R200',
    per: '/mo',
    color: '#10b981',
    features: ['Up to 6 bikes', '2 admin users', 'Full platform access', 'Payment collection', 'Remote immobilisation', 'Standard support'],
    cta: 'trial',
  },
  {
    key: 'medium',
    name: 'Growth',
    bikes: '7–20 bikes',
    price: 'R750',
    per: '/mo',
    color: '#3b82f6',
    features: ['Up to 20 bikes', '3 admin users', 'Full platform access', 'Advanced filters', 'Performance reporting', 'Standard support'],
    cta: 'trial',
  },
  {
    key: 'large',
    name: 'Professional',
    bikes: '21–35 bikes',
    price: 'R1 500',
    per: '/mo',
    color: '#8b5cf6',
    features: ['Up to 35 bikes', '5 admin users', 'Full platform access', 'Multi-branch support', 'Priority onboarding', 'Priority support'],
    cta: 'trial',
  },
  {
    key: 'empire',
    name: 'Empire',
    bikes: '36+ bikes',
    price: 'Custom',
    per: '',
    color: '#f59e0b',
    features: ['Unlimited bikes', '20+ admin users', 'Full platform access', 'Dedicated onboarding', 'Custom integrations', 'SLA support'],
    cta: 'contact',
  },
];

export default function FleetOwnerPilot() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [form, setForm] = useState({ name: '', company: '', email: '', phone: '', bikes: '', message: '' });
  const [formState, setFormState] = useState('idle');
  const [formError, setFormError] = useState('');
  const [platformStats, setPlatformStats] = useState(null);

  useEffect(() => {
    document.title = 'OnFleet Fleet — Your riders pay, or the bike doesn\'t start';
    return () => { document.title = 'OnFleet Africa'; };
  }, []);

  useEffect(() => {
    axios.get('/api/pilot/stats').then(r => setPlatformStats(r.data)).catch(() => {});
  }, []);

  function scrollTo(id) {
    return (e) => {
      e.preventDefault();
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
      setMenuOpen(false);
    };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name || !form.company || !form.email || !form.phone) {
      setFormError('Please fill in your name, company, email, and phone number.');
      return;
    }
    if (!form.email.includes('@')) {
      setFormError('Please enter a valid email address.');
      return;
    }
    setFormError('');
    setFormState('busy');
    try {
      await axios.post('/api/pilot/leads', {
        contact_name: form.name,
        company_name: form.company,
        email:        form.email,
        phone:        form.phone,
        fleet_size:   form.bikes ? Number(form.bikes) : undefined,
        notes:        form.message || undefined,
        wants_demo:   true,
        source:       'fleet_landing_page',
      });
      setFormState('success');
    } catch (err) {
      if (err.response?.status === 409) {
        setFormState('success');
      } else {
        setFormError(err.response?.data?.error || 'Something went wrong. Please WhatsApp or call us directly.');
        setFormState('error');
      }
    }
  }

  return (
    <div style={{ background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh' }}>

      {/* ── Navbar ────────────────────────────────────────────────── */}
      <header className="fleet-mkt-nav">
        <Link to="/fleet" className="fleet-mkt-nav-logo" aria-label="OnFleet Fleet">
          <Logo />
          <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Fleet</span>
        </Link>
        <nav className="fleet-mkt-links">
          <a href="#how"     onClick={scrollTo('how')}>How it works</a>
          <a href="#pricing" onClick={scrollTo('pricing')}>Pricing</a>
          <a href="#contact" onClick={scrollTo('contact')}>Book a demo</a>
          <Link to="/fleet/login"  className="btn btn-secondary" style={{ padding: '6px 16px', fontSize: 13 }}>Sign in</Link>
          <Link to="/fleet/signup" className="btn"               style={{ padding: '6px 16px', fontSize: 13 }}>Start free trial</Link>
        </nav>
        <button className="fleet-mkt-hamburger" onClick={() => setMenuOpen(o => !o)} aria-label={menuOpen ? 'Close menu' : 'Open menu'}>
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </header>

      {menuOpen && (
        <div className="fleet-mkt-mobile-menu" role="dialog" aria-modal="true">
          <button className="fleet-mkt-mobile-close" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X size={24} /></button>
          <a href="#how"     onClick={scrollTo('how')}     className="fleet-mkt-mobile-link">How it works</a>
          <a href="#pricing" onClick={scrollTo('pricing')} className="fleet-mkt-mobile-link">Pricing</a>
          <a href="#contact" onClick={scrollTo('contact')} className="fleet-mkt-mobile-link">Book a demo</a>
          <Link to="/fleet/signup" className="btn" style={{ fontSize: 16, padding: '12px 40px' }} onClick={() => setMenuOpen(false)}>Start free trial</Link>
          <Link to="/fleet/login"  className="btn btn-secondary" style={{ fontSize: 16, padding: '12px 40px', marginTop: 8 }} onClick={() => setMenuOpen(false)}>Sign in</Link>
        </div>
      )}

      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section className="fleet-mkt-hero">
        <div className="fleet-mkt-eyebrow">Fleet-owner platform</div>
        <h1 className="fleet-mkt-h1">
          Your riders pay,<br />or the bike doesn't start.
        </h1>
        <p className="fleet-mkt-sub">
          OnFleet lets you manage your bikes, collect rider payments automatically,
          and immobilise any bike that falls behind — from your phone.
        </p>
        <div className="fleet-mkt-hero-cta">
          <Link to="/fleet/signup" className="btn fleet-mkt-cta-primary">
            Start free 14-day trial
          </Link>
          <a href="#contact" onClick={scrollTo('contact')} className="btn btn-secondary fleet-mkt-cta-secondary">
            Book a demo
          </a>
        </div>
        <div className="muted text-xs" style={{ marginTop: 10 }}>
          No card required · Takes 2 minutes ·{' '}
          <Link to="/fleet/login" style={{ color: 'inherit' }}>Already have an account? Sign in</Link>
        </div>
      </section>

      {/* ── Problems ──────────────────────────────────────────────── */}
      <section className="fleet-mkt-section">
        <h2 className="fleet-mkt-section-title">Sound familiar?</h2>
        <p className="fleet-mkt-section-sub">Most fleet owners deal with the same three problems.</p>
        <div className="grid grid-3 fleet-mkt-grid">
          {PROBLEMS.map((p) => (
            <div key={p.title} className="card fleet-mkt-problem-card">
              <h3 style={{ marginBottom: 10, fontSize: 16 }}>{p.title}</h3>
              <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.65, margin: 0 }}>{p.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────────── */}
      <section id="how" className="fleet-mkt-section fleet-mkt-section-alt">
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <h2 className="fleet-mkt-section-title">How it works</h2>
          <div className="grid grid-2 fleet-mkt-grid">
            {STEPS.map((s) => (
              <div key={s.n} style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
                <div className="fleet-mkt-step-num">{s.n}</div>
                <div>
                  <h3 style={{ marginBottom: 8, fontSize: 17 }}>{s.title}</h3>
                  <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.65, margin: 0 }}>{s.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ──────────────────────────────────────────────── */}
      <section className="fleet-mkt-section">
        <h2 className="fleet-mkt-section-title">What you get</h2>
        <p className="fleet-mkt-section-sub">Everything you need to run a paying fleet — on every plan.</p>
        <div className="grid grid-3 fleet-mkt-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="card">
              <h3 style={{ marginBottom: 8, fontSize: 15 }}>{f.title}</h3>
              <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.65, margin: 0 }}>{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Proof strip ───────────────────────────────────────────── */}
      <section className="fleet-mkt-proof">
        {[
          {
            value: platformStats ? `${platformStats.bikes} bikes` : '— bikes',
            label: 'On the platform'
          },
          {
            value: platformStats
              ? `R${platformStats.collected >= 1000000
                  ? (platformStats.collected / 1000000).toFixed(1) + 'm'
                  : platformStats.collected >= 1000
                    ? Math.round(platformStats.collected / 1000) + 'k'
                    : platformStats.collected.toLocaleString()}`
              : 'R—',
            label: 'Collected for fleet owners'
          },
          {
            value: platformStats?.recovered_pct != null ? `${platformStats.recovered_pct}%` : '—%',
            label: 'Defaults recovered via immobilisation'
          },
        ].map((s) => (
          <div key={s.label} className="fleet-mkt-proof-stat">
            <div className="fleet-mkt-proof-value">{s.value}</div>
            <div className="fleet-mkt-proof-label">{s.label}</div>
          </div>
        ))}
      </section>

      {/* ── Pricing ───────────────────────────────────────────────── */}
      <section id="pricing" className="fleet-mkt-section fleet-mkt-section-alt">
        <h2 className="fleet-mkt-section-title">Pricing</h2>
        <p className="fleet-mkt-section-sub">Flat monthly plans. No per-bike charges, no surprises.</p>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: 16,
          maxWidth: 960,
          margin: '0 auto 20px',
        }}>
          {TIERS.map((tier) => (
            <div key={tier.key} className="card" style={{
              display: 'flex', flexDirection: 'column', gap: 14,
              borderColor: tier.key === 'large' ? 'rgba(139,92,246,0.4)' : undefined,
              boxShadow: tier.key === 'large' ? '0 0 0 1px rgba(139,92,246,0.2)' : undefined,
              position: 'relative',
            }}>
              {tier.key === 'large' && (
                <div style={{
                  position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
                  background: '#8b5cf6', color: '#fff',
                  fontSize: 10, fontWeight: 700, padding: '2px 12px', borderRadius: 20,
                  letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap'
                }}>Most popular</div>
              )}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: tier.color, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
                  {tier.name}
                </div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>{tier.bikes}</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--primary-light)', lineHeight: 1 }}>
                  {tier.price}
                  {tier.per && <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--muted)' }}>{tier.per}</span>}
                </div>
              </div>
              <ul style={{ listStyle: 'none', display: 'grid', gap: 7, flex: 1, margin: 0, padding: 0 }}>
                {tier.features.map((f) => (
                  <li key={f} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                    <CheckCircle2 size={13} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 2 }} />
                    {f}
                  </li>
                ))}
              </ul>
              {tier.cta === 'contact' ? (
                <a
                  href={`https://wa.me/${WHATSAPP_NUMBER}?text=Hi%2C+I'm+interested+in+the+Empire+fleet+plan`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary btn-sm"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                >
                  Contact us for a quote
                </a>
              ) : (
                <Link
                  to="/fleet/signup"
                  className="btn btn-sm"
                  style={{
                    background: tier.color, borderColor: tier.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                  }}
                >
                  Start free trial <ArrowRight size={13} />
                </Link>
              )}
            </div>
          ))}
        </div>

        <div style={{ textAlign: 'center', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ fontWeight: 600, color: 'var(--success)', fontSize: 15, marginBottom: 6 }}>
            All plans include a 14-day free trial — no card required.
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            Start on any plan, cancel any time. Billing via Paystack — your card is only charged after the trial ends.
          </div>
        </div>
      </section>

      {/* ── Contact / Demo form ───────────────────────────────────── */}
      <section id="contact" className="fleet-mkt-section">
        <div style={{ maxWidth: 840, margin: '0 auto' }}>
          <h2 className="fleet-mkt-section-title" style={{ textAlign: 'left' }}>Book a demo</h2>
          <p style={{ color: 'var(--muted)', marginBottom: 36, fontSize: 15, lineHeight: 1.65, maxWidth: 520 }}>
            Fill in the form and we'll call you back. We also do in-person demos at
            our Kya Sand workshop — bring your list of bikes and we'll set you up on the spot.
          </p>

          <div className="fleet-mkt-contact-grid">
            <div>
              {formState === 'success' ? (
                <div className="card" style={{ textAlign: 'center', padding: 40 }}>
                  <CheckCircle2 size={40} style={{ color: 'var(--success)', margin: '0 auto 16px', display: 'block' }} />
                  <h3 style={{ marginBottom: 8 }}>We'll be in touch</h3>
                  <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 24 }}>
                    Expect a call within one business day. Check your email for a confirmation.
                  </p>
                  <a
                    href={`https://wa.me/${WHATSAPP_NUMBER}?text=Hi%2C%20I%20just%20submitted%20a%20demo%20request%20for%20OnFleet%20Fleet.`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-block"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#25D366', border: 'none', textDecoration: 'none' }}
                  >
                    <MessageCircle size={18} /> Chat on WhatsApp now
                  </a>
                </div>
              ) : (
                <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div className="field">
                    <label className="label" htmlFor="fm-name">Your name <span style={{ color: 'var(--danger)' }}>*</span></label>
                    <input id="fm-name" className="input" placeholder="Sipho Dlamini"
                      value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="fm-company">Company <span style={{ color: 'var(--danger)' }}>*</span></label>
                    <input id="fm-company" className="input" placeholder="Dlamini Fleet Pty Ltd"
                      value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="fm-email">Email address <span style={{ color: 'var(--danger)' }}>*</span></label>
                    <input id="fm-email" className="input" type="email" placeholder="sipho@dlaminifleet.co.za"
                      value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="fm-phone">Phone number <span style={{ color: 'var(--danger)' }}>*</span></label>
                    <input id="fm-phone" className="input" type="tel" placeholder="+27 82 000 0000"
                      value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="fm-bikes">How many bikes do you have?</label>
                    <input id="fm-bikes" className="input" type="number" min="1" max="1000" placeholder="e.g. 8"
                      value={form.bikes} onChange={e => setForm(f => ({ ...f, bikes: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="fm-message">Anything else we should know?</label>
                    <textarea id="fm-message" className="input"
                      placeholder="e.g. We run Hondas in Soweto and Midrand, looking to move off spreadsheets"
                      value={form.message} onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                      style={{ resize: 'vertical', minHeight: 80 }} />
                  </div>
                  {formError && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{formError}</div>}
                  <button type="submit" className="btn btn-block" disabled={formState === 'busy'}>
                    {formState === 'busy' ? 'Sending…' : 'Send request'}
                  </button>
                </form>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="card">
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  <MessageCircle size={22} style={{ color: '#25D366', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>WhatsApp us</div>
                    <a href={`https://wa.me/${WHATSAPP_NUMBER}`} style={{ color: 'var(--primary-light)', fontSize: 14, textDecoration: 'none' }}>
                      +{WHATSAPP_NUMBER}
                    </a>
                    <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>Quickest response during business hours.</div>
                  </div>
                </div>
              </div>

              <div className="card">
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  <Phone size={22} style={{ color: 'var(--primary-light)', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>Call us</div>
                    <a href={`tel:${PHONE_DIAL}`} style={{ color: 'var(--primary-light)', fontSize: 14, textDecoration: 'none' }}>
                      {PHONE_DISPLAY}
                    </a>
                    <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>Monday–Friday, 8am–5pm.</div>
                  </div>
                </div>
              </div>

              <div className="card" style={{ background: 'rgba(30,136,209,0.07)', border: '1px solid rgba(30,136,209,0.2)' }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>In-person demo</div>
                <div style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.65 }}>
                  Kya Sand, Johannesburg.<br />
                  Bring your list of bikes. We'll get you set up on the spot.
                </div>
              </div>

              <div className="card" style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)' }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Ready to start now?</div>
                <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
                  Skip the demo — create your account and start your free 14-day trial immediately.
                </div>
                <Link to="/fleet/signup" className="btn btn-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  Start free trial <ArrowRight size={13} />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────── */}
      <footer className="fleet-mkt-footer">
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>OnFleet Africa</div>
          <div>Kya Sand, Johannesburg</div>
        </div>
        <div className="fleet-mkt-footer-links">
          <Link to="/fleet/signup">Start free trial</Link>
          <Link to="/fleet/login">Sign in</Link>
          <Link to="/privacy">Privacy policy</Link>
          <Link to="/terms">Terms</Link>
        </div>
      </footer>

    </div>
  );
}
