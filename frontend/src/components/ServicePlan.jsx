import { useCallback, useEffect, useState } from 'react';
import { Wrench, AlertTriangle, Clock, Plus } from 'lucide-react';
import api from '../api';
import { fmt } from './ui';

// What the manufacturer says this bike needs at the kilometres on its clock.
//
// The chart and the 36-month schedule used to live on paper, so a service was
// whatever the technician remembered and parts were ordered once the bike was
// already apart. This shows the tasks for the service the bike is at, the
// parts due now with their price, and what is close enough to be worth doing
// while the bike is on the ramp.

const money = (value) => (value == null ? '—' : fmt(Number(value)));

export default function ServicePlan({ bikeId, odometerKm, onAddPart = null, compact = false }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!bikeId) { setLoading(false); return; }
    setLoading(true);
    try {
      const { data } = await api.get('/workshop/service-plan', {
        params: { bike_id: bikeId, odometer_km: odometerKm || undefined },
      });
      setPlan(data);
    } catch {
      setPlan(null);
    } finally { setLoading(false); }
  }, [bikeId, odometerKm]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="text-sm muted">Checking the service schedule…</div>;
  if (!plan) return null;
  if (!plan.has_schedule) {
    return (
      <div className="text-sm muted">
        No service schedule loaded for {plan.make} {plan.model}. An admin can add one from the manufacturer's maintenance chart.
      </div>
    );
  }

  const { service, tasks, parts_due: due, parts_soon: soon } = plan;

  return (
    <div>
      <div className="flex-between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <strong>
            {service ? `Service ${service.service_no}` : 'Service'}
            {service?.repeat_of ? ` (the ${service.repeat_of}${['st', 'nd', 'rd'][service.repeat_of - 1] || 'th'}-service list, repeating)` : ''}
          </strong>
          <span className="text-sm muted"> · at {Number(plan.odometer_km).toLocaleString()} km</span>
        </div>
        {plan.next_service_km && <span className="text-xs muted">Next around {plan.next_service_km.toLocaleString()} km</span>}
      </div>

      {due.length > 0 && (
        <div className="mt-2">
          <div className="text-xs" style={{ fontWeight: 700, color: 'var(--danger)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
            <AlertTriangle size={11} /> Replace now — {due.length} part{due.length === 1 ? '' : 's'} · {money(plan.parts_due_total_ex_vat)} excl. VAT
          </div>
          <table className="table" style={{ marginTop: 4 }}>
            <tbody>
              {due.map((part) => (
                <tr key={`${part.part_number}-${part.description}`}>
                  <td style={{ width: 24 }}><Wrench size={12} /></td>
                  <td>
                    {part.description}
                    {part.last_fitted_km != null && (
                      <span className="text-xs muted"> · last fitted at {Number(part.last_fitted_km).toLocaleString()} km</span>
                    )}
                  </td>
                  <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                    {part.part_number}
                    {!part.in_catalogue && <span className="text-xs muted"> · not in the price list</span>}
                    {/* Two of the manufacturer's documents can disagree by a
                        character. Say so and offer the nearest, rather than
                        substituting: the supplier ships the number asked for. */}
                    {!part.in_catalogue && part.did_you_mean?.length > 0 && (
                      <div className="text-xs" style={{ color: 'var(--warn, #b45309)', whiteSpace: 'normal' }}>
                        Closest in the price list: {part.did_you_mean[0].part_number} ({part.did_you_mean[0].description},
                        {' '}{money(part.did_you_mean[0].price_ex_vat)}) — check which is right before ordering
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{money(part.price_ex_vat)}</td>
                  {onAddPart && (
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-sm btn-secondary" style={{ padding: '2px 7px' }}
                        onClick={() => onAddPart(part)} title="Add to this job card">
                        <Plus size={11} /> Add
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {soon.length > 0 && (
        <div className="mt-3">
          <div className="text-xs" style={{ fontWeight: 700, color: 'var(--warn, #b45309)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
            <Clock size={11} /> Worth doing while it is here
          </div>
          <table className="table" style={{ marginTop: 4 }}>
            <tbody>
              {soon.map((part) => (
                <tr key={`${part.part_number}-soon`}>
                  <td>{part.description}</td>
                  <td className="text-sm muted">due in {Number(part.km_until).toLocaleString()} km</td>
                  <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{part.part_number}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{money(part.price_ex_vat)}</td>
                  {onAddPart && (
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-sm btn-secondary" style={{ padding: '2px 7px' }} onClick={() => onAddPart(part)}>
                        <Plus size={11} /> Add
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!compact && tasks.length > 0 && (
        <div className="mt-3">
          <div className="text-xs muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px' }}>
            Check list for this service ({tasks.length})
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '2px 14px', marginTop: 4 }}>
            {tasks.map((task) => (
              <div key={task.item} className="text-sm" style={{ display: 'flex', gap: 6 }} title={task.note || ''}>
                <span style={{ color: task.replaces ? 'var(--danger)' : 'var(--muted)' }}>•</span>
                <span style={{ flex: 1 }}>{task.item.replace(/[*^@]+$/, '')}</span>
                <span className="text-xs muted">{task.actions_text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {due.length === 0 && soon.length === 0 && (
        <div className="text-sm muted mt-2">No parts are due at this reading — the check list above still applies.</div>
      )}
    </div>
  );
}
