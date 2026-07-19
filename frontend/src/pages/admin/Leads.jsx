import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, Clock, Calendar, UserCheck, Archive, Mail, Phone, Building2, Users, ChevronRight, RefreshCw, X, Loader2 } from 'lucide-react';
import api from '../../api';

const STATUS_META = {
  new:            { label: 'New',            color: 'var(--primary)',  bg: 'rgba(30,136,209,0.12)' },
  contacted:      { label: 'Contacted',      color: '#f59e0b',         bg: 'rgba(245,158,11,0.12)' },
  demo_scheduled: { label: 'Demo scheduled', color: '#8b5cf6',         bg: 'rgba(139,92,246,0.12)' },
  trial_started:  { label: 'Trial started',  color: '#06b6d4',         bg: 'rgba(6,182,212,0.12)'  },
  converted:      { label: 'Converted',      color: 'var(--success)',  bg: 'rgba(34,197,94,0.12)'  },
  archived:       { label: 'Archived',       color: 'var(--muted)',    bg: 'rgba(107,114,128,0.12)'},
};

const PLAN_LABELS = { trial: 'Trial', small: 'Small', medium: 'Medium', large: 'Large', enterprise: 'Enterprise' };

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, color: 'var(--muted)', bg: 'transparent' };
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, color: meta.color, background: meta.bg, whiteSpace: 'nowrap' }}>
      {meta.label}
    </span>
  );
}

function StatTile({ label, value, color }) {
  return (
    <div className="card" style={{ padding: '16px 20px', minWidth: 110, flex: 1 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || 'var(--fg)' }}>{value}</div>
      <div className="text-xs muted" style={{ marginTop: 2 }}>{label}</div>
    </div>
  );
}

