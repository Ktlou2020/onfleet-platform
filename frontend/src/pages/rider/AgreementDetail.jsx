import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';
import api from '../../api';
import { Loading, Badge, Stat, fmt, fmtDate, fmtDateTime } from '../../components/ui';

const bikeIcon = new L.DivIcon({
  html: `<div style="background:var(--primary);width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white;box-shadow:0 4px 10px rgba(0,0,0,0.3)">🏍️</div>`,
  className: '', iconSize: [30,30], iconAnchor: [15,15]
});

export default function RiderAgreementDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [bike, setBike] = useState(null);

  useEffect(() => {
    api.get(`/agreements/${id}`).then(r => {
      setData(r.data);
      api.get(`/bikes/${r.data.agreement.bike_id}`).then(b => setBike(b.data));
    });
  }, [id]);
  if (!data) return <Loading />;
  const { agreement, schedule, payments, summary } = data;
  const positions = bike?.gps_history?.map(p => [p.lat, p.lng]) || [];
  const currentPos = bike?.bike?.last_known_lat ? [bike.bike.last_known_lat, bike.bike.last_known_lng] : null;

  return (
    <>
      <Link to="/agreements" className="muted text-sm">← Back to agreements</Link>
      <div className="flex-between mt-2 mb-4">
        <div>
          <h1 className="page-title">{agreement.agreement_no}</h1>
          <div className="muted">{agreement.make} {agreement.model} · {agreement.registration || agreement.vin}</div>
        </div>
        <Badge status={agreement.status} />
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Weekly" value={fmt(agreement.weekly_amount)} />
        <Stat label="Paid" value={fmt(summary.total_paid)} accent="var(--success)" />
        <Stat label="Remaining" value={fmt(summary.remaining)} accent="var(--accent)" />
        <Stat label="Progress" value={`${summary.progress_pct}%`} accent="var(--primary)" />
      </div>

      <div className="card mb-4">
        <h3 className="mb-3">Progress to ownership</h3>
        <div className="progress-bar"><div className="progress-fill" style={{ width: `${summary.progress_pct}%` }} /></div>
        <div className="flex-between mt-3 text-sm">
          <div className="muted">Started {fmtDate(agreement.start_date)}</div>
          <div className="muted">{summary.weeks_paid} of {summary.weeks_total} weeks</div>
          <div className="muted">Ownership {fmtDate(agreement.end_date)}</div>
        </div>
      </div>

      {currentPos && (
        <div className="card mb-4">
          <div className="card-title"><h3>🛰️ Live bike location</h3>
            <div className="muted text-xs">Last seen {fmtDateTime(bike.bike.last_location_at)}</div></div>
          <div style={{ height: 360, borderRadius: 12, overflow: 'hidden' }}>
            <MapContainer center={currentPos} zoom={13} style={{ height: '100%' }}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <Marker position={currentPos} icon={bikeIcon}>
                <Popup>{agreement.make} {agreement.model}<br/>{agreement.registration}</Popup>
              </Marker>
              {positions.length > 1 && <Polyline positions={positions} color="#ff6b35" weight={3} opacity={0.7} />}
            </MapContainer>
          </div>
          <div className="grid grid-3 mt-3 text-sm">
            <div><span className="muted">Odometer:</span> {bike.bike.odometer_km || 0} km</div>
            <div><span className="muted">Next service:</span> {fmtDate(bike.bike.next_service_date)}</div>
            <div><span className="muted">Insurance expires:</span> {fmtDate(bike.bike.insurance_expiry)}</div>
          </div>
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <div className="card-title"><h3>Payment schedule</h3>
            <Link to="/payments" className="btn btn-sm">Pay now</Link></div>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>#</th><th>Due</th><th>Amount</th><th>Paid</th><th>Status</th></tr></thead>
              <tbody>
                {schedule.map(s => (
                  <tr key={s.id}>
                    <td>{s.week_number}</td>
                    <td>{fmtDate(s.due_date)}</td>
                    <td>{fmt(s.amount_due)}</td>
                    <td>{fmt(s.amount_paid)}</td>
                    <td><Badge status={s.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3 className="mb-3">Payment history</h3>
          {!payments.length && <div className="muted text-sm">No payments yet.</div>}
          <table className="table">
            <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead>
            <tbody>
              {payments.map(p => (
                <tr key={p.id}>
                  <td>{fmtDate(p.paid_at || p.created_at)}</td>
                  <td><Badge status="info">{p.method}</Badge></td>
                  <td className="text-xs muted">{p.reference}</td>
                  <td><strong>{fmt(p.amount)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {bike?.services?.length > 0 && (
        <div className="card mt-4">
          <h3 className="mb-3">🔧 Service history</h3>
          <table className="table">
            <thead><tr><th>Date</th><th>Type</th><th>Odometer</th><th>Description</th><th>Cost</th></tr></thead>
            <tbody>
              {bike.services.map(s => (
                <tr key={s.id}>
                  <td>{fmtDate(s.service_date)}</td>
                  <td>{s.service_type}</td>
                  <td>{s.odometer_km} km</td>
                  <td className="text-sm muted">{s.description}</td>
                  <td>{s.cost ? fmt(s.cost) : <span className="badge badge-success">FREE</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
