import { useEffect, useMemo, useState } from 'react';
import { Badge, EmptyState, Loading, SearchInput, Stat, fmt, fmtDate, fmtDateTime, matchesSearch } from '../../components/ui';
import api from '../../api';
import toast from 'react-hot-toast';
import { Briefcase, CreditCard, AlertTriangle, Wallet, Building2, Bike, FileText, Users } from 'lucide-react';

const payerFilterOptions = [
  { value: 'all', label: 'All billing states' },
  { value: 'payer', label: 'Payers' },
  { value: 'non_payer', label: 'Non-payers' }
];

function payerStatusLabel(value) {
  return value === 'payer' ? 'Payer' : 'Non-payer';
}

export default function AdminFleetDashboard() {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);
  const [organizations, setOrganizations] = useState([]);
  const [search, setSearch] = useState('');
  const [payerFilter, setPayerFilter] = useState('all');

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/fleet-owners/dashboard');
      setSummary(data?.summary || null);
      setOrganizations(Array.isArray(data?.organizations) ? data.organizations : []);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load fleet-owner dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => organizations.filter((organization) => {
    if (payerFilter !== 'all' && organization.payer_status !== payerFilter) return false;
    return matchesSearch(
      search,
      organization.name,
      organization.slug,
      organization.contact_email,
      organization.contact_phone,
      organization.city,
      organization.plan_key,
      organization.status,
      organization.payer_status,
      organization.fleet_size,
      organization.member_count,
      organization.bike_count
    );
  }), [organizations, payerFilter, search]);

  const topNonPayers = useMemo(() => filtered
    .filter((organization) => organization.payer_status === 'non_payer')
    .sort((a, b) => Number(b.overdue_amount || 0) - Number(a.overdue_amount || 0))
    .slice(0, 5), [filtered]);

  if (loading) return <Loading />;

  return (
    <div>
      <div className="flex-between mb-2" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h1 className="page-title">Fleet owner dashboard</h1>
          <p className="page-sub">Monitor fleet organizations, identify payers and non-payers, and track live operational usage across the fleet-owner platform.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>Refresh</button>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Fleet organizations" value={summary?.organizations || 0} icon={<Building2 size={16} />} />
        <Stat label="Payers · 30 days" value={summary?.payers_30d || 0} icon={<Wallet size={16} />} />
        <Stat label="Non-payers · 30 days" value={summary?.non_payers_30d || 0} icon={<AlertTriangle size={16} />} />
        <Stat label="Fleet owner users" value={summary?.fleet_owner_users || 0} icon={<Users size={16} />} />
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Revenue · 30 days" value={fmt(summary?.revenue_30d || 0)} icon={<CreditCard size={16} />} />
        <Stat label="Overdue amount" value={fmt(summary?.overdue_amount || 0)} icon={<AlertTriangle size={16} />} />
        <Stat label="Active bikes" value={summary?.active_bikes || 0} icon={<Bike size={16} />} />
        <Stat label="Open agreements" value={summary?.open_agreements || 0} icon={<FileText size={16} />} />
      </div>

      <div className="card mb-4">
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'end', gap: 12 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>Fleet billing analytics</h3>
            <div className="muted text-sm">Payer status is based on successful fleet payment activity in the last 30 days.</div>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search company, city, plan or contact" style={{ minWidth: 280 }} />
            <div style={{ minWidth: 180 }}>
              <label className="label">Payer status</label>
              <select value={payerFilter} onChange={(e) => setPayerFilter(e.target.value)}>
                {payerFilterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      {!filtered.length ? (
        <EmptyState title="No fleet organizations found" sub="Create a fleet company account to start tracking fleet-owner analytics here." />
      ) : (
        <div className="grid grid-2" style={{ alignItems: 'start' }}>
          <div className="card" style={{ overflowX: 'auto' }}>
            <div className="card-title"><h3>Organizations</h3><Badge status="active">{filtered.length} visible</Badge></div>
            <table className="table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Plan</th>
                  <th>Billing</th>
                  <th>Payer</th>
                  <th>Members</th>
                  <th>Bikes</th>
                  <th>Open agreements</th>
                  <th>Revenue · 30d</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((organization) => (
                  <tr key={organization.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{organization.name}</div>
                      <div className="text-xs muted">{organization.contact_email || 'No contact email'} · {organization.city || '—'}</div>
                    </td>
                    <td><Badge status="active">{String(organization.plan_key || 'trial').replace(/_/g, ' ')}</Badge></td>
                    <td><Badge status={organization.status}>{String(organization.status || 'trialing').replace(/_/g, ' ')}</Badge></td>
                    <td><Badge status={organization.payer_status === 'payer' ? 'success' : 'overdue'}>{payerStatusLabel(organization.payer_status)}</Badge></td>
                    <td>{organization.active_member_count}/{organization.member_count}</td>
                    <td>{organization.active_bikes}/{organization.bike_count}</td>
                    <td>{organization.open_agreements}</td>
                    <td>
                      <strong>{fmt(organization.revenue_30d || 0)}</strong>
                      <div className="text-xs muted">Last payment {fmtDateTime(organization.last_payment_at)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid" style={{ gap: 16 }}>
            <div className="card">
              <div className="card-title"><h3>Billing mix</h3><Badge status="info">Live</Badge></div>
              <div className="grid grid-2">
                <div>
                  <div className="label">Trialing</div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{summary?.trialing || 0}</div>
                </div>
                <div>
                  <div className="label">Active</div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{summary?.active || 0}</div>
                </div>
                <div>
                  <div className="label">Past due</div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{summary?.past_due || 0}</div>
                </div>
                <div>
                  <div className="label">Suspended</div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{summary?.suspended || 0}</div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title"><h3>Top non-payers</h3><Badge status="overdue">Needs attention</Badge></div>
              {!topNonPayers.length ? (
                <div className="muted text-sm">Every visible organization has recorded successful payments in the last 30 days.</div>
              ) : (
                <div className="fleet-demo-list">
                  {topNonPayers.map((organization) => (
                    <div key={organization.id} className="fleet-demo-list-item" style={{ alignItems: 'flex-start' }}>
                      <Briefcase size={16} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{organization.name}</div>
                        <div className="muted text-sm">{organization.open_agreements} open agreements · {organization.active_bikes}/{organization.bike_count} active bikes</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 700 }}>{fmt(organization.overdue_amount || 0)}</div>
                        <div className="text-xs muted">Last payment {fmtDate(organization.last_payment_at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
