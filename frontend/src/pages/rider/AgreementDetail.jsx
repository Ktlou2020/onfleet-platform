import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';
import { jsPDF } from 'jspdf';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Stat, fmt, fmtDate, fmtDateTime } from '../../components/ui';

const bikeIcon = new L.DivIcon({
  html: `<div style="background:var(--primary);width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white;box-shadow:0 4px 10px rgba(0,0,0,0.3)">🏍️</div>`,
  className: '', iconSize: [30, 30], iconAnchor: [15, 15]
});

const SERVICE_BOOKING_LINKS = [
  {
    name: 'OnFix',
    city: 'Johannesburg',
    url: 'https://calendar.app.google/JjLd7TFBdDGK6W4r6',
    description: 'Book your OnFleet service slot in JHB for inspections, routine maintenance, or repairs.'
  },
  {
    name: 'Bikerhouse',
    city: 'Cape Town',
    url: 'https://calendar.app.google/JjLd7TFBdDGK6W4r6',
    description: 'Book your Cape Town service appointment for monthly checks and bike support.'
  }
];

const CARE_TIPS = [
  { title: 'Check tyres every week', text: 'Keep tyre pressure correct, inspect tread and sidewalls, and never ride long distances on a puncture or soft tyre.' },
  { title: 'Watch oil, chain, and brakes', text: 'Check engine oil regularly, keep the chain clean and lubricated, and stop riding immediately if brakes feel weak or noisy.' },
  { title: 'Keep it clean and report damage fast', text: 'Wash off dirt, rain residue, and food spills. Report knocks, leaks, warning lights, or crashes as soon as they happen.' },
  { title: 'Park smart', text: 'Use well-lit areas, lock the steering, add a disc lock or chain if available, and avoid leaving the bike unattended in isolated streets.' },
  { title: 'Protect your keys and documents', text: 'Do not leave spare keys on the bike. Keep registration, licence disc, and insurance details secure and up to date.' },
  { title: 'Reduce theft risk', text: 'Vary parking spots, use busy pickup points, switch off quickly when stopping, and share suspicious activity with OnFleet immediately.' }
];

const creditedAmount = (payment) => Number(payment?.net_amount || payment?.amount || 0);
const feeAmount = (payment) => Number(payment?.fee_amount || 0);
const grossAmount = (payment) => Number(payment?.amount || 0);
const monthKey = (date) => String(date || '').slice(0, 7);
const monthLabel = (key) => new Date(`${key}-01T00:00:00`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });

function buildMonthOptions(agreement) {
  if (!agreement?.start_date) return [new Date().toISOString().slice(0, 7)];
  const now = new Date();
  const start = new Date(`${agreement.start_date.slice(0, 7)}-01T00:00:00`);
  const endBoundary = agreement.end_date ? new Date(`${agreement.end_date.slice(0, 7)}-01T00:00:00`) : now;
  const end = endBoundary < now ? endBoundary : new Date(`${now.toISOString().slice(0, 7)}-01T00:00:00`);
  const items = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    items.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return items.reverse();
}

function buildStatement({ agreement, schedule, payments, month }) {
  const successPayments = payments.filter((payment) => payment.status === 'success');
  const statementPayments = successPayments.filter((payment) => monthKey(payment.paid_at || payment.created_at) === month);
  const statementPaid = statementPayments.reduce((sum, payment) => sum + creditedAmount(payment), 0);
  const statementFees = statementPayments.reduce((sum, payment) => sum + feeAmount(payment), 0);
  const totalPaidToDate = successPayments.reduce((sum, payment) => sum + creditedAmount(payment), 0);
  const discontinued = agreement.status === 'discontinued';
  const scheduledThisMonth = discontinued ? 0 : schedule.filter((row) => row.status !== 'waived' && monthKey(row.due_date) === month).reduce((sum, row) => sum + Number(row.amount_due || 0), 0);
  const remainingOutstanding = discontinued ? 0 : Math.max(0, Number(agreement.total_amount || 0) - totalPaidToDate);
  const nextDue = discontinued ? null : schedule.find((row) => row.status !== 'paid' && row.status !== 'waived');
  return {
    month,
    monthLabel: monthLabel(month),
    statementPaid: +statementPaid.toFixed(2),
    statementFees: +statementFees.toFixed(2),
    totalPaidToDate: +totalPaidToDate.toFixed(2),
    scheduledThisMonth: +scheduledThisMonth.toFixed(2),
    remainingOutstanding: +remainingOutstanding.toFixed(2),
    paymentCount: statementPayments.length,
    statementPayments,
    nextDue
  };
}

