import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Stat, Badge, Loading, SearchInput, fmt, fmtDate, EmptyState, matchesSearch } from '../../components/ui';
import { Bike, TrendingUp, Calendar, AlertCircle, CreditCard, FileText, UserCircle, CheckCircle2 } from 'lucide-react';
import TourModal from '../../components/TourModal';

const RIDER_TOUR_STEPS = [
  {
    icon: <Bike size={32} />,
    title: 'Welcome to your rider portal!',
    description: "This is your personal dashboard for the rent-to-own programme. Track your bike, monitor your payments, and manage everything in one place.",
    tip: 'Tip: bookmark this page for quick access from your phone.'
  },
  {
    icon: <CheckCircle2 size={32} />,
    title: 'Step 1 — Submit your application',
    description: "Go to Application in the sidebar to upload your ID, driver's licence, selfie, and three recent payslips. Once submitted, the system reviews your income automatically and notifies you of the outcome.",
    tip: "Payslips don't have to be PDFs — images and Word documents are accepted. You'll be asked to type the monthly Rand amount shown on the payslip."
  },
  {
    icon: <FileText size={32} />,
    title: 'Step 2 — Your agreement',
    description: "Once approved, your rental agreement is created and a bike is allocated. Open My Agreement to read your contract, track your ownership progress, and download your monthly statement.",
    tip: 'Your agreement tracks every week — you can see exactly how many weeks are paid, how many remain, and the full payment schedule.'
  },
  {
    icon: <CreditCard size={32} />,
    title: 'Step 3 — Making payments',
    description: "Your fleet owner will set up a weekly Paystack subscription for you. You'll authorise your card once via a secure Paystack link — after that, your weekly rental is deducted automatically every week.",
    tip: 'You can also make one-off manual payments from the Payments section at any time.'
  },
  {
    icon: <UserCircle size={32} />,
    title: 'Keep your profile updated',
    description: "Go to Profile to update your phone number, address, emergency contact, and banking details. Keeping this information current ensures smooth communication and correct payment records.",
    tip: "You're all set! If you ever have a question, reach out to your fleet manager directly."
  }
];

