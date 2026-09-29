import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, EmptyState, Loading, fmtDate } from '../../components/ui';
import { Siren, ShieldAlert } from 'lucide-react';

// Theft cases and insurance claims for this fleet's bikes.
//
// Both scope through bikes, which is the only thing either is attached to.

const THEFT_TONE = { open: 'danger', with_police: 'warning', recovered: 'success', false_alarm: '', written_off: 'danger' };

export default function FleetSecurity() {
  const [theft, setTheft] = useState([]);
  const [claims, setClaims] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        api.get('/fleet/theft-cases'),
        api.get('/fleet/claims'),
      ]);
      setTheft(t.data.theft_cases || []);
      setClaims(c.data.claims || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load theft and claims');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  if (loading) return <Loading />;

  return (
    <>
      <h1>Theft &amp; claims</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Cases opened on your bikes, and the claims that followed.
      </p>

      <h2 style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Siren size={18} /> Theft cases
      </h2>
      {theft.length === 0 ? (
        <EmptyState title="No theft cases"
                    sub="A case opens itself when a bike is tampered with or towed." />
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr><th>Bike</th><th>Status</th><th>Opened</th><th>Police ref</th><th>Closed</th></tr></thead>
            <tbody>
              {theft.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.registration}</strong><div className="text-xs muted">{c.make} {c.model}</div></td>
                  <td><Badge status={THEFT_TONE[c.status] || ''}>{String(c.status).replace(/_/g, ' ')}</Badge></td>
                  <td>{fmtDate(c.opened_at)}</td>
                  <td>{c.police_reference || '—'}</td>
                  <td>{c.closed_at ? fmtDate(c.closed_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 26, display: 'flex', alignItems: 'center', gap: 8 }}>
        <ShieldAlert size={18} /> Insurance claims
      </h2>
      {claims.length === 0 ? (
        <EmptyState title="No claims" sub="Claims raised against your bikes will appear here." />
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr><th>Bike</th><th>Type</th><th>What happened</th><th>Status</th></tr></thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.registration}</strong><div className="text-xs muted">{c.make} {c.model}</div></td>
                  <td>{c.claim_type}</td>
                  <td style={{ maxWidth: 340 }}>{c.description}</td>
                  <td><Badge status={c.status === 'settled' ? 'success' : 'info'}>{String(c.status).replace(/_/g, ' ')}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
