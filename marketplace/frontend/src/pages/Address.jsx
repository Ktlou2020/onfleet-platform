import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import { api, useAuth, useLoc, useMeta, useToast } from '../lib.jsx';

export const pin = (emoji, cls = '') => L.divIcon({ className: `map-pin ${cls}`, html: `<span><i>${emoji}</i></span>`, iconSize: [36, 36], iconAnchor: [18, 34] });
export const TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
export const TILE_ATTR = '&copy; OpenStreetMap contributors &copy; CARTO';

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
  const [city, setCity] = useState(loc?.city || 'johannesburg');
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');

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
        setPoint(here);
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
    const here = { ...point, label: label.trim(), city: nearestCity(point) };
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
        <button className="btn btn-ghost full" onClick={useMine} disabled={locating}>{locating ? 'Finding you…' : '📍 Use my current location'}</button>
        <div className="map-box small">
          <MapContainer center={[point.lat, point.lng]} zoom={14} scrollWheelZoom style={{ height: '100%' }}>
            <TileLayer url={TILE_URL} attribution={TILE_ATTR} />
            <Marker position={[point.lat, point.lng]} icon={pin('🏠', 'home')} draggable eventHandlers={{ dragend: (e) => setPoint(e.target.getLatLng()) }} />
            <ClickToMove onPick={setPoint} />
            <Recenter point={point} />
          </MapContainer>
        </div>
        <p className="hint">Tap the map or drag the pin to your exact door.</p>
        <label className="field">
          <span>Street address, unit, complex</span>
          <input value={label} onChange={(e) => { setLabel(e.target.value); setError(''); }} placeholder="e.g. 14 Jan Smuts Ave, Unit 3" autoComplete="street-address" />
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
