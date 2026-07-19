import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../api';
import { useAuth } from '../../auth';
import { ConfirmModal, EmptyState, Loading, SearchInput, matchesSearch } from '../../components/ui';
import { canManageFleetSection } from './access';

function buildForm() {
  return { name: '', address: '', city: '', contact_name: '', contact_phone: '', notes: '' };
}

export default function Hubs() {
  const { user } = useAuth();
  const canManage = canManageFleetSection(user?.role, 'hubs');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hubs, setHubs] = useState([]);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('');
  const [form, setForm] = useState(buildForm());
  const [editId, setEditId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/fleet/hubs');
      setHubs(data.hubs || []);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load hubs');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => hubs.filter((h) => matchesSearch(search, h.name, h.city, h.contact_name)), [hubs, search]);

  const setText = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const openCreate = () => {
    setMode('create');
    setForm(buildForm());
    setEditId(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openEdit = (hub) => {
    setMode('edit');
    setEditId(hub.id);
    setForm({ name: hub.name || '', address: hub.address || '', city: hub.city || '', contact_name: hub.contact_name || '', contact_phone: hub.contact_phone || '', notes: hub.notes || '' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const reset = () => { setMode(''); setEditId(null); setForm(buildForm()); };

  const submit = async () => {
    if (!form.name.trim()) return toast.error('Hub name is required');
    setSaving(true);
    try {
      if (mode === 'create') {
        await api.post('/fleet/hubs', form);
        toast.success('Hub created');
      } else {
        await api.put(`/fleet/hubs/${editId}`, form);
        toast.success('Hub updated');
      }
      reset();
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not save hub');
    } finally {
      setSaving(false);
    }
  };

  const deleteHub = async (hub) => {
    try {
      await api.delete(`/fleet/hubs/${hub.id}`);
      toast.success('Hub deleted');
      setConfirmDelete(null);
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not delete hub');
    }
  };

  if (loading) return <Loading />;

  return (
    <>
      <div className="flex-between mb-4" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Hubs</h1>
          <p className="page-sub">Manage branch locations. Assign bikes to hubs to filter and group your fleet by location.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search hub name, city" style={{ width: 280 }} />
          {canManage && <button className="btn" onClick={openCreate}>Add hub</button>}
        </div>
      </div>

      {mode && canManage && (
        <div className="card mb-4">
          <div className="flex-between mb-3">
            <h3>{mode === 'create' ? 'Add hub' : 'Edit hub'}</h3>
            <button className="btn btn-secondary" onClick={reset}>Cancel</button>
          </div>
          <div className="grid grid-2">
            <div className="field"><label className="label">Hub name *</label><input value={form.name} onChange={setText('name')} placeholder="Johannesburg North" /></div>
            <div className="field"><label className="label">City</label><input value={form.city} onChange={setText('city')} placeholder="Johannesburg" /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Address</label><input value={form.address} onChange={setText('address')} placeholder="123 Main Road, Northgate" /></div>
            <div className="field"><label className="label">Contact name</label><input value={form.contact_name} onChange={setText('contact_name')} /></div>
            <div className="field"><label className="label">Contact phone</label><input value={form.contact_phone} onChange={setText('contact_phone')} placeholder="+27 82 123 4567" /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Notes</label><textarea rows="2" value={form.notes} onChange={setText('notes')} placeholder="Operating hours, access instructions, etc." /></div>
          </div>
          <div className="row mt-3" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" onClick={reset}>Cancel</button>
            <button className="btn" disabled={saving} onClick={submit}>{saving ? 'Saving…' : mode === 'create' ? 'Create hub' : 'Save changes'}</button>
          </div>
        </div>
      )}

      {!filtered.length && <EmptyState title="No hubs yet" sub="Create a hub to group bikes by branch or location." action={canManage ? <button className="btn" onClick={openCreate}>Add hub</button> : null} />}

      <div className="grid grid-2">
        {filtered.map((hub) => (
          <div key={hub.id} className="card">
            <div className="flex-between mb-2">
              <strong>{hub.name}</strong>
              {canManage && (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => openEdit(hub)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(hub)}>Delete</button>
                </div>
              )}
            </div>
            {hub.city && <div className="text-sm muted">{hub.city}</div>}
            {hub.address && <div className="text-sm muted">{hub.address}</div>}
            {hub.contact_name && <div className="text-sm mt-2"><strong>Contact:</strong> {hub.contact_name}{hub.contact_phone ? ` · ${hub.contact_phone}` : ''}</div>}
            {hub.notes && <div className="text-xs muted mt-2">{hub.notes}</div>}
          </div>
        ))}
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Delete hub"
          body={`Delete "${confirmDelete.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => deleteHub(confirmDelete)}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