const monthLabel = (monthKey) => new Date(`${monthKey}-01T00:00:00`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
const creditedAmount = (payment) => Number(payment?.net_amount ?? payment?.amount ?? 0);

export default function RiderDashboard() {
  const [data, setData] = useState(null);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/agreements/mine'),
      api.get('/applications/mine')
    ]).then(([a, p]) => {
      setApps(p.data.applications);
      const ag = a.data.agreements[0];
      if (ag) api.get(`/agreements/${ag.id}`).then((r) => setData(r.data));
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading />;

  if (!data) {
    const pending = apps.find((application) => application.status === 'submitted' || application.status === 'under_review');
    return (
      <>
        <TourModal steps={RIDER_TOUR_STEPS} storageKey="onfleet_tour_rider_v1" />
        <h1 className="page-title">Dashboard</h1>
        <p className="page-sub">Get started on your rent-to-own journey</p>
        {pending ? (
          <div className="card">
            <div className="row" style={{ gap: 16 }}>
              <div style={{ width: 48, height: 48, borderRadius: 10, background: 'rgba(255,182,39,0.15)', display: 'flex', alignItems:'center', justifyContent:'center', color: 'var(--warn)' }}><AlertCircle /></div>
              <div style={{ flex: 1 }}>
                <h3>Application under review</h3>
                <div className="muted text-sm">We'll notify you within 48 hours. Status: <Badge status={pending.status}/></div>
              </div>
              <Link to="/application" className="btn btn-secondary">View</Link>
            </div>
          </div>
        ) : (
          <EmptyState title="No active agreement yet" sub="Submit an application to start your rent-to-own journey." action={<Link to="/application" className="btn">Start application</Link>} />
        )}
      </>
    );
  }

  const { agreement, summary, schedule, payments = [] } = data;
  const upcoming = schedule.filter((item) => item.status !== 'paid' && item.status !== 'waived').slice(0, 5).filter((item) => matchesSearch(search, item.week_number, item.due_date, item.amount_due, item.amount_paid, item.status));
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthlyPaid = payments.filter((payment) => payment.status === 'success' && String(payment.paid_at || payment.created_at || '').slice(0, 7) === currentMonth).reduce((sum, payment) => sum + creditedAmount(payment), 0);
  const quickActions = [
    { label: "💳 Pay this week's fee", link: '/payments', primary: true },
    { label: '🧾 Monthly statement', link: `/agreements/${agreement.id}` },
    { label: '🛠️ Book service / bike care', link: `/agreements/${agreement.id}` },
    { label: '⚙️ Update profile', link: '/profile' }
  ].filter((item) => matchesSearch(search, item.label));

  return (
    <>
      <TourModal steps={RIDER_TOUR_STEPS} storageKey="onfleet_tour_rider_v1" />
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Track your rent-to-own progress</p>

      <div className="row mb-4" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search due dates, statements, and quick actions" style={{ flex: '1 1 320px', maxWidth: 420 }} />
        <div className="muted text-sm">Showing {upcoming.length + quickActions.length} dashboard matches</div>
      </div>

      <div className="card mb-4" style={{ background: 'var(--surface-2)' }}>
        <strong>Need help using the rider portal?</strong>
        <div className="muted text-sm mt-2">Use Application to upload documents and track approval, My Agreement to read your contract and monthly statement, Payments to stay up to date, and Profile to keep your contact details correct.</div>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Total paid" value={fmt(summary.total_paid)} icon={<TrendingUp size={16}/>} />
        <Stat label="Remaining" value={fmt(summary.remaining)} icon={<Calendar size={16}/>} accent="var(--accent)" />
        <Stat label="Weeks paid" value={`${summary.weeks_paid} / ${summary.weeks_total}`} icon={<Bike size={16}/>} />
        <Stat label="Overdue" value={fmt(summary.overdue)} icon={<AlertCircle size={16}/>} accent="var(--danger)" />
      </div>

      <div className="card mb-4" style={{ padding: 0, overflow: 'hidden' }}>
        {agreement.image_url && (
          <div style={{ height: 200, backgroundImage: `url("${agreement.image_url}")`, backgroundSize: 'cover', backgroundPosition: 'center', position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 40%, rgba(13,15,20,0.9))' }} />
            <div style={{ position: 'absolute', bottom: 16, left: 20, right: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <div>
                <div className="muted text-xs">YOUR BIKE</div>
                <h2 style={{ fontSize: 24 }}>{agreement.make} {agreement.model}</h2>
              </div>
              <Badge status={agreement.status} />
            </div>
          </div>
        )}
        <div style={{ padding: 20 }}>
          <div className="flex-between mb-3">
            <div>
              {!agreement.image_url && <><div className="muted text-xs">YOUR BIKE</div><h2>{agreement.make} {agreement.model}</h2></>}
              <div className="muted text-sm">Agreement {agreement.agreement_no} · {agreement.registration || agreement.vin}</div>
            </div>
            {!agreement.image_url && <Badge status={agreement.status} />}
          </div>
          <div className="mb-2 flex-between">
            <div className="text-sm">Progress to ownership</div>
            <div className="font-bold">{summary.progress_pct}%</div>
          </div>
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${summary.progress_pct}%` }} /></div>
          <div className="flex-between mt-3 text-sm muted">
            <div>Started {fmtDate(agreement.start_date)}</div>
            <div>Ownership: {fmtDate(agreement.end_date)}</div>
          </div>
          <div className="row mt-4">
            <Link to={`/agreements/${agreement.id}`} className="btn">View agreement</Link>
            <Link to="/payments" className="btn btn-secondary">Make a payment</Link>
          </div>
        </div>
      </div>

      <div className="card mb-4">
        <div className="flex-between" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div>
            <h3 className="mb-1">Monthly statement</h3>
            <div className="muted text-sm">Your latest running statement for {monthLabel(currentMonth)} includes bike info, total paid, and outstanding balance.</div>
          </div>
          <Link to={`/agreements/${agreement.id}`} className="btn btn-secondary btn-sm">Open full statement</Link>
        </div>
        <div className="grid grid-3 mt-4">
          <div className="stat"><div className="stat-label">Paid this month</div><div className="stat-value">{fmt(monthlyPaid)}</div></div>
          <div className="stat"><div className="stat-label">Outstanding balance</div><div className="stat-value">{fmt(summary.remaining)}</div></div>
          <div className="stat"><div className="stat-label">Bike reference</div><div className="stat-value" style={{ fontSize: 20 }}>{agreement.registration || agreement.vin}</div></div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="mb-3">Upcoming payments</h3>
          <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Week</th><th>Due date</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {upcoming.map((item) => (
                <tr key={item.id}>
                  <td>#{item.week_number}</td>
                  <td>{fmtDate(item.due_date)}</td>
                  <td>{fmt(item.amount_due - item.amount_paid)}</td>
                  <td><Badge status={item.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {!upcoming.length && <div className="muted text-sm">No upcoming payments match your search.</div>}
        </div>
        <div className="card">
          <h3 className="mb-3">Quick actions</h3>
          {quickActions.map((item) => (
            <Link key={item.link + item.label} to={item.link} className={`btn ${item.primary ? 'btn-block' : 'btn-secondary btn-block'} mb-2`}>{item.label}</Link>
          ))}
          {!quickActions.length && <div className="muted text-sm">No quick actions match your search.</div>}
        </div>
      </div>
    </>
  );
}
