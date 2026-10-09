import { useEffect, useState } from 'react';
import api from '../../api';
import { Loading } from '../../components/ui';
import TrackingConsole from '../admin/Tracking';

/**
 * The fleet portal's GPS tracking screen.
 *
 * This was a separate 537-line implementation of the same idea: a device
 * list, a map and a detail panel, built smaller and differently from the one
 * the operator uses. Two screens doing one job means the fleet's version is
 * always a release or two behind, and every improvement to the operator's
 * has to be remembered twice.
 *
 * So it is the same component, mounted against this fleet's own scoped
 * routes. Structure is identical by construction rather than by imitation,
 * and what a fleet can see is decided by what it pays for.
 */
export default function FleetTracking() {
  const [tier, setTier] = useState(undefined);

  useEffect(() => {
    // Falls back to 'basic' rather than to ungated. If this call fails the
    // screen should show the least a paying fleet is entitled to, not the
    // operator's full console.
    api.get('/fleet/billing/status')
      .then((r) => setTier(r.data?.tier?.current || 'basic'))
      .catch(() => setTier('basic'));
  }, []);

  if (tier === undefined) return <Loading />;

  return <TrackingConsole apiBase="/fleet/tracking" tier={tier} />;
}
