import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, ConfirmModal, EmptyState, Loading, Modal, SearchInput, Stat, fmt, fmtDate } from '../../components/ui';
import { Package, ShoppingCart, Plus, Trash2, AlertTriangle, Boxes } from 'lucide-react';

// The parts counter.
//
// Two jobs on one screen, because they are two halves of the same thing: what
// is on the shelf, and what left it. A dealer standing at the counter with a
// customer in front of them needs the stock number and the sell button in the
// same place, not two tabs apart.
//
// Prices are ex VAT throughout and VAT is added at the total, because that is
// how a parts list is quoted and how the invoice has to read.

const VAT_RATE = 0.15;
const EMPTY_LINE = { part_number: '', description: '', quantity: 1, unit_price_ex_vat: '' };

function SellModal({ fleets, onClose, onSold }) {
  const [channel, setChannel] = useState('counter');
  const [organizationId, setOrganizationId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [busy, setBusy] = useState(false);
  const [shortfall, setShortfall] = useState(null);

  // Priced here as well as on the server, so the person at the counter can
  // read the total before they commit. The server prices it again and its
  // answer is the one that is stored.
  const subtotal = lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unit_price_ex_vat) || 0), 0);
  const vat = subtotal * VAT_RATE;

  const setLine = (i, patch) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  // Filling in a part number fetches what it costs, what it sells for and how
  // many are left, so the price is right without anybody remembering it.
  const lookup = async (i, partNumber) => {
    if (!partNumber.trim()) return;
    try {
      const { data } = await api.get('/workshop/stock', { params: { search: partNumber.trim() } });
      const hit = (data.stock || []).find(
        (s) => s.part_number.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
            === partNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase());
      if (!hit) return;
      setLine(i, {
        description: hit.description || '',
        unit_price_ex_vat: hit.sell_price_ex_vat ?? '',
        on_hand: Number(hit.on_hand),
      });
    } catch { /* the server prices it anyway */ }
  };

  const submit = async (allowNegative = false) => {
    const items = lines
      .filter((l) => l.part_number.trim())
      .map((l) => ({
        part_number: l.part_number.trim(),
        description: l.description || undefined,
        quantity: Number(l.quantity),
        unit_price_ex_vat: l.unit_price_ex_vat === '' ? undefined : Number(l.unit_price_ex_vat),
      }));
    if (!items.length) return toast.error('Put something on the sale');
    if (channel === 'account' && !organizationId) return toast.error('Which fleet is this going on?');

    setBusy(true);
    try {
      const { data } = await api.post('/workshop/sales', {
        channel,
        organization_id: channel === 'account' ? Number(organizationId) : undefined,
        customer_name: customerName || undefined,
        customer_phone: customerPhone || undefined,
        payment_method: channel === 'counter' ? paymentMethod : undefined,
        allow_negative: allowNegative || undefined,
        items,
      });
      toast.success(`${data.sale.reference} · ${fmt(data.sale.total)} · margin ${fmt(data.margin)}`);
      setShortfall(null);
      onSold();
      onClose();
    } catch (err) {
      const body = err.response?.data;
      // The shelf says there are fewer than the sale wants. The part may well
      // be in the customer's hand and the count be what is wrong, so this is
      // a question rather than a refusal.
      if (body?.code === 'NOT_ENOUGH_STOCK') setShortfall(body);
      else toast.error(body?.error || 'Could not record that sale');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal title="Sell parts" onClose={onClose} style={{ maxWidth: 720 }}>
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          {[['counter', 'Over the counter'], ['account', "On a fleet's account"]].map(([v, label]) => (
            <button key={v} className={channel === v ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
                    onClick={() => setChannel(v)}>{label}</button>
          ))}
        </div>

        {channel === 'account' ? (
          <div className="field">
            <label className="label">Fleet</label>
            <select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} style={{ width: '100%' }}>
              <option value="">— Whose account —</option>
              {fleets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
        ) : (
          <div className="grid grid-3">
            <div className="field">
              <label className="label">Customer <span className="muted">(optional)</span></label>
              <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Walk-in" />
            </div>
            <div className="field">
              <label className="label">Phone <span className="muted">(optional)</span></label>
              <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Paid by</label>
              <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="eft">EFT</option>
              </select>
            </div>
          </div>
        )}

        <h3 style={{ marginTop: 14, marginBottom: 6 }}>Parts</h3>
        {lines.map((line, i) => (
          <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end', marginBottom: 8, flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: '1 1 160px', margin: 0 }}>
              <label className="label">Part number</label>
              <input value={line.part_number}
                     onChange={(e) => setLine(i, { part_number: e.target.value })}
                     onBlur={(e) => lookup(i, e.target.value)}
                     placeholder="12391AAK900S" />
            </div>
            <div className="field" style={{ flex: '2 1 200px', margin: 0 }}>
              <label className="label">Description</label>
              <input value={line.description} onChange={(e) => setLine(i, { description: e.target.value })} />
            </div>
            <div className="field" style={{ width: 80, margin: 0 }}>
              <label className="label">Qty</label>
              <input type="number" min="1" value={line.quantity}
                     onChange={(e) => setLine(i, { quantity: e.target.value })} />
            </div>
            <div className="field" style={{ width: 110, margin: 0 }}>
              <label className="label">Each ex VAT</label>
              <input type="number" min="0" step="0.01" value={line.unit_price_ex_vat}
                     onChange={(e) => setLine(i, { unit_price_ex_vat: e.target.value })} />
            </div>
            <button className="btn btn-secondary btn-sm" aria-label="Remove line"
                    onClick={() => setLines((ls) => (ls.length === 1 ? [{ ...EMPTY_LINE }] : ls.filter((_, n) => n !== i)))}>
              <Trash2 size={14} />
            </button>
            {line.on_hand != null && (
              <div className="text-xs" style={{ width: '100%', color: line.on_hand < Number(line.quantity) ? 'var(--warn)' : 'var(--muted)' }}>
                {line.on_hand} on the shelf
              </div>
            )}
          </div>
        ))}
        <button className="btn btn-secondary btn-sm" onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}>
          <Plus size={14} /> Another part
        </button>

        <div className="card" style={{ background: 'var(--surface-2)', marginTop: 14 }}>
          <div className="flex-between"><span className="muted">Subtotal ex VAT</span><span>{fmt(subtotal)}</span></div>
          <div className="flex-between"><span className="muted">VAT at 15%</span><span>{fmt(vat)}</span></div>
          <div className="flex-between" style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>
            <span>Total</span><span>{fmt(subtotal + vat)}</span>
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={() => submit(false)} disabled={busy}>
            {busy ? 'Recording…' : 'Record the sale'}
          </button>
        </div>
      </Modal>

      {shortfall && (
        <ConfirmModal
          danger
          title="Fewer on the shelf than that"
          body={(
            <div>
              <p>{shortfall.error}</p>
              <p className="text-sm muted">
                If the part is in the customer's hand then the count is what is wrong, not the
                sale. Selling anyway records it and leaves the shelf showing a negative until
                somebody counts it.
              </p>
            </div>
          )}
          confirmLabel="Sell anyway"
          onConfirm={() => { setShortfall(null); submit(true); }}
          onClose={() => setShortfall(null)}
        />
      )}
    </>
  );
}

