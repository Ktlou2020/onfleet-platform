import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Stat, Modal, fmt, fmtDate, fmtDateTime } from '../../components/ui';

const creditedAmount = (payment) => Number(payment?.net_amount || payment?.amount || 0);
const feeAmount = (payment) => Number(payment?.fee_amount || 0);
const grossAmount = (payment) => Number(payment?.amount || 0);

export default function AdminAgreementDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [showPay, setShowPay] = useState(false);
  const [pay, setPay] = useState({ amount: '', method: 'eft', reference: '', notes: '' });
  const [busyAction, setBusyAction] = useState('');

  const load = () => api.get(`/agreements/${id}`).then((response) => {
    setData(response.data);
    setPay((current) => ({ ...current, amount: response.data.agreement.weekly_amount }));
  });

  useEffect(() => { load(); }, [id]);
  if (!data) return <Loading />;

  const { agreement, schedule, payments, summary, application_documents: applicationDocuments = [] } = data;
  const isDiscontinued = agreement.status === 'discontinued';
  const canReinstate = isDiscontinued && agreement.discontinued_reason === 'bike_stolen';
  const bikeStillStolen = agreement.bike_status === 'stolen';

  const recordPayment = async () => {
    try {
      await api.post('/payments/manual', { agreement_id: Number(id), ...pay, amount: Number(pay.amount) });
      toast.success('Payment recorded');
      setShowPay(false);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed');
    }
  };

  const updateStatus = async (status) => {
    if (!window.confirm(`Change status to ${status}?`)) return;
    try {
      setBusyAction(status);
      await api.post(`/agreements/${id}/status`, { status });
      toast.success('Status updated');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update agreement status');
    } finally {
      setBusyAction('');
    }
  };

  const reinstate = async () => {
    if (!window.confirm('Reinstate this discontinued contract and resume future payments from today onward?')) return;
    try {
      setBusyAction('reinstate');
      await api.post(`/agreements/${id}/reinstate`);
      toast.success('Agreement reinstated');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not reinstate this agreement');
    } finally {
      setBusyAction('');
    }
  };

  return (
    <>
      <Link to="/admin/agreements" className="muted text-sm">← Back</Link>
      <div className="flex-between mt-2 mb-4">
        <div>
          <h1 className="page-title">{agreement.agreement_no}</h1>
          <div className="muted">{agreement.full_name} · {agreement.make} {agreement.model}</div>
        </div>
        <Badge status={agreement.status} />
      </div>

      {isDiscontinued && (
        <div className="card mb-4" style={{ border: '1px solid var(--danger)', background: 'rgba(239,68,68,0.08)' }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--danger)' }}>Agreement discontinued</div>
          <div className="muted text-sm" style={{ marginBottom: 12 }}>
            This contract was discontinued because the bike was marked stolen. No further payment is required while the agreement stays discontinued.
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="badge badge-muted">Bike status: {agreement.bike_status || '—'}</div>
            {agreement.discontinued_at && <div className="badge badge-muted">Stopped {fmtDateTime(agreement.discontinued_at)}</div>}
            {agreement.reinstated_at && <div className="badge badge-muted">Previously reinstated {fmtDateTime(agreement.reinstated_at)}</div>}
          </div>
          {canReinstate && (
            <div className="row mt-3" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" onClick={reinstate} disabled={busyAction === 'reinstate' || bikeStillStolen}>
                {busyAction === 'reinstate' ? 'Reinstating…' : 'Reinstate contract'}
              </button>
              {bikeStillStolen && <div className="muted text-sm">Recover the bike from stolen status first, then reinstate the contract.</div>}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-4 mb-4">
        <Stat label="Total contract" value={fmt(agreement.total_amount)} />
        <Stat label="Received" value={fmt(summary.total_paid)} accent="var(--success)" />
        <Stat label="Remaining" value={fmt(summary.remaining)} accent="var(--accent)" />
        <Stat label="Overdue" value={fmt(summary.overdue)} accent="var(--danger)" />
      </div>

      <div className="card mb-4">
        <div className="flex-between mb-3" style={{ gap: 16, flexWrap: 'wrap' }}>
          <h3>Progress to ownership · {summary.progress_pct}%</h3>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {!isDiscontinued && <button className="btn btn-sm" onClick={() => setShowPay(true)}>+ Record manual payment</button>}
            {agreement.contract_file_path && <a className="btn btn-sm btn-secondary" href={agreement.contract_file_path} target="_blank" rel="noreferrer">Contract</a>}
            {agreement.signed_contract_path && <a className="btn btn-sm btn-secondary" href={agreement.signed_contract_path} target="_blank" rel="noreferrer">Signed copy</a>}
            {agreement.status === 'active' && <button className="btn btn-sm btn-secondary" onClick={() => updateStatus('paused')} disabled={busyAction === 'paused'}>Pause</button>}
            {agreement.status === 'paused' && <button className="btn btn-sm btn-secondary" onClick={() => updateStatus('active')} disabled={busyAction === 'active'}>Resume</button>}
            {!['completed', 'discontinued'].includes(agreement.status) && <button className="btn btn-sm btn-success" onClick={() => updateStatus('completed')} disabled={busyAction === 'completed'}>Mark completed</button>}
            {agreement.status === 'active' && <button className="btn btn-sm btn-danger" onClick={() => updateStatus('defaulted')} disabled={busyAction === 'defaulted'}>Default</button>}
          </div>
        </div>
        <div className="progress-bar"><div className="progress-fill" style={{ width: `${summary.progress_pct}%` }} /></div></div>
        <div className="flex-between mt-3 text-sm muted">
          <div>Start {fmtDate(agreement.start_date)}</div>
          <div>{summary.weeks_paid} / {summary.weeks_total} weeks</div>
          <div>End {fmtDate(agreement.end_date)}</div>
        </div>
      </div>

      <div className="grid grid-2 mb-4">
        <div className="card">
          <h3 className="mb-3">Payment schedule</h3>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>#</th><th>Due</th><th>Paid</th><th>Status</th></tr></thead>
              <tbody>
                {schedule.map((row) => (
                  <tr key={row.id}>
                    <td>{row.week_number}</td>
                    <td>{fmtDate(row.due_date)}</td>
                    <td>{fmt(row.amount_paid)} / {fmt(row.amount_due)}</td>
                    <td><Badge status={row.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3 className="mb-3">Payment history</h3>
          <table className="table">
            <thead><tr><th>Date</th><th>Method</th><th>Ref</th><th>Status</th><th>Rental</th><th>Fee</th><th>Gross</th></tr></thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td>{fmtDateTime(payment.paid_at || payment.created_at)}</td>
                  <td>{payment.method}</td>
                  <td className="text-xs muted">{payment.reference}</td>
                  <td><Badge status={payment.status} /></td>
                  <td><strong>{fmt(creditedAmount(payment))}</strong></td>
                  <td>{feeAmount(payment) > 0 ? fmt(feeAmount(payment)) : '—'}</td>
                  <td>{fmt(grossAmount(payment))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3 className="mb-3">Application documents linked to this agreement</h3>
        <table className="table">
          <thead><tr><th>Type</th><th>File</th><th>Uploaded</th><th></th></tr></thead>
          <tbody>
            {applicationDocuments.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.doc_type.replace(/_/g, ' ')}</td>
                <td>{doc.original_name}</td>
                <td>{fmtDate(doc.uploaded_at)}</td>
                <td><a className="btn btn-sm btn-secondary" href={doc.file_path} target="_blank" rel="noreferrer">Open</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!applicationDocuments.length && <div className="muted text-sm">No linked application documents.</div>}
      </div>

      {showPay && (
        <Modal title="Record manual payment" onClose={() => setShowPay(false)}>
          <div className="grid grid-2">
            <div className="field"><label className="label">Amount</label><input type="number" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></div>
            <div className="field"><label className="label">Method</label>
              <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                <option value="eft">EFT</option><option value="cash">Cash</option><option value="card">Card</option><option value="other">Other</option>
              </select></div>
          </div>
          <div className="field"><label className="label">Reference</label><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></div>
          <div className="field"><label className="label">Notes</label><textarea rows={3} value={pay.notes} onChange={(e) => setPay({ ...pay, notes: e.target.value })} /></div>
          <div className="row"><button className="btn" onClick={recordPayment}>Record</button><button className="btn btn-secondary" onClick={() => setShowPay(false)}>Cancel</button></div>
        </Modal>
      )}
    </>
  );
}
