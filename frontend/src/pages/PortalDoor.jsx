import { Link } from 'react-router-dom';
import { Building2, Wrench, User, ArrowRight } from 'lucide-react';
import Logo from '../components/Logo';
import brand, { brandName } from '../brand';

// The front door for a deployment that is not OnFleet.
//
// "/" used to render OnFleet's rider landing page whatever brand was serving
// it, so a fleet operator arriving at Pillion's portal met a rent-to-own offer
// aimed at riders, a section headed "Why OnFleet", a competitor's WhatsApp
// number, and an empty bike catalogue. Every one of those is wrong for the
// person standing there.
//
// This is deliberately not a marketing page. Marketing lives on its own
// domain; a portal's front door has one job, which is to get the person who
// arrived to the right sign-in. Three doors, because the platform has three
// kinds of user and guessing wrong costs them a failed login.
//
// When a marketing site is live, HomeRoute sends signed-out visitors there
// instead and this is never seen — it is the honest fallback for before that
// is true, not a placeholder nobody finished.

const DOORS = [
  {
    to: '/fleet/login',
    icon: Building2,
    title: 'Fleet owner',
    body: 'Your bikes, riders, agreements and collections.',
  },
  {
    to: '/workshop/login',
    icon: Wrench,
    title: 'Workshop',
    body: 'Job cards, parts and service schedules.',
  },
  {
    to: '/login',
    icon: User,
    title: 'Rider',
    body: 'Your agreement, your payments and your bike.',
  },
];

export default function PortalDoor() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <header style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
        <Logo />
      </header>

      <main
        style={{
          flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center',
          padding: '48px 24px', maxWidth: 780, width: '100%', margin: '0 auto',
        }}
      >
        <h1 style={{ fontSize: 'clamp(26px, 5vw, 38px)', lineHeight: 1.15, marginBottom: 10 }}>
          Sign in to {brandName}
        </h1>
        <p className="muted" style={{ fontSize: 16, marginBottom: 28, maxWidth: '52ch' }}>
          Fleet management for two-wheeler operators — where every bike is, what every rider owes,
          and what the workshop did to it.
        </p>

        <div style={{ display: 'grid', gap: 12 }}>
          {DOORS.map(({ to, icon: Icon, title, body }) => (
            <Link
              key={to}
              to={to}
              className="card"
              style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: 18, textDecoration: 'none', color: 'inherit',
              }}
            >
              <span
                style={{
                  width: 42, height: 42, flexShrink: 0, borderRadius: 10,
                  background: 'var(--surface-2)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Icon size={20} style={{ color: 'var(--primary)' }} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 600 }}>{title}</span>
                <span className="muted text-sm" style={{ display: 'block' }}>{body}</span>
              </span>
              <ArrowRight size={18} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            </Link>
          ))}
        </div>

        <p className="muted text-sm" style={{ marginTop: 24 }}>
          Looking to put a fleet on {brandName}?{' '}
          <Link to="/fleet/signup">Create a company account</Link>.
        </p>
      </main>

      <footer style={{ padding: '18px 24px', borderTop: '1px solid var(--border)' }}>
        <p className="muted text-xs" style={{ margin: 0 }}>
          © {new Date().getFullYear()} {brand.fullName} · Johannesburg, South Africa
        </p>
      </footer>
    </div>
  );
}
