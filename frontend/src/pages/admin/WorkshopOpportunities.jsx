import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { EmptyState, Loading, Stat, fmt, fmtDate } from '../../components/ui';
import { CalendarClock, FileQuestion, PauseCircle, Package, PhoneOff, Wrench } from 'lucide-react';

// What the workshop could be earning, as opposed to what it is earning.
//
// The Workshop page already answers "what is in the shop": jobs open, revenue
// billed, who is working on what. This answers the other question — where is
// money sitting that nobody has gone and got — which is the one you cannot
// see by walking around the workshop, because none of it is in front of you.
//
// Every panel is a list of specific registrations and names, not a number to
// admire. A dashboard that says "R12,400 in unapproved quotes" and cannot say
// whose has told you nothing you can act on this afternoon.

const WINDOWS = [30, 90, 180];

function Panel({ title, icon, worth, hint, children }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>{icon} {title}</h2>
        {worth != null && <strong style={{ fontSize: 18 }}>{fmt(worth)}</strong>}
      </div>
      {hint && <p className="muted text-sm" style={{ marginTop: 4, marginBottom: 10 }}>{hint}</p>}
      {children}
    </div>
  );
}

const Table = ({ head, rows }) => (
  <div className="table-wrap">
    <table className="table" style={{ width: '100%' }}>
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows}</tbody>
    </table>
  </div>
);

