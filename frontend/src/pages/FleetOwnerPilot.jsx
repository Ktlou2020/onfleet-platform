import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Menu, X, Phone, MessageCircle } from 'lucide-react';
import Logo from '../components/Logo';
import axios from 'axios';

// TODO: Replace these with real contact details before going live
const WHATSAPP_NUMBER = 'FILL_IN_WHATSAPP'; // e.g. 27821234567 (no + or spaces)
const PHONE_DISPLAY   = 'FILL_IN_PHONE';    // e.g. +27 82 123 4567
const PHONE_DIAL      = 'FILL_IN_PHONE';    // e.g. +27821234567

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
    text: 'Choose a daily or weekly payment amount. The platform builds the payment schedule automatically.',
  },
  {
    n: '03',
    title: 'Payments collected and tracked automatically',
    text: 'Paystack debits the rider\'s card each week. Funds land in your Fleet Wallet. You see every transaction.',
  },
  {
    n: '04',
    title: 'Falls behind? Immobilise in one tap',
    text: 'Open the app, find the bike, tap Immobilise. The bike won\'t start until the rider is back on track.',
  },
];

const FEATURES = [
  {
    title: 'Fleet dashboard',
    text: "All your bikes, riders, and money in one place. See what's standing, what's moving, and what's overdue.",
  },
  {
    title: 'Rider agreements',
    text: 'Each rider has a contract with a start date, weekly amount, and payment schedule. No more WhatsApp threads.',
  },
  {
    title: 'Automatic payment collection',
    text: 'Set up a Paystack debit order once. The weekly payment runs itself — you just watch the money come in.',
  },
  {
    title: 'Remote immobilisation',
    text: 'If a rider falls behind, cut the ignition from your phone. The bike won\'t start until they\'re up to date.',
  },
  {
    title: 'Payment history per rider',
    text: 'See exactly what each rider has paid, what they owe, and when it\'s due. No guesswork.',
  },
  {
    title: 'Service records',
    text: 'Log every service, note the mileage, and see when each bike is due for its next check.',
  },
];

const PRICING_FEATURES = [
  'Platform access for your whole team',
  'Automatic payment collection from riders',
  'Remote immobilisation — one tap',
  'Scheduled servicing and workshop booking',
  'Priority workshop bay access',
  'Loan bike while yours is in for service',
  'Rider pipeline to find new operators',
];

