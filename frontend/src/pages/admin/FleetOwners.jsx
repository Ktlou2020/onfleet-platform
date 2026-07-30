import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, ConfirmModal, CopyableContactValue, EmptyState, Loading, Modal, Pagination, SearchInput, Stat, fmt, fmtDate, matchesSearch, paginateItems } from '../../components/ui';
import { getFleetRoleLabel } from '../fleet/access';
import { Building2, ShieldCheck, Users, Wallet, Settings, ChevronDown, ChevronRight, Mail, MapPin, Bike, CreditCard, KeyRound, Trash2, Send, Eye, Phone, TrendingUp, AlertTriangle, CheckCircle2, Circle, Zap, Clock, RefreshCw } from 'lucide-react';

const EMAIL_TEMPLATES = [
  { key: 'demo_invite',     label: 'Demo / call invite' },
  { key: 'trial_ending',    label: 'Trial ending soon' },
  { key: 'trial_expired',   label: 'Trial expired — re-engage' },
  { key: 'check_in',        label: 'Check-in / how is it going?' },
  { key: 'upgrade_prompt',  label: 'Upgrade prompt' },
  { key: '__custom__',      label: 'Custom message…' },
];

function EmailModal({ orgs, onClose }) {
  const [templateKey, setTemplateKey] = useState('demo_invite');
  const [customSubject, setCustomSubject] = useState('');
  const [customMessage, setCustomMessage] = useState('');
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);

  const isCustom = templateKey === '__custom__';
  const orgIds = orgs.map((o) => o.id);

  const loadPreview = async () => {
    setLoadingPreview(true);
    try {
      const payload = { org_ids: orgIds, template_key: isCustom ? undefined : templateKey, custom_subject: isCustom ? customSubject : undefined, custom_message: isCustom ? customMessage : undefined, preview: true };
      const { data } = await api.post('/admin/fleet-owners/email', payload);
      setPreview(data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load preview');
    } finally {
      setLoadingPreview(false);
    }
  };

  const send = async () => {
    setSending(true);
    try {
      const payload = { org_ids: orgIds, template_key: isCustom ? undefined : templateKey, custom_subject: isCustom ? customSubject : undefined, custom_message: isCustom ? customMessage : undefined };
      const { data } = await api.post('/admin/fleet-owners/email', payload);
      setSent(data);
      toast.success(`Sent to ${data.sent} organisation${data.sent !== 1 ? 's' : ''}`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not send emails');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <Modal title="Emails sent" onClose={onClose}>
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
          <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 8 }}>{sent.sent} email{sent.sent !== 1 ? 's' : ''} sent</div>
          {sent.failed?.length > 0 && (
            <div style={{ marginTop: 12, textAlign: 'left' }}>
              <div className="muted text-sm" style={{ marginBottom: 8 }}>Failed ({sent.failed.length}):</div>
              {sent.failed.map((f, i) => <div key={i} className="text-sm" style={{ color: 'var(--danger)', marginBottom: 4 }}>{f.org} — {f.reason}</div>)}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Send email · ${orgs.length} recipient${orgs.length !== 1 ? 's' : ''}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label className="label">Recipients</label>
          <div style={{ background: 'var(--bg-alt, #f8fafc)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', maxHeight: 100, overflowY: 'auto' }}>
            {orgs.map((o) => (
              <div key={o.id} className="text-sm" style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                <span style={{ fontWeight: 600 }}>{o.name}</span>
                <span className="muted">{o.contact_email}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <label className="label">Template</label>
          <select value={templateKey} onChange={(e) => { setTemplateKey(e.target.value); setPreview(null); }}>
            {EMAIL_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </div>
        {isCustom && (
          <>
            <div>
              <label className="label">Subject</label>
              <input className="form-control" value={customSubject} onChange={(e) => { setCustomSubject(e.target.value); setPreview(null); }} placeholder="Email subject…" />
            </div>
            <div>
              <label className="label">Message</label>
              <textarea className="form-control" rows={6} value={customMessage} onChange={(e) => { setCustomMessage(e.target.value); setPreview(null); }} placeholder="Write your message here…" style={{ resize: 'vertical' }} />
            </div>
          </>
        )}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={loadPreview} disabled={loadingPreview || (isCustom && !customMessage)}>
            {loadingPreview ? 'Loading…' : 'Preview email'}
          </button>
          <button className="btn btn-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={send} disabled={sending || (isCustom && !customMessage)}>
            <Send size={13} /> {sending ? 'Sending…' : `Send to ${orgs.length}`}
          </button>
        </div>
        {preview && (
          <div style={{ marginTop: 8 }}>
            <div className="label" style={{ marginBottom: 6 }}>Preview — <span className="muted">subject: {preview.subject}</span></div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', maxHeight: 420, overflowY: 'auto' }}>
              <iframe srcDoc={preview.html} title="Email preview" style={{ width: '100%', height: 420, border: 'none', display: 'block' }} sandbox="allow-same-origin" />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

const PLAN_OPTIONS = [
  { key: 'trial',      label: 'Trial',       defaultStatus: 'trialing', maxBikes: 10,  maxAdmins: 2  },
  { key: 'small',      label: 'Small',       defaultStatus: 'active',   maxBikes: 20,  maxAdmins: 3  },
  { key: 'medium',     label: 'Medium',      defaultStatus: 'active',   maxBikes: 60,  maxAdmins: 5  },
  { key: 'large',      label: 'Large',       defaultStatus: 'active',   maxBikes: 100, maxAdmins: 10 },
  { key: 'enterprise', label: 'Enterprise',  defaultStatus: 'active',   maxBikes: 999, maxAdmins: 50 }
];
const ORG_STATUS_OPTIONS = ['trialing', 'active', 'past_due', 'suspended', 'cancelled'];

function ChangePlanModal({ orgId, orgName, currentPlan, currentStatus, onClose, onSaved }) {
  const plan = PLAN_OPTIONS.find((p) => p.key === currentPlan) || PLAN_OPTIONS[0];
  const [selectedPlan, setSelectedPlan] = useState(plan.key);
  const [selectedStatus, setSelectedStatus] = useState(currentStatus || plan.defaultStatus);
  const [maxBikes, setMaxBikes] = useState(String(plan.maxBikes));
  const [maxAdmins, setMaxAdmins] = useState(String(plan.maxAdmins));
  const [busy, setBusy] = useState(false);

  const onPlanChange = (key) => {
    const p = PLAN_OPTIONS.find((o) => o.key === key);
    setSelectedPlan(key);
    setSelectedStatus(p.defaultStatus);
    setMaxBikes(String(p.maxBikes));
    setMaxAdmins(String(p.maxAdmins));
  };

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/organizations/${orgId}/plan`, { plan_key: selectedPlan, status: selectedStatus, max_bikes: Number(maxBikes), max_admin_users: Number(maxAdmins) });
      toast.success(`${orgName} plan updated to ${selectedPlan}`);
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not update plan');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Change plan" onClose={onClose}>
      <div className="muted text-sm mb-3">{orgName}</div>
      <div className="field">
        <label className="label">Plan</label>
        <select value={selectedPlan} onChange={(e) => onPlanChange(e.target.value)}>
          {PLAN_OPTIONS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="label">Status</label>
        <select value={selectedStatus} onChange={(e) => setSelectedStatus(e.target.value)}>
          {ORG_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label className="label">Max bikes</label>
          <input type="number" min="1" value={maxBikes} onChange={(e) => setMaxBikes(e.target.value)} />
        </div>
        <div className="field">
          <label className="label">Max admin users</label>
          <input type="number" min="1" value={maxAdmins} onChange={(e) => setMaxAdmins(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <button className="btn" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ── Conversation insight based on activity ─────────────────────────────────────
function getInsight(org) {
  if (org.status === 'active' && org.revenue_30d > 0) {
    return { type: 'success', text: 'Paying customer actively collecting — focus on retention and upsell' };
  }
  if (org.status === 'active' && org.revenue_30d === 0) {
    return { type: 'warn', text: 'Paid plan but no activity in 30 days — check if they\'re still using it' };
  }
  if (org.bike_count === 0) {
    return { type: 'cold', text: 'Hasn\'t added any bikes yet — guide them through the setup wizard on the call' };
  }
  if (org.total_agreements === 0) {
    return { type: 'cold', text: `Has ${org.bike_count} bike${org.bike_count !== 1 ? 's' : ''} but no agreements — help them onboard their first rider` };
  }
  if (org.payment_count === 0) {
    return { type: 'warm', text: 'Has agreements but never collected a payment — demo the Paystack debit flow' };
  }
  if (org.revenue_30d === 0 && org.payment_count > 0) {
    return { type: 'warn', text: 'Collected payments before but nothing in 30 days — re-engage and find out what changed' };
  }
  if (org.revenue_30d > 0 && org.status === 'trialing') {
    return { type: 'hot', text: 'Actively collecting payments on trial — strong conversion candidate, strike now' };
  }
  if (org.overdue_amount > 0) {
    return { type: 'warn', text: `${fmt(org.overdue_amount)} overdue — talk about the collections queue and automated Paystack debit` };
  }
  return null;
}

const INSIGHT_STYLE = {
  hot:     { bg: '#fef3c7', border: '#fbbf24', text: '#92400e', icon: <Zap size={13} /> },
  success: { bg: '#dcfce7', border: '#86efac', text: '#166534', icon: <CheckCircle2 size={13} /> },
  warm:    { bg: '#fff7ed', border: '#fdba74', text: '#9a3412', icon: <TrendingUp size={13} /> },
  warn:    { bg: '#fff7ed', border: '#fdba74', text: '#9a3412', icon: <AlertTriangle size={13} /> },
  cold:    { bg: '#f1f5f9', border: '#cbd5e1', text: '#475569', icon: <Circle size={13} /> },
};

function TrialPill({ days }) {
  if (days === null) return null;
  if (days <= 0)  return <span style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 99, padding: '2px 10px', fontSize: 11, fontWeight: 700 }}>Trial expired</span>;
  if (days <= 3)  return <span style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 99, padding: '2px 10px', fontSize: 11, fontWeight: 700 }}>{days}d left ⚠</span>;
  if (days <= 7)  return <span style={{ background: '#fffbeb', color: '#d97706', border: '1px solid #fcd34d', borderRadius: 99, padding: '2px 10px', fontSize: 11, fontWeight: 700 }}>{days}d left</span>;
  return <span style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #86efac', borderRadius: 99, padding: '2px 10px', fontSize: 11, fontWeight: 600 }}>{days}d left</span>;
}

function SetupStep({ done, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: done ? 'var(--text)' : 'var(--muted)', fontWeight: done ? 600 : 400 }}>
      {done
        ? <CheckCircle2 size={13} style={{ color: '#16a34a', flexShrink: 0 }} />
        : <Circle size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
      {label}
    </span>
  );
}

const SORT_OPTIONS = [
  { value: 'trial_asc',    label: 'Trial ending soonest' },
  { value: 'revenue_desc', label: 'Most revenue (30d)' },
  { value: 'bikes_desc',   label: 'Most bikes' },
  { value: 'activity',     label: 'Least active first' },
  { value: 'newest',       label: 'Newest first' },
];

function sortOrgs(orgs, sortBy) {
  const copy = [...orgs];
  switch (sortBy) {
    case 'trial_asc':
      return copy.sort((a, b) => {
        const da = a.trial_days_left ?? 999;
        const db2 = b.trial_days_left ?? 999;
        return da - db2;
      });
    case 'revenue_desc':
      return copy.sort((a, b) => b.revenue_30d - a.revenue_30d);
    case 'bikes_desc':
      return copy.sort((a, b) => b.bike_count - a.bike_count);
    case 'activity':
      return copy.sort((a, b) => a.payment_count - b.payment_count);
    case 'newest':
      return copy.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    default:
      return copy;
  }
}

const roleOptions = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];

export default function AdminFleetOwners() {
  const { user } = useAuth();
  const [urlParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [organizations, setOrganizations] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [search, setSearch] = useState(urlParams.get('search') || '');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortBy, setSortBy] = useState('trial_asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [busyKey, setBusyKey] = useState('');
  const [roleEdits, setRoleEdits] = useState({});
  const [planModal, setPlanModal] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [confirmModal, setConfirmModal] = useState(null);
  const [emailModal, setEmailModal] = useState(null);
  const orgParamApplied = useRef(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/fleet-owners');
      setOrganizations(data.organizations || []);
      setAccounts(data.users || []);

      const [, urlParams2] = [null, new URLSearchParams(window.location.search)];
      const orgId = urlParams2.get('org');
      if (orgId && !orgParamApplied.current) {
        orgParamApplied.current = true;
        const target = (data.organizations || []).find((o) => String(o.id) === orgId);
        if (target) {
          setSearch(target.name);
          setExpanded(new Set([target.id]));
        }
      }
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load fleet owners');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'superadmin') load();
    else setLoading(false);
  }, [user?.role]);

  useEffect(() => { setPage(1); }, [search, statusFilter, sortBy]);

  const byOrg = useMemo(() => {
    const map = {};
    for (const a of accounts) {
      if (!map[a.organization_id]) map[a.organization_id] = [];
      map[a.organization_id].push(a);
    }
    return map;
  }, [accounts]);

  const filteredOrgs = useMemo(() => {
    const base = organizations.filter((org) => {
      if (statusFilter !== 'all' && org.status !== statusFilter) return false;
      const members = byOrg[org.id] || [];
      const memberTerms = members.flatMap((m) => [m.full_name, m.email, m.phone, m.city]);
      return matchesSearch(search, org.name, org.contact_email, org.contact_phone, org.city, org.plan_key, org.status, ...memberTerms);
    });
    return sortOrgs(base, sortBy);
  }, [organizations, byOrg, statusFilter, search, sortBy]);

  const pagination = useMemo(() => paginateItems(filteredOrgs, page, pageSize), [filteredOrgs, page, pageSize]);

  const stats = useMemo(() => ({
    organizations: organizations.length,
    accounts: accounts.length,
    active: organizations.filter((o) => o.status === 'active').length,
    nonPayers: organizations.filter((o) => o.payer_status === 'non_payer').length
  }), [accounts, organizations]);

  const trialingOrgs = useMemo(() => organizations.filter((o) => o.status === 'trialing' && o.contact_email), [organizations]);

  const toggleExpanded = (orgId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(orgId) ? next.delete(orgId) : next.add(orgId);
      return next;
    });
  };

  const saveRole = async (account) => {
    const newRole = roleEdits[account.id];
    if (!newRole || newRole === account.role) return;
    setBusyKey(`role-${account.id}`);
    try {
      await api.post(`/admin/fleet-owners/${account.id}/role`, { role: newRole });
      toast.success('Role updated');
      setRoleEdits((prev) => { const n = { ...prev }; delete n[account.id]; return n; });
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update role');
    } finally {
      setBusyKey('');
    }
  };

  const toggleStatus = async (account) => {
    const newStatus = account.status === 'active' ? 'suspended' : 'active';
    setBusyKey(`status-${account.id}`);
    try {
      await api.post(`/admin/fleet-owners/${account.id}/status`, { status: newStatus });
      toast.success(`${account.full_name} ${newStatus}`);
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update status');
    } finally {
      setBusyKey('');
    }
  };

  const deleteOrg = (org) => {
    const members = byOrg[org.id] || [];
    setConfirmModal({
      title: 'Delete organization',
      body: `This will permanently delete ${org.name} and revoke access for all ${members.length} team member${members.length !== 1 ? 's' : ''}. This cannot be undone.`,
      confirmLabel: 'Delete permanently',
      danger: true,
      key: `delete-org-${org.id}`,
      onConfirm: async () => {
        setBusyKey(`delete-org-${org.id}`);
        try {
          await api.delete(`/admin/organizations/${org.id}`);
          toast.success(`${org.name} deleted`);
          setConfirmModal(null);
          await load();
        } catch (error) {
          toast.error(error.response?.data?.error || 'Could not delete organization');
        } finally {
          setBusyKey('');
        }
      }
    });
  };

  const sendPasswordReset = (account) => {
    setConfirmModal({
      title: 'Send password reset',
      body: `Send a secure password reset link to ${account.full_name} at ${account.email}? The link expires after 60 minutes.`,
      confirmLabel: 'Send link',
      danger: false,
      key: `reset-${account.id}`,
      onConfirm: async () => {
        setBusyKey(`reset-${account.id}`);
        try {
          await api.post(`/admin/fleet-owners/${account.id}/send-password-reset`);
          toast.success('Password reset email sent');
          setConfirmModal(null);
        } catch (error) {
          toast.error(error.response?.data?.error || 'Could not send password reset');
        } finally {
          setBusyKey('');
        }
      }
    });
  };

  const [syncModal, setSyncModal] = useState(null); // { org, subCodesText, agreementNum }

  const syncPaystack = async (org, subscriptionCodes, hintAgreementNumber) => {
    setBusyKey(`sync-${org.id}`);
    try {
      const body = { org_id: org.id };
      if (subscriptionCodes?.length) body.subscription_codes = subscriptionCodes;
      if (hintAgreementNumber) body.hint_agreement_number = hintAgreementNumber;
      const { data } = await api.post('/admin/paystack/sync-org', body, { timeout: 120000 });
      const { synced, checked, skipped, errors, debug } = data;
      console.log('[paystack sync debug]', JSON.stringify(debug, null, 2));
      if (errors?.length) console.error('[paystack sync errors]', errors);
      if (synced > 0) {
        toast.success(`Synced ${synced} payment${synced !== 1 ? 's' : ''} for ${org.name} · ${checked} checked, ${skipped} already recorded`);
        await load();
      } else if (errors?.length) {
        // Show first error prominently — if agreement couldn't be resolved, hint about agreement number field.
        const firstErr = errors[0]?.reason || 'unknown error';
        const needsAgreement = firstErr.includes('agreement_id');
        const hint = needsAgreement ? ' Enter the agreement number (e.g. OF-2026-895786) in "Sync by codes" to override.' : '';
        toast.error(`Sync — 0 new · ${errors.length} error${errors.length !== 1 ? 's' : ''}: ${firstErr}.${hint}`, { duration: 12000 });
      } else if (checked === 0) {
        const usingCodes = subscriptionCodes?.length > 0;
        if (usingCodes && debug?.subscriptions?.length) {
          const sub = debug.subscriptions[0];
          const detail = sub.error
            ? `Paystack error: ${sub.error}`
            : sub.ps_found
              ? `Found on Paystack (${sub.invoice_count} invoices, ${sub.txn_count} txns) · customer: ${sub.customer_email || 'no email'} · email match: ${sub.email_match ? sub.email_match.name : 'none'}${sub.hint_agreement_used ? ' · agreement hint used' : ''}`
              : `Not found on Paystack — check the subscription codes`;
          toast.error(`0 transactions for ${org.name}. ${detail}. Check browser console for full detail.`, { duration: 10000 });
        } else {
          const planInfo = debug?.plan_codes_found?.length
            ? `Plan codes checked: ${debug.plan_codes_found.join(', ')}`
            : 'No fleet plan codes configured (PAYSTACK_FLEET_PLAN_xxx env vars missing)';
          toast.error(`0 transactions found for ${org.name}. ${planInfo}. Use "Sync by codes" to enter subscription codes directly.`, { duration: 8000 });
        }
      } else {
        toast.success(`All Paystack payments already recorded for ${org.name} (${checked} checked)`);
      }
    } catch (e) {
      toast.error(e.response?.data?.error || 'Paystack sync failed');
    } finally {
      setBusyKey('');
    }
  };

  if (loading) return <Loading />;

  if (user?.role !== 'superadmin') {
    return <EmptyState title="Superadmin access required" sub="Only superadmins can manage fleet-owner accounts." />;
  }

  return (
    <div>
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          body={confirmModal.body}
          confirmLabel={confirmModal.confirmLabel}
          danger={confirmModal.danger}
          busy={busyKey === confirmModal.key}
          onConfirm={confirmModal.onConfirm}
          onClose={() => setConfirmModal(null)}
        />
      )}
      {planModal && (
        <ChangePlanModal
          orgId={planModal.orgId}
          orgName={planModal.orgName}
          currentPlan={planModal.currentPlan}
          currentStatus={planModal.currentStatus}
          onClose={() => setPlanModal(null)}
          onSaved={() => { setPlanModal(null); load(); }}
        />
      )}
      {emailModal && <EmailModal orgs={emailModal} onClose={() => setEmailModal(null)} />}
      {syncModal && (
        <Modal title={`Sync Paystack · ${syncModal.org.name}`} onClose={syncModal.syncing ? undefined : () => setSyncModal(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {syncModal.syncing ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <RefreshCw size={24} className="spin" style={{ marginBottom: 12 }} />
                <p className="text-sm muted" style={{ margin: 0 }}>Fetching payments from Paystack — this may take up to a minute…</p>
              </div>
            ) : (
              <>
                <p className="text-sm muted" style={{ margin: 0 }}>
                  Paste Paystack subscription codes (one per line, e.g. <code>SUB_abc123</code>). If the Paystack customer email doesn't match OnFleet, enter the agreement number below to override.
                </p>
                <textarea
                  className="form-control"
                  rows={4}
                  placeholder={'SUB_umbfan2iixtspk2\nSUB_scek35i9hkuvoky\nSUB_og5pmeife5h2wv9'}
                  value={syncModal.subCodesText}
                  onChange={(e) => setSyncModal((m) => ({ ...m, subCodesText: e.target.value }))}
                  style={{ fontFamily: 'monospace', fontSize: 13 }}
                />
                <div>
                  <label className="text-sm" style={{ display: 'block', marginBottom: 4 }}>
                    Agreement number <span className="muted">(optional — override if email doesn't match)</span>
                  </label>
                  <input
                    className="form-control"
                    placeholder="e.g. OF-2026-895786"
                    value={syncModal.agreementNum || ''}
                    onChange={(e) => setSyncModal((m) => ({ ...m, agreementNum: e.target.value }))}
                    style={{ fontFamily: 'monospace', fontSize: 13 }}
                  />
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn btn-sm"
                    disabled={!syncModal.subCodesText.trim()}
                    onClick={async () => {
                      const codes = syncModal.subCodesText.split(/[\n,\s]+/).map((s) => s.trim()).filter((s) => s.startsWith('SUB_'));
                      if (!codes.length) { toast.error('No valid SUB_ codes found'); return; }
                      const agreementNum = syncModal.agreementNum?.trim() || null;
                      const org = syncModal.org;
                      setSyncModal((m) => ({ ...m, syncing: true }));
                      await syncPaystack(org, codes, agreementNum);
                      setSyncModal(null);
                    }}
                  >
                    Sync {syncModal.subCodesText.split(/[\n,\s]+/).filter((s) => s.trim().startsWith('SUB_')).length || ''} codes
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setSyncModal(null)}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      <div className="flex-between mb-2" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Fleet owners</h1>
          <p className="page-sub">Sales pipeline — who to call, what to say, and how to convert them.</p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {trialingOrgs.length > 0 && (
            <button className="btn btn-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={() => setEmailModal(trialingOrgs)}>
              <Send size={13} /> Email {trialingOrgs.length} trialing org{trialingOrgs.length !== 1 ? 's' : ''}
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={load}>Refresh</button>
        </div>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Organizations" value={stats.organizations} icon={<Building2 size={16} />} />
        <Stat label="Fleet owner users" value={stats.accounts} icon={<Users size={16} />} />
        <Stat label="Active subscriptions" value={stats.active} icon={<ShieldCheck size={16} />} />
        <Stat label="Non-payer orgs" value={stats.nonPayers} icon={<Wallet size={16} />} />
      </div>

      <div className="card mb-4">
        <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search company, contact, email, city, plan…"
            style={{ flex: '1 1 260px', maxWidth: 400 }}
          />
          <div style={{ minWidth: 170 }}>
            <label className="label">Status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All statuses</option>
              {ORG_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div style={{ minWidth: 200 }}>
            <label className="label">Sort by</label>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {SORT_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div className="muted text-sm" style={{ alignSelf: 'center', paddingTop: 4 }}>
            {filteredOrgs.length} of {organizations.length}
          </div>
        </div>
      </div>

      {!filteredOrgs.length ? (
        <EmptyState title="No organizations match this view" sub="Try a different status or search term." />
      ) : (
        <>
          {pagination.items.map((org) => {
            const members = byOrg[org.id] || [];
            const isExpanded = expanded.has(org.id);
            const insight = getInsight(org);
            const insightStyle = insight ? INSIGHT_STYLE[insight.type] : null;
            const adminMember = members.find((m) => m.role === 'fleet_owner_admin') || members[0];

            return (
              <div key={org.id} className="card mb-3" style={{ padding: 0, overflow: 'hidden' }}>

                {/* Main card body */}
                <div style={{ padding: '18px 20px' }}>

                  {/* Row 1: name + badges + actions */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 16 }}>{org.name}</span>
                      <Badge status={org.status}>{String(org.status || 'trialing').replace(/_/g, ' ')}</Badge>
                      <Badge status="active">{String(org.plan_key || 'trial').replace(/_/g, ' ')}</Badge>
                      {org.status === 'trialing' && <TrialPill days={org.trial_days_left} />}
                    </div>

                    {/* Action buttons */}
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
                      {org.contact_phone && (
                        <a
                          href={`tel:${org.contact_phone}`}
                          className="btn btn-sm btn-secondary"
                          style={{ display: 'flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}
                          title={`Call ${org.contact_phone}`}
                        >
                          <Phone size={13} /> Call
                        </a>
                      )}
                      {org.contact_email && (
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => setEmailModal([org])}
                          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                        >
                          <Mail size={13} /> Email
                        </button>
                      )}
                      <button
                        className="btn btn-sm btn-secondary"
                        disabled={busyKey === `imp-${org.id}`}
                        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                        title="Open fleet portal as this org"
                        onClick={async () => {
                          setBusyKey(`imp-${org.id}`);
                          try {
                            const { data } = await api.post(`/admin/impersonate/${org.id}`);
                            const userParam = encodeURIComponent(JSON.stringify(data.user));
                            window.open(`/fleet/impersonate?token=${encodeURIComponent(data.token)}&user=${userParam}`, '_blank');
                          } catch (error) {
                            toast.error(error.response?.data?.error || 'Could not start impersonation');
                          } finally {
                            setBusyKey('');
                          }
                        }}
                      >
                        <Eye size={13} /> View as
                      </button>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => setPlanModal({ orgId: org.id, orgName: org.name, currentPlan: org.plan_key, currentStatus: org.status })}
                        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        <Settings size={13} /> Plan
                      </button>
                      <button
                        className="btn btn-sm btn-secondary"
                        disabled={busyKey === `sync-${org.id}`}
                        onClick={() => syncPaystack(org)}
                        title="Pull missing Paystack payments into OnFleet"
                        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        <RefreshCw size={13} style={busyKey === `sync-${org.id}` ? { animation: 'spin 1s linear infinite' } : {}} />
                        {busyKey === `sync-${org.id}` ? 'Syncing…' : 'Sync PS'}
                      </button>
                      <button
                        className="btn btn-sm btn-secondary"
                        disabled={busyKey === `sync-${org.id}`}
                        onClick={() => setSyncModal({ org, subCodesText: '', agreementNum: '' })}
                        title="Sync specific Paystack subscription codes"
                        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        <RefreshCw size={13} /> Sync by codes
                      </button>
                      <button
                        className={`btn btn-sm ${isExpanded ? '' : 'btn-secondary'}`}
                        onClick={() => toggleExpanded(org.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Team
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busyKey === `delete-org-${org.id}`}
                        onClick={() => deleteOrg(org)}
                        title="Delete organization"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Row 2: contact info */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 16px', marginBottom: 14, fontSize: 13, color: 'var(--muted)' }}>
                    {adminMember?.full_name && (
                      <span style={{ color: 'var(--text)', fontWeight: 500 }}>{adminMember.full_name}</span>
                    )}
                    {org.contact_email && (
                      <a href={`mailto:${org.contact_email}`} style={{ color: 'var(--muted)', textDecoration: 'none' }}>{org.contact_email}</a>
                    )}
                    {org.contact_phone && (
                      <a href={`tel:${org.contact_phone}`} style={{ color: 'var(--muted)', textDecoration: 'none', fontWeight: 500 }}>{org.contact_phone}</a>
                    )}
                    {org.city && <span><MapPin size={11} style={{ marginRight: 2, verticalAlign: 'middle' }} />{org.city}</span>}
                    <span className="muted text-xs" style={{ marginLeft: 4 }}>since {fmtDate(org.created_at)}</span>
                  </div>

                  {/* Row 3: setup progress + metrics */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>

                    {/* Setup progress */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 2 }}>Setup progress</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
                        <SetupStep done={org.bike_count > 0} label={`${org.bike_count} bike${org.bike_count !== 1 ? 's' : ''}`} />
                        <SetupStep done={org.total_agreements > 0} label={`${org.total_agreements} agreement${org.total_agreements !== 1 ? 's' : ''}`} />
                        <SetupStep done={org.rider_count > 0} label={`${org.rider_count} rider${org.rider_count !== 1 ? 's' : ''}`} />
                        <SetupStep done={org.payment_count > 0} label={`${org.payment_count} payment${org.payment_count !== 1 ? 's' : ''}`} />
                      </div>
                    </div>

                    {/* Revenue metrics */}
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 13 }}>
                      {org.weekly_potential > 0 && (
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontWeight: 700, fontSize: 15 }}>{fmt(org.weekly_potential)}</div>
                          <div style={{ color: 'var(--muted)', fontSize: 11 }}>potential/wk</div>
                        </div>
                      )}
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontWeight: 700, fontSize: 15, color: org.revenue_30d > 0 ? '#16a34a' : 'var(--text)' }}>{fmt(org.revenue_30d)}</div>
                        <div style={{ color: 'var(--muted)', fontSize: 11 }}>revenue 30d</div>
                      </div>
                      {org.overdue_amount > 0 && (
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontWeight: 700, fontSize: 15, color: '#dc2626' }}>{fmt(org.overdue_amount)}</div>
                          <div style={{ color: 'var(--muted)', fontSize: 11 }}>overdue</div>
                        </div>
                      )}
                      {org.revenue_total > 0 && (
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontWeight: 700, fontSize: 15 }}>{fmt(org.revenue_total)}</div>
                          <div style={{ color: 'var(--muted)', fontSize: 11 }}>total collected</div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Row 4: conversation insight */}
                  {insight && (
                    <div style={{
                      marginTop: 12,
                      background: insightStyle.bg,
                      border: `1px solid ${insightStyle.border}`,
                      borderRadius: 8,
                      padding: '8px 12px',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      fontSize: 13,
                      color: insightStyle.text,
                    }}>
                      <span style={{ flexShrink: 0, marginTop: 1 }}>{insightStyle.icon}</span>
                      <span>{insight.text}</span>
                    </div>
                  )}
                </div>

                {/* Expanded: team member table */}
                {isExpanded && (
                  <div style={{ borderTop: '1px solid var(--border)' }}>
                    {members.length === 0 ? (
                      <div className="muted text-sm" style={{ padding: '12px 20px' }}>No team members.</div>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Member</th>
                              <th>Contact</th>
                              <th>Role</th>
                              <th>Status</th>
                              <th>Joined</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {members.map((account) => {
                              const nextRole = roleEdits[account.id] || account.role;
                              const changedRole = nextRole !== account.role;
                              return (
                                <tr key={account.id}>
                                  <td>
                                    <div style={{ fontWeight: 600 }}>{account.full_name}</div>
                                    <div className="text-xs muted">{account.email}</div>
                                  </td>
                                  <td>
                                    <CopyableContactValue value={account.phone} compact />
                                    {account.city && <div className="text-xs muted" style={{ marginTop: 4 }}>{account.city}</div>}
                                  </td>
                                  <td style={{ minWidth: 190 }}>
                                    <select value={nextRole} onChange={(e) => setRoleEdits((prev) => ({ ...prev, [account.id]: e.target.value }))}>
                                      {roleOptions.map((r) => <option key={r} value={r}>{getFleetRoleLabel(r)}</option>)}
                                    </select>
                                    {changedRole && <div className="text-xs muted" style={{ marginTop: 4 }}>Unsaved change</div>}
                                  </td>
                                  <td><Badge status={account.status}>{account.status}</Badge></td>
                                  <td className="text-xs muted">{fmtDate(account.created_at)}</td>
                                  <td>
                                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                      {changedRole && (
                                        <button className="btn btn-sm" disabled={busyKey === `role-${account.id}`} onClick={() => saveRole(account)}>
                                          {busyKey === `role-${account.id}` ? 'Saving…' : 'Save role'}
                                        </button>
                                      )}
                                      <button className="btn btn-sm btn-secondary" disabled={account.status !== 'active' || busyKey === `reset-${account.id}`} onClick={() => sendPasswordReset(account)} title="Send password reset">
                                        <KeyRound size={12} /> Reset
                                      </button>
                                      <button className={`btn btn-sm ${account.status === 'active' ? 'btn-danger' : 'btn-secondary'}`} disabled={busyKey === `status-${account.id}`} onClick={() => toggleStatus(account)}>
                                        {account.status === 'active' ? 'Suspend' : 'Activate'}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <Pagination
            page={pagination.currentPage}
            pageSize={pagination.pageSize}
            totalItems={pagination.totalItems}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            label="organizations"
          />
        </>
      )}
    </div>
  );
}