export default function PartsCounter() {
  const [stock, setStock] = useState([]);
  const [summary, setSummary] = useState(null);
  const [sales, setSales] = useState([]);
  const [salesSummary, setSalesSummary] = useState(null);
  const [fleets, setFleets] = useState([]);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selling, setSelling] = useState(false);
  const [adjusting, setAdjusting] = useState(null);
  const [voiding, setVoiding] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, sl] = await Promise.all([
        api.get('/workshop/stock', { params: { search: search || undefined, low: lowOnly ? 1 : undefined } }),
        api.get('/workshop/sales'),
      ]);
      setStock(s.data.stock || []);
      setSummary(s.data.summary || null);
      setSales(sl.data.sales || []);
      setSalesSummary(sl.data.summary || null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load the parts counter');
    } finally {
      setLoading(false);
    }
  }, [search, lowOnly]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/admin/fleet-owners')
      .then((r) => setFleets(r.data.organizations || []))
      .catch(() => setFleets([]));
  }, []);

  const margin = useMemo(() => {
    if (!salesSummary || !salesSummary.sold_ex_vat) return 0;
    return Math.round((salesSummary.margin / salesSummary.sold_ex_vat) * 100);
  }, [salesSummary]);

  if (loading) return <Loading />;

  return (
    <>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 className="page-title">Parts counter</h1>
          <p className="page-sub">What is on the shelf, and what left it. Prices are ex VAT.</p>
        </div>
        <button className="btn" onClick={() => setSelling(true)}><ShoppingCart size={15} /> Sell parts</button>
      </div>

      <div className="grid grid-4" style={{ marginTop: 16 }}>
        <Stat label="On the shelves, at cost" value={fmt(summary?.value_at_cost || 0)} icon={<Boxes size={18} />} />
        <Stat label="Lines below reorder" value={summary?.low || 0}
              accent={summary?.low ? 'var(--warn)' : undefined} icon={<AlertTriangle size={18} />} />
        <Stat label="Sold in 30 days" value={fmt(salesSummary?.sold_ex_vat || 0)} icon={<ShoppingCart size={18} />}
              delta={salesSummary ? `${salesSummary.counter} counter · ${salesSummary.account} account` : null} />
        <Stat label="Margin" value={fmt(salesSummary?.margin || 0)}
              accent={salesSummary?.margin > 0 ? 'var(--success)' : undefined} icon={<Package size={18} />}
              delta={salesSummary?.sold_ex_vat ? `${margin}% of what was sold` : null} />
      </div>

      <div className="flex-between" style={{ marginTop: 22, flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Stock</h2>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Part number or description" style={{ minWidth: 240 }} />
          <button className={lowOnly ? 'filter-pill active' : 'filter-pill'} onClick={() => setLowOnly((v) => !v)}>
            Below reorder
          </button>
        </div>
      </div>

      {stock.length === 0 ? (
        <EmptyState title="Nothing on the shelves yet"
                    sub="Receive a parts order, or count a shelf in, and it will show here." />
      ) : (
        <div className="card" style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr>
              <th>Part</th><th>Description</th><th>On hand</th><th>Reorder at</th>
              <th>Cost</th><th>Sells for</th><th>Margin</th><th></th>
            </tr></thead>
            <tbody>
              {stock.map((s) => {
                const cost = s.cost_price_ex_vat != null ? Number(s.cost_price_ex_vat) : null;
                const sell = s.sell_price_ex_vat != null ? Number(s.sell_price_ex_vat) : null;
                return (
                  <tr key={s.id} style={s.low ? { background: 'rgba(255,182,39,0.06)' } : undefined}>
                    <td style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>
                      {s.part_number}
                      {s.bin && <div className="text-xs muted">bin {s.bin}</div>}
                    </td>
                    <td>{s.description || '—'}</td>
                    <td><strong style={s.low ? { color: 'var(--warn)' } : undefined}>{Number(s.on_hand)}</strong></td>
                    <td className="text-sm muted">{Number(s.reorder_level) || '—'}</td>
                    <td>
                      {cost != null ? fmt(cost) : '—'}
                      {s.cost_is_catalogue && <div className="text-xs muted">list price</div>}
                    </td>
                    <td>{sell != null ? fmt(sell) : <span className="muted">not set</span>}</td>
                    <td>{cost != null && sell != null ? fmt(sell - cost) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-secondary btn-sm"
                              onClick={() => setAdjusting({ part_number: s.part_number, description: s.description, on_hand: Number(s.on_hand) })}>
                        Count
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 26 }}>Recent sales</h2>
      {sales.length === 0 ? (
        <EmptyState title="Nothing sold yet" sub="Counter and account sales appear here." />
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr>
              <th>Reference</th><th>Who</th><th>Lines</th><th>Total</th><th>Margin</th><th>When</th><th></th>
            </tr></thead>
            <tbody>
              {sales.map((s) => (
                <tr key={s.id} style={s.status === 'void' ? { opacity: 0.5 } : undefined}>
                  <td>
                    <strong>{s.reference}</strong>
                    <div className="text-xs muted">{s.channel === 'account' ? 'account' : s.payment_method}</div>
                  </td>
                  <td>{s.organization_name || s.customer_name || <span className="muted">walk-in</span>}</td>
                  <td>{s.lines}</td>
                  <td>{fmt(s.total)}</td>
                  <td>{fmt(Number(s.subtotal_ex_vat) - Number(s.cost_total_ex_vat))}</td>
                  <td>{fmtDate(s.sold_at)}<div className="text-xs muted">{s.sold_by_name}</div></td>
                  <td style={{ textAlign: 'right' }}>
                    {s.status === 'void'
                      ? <Badge status="cancelled">void</Badge>
                      : <button className="btn btn-secondary btn-sm" onClick={() => setVoiding(s)}>Void</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selling && <SellModal fleets={fleets} onClose={() => setSelling(false)} onSold={load} />}

      {adjusting && (
        <CountModal item={adjusting} onClose={() => setAdjusting(null)} onDone={() => { setAdjusting(null); load(); }} />
      )}

      {voiding && (
        <VoidModal sale={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); load(); }} />
      )}
    </>
  );
}

// A stock take. The number on the shelf wins, and the difference is what gets
// written down, so the ledger still adds up to the count.
function CountModal({ item, onClose, onDone }) {
  const [counted, setCounted] = useState(String(item.on_hand));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!note.trim()) return toast.error('Say why the count is changing');
    setBusy(true);
    try {
      const { data } = await api.post('/workshop/stock/adjust', {
        part_number: item.part_number, counted: Number(counted), note,
      });
      toast.success(data.unchanged ? 'Count agreed, nothing changed' : `${item.part_number} now ${data.on_hand}`);
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not record that count');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Count ${item.part_number}`} onClose={onClose}>
      <p className="muted text-sm" style={{ marginTop: 0 }}>
        {item.description || 'This part'} — the system thinks there are {item.on_hand}.
      </p>
      <div className="field">
        <label className="label">Counted on the shelf</label>
        <input type="number" min="0" value={counted} onChange={(e) => setCounted(e.target.value)} />
      </div>
      <div className="field">
        <label className="label">Why</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Monthly stock take" />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Record the count'}</button>
      </div>
    </Modal>
  );
}

function VoidModal({ sale, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmModal
      danger
      title={`Void ${sale.reference}?`}
      body={(
        <div>
          <p>The parts go back on the shelf. The sale stays on the record as void — a till that can forget a sale cannot be audited.</p>
          <input value={reason} onChange={(e) => setReason(e.target.value)}
                 placeholder="Why it is being voided" style={{ width: '100%', marginTop: 8 }} />
        </div>
      )}
      confirmLabel="Void the sale"
      busy={busy}
      onConfirm={async () => {
        if (!reason.trim()) return toast.error('Say why it is being voided');
        setBusy(true);
        try {
          await api.post(`/workshop/sales/${sale.id}/void`, { reason });
          toast.success('Voided, parts back on the shelf');
          onDone();
        } catch (err) {
          toast.error(err.response?.data?.error || 'Could not void that sale');
        } finally {
          setBusy(false);
        }
      }}
      onClose={onClose}
    />
  );
}