export default function FleetOwnerPilot() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [form, setForm] = useState({ name: '', company: '', phone: '', bikes: '', message: '' });
  const [formState, setFormState] = useState('idle'); // idle | busy | success | error
  const [formError, setFormError] = useState('');

  useEffect(() => {
    document.title = 'OnFleet Fleet — Your riders pay, or the bike doesn\'t start';
    return () => { document.title = 'OnFleet Africa'; };
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
    if (!form.name || !form.company || !form.phone) {
      setFormError('Please fill in your name, company, and phone number.');
      return;
    }
    setFormError('');
    setFormState('busy');
    try {
      await axios.post('/api/pilot/leads', {
        contact_name:  form.name,
        company_name:  form.company,
        phone:         form.phone,
        fleet_size:    form.bikes ? Number(form.bikes) : undefined,
        notes:         form.message || undefined,
        wants_demo:    true,
        source:        'fleet_landing_page',
      });
      setFormState('success');
    } catch (err) {
      if (err.response?.status === 409) {
        setFormState('success'); // already submitted — treat as success
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
          <Link to="/fleet/login" className="btn btn-secondary" style={{ padding: '6px 16px', fontSize: 13 }}>Sign in</Link>
        </nav>

        <button
          className="fleet-mkt-hamburger"
          onClick={() => setMenuOpen(o => !o)}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        >
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </header>

      {/* Mobile fullscreen menu */}
      {menuOpen && (
        <div className="fleet-mkt-mobile-menu" role="dialog" aria-modal="true">
          <button className="fleet-mkt-mobile-close" onClick={() => setMenuOpen(false)} aria-label="Close menu">
            <X size={24} />
          </button>
          <a href="#how"     onClick={scrollTo('how')}     className="fleet-mkt-mobile-link">How it works</a>
          <a href="#pricing" onClick={scrollTo('pricing')} className="fleet-mkt-mobile-link">Pricing</a>
          <a href="#contact" onClick={scrollTo('contact')} className="fleet-mkt-mobile-link">Book a demo</a>
          <Link to="/fleet/login" className="btn" style={{ fontSize: 16, padding: '12px 40px' }} onClick={() => setMenuOpen(false)}>Sign in</Link>
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
          <a href="#contact" onClick={scrollTo('contact')} className="btn fleet-mkt-cta-primary">
            Book a demo
          </a>
          <Link to="/fleet/login" className="btn btn-secondary fleet-mkt-cta-secondary">
            Sign in
          </Link>
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
        <p className="fleet-mkt-section-sub">Everything you need to run a paying fleet.</p>
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
        {/* TODO: Replace placeholder values with real numbers before launch */}
        {[
          { value: '— bikes',  label: 'On the platform' },          // TODO: e.g. 120 bikes
          { value: 'R—',       label: 'Collected for fleet owners' }, // TODO: e.g. R1.4m
          { value: '—%',       label: 'Defaults recovered via immobilisation' }, // TODO: e.g. 94%
        ].map((s) => (
          <div key={s.label} className="fleet-mkt-proof-stat">
            <div className="fleet-mkt-proof-value">{s.value}</div>
            <div className="fleet-mkt-proof-label">{s.label}</div>
          </div>
        ))}
      </section>

      {/* ── Pricing ───────────────────────────────────────────────── */}
      <section id="pricing" className="fleet-mkt-section fleet-mkt-pricing-section">
        <h2 className="fleet-mkt-section-title">Pricing</h2>
        <p className="fleet-mkt-section-sub">One rate. No tiers to figure out.</p>
        <div className="card fleet-mkt-pricing-card">
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div className="fleet-mkt-price">R750</div>
            <div style={{ color: 'var(--muted)', fontSize: 15, marginTop: 6 }}>per bike, per month</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13, marginBottom: 28 }}>
            {PRICING_FEATURES.map((feature) => (
              <div key={feature} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <CheckCircle2 size={16} style={{ color: 'var(--success)', flexShrink: 0 }} />
                <span style={{ fontSize: 14 }}>{feature}</span>
              </div>
            ))}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20, marginBottom: 24 }}>
            <div style={{ fontWeight: 600, color: 'var(--success)', fontSize: 15, marginBottom: 4 }}>First month free.</div>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>No contract. Cancel any time.</div>
          </div>
          <a href="#contact" onClick={scrollTo('contact')} className="btn btn-block" style={{ textAlign: 'center' }}>
            Book a demo
          </a>
        </div>
      </section>

      {/* ── Contact / Demo form ───────────────────────────────────── */}
      <section id="contact" className="fleet-mkt-section fleet-mkt-section-alt">
        <div style={{ maxWidth: 840, margin: '0 auto' }}>
          <h2 className="fleet-mkt-section-title" style={{ textAlign: 'left' }}>Book a demo</h2>
          <p style={{ color: 'var(--muted)', marginBottom: 36, fontSize: 15, lineHeight: 1.65, maxWidth: 520 }}>
            Fill in the form and we'll call you back. We also do in-person demos at
            our Kya Sand workshop — bring your list of bikes and we'll set you up on the spot.
          </p>

          <div className="fleet-mkt-contact-grid">
            {/* Form */}
            <div>
              {formState === 'success' ? (
                <div className="card" style={{ textAlign: 'center', padding: 40 }}>
                  <CheckCircle2 size={40} style={{ color: 'var(--success)', margin: '0 auto 16px', display: 'block' }} />
                  <h3 style={{ marginBottom: 8 }}>We'll be in touch</h3>
                  <p style={{ color: 'var(--muted)', fontSize: 14, margin: 0 }}>
                    Expect a call within one business day.
                  </p>
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
                  {formError && (
                    <div style={{ color: 'var(--danger)', fontSize: 13 }}>{formError}</div>
                  )}
                  <button type="submit" className="btn btn-block" disabled={formState === 'busy'}>
                    {formState === 'busy' ? 'Sending…' : 'Send request'}
                  </button>
                </form>
              )}
            </div>

            {/* Direct contact options */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="card">
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  <MessageCircle size={22} style={{ color: '#25D366', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>WhatsApp us</div>
                    {/* TODO: Replace WHATSAPP_NUMBER at the top of this file */}
                    <a
                      href={WHATSAPP_NUMBER === 'FILL_IN_WHATSAPP' ? undefined : `https://wa.me/${WHATSAPP_NUMBER}`}
                      style={{ color: 'var(--primary-light)', fontSize: 14, textDecoration: 'none' }}
                    >
                      {WHATSAPP_NUMBER === 'FILL_IN_WHATSAPP' ? 'Number coming soon' : `+${WHATSAPP_NUMBER}`}
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
                    {/* TODO: Replace PHONE_DISPLAY and PHONE_DIAL at the top of this file */}
                    <a
                      href={PHONE_DIAL === 'FILL_IN_PHONE' ? undefined : `tel:${PHONE_DIAL}`}
                      style={{ color: 'var(--primary-light)', fontSize: 14, textDecoration: 'none' }}
                    >
                      {PHONE_DISPLAY === 'FILL_IN_PHONE' ? 'Number coming soon' : PHONE_DISPLAY}
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
          <Link to="/fleet/login">Sign in</Link>
          <Link to="/privacy">Privacy policy</Link>
          <Link to="/terms">Terms</Link>
        </div>
      </footer>

    </div>
  );
}
