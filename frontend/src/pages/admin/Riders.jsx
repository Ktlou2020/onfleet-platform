import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Loading, Badge, SearchInput, Pagination, EmptyState, fmtDate, matchesSearch, paginateItems } from '../../components/ui';

// Same thresholds as fleet/Riders.jsx and admin/Users.jsx so a score reads
// the same color everywhere it appears across the platform.
function ratingColor(score) {
  if (score >= 70) return '#22c55e';
  if (score >= 40) return '#eab308';
  return '#ef4444';
}
function ratingLabel(score) {
  if (score >= 70) return 'Good';
  if (score >= 40) return 'Watch';
  return 'Needs attention';
}

const RATING_FILTERS = [
  { id: '', label: 'All' },
  { id: 'good', label: 'Good (70+)' },
  { id: 'watch', label: 'Watch (40–69)' },
  { id: 'attention', label: 'Needs attention (<40)' },
  { id: 'unrated', label: 'No rating yet' },
];

export default function AdminRiders() {
  const [riders, setRiders] = useState(null);
  const [scorecards, setScorecards] = useState({}); // user_id -> scorecard
  const [search, setSearch] = useState('');
  const [ratingFilter, setRatingFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = async () => {
    const [usersRes, scorecardsRes] = await Promise.all([
      api.get('/admin/users', { params: { role: 'rider' } }),
      api.get('/admin/riders/scorecards').catch(() => ({ data: { riders: [] } })),
    ]);
    setRiders(usersRes.data.users || []);
    setScorecards(Object.fromEntries((scorecardsRes.data.riders || []).map((r) => [r.user_id, r])));
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { setPage(1); }, [search, ratingFilter]);

  const merged = useMemo(() => (riders || []).map((r) => ({ ...r, scorecard: scorecards[r.id] || null })), [riders, scorecards]);

  const filtered = useMemo(() => merged
    .filter((r) => {
      if (ratingFilter === 'unrated') return !r.scorecard;
      if (ratingFilter && !r.scorecard) return false;
      if (ratingFilter === 'good') return r.scorecard.score >= 70;
      if (ratingFilter === 'watch') return r.scorecard.score >= 40 && r.scorecard.score < 70;
      if (ratingFilter === 'attention') return r.scorecard.score < 40;
      return true;
    })
    .filter((r) => matchesSearch(search, r.full_name, r.email, r.phone, r.scorecard?.bike_registration))
    // Lowest (worst) rating first so riders needing attention surface immediately; unrated riders last.
    .sort((a, b) => {
      if (a.scorecard && b.scorecard) return a.scorecard.score - b.scorecard.score;
      if (a.scorecard) return -1;
      if (b.scorecard) return 1;
      return (a.full_name || '').localeCompare(b.full_name || '');
    }),
  [merged, search, ratingFilter]);

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  if (!riders) return <Loading />;

  return (
    <>
      <div className="flex-between mb-3" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Riders</h1>
          <p className="page-sub">All riders and their reliability ratings — computed live from alert history, payment record, and address verification.</p>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="flex-between" style={{ padding: 16, gap: 12, flexWrap: 'wrap' }}>
          <strong>{filtered.length} rider{filtered.length === 1 ? '' : 's'}</strong>
          <SearchInput value={search} onChange={setSearch} placeholder="Search rider, email, phone, bike" style={{ flex: '1 1 220px', maxWidth: 380 }} />
        </div>
        <div className="filter-pills" style={{ padding: '0 16px 12px' }}>
          {RATING_FILTERS.map((f) => (
            <button key={f.id} className={`filter-pill ${ratingFilter === f.id ? 'active' : ''}`} onClick={() => setRatingFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Rider</th>
                <th className="col-mobile-hide">Bike</th>
                <th>Status</th>
                <th>Rating</th>
                <th className="col-mobile-hide">Payments</th>
                <th className="col-mobile-hide">Address</th>
                <th className="col-mobile-hide">Joined</th>
              </tr>
            </thead>
            <tbody>
              {pagination.items.map((r) => {
                const sc = r.scorecard;
                return (
                  <tr key={r.id}>
                    <td>
                      {r.full_name}
                      <div className="text-xs muted">{r.email} · {r.phone || '—'}</div>
                    </td>
                    <td className="col-mobile-hide">
                      {sc?.bike_registration
                        ? <Link to={`/admin/tracking?bike=${sc.bike_id}`}>{sc.bike_registration}</Link>
                        : <span className="muted text-xs">No active agreement</span>}
                    </td>
                    <td><Badge status={r.status} /></td>
                    <td>
                      {sc ? (
                        <span
                          title={`${sc.critical_alerts_90d} critical alert(s), ${sc.driving_alerts_90d} driving alert(s) in last 90d`}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700,
                            padding: '3px 10px', borderRadius: 100, color: ratingColor(sc.score),
                            background: `${ratingColor(sc.score)}26`,
                          }}
                        >
                          {sc.score} · {ratingLabel(sc.score)}
                        </span>
                      ) : <span className="muted text-xs" title="No active agreement to score">—</span>}
                    </td>
                    <td className="col-mobile-hide">{sc ? `${sc.payment_late_or_overdue}/${sc.payment_reckoned} late or overdue` : '—'}</td>
                    <td className="col-mobile-hide">{sc?.address_match_status || '—'}</td>
                    <td className="col-mobile-hide">{fmtDate(r.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!pagination.items.length && <EmptyState title="No riders match your filters" sub="Try clearing the search or rating filter." />}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="riders" />
    </>
  );
}
