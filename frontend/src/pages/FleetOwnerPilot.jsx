import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { CheckCircle2, ChevronRight, CreditCard, ShieldCheck, Users, Bike, BarChart3, Layers3, Briefcase, Clock3 } from 'lucide-react';
import Logo from '../components/Logo';
import api from '../api';
import { fmt } from '../components/ui';

const plans = [
  {
    key: 'trial',
    name: '14-day trial',
    price: 'Free',
    cap: 'Up to 10 bikes',
    summary: 'Best for validating the workflow with a live mini-fleet before going paid.',
    cta: 'Start trial',
    highlight: true,
    features: ['2 admin users', 'Bike and agreement tracking', 'Payments dashboard', 'Collections visibility']
  },
  {
    key: 'small',
    name: 'Small fleet',
    price: fmt(1499).replace('.00', ''),
    cap: 'Up to 20 bikes',
    summary: 'For early operators moving from spreadsheets to a daily operating system.',
    cta: 'Choose Small',
    features: ['3 admin users', 'CSV imports', 'Maintenance reminders', 'Standard support']
  },
  {
    key: 'medium',
    name: 'Medium fleet',
    price: fmt(3999).replace('.00', ''),
    cap: 'Up to 60 bikes',
    summary: 'For growing fleets that need bulk actions, reporting, and tighter control.',
    cta: 'Choose Medium',
    features: ['5 admin users', 'Advanced filters', 'Bulk contract actions', 'Performance reporting']
  },
  {
    key: 'large',
    name: 'Large fleet',
    price: fmt(6999).replace('.00', ''),
    cap: 'Up to 100 bikes',
    summary: 'For scaled operations running multiple teams, hubs, and field processes.',
    cta: 'Choose Large',
    features: ['10 admin users', 'Priority onboarding', 'Audit visibility', 'Multi-branch readiness']
  },
  {
    key: 'enterprise',
    name: 'Enterprise+',
    price: 'Custom',
    cap: '100+ bikes',
    summary: 'For enterprise rollouts needing custom onboarding, integrations, and support.',
    cta: 'Talk to us',
    features: ['Custom bike limits', 'Dedicated onboarding', 'API/webhook options', 'Success support']
  }
];

const defaultForm = {
  company_name: '',
  contact_name: '',
  email: '',
  phone: '',
  city: '',
  fleet_size: '',
  plan_interest: 'trial',
  wants_demo: true,
  notes: ''
};

