import { useEffect, useState } from 'react';
import { MessageCircle, Phone, Mail, LifeBuoy } from 'lucide-react';
import api from '../api';

// Digits only — wa.me rejects spaces, +, and dashes.
const waNumber = (phone) => String(phone || '').replace(/[^0-9]/g, '');

/**
 * Who to call when something goes wrong. Riders previously had no contact
 * channel anywhere in the portal — the agreement page even told them to
 * "contact OnFleet" without giving them any way to do it.
 *
 * Renders nothing at all when the platform has no support details configured,
 * so an unconfigured deploy shows no card rather than a dead phone number.
 */
export default function SupportContact({ title = 'Need help?', sub, compact = false }) {
  const [contact, setContact] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get('/auth/support-contact')
      .then((r) => { if (alive) setContact(r.data); })
      .catch(() => { /* support card is non-essential — stay silent */ });
    return () => { alive = false; };
  }, []);

  if (!contact) return null;
  const { name, phone, email, whatsapp } = contact;
  if (!phone && !email && !whatsapp) return null;

  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <LifeBuoy size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{title}</strong>
          <div className="muted text-sm mt-1">
            {sub || `Contact ${name} directly — they can help with your bike, payments, or agreement.`}
          </div>
          <div className="row mt-3" style={{ flexWrap: 'wrap', gap: 8 }}>
            {whatsapp && (
              <a
                className="btn btn-sm"
                href={`https://wa.me/${waNumber(whatsapp)}`}
                target="_blank"
                rel="noopener noreferrer"
              ><MessageCircle size={14} /> WhatsApp</a>
            )}
            {phone && (
              <a className="btn btn-sm btn-secondary" href={`tel:${phone}`}><Phone size={14} /> Call{compact ? '' : ` ${phone}`}</a>
            )}
            {email && (
              <a className="btn btn-sm btn-secondary" href={`mailto:${email}`}><Mail size={14} /> Email</a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
