import { useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Modal } from '../../components/ui';
import { Building2, Check, AlertTriangle } from 'lucide-react';
import { brandName } from '../../brand';

// Signing a fleet up from the operator's side.
//
// Deliberately not a copy of the public signup form. There is no password
// field: the customer sets their own through the invite, because an operator
// who types a password for a customer has made a credential two people know.
// And the plan and status are here, because this account is being created on
// the back of a conversation about both.

const PLANS = [
  ['trial', 'Trial', '6 bikes, 2 admins'],
  ['small', 'Small', '6 bikes, 2 admins'],
  ['medium', 'Medium', '20 bikes, 3 admins'],
  ['large', 'Large', '35 bikes, 5 admins'],
  ['empire', 'Empire', 'Unlimited'],
];

const BLANK = {
  company_name: '', full_name: '', email: '', phone: '', city: '',
  fleet_size: '', plan_key: 'trial', status: 'trialing', send_invite: true,
};

export default function OnboardFleet({ onClose, onDone }) {
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);

  const set = (k) => (e) => setForm((f) => ({
    ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
  }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { data } = await api.post('/admin/fleet-owners', {
        ...form,
        fleet_size: Number(form.fleet_size) || 0,
      });
      setDone(data);
      if (data.warning) toast.error(data.warning, { duration: 8000 });
      else toast.success(`${data.organization.name} is on the platform`);
      onDone?.(data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not create that fleet');
    } finally {
      setSaving(false);
    }
  };

  // Once it exists, say plainly what happened and what has not happened yet.
  if (done) {
    return (
      <Modal title="Fleet created" onClose={onClose}>
        <div className="row gap-3" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
          <Check size={20} style={{ color: '#16a34a', flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong>{done.organization.name}</strong>
            <div className="text-sm muted" style={{ marginTop: 4 }}>
              {done.organization.plan_key} plan · {String(done.organization.status).replace('_', ' ')} ·
              {' '}owner {done.owner.email}
            </div>
          </div>
        </div>

        <div className="card" style={{
          background: done.invited ? 'rgba(34,197,94,0.08)' : 'rgba(234,179,8,0.10)',
          borderColor: done.invited ? 'rgba(34,197,94,0.35)' : 'rgba(234,179,8,0.4)',
        }}>
          {done.invited ? (
            <>
              <strong>Invite sent to {done.owner.email}</strong>
              <p className="text-sm muted" style={{ margin: '6px 0 0' }}>
                They set their own password from that link. Until they do, the account
                exists but cannot be signed into — including by you.
              </p>
            </>
          ) : (
            <div className="row gap-3" style={{ alignItems: 'flex-start' }}>
              <AlertTriangle size={18} style={{ color: '#ca8a04', flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>No invite has been sent</strong>
                <p className="text-sm muted" style={{ margin: '6px 0 0' }}>
                  The fleet is on the platform, but nobody can sign in yet. Send the
                  invite from Manage accounts when you are ready.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="row gap-2" style={{ marginTop: 16 }}>
          <button className="btn" onClick={onClose}>Done</button>
          <button className="btn btn-secondary" onClick={() => { setDone(null); setForm(BLANK); }}>
            Onboard another
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Onboard a fleet onto ${brandName}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <label style={{ gridColumn: '1 / -1' }}>
            <span className="text-sm">Company name</span>
            <input required value={form.company_name} onChange={set('company_name')}
                   placeholder="Rapid Wheels" style={{ width: '100%', marginTop: 4 }} />
          </label>

          <label>
            <span className="text-sm">Contact name</span>
            <input required value={form.full_name} onChange={set('full_name')}
                   placeholder="Thabo Nkosi" style={{ width: '100%', marginTop: 4 }} />
          </label>

          <label>
            <span className="text-sm">Email</span>
            <input required type="email" value={form.email} onChange={set('email')}
                   placeholder="thabo@rapidwheels.co.za" style={{ width: '100%', marginTop: 4 }} />
          </label>

          <label>
            <span className="text-sm">Phone <span className="muted">(optional)</span></span>
            <input value={form.phone} onChange={set('phone')}
                   placeholder="081 000 0000" style={{ width: '100%', marginTop: 4 }} />
          </label>

          <label>
            <span className="text-sm">City <span className="muted">(optional)</span></span>
            <input value={form.city} onChange={set('city')}
                   placeholder="Johannesburg" style={{ width: '100%', marginTop: 4 }} />
          </label>

          <label>
            <span className="text-sm">Bikes they run</span>
            <input type="number" min="0" value={form.fleet_size} onChange={set('fleet_size')}
                   placeholder="24" style={{ width: '100%', marginTop: 4 }} />
          </label>

          <label>
            <span className="text-sm">Plan</span>
            <select value={form.plan_key} onChange={set('plan_key')} style={{ width: '100%', marginTop: 4 }}>
              {PLANS.map(([k, label, limits]) => (
                <option key={k} value={k}>{label} — {limits}</option>
              ))}
            </select>
          </label>

          <label style={{ gridColumn: '1 / -1' }}>
            <span className="text-sm">Start them</span>
            <select value={form.status} onChange={set('status')} style={{ width: '100%', marginTop: 4 }}>
              <option value="trialing">On a 14-day trial</option>
              <option value="active">Active — they are paying from today</option>
            </select>
            <span className="text-xs muted">
              {form.status === 'trialing'
                ? 'The trial clock starts now and they are billed when it ends.'
                : 'No trial clock. Use this when the deal is already signed.'}
            </span>
          </label>
        </div>

        <label className="row gap-2" style={{ alignItems: 'flex-start', marginTop: 14 }}>
          <input type="checkbox" checked={form.send_invite} onChange={set('send_invite')}
                 style={{ marginTop: 3 }} />
          <span>
            <span className="text-sm">Email them an invite now</span>
            <span className="text-xs muted" style={{ display: 'block' }}>
              They set their own password from the link. Leave this off and the account
              is created but unusable until you send one.
            </span>
          </span>
        </label>

        <div className="row gap-2" style={{ marginTop: 18 }}>
          <button className="btn" type="submit" disabled={saving}>
            <Building2 size={15} /> {saving ? 'Creating…' : 'Create fleet'}
          </button>
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
