import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowDownLeft, ArrowUpRight, RefreshCw, Smartphone } from 'lucide-react';
import api from '../../api';
import { Loading, EmptyState, Badge, fmt, fmtDateTime, SearchInput, matchesSearch } from '../../components/ui';

// MTN MoMo, from the operator's side.
//
// Three questions, in the order somebody actually asks them: is it connected,
// is there money in the float, and what has moved. The float matters more
// than it looks — a disbursement fails when the account behind it is empty,
// and the first anyone hears of that is usually a fleet owner asking where
// their payout is.

const STATUS_TONE = { successful: 'success', pending: 'warning', failed: 'danger' };

function Float({ label, icon: Icon, data }) {
  const broken = !data || data.error;
  return (
    <div className="card">
      <div className="row text-xs muted" style={{ gap: 6, alignItems: 'center' }}>
        <Icon size={13} /> {label}
      </div>
      {broken ? (
        <div className="text-sm" style={{ color: 'var(--muted)', marginTop: 6 }}>
          {data?.error ? 'MTN did not answer' : 'Not connected'}
        </div>
      ) : (
        <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>
          {Number(data.availableBalance).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}
          <span className="text-xs muted" style={{ marginLeft: 6 }}>{data.currency}</span>
        </div>
      )}
    </div>
  );
}

export default function AdminMomo() {
  const [status, setStatus] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, t] = await Promise.all([api.get('/momo/status'), api.get('/momo/transactions')]);
      setStatus(s.data);
      setTransactions(t.data.transactions || []);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not read the MoMo status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const reconcile = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/momo/reconcile', { limit: 100 });
      toast.success(data.skipped
        ? 'MoMo is not connected yet'
        : `Checked ${data.checked}, settled ${data.settled}`);
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not reach MTN');
    } finally { setBusy(false); }
  };

  if (loading && !status) return <Loading />;

  const connected = status?.collection_configured || status?.disbursement_configured;
  const shown = transactions.filter((t) => matchesSearch(search,
    t.msisdn, t.external_id, t.reference_id, t.organization_name, t.rider_name, t.status));

  return (
    <div>
      <h1 style={{ marginBottom: 4 }}>MTN MoMo</h1>
      <p className="muted text-sm" style={{ marginTop: 0 }}>
        Riders pay their rent from their wallets; fleet owners are paid out to theirs.
      </p>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <Badge status={connected ? 'active' : 'inactive'}>
          {connected ? 'Connected' : 'Not connected'}
        </Badge>
        {status?.environment && <span className="text-xs muted">{status.environment}</span>}
        {status?.currency && <span className="text-xs muted">· {status.currency}</span>}
        <button className="btn btn-sm btn-secondary" disabled={busy} onClick={reconcile}>
          <RefreshCw size={12} /> {busy ? 'Checking…' : 'Check pending with MTN'}
        </button>
      </div>

      {!connected && (
        <div className="card" style={{ borderColor: 'rgba(245,158,11,0.4)', marginBottom: 14 }}>
          <strong className="text-sm">No MoMo credentials are set.</strong>
          <p className="text-sm muted" style={{ marginBottom: 0 }}>
            Collection and Disbursement each need their own subscription key, API user and API key.
            Until they are set, riders are not offered MoMo and payouts stay on bank transfer.
          </p>
        </div>
      )}

      <div className="grid grid-2" style={{ gap: 12, marginBottom: 18 }}>
        <Float label="Collections float" icon={ArrowDownLeft} data={status?.balances?.collection} />
        <Float label="Payouts float" icon={ArrowUpRight} data={status?.balances?.disbursement} />
      </div>

      {status?.last_30_days?.length > 0 && (
        <div className="row" style={{ gap: 14, flexWrap: 'wrap', marginBottom: 18 }}>
          {status.last_30_days.map((r) => (
            <div key={`${r.direction}-${r.status}`} className="text-sm">
              <span className="muted">{r.direction === 'collection' ? 'In' : 'Out'} · {r.status}</span>{' '}
              <strong>{r.n}</strong> <span className="muted">({fmt(r.total)})</span>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Transactions</h2>
        <SearchInput value={search} onChange={setSearch} placeholder="Number, reference, fleet or rider" />
      </div>

      {shown.length === 0 ? (
        <EmptyState title="Nothing yet" sub="Payments and payouts over MoMo appear here." />
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>When</th>
                <th style={{ textAlign: 'left' }}>Direction</th>
                <th style={{ textAlign: 'left' }}>Who</th>
                <th style={{ textAlign: 'left' }}>Number</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th style={{ textAlign: 'left' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td className="text-xs muted">{fmtDateTime(t.requested_at)}</td>
                  <td>
                    {t.direction === 'collection'
                      ? <span><ArrowDownLeft size={11} /> In</span>
                      : <span><ArrowUpRight size={11} /> Out</span>}
                  </td>
                  <td>{t.rider_name || t.organization_name || '—'}</td>
                  <td className="text-xs">{t.msisdn}</td>
                  <td style={{ textAlign: 'right' }}>{Number(t.amount).toFixed(2)} {t.currency}</td>
                  <td>
                    <Badge status={STATUS_TONE[t.status] || 'inactive'}>{t.status}</Badge>
                    {t.momo_reason && <div className="text-xs muted">{t.momo_reason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs muted" style={{ marginTop: 16 }}>
        <Smartphone size={11} /> MTN's callbacks are unsigned, so a callback is only ever a prompt to ask
        MTN directly what happened. Anything still pending is re-checked every five minutes.
      </p>
    </div>
  );
}
