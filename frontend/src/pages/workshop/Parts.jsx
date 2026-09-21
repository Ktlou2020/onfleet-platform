import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Search } from 'lucide-react';
import api from '../../api';
import { fmt } from '../../components/ui';

// The dealer parts list, searchable from the workshop floor: type the name of
// the part or the number stamped on it — with or without dashes, old number or
// new — and get the number to order, the price and whether it is a kit.

const money = (value) => (value == null ? '—' : fmt(Number(value)));

export default function WorkshopParts() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const typed = useRef(null);

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return undefined; }
    clearTimeout(typed.current);
    typed.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await api.get('/workshop/parts-catalog/search', { params: { q: query.trim(), limit: 60 } });
        setResults(data.results);
      } catch (e) {
        toast.error(e.response?.data?.error || 'Could not search the parts list');
      } finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(typed.current);
  }, [query]);

  return (
    <div>
      <h1 className="page-title">Parts</h1>
      <p className="page-sub">Search the dealer parts list by name or part number.</p>

      <div style={{ position: 'relative', marginBottom: 14 }}>
        <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="brake pads, gasket, 12391AAK900S…"
          style={{ width: '100%', paddingLeft: 34, fontSize: 16 }}
        />
      </div>

      {query.trim().length >= 2 && !searching && !results.length && (
        <p className="text-sm muted">Nothing matches “{query.trim()}”. Try the part name, or the number stamped on the old part.</p>
      )}

      {results.map((part) => (
        <div key={part.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
          <div className="flex-between" style={{ gap: 10, alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{part.description}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 13 }}>{part.part_number}</div>
              <div className="text-xs muted">
                {part.group_name}
                {part.is_kit ? ' · kit' : ''}
                {part.supersedes ? ` · replaces ${part.supersedes}` : ''}
                {part.status && part.status !== 'REGULAR' ? ` · ${part.status}` : ''}
              </div>
            </div>
            <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <div style={{ fontWeight: 700 }}>{money(part.price_ex_vat)}</div>
              <div className="text-xs muted">excl. VAT</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