function downloadStatementPdf(agreement, statement) {
  const doc = new jsPDF();
  let y = 18;
  const line = (text, gap = 8) => {
    doc.text(String(text), 14, y);
    y += gap;
  };

  doc.setFontSize(18);
  line('OnFleet rider monthly statement', 10);
  doc.setFontSize(11);
  line(`Statement month: ${statement.monthLabel}`);
  line(`Agreement: ${agreement.agreement_no}`);
  line(`Bike: ${agreement.make} ${agreement.model}`);
  line(`Bike reference: ${agreement.registration || agreement.vin}`);
  line(`Weekly rental: ${fmt(agreement.weekly_amount)}`);
  line(`Paid this month: ${fmt(statement.statementPaid)}`);
  line(`Gateway fees this month: ${fmt(statement.statementFees)}`);
  line(`Total paid to date: ${fmt(statement.totalPaidToDate)}`);
  line(`Outstanding balance: ${fmt(statement.remainingOutstanding)}`);
  if (statement.nextDue) line(`Next instalment: ${fmt(statement.nextDue.amount_due - statement.nextDue.amount_paid)} due ${fmtDate(statement.nextDue.due_date)}`);

  y += 4;
  doc.setFontSize(13);
  line('Payments in this statement period', 8);
  doc.setFontSize(10);
  if (!statement.statementPayments.length) {
    line('No successful payments recorded for this month.');
  } else {
    statement.statementPayments.forEach((payment) => {
      const text = `${fmtDate(payment.paid_at || payment.created_at)} · ${payment.method} · ${payment.reference || 'No ref'} · rental ${fmt(creditedAmount(payment))} · gross ${fmt(grossAmount(payment))}`;
      if (y > 275) {
        doc.addPage();
        y = 18;
      }
      line(text, 7);
    });
  }

  doc.save(`statement-${agreement.agreement_no}-${statement.month}.pdf`);
}

