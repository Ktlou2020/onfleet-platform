import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, BarChart3, Bike, CheckCircle2, Clock3, CreditCard, FileText, ShieldCheck, Users, Wrench } from 'lucide-react';
import Logo from '../components/Logo';
import { Badge, SearchInput, fmt, fmtDate, matchesSearch } from '../components/ui';

const tabOptions = [
  { key: 'overview', label: 'Overview' },
  { key: 'fleet', label: 'Fleet' },
  { key: 'agreements', label: 'Agreements' },
  { key: 'collections', label: 'Collections' },
  { key: 'billing', label: 'Billing' }
];

const fleetRows = [
  { id: 1, registration: 'JHB 452 GP', bike: 'TVS HLX 150', rider: 'Sipho Dlamini', status: 'active', branch: 'Johannesburg CBD', next_service: '2026-05-18', weekly_rental: 850 },
  { id: 2, registration: 'JHB 519 GP', bike: 'Bajaj Boxer', rider: 'Ayanda Mokoena', status: 'repairs', branch: 'Braamfontein', next_service: '2026-05-14', weekly_rental: 820 },
  { id: 3, registration: 'PTA 117 GP', bike: 'TVS HLX 150', rider: 'Thabo Ndlovu', status: 'active', branch: 'Pretoria West', next_service: '2026-05-20', weekly_rental: 850 },
  { id: 4, registration: 'JHB 778 GP', bike: 'Honda Ace', rider: 'Lebo Molefe', status: 'stolen', branch: 'Soweto', next_service: '—', weekly_rental: 890 },
  { id: 5, registration: 'JHB 884 GP', bike: 'Bajaj Boxer', rider: 'Kagiso Mthembu', status: 'ready_to_go', branch: 'Midrand', next_service: '2026-05-28', weekly_rental: 820 },
  { id: 6, registration: 'PTA 623 GP', bike: 'TVS HLX 150', rider: 'Neo Maseko', status: 'active', branch: 'Pretoria CBD', next_service: '2026-05-22', weekly_rental: 850 }
];

const agreementRows = [
  { id: 1, agreement_no: 'OF-FLEET-001', rider: 'Sipho Dlamini', bike_registration: 'JHB 452 GP', bike_status: 'active', status: 'active', weekly_amount: 850, overdue_balance: 0, remaining_balance: 22100 },
  { id: 2, agreement_no: 'OF-FLEET-002', rider: 'Ayanda Mokoena', bike_registration: 'JHB 519 GP', bike_status: 'repairs', status: 'paused', weekly_amount: 820, overdue_balance: 0, remaining_balance: 19440 },
  { id: 3, agreement_no: 'OF-FLEET-003', rider: 'Thabo Ndlovu', bike_registration: 'PTA 117 GP', bike_status: 'active', status: 'defaulted', weekly_amount: 850, overdue_balance: 1700, remaining_balance: 24650 },
  { id: 4, agreement_no: 'OF-FLEET-004', rider: 'Lebo Molefe', bike_registration: 'JHB 778 GP', bike_status: 'stolen', status: 'discontinued', weekly_amount: 890, overdue_balance: 0, remaining_balance: 17800 },
  { id: 5, agreement_no: 'OF-FLEET-005', rider: 'Neo Maseko', bike_registration: 'PTA 623 GP', bike_status: 'active', status: 'active', weekly_amount: 850, overdue_balance: 850, remaining_balance: 21250 }
];

const collectionsQueue = [
  { rider: 'Thabo Ndlovu', agreement_no: 'OF-FLEET-003', stage: 'Default action', amount: 1700, note: 'Bike is active, collections team should contact rider and inspect route performance.' },
  { rider: 'Neo Maseko', agreement_no: 'OF-FLEET-005', stage: 'Overdue this week', amount: 850, note: 'Send reminder today and confirm wallet funding before cutoff.' },
  { rider: 'Lebo Molefe', agreement_no: 'OF-FLEET-004', stage: 'Stolen-bike workflow', amount: 0, note: 'Agreement discontinued automatically. Future unpaid rows waived until recovery.' }
];

const checklist = [
  { label: 'Brand your workspace', done: true },
  { label: 'Import bikes by CSV', done: true },
  { label: 'Invite ops manager', done: true },
  { label: 'Connect Paystack plan', done: false },
  { label: 'Launch first pilot branch', done: false }
];

