import { Link } from 'react-router-dom';
import { Building2, ArrowRight } from 'lucide-react';
import { brandName } from '../../brand';

// A page that belongs to a fleet, reached on a console that sells the
// platform rather than running motorcycles.
//
// The menu has never offered these, but the routes answered anyway, so a
// typed URL or an old bookmark put a platform admin inside somebody else's
// operating records with nothing on the screen saying whose. This is the
// other half of the boundary the API now enforces: the way in is to open the
// fleet's own account, which names them across every screen.
export default function NotOnThisConsole() {
  return (
    <div style={{ maxWidth: 560, margin: '48px auto', textAlign: 'center' }}>
      <div style={{
        width: 56, height: 56, borderRadius: 16, margin: '0 auto 18px',
        background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Building2 size={26} style={{ color: 'var(--primary)' }} />
      </div>
      <h1 style={{ marginBottom: 10 }}>That belongs to a fleet</h1>
      <p className="muted">
        {brandName} runs no motorcycles of its own, so applications, agreements, rider
        payments, claims and the workshop are a customer's records rather than this
        console's. Open their account to work in it — everything there is theirs, and
        every screen says whose.
      </p>
      <Link className="btn" to="/admin/fleet-dashboard" style={{ marginTop: 18 }}>
        Go to Fleets <ArrowRight size={15} />
      </Link>
    </div>
  );
}
