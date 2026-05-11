import { Search, X, ChevronLeft, ChevronRight } from 'lucide-react';

export const fmt = (n) => `R${Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
export const fmtDateTime = (d) => d ? new Date(d).toLocaleString('en-ZA') : '—';
export const matchesSearch = (query, ...values) => {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return values.flat(Infinity).some((value) => String(value || '').toLowerCase().includes(needle));
};

export function paginateItems(items, page = 1, pageSize = 10) {
  const safeItems = Array.isArray(items) ? items : [];
  const safePageSize = Math.max(1, Number(pageSize) || 10);
  const totalPages = Math.max(1, Math.ceil(safeItems.length / safePageSize));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const startIndex = (currentPage - 1) * safePageSize;
  return {
    items: safeItems.slice(startIndex, startIndex + safePageSize),
    currentPage,
    pageSize: safePageSize,
    totalPages,
    totalItems: safeItems.length,
    startIndex,
    endIndex: Math.min(startIndex + safePageSize, safeItems.length)
  };
}

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
    paid: 'badge-success', success: 'badge-success', approved: 'badge-success', completed: 'badge-success', ready_to_go: 'badge-success', sent: 'badge-success',
    pending: 'badge-warn', submitted: 'badge-warn', under_review: 'badge-warn', partial: 'badge-warn', repairs: 'badge-warn', not_available: 'badge-warn', stationary: 'badge-warn',
    overdue: 'badge-danger', rejected: 'badge-danger', defaulted: 'badge-danger', failed: 'badge-danger', suspended: 'badge-danger', written_off: 'badge-danger',
    active: 'badge-info', sold: 'badge-info', paid_off: 'badge-info', signed: 'badge-info', read: 'badge-info'
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

export function SearchInput({ value, onChange, placeholder = 'Search', style = {}, inputProps = {} }) {
  return (
    <div style={{ position: 'relative', minWidth: 260, ...style }}>
      <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ paddingLeft: 38, paddingRight: value ? 38 : 12 }}
        {...inputProps}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', color: 'var(--muted)', padding: 4, display: 'flex', alignItems: 'center' }}
          title="Clear search"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export function Pagination({ page, pageSize, totalItems, onPageChange, onPageSizeChange, label = 'items' }) {
  if (!totalItems) return null;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  return (
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
      <div className="muted text-sm">Showing {start}-{end} of {totalItems} {label}</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {onPageSizeChange && (
          <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))} style={{ minWidth: 90 }}>
            {Array.from(new Set([pageSize, 10, 20, 50, 100])).sort((a, b) => a - b).map((size) => <option key={size} value={size}>{size} / page</option>)}
          </select>
        )}
        <button className="btn btn-sm btn-secondary" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage <= 1}>
          <ChevronLeft size={14} /> Prev
        </button>
        <div className="badge badge-muted">Page {currentPage} / {totalPages}</div>
        <button className="btn btn-sm btn-secondary" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= totalPages}>
          Next <ChevronRight size={14} />
        </button>
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