const billingTiers = [
  { name: 'Trial', limit: '10 bikes', price: 'Free for 14 days', highlight: 'Validate your process before billing starts.' },
  { name: 'Small', limit: '20 bikes', price: 'R1,499 / month', highlight: 'Good for first branch operators.' },
  { name: 'Medium', limit: '60 bikes', price: 'R3,999 / month', highlight: 'Bulk actions and reporting included.' },
  { name: 'Large', limit: '100 bikes', price: 'R6,999 / month', highlight: 'Best for scaled operations.' }
];

export default function FleetOwnerWorkspace() {
  const [tab, setTab] = useState('overview');
  const [search, setSearch] = useState('');
  const [fleetStatus, setFleetStatus] = useState('all');
  const [agreementStatus, setAgreementStatus] = useState('all');

  const activeBikeCount = fleetRows.filter((row) => row.status === 'active').length;
  const readyBikeCount = fleetRows.filter((row) => row.status === 'ready_to_go').length;
  const defaultedCount = agreementRows.filter((row) => row.status === 'defaulted' && row.bike_status !== 'stolen').length;
  const overdueAmount = agreementRows.reduce((sum, row) => sum + Number(row.overdue_balance || 0), 0);
  const checklistDone = checklist.filter((item) => item.done).length;

  const visibleFleet = useMemo(() => fleetRows.filter((row) => {
    if (fleetStatus !== 'all' && row.status !== fleetStatus) return false;
    return matchesSearch(search, row.registration, row.bike, row.rider, row.branch, row.status);
  }), [search, fleetStatus]);

  const visibleAgreements = useMemo(() => agreementRows.filter((row) => {
    if (agreementStatus !== 'all' && row.status !== agreementStatus) return false;
    return matchesSearch(search, row.agreement_no, row.rider, row.bike_registration, row.status, row.bike_status);
  }), [search, agreementStatus]);

  return (
    <div className="fleet-demo-page">
      <header className="navbar landing-navbar fleet-demo-navbar">
        <Logo />
        <nav className="landing-nav fleet-pilot-nav-inline fleet-demo-nav-inline">
          <Link to="/fleet">Pilot page</Link>
          <a href="#demo-workspace">Workspace</a>
          <a href="#demo-billing">Billing</a>
          <Link to="/fleet/login">Fleet sign in</Link>
          <Link to="/fleet/signup" className="btn btn-secondary">Create company account</Link>
        </nav>
      </header>

      <section id="demo-workspace" className="fleet-demo-hero">
        <div>
          <div className="hero-pill"><CheckCircle2 size={14} /> Testable fleet-owner workspace</div>
          <h1>Explore the <span>fleet-owner platform</span> before full tenant rollout.</h1>
          <p>This demo shows the experience fleet owners can test right now: fleet visibility, agreement control, collections routing, and billing logic built around the plans you approved.</p>
          <div className="hero-cta">
            <button className="btn hero-cta-btn" onClick={() => setTab('overview')}>Open overview</button>
            <button className="btn btn-secondary hero-cta-btn" onClick={() => setTab('billing')}>Review billing</button>
          </div>
          <div className="hero-trust-list">
            <div className="hero-trust-item"><Bike size={16} /> {fleetRows.length} demo bikes</div>
            <div className="hero-trust-item"><FileText size={16} /> {agreementRows.length} demo agreements</div>
            <div className="hero-trust-item"><ShieldCheck size={16} /> Stolen-bike discontinuation flow included</div>
          </div>
        </div>
        <div className="fleet-demo-summary-grid">
          <div className="stat"><div className="stat-label">Active bikes</div><div className="stat-value">{activeBikeCount}</div><div className="stat-delta muted">{readyBikeCount} ready to deploy</div></div>
          <div className="stat"><div className="stat-label">Collections risk</div><div className="stat-value">{defaultedCount}</div><div className="stat-delta muted">Agreements needing action</div></div>
          <div className="stat"><div className="stat-label">Overdue amount</div><div className="stat-value">{fmt(overdueAmount)}</div><div className="stat-delta muted">Across live demo agreements</div></div>
          <div className="stat"><div className="stat-label">Trial setup</div><div className="stat-value">{checklistDone}/{checklist.length}</div><div className="stat-delta muted">Pilot onboarding tasks complete</div></div>
        </div>
      </section>

      <section className="section fleet-demo-section">
        <div className="fleet-demo-toolbar card">
          <div>
            <div className="page-title" style={{ marginBottom: 6 }}>Fleet owner demo workspace</div>
            <div className="muted">This is a clickable prototype for testing the operator experience before full multi-tenant access is enabled.</div>
          </div>
          <div className="fleet-demo-tabs">
            {tabOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`btn btn-sm ${tab === option.key ? '' : 'btn-secondary'}`}
                onClick={() => setTab(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {(tab === 'fleet' || tab === 'agreements') ? (
          <div className="fleet-demo-filters card mt-4">
            <div style={{ flex: 1, minWidth: 240 }}>
              <label className="label">Search</label>
              <SearchInput value={search} onChange={setSearch} placeholder="Search rider, bike, branch, agreement" style={{ width: '100%' }} />
            </div>
            {tab === 'fleet' ? (
              <div style={{ minWidth: 180 }}>
                <label className="label">Bike status</label>
                <select value={fleetStatus} onChange={(e) => setFleetStatus(e.target.value)}>
                  <option value="all">All bike statuses</option>
                  <option value="active">Active</option>
                  <option value="ready_to_go">Ready to go</option>
                  <option value="repairs">Repairs</option>
                  <option value="stolen">Stolen</option>
                </select>
              </div>
            ) : (
              <div style={{ minWidth: 180 }}>
                <label className="label">Agreement status</label>
                <select value={agreementStatus} onChange={(e) => setAgreementStatus(e.target.value)}>
                  <option value="all">All agreement statuses</option>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="defaulted">Defaulted</option>
                  <option value="discontinued">Discontinued</option>
                </select>
              </div>
            )}
          </div>
        ) : null}

        {tab === 'overview' ? (
          <div className="fleet-demo-layout mt-4">
            <div className="card">
              <div className="card-title"><h3>Onboarding checklist</h3><span className="badge badge-info">Pilot branch</span></div>
              <div className="fleet-demo-list">
                {checklist.map((item) => (
                  <div key={item.label} className="fleet-demo-list-item">
                    <div className={`fleet-demo-dot ${item.done ? 'done' : ''}`}>{item.done ? '✓' : ''}</div>
                    <div>{item.label}</div>
                  </div>
                ))}
              </div>
              <div className="fleet-demo-callout mt-4">
                <strong>What to test now:</strong> switch between Fleet, Agreements, Collections, and Billing to validate the operator workflow and messaging.
              </div>
            </div>

            <div className="card">
              <div className="card-title"><h3>Action queue</h3><Badge status="defaulted">Needs attention</Badge></div>
              <div className="fleet-demo-list">
                <div className="fleet-demo-list-item"><AlertTriangle size={16} /> {defaultedCount} defaulted agreement{defaultedCount === 1 ? '' : 's'} on active bikes</div>
                <div className="fleet-demo-list-item"><Wrench size={16} /> 1 bike in repairs awaiting return-to-service decision</div>
                <div className="fleet-demo-list-item"><Clock3 size={16} /> 1 trial billing setup still incomplete</div>
              </div>
              <div className="fleet-demo-callout mt-4">
                Stolen bikes do not appear in the default-action queue once their agreements have been discontinued.
              </div>
            </div>

            <div className="card">
              <div className="card-title"><h3>Plan entitlement snapshot</h3><Badge status="active">Medium trial</Badge></div>
              <div className="fleet-demo-metric-pair"><span>Bike slots used</span><strong>42 / 60</strong></div>
              <div className="progress-bar mt-2"><div className="progress-fill" style={{ width: '70%' }} /></div>
              <div className="fleet-demo-metric-pair mt-4"><span>Admin seats used</span><strong>3 / 5</strong></div>
              <div className="progress-bar mt-2"><div className="progress-fill" style={{ width: '60%' }} /></div>
              <div className="fleet-demo-callout mt-4">When the trial ends, access continues only if the Paystack subscription is active or within the grace window.</div>
            </div>
          </div>
        ) : null}

        {tab === 'fleet' ? (
          <div className="card mt-4" style={{ overflowX: 'auto' }}>
            <div className="card-title"><h3>Fleet visibility</h3><Badge status="active">{visibleFleet.length} bikes shown</Badge></div>
            <table className="table">
              <thead>
                <tr>
                  <th>Registration</th>
                  <th>Bike</th>
                  <th>Rider</th>
                  <th>Status</th>
                  <th>Branch</th>
                  <th>Next service</th>
                  <th>Weekly rental</th>
                </tr>
              </thead>
              <tbody>
                {visibleFleet.map((row) => (
                  <tr key={row.id}>
                    <td>{row.registration}</td>
                    <td>{row.bike}</td>
                    <td>{row.rider}</td>
                    <td><Badge status={row.status}>{String(row.status).replace(/_/g, ' ')}</Badge></td>
                    <td>{row.branch}</td>
                    <td>{row.next_service === '—' ? '—' : fmtDate(row.next_service)}</td>
                    <td>{fmt(row.weekly_rental)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === 'agreements' ? (
          <div className="card mt-4" style={{ overflowX: 'auto' }}>
            <div className="card-title"><h3>Agreement control</h3><Badge status="active">{visibleAgreements.length} agreements shown</Badge></div>
            <table className="table">
              <thead>
                <tr>
                  <th>Agreement</th>
                  <th>Rider</th>
                  <th>Bike</th>
                  <th>Bike status</th>
                  <th>Agreement status</th>
                  <th>Weekly amount</th>
                  <th>Overdue</th>
                  <th>Remaining</th>
                </tr>
              </thead>
              <tbody>
                {visibleAgreements.map((row) => (
                  <tr key={row.id}>
                    <td>{row.agreement_no}</td>
                    <td>{row.rider}</td>
                    <td>{row.bike_registration}</td>
                    <td><Badge status={row.bike_status}>{String(row.bike_status).replace(/_/g, ' ')}</Badge></td>
                    <td><Badge status={row.status}>{String(row.status).replace(/_/g, ' ')}</Badge></td>
                    <td>{fmt(row.weekly_amount)}</td>
                    <td>{fmt(row.overdue_balance)}</td>
                    <td>{fmt(row.remaining_balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === 'collections' ? (
          <div className="fleet-demo-layout mt-4">
            <div className="card">
              <div className="card-title"><h3>Collections queue</h3><Badge status="overdue">{fmt(overdueAmount)}</Badge></div>
              <div className="fleet-demo-list">
                {collectionsQueue.map((item) => (
                  <div key={item.agreement_no} className="fleet-demo-queue-item">
                    <div className="flex-between gap-3" style={{ alignItems: 'flex-start' }}>
                      <div>
                        <strong>{item.rider}</strong>
                        <div className="muted text-sm">{item.agreement_no} · {item.stage}</div>
                      </div>
                      <div style={{ fontWeight: 700 }}>{fmt(item.amount)}</div>
                    </div>
                    <div className="muted text-sm mt-2">{item.note}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="card-title"><h3>Collections rules in this build</h3><Badge status="success">Configured</Badge></div>
              <div className="fleet-demo-list">
                <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Default-action queue excludes bikes that are stolen, written off, or sold.</div>
                <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Agreements can be bulk discontinued on the admin agreements screen.</div>
                <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> When a bike is marked stolen, the linked contract is automatically discontinued.</div>
              </div>
              <Link to="/fleet#pilot-form" className="btn btn-block mt-4">Request live onboarding <ArrowRight size={16} /></Link>
            </div>
          </div>
        ) : null}

        {tab === 'billing' ? (
          <div id="demo-billing" className="fleet-demo-layout mt-4">
            <div className="card">
              <div className="card-title"><h3>Billing and access policy</h3><Badge status="active">Trial active</Badge></div>
              <div className="fleet-demo-list">
                <div className="fleet-demo-list-item"><CreditCard size={16} /> Day 1–14: full access during free trial.</div>
                <div className="fleet-demo-list-item"><Users size={16} /> Paid subscription active: full access based on plan entitlements.</div>
                <div className="fleet-demo-list-item"><AlertTriangle size={16} /> Past due: billing banner stays visible and billing pages remain accessible.</div>
                <div className="fleet-demo-list-item"><ShieldCheck size={16} /> Suspended after grace period: operational access is blocked until payment succeeds.</div>
              </div>
              <div className="fleet-demo-callout mt-4">This matches the commercial rule you requested: if they do not pay, they do not keep platform access.</div>
            </div>

            <div className="card">
              <div className="card-title"><h3>Plan ladder</h3><Badge status="info">Suggested pricing</Badge></div>
              <div className="fleet-demo-tier-grid">
                {billingTiers.map((tier) => (
                  <div key={tier.name} className="fleet-demo-tier-card">
                    <div className="badge badge-info">{tier.name}</div>
                    <div className="text-lg font-bold mt-3">{tier.price}</div>
                    <div className="muted text-sm mt-1">{tier.limit}</div>
                    <div className="muted text-sm mt-3">{tier.highlight}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