function ContactModal({ lead, onClose, onDone }) {
  const [msg, setMsg] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setBusy(true); setErr('');
    try {
      await api.post(`/pilot/leads/${lead.id}/contact`, { message: msg, send_email: sendEmail });
      onDone();
    } catch (e) {
      setErr(e.response?.data?.error || 'Request failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={{ margin: 0 }}>Mark as contacted</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <p className="text-sm muted" style={{ marginBottom: 16 }}>
          Mark <strong>{lead.contact_name}</strong> at <strong>{lead.company_name}</strong> as contacted. Optionally send them a follow-up email.
        </p>
        <div className="field">
          <label className="label">Message to send <span className="muted">(optional)</span></label>
          <textarea className="input" rows={5} value={msg} onChange={e => setMsg(e.target.value)}
            placeholder={`Hi ${lead.contact_name},\n\nThanks for your interest in OnFleet Fleet...`} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, cursor: 'pointer' }}>
          <input type="checkbox" checked={sendEmail} onChange={e => setSendEmail(e.target.checked)} />
          <span className="text-sm">Send this message to {lead.email}</span>
        </label>
        {err && <div className="alert-banner alert-danger" style={{ marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={submit} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <CheckCircle size={14} />} Mark contacted
          </button>
        </div>
      </div>
    </div>
  );
}

function ScheduleDemoModal({ lead, onClose, onDone }) {
  const [demoAt, setDemoAt] = useState('');
  const [location, setLocation] = useState('Kya Sand, Johannesburg');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    if (!demoAt) { setErr('Please pick a date and time'); return; }
    setBusy(true); setErr('');
    try {
      await api.post(`/pilot/leads/${lead.id}/schedule-demo`, { demo_at: demoAt, location, notes });
      onDone();
    } catch (e) {
      setErr(e.response?.data?.error || 'Request failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={{ margin: 0 }}>Schedule demo</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <p className="text-sm muted" style={{ marginBottom: 16 }}>
          Book a demo for <strong>{lead.contact_name}</strong> at <strong>{lead.company_name}</strong>. A confirmation email will be sent to {lead.email}.
        </p>
        <div className="field">
          <label className="label">Date and time <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input className="input" type="datetime-local" value={demoAt} onChange={e => setDemoAt(e.target.value)} />
        </div>
        <div className="field">
          <label className="label">Location</label>
          <input className="input" value={location} onChange={e => setLocation(e.target.value)} />
        </div>
        <div className="field">
          <label className="label">Notes for the lead <span className="muted">(optional)</span></label>
          <textarea className="input" rows={3} value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="What to bring, who to ask for, parking details..." />
        </div>
        {err && <div className="alert-banner alert-danger" style={{ marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={submit} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Calendar size={14} />} Confirm demo
          </button>
        </div>
      </div>
    </div>
  );
}

function ConvertModal({ lead, onClose, onDone }) {
  const [form, setForm] = useState({
    email: lead.email || '',
    full_name: lead.contact_name || '',
    company_name: lead.company_name || '',
    phone: lead.phone || '',
    city: lead.city || '',
    fleet_size: lead.fleet_size || '',
    plan_key: lead.plan_interest || 'trial',
    welcome_message: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);

  function set(k) { return e => setForm(f => ({ ...f, [k]: e.target.value })); }

  async function submit() {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/pilot/leads/${lead.id}/convert`, form);
      setDone(r.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Request failed');
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
          <div style={{ textAlign: 'center', padding: '8px 0 24px' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(34,197,94,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <CheckCircle size={28} style={{ color: 'var(--success)' }} />
            </div>
            <h3 style={{ margin: '0 0 8px' }}>Fleet owner account created</h3>
            <p className="text-sm muted" style={{ marginBottom: 20 }}>
              {done.organization?.name} is now on the platform. A password-set email has been sent to {form.email}.
            </p>
            <div className="card" style={{ padding: 12, textAlign: 'left', marginBottom: 20 }}>
              <div className="text-xs muted" style={{ marginBottom: 4 }}>Password reset link (expires in 60 min)</div>
              <div style={{ wordBreak: 'break-all', fontSize: 11, fontFamily: 'monospace' }}>{done.reset_url}</div>
            </div>
            <button className="btn" onClick={() => { onDone(); onClose(); }}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={{ margin: 0 }}>Convert to fleet owner</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <p className="text-sm muted" style={{ marginBottom: 16 }}>
          Creates a fleet-owner organisation and admin account. A password-set link is emailed to the contact.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="field" style={{ gridColumn: '1/-1' }}>
            <label className="label">Company name <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input className="input" value={form.company_name} onChange={set('company_name')} />
          </div>
          <div className="field">
            <label className="label">Contact name <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input className="input" value={form.full_name} onChange={set('full_name')} />
          </div>
          <div className="field">
            <label className="label">Login email <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input className="input" type="email" value={form.email} onChange={set('email')} />
          </div>
          <div className="field">
            <label className="label">Phone</label>
            <input className="input" value={form.phone} onChange={set('phone')} />
          </div>
          <div className="field">
            <label className="label">City</label>
            <input className="input" value={form.city} onChange={set('city')} />
          </div>
          <div className="field">
            <label className="label">Fleet size</label>
            <input className="input" type="number" min={1} value={form.fleet_size} onChange={set('fleet_size')} />
          </div>
          <div className="field">
            <label className="label">Plan</label>
            <select className="input" value={form.plan_key} onChange={set('plan_key')}>
              <option value="trial">Trial (1 month free)</option>
              <option value="small">Small fleet</option>
              <option value="medium">Medium fleet</option>
              <option value="large">Large fleet</option>
              <option value="enterprise">Enterprise+</option>
            </select>
          </div>
          <div className="field" style={{ gridColumn: '1/-1' }}>
            <label className="label">Personal welcome note <span className="muted">(optional — appears in the account-ready email)</span></label>
            <textarea className="input" rows={3} value={form.welcome_message} onChange={set('welcome_message')}
              placeholder="e.g. Great meeting you today — excited to have you onboard." />
          </div>
        </div>
        {err && <div className="alert-banner alert-danger" style={{ marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-success" onClick={submit} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <UserCheck size={14} />} Create account &amp; send login
          </button>
        </div>
      </div>
    </div>
  );
}

function LeadDetailModal({ lead: initLead, onClose, onUpdated }) {
  const [lead, setLead] = useState(initLead);
  const [org, setOrg] = useState(null);
  const [internalNotes, setInternalNotes] = useState(initLead.internal_notes || '');
  const [notesSaving, setNotesSaving] = useState(false);
  const [modal, setModal] = useState(null);

  useEffect(() => {
    api.get(`/pilot/leads/${lead.id}`).then(r => {
      setLead(r.data.lead);
      setOrg(r.data.organization);
      setInternalNotes(r.data.lead.internal_notes || '');
    }).catch(() => {});
  }, [lead.id]);

  async function saveNotes() {
    setNotesSaving(true);
    try {
      const r = await api.patch(`/pilot/leads/${lead.id}`, { internal_notes: internalNotes });
      setLead(r.data.lead);
      onUpdated(r.data.lead);
    } finally { setNotesSaving(false); }
  }

  async function archive() {
    if (!window.confirm(`Archive lead for ${lead.company_name}? They won't be deleted.`)) return;
    const r = await api.patch(`/pilot/leads/${lead.id}`, { status: 'archived' });
    setLead(r.data.lead);
    onUpdated(r.data.lead);
  }

  function afterAction() {
    api.get(`/pilot/leads/${lead.id}`).then(r => {
      setLead(r.data.lead);
      setOrg(r.data.organization);
      onUpdated(r.data.lead);
    }).catch(() => {});
    setModal(null);
  }

  const canContact = ['new', 'contacted'].includes(lead.status);
  const canSchedule = ['new', 'contacted', 'demo_scheduled'].includes(lead.status);
  const canConvert = !['converted', 'archived'].includes(lead.status);
  const isConverted = lead.status === 'converted';

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 640, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <h3 style={{ margin: '0 0 4px' }}>{lead.company_name}</h3>
              <StatusBadge status={lead.status} />
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', flexShrink: 0 }}><X size={18} /></button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div>
              <div className="text-xs muted" style={{ marginBottom: 2 }}>Contact</div>
              <div style={{ fontWeight: 600 }}>{lead.contact_name}</div>
            </div>
            <div>
              <div className="text-xs muted" style={{ marginBottom: 2 }}>Plan interest</div>
              <div style={{ fontWeight: 600 }}>{PLAN_LABELS[lead.plan_interest] || lead.plan_interest}</div>
            </div>
            <div>
              <div className="text-xs muted" style={{ marginBottom: 2 }}>Email</div>
              <a href={`mailto:${lead.email}`} style={{ color: 'var(--primary-light)' }}>{lead.email}</a>
            </div>
            <div>
              <div className="text-xs muted" style={{ marginBottom: 2 }}>Phone</div>
              <div>{lead.phone ? <a href={`tel:${lead.phone}`} style={{ color: 'var(--primary-light)' }}>{lead.phone}</a> : <span className="muted">—</span>}</div>
            </div>
            <div>
              <div className="text-xs muted" style={{ marginBottom: 2 }}>City</div>
              <div>{lead.city || <span className="muted">—</span>}</div>
            </div>
            <div>
              <div className="text-xs muted" style={{ marginBottom: 2 }}>Fleet size</div>
              <div>{lead.fleet_size ? `${lead.fleet_size} bikes` : <span className="muted">—</span>}</div>
            </div>
            <div>
              <div className="text-xs muted" style={{ marginBottom: 2 }}>Demo requested</div>
              <div>{lead.wants_demo ? 'Yes' : 'No'}</div>
            </div>
            <div>
              <div className="text-xs muted" style={{ marginBottom: 2 }}>Demo scheduled for</div>
              <div>{lead.demo_at ? new Date(lead.demo_at).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : <span className="muted">—</span>}</div>
            </div>
            <div>
              <div className="text-xs muted" style={{ marginBottom: 2 }}>Source</div>
              <div className="text-sm">{lead.source}</div>
            </div>
            <div>
              <div className="text-xs muted" style={{ marginBottom: 2 }}>Submitted</div>
              <div className="text-sm">{new Date(lead.created_at).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })}</div>
            </div>
          </div>

          {lead.notes && (
            <div style={{ marginBottom: 20 }}>
              <div className="text-xs muted" style={{ marginBottom: 4 }}>Notes from lead</div>
              <div className="card" style={{ padding: 12, fontSize: 13 }}>{lead.notes}</div>
            </div>
          )}

          {isConverted && org && (
            <div className="card" style={{ padding: 12, marginBottom: 20, border: '1px solid var(--success)', background: 'rgba(34,197,94,0.06)' }}>
              <div className="text-xs muted" style={{ marginBottom: 6 }}>Converted organisation</div>
              <div style={{ fontWeight: 600 }}>{org.name}</div>
              <div className="text-sm muted">Plan: {PLAN_LABELS[org.plan_key] || org.plan_key} · Status: {org.status}</div>
            </div>
          )}

          <div style={{ marginBottom: 20 }}>
            <div className="text-xs muted" style={{ marginBottom: 4 }}>Internal notes <span className="muted">(not visible to lead)</span></div>
            <textarea className="input" rows={4} value={internalNotes} onChange={e => setInternalNotes(e.target.value)}
              placeholder="Call notes, context, follow-up dates, objections..." />
            <button className="btn btn-secondary btn-sm" style={{ marginTop: 6 }} onClick={saveNotes} disabled={notesSaving}>
              {notesSaving ? <Loader2 size={12} className="spin" /> : null} Save notes
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canContact && (
              <button className="btn btn-secondary" onClick={() => setModal('contact')}>
                <Mail size={14} /> Mark contacted
              </button>
            )}
            {canSchedule && (
              <button className="btn btn-secondary" onClick={() => setModal('demo')}>
                <Calendar size={14} /> Schedule demo
              </button>
            )}
            {canConvert && (
              <button className="btn btn-success" onClick={() => setModal('convert')}>
                <UserCheck size={14} /> Convert to fleet owner
              </button>
            )}
            {lead.status !== 'archived' && !isConverted && (
              <button className="btn btn-secondary" style={{ color: 'var(--muted)' }} onClick={archive}>
                <Archive size={14} /> Archive
              </button>
            )}
          </div>
        </div>
      </div>

      {modal === 'contact' && <ContactModal lead={lead} onClose={() => setModal(null)} onDone={afterAction} />}
      {modal === 'demo' && <ScheduleDemoModal lead={lead} onClose={() => setModal(null)} onDone={afterAction} />}
      {modal === 'convert' && <ConvertModal lead={lead} onClose={() => setModal(null)} onDone={afterAction} />}
    </>
  );
}

export default function AdminLeads() {
  const [leads, setLeads] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedLead, setSelectedLead] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (debouncedSearch) params.search = debouncedSearch;
      const r = await api.get('/pilot/leads', { params });
      setLeads(r.data.leads || []);
      setStats(r.data.stats || {});
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not load leads');
    } finally { setLoading(false); }
  }, [statusFilter, debouncedSearch]);

  useEffect(() => { load(); }, [load]);

  const statuses = ['', 'new', 'contacted', 'demo_scheduled', 'trial_started', 'converted', 'archived'];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0 }}>Pilot leads</h2>
          <div className="text-sm muted" style={{ marginTop: 2 }}>Fleet owner demo requests and pipeline</div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
        <StatTile label="Total" value={stats.total ?? '—'} />
        <StatTile label="New" value={stats.new ?? '—'} color={STATUS_META.new.color} />
        <StatTile label="Demo booked" value={stats.demos ?? '—'} color={STATUS_META.demo_scheduled.color} />
        <StatTile label="Trial" value={stats.trials ?? '—'} color={STATUS_META.trial_started.color} />
        <StatTile label="Converted" value={stats.converted ?? '—'} color={STATUS_META.converted.color} />
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {statuses.map(s => (
            <button key={s || 'all'} className={`btn btn-sm ${statusFilter === s ? '' : 'btn-secondary'}`}
              onClick={() => setStatusFilter(s)}>
              {s ? STATUS_META[s]?.label : 'All'}
            </button>
          ))}
        </div>
        <input className="input" style={{ maxWidth: 240, marginLeft: 'auto' }} placeholder="Search leads..."
          value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {err && <div className="alert-banner alert-danger" style={{ marginBottom: 16 }}>{err}</div>}

      {loading && !leads.length ? (
        <div className="muted text-sm" style={{ padding: '24px 0', textAlign: 'center' }}>Loading...</div>
      ) : leads.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
          No leads match your filters.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Contact</th>
                <th>Plan</th>
                <th>Fleet</th>
                <th>Demo</th>
                <th>Status</th>
                <th>Submitted</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {leads.map(lead => (
                <tr key={lead.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedLead(lead)}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{lead.company_name}</div>
                    {lead.city && <div className="text-xs muted">{lead.city}</div>}
                  </td>
                  <td>
                    <div>{lead.contact_name}</div>
                    <div className="text-xs muted">{lead.email}</div>
                    {lead.phone && <div className="text-xs muted">{lead.phone}</div>}
                  </td>
                  <td><span className="badge badge-info">{PLAN_LABELS[lead.plan_interest] || lead.plan_interest}</span></td>
                  <td>{lead.fleet_size ? `${lead.fleet_size} bikes` : <span className="muted">—</span>}</td>
                  <td>
                    {lead.demo_at
                      ? <span style={{ fontSize: 12 }}>{new Date(lead.demo_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
                      : lead.wants_demo ? <span className="text-xs" style={{ color: '#f59e0b' }}>Requested</span>
                      : <span className="muted text-xs">—</span>}
                  </td>
                  <td><StatusBadge status={lead.status} /></td>
                  <td className="text-xs muted">{new Date(lead.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</td>
                  <td><ChevronRight size={14} style={{ color: 'var(--muted)' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedLead && (
        <LeadDetailModal
          key={selectedLead.id}
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
          onUpdated={(updated) => {
            setLeads(ls => ls.map(l => l.id === updated.id ? updated : l));
            setSelectedLead(updated);
          }}
        />
      )}
    </div>
  );
}
