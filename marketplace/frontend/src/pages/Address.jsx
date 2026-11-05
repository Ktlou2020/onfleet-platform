import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import { useLoc, useMeta } from '../lib.jsx';

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

export function AddressSheet({ onClose }) {
  const meta = useMeta();
  const { loc, setLoc } = useLoc();
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

  const save = () => {
    if (label.trim().length < 5) return setError('Add your street address so the rider can find you');
    setLoc({ ...point, label: label.trim(), city: nearestCity(point) });
    onClose();
  };

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && loc && onClose()}>
      <div className="sheet" role="dialog" aria-label="Delivery address">
        <div className="sheet-handle" />
        <h2>Where should we deliver?</h2>
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
        {error && <p className="error">{error}</p>}
        <button className="btn btn-lg full" onClick={save}>Save address</button>
      </div>
    </div>
  );
}
