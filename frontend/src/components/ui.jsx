import { Link } from 'react-router-dom';

export const fmt = (n) => `R${Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
export const fmtDateTime = (d) => d ? new Date(d).toLocaleString('en-ZA') : '—';

export function Stat({ label, value, delta, icon, accent }) {
  return (
    <div className="stat">
      <div className="flex-between">
        <div className="stat-label">{label}</div>
        {icon && <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface-2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: accent || 'var(--primary)' }}>{icon}</div>}
      </div>
      <div className="stat-value">{value}</div>
      {delta && <div className="stat-delta muted">{delta}</div>}
    </div>
  );
}

export function Badge({ status, children }) {
  const map = {
    active: 'badge-success', paid: 'badge-success', success: 'badge-success', approved: 'badge-success', completed: 'badge-success', available: 'badge-success', sent: 'badge-success',
    pending: 'badge-warn', submitted: 'badge-warn', under_review: 'badge-warn', partial: 'badge-warn', maintenance: 'badge-warn',
    overdue: 'badge-danger', rejected: 'badge-danger', defaulted: 'badge-danger', failed: 'badge-danger', suspended: 'badge-danger',
    allocated: 'badge-info', sold: 'badge-info', signed: 'badge-info', read: 'badge-info'
  };
  return <span className={`badge ${map[status] || 'badge-muted'}`}>{children || status}</span>;
}

export function Loading() {
  return <div className="center-flex"><div className="spinner" /></div>;
}

export function Modal({ children, onClose, title }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ title, sub, action }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px' }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>📭</div>
      <h3 style={{ marginBottom: 6 }}>{title}</h3>
      <div className="muted mb-4">{sub}</div>
      {action}
    </div>
  );
}
