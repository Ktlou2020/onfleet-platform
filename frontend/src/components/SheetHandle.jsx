import { ChevronDown, ChevronUp } from 'lucide-react';
import { SHEET_NEXT } from '../utils/mobileMap';

// Grab bar at the top of a phone bottom sheet: each tap moves it peek → half → full → peek.
export default function SheetHandle({ size, onChange }) {
  return (
    <button
      onClick={() => onChange(SHEET_NEXT[size])}
      aria-label={size === 'full' ? 'Shrink details' : 'Expand details'}
      style={{ position: 'sticky', top: 0, zIndex: 3, background: 'var(--surface)', border: 'none', borderRadius: '16px 16px 0 0', padding: '6px 0 2px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, color: 'var(--muted)', cursor: 'pointer', flexShrink: 0, width: '100%' }}>
      <span style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--border)' }} />
      {size === 'full' ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
    </button>
  );
}

export const sheetStyle = (height) => ({
  position: 'absolute', left: 0, right: 0, bottom: 0, height, zIndex: 1150,
  display: 'flex', flexDirection: 'column', background: 'var(--surface-2)',
  borderTop: '1px solid var(--border)', borderRadius: '16px 16px 0 0',
  boxShadow: '0 -6px 24px rgba(0,0,0,.45)', transition: 'height .2s ease',
});
