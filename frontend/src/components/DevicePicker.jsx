import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';

// Picking one tracker out of the fleet.
//
// This was a native <select>. That is fine for five devices and unusable at
// ninety: the browser gives you no search box, so finding MH29SRGP meant
// scrolling a list ordered by nothing in particular and reading IMEIs.
//
// Searches everything the device list on the tracking screen searches — label,
// IMEI, registration, tracker model — so somebody who has just found a bike
// there can type the same thing here and get the same hit, plus the bike's own
// make, model and VIN, which that list leaves out.
//
// Deliberately a superset rather than a different set. A picker that finds
// less than the list would send people back to the list to read off an IMEI;
// finding more only ever means the thing you typed works.
//
// Note `model` is the TRACKER's (FMB920), and `bike_model` is the
// motorcycle's (Eco 150). Searching "Boxer" and getting nothing because only
// one of those was indexed is exactly the kind of quiet gap this exists to
// avoid.
const FIELDS = (d) => [d.label, d.imei, d.registration, d.model, d.make, d.bike_model, d.bike_vin];

const STATUS_DOT = {
  active: '#22c55e',
  sleeping: '#6366f1',
};

function describe(d) {
  const name = d.label || d.registration || d.imei;
  const bike = [d.make, d.bike_model].filter(Boolean).join(' ');
  const parts = [];
  if (d.registration && d.registration !== name) parts.push(d.registration);
  if (bike) parts.push(bike);
  if (d.model) parts.push(d.model);
  if (d.imei && d.imei !== name) parts.push(d.imei);
  return { name, sub: parts.join(' · ') };
}

export default function DevicePicker({
  devices = [],
  value = null,
  onChange,
  allLabel = 'All devices (global default)',
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const selected = value ? devices.find((d) => d.id === value) : null;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return devices;
    return devices.filter((d) =>
      FIELDS(d).some((v) => String(v || '').toLowerCase().includes(needle)));
  }, [devices, query]);

  // The "all devices" row is an option like any other when nothing has been
  // typed, and gets out of the way once somebody is searching for a bike.
  const options = query.trim() ? matches : [null, ...matches];

  useEffect(() => { setHighlight(0); }, [query, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery('');
  }, [open]);

  // Keeps the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const choose = (device) => {
    onChange(device ? device.id : null);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (options.length) choose(options[highlight]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const control = {
    width: '100%', fontSize: 12, padding: '7px 10px', borderRadius: 7,
    border: '1px solid var(--border)', background: 'var(--surface)',
    color: 'var(--text)', cursor: disabled ? 'default' : 'pointer',
    display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button type="button" style={control} disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox" aria-expanded={open}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? describe(selected).name : allLabel}
          {selected && describe(selected).sub && (
            <span className="muted" style={{ marginLeft: 6 }}>{describe(selected).sub}</span>
          )}
        </span>
        {selected && (
          <span role="button" tabIndex={-1} title="Back to the global default"
            onClick={(e) => { e.stopPropagation(); choose(null); }}
            style={{ display: 'flex', opacity: 0.6 }}>
            <X size={12} />
          </span>
        )}
        <ChevronDown size={13} style={{ opacity: 0.6, flexShrink: 0 }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.35)', overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', borderBottom: '1px solid var(--border)' }}>
            <Search size={12} style={{ opacity: 0.5, flexShrink: 0 }} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Registration, IMEI, VIN, make or model"
              style={{
                flex: 1, border: 'none', outline: 'none', background: 'transparent',
                color: 'var(--text)', fontSize: 12, padding: 0,
              }}
            />
            {query && (
              <button type="button" onClick={() => { setQuery(''); inputRef.current?.focus(); }}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0, display: 'flex' }}>
                <X size={12} />
              </button>
            )}
          </div>

          <div ref={listRef} style={{ maxHeight: 260, overflowY: 'auto' }}>
            {options.length === 0 && (
              <div className="text-xs muted" style={{ padding: '12px 10px' }}>
                No tracker matches “{query}” by registration, IMEI, VIN, make or model.
              </div>
            )}
            {options.map((d, i) => {
              const on = i === highlight;
              const isAll = d === null;
              const { name, sub } = isAll ? { name: allLabel, sub: '' } : describe(d);
              const chosen = isAll ? !value : d.id === value;
              return (
                <button
                  key={isAll ? '__all__' : d.id}
                  type="button"
                  data-highlighted={on ? 'true' : 'false'}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(d)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 10px', border: 'none', textAlign: 'left', cursor: 'pointer',
                    background: on ? 'var(--surface-2)' : 'transparent', color: 'var(--text)',
                  }}
                >
                  {!isAll && (
                    <span style={{
                      width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                      background: STATUS_DOT[d.device_status] || 'var(--muted)',
                    }} />
                  )}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    {sub && <span className="text-xs muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
                  </span>
                  {chosen && <Check size={12} style={{ flexShrink: 0, opacity: 0.7 }} />}
                </button>
              );
            })}
          </div>

          {devices.length > 0 && (
            <div className="text-xs muted" style={{ padding: '5px 10px', borderTop: '1px solid var(--border)' }}>
              {query.trim() ? `${matches.length} of ${devices.length}` : `${devices.length} trackers`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
