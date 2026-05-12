import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronRight, CreditCard, ShieldCheck, Users, Bike, BarChart3, Layers3, Briefcase, Clock3, Rocket } from 'lucide-react';
import Logo from '../components/Logo';
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

export default function FleetOwnerPilot() {
  const [selectedPlanKey, setSelectedPlanKey] = useState('trial');
  const selectedPlan = useMemo(() => plans.find((plan) => plan.key === selectedPlanKey) || plans[0], [selectedPlanKey]);

  return (
    <div className="fleet-pilot-page">
      <header className="navbar landing-navbar fleet-pilot-navbar">
        <Logo />
        <nav className="landing-nav fleet-pilot-nav-inline">
          <a href="#plans">Plans</a>
          <a href="#features">Features</a>
          <Link to="/fleet/workspace">Preview workspace</Link>
          <a href="#launch">Launch now</a>
          <Link to="/fleet/login">Fleet sign in</Link>
          <Link to="/fleet/signup" className="btn btn-secondary">Create company account</Link>
        </nav>
      </header>

      <section className="fleet-pilot-hero">
        <div className="fleet-pilot-copy">
          <div className="hero-pill"><Briefcase size={14} /> Fleet-owner platform</div>
          <h1>Let fleet owners run operations on <span>OnFleet</span>.</h1>
          <p>The fleet-owner site is now live. Operators can launch a company account immediately, manage bikes and agreements, capture payments, and work from a production-ready workspace with billing controls in place.</p>
          <div className="hero-cta">
            <Link to="/fleet/signup" className="btn hero-cta-btn">Create company account</Link>
            <Link to="/fleet/login" className="btn btn-secondary hero-cta-btn">Fleet sign in</Link>
            <Link to="/fleet/workspace" className="btn btn-secondary hero-cta-btn">Preview workspace</Link>
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
              'Fleet billing and payment visibility',
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
              onClick={() => setSelectedPlanKey(plan.key)}
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

      <section id="launch" className="section fleet-pilot-section">
        <div className="fleet-pilot-form-wrap">
          <div className="card fleet-pilot-form-card">
            <div className="page-title" style={{ marginBottom: 8 }}>Launch your fleet now</div>
            <div className="page-sub" style={{ marginBottom: 18 }}>The public onboarding request form has been retired because the fleet-owner site is live. Create a company account and start operating immediately.</div>
            <div className="grid grid-2">
              <div className="card" style={{ background: 'var(--surface-2)' }}>
                <div className="badge badge-success">Go live</div>
                <h3 className="mt-3">Create a company account</h3>
                <div className="muted mt-2">Set up the fleet, choose the right plan, and invite your first team member.</div>
                <Link to="/fleet/signup" className="btn btn-block mt-4">Create account <Rocket size={16} /></Link>
              </div>
              <div className="card" style={{ background: 'var(--surface-2)' }}>
                <div className="badge badge-info">Already registered</div>
                <h3 className="mt-3">Sign in to the fleet portal</h3>
                <div className="muted mt-2">Open the live workspace to manage bikes, agreements, and payments.</div>
                <div className="row mt-4" style={{ flexWrap: 'wrap' }}>
                  <Link to="/fleet/login" className="btn">Fleet sign in</Link>
                  <Link to="/fleet/app" className="btn btn-secondary">Open portal</Link>
                </div>
              </div>
            </div>
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
