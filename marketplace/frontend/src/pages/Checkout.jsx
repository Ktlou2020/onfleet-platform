import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Empty, api, rand, useAuth, useCart, useLoc, useMeta, useToast } from '../lib.jsx';

export function VerifyAge({ onDone }) {
  const { setUser } = useAuth();
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await api('/me/verify-age', { method: 'POST', body: { idNumber: id } });
      setUser(d.user);
      onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card verify" onSubmit={submit}>
      <h3>🪪 Verify you're 18+</h3>
      <p className="muted">Once only. We use your SA ID number to confirm your age — the rider will also check your ID at the door.</p>
      <label className="field">
        <span>SA ID number</span>
        <input inputMode="numeric" maxLength={13} value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ''))} placeholder="13 digits" required />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn full" disabled={busy || id.length !== 13}>{busy ? 'Checking…' : 'Verify'}</button>
    </form>
  );
}

export default function Checkout({ onAddress }) {
  const { cart, setQty, clear, subtotal } = useCart();
  const { user } = useAuth();
  const { loc } = useLoc();
  const meta = useMeta();
  const notify = useToast();
  const navigate = useNavigate();
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [notes, setNotes] = useState('');
  const [tipCents, setTipCents] = useState(1000);
  const [promoInput, setPromoInput] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [offers, setOffers] = useState([]);
  useEffect(() => { api('/promos').then((d) => setOffers(d.promos)).catch(() => {}); }, [user?.id]);
  const [busy, setBusy] = useState(false);

  const itemsKey = JSON.stringify(cart.items.map((i) => [i.id, i.qty]));
  useEffect(() => {
    if (!cart.store || !loc) { setQuote(null); return; }
    setQuoteError('');
    api('/quote', { method: 'POST', body: { storeId: cart.store.id, items: cart.items.map((i) => ({ productId: i.id, qty: i.qty })), lat: loc.lat, lng: loc.lng, promoCode: promoCode || undefined } })
      .then((d) => setQuote(d.quote))
      .catch((e) => { setQuote(null); setQuoteError(e.message); });
  }, [itemsKey, loc, cart.store, promoCode, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cart.items.length) {
    return <div className="page"><Empty icon="🛒" title="Your basket is empty"><Link className="btn" to="/">Browse stores</Link></Empty></div>;
  }

  const place = async () => {
    setBusy(true);
    try {
      const { order } = await api('/orders', {
        method: 'POST',
        body: { storeId: cart.store.id, items: cart.items.map((i) => ({ productId: i.id, qty: i.qty })), lat: loc.lat, lng: loc.lng, address: loc.label, notes, tipCents, promoCode: quote?.promo ? promoCode : undefined },
      });
      const paid = await api(`/orders/${order.id}/pay`, { method: 'POST' });
      clear();
      if (paid.redirectUrl) { window.location.href = paid.redirectUrl; return; }
      notify('Order placed — the store has it', 'ok');
      navigate(`/orders/${order.id}`);
    } catch (e) {
      notify(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const canPlace = user?.role === 'customer' && user.ageVerified && loc && quote && !quote.belowMinimum && meta?.deliveryHours.openNow !== false;

  return (
    <div className="page narrow">
      <h1>Checkout</h1>
      <div className="card">
        <div className="row-between">
          <h3>{cart.store.name}</h3>
          <Link to={`/store/${cart.store.slug}`} className="link">Add more</Link>
        </div>
        {cart.items.map((i) => (
          <div key={i.id} className="line">
            <span className="line-icon">{i.icon}</span>
            <span className="line-name">{i.name}</span>
            <div className="stepper">
              <button onClick={() => setQty(i.id, i.qty - 1)} aria-label="Fewer">−</button>
              <span>{i.qty}</span>
              <button onClick={() => setQty(i.id, i.qty + 1)} aria-label="More">+</button>
            </div>
            <strong className="line-price">{rand(i.priceCents * i.qty)}</strong>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="row-between">
          <h3>📍 Deliver to</h3>
          <button className="link" onClick={onAddress}>{loc ? 'Change' : 'Add'}</button>
        </div>
        <p>{loc?.label || 'No address yet'}</p>
        <label className="field">
          <span>Note for the rider (optional)</span>
          <input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} placeholder="Gate code, complex name, landmark…" />
        </label>
      </div>

      <div className="card">
        <h3>Summary</h3>
        <div className="sum"><span>Items</span><span>{rand(quote?.subtotalCents ?? subtotal)}</span></div>
        {quote && (
          <>
            <div className="sum"><span>Delivery ({quote.distanceKm} km)</span><span>{quote.deliveryFeeCents ? rand(quote.deliveryFeeCents) : 'Free'}</span></div>
            <div className="sum"><span>Service fee</span><span>{rand(quote.serviceFeeCents)}</span></div>
            {quote.discountCents > 0 && <div className="sum discount"><span>🏷️ {quote.promo.code}</span><span>−{rand(quote.discountCents)}</span></div>}
            <div className="promo-box">
              {quote.promo ? (
                <p className="small"><strong>{quote.promo.code}</strong> applied — {quote.promo.description}. <button className="link" onClick={() => { setPromoCode(''); setPromoInput(''); }}>Remove</button></p>
              ) : (
                <>
                  <form className="promo-form" onSubmit={(e) => { e.preventDefault(); setPromoCode(promoInput.trim().toUpperCase()); }}>
                    <input value={promoInput} onChange={(e) => setPromoInput(e.target.value)} placeholder="Promo code" aria-label="Promo code" autoCapitalize="characters" />
                    <button className="btn btn-sm btn-ghost" disabled={!promoInput.trim()}>Apply</button>
                  </form>
                  {quote.promoError && promoCode && <p className="error small">{quote.promoError}</p>}
                  {offers.length > 0 && (
                    <div className="promo-offers">
                      {offers.map((o) => (
                        <button key={o.code} type="button" className="promo-chip" onClick={() => { setPromoInput(o.code); setPromoCode(o.code); }}>
                          <strong>{o.code}</strong><span>{o.description}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="tip-box">
              <div className="row-between"><strong>Tip your rider</strong><span className="muted small">100% goes to them</span></div>
              <div className="tip-chips">
                {(meta?.tipPresetsCents || [0, 1000, 2000, 3000]).map((t) => (
                  <button key={t} type="button" className={`chip ${tipCents === t ? 'on' : ''}`} onClick={() => setTipCents(t)}>{t ? rand(t) : 'Not now'}</button>
                ))}
              </div>
            </div>
            {tipCents > 0 && <div className="sum"><span>Rider tip</span><span>{rand(tipCents)}</span></div>}
            <div className="sum total"><span>Total</span><span>{rand(quote.totalCents + tipCents)}</span></div>
            <p className="muted small">Includes VAT of {rand(quote.vatCents)} · Arrives in about {quote.etaMinutes}–{quote.etaMinutes + 10} min</p>
            {quote.belowMinimum && <p className="error">Minimum order is {rand(quote.minimumOrderCents)} — add {rand(quote.minimumOrderCents - quote.subtotalCents)} more.</p>}
            {meta && quote.subtotalCents < meta.fees.freeDeliveryOverCents && quote.deliveryFeeCents > 0 && (
              <p className="hint">Add {rand(meta.fees.freeDeliveryOverCents - quote.subtotalCents)} for free delivery.</p>
            )}
          </>
        )}
        {quoteError && <p className="error">{quoteError}</p>}
      </div>

      {!user && (
        <div className="card center-text">
          <p>Sign in to place your order.</p>
          <Link className="btn full" to="/login?next=/checkout">Sign in or create an account</Link>
        </div>
      )}
      {user && user.role !== 'customer' && <p className="banner warn">You're signed in as a {user.role}. Use a customer account to order.</p>}
      {user?.role === 'customer' && !user.ageVerified && <VerifyAge />}
      {meta?.deliveryHours.openNow === false && <p className="banner">🌙 Delivery opens at {meta.deliveryHours.open}:00.</p>}

      <button className="btn btn-lg full sticky-cta" disabled={!canPlace || busy} onClick={place}>
        {busy ? 'Placing order…' : quote ? `Pay ${rand(quote.totalCents + tipCents)}` : 'Pay'}
      </button>
      {meta?.paymentProvider === 'mock' && <p className="muted small center-text">Demo mode: payment is simulated.</p>}
    </div>
  );
}
