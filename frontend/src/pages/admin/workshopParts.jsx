import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, Upload, Package, FileSpreadsheet, Send, Download, RefreshCw, Check } from 'lucide-react';
import api from '../../api';
import { Loading, Modal, fmt, fmtDate, fmtDateTime } from '../../components/ui';

// The parts catalogue and the ordering desk, as two tabs of the admin
// workshop. Both work from the dealer price list: search it to find a part,
// and order from it on Hero's own RFQ form.

const money = (value) => (value == null ? '—' : fmt(Number(value)));

// ── Parts catalogue ──────────────────────────────────────────────────────────

export function PartsTab() {
  const [query, setQuery] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState([]);
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const typed = useRef(null);

  const loadModels = useCallback(async () => {
    try { setModels((await api.get('/admin/parts-catalog/models')).data); } catch { /* shown by the search */ }
  }, []);
  useEffect(() => { loadModels(); }, [loadModels]);

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setTotal(0); return undefined; }
    clearTimeout(typed.current);
    typed.current = setTimeout(async () => {
      setSearching(true);
      try {
        const [make, ...rest] = model ? model.split('|') : [];
        const { data } = await api.get('/admin/parts-catalog', {
          params: { q: query.trim(), make: make || undefined, model: rest.join('|') || undefined, limit: 100 },
        });
        setResults(data.results);
        setTotal(data.total);
      } catch (e) {
        toast.error(e.response?.data?.error || 'Could not search the parts list');
      } finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(typed.current);
  }, [query, model]);

  return (
    <div>
      <div className="row mb-3" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 320px' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by part name or part number — brake, 12391AAK900S, 12391-KRM-840"
            style={{ width: '100%', paddingLeft: 32 }}
          />
        </div>
        <select value={model} onChange={(e) => setModel(e.target.value)} style={{ flex: '0 1 220px' }}>
          <option value="">Every bike</option>
          {models.map((m) => <option key={`${m.make}|${m.model}`} value={`${m.make}|${m.model}`}>{m.make} {m.model} ({m.parts})</option>)}
        </select>
        <button className="btn btn-sm btn-secondary" onClick={() => setShowImport(true)}><Upload size={14} /> Upload a parts list</button>
      </div>

      {models.length === 0 && (
        <div className="card mb-3">
          <strong>No parts list loaded yet.</strong>
          <p className="text-sm muted" style={{ marginBottom: 0 }}>
            Upload the dealer parts list spreadsheet your supplier sends (for example “Dealer Parts List ECO 150.xlsx”).
            Part numbers, descriptions, prices and superseded numbers are read from it.
          </p>
        </div>
      )}

      {query.trim().length >= 2 && (
        <div className="text-sm muted mb-2">
          {searching ? 'Searching…' : `${total} part${total === 1 ? '' : 's'} match “${query.trim()}”${total > results.length ? `, showing ${results.length}` : ''}`}
        </div>
      )}

      {results.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Part number</th><th>Description</th><th>Group</th>
                <th style={{ textAlign: 'right' }}>Price excl. VAT</th><th>Status</th><th>Replaces</th>
              </tr>
            </thead>
            <tbody>
              {results.map((part) => (
                <tr key={part.id}>
                  <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                    {part.part_number}
                    {part.is_kit && <span className="badge badge-info" style={{ marginLeft: 6, fontSize: 9 }}>KIT</span>}
                  </td>
                  <td>{part.description}</td>
                  <td className="text-sm muted">{part.group_name}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{money(part.price_ex_vat)}</td>
                  <td className="text-sm">{part.status || '—'}</td>
                  <td className="text-sm muted" style={{ fontFamily: 'monospace' }}>{part.supersedes || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showImport && <ImportPartsModal onClose={() => setShowImport(false)} onDone={() => { setShowImport(false); loadModels(); }} />}
    </div>
  );
}

function ImportPartsModal({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [make, setMake] = useState('Hero');
  const [model, setModel] = useState('Eco 150');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const send = async (isPreview) => {
    if (!file) return toast.error('Choose the spreadsheet first');
    const body = new FormData();
    body.append('file', file);
    body.append('make', make.trim());
    body.append('model', model.trim());
    if (isPreview) body.append('preview', '1');
    setBusy(true);
    try {
      const { data } = await api.post('/admin/parts-catalog/import', body, { headers: { 'Content-Type': 'multipart/form-data' } });
      if (isPreview) { setPreview(data); return; }
      toast.success(`${data.added} part${data.added === 1 ? '' : 's'} added, ${data.updated} updated`);
      onDone();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not read that spreadsheet');
    } finally { setBusy(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title="Upload a parts list">
      <div style={{ minWidth: 380 }}>
        <p className="text-sm muted">
          The dealer price list as your supplier sends it. Every sheet with a part number and a description is read;
          a sheet named “Kits” is marked as kits. Re-uploading an updated list refreshes prices rather than duplicating parts.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="label">Make</label>
            <input value={make} onChange={(e) => setMake(e.target.value)} placeholder="Hero" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label className="label">Model</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Eco 150" />
          </div>
        </div>
        <div className="muted text-xs mb-2">Use the same wording as the bikes: the catalogue is searched from job cards by make and model.</div>
        <input type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files[0]); setPreview(null); }} />

        {preview && (
          <div className="card mt-3" style={{ padding: 12 }}>
            <strong>{preview.total} parts found</strong>
            <ul className="text-sm muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {preview.sheets.map((s) => (
                <li key={s.sheet}>{s.sheet}: {s.used ? `${s.parts} parts${s.kits ? ' (kits)' : ''}` : `not used — ${s.reason}`}</li>
              ))}
            </ul>
            {preview.sample?.[0] && (
              <div className="text-xs muted mt-2">
                First: {preview.sample[0].part_number} · {preview.sample[0].description}
                {preview.sample[0].price_ex_vat != null && ` · ${money(preview.sample[0].price_ex_vat)}`}
              </div>
            )}
          </div>
        )}

        <div className="row mt-3" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-sm btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-sm btn-secondary" onClick={() => send(true)} disabled={busy || !file}>Check it first</button>
          <button className="btn btn-sm btn-primary" onClick={() => send(false)} disabled={busy || !file}>
            {busy ? 'Reading…' : 'Upload'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Ordering ─────────────────────────────────────────────────────────────────

const ORDER_STATUS = {
  draft: { label: 'Draft', colour: '#6b7280' },
  sent: { label: 'Sent to Hero', colour: '#1d4ed8' },
  quoted: { label: 'Quoted', colour: '#b45309' },
  ordered: { label: 'Ordered', colour: '#7c3aed' },
  received: { label: 'Received', colour: '#15803d' },
  cancelled: { label: 'Cancelled', colour: '#b91c1c' },
};

export function PartsOrdersTab() {
  const [orders, setOrders] = useState([]);
  const [suggestion, setSuggestion] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [openOrder, setOpenOrder] = useState(null);
  const [skip, setSkip] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, suggested] = await Promise.all([
        api.get('/admin/parts-orders'),
        api.get('/admin/parts-orders/suggestion'),
      ]);
      setOrders(list.data);
      setSuggestion(suggested.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load parts orders');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const chosen = useMemo(
    () => (suggestion?.lines || []).filter((l) => !skip.has(l.part_number)),
    [suggestion, skip],
  );
  const chosenTotal = chosen.reduce((sum, l) => sum + (l.unit_price_ex_vat || 0) * l.qty_to_order, 0);

  // A part number Hero's price list doesn't carry would come back rejected, so
  // the server refuses it. Here it becomes a choice: use the number they do
  // sell, leave the line out, or say why to send it anyway.
  const [blocked, setBlocked] = useState(null);
  const [overrides, setOverrides] = useState({});   // part number → reason
  const [swaps, setSwaps] = useState({});           // part number → number to use instead

  const createOrder = async () => {
    setBusy('create');
    try {
      const lines = chosen.map((line) => {
        const swapTo = swaps[line.part_number];
        const swapped = swapTo && line.did_you_mean?.find((s) => s.part_number === swapTo);
        if (swapped) {
          return { ...line, part_number: swapped.part_number, description: swapped.description,
            unit_price_ex_vat: Number(swapped.price_ex_vat) || null, did_you_mean: undefined };
        }
        return overrides[line.part_number] ? { ...line, override_reason: overrides[line.part_number] } : line;
      });
      const { data } = await api.post('/admin/parts-orders', { lines, delivery_method: 'collect' });
      toast.success(`${data.reference} created with ${data.items.length} lines`);
      setSkip(new Set());
      setBlocked(null);
      setOverrides({});
      setSwaps({});
      await load();
      setOpenOrder(data.id);
    } catch (e) {
      if (e.response?.status === 409 && e.response.data?.blocked) {
        setBlocked(e.response.data.blocked);
        toast.error(e.response.data.error);
      } else {
        toast.error(e.response?.data?.error || 'Could not create that order');
      }
    } finally { setBusy(''); }
  };

  if (loading && !orders.length) return <Loading />;

  return (
    <div>
      <div className="card mb-3">
        <div className="flex-between" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>What the workshop needs</h3>
            <p className="text-sm muted" style={{ margin: '4px 0 0' }}>
              {suggestion?.lines?.length
                ? `${suggestion.lines.length} part${suggestion.lines.length === 1 ? '' : 's'} from ${suggestion.bikes_due} bike${suggestion.bikes_due === 1 ? '' : 's'} due for service and ${suggestion.job_cards} open job card${suggestion.job_cards === 1 ? '' : 's'}. Parts already on an open order are left out.`
                : 'Nothing outstanding: no service is due and no open job card is waiting on a part.'}
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm btn-secondary" onClick={load} disabled={!!busy}><RefreshCw size={13} /> Refresh</button>
            <button className="btn btn-sm btn-primary" onClick={createOrder} disabled={!!busy || !chosen.length}>
              <FileSpreadsheet size={13} /> Create RFQ ({chosen.length})
            </button>
          </div>
        </div>

        {blocked?.length > 0 && (
          <div className="card mt-2" style={{ borderLeft: '3px solid var(--danger)', padding: 12 }}>
            <strong>Not in Hero's price list</strong>
            <p className="text-sm muted" style={{ margin: '4px 0 6px' }}>
              Hero supply against the exact number requested, so these lines would come back rejected.
              Use the number they sell, untick the line, or order it anyway with a reason.
            </p>
            <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>
              {blocked.map((b) => (
                <li key={b.part_number}>
                  <span style={{ fontFamily: 'monospace' }}>{b.part_number}</span>
                  {b.description ? ` — ${b.description}` : ''}
                  {b.did_you_mean?.[0] && <span className="muted"> · closest: {b.did_you_mean[0].part_number} ({b.did_you_mean[0].description})</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!!suggestion?.lines?.length && (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 30 }} />
                  <th>Part number</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Each</th><th style={{ textAlign: 'right' }}>Line</th><th>Why</th>
                </tr>
              </thead>
              <tbody>
                {suggestion.lines.map((line) => {
                  const included = !skip.has(line.part_number);
                  return (
                    <tr key={line.part_number} style={{ opacity: included ? 1 : 0.45 }}>
                      <td>
                        <input type="checkbox" checked={included} onChange={() => {
                          setSkip((prev) => {
                            const next = new Set(prev);
                            if (next.has(line.part_number)) next.delete(line.part_number); else next.add(line.part_number);
                            return next;
                          });
                          setBlocked((prev) => prev?.filter((b) => b.part_number !== line.part_number) || null);
                        }} />
                      </td>
                      <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                        {swaps[line.part_number] || line.part_number}
                        {!line.in_catalogue && !swaps[line.part_number] && !overrides[line.part_number] && (
                          <span className="badge badge-warn" style={{ marginLeft: 6, fontSize: 9 }}>not in the price list</span>
                        )}
                        {swaps[line.part_number] && <span className="text-xs muted"> · was {line.part_number}</span>}
                        {overrides[line.part_number] && (
                          <div className="text-xs muted" style={{ whiteSpace: 'normal' }}>ordering anyway: {overrides[line.part_number]}</div>
                        )}
                        {line.replaced_by && <div className="text-xs" style={{ color: 'var(--danger)' }}>replaced by {line.replaced_by}</div>}
                        {!line.in_catalogue && !swaps[line.part_number] && !overrides[line.part_number] && line.did_you_mean?.length > 0 && (
                          <div className="text-xs" style={{ whiteSpace: 'normal', marginTop: 2 }}>
                            Hero sell {line.did_you_mean[0].part_number} ({line.did_you_mean[0].description}){' '}
                            <button className="btn btn-sm btn-secondary" style={{ padding: '0 6px', fontSize: 10 }}
                              onClick={() => {
                                setSwaps((prev) => ({ ...prev, [line.part_number]: line.did_you_mean[0].part_number }));
                                setBlocked((prev) => prev?.filter((b) => b.part_number !== line.part_number) || null);
                              }}>
                              use it
                            </button>{' '}
                            <button className="btn btn-sm btn-secondary" style={{ padding: '0 6px', fontSize: 10 }}
                              onClick={() => {
                                const reason = window.prompt(`Order ${line.part_number} anyway? Hero's price list doesn't carry it, so it may be rejected. Say why:`);
                                if (reason?.trim()) {
                                  setOverrides((prev) => ({ ...prev, [line.part_number]: reason.trim() }));
                                  setBlocked((prev) => prev?.filter((b) => b.part_number !== line.part_number) || null);
                                }
                              }}>
                              order anyway
                            </button>
                          </div>
                        )}
                      </td>
                      <td>{line.description}{line.our_name && <span className="text-xs muted"> · our name: {line.our_name}</span>}</td>
                      <td style={{ textAlign: 'right' }}>{line.qty_to_order}</td>
                      <td style={{ textAlign: 'right' }}>{money(line.unit_price_ex_vat)}</td>
                      <td style={{ textAlign: 'right' }}>{money((line.unit_price_ex_vat || 0) * line.qty_to_order)}</td>
                      <td className="text-sm muted">{line.reasons.join(', ')}{line.bikes?.length ? ` · ${line.bikes.length} bike${line.bikes.length === 1 ? '' : 's'}` : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} style={{ textAlign: 'right', fontWeight: 600 }}>Total excl. VAT</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(chosenTotal)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <h3 style={{ fontSize: 16 }}>Requests for quotation</h3>
      {!orders.length && <p className="text-sm muted">None yet.</p>}
      {!!orders.length && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr><th>Reference</th><th>Status</th><th style={{ textAlign: 'right' }}>Lines</th><th style={{ textAlign: 'right' }}>Total excl. VAT</th><th>Created</th><th /></tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td style={{ fontFamily: 'monospace' }}>{order.reference}</td>
                  <td>
                    <span style={{ background: ORDER_STATUS[order.status]?.colour, color: '#fff', borderRadius: 9, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>
                      {ORDER_STATUS[order.status]?.label || order.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{order.line_count}</td>
                  <td style={{ textAlign: 'right' }}>{money(order.total_ex_vat)}</td>
                  <td className="text-sm muted">{fmtDate(order.created_at)}{order.created_by_name ? ` · ${order.created_by_name}` : ''}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => setOpenOrder(order.id)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openOrder && <OrderModal id={openOrder} onClose={() => setOpenOrder(null)} onChanged={load} />}
    </div>
  );
}

function OrderModal({ id, onClose, onChanged }) {
  const [order, setOrder] = useState(null);
  const [busy, setBusy] = useState('');
  const [quoteRef, setQuoteRef] = useState('');

  const load = useCallback(async () => {
    const { data } = await api.get(`/admin/parts-orders/${id}`);
    setOrder(data);
    setQuoteRef(data.quote_reference || '');
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const download = () => {
    // The browser fetches this with the session's token via the api instance.
    api.get(`/admin/parts-orders/${id}/rfq`, { responseType: 'blob' }).then(({ data, headers }) => {
      const name = /filename="([^"]+)"/.exec(headers['content-disposition'] || '')?.[1] || `${order.reference}.xlsx`;
      const url = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = url; link.download = name; link.click();
      URL.revokeObjectURL(url);
    }).catch((e) => toast.error(e.response?.data?.error || 'Could not build the RFQ'));
  };

  const send = async () => {
    if (!window.confirm(`Email ${order.reference} to ${order.supplier_email}? This is a real request for quotation.`)) return;
    setBusy('send');
    try {
      await api.post(`/admin/parts-orders/${id}/send`, {});
      toast.success('RFQ sent to Hero');
      await load(); onChanged();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not send the RFQ');
    } finally { setBusy(''); }
  };

  const setStatus = async (status) => {
    setBusy(status);
    try {
      await api.put(`/admin/parts-orders/${id}/status`, { status, quote_reference: quoteRef.trim() || null });
      await load(); onChanged();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not update that order');
    } finally { setBusy(''); }
  };

  return (
    <Modal isOpen onClose={onClose} title={order ? `${order.reference} · ${ORDER_STATUS[order.status]?.label}` : 'Loading…'}>
      {!order ? <Loading /> : (
        <div style={{ minWidth: 520 }}>
          <div className="text-sm muted mb-2">
            {order.make} {order.model} · {order.items.length} lines · {money(order.total_ex_vat)} excl. VAT
            {order.sent_at && <> · sent {fmtDateTime(order.sent_at)} to {order.sent_to}</>}
          </div>

          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>Part number</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th><th>Why</th></tr></thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id}>
                    <td style={{ fontFamily: 'monospace' }}>{item.part_number}</td>
                    <td>{item.description}</td>
                    <td style={{ textAlign: 'right' }}>{item.qty}</td>
                    <td className="text-sm muted">{item.reason}{item.registration ? ` · ${item.registration}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row mt-3" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-secondary" onClick={download}><Download size={13} /> Download the RFQ</button>
            {order.status === 'draft' && (
              <button className="btn btn-sm btn-primary" onClick={send} disabled={busy === 'send'}>
                <Send size={13} /> {busy === 'send' ? 'Sending…' : `Email it to ${order.supplier}`}
              </button>
            )}
            {order.status === 'sent' && (
              <>
                <input value={quoteRef} onChange={(e) => setQuoteRef(e.target.value)} placeholder="Their quote reference" style={{ flex: '1 1 180px' }} />
                <button className="btn btn-sm btn-secondary" onClick={() => setStatus('quoted')} disabled={!!busy}>Quote received</button>
              </>
            )}
            {order.status === 'quoted' && <button className="btn btn-sm btn-primary" onClick={() => setStatus('ordered')} disabled={!!busy}>Accepted — order placed</button>}
            {order.status === 'ordered' && <button className="btn btn-sm btn-primary" onClick={() => setStatus('received')} disabled={!!busy}><Check size={13} /> Parts received</button>}
            {!['received', 'cancelled'].includes(order.status) && (
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => setStatus('cancelled')} disabled={!!busy}>Cancel</button>
            )}
          </div>

          {order.status === 'draft' && (
            <p className="text-xs muted mt-2">
              <Package size={11} /> The form goes to {order.supplier_email} on Hero's own template, with the part numbers, quantities and the delivery term.
              Nothing is sent until you press the button.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