export default function RiderAgreementDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [bike, setBike] = useState(null);
  const [signing, setSigning] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState('');

  const load = () => api.get(`/agreements/${id}`).then((response) => {
    setData(response.data);
    api.get(`/bikes/${response.data.agreement.bike_id}`).then((bikeResponse) => setBike(bikeResponse.data));
  });
  useEffect(() => { load(); }, [id]);

  const agreement = data?.agreement || {};
  const schedule = data?.schedule || [];
  const payments = data?.payments || [];
  const summary = data?.summary || {};
  const positions = bike?.gps_history?.map((point) => [point.lat, point.lng]) || [];
  const currentPos = bike?.bike?.last_known_lat ? [bike.bike.last_known_lat, bike.bike.last_known_lng] : null;
  const monthOptions = useMemo(() => buildMonthOptions(agreement), [agreement]);
  const activeMonth = selectedMonth || monthOptions[0] || new Date().toISOString().slice(0, 7);
  const statement = useMemo(() => buildStatement({ agreement, schedule, payments, month: activeMonth }), [agreement, schedule, payments, activeMonth]);
  const discontinued = agreement.status === 'discontinued';

  useEffect(() => {
    if (!selectedMonth && monthOptions[0]) setSelectedMonth(monthOptions[0]);
  }, [selectedMonth, monthOptions]);

  if (!data) return <Loading />;

  const signAgreement = async () => {
    setSigning(true);
    try {
      await api.post(`/agreements/${id}/sign`, { signature: `${agreement.full_name} · ${new Date().toLocaleString('en-ZA')}` });
      toast.success('Agreement signed electronically');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not sign agreement');
    } finally {
      setSigning(false);
    }
  };

  return (
    <>
      <Link to="/agreements" className="muted text-sm">← Back to agreements</Link>
      <div className="flex-between mt-2 mb-4">
        <div>
          <h1 className="page-title">{agreement.agreement_no}</h1>
          <div className="muted">{agreement.make} {agreement.model} · {agreement.registration || agreement.vin}</div>
        </div>
        <Badge status={agreement.status} />
      </div>

      {discontinued && (
        <div className="card mb-4" style={{ border: '1px solid var(--danger)', background: 'rgba(239,68,68,0.08)' }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--danger)' }}>Agreement discontinued</div>
          <div className="muted text-sm">Your bike was marked stolen, so this contract has been discontinued and no further payment is required unless OnFleet later recovers the bike and reinstates the agreement.</div>
        </div>
      )}

      <div className="grid grid-4 mb-4">
        <Stat label="Weekly rental" value={fmt(agreement.weekly_amount)} />
        <Stat label="Received" value={fmt(summary.total_paid)} accent="var(--success)" />
        <Stat label="Remaining" value={fmt(summary.remaining)} accent="var(--accent)" />
        <Stat label="Progress" value={`${summary.progress_pct}%`} accent="var(--primary)" />
      </div>

      <div className="card mb-4">
        <div className="flex-between mb-3">
          <h3>Electronic contract</h3>
          <div className="row">
            {agreement.contract_file_path && <a href={agreement.contract_file_path} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">View contract</a>}
            {agreement.signed_contract_path && <a href={agreement.signed_contract_path} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">Signed copy</a>}
            {!agreement.signed_at && !discontinued && <button className="btn btn-sm" onClick={signAgreement} disabled={signing}>{signing ? 'Signing…' : 'Sign now'}</button>}
          </div>
        </div>
        <div className="muted text-sm">The contract now uses the longer OnFleet rental wording structure, including ownership, payment, insurance, breach, and domicilium clauses.</div>
        {agreement.signed_at && <div className="mt-2 text-sm">Signed on {fmtDateTime(agreement.signed_at)}</div>}
      </div>

      <div className="card mb-4">
        <div className="flex-between mb-3" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div>
            <h3>Monthly statement</h3>
            <div className="muted text-sm">View your running monthly statement with bike info, what you have paid so far, and what is still outstanding.</div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <select value={activeMonth} onChange={(e) => setSelectedMonth(e.target.value)} style={{ minWidth: 180 }}>
              {monthOptions.map((option) => <option key={option} value={option}>{monthLabel(option)}</option>)}
            </select>
            <button className="btn btn-secondary btn-sm" onClick={() => downloadStatementPdf(agreement, statement)}>Download PDF statement</button>
          </div>
        </div>
        <div className="grid grid-4 mb-4">
          <div className="stat"><div className="stat-label">Paid this month</div><div className="stat-value">{fmt(statement.statementPaid)}</div><div className="stat-delta muted">{statement.paymentCount} successful payments</div></div>
          <div className="stat"><div className="stat-label">Scheduled this month</div><div className="stat-value">{fmt(statement.scheduledThisMonth)}</div></div>
          <div className="stat"><div className="stat-label">Total paid to date</div><div className="stat-value">{fmt(statement.totalPaidToDate)}</div></div>
          <div className="stat"><div className="stat-label">Outstanding</div><div className="stat-value">{fmt(statement.remainingOutstanding)}</div></div>
        </div>
        <div className="grid grid-2">
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <h4 className="mb-2">Bike information</h4>
            <div className="muted text-sm">{agreement.make} {agreement.model}</div>
            <div className="muted text-sm">Reference: {agreement.registration || agreement.vin}</div>
            <div className="muted text-sm">Agreement no: {agreement.agreement_no}</div>
            <div className="muted text-sm">Statement month: {statement.monthLabel}</div>
          </div>
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <h4 className="mb-2">Next due</h4>
            {statement.nextDue ? (
              <>
                <div className="muted text-sm">Due date: {fmtDate(statement.nextDue.due_date)}</div>
                <div className="muted text-sm">Amount: {fmt(statement.nextDue.amount_due - statement.nextDue.amount_paid)}</div>
                <div className="muted text-sm">Status: {statement.nextDue.status}</div>
              </>
            ) : <div className="muted text-sm">{discontinued ? 'No payment is currently required on this discontinued agreement.' : 'No unpaid instalments remain.'}</div>}
          </div>
        </div>
        <div className="mt-4">
          <h4 className="mb-2">Payments in {statement.monthLabel}</h4>
          <table className="table">
            <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Rental</th><th>Fee</th><th>Gross</th></tr></thead>
            <tbody>
              {statement.statementPayments.map((payment) => (
                <tr key={payment.id}>
                  <td>{fmtDate(payment.paid_at || payment.created_at)}</td>
                  <td><Badge>{payment.method}</Badge></td>
                  <td className="text-xs muted">{payment.reference}</td>
                  <td><strong>{fmt(creditedAmount(payment))}</strong></td>
                  <td>{feeAmount(payment) > 0 ? fmt(feeAmount(payment)) : '—'}</td>
                  <td>{fmt(grossAmount(payment))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!statement.statementPayments.length && <div className="muted text-sm">No successful payments were recorded for this month.</div>}
        </div>
      </div>

      <div className="card mb-4">
        <h3 className="mb-3">Progress to ownership</h3>
        <div className="progress-bar"><div className="progress-fill" style={{ width: `${summary.progress_pct}%` }} /></div></div>
        <div className="flex-between mt-3 text-sm">
          <div className="muted">Started {fmtDate(agreement.start_date)}</div>
          <div className="muted">{summary.weeks_paid} of {summary.weeks_total} weeks</div>
          <div className="muted">Ownership {fmtDate(agreement.end_date)}</div>
        </div>
      </div>

      {currentPos && (
        <div className="card mb-4">
          <div className="card-title"><h3>Live bike location</h3><div className="muted text-xs">Last seen {fmtDateTime(bike.bike.last_location_at)}</div></div>
          <div style={{ height: 360, borderRadius: 12, overflow: 'hidden' }}>
            <MapContainer center={currentPos} zoom={13} style={{ height: '100%' }}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <Marker position={currentPos} icon={bikeIcon}><Popup>{agreement.make} {agreement.model}<br />{agreement.registration}</Popup></Marker>
              {positions.length > 1 && <Polyline positions={positions} color="#1E88D1" weight={3} opacity={0.7} />}
            </MapContainer>
          </div>
        </div>
      )}

      <div className="grid grid-2 mb-4">
        <div className="card">
          <div className="card-title"><h3>Payment schedule</h3>{!discontinued && <Link to="/payments" className="btn btn-sm">Pay now</Link>}</div>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>#</th><th>Due</th><th>Amount</th><th>Paid</th><th>Status</th></tr></thead>
              <tbody>
                {schedule.map((row) => (
                  <tr key={row.id}><td>{row.week_number}</td><td>{fmtDate(row.due_date)}</td><td>{fmt(row.amount_due)}</td><td>{fmt(row.amount_paid)}</td><td><Badge status={row.status} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3 className="mb-3">Payment history</h3>
          {!payments.length && <div className="muted text-sm">No payments yet.</div>}
          <table className="table">
            <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Rental</th><th>Fee</th><th>Gross</th></tr></thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td>{fmtDate(payment.paid_at || payment.created_at)}</td>
                  <td><Badge>{payment.method}</Badge></td>
                  <td className="text-xs muted">{payment.reference}</td>
                  <td><strong>{fmt(creditedAmount(payment))}</strong></td>
                  <td>{feeAmount(payment) > 0 ? fmt(feeAmount(payment)) : '—'}</td>
                  <td>{fmt(grossAmount(payment))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-2 mb-4">
        <div className="card">
          <h3 className="mb-3">Bike care education</h3>
          <div className="grid grid-2">
            {CARE_TIPS.map((tip) => (
              <div key={tip.title} className="card" style={{ background: 'var(--surface-2)' }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>{tip.title}</div>
                <div className="muted text-sm">{tip.text}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h3 className="mb-3">Book a service</h3>
          {SERVICE_BOOKING_LINKS.map((booking) => (
            <div key={booking.name} className="card mb-3" style={{ background: 'var(--surface-2)' }}>
              <div className="flex-between" style={{ gap: 12, alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{booking.name} · {booking.city}</div>
                  <div className="muted text-sm" style={{ marginTop: 6 }}>{booking.description}</div>
                </div>
                <a className="btn btn-secondary btn-sm" href={booking.url} target="_blank" rel="noreferrer">Book now</a>
              </div>
            </div>
          ))}
          <div className="muted text-sm">Use the Google booking link for the workshop closest to you. If the bike feels unsafe to ride, contact OnFleet before travelling to the workshop.</div>
        </div>
      </div>
    </>
  );
}
