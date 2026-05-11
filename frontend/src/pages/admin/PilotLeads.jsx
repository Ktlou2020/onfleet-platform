import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../api';
import { Badge, EmptyState, Loading, Pagination, SearchInput, Stat, fmtDateTime, matchesSearch } from '../../components/ui';
import { Briefcase, CalendarCheck2, Rocket, Trophy } from 'lucide-react';

const statusOptions = ['all', 'new', 'contacted', 'demo_scheduled', 'trial_started', 'converted', 'archived'];

export default function AdminPilotLeads() {
  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState([]);
  const [stats, setStats] = useState({ total: 0, new: 0, demos: 0, trials: 0, converted: 0 });
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState({ status: 'new', notes: '' });

  const load = async (nextStatus = status, nextSearch = search) => {
    setLoading(true);
    try {
      const { data } = await api.get('/pilot/leads', {
        params: {
          ...(nextStatus && nextStatus !== 'all' ? { status: nextStatus } : {}),
          ...(nextSearch ? { search: nextSearch } : {})
        }
      });
      setLeads(Array.isArray(data?.leads) ? data.leads : []);
      setStats(data?.stats || { total: 0, new: 0, demos: 0, trials: 0, converted: 0 });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load pilot leads');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { setPage(1); }, [status, search]);

  const filtered = useMemo(() => (leads || []).filter((lead) => matchesSearch(
    search,
    lead.company_name,
    lead.contact_name,
    lead.email,
    lead.phone,
    lead.city,
    lead.plan_interest,
    lead.notes,
    lead.status,
    lead.source,
    lead.fleet_size
  )), [leads, search]);

  const pagination = useMemo(() => {
    const totalItems = filtered.length;
    const safePageSize = Math.max(1, pageSize || 10);
    const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * safePageSize;
    return {
      items: filtered.slice(startIndex, startIndex + safePageSize),
      currentPage,
      totalItems
    };
  }, [filtered, page, pageSize]);

  const selectedLead = useMemo(() => leads.find((lead) => lead.id === selectedLeadId) || pagination.items[0] || null, [leads, selectedLeadId, pagination.items]);

  useEffect(() => {
    if (!selectedLead) return;
    setSelectedLeadId(selectedLead.id);
    setEditor({ status: selectedLead.status || 'new', notes: selectedLead.notes || '' });
  }, [selectedLead?.id]);

  const saveLead = async () => {
    if (!selectedLead) return;
    setSaving(true);
    try {
      const { data } = await api.patch(`/pilot/leads/${selectedLead.id}`, editor);
      const updatedLead = data?.lead;
      setLeads((prev) => prev.map((lead) => lead.id === updatedLead.id ? updatedLead : lead));
      toast.success('Pilot lead updated');
      load(status, search);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update lead');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-title">Fleet-owner pilot</div>
      <div className="page-sub">Capture pilot interest from fleet owners, route demos, and move strong operators into trial or conversion.</div>

      <div className="grid grid-4 mb-4">
        <Stat label="Pilot leads" value={stats.total || 0} icon={<Briefcase size={16} />} />
        <Stat label="New" value={stats.new || 0} icon={<Rocket size={16} />} />
        <Stat label="Demos scheduled" value={stats.demos || 0} icon={<CalendarCheck2 size={16} />} />
        <Stat label="Converted" value={stats.converted || 0} icon={<Trophy size={16} />} />
      </div>

      <div className="card mb-4 pilot-admin-filters">
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>Pipeline</h3>
            <div className="muted text-sm">New lead → contacted → demo scheduled → trial started → converted</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => load(status, search)} disabled={loading}>Refresh</button>
        </div>
        <div className="row mt-4" style={{ flexWrap: 'wrap', alignItems: 'end' }}>
          <div style={{ minWidth: 180 }}>
            <label className="label">Status</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); load(e.target.value, search); }}>
              {statusOptions.map((value) => <option key={value} value={value}>{value === 'all' ? 'All statuses' : value.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <label className="label">Search</label>
            <SearchInput value={search} onChange={(value) => { setSearch(value); load(status, value); }} placeholder="Search company, contact, city, plan, notes" style={{ width: '100%' }} />
          </div>
        </div>
      </div>

      {loading ? <Loading /> : !filtered.length ? (
        <EmptyState title="No pilot leads yet" sub="Once a fleet owner submits the public pilot form, the lead will show up here for follow-up." />
      ) : (
        <div className="pilot-admin-layout">
          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Plan</th>
                  <th>Fleet size</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {pagination.items.map((lead) => (
                  <tr key={lead.id} onClick={() => setSelectedLeadId(lead.id)} style={{ cursor: 'pointer', outline: selectedLeadId === lead.id ? '1px solid rgba(79,168,224,0.4)' : 'none' }}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{lead.company_name}</div>
                      <div className="muted text-sm">{lead.contact_name} · {lead.email}</div>
                    </td>
                    <td><Badge status="active">{String(lead.plan_interest || 'trial').replace(/_/g, ' ')}</Badge></td>
                    <td>{lead.fleet_size || '—'}</td>
                    <td><Badge status={lead.status}>{String(lead.status || 'new').replace(/_/g, ' ')}</Badge></td>
                    <td>{fmtDateTime(lead.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination
              page={pagination.currentPage}
              pageSize={pageSize}
              totalItems={pagination.totalItems}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              label="pilot leads"
            />
          </div>

          <div className="card pilot-admin-editor">
            {selectedLead ? (
              <>
                <div className="flex-between gap-3" style={{ alignItems: 'flex-start' }}>
                  <div>
                    <h3>{selectedLead.company_name}</h3>
                    <div className="muted text-sm">{selectedLead.contact_name}</div>
                  </div>
                  <Badge status={selectedLead.status}>{String(selectedLead.status).replace(/_/g, ' ')}</Badge>
                </div>
                <div className="grid grid-2 mt-4">
                  <div>
                    <div className="label">Email</div>
                    <div>{selectedLead.email}</div>
                  </div>
                  <div>
                    <div className="label">Phone</div>
                    <div>{selectedLead.phone || '—'}</div>
                  </div>
                  <div>
                    <div className="label">City</div>
                    <div>{selectedLead.city || '—'}</div>
                  </div>
                  <div>
                    <div className="label">Fleet size</div>
                    <div>{selectedLead.fleet_size || '—'}</div>
                  </div>
                  <div>
                    <div className="label">Plan interest</div>
                    <div>{String(selectedLead.plan_interest || 'trial').replace(/_/g, ' ')}</div>
                  </div>
                  <div>
                    <div className="label">Demo requested</div>
                    <div>{selectedLead.wants_demo ? 'Yes' : 'No'}</div>
                  </div>
                </div>

                <div className="field mt-4">
                  <label className="label">Lead status</label>
                  <select value={editor.status} onChange={(e) => setEditor((prev) => ({ ...prev, status: e.target.value }))}>
                    {statusOptions.filter((value) => value !== 'all').map((value) => <option key={value} value={value}>{value.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>

                <div className="field">
                  <label className="label">Internal notes</label>
                  <textarea rows="8" value={editor.notes} onChange={(e) => setEditor((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Demo timing, objections, rollout notes, billing blockers" />
                </div>

                <div className="muted text-xs mb-3">Submitted {fmtDateTime(selectedLead.created_at)} · Updated {fmtDateTime(selectedLead.updated_at || selectedLead.created_at)}</div>
                <button className="btn btn-block" onClick={saveLead} disabled={saving}>{saving ? 'Saving…' : 'Save lead update'}</button>
              </>
            ) : (
              <div className="muted">Select a lead to view details.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
