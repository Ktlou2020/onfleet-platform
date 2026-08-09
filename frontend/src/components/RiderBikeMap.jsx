import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';

const bikeIcon = new L.DivIcon({
  html: `<div style="background:var(--primary);width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white;box-shadow:0 4px 10px rgba(0,0,0,0.3)">🏍️</div>`,
  className: '', iconSize: [30, 30], iconAnchor: [15, 15]
});

// Split out of AgreementDetail.jsx and lazy-loaded there — leaflet/react-leaflet
// is a heavy dependency (~150KB+) that shouldn't download on every visit to a
// page riders check routinely, when the map itself only renders conditionally.
export default function RiderBikeMap({ currentPos, positions, agreement }) {
  return (
    <MapContainer center={currentPos} zoom={13} style={{ height: '100%' }}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <Marker position={currentPos} icon={bikeIcon}><Popup>{agreement.make} {agreement.model}<br />{agreement.registration}</Popup></Marker>
      {positions.length > 1 && <Polyline positions={positions} color="#1E88D1" weight={3} opacity={0.7} />}
    </MapContainer>
  );
}