export default function WorkshopOpportunities() {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (window) => {
    setLoading(true);
    try {
      const { data: d } = await api.get('/workshop/admin/opportunities', { params: { days: window } });
      setData(d);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load the opportunities');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [load, days]);
  if (loading && !data) return <Loading />;
  if (!data) return null;

  const { service_due: due, quotes, stalled, parts, on_order: order, gone_quiet: quiet } = data;
  // The margin covers only the lines carrying a part number we hold a price
  // for. Said out loud, because a margin on half the money reads as a margin
  // on all of it.
  const coverage = parts.charged > 0 ? Math.round((parts.charged_costed / parts.charged) * 100) : 0;

  return (
    <>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 className="page-title">Opportunities</h1>
          <p className="page-sub">
            Work that has not been won yet, and what the parts counter is making. Everything
            here is a list you can act on, not a number to look at.
          </p>
        </div>
        <div className="filter-pills">
          {WINDOWS.map((w) => (
            <button key={w} className={`filter-pill ${days === w ? 'active' : ''}`} onClick={() => setDays(w)}>
              {w} days
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-4" style={{ marginTop: 16 }}>
        <Stat label="Overdue for service, nobody asked" value={due.overdue}
              accent={due.overdue ? 'var(--warn)' : undefined} icon={<CalendarClock size={18} />}
              delta={due.overdue ? `about ${fmt(due.worth)} of work` : null} />
        <Stat label="Quotes waiting on a yes" value={quotes.count}
              accent={quotes.count ? 'var(--warn)' : undefined} icon={<FileQuestion size={18} />}
              delta={quotes.count ? fmt(quotes.worth) : null} />
        <Stat label="Parts margin" value={fmt(parts.margin)} icon={<Package size={18} />}
              delta={`on ${coverage}% of parts billed`} />
        <Stat label="Fleets gone quiet" value={quiet.length}
              accent={quiet.length ? 'var(--danger)' : undefined} icon={<PhoneOff size={18} />} />
      </div>

      <Panel title="Due a service, and nobody has asked them in" icon={<CalendarClock size={18} />}
             worth={due.worth}
             hint={`A motorcycle past its service with no job card open and no booking made. Worth is the overdue count at ${fmt(due.average_service)}, what a service has actually billed here over the last ${data.window_days} days.`}>
        {due.bikes.length === 0 ? (
          <EmptyState title="Nothing waiting" sub="Every bike due a service is either booked in or already on a job card." />
        ) : (
          <Table head={['Bike', 'Fleet', 'Odometer', 'Due', 'State']}
                 rows={due.bikes.map((b) => (
                   <tr key={b.id}>
                     <td><strong>{b.registration}</strong><div className="text-xs muted">{b.make} {b.model}</div></td>
                     <td>{b.fleet || '—'}</td>
                     <td>{b.odometer_km != null ? `${Number(b.odometer_km).toLocaleString('en-ZA')} km` : '—'}</td>
                     <td>{fmtDate(b.next_service_date)}</td>
                     <td style={{ color: b.state === 'overdue' ? 'var(--warn)' : undefined }}>
                       {b.state === 'overdue' ? `${b.days_past} days over` : 'due soon'}
                     </td>
                   </tr>
                 ))} />
        )}
      </Panel>

      <Panel title="Quoted, not answered" icon={<FileQuestion size={18} />} worth={quotes.worth}
             hint="They have been told the price and have not said yes. The longer it sits the less likely it becomes.">
        {quotes.items.length === 0 ? (
          <EmptyState title="No quotes outstanding" sub="Everything quoted has been answered." />
        ) : (
          <Table head={['Job', 'Bike', 'Fleet', 'Quoted', 'Waiting']}
                 rows={quotes.items.map((q) => (
                   <tr key={q.id}>
                     <td>#{q.id}</td>
                     <td><strong>{q.registration}</strong></td>
                     <td>{q.fleet || '—'}</td>
                     <td>{fmt(q.quote_amount)}</td>
                     <td style={{ color: q.days_waiting > 14 ? 'var(--warn)' : undefined }}>{q.days_waiting} days</td>
                   </tr>
                 ))} />
        )}
      </Panel>

      <div className="grid grid-2" style={{ gap: 16, alignItems: 'start' }}>
        <Panel title="Accepted, not started" icon={<PauseCircle size={18} />}
               hint="Work somebody is expecting that nobody has picked up.">
          {stalled.items.length === 0 ? (
            <p className="muted text-sm">Nothing stalled.</p>
          ) : stalled.items.map((j) => (
            <div key={j.id} className="flex-between" style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
              <div><strong>{j.registration}</strong> <span className="text-xs muted">{j.job_type} · #{j.id}</span></div>
              <span className="text-sm" style={{ color: 'var(--warn)' }}>{j.days_open} days</span>
            </div>
          ))}
        </Panel>

        <Panel title="On order, not arrived" icon={<Package size={18} />} worth={order.worth}
               hint="Money committed to a supplier and not yet on a shelf.">
          {order.items.length === 0 ? (
            <p className="muted text-sm">Nothing outstanding with a supplier.</p>
          ) : order.items.map((o) => (
            <div key={o.id} className="flex-between" style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
              <div>
                <strong>{o.reference}</strong>
                <div className="text-xs muted">{o.supplier} · {o.lines} lines · {o.status}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div>{o.quoted_total_ex_vat != null ? fmt(o.quoted_total_ex_vat) : '—'}</div>
                <div className="text-xs muted">{o.days_out} days out</div>
              </div>
            </div>
          ))}
        </Panel>
      </div>

      <Panel title="The parts counter" icon={<Wrench size={18} />}
             hint={`Parts billed on completed jobs in the last ${data.window_days} days. Margin is what you charged less the Hero list price, and only lines carrying a part number can be costed — so it covers ${coverage}% of what you billed, not all of it.`}>
        <div className="grid grid-3" style={{ marginBottom: 12 }}>
          <Stat label="Parts billed" value={fmt(parts.charged)} />
          <Stat label="At list price" value={fmt(parts.cost)} />
          <Stat label={`Margin on ${parts.lines_costed} of ${parts.lines} lines`} value={fmt(parts.margin)}
                accent={parts.margin > 0 ? 'var(--success)' : undefined} />
        </div>
        {parts.top.length === 0 ? (
          <EmptyState title="No parts billed yet" sub="Parts fitted on completed jobs will appear here." />
        ) : (
          <Table head={['Part', 'Description', 'Fitted', 'Billed']}
                 rows={parts.top.map((t) => (
                   <tr key={t.part_number}>
                     <td style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{t.part_number}</td>
                     <td>{t.description}</td>
                     <td>{Number(t.qty)}</td>
                     <td>{fmt(t.charged)}</td>
                   </tr>
                 ))} />
        )}
      </Panel>

      <Panel title="Fleets that have gone quiet" icon={<PhoneOff size={18} />}
             hint={`Bikes on the platform, nothing through the workshop in ${data.window_days} days. Nothing happening is not an event, so this is the list nobody notices without being shown it.`}>
        {quiet.length === 0 ? (
          <EmptyState title="Everyone has been in" sub="Every fleet with bikes has had work done recently." />
        ) : (
          <Table head={['Fleet', 'Bikes', 'Last job', 'Quiet for']}
                 rows={quiet.map((o) => (
                   <tr key={o.id}>
                     <td><strong>{o.name}</strong></td>
                     <td>{o.bikes}</td>
                     <td>{o.last_seen ? fmtDate(o.last_seen) : 'never'}</td>
                     <td style={{ color: 'var(--warn)' }}>{o.days_quiet >= 9999 ? 'never been in' : `${o.days_quiet} days`}</td>
                   </tr>
                 ))} />
        )}
      </Panel>
    </>
  );
}
