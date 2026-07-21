import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, ConfirmModal, EmptyState, Loading } from '../../components/ui';
import { canManageFleetSection, FLEET_ROLE_LABELS } from './access';

const ROLE_OPTIONS = [
  { value: 'fleet_owner_admin', label: 'Company admin' },
  { value: 'fleet_owner_ops', label: 'Operations lead' },
  { value: 'fleet_owner_billing', label: 'Billing lead' },
  { value: 'fleet_owner_viewer', label: 'Viewer' }
];

const ADMIN_TIER_ROLES = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'];

const ROLE_BADGE_VARIANTS = {
  fleet_owner_admin: 'purple',
  fleet_owner_ops: 'blue',
  fleet_owner_billing: 'green',
  fleet_owner_viewer: 'default'
};

const EMPTY_INVITE = { full_name: '', email: '', password: '', role: 'fleet_owner_ops' };

function initEditForm(member) {
  return { role: member.role, status: member.status };
}

export default function FleetTeam() {
  const { user } = useAuth();
  const canManage = canManageFleetSection(user?.role, 'team');

  const [loading, setLoading] = useState(true);
  const [organization, setOrganization] = useState(null);
  const [members, setMembers] = useState([]);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState(EMPTY_INVITE);
  const [inviteSaving, setInviteSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editSaving, setEditSaving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/fleet/account');
      setOrganization(data.organization);
      setMembers(data.members || []);
    } catch {
      toast.error('Could not load team members');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const adminCount = members.filter((m) => ADMIN_TIER_ROLES.includes(m.role)).length;
  const maxAdmin = Number(organization?.max_admin_users || 0);

  async function handleInvite(e) {
    e.preventDefault();
    setInviteSaving(true);
    try {
      await api.post('/fleet/team-members', inviteForm);
      toast.success('Team member invited');
      setShowInvite(false);
      setInviteForm(EMPTY_INVITE);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not invite team member');
    } finally {
      setInviteSaving(false);
    }
  }

  function startEdit(member) {
    setEditingId(member.id);
    setEditForm(initEditForm(member));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm({});
  }

  async function saveEdit(memberId) {
    setEditSaving(true);
    try {
      const { data } = await api.patch(`/fleet/team-members/${memberId}`, editForm);
      setMembers((prev) => prev.map((m) => (m.id === memberId ? data.member : m)));
      setEditingId(null);
      toast.success('Member updated');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update member');
    } finally {
      setEditSaving(false);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.delete(`/fleet/team-members/${removeTarget.id}`);
      setMembers((prev) => prev.filter((m) => m.id !== removeTarget.id));
      toast.success(`${removeTarget.full_name} removed`);
      setRemoveTarget(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not remove member');
    } finally {
      setRemoving(false);
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Team</h1>
          {maxAdmin > 0 && (
            <p className="page-subtitle">
              {adminCount} / {maxAdmin} admin seats used
              {organization?.billing_plan ? ` · ${organization.billing_plan} plan` : ''}
            </p>
          )}
        </div>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setShowInvite(true)}>
            Invite member
          </button>
        )}
      </div>

      {members.length === 0 ? (
        <EmptyState title="No team members" description="Invite your first team member to get started." />
      ) : (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                {canManage && <th style={{ width: 180 }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const isSelf = member.id === user?.id;
                const isEditing = editingId === member.id;

                return (
                  <tr key={member.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{member.full_name}</div>
                      {isSelf && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>You</div>}
                    </td>
                    <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{member.email}</td>
                    <td>
                      {isEditing ? (
                        <select
                          className="form-select"
                          style={{ fontSize: 13, padding: '3px 6px' }}
                          value={editForm.role}
                          onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))}
                        >
                          {ROLE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      ) : (
                        <Badge variant={ROLE_BADGE_VARIANTS[member.role] || 'default'}>
                          {FLEET_ROLE_LABELS[member.role] || member.role}
                        </Badge>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <select
                          className="form-select"
                          style={{ fontSize: 13, padding: '3px 6px' }}
                          value={editForm.status}
                          disabled={isSelf}
                          onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}
                        >
                          <option value="active">Active</option>
                          <option value="suspended">Suspended</option>
                        </select>
                      ) : (
                        <Badge variant={member.status === 'active' ? 'green' : 'default'}>
                          {member.status}
                        </Badge>
                      )}
                    </td>
                    {canManage && (
                      <td>
                        {isEditing ? (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={editSaving}
                              onClick={() => saveEdit(member.id)}
                            >
                              {editSaving ? 'Saving…' : 'Save'}
                            </button>
                            <button className="btn btn-sm" onClick={cancelEdit}>Cancel</button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="btn btn-sm"
                              onClick={() => startEdit(member)}
                            >
                              Edit
                            </button>
                            {!isSelf && (
                              <button
                                className="btn btn-sm btn-danger"
                                onClick={() => setRemoveTarget(member)}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showInvite && (
        <div className="modal-backdrop" onClick={() => !inviteSaving && setShowInvite(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <h2 className="modal-title">Invite team member</h2>
              <button className="modal-close" onClick={() => setShowInvite(false)}>×</button>
            </div>
            <form onSubmit={handleInvite}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="form-group">
                  <label className="form-label">Full name</label>
                  <input
                    className="form-input"
                    required
                    value={inviteForm.full_name}
                    onChange={(e) => setInviteForm((f) => ({ ...f, full_name: e.target.value }))}
                    placeholder="Jane Smith"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input
                    className="form-input"
                    type="email"
                    required
                    value={inviteForm.email}
                    onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
                    placeholder="jane@company.com"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Temporary password</label>
                  <input
                    className="form-input"
                    type="password"
                    required
                    minLength={6}
                    value={inviteForm.password}
                    onChange={(e) => setInviteForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder="Min. 6 characters"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Role</label>
                  <select
                    className="form-select"
                    value={inviteForm.role}
                    onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value }))}
                  >
                    {ROLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  {ADMIN_TIER_ROLES.includes(inviteForm.role) && maxAdmin > 0 && adminCount >= maxAdmin && (
                    <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>
                      Admin seat limit reached ({adminCount}/{maxAdmin}). Upgrade your plan or choose Viewer.
                    </div>
                  )}
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn" onClick={() => setShowInvite(false)} disabled={inviteSaving}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={inviteSaving}>
                  {inviteSaving ? 'Inviting…' : 'Invite member'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {removeTarget && (
        <ConfirmModal
          title="Remove team member"
          message={`Remove ${removeTarget.full_name} from your team? They will lose access immediately.`}
          confirmLabel="Remove"
          danger
          loading={removing}
          onConfirm={confirmRemove}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
