import { useState } from 'react';
import { Search, X, ChevronLeft, ChevronRight, Copy, Check, Phone, AlertTriangle } from 'lucide-react';

export const fmt = (n) => `R${Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
export const fmtDateTime = (d) => d ? new Date(d).toLocaleString('en-ZA') : '—';
export const matchesSearch = (query, ...values) => {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return values.flat(Infinity).some((value) => String(value || '').toLowerCase().includes(needle));
};

export function normalizePhoneInput(value) {
  const raw = String(value || '');
  if (!raw) return '';
  let normalized = raw.replace(/[^\d+]/g, '');
  normalized = normalized.startsWith('+')
    ? `+${normalized.slice(1).replace(/\+/g, '')}`
    : normalized.replace(/\+/g, '');
  if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
  return normalized;
}

export function formatPhoneDisplay(value) {
  const normalized = normalizePhoneInput(value);
  if (!normalized) return '—';
  const digits = normalized.replace(/\D/g, '');

  if (normalized.startsWith('+27') && digits.length >= 11) {
    const local = digits.slice(2, 11);
    return `+27 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5, 9)}`.trim();
  }

  if (digits.length === 10 && digits.startsWith('0')) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`;
  }

  if (normalized.startsWith('+') && digits.length > 6) {
    const country = digits.slice(0, Math.max(2, digits.length - 9));
    const rest = digits.slice(country.length);
    if (rest.length >= 6) {
      const chunks = [rest.slice(0, 2), rest.slice(2, 5), rest.slice(5)].filter(Boolean);
      return `+${country} ${chunks.join(' ')}`.trim();
    }
  }

  return normalized;
}

async function copyText(value) {
  if (!value) return false;
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  return false;
}

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
    pending: 'badge-warn', submitted: 'badge-warn', under_review: 'badge-warn', partial: 'badge-warn', repairs: 'badge-warn', not_available: 'badge-warn', stationary: 'badge-warn', paused: 'badge-warn',
    overdue: 'badge-danger', rejected: 'badge-danger', defaulted: 'badge-danger', failed: 'badge-danger', suspended: 'badge-danger', written_off: 'badge-danger', discontinued: 'badge-danger', stolen: 'badge-danger',
    active: 'badge-info', sold: 'badge-info', paid_off: 'badge-info', signed: 'badge-info', read: 'badge-info', cancelled: 'badge-muted'
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

export function CopyableContactValue({ value, type = 'phone', compact = false }) {
  const [copied, setCopied] = useState(false);
  const normalized = type === 'phone' ? normalizePhoneInput(value) : String(value || '').trim();
  if (!normalized) return <span className="muted">—</span>;

  const displayValue = type === 'phone' ? formatPhoneDisplay(normalized) : normalized;
  const href = type === 'phone' ? `tel:${normalized}` : null;

  const handleCopy = async () => {
    const ok = await copyText(normalized);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span className={`copyable-value ${compact ? 'compact' : ''}`}>
      {href ? (
        <a href={href} className="copyable-link">
          {compact && <Phone size={12} />}
          <span>{displayValue}</span>
        </a>
      ) : (
        <span className="copyable-link"><span>{displayValue}</span></span>
      )}
      <button type="button" className="btn btn-sm btn-secondary copyable-btn" onClick={handleCopy} title={`Copy ${type}`}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </span>
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

export function Skeleton({ lines = 3, height, className = '' }) {
  if (height) return <div className={`skeleton ${className}`} style={{ height }} />;
  return (
    <div style={{ padding: 4 }}>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={`skeleton skeleton-line ${i === lines - 1 ? 'short' : i % 2 === 0 ? '' : 'medium'}`} />
      ))}
    </div>
  );
}

export function ConfirmModal({ title, body, confirmLabel = 'Confirm', danger = false, onConfirm, onClose, busy = false }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="confirm-modal-icon" style={{ background: danger ? 'rgba(239,68,68,0.12)' : 'rgba(30,136,209,0.12)', color: danger ? 'var(--danger)' : 'var(--primary-light)' }}>
          <AlertTriangle size={22} />
        </div>
        <h2 style={{ marginBottom: 10, fontSize: 20 }}>{title}</h2>
        <div className="confirm-modal-body">{body}</div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={`btn ${danger ? 'btn-danger' : ''}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
