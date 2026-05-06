import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import api from '../../api';

export default function PaymentCallback() {
  const [params] = useSearchParams();
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    const ref = params.get('reference') || params.get('trxref');
    if (!ref) return setState({ loading: false, error: 'Missing reference' });
    api.get(`/payments/paystack/verify/${ref}`).then(r => setState({ loading: false, ...r.data }))
      .catch(e => setState({ loading: false, error: e.response?.data?.error || 'Verification failed' }));
  }, [params]);

  return (
    <div className="card" style={{ maxWidth: 500, margin: '40px auto', textAlign: 'center' }}>
      {state.loading ? <><div className="spinner" style={{ margin: '20px auto' }} /><p>Verifying payment…</p></> :
        state.status === 'success' ? <>
          <div style={{ fontSize: 56 }}>✅</div><h2>Payment successful</h2>
          <p className="muted mt-2">R{state.amount} has been recorded against your agreement.</p>
          <Link to="/dashboard" className="btn mt-4">Back to dashboard</Link>
        </> : <>
          <div style={{ fontSize: 56 }}>⚠️</div><h2>Payment {state.status || 'failed'}</h2>
          <p className="muted mt-2">{state.error || 'Please try again.'}</p>
          <Link to="/payments" className="btn btn-secondary mt-4">Try again</Link>
        </>}
    </div>
  );
}