export default function FleetOwnerPilot() {
  const [form, setForm] = useState(defaultForm);
  const [submitting, setSubmitting] = useState(false);
  const selectedPlan = useMemo(() => plans.find((plan) => plan.key === form.plan_interest) || plans[0], [form.plan_interest]);

  const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!form.company_name.trim() || !form.contact_name.trim() || !form.email.trim()) {
      toast.error('Company name, contact name, and email are required');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/pilot/leads', {
        ...form,
        fleet_size: form.fleet_size ? Number(form.fleet_size) : null,
        source: 'fleet_owner_pilot_page'
      });
      toast.success('Request submitted. We will contact you shortly.');
      setForm(defaultForm);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not submit request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fleet-pilot-page">
      <header className="navbar landing-navbar fleet-pilot-navbar">
        <Logo />
        <nav className="landing-nav fleet-pilot-nav-inline">
          <a href="#plans">Plans</a>
          <a href="#features">Features</a>
          <Link to="/fleet/workspace">Preview workspace</Link>
          <a href="#get-started">Get started</a>
          <Link to="/fleet/login">Fleet sign in</Link>
          <Link to="/fleet/signup" className="btn btn-secondary">Create company account</Link>
        </nav>
      </header>

      <section className="fleet-pilot-hero">
        <div className="fleet-pilot-copy">
          <div className="hero-pill"><Briefcase size={14} /> Fleet-owner platform</div>
          <h1>Let fleet owners run operations on <span>OnFleet</span>.</h1>
          <p>Launch a fleet workspace for operators who want to manage bikes, agreements, payments, maintenance, and collections in one admin experience — with a 14-day trial and Paystack billing ready for go-live.</p>
          <div className="hero-cta">
            <Link to="/fleet/app" className="btn hero-cta-btn">Open fleet portal</Link>
            <Link to="/fleet/workspace" className="btn btn-secondary hero-cta-btn">Preview workspace</Link>
            <Link to="/fleet/signup" className="btn btn-secondary hero-cta-btn">Create company account</Link>
          </div>
          <div className="hero-trust-list">
            <div className="hero-trust-item"><Clock3 size={16} /> 14-day live trial</div>
            <div className="hero-trust-item"><CreditCard size={16} /> Paystack billing flow ready</div>
            <div className="hero-trust-item"><ShieldCheck size={16} /> Access blocks when billing fails</div>
          </div>
        </div>
        <div className="fleet-pilot-hero-card card">
          <div className="badge badge-success">Production ready</div>
          <h3 className="mt-3">What teams can manage</h3>
          <div className="fleet-pilot-checks mt-4">
            {[
              'Daily bike, rider, and agreement operations',
              'Collections workflows and default handling',
              'Bulk imports, filters, and contract actions',
              'A guided workspace preview for stakeholder reviews',
              'Role-based access and billing controls for live operations'
            ].map((item) => (
              <div className="fleet-pilot-check" key={item}><CheckCircle2 size={16} /> {item}</div>
            ))}
          </div>
        </div>
      </section>

      <section id="plans" className="section fleet-pilot-section">
        <div className="section-head">
          <h2>Fleet plans</h2>
          <div className="sub">Start with the trial, then move operators onto the right fleet size once they are active and billing through Paystack.</div>
        </div>
        <div className="fleet-plan-grid">
          {plans.map((plan) => (
            <button
              key={plan.key}
              type="button"
              className={`card fleet-plan-card ${selectedPlan.key === plan.key ? 'selected' : ''} ${plan.highlight ? 'highlight' : ''}`}
              onClick={() => update('plan_interest', plan.key)}
            >
              <div className="flex-between gap-3" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div className={`badge ${plan.highlight ? 'badge-success' : 'badge-info'}`}>{plan.name}</div>
                  <h3 className="mt-3">{plan.price}{plan.key !== 'trial' && plan.key !== 'enterprise' ? <span className="muted text-sm"> / month</span> : null}</h3>
                </div>
                <div className="badge badge-muted">{plan.cap}</div>
              </div>
              <p className="muted mt-3">{plan.summary}</p>
              <div className="fleet-plan-list mt-4">
                {plan.features.map((feature) => <div key={feature}><CheckCircle2 size={14} /> {feature}</div>)}
              </div>
              <div className="fleet-plan-footer mt-4">
                <span>{plan.cta}</span>
                <ChevronRight size={16} />
              </div>
            </button>
          ))}
        </div>
      </section>

      <section id="features" className="section fleet-pilot-section fleet-pilot-features">
        <div className="section-head">
          <h2>What the platform includes</h2>
          <div className="sub">A commercial workspace focused on daily operations, billing discipline, and operator visibility.</div>
        </div>
        <div className="grid grid-4">
          {[
            { icon: <Bike />, title: 'Fleet operations', text: 'Manage bike statuses, allocations, service dates, and compliance documents from one place.' },
            { icon: <Users />, title: 'Agreement control', text: 'Track rider contracts, outstanding balances, defaults, discontinuations, and reinstatements.' },
            { icon: <BarChart3 />, title: 'Collections visibility', text: 'Spot overdue and defaulted agreements fast and route ops teams to the right follow-up.' },
            { icon: <Layers3 />, title: 'Plan-based rollout', text: 'Plan entitlements map naturally to Small, Medium, Large, and Enterprise commercial tiers.' }
          ].map((item) => (
            <div className="card landing-benefit-card" key={item.title}>
              <div style={{ color: 'var(--primary-light)', marginBottom: 10 }}>{item.icon}</div>
              <h3>{item.title}</h3>
              <div className="muted text-sm mt-2">{item.text}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="get-started" className="section fleet-pilot-section">
        <div className="fleet-pilot-form-wrap">
          <div className="card fleet-pilot-form-card">
            <div className="page-title" style={{ marginBottom: 8 }}>Request onboarding support</div>
            <div className="page-sub" style={{ marginBottom: 18 }}>Tell us about the operator and we will help you launch the right fleet setup.</div>
            <form onSubmit={handleSubmit} className="grid grid-2">
              <div className="field">
                <label className="label">Company name</label>
                <input value={form.company_name} onChange={(e) => update('company_name', e.target.value)} placeholder="e.g. FastMoto Couriers" />
              </div>
              <div className="field">
                <label className="label">Contact name</label>
                <input value={form.contact_name} onChange={(e) => update('contact_name', e.target.value)} placeholder="Owner or operations lead" />
              </div>
              <div className="field">
                <label className="label">Email</label>
                <input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} placeholder="name@company.com" />
              </div>
              <div className="field">
                <label className="label">Phone</label>
                <input value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="+27..." />
              </div>
              <div className="field">
                <label className="label">City</label>
                <input value={form.city} onChange={(e) => update('city', e.target.value)} placeholder="Johannesburg" />
              </div>
              <div className="field">
                <label className="label">Fleet size</label>
                <input type="number" min="1" value={form.fleet_size} onChange={(e) => update('fleet_size', e.target.value)} placeholder="How many bikes" />
              </div>
              <div className="field">
                <label className="label">Plan interest</label>
                <select value={form.plan_interest} onChange={(e) => update('plan_interest', e.target.value)}>
                  {plans.map((plan) => <option key={plan.key} value={plan.key}>{plan.name}</option>)}
                </select>
              </div>
              <div className="field fleet-pilot-checkbox-field">
                <label className="label">Support needed</label>
                <label className="fleet-pilot-checkbox">
                  <input type="checkbox" checked={form.wants_demo} onChange={(e) => update('wants_demo', e.target.checked)} />
                  <span>Schedule an onboarding call</span>
                </label>
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label className="label">Notes</label>
                <textarea rows="4" value={form.notes} onChange={(e) => update('notes', e.target.value)} placeholder="Current tools, rollout timing, or any specific needs" />
              </div>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn" type="submit" disabled={submitting}>{submitting ? 'Submitting…' : 'Submit request'}</button>
                <span className="muted text-sm">You will receive a follow-up for onboarding and billing setup.</span>
              </div>
            </form>
          </div>

          <div className="card fleet-pilot-summary-card">
            <div className="badge badge-info">Selected plan</div>
            <h3 className="mt-3">{selectedPlan.name}</h3>
            <div className="fleet-pilot-price mt-2">{selectedPlan.price}{selectedPlan.key !== 'trial' && selectedPlan.key !== 'enterprise' ? <span className="muted text-sm"> / month</span> : null}</div>
            <div className="muted mt-2">{selectedPlan.cap}</div>
            <div className="fleet-plan-list mt-4">
              {selectedPlan.features.map((feature) => <div key={feature}><CheckCircle2 size={14} /> {feature}</div>)}
            </div>
            <div className="fleet-pilot-note mt-4">
              <strong>Billing rule:</strong> access continues during trial or when the subscription is active. If payment fails after the grace window, the operator only keeps access to billing screens until they settle.
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
