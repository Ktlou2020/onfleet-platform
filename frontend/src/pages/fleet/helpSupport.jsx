import { ArrowRight, Info } from 'lucide-react';
import { Link } from 'react-router-dom';

export function fleetHelpHref(section = 'getting-started') {
  return `/fleet/app/help#${section}`;
}

export function FleetHelpTip({ section = 'getting-started', tooltip = '', label = 'Learn more', compact = false }) {
  return (
    <span className={`fleet-help-inline${compact ? ' compact' : ''}`}>
      {tooltip ? (
        <span className="fleet-help-tooltip" title={tooltip} aria-label={tooltip}>
          <Info size={14} />
        </span>
      ) : null}
      <Link className="fleet-help-link" to={fleetHelpHref(section)}>
        <span>{label}</span>
        <ArrowRight size={12} />
      </Link>
    </span>
  );
}
