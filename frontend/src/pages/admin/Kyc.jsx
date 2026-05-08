import { Link } from 'react-router-dom';

export default function AdminKyc() {
  return (
    <>
      <h1 className="page-title">Document Review</h1>
      <p className="page-sub">KYC and application documents are now reviewed inside each application record.</p>
      <div className="card">
        <strong>New workflow</strong>
        <div className="muted text-sm mt-2">Open Applications to review ID documents, driver's licences, 3 latest payslips, extracted earnings, and signed contracts in one place.</div>
        <div className="mt-3"><Link to="/admin/applications" className="btn">Go to applications</Link></div>
      </div>
    </>
  );
}
