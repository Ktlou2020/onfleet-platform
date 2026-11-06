import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import { api, useAuth, useLoc, useMeta, useToast } from '../lib.jsx';

export const pin = (emoji, cls = '') => L.divIcon({ className: `map-pin ${cls}`, html: `<span><i>${emoji}</i></span>`, iconSize: [36, 36], iconAnchor: [18, 34] });
const DEFAULT_TILES = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 };

// The map background, from whichever tile provider the server is set up
// with. Tile servers need a Referer to accept requests, so send the origin.
export function MapTiles() {
  const meta = useMeta();
  const t = meta?.mapTiles || DEFAULT_TILES;
  return <TileLayer key={t.url} url={t.url} attribution={t.attribution} maxZoom={t.maxZoom} referrerPolicy="strict-origin-when-cross-origin" />;
}

function ClickToMove({ onPick }) {
  useMapEvents({ click: (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

function Recenter({ point }) {
  const map = useMap();
  useEffect(() => { map.setView([point.lat, point.lng], Math.max(map.getZoom(), 14)); }, [point.lat, point.lng, map]);
  return null;
}

// The address picker. Signed-in customers see their saved addresses first
// and can save a new one as Home, Work or anything else. With `saveOnly`
// (from the Account page) it just saves an address without delivering there.
export function AddressSheet({ onClose, saveOnly = false, onSaved }) {
  const meta = useMeta();
  const { loc, setLoc } = useLoc();
  const { user } = useAuth();
  const notify = useToast();
  const isCustomer = user?.role === 'customer';
  const [saved, setSaved] = useState([]);
  const [adding, setAdding] = useState(saveOnly);
  const [saveAs, setSaveAs] = useState(saveOnly ? 'Home' : '');
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (isCustomer && !saveOnly) api('/me/addresses').then((d) => { setSaved(d.addresses); if (!d.addresses.length) setAdding(true); }).catch(() => setAdding(true));
    else setAdding(true);
  }, [isCustomer, saveOnly]);
  const [point, setPoint] = useState(loc ? { lat: loc.lat, lng: loc.lng } : { lat: -26.1076, lng: 28.0567 });
  const [label, setLabel] = useState(loc?.label || '');
  const [unit, setUnit] = useState('');
  const [city, setCity] = useState(loc?.city || 'johannesburg');
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  // Where the address text came from: what the person typed (never
  // overwrite it), a suggestion they picked, or a lookup of the pin.
  const source = useRef(loc?.label ? 'pick' : 'auto');
  const [suggestions, setSuggestions] = useState([]);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [lookupNote, setLookupNote] = useState('');
  const searchSeq = useRef(0);

  // Suggestions as you type, biased towards where the pin is now.
  useEffect(() => {
    if (source.current !== 'typed' || label.trim().length < 3) { setSuggestions([]); return undefined; }
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(() => {
      api(`/geocode/search?q=${encodeURIComponent(label.trim())}&lat=${point.lat}&lng=${point.lng}`)
        .then((d) => { if (seq === searchSeq.current) { setSuggestions(d.results); setActive(-1); setLookupNote(''); } })
        .catch((e) => { if (seq === searchSeq.current) { setSuggestions([]); setLookupNote(e.message); } })
        .finally(() => { if (seq === searchSeq.current) setSearching(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [label]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (s) => {
    source.current = 'pick';
    searchSeq.current++;
    setLabel(s.label);
    setPoint({ lat: s.lat, lng: s.lng });
    setSuggestions([]);
    setError('');
  };

  // Moving the pin fills in the street address — unless they typed their own.
  const movePin = (p) => {
    setPoint(p);
    if (source.current === 'typed' && label.trim()) return;
    api(`/geocode/reverse?lat=${p.lat}&lng=${p.lng}`)
      .then((d) => { if (d.place && (source.current !== 'typed' || !label.trim())) { source.current = 'auto'; setLabel(d.place.label); } })
      .catch(() => {});
  };

  const onKey = (e) => {
    if (!suggestions.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, suggestions.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(suggestions[active]); }
    if (e.key === 'Escape') setSuggestions([]);
  };

  const nearestCity = (p) => {
    if (!meta) return city;
    let best = meta.cities[0];
    for (const c of meta.cities) if (Math.hypot(c.lat - p.lat, c.lng - p.lng) < Math.hypot(best.lat - p.lat, best.lng - p.lng)) best = c;
    return best.slug;
  };

  const useMine = () => {
    if (!navigator.geolocation) return setError('Your browser cannot share its location');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const here = { lat: p.coords.latitude, lng: p.coords.longitude };
        source.current = 'auto';
        movePin(here);
        setCity(nearestCity(here));
        setLocating(false);
      },
      () => { setError('We could not get your location — tap the map instead'); setLocating(false); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const pick = (a) => {
    setLoc({ lat: a.lat, lng: a.lng, label: a.address, city: a.city || nearestCity(a), savedId: a.id, savedLabel: a.label });
    onClose();
  };

  const save = async () => {
    if (label.trim().length < 5) return setError('Add your street address so the rider can find you');
    const full = unit.trim() ? `${unit.trim()}, ${label.trim()}` : label.trim();
    const here = { ...point, label: full, city: nearestCity(point) };
    if (isCustomer && saveAs.trim()) {
      try {
        const d = await api('/me/addresses', { method: 'POST', body: { label: saveAs.trim(), address: here.label, lat: here.lat, lng: here.lng, city: here.city, notes } });
        onSaved?.(d.address);
        if (saveOnly) { notify(`Saved ${d.address.label}`, 'ok'); onClose(); return; }
        here.savedId = d.address.id;
        here.savedLabel = d.address.label;
      } catch (e) { return setError(e.message); }
    }
    setLoc(here);
    onClose();
  };

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && loc && onClose()}>
      <div className="sheet" role="dialog" aria-label="Delivery address">
        <div className="sheet-handle" />
        <h2>{saveOnly ? 'Add an address' : 'Where should we deliver?'}</h2>
        {!saveOnly && saved.length > 0 && (
          <div className="saved-list">
            {saved.map((a) => (
              <button key={a.id} className={`saved-addr ${loc?.savedId === a.id ? 'on' : ''}`} onClick={() => pick(a)}>
                <span className="saved-icon">{/home/i.test(a.label) ? '🏠' : /work|office/i.test(a.label) ? '💼' : '📍'}</span>
                <span className="grow"><strong>{a.label}</strong><em>{a.address}</em></span>
                {loc?.savedId === a.id && <span className="tag">current</span>}
              </button>
            ))}
            {!adding && <button className="btn btn-ghost full" onClick={() => setAdding(true)}>+ Use a new address</button>}
          </div>
        )}
        {adding && <>
        <div className="chips">
          {meta?.cities.map((c) => (
            <button key={c.slug} className={`chip ${city === c.slug ? 'on' : ''}`} onClick={() => { setCity(c.slug); setPoint({ lat: c.lat, lng: c.lng }); }}>
              {c.name}
            </button>
          ))}
        </div>
        <div className="addr-search">
          <label className="field">
            <span>Street address</span>
            <input
              value={label}
              onChange={(e) => { source.current = 'typed'; setLabel(e.target.value); setError(''); }}
              onKeyDown={onKey}
              onBlur={() => setTimeout(() => setSuggestions([]), 150)}
              placeholder="Start typing, e.g. 14 Jan Smuts"
              autoComplete="off"
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-controls="addr-suggestions"
              aria-autocomplete="list"
            />
          </label>
          {searching && <span className="addr-spinner" aria-hidden="true" />}
          {suggestions.length > 0 && (
            <ul className="addr-suggestions" id="addr-suggestions" role="listbox">
              {suggestions.map((s, i) => (
                <li key={`${s.lat},${s.lng},${i}`} role="option" aria-selected={i === active}>
                  <button type="button" className={i === active ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(s)}>
                    <span>📍</span>
                    <span className="grow"><strong>{s.main || s.label}</strong>{s.secondary && <em>{s.secondary}</em>}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {lookupNote && <p className="hint">{lookupNote}</p>}
        </div>
        <button className="btn btn-ghost full" onClick={useMine} disabled={locating}>{locating ? 'Finding you…' : '📍 Use my current location'}</button>
        <div className="map-box small">
          <MapContainer center={[point.lat, point.lng]} zoom={15} scrollWheelZoom style={{ height: '100%' }}>
            <MapTiles />
            <Marker position={[point.lat, point.lng]} icon={pin('🏠', 'home')} draggable eventHandlers={{ dragend: (e) => movePin(e.target.getLatLng()) }} />
            <ClickToMove onPick={movePin} />
            <Recenter point={point} />
          </MapContainer>
        </div>
        <p className="hint">Check the pin is on your door — drag it if not.</p>
        <label className="field">
          <span>Unit, flat or complex (optional)</span>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. Unit 3, The Avenues" autoComplete="address-line2" />
        </label>
        {isCustomer && (
          <div className="save-as">
            <span className="small muted">{saveOnly ? 'Name it' : 'Save it for next time? (optional)'}</span>
            <div className="chips">
              {['Home', 'Work', 'Other'].map((l) => <button key={l} type="button" className={`chip ${saveAs === l ? 'on' : ''}`} onClick={() => setSaveAs(saveAs === l && !saveOnly ? '' : l)}>{l === 'Home' ? '🏠 ' : l === 'Work' ? '💼 ' : '📍 '}{l}</button>)}
            </div>
            {saveAs && <input className="notes-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Gate code, complex, landmark (optional)" maxLength={200} aria-label="Address notes" />}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn btn-lg full" onClick={save}>{saveOnly ? 'Save address' : saveAs ? `Save as ${saveAs} & deliver here` : 'Deliver here'}</button>
        </>}
      </div>
    </div>
  );
}
