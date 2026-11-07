import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { BRAND, Empty, Spinner, api, rand } from '../lib.jsx';

// Printable documents: a store's statement and a customer's tax invoice.
// While one is open, printing shows only the document (Save as PDF works
// from every browser's print dialog).
function usePrintMode() {
  useEffect(() => {
    document.body.classList.add('print-doc');
    return () => document.body.classList.remove('print-doc');
  }, []);
}

// Server sends SAST wall-clock times; show them as given.
const sastDay = (s) => new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const sastTime = (s) => s.slice(11, 16);

function Toolbar({ back, children }) {
  return (
    <div className="doc-tools">
      {back}
      <div className="actions">{children}<button className="btn" onClick={() => window.print()}>🖨️ Print or save as PDF</button></div>
    </div>
  );
}

function Supplier({ s, title }) {
  return (
    <div className="doc-party">
      <span className="muted small">{title}</span>
      <strong>{s.name}</strong>
      {s.tradingAs && <span>t/a {s.tradingAs}</span>}
      {s.address && <span>{s.address}</span>}
      {s.companyReg && <span>Reg. {s.companyReg}</span>}
      {s.vatNumber && <span>VAT no. {s.vatNumber}</span>}
    </div>
  );
}

export function Statement() {
  usePrintMode();
  const [params] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/merchant/statement?from=${params.get('from') || ''}&to=${params.get('to') || ''}`).then(setD).catch((e) => setError(e.message));
  }, [params]);
  if (error) return <div className="page"><Empty icon="📄" title="Couldn't make the statement">{error}</Empty></div>;
  if (!d) return <div className="page center pad"><Spinner /></div>;
  const events = [
    ...d.orders.map((o) => ({ at: o.deliveredAt, o })),
    ...d.payouts.map((p) => ({ at: p.paidAt, p })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <div className="page doc-wrap">
      <Toolbar back={<Link to="/merchant" className="link">← Store console</Link>} />
      <article className="doc">
        <header className="doc-head">
          <div><h1>Statement</h1><p className="muted">{sastDay(d.from)} – {sastDay(d.to)}</p></div>
          <div className="doc-brand">💨 {BRAND.name}</div>
        </header>
        <div className="doc-parties">
          <Supplier title="Store" s={{ name: d.store.legalName || d.store.name, tradingAs: d.store.legalName ? d.store.name : null, address: d.store.address, vatNumber: d.store.vatNumber, companyReg: d.store.companyReg }} />
          <Supplier title="From" s={{ name: d.platform.name, vatNumber: d.platform.vatNumber }} />
        </div>
        <div className="doc-summary">
          <div><span>Opening balance</span><strong>{rand(d.openingBalanceCents)}</strong></div>
          <div><span>Earned</span><strong>{rand(d.earnedCents)}</strong></div>
          <div><span>Paid to you</span><strong>{rand(d.paidCents)}</strong></div>
          <div className="hl"><span>Closing balance</span><strong>{rand(d.closingBalanceCents)}</strong></div>
        </div>
        <table className="doc-table">
          <thead><tr><th>Date</th><th>Detail</th><th className="num">Sales</th><th className="num">Your promos</th><th className="num">Refunds</th><th className="num">Earned</th><th className="num">Paid out</th></tr></thead>
          <tbody>
            {events.length === 0 && <tr><td colSpan={7} className="muted">No deliveries or payouts in this period.</td></tr>}
            {events.map((e, i) => (e.o ? (
              <tr key={i}><td>{sastDay(e.at)} {sastTime(e.at)}</td><td>Order #{e.o.code} · {e.o.items} item{e.o.items === 1 ? '' : 's'}</td><td className="num">{rand(e.o.salesCents)}</td>
                <td className="num">{e.o.storePromoCents ? `−${rand(e.o.storePromoCents)}` : ''}</td><td className="num">{e.o.storeRefundCents ? `−${rand(e.o.storeRefundCents)}` : ''}</td><td className="num">{rand(e.o.earnedCents)}</td><td /></tr>
            ) : (
              <tr key={i} className="doc-payout"><td>{sastDay(e.at)}</td><td>EFT payout · ref {e.p.reference}</td><td /><td /><td /><td /><td className="num">{rand(e.p.amountCents)}</td></tr>
            )))}
          </tbody>
          <tfoot><tr><td colSpan={2}>Totals</td><td className="num">{rand(d.salesCents)}</td><td className="num">{d.storePromoCents ? `−${rand(d.storePromoCents)}` : ''}</td><td className="num">{d.storeRefundCents ? `−${rand(d.storeRefundCents)}` : ''}</td><td className="num">{rand(d.earnedCents)}</td><td className="num">{rand(d.paidCents)}</td></tr></tfoot>
        </table>
        {d.vatOnSalesCents != null && <p className="muted small">Earned includes VAT of {rand(d.vatOnSalesCents)} at 15% on your sales.</p>}
        <p className="muted small doc-foot">You earn the item total of every delivered order, less your own promo codes and refunds you agreed to carry. Delivery and service fees are invoiced to the customer by {d.platform.name}.</p>
      </article>
    </div>
  );
}

function Part({ part, title }) {
  return (
    <section className="doc-part">
      <div className="row-between">
        <Supplier title={title} s={part.supplier} />
        <span className="doc-kind">{part.taxInvoice ? 'Tax invoice' : 'Invoice'}</span>
      </div>
      <table className="doc-table">
        <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {part.lines.map((l, i) => <tr key={i}><td>{l.name}</td><td className="num">{l.qty || ''}</td><td className="num">{l.unitCents ? rand(l.unitCents) : ''}</td><td className="num">{rand(l.totalCents)}</td></tr>)}
          {part.discountCents > 0 && <tr><td>Discount</td><td /><td /><td className="num">−{rand(part.discountCents)}</td></tr>}
        </tbody>
        <tfoot>
          <tr><td colSpan={3}>Total{part.taxInvoice ? ' (incl. VAT)' : ''}</td><td className="num">{rand(part.totalCents)}</td></tr>
          {part.vatCents != null && <tr className="muted"><td colSpan={3}>VAT at 15% included</td><td className="num">{rand(part.vatCents)}</td></tr>}
          {part.vatCents != null && <tr className="muted"><td colSpan={3}>Excluding VAT</td><td className="num">{rand(part.totalCents - part.vatCents)}</td></tr>}
        </tfoot>
      </table>
      {!part.taxInvoice && <p className="muted small">This supplier is not registered for VAT, so no VAT is charged.</p>}
    </section>
  );
}

export function Invoice() {
  usePrintMode();
  const { id } = useParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api(`/orders/${id}/invoice`).then(setD).catch((e) => setError(e.message)); }, [id]);
  if (error) return <div className="page"><Empty icon="🧾" title="No invoice yet">{error}<br /><Link to={`/orders/${id}`}>Back to the order</Link></Empty></div>;
  if (!d) return <div className="page center pad"><Spinner /></div>;
  return (
    <div className="page doc-wrap">
      <Toolbar back={<Link to={`/orders/${id}`} className="link">← Order</Link>} />
      <article className="doc">
        <header className="doc-head">
          <div><h1>{d.goods.taxInvoice || d.services.taxInvoice ? 'Tax invoice' : 'Invoice'}</h1><p className="muted">{d.number} · {sastDay(d.date)}</p></div>
          <div className="doc-brand">💨 {BRAND.name}</div>
        </header>
        <div className="doc-party">
          <span className="muted small">Billed to</span>
          <strong>{d.customer.name}</strong>
          <span>{d.customer.address}</span>
          <span>{d.customer.email}</span>
        </div>
        <Part title="Goods sold by" part={d.goods} />
        <Part title="Delivery and service by" part={d.services} />
        <div className="doc-summary">
          <div><span>Goods</span><strong>{rand(d.goods.totalCents)}</strong></div>
          <div><span>Delivery and service</span><strong>{rand(d.services.totalCents)}</strong></div>
          {d.tipCents > 0 && <div><span>Rider tip (not VAT-able)</span><strong>{rand(d.tipCents)}</strong></div>}
          <div className="hl"><span>Paid</span><strong>{rand(d.paidCents)}</strong></div>
          {d.refundedCents > 0 && <div><span>Refunded</span><strong>−{rand(d.refundedCents)}</strong></div>}
        </div>
        <p className="muted small doc-foot">Order #{d.orderCode}{d.promoCode ? ` · Promo ${d.promoCode}` : ''}. {BRAND.name} collects payment on behalf of the store for the goods.</p>
      </article>
    </div>
  );
}
