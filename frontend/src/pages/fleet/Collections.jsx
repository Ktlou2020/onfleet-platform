import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, ConfirmModal, EmptyState, Loading, SearchInput, fmt, fmtDate, matchesSearch } from '../../components/ui';
import { ChevronDown, ChevronRight, Zap, ZapOff, Wifi, WifiOff } from 'lucide-react';
import { canManageFleetSection } from './access';

const STAGES = ['pending', 'contacted', 'notice_sent', 'recovery', 'resolved'];
const ACTION_TYPES = ['call', 'sms', 'whatsapp', 'email', 'visit', 'legal_notice', 'repo', 'note'];

const STAGE_COLORS = {
  pending: 'var(--warning)',
  contacted: 'var(--primary)',
  notice_sent: 'var(--accent)',
  recovery: 'var(--danger)',
  resolved: 'var(--success)'
};

function buildActionForm() {
  return { stage: 'contacted', action_type: 'call', notes: '', outcome: '', next_action_date: '' };
}

export default function Collections() {
  const { user } = useAuth();
  const canManage = canManageFleetSection(user?.role, 'collections');
  const canImmobilise = canManageFleetSection(user?.role, 'tracking');
  const [loading, setLoading] = useState(true);
  const [collections, setCollections] = useState([]);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [actions, setActions] = useState({});
  const [actionForm, setActionForm] = useState(buildActionForm());
  const [saving, setSaving] = useState(false);
  const [loadingActions, setLoadingActions] = useState(false);
  const [immobModal, setImmobModal] = useState(null); // { item, preset }
  const [immobBusy, setImmobBusy] = useState(false);

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/fleet/collections');
      setCollections(data.collections || []);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load collections');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => collections.filter((item) => {
    if (stageFilter && item.current_stage !== stageFilter) return false;
    return matchesSearch(search, item.rider_name, item.agreement_no, item.bike_registration, item.current_stage);
  }), [collections, search, stageFilter]);

  const toggleExpand = async (id) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    setActionForm(buildActionForm());
    if (!actions[id]) {
      setLoadingActions(true);
      try {
        const { data } = await api.get(`/fleet/collections/${id}/actions`);
        setActions((prev) => ({ ...prev, [id]: data.actions || [] }));
      } catch {
        setActions((prev) => ({ ...prev, [id]: [] }));
      } finally {
        setLoadingActions(false);
      }
    }
  };

  const submitAction = async (agreementId) => {
    if (!actionForm.action_type || !actionForm.stage) return toast.error('Stage and action type are required');
    setSaving(true);
    try {
      const { data } = await api.post(`/fleet/collections/${agreementId}/action`, actionForm);
      setActions((prev) => ({ ...prev, [agreementId]: [data.action, ...(prev[agreementId] || [])] }));
      setCollections((prev) => prev.map((item) => item.id === agreementId ? { ...item, current_stage: actionForm.stage } : item));
      setActionForm(buildActionForm());
      toast.success('Action logged');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not log action');
    } finally {
      setSaving(false);
    }
  };

  const sendCommand = async () => {
    if (!immobModal) return;
    const { item, preset } = immobModal;
    setImmobBusy(true);
    try {
      const { data } = await api.post(`/fleet/tracking/devices${item.tracking_device_id}/commands`, { preset });
      toast.success(data.note || (preset === 'cut_engine' ? 'Immobilisation command sent' : 'Restore command sent'));
      setImmobModal(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Command failed');
    } finally {
      setImmobBusy(false);
    }
  };

  if (loading) return <Loading />;

  return (
    <>
      {immobModal && (
        <ConfirmModal
          title={immobModal.preset === 'cut_engine' ? `Immobilise ${immobModal.item.bike_registration || 'bike'}?` : `Restore ignition — ${immobModal.item.bike_registration || 'bike'}?`}
          body={immobModal.preset === 'cut_engine'
            ? `The bike won't start until you restore ignition. If the device is offline the command will be queued and sent when it reconnects. The rider will not receive an automatic notification.`
            : `The bike's ignition will be restored. If the device is offline the command will be queued.`}
          confirmLabel={immobModal.preset === 'cut_engine' ? 'Immobilise bike' : 'Restore ignition'}
          danger={immobModal.preset === 'cut_engine'}
          busy={immobBusy}
          onConfirm={sendCommand}
          onClose={() => { if (!immobBusy) setImmobModal(null); }}
        />
      )}
      <div className="flex-between mb-4" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Collections</h1>
          <p className="page-sub">Manage overdue and defaulted agreements. Log contact attempts, escalate stages, and track recovery outcomes.</p>
        </div>
        <SearchInput value={search} onChange={setSearch} placeholder="Search rider, agreement, registration" style={{ width: 320 }} />
      </div>
      <div className="filter-pills mb-3">
        <button className={`filter-pill ${stageFilter === '' ? 'active' : ''}`} onClick={() => setStageFilter('')}>All stages</button>
        {STAGES.map((s) => (
          <button key={s} className={`filter-pill ${stageFilter === s ? 'active' : ''}`} onClick={() => setStageFilter(s)} style={{ color: stageFilter === s ? undefined : STAGE_COLORS[s] }}>
            {s.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {!filtered.length && <EmptyState title="No overdue agreements" sub="All agreements are current. Overdue and defaulted agreements will appear here." />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {filtered.map((item) => {
          const isExpanded = expanded === item.id;
          const itemActions = actions[item.id] || [];
          const stageColor = STAGE_COLORS[item.current_stage] || 'var(--muted)';

          return (
            <div key={item.id} className="card" style={{ padding: 0 }}>
              <div
                style={{ padding: 16, cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}
                onClick={() => toggleExpand(item.id)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{item.rider_name || 'Unknown rider'}</div>
                  <div className="text-xs muted">{item.agreement_no} · {item.bike_registration || 'No reg'} · {item.make} {item.model}</div>
                  <div className="text-xs muted">{item.rider_email} {item.rider_phone ? `· ${item.rider_phone}` : ''}</div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 700, color: 'var(--danger)' }}>{fmt(item.overdue_balance)}</div>
                    <div className="text-xs muted">{item.days_overdue} days overdue</div>
                  </div>
                  <span style={{ padding: '4px 10px', borderRadius: 100, fontSize: 12, fontWeight: 600, background: `${stageColor}20`, color: stageColor }}>
                    {item.current_stage.replace(/_/g, ' ')}
                  </span>
                  <Badge status={item.status} />
                  {canImmobilise && item.tracking_device_id && (
                    <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                      <span title={item.device_connected ? 'Device online' : 'Device offline — command will queue'} style={{ display: 'flex', alignItems: 'center', color: item.device_connected ? 'var(--success)' : 'var(--muted)' }}>
                        {item.device_connected ? <Wifi size={13} /> : <WifiOff size={13} />}
                      </span>
                      <button
                        className="btn btn-sm btn-danger"
                        style={{ padding: '3px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                        onClick={() => setImmobModal({ item, preset: 'cut_engine' })}
                        title="Immobilise bike"
                      >
                        <ZapOff size={12} /> Immobilise
                      </button>
                      <button
                        className="btn btn-sm btn-secondary"
                        style={{ padding: '3px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                        onClick={() => setImmobModal({ item, preset: 'restore_engine' })}
                        title="Restore ignition"
                      >
                        <Zap size={12} /> Restore
                      </button>
                    </div>
                  )}
                  {isExpanded ? <ChevronDown size={16} style={{ color: 'var(--muted)' }} /> : <ChevronRight size={16} style={{ color: 'var(--muted)' }} />}
                </div>
              </div>

              {isExpanded && (
                <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
                  {canManage && (
                    <div className="card mb-4" style={{ background: 'var(--surface-2)' }}>
                      <h4 className="mb-3">Log action</h4>
                      <div className="grid grid-2">
                        <div className="field">
                          <label className="label">Stage</label>
                          <select value={actionForm.stage} onChange={(e) => setActionForm((f) => ({ ...f, stage: e.target.value }))}>
                            {STAGES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                          </select>
                        </div>
                        <div className="field">
                          <label className="label">Action type</label>
                          <select value={actionForm.action_type} onChange={(e) => setActionForm((f) => ({ ...f, action_type: e.target.value }))}>
                            {ACTION_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                          </select>
                        </div>
                        <div className="field">
                          <label className="label">Notes</label>
                          <textarea rows={3} value={actionForm.notes} onChange={(e) => setActionForm((f) => ({ ...f, notes: e.target.value }))} placeholder="What happened?" />
                        </div>
                        <div className="field">
                          <label className="label">Outcome</label>
                          <input value={actionForm.outcome} onChange={(e) => setActionForm((f) => ({ ...f, outcome: e.target.value }))} placeholder="Result or next steps" />
                        </div>
                        <div className="field">
                          <label className="label">Next action date</label>
                          <input type="date" value={actionForm.next_action_date} onChange={(e) => setActionForm((f) => ({ ...f, next_action_date: e.target.value }))} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                          <button className="btn" disabled={saving} onClick={() => submitAction(item.id)} style={{ width: '100%' }}>
                            {saving ? 'Saving…' : 'Log action'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <h4 className="mb-2">Action history</h4>
                  {loadingActions && !itemActions.length ? (
                    <div className="muted text-sm">Loading…</div>
                  ) : !itemActions.length ? (
                    <div className="muted text-sm">No actions logged yet.</div>
                  ) : (
                    <table className="table">
                      <thead><tr><th>Date</th><th>Stage</th><th>Type</th><th>Notes</th><th>Outcome</th><th>Next date</th><th>By</th></tr></thead>
                      <tbody>
                        {itemActions.map((action) => (
                          <tr key={action.id}>
                            <td>{fmtDate(action.created_at)}</td>
                            <td><span style={{ padding: '2px 8px', borderRadius: 100, fontSize: 11, background: `${STAGE_COLORS[action.stage] || 'var(--muted)'}20`, color: STAGE_COLORS[action.stage] || 'var(--muted)' }}>{action.stage.replace(/_/g, ' ')}</span></td>
                            <td>{action.action_type.replace(/_/g, ' ')}</td>
                            <td className="text-xs">{action.notes || '—'}</td>
                            <td className="text-xs">{action.outcome || '—'}</td>
                            <td className="text-xs">{action.next_action_date ? fmtDate(action.next_action_date) : '—'}</td>
                            <td className="text-xs muted">{action.created_by_name || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
