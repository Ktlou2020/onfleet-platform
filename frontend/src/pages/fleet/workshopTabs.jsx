import { NavLink } from 'react-router-dom';

// Two views of the same subject, so one heading and a pair of pills rather
// than two menu entries both called Workshop.
//
//   Work done   what the workshop has done to your bikes, and what is due.
//   Your diary  the workshop you run yourself: hours, closures, who is in.
//
// Both sit behind the `workshop` section, so a plan or a role that cannot see
// one cannot see either, and neither pill needs its own guard.

const TABS = [
  { to: '/fleet/app/workshop', label: 'Work done', end: true },
  { to: '/fleet/app/workshop/diary', label: 'Your diary' },
];

export default function WorkshopTabs() {
  return (
    <div className="filter-pills" style={{ margin: '0 0 14px' }}>
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end}
                 className={({ isActive }) => `filter-pill${isActive ? ' active' : ''}`}
                 style={{ textDecoration: 'none' }}>
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}
