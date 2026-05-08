import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Stat, fmt, fmtDate, fmtDateTime } from '../../components/ui';

const bikeIcon = new L.DivIcon({
  html: `<div style="background:var(--primary);width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white;box-shadow:0 4px 10px rgba(0,0,0,0.3)">🏍️</div>`,
  className: '', iconSize: [30, 30], iconAnchor: [15, 15]
});

export default function RiderAgreementDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [bike, setBike] = useState(null);
  const [signing, setSigning] = useState(false);

  const load = () => api.get(`/agreements/${id}`).then((response) => {
    setData(response.data);
    api.get(`/bikes/${response.data.agreement.bike_id}`).then((bikeResponse) => setBike(bikeResponse.data));
  });
  useEffect(() => { load(); }, [id]);
  if (!data) return <Loading />;
  const { agreement, schedule, payments, summary, application_documents: applicationDocuments = [] } = data;
  const positions = bike?.gps_history?.map((point) => [point.lat, point.lng]) || [];
  const currentPos = bike?.bike?.last_known_lat ? [bike.bike.last_known_lat, bike.bike.last_known_lng] : null;

  const signAgreement = async () => {
    setSigning(true);
    try {
      await api.post(`/agreements/${id}/sign`, { signature: `${agreement.full_name} · ${new Date().toLocaleString('en-ZA')}` });
      toast.success('Agreement signed electronically');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not sign agreement');
    } finally {
      setSigning(false);
    }
  };

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
        <div className="flex-between mb-3">
          <h3>Electronic contract</h3>
          <div className="row">
            {agreement.contract_file_path && <a href={agreement.contract_file_path} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">View contract</a>}
            {agreement.signed_contract_path && <a href={agreement.signed_contract_path} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">Signed copy</a>}
            {!agreement.signed_at && <button className="btn btn-sm" onClick={signAgreement} disabled={signing}>{signing ? 'Signing…' : 'Sign now'}</button>}
          </div>
        </div>
        <div className="muted text-sm">Once you sign, the signed copy is saved back onto your application record for admin review and auditing.</div>
        {agreement.signed_at && <div className="mt-2 text-sm">Signed on {fmtDateTime(agreement.signed_at)}</div>}
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
          <div className="card-title"><h3>Live bike location</h3><div className="muted text-xs">Last seen {fmtDateTime(bike.bike.last_location_at)}</div></div>
          <div style={{ height: 360, borderRadius: 12, overflow: 'hidden' }}>
            <MapContainer center={currentPos} zoom={13} style={{ height: '100%' }}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <Marker position={currentPos} icon={bikeIcon}><Popup>{agreement.make} {agreement.model}<br />{agreement.registration}</Popup></Marker>
              {positions.length > 1 && <Polyline positions={positions} color="#1E88D1" weight={3} opacity={0.7} />}
            </MapContainer>
          </div>
        </div>
      )}

      <div className="grid grid-2 mb-4">
        <div className="card">
          <div className="card-title"><h3>Payment schedule</h3><Link to="/payments" className="btn btn-sm">Pay now</Link></div>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>#</th><th>Due</th><th>Amount</th><th>Paid</th><th>Status</th></tr></thead>
              <tbody>
                {schedule.map((row) => (
                  <tr key={row.id}><td>{row.week_number}</td><td>{fmtDate(row.due_date)}</td><td>{fmt(row.amount_due)}</td><td>{fmt(row.amount_paid)}</td><td><Badge status={row.status} /></td></tr>
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
              {payments.map((payment) => (
                <tr key={payment.id}><td>{fmtDate(payment.paid_at || payment.created_at)}</td><td><Badge>{payment.method}</Badge></td><td className="text-xs muted">{payment.reference}</td><td><strong>{fmt(payment.amount)}</strong></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3 className="mb-3">Application documents</h3>
        <table className="table">
          <thead><tr><th>Type</th><th>File</th><th></th></tr></thead>
          <tbody>
            {applicationDocuments.map((doc) => (
              <tr key={doc.id}><td>{doc.doc_type.replace(/_/g, ' ')}</td><td>{doc.original_name}</td><td><a href={doc.file_path} target="_blank" rel="noreferrer">Open</a></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
