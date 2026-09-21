import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  BookOpen, ClipboardList, CalendarClock, Search, FileSpreadsheet, Upload,
  LifeBuoy, CheckCircle2, Circle, ChevronRight, Wrench, AlertTriangle, Users,
} from 'lucide-react';
import api from '../api';
import { fmt } from './ui';

// The workshop guide, in the product rather than in a folder somewhere.
//
// Three things make it worth opening twice: it ticks off where you got to and
// remembers that against your name, the parts search inside it is the real
// catalogue, and the schedule box asks the real schedule what a bike needs at
// a kilometre reading you type. Reading about a feature and using it are the
// same action here.

const money = (value) => (value == null ? '—' : fmt(Number(value)));

// Where each section's steps live. Step keys are stable strings, since
// progress is stored against them.
const SECTIONS = [
  {
    id: 'job-card',
    title: 'Running a job card',
    icon: ClipboardList,
    forRole: 'everyone',
    summary: 'One visit by one bike: what was found, what was fitted, what it cost, and the odometer when it left.',
    steps: [
      ['open', 'Open the card and check the registration against the bike in front of you.',
        'The card shows the rider, the fleet, the odometer the trackers have recorded, and the bike\'s service history.'],
      ['start', 'Press Start job.',
        'This starts the work timer, which is what the Technicians tab reports on. Stopping for parts or lunch? Press Pause work timer — paused time is not counted against you.'],
      ['schedule', 'Read the Service schedule panel, under the bike details.',
        'It tells you what Hero say this bike needs at the kilometres on its clock.'],
      ['odometer', 'Type the real odometer reading into Current km.',
        'The schedule panel re-reads itself as you type, so the recommendation matches the bike rather than the last thing a tracker saw.'],
      ['lines', 'Add every part and every hour.',
        'Parts the schedule recommends go on with one press of Add, carrying their part number and price. Typing a part? Pick it from the catalogue so the number comes with it.'],
      ['photos', 'Photograph anything worn, damaged or disputable.'],
      ['complete', 'Complete the job: notes, odometer, and the bike\'s status afterwards.',
        'Two things will stop you: a job on a bike cannot close without an odometer reading, and a job with no parts and no labour asks you to confirm you are closing it uncosted.'],
    ],
    links: [{ label: 'Open job cards', to: '/workshop/app/job-cards', adminTo: '/admin/workshop' }],
  },
  {
    id: 'schedule',
    title: 'The service schedule',
    icon: CalendarClock,
    forRole: 'everyone',
    summary: 'Hero\'s maintenance chart and 36-month schedule, loaded — so the job card says what this bike needs.',
    steps: [
      ['services', 'Know which service the bike is at.',
        'Eleven services from 500 km to 30 500 km, then repeating every 3 000 km. Each has a 500 km window, so 12 400 km and 12 500 km are both service 5.'],
      ['due', 'Fit everything under Replace now.',
        'Each part comes with its Hero number and price. A part fitted recently is left out, and says when it was last fitted.'],
      ['soon', 'Consider what is under Worth doing while it is here.',
        'Anything falling due within the next 1 500 km — cheaper now than bringing the bike back.'],
      ['checklist', 'Work the check list for that service.',
        'Every item from Hero\'s chart, in words: Inspect, Clean, Adjust if required, Lubricate, Replace, Oil change, Top up, Emission check.'],
    ],
    interactive: 'schedule',
  },
  {
    id: 'parts',
    title: 'Finding a part',
    icon: Search,
    forRole: 'everyone',
    summary: '860 parts and 21 kits from Hero\'s dealer price list, every one priced.',
    steps: [
      ['name', 'Search by what the part is called — "brake pads" finds KIT, BRAKE SHOE.',
        'Each word is matched separately and the parts matching more of them come first.'],
      ['number', 'Or search the number stamped on the part.',
        'Dashes, spaces and capitals make no difference: 12391AAK900S, 12391-aak-900-s and 12391 AAK 900 S all find the same part.'],
      ['old', 'The old number works too.',
        'Searching 90463-ML7-000 finds 90463KRM840S, the part that replaced it.'],
      ['exact', 'Order the number the price list gives you — never one off a note or from memory.',
        'Hero supply only against the number requested, and issue no quotation at all if the numbers are missing. A wrong number comes back rejected and the bike waits.'],
    ],
    interactive: 'parts',
    links: [{ label: 'Open parts search', to: '/workshop/app/parts', adminTo: '/admin/workshop?tab=Parts' }],
  },
  {
    id: 'ordering',
    title: 'Ordering from Hero',
    icon: FileSpreadsheet,
    forRole: 'admin',
    summary: 'The platform builds the request from the work, writes it onto Hero\'s own form, and tracks what comes back.',
    steps: [
      ['needs', 'Read "What the workshop needs" under Workshop → Parts orders.',
        'Built from bikes whose service is due and parts on open job cards. The same part across several bikes is added up; anything already on an open order is left off.'],
      ['untick', 'Untick anything you do not want. The Why column says where each line came from.'],
      ['blocked', 'Deal with any line marked "not in the price list".',
        'Use the number Hero do sell, order it anyway with a reason, or untick it. Read the description, not just the number — the clutch cable\'s nearest number was the cable\'s rubber boot at a tenth of the price.'],
      ['create', 'Press Create RFQ. This makes a draft — nothing has left the building yet.'],
      ['check', 'Open it and download the RFQ to check the finished form.',
        'It is Hero\'s own template: their letterhead, their field order, their line numbering, with only the dates, our details and the lines filled in.'],
      ['send', 'Email it to Hero, stating whether we collect or they courier.',
        'Goes to parts@heromotorcycles.co.za with the form attached. You will be asked to confirm — this is a real request for quotation.'],
      ['track', 'Record their quote reference when it lands, then mark the order placed and received.',
        'Quotes are valid 30 days. They pick and dispatch within 48 hours of payment or a purchase order. Parts on a received order count as needed again next time.'],
    ],
    links: [{ label: 'Open parts orders', to: '/admin/workshop?tab=Parts%20orders', adminTo: '/admin/workshop?tab=Parts%20orders' }],
  },
  {
    id: 'price-list',
    title: 'Loading a price list',
    icon: Upload,
    forRole: 'admin',
    summary: 'When Hero send an updated list, load it yourself.',
    steps: [
      ['fields', 'Workshop → Parts → Upload a parts list. Set make and model to match the bikes: Hero, Eco 150.',
        'The catalogue is searched from job cards by make and model, so a list filed under "ECO 150 (Dec, 2019)" would never be found.'],
      ['preview', 'Press "Check it first".',
        'It reads the file without saving anything and reports what it found on each sheet.'],
      ['upload', 'Press Upload.',
        'Re-uploading refreshes prices rather than duplicating parts. A sheet named Kits is marked as kits.'],
    ],
  },
  {
    id: 'trouble',
    title: 'When something is wrong',
    icon: LifeBuoy,
    forRole: 'everyone',
    summary: 'The messages you will actually meet, and what to do about each.',
    trouble: [
      ['No service schedule loaded', 'The bike is not a Hero Eco 150', 'Service it from the manufacturer\'s book; ask an admin to load that model\'s chart.'],
      ['A part shows "not in the price list"', 'The schedule\'s number is not one Hero sell', 'Use the closest number if the description matches, or check with Hero. One is known: the tappet cover gasket.'],
      ['A part number finds nothing', 'Not in this list, or a typo', 'Search the part\'s name instead. Two letters is the minimum.'],
      ['"This job has no parts or labour recorded"', 'Nothing was costed on the card', 'Add the lines. If it genuinely cost nothing, confirm and close.'],
      ['"Odometer reading is required"', 'A bike\'s card cannot close without the clock reading', 'Read it off the bike and enter it.'],
      ['An order will not create', 'A line carries a number Hero do not sell', 'Swap it, override it with a reason, or untick it.'],
      ['"No email provider is configured"', 'The RFQ could not be emailed', 'Download it and send it from your own mail. The order stays a draft.'],
    ],
  },
];

const ACTION_CODES = [
  ['I', 'Inspect'], ['C', 'Clean'], ['A', 'Adjust if required'], ['R', 'Replace'],
  ['O', 'Oil change'], ['T', 'Top up'], ['L', 'Lubricate'], ['E', 'Emission check'],
];

const INTERVALS = [
  ['Engine oil', 'Replace every 6 000 km; top up every 3 000 km'],
  ['Air cleaner element', 'Clean at every service; replace every 15 000 km, sooner in dust'],
  ['Drive chain', 'Inspect, clean, lubricate and adjust every 2 000 km'],
  ['Front fork oil', 'Replace every two years or 30 000 km, whichever is first'],
  ['Services', '500 km, then every 3 000 km — 11 published, repeating after 30 500 km'],
];

// ── Live parts search, against the real catalogue ────────────────────────────

function TryPartsSearch() {
  const [query, setQuery] = useState('brake pads');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await api.get('/workshop/parts-catalog/search', { params: { q: query.trim(), limit: 6 } });
        setResults(data.results);
      } catch {
        setResults([]);
      } finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query]);

  return (
    <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
      <div className="text-xs muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>
        Try it — this is the real catalogue
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {['brake pads', '12391-aak-900-s', '90463-ML7-000', 'chain sprocket'].map((example) => (
          <button key={example} className="btn btn-sm btn-secondary" style={{ fontSize: 11 }} onClick={() => setQuery(example)}>
            {example}
          </button>
        ))}
      </div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Part name or number" style={{ width: '100%' }} />
      <div style={{ marginTop: 8 }}>
        {searching && <div className="text-sm muted">Searching…</div>}
        {!searching && !results.length && query.trim().length >= 2 && (
          <div className="text-sm muted">Nothing matches “{query.trim()}”. Try the part name instead.</div>
        )}
        {results.map((part) => (
          <div key={part.id} style={{ display: 'flex', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontFamily: 'monospace', fontSize: 12, minWidth: 140 }}>{part.part_number}</span>
            <span style={{ flex: 1, fontSize: 13 }}>
              {part.description}
              {part.is_kit && <span className="badge badge-info" style={{ marginLeft: 6, fontSize: 9 }}>KIT</span>}
              {part.supersedes && <span className="text-xs muted"> · replaces {part.supersedes}</span>}
            </span>
            <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{money(part.price_ex_vat)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Schedule box: ask the real schedule what a reading needs ─────────────────

function TrySchedule() {
  const [km, setKm] = useState(12500);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);

  const ask = useCallback(async (value) => {
    setLoading(true);
    try {
      const { data } = await api.get('/workshop/service-plan', {
        params: { make: 'Hero', model: 'Eco 150', odometer_km: value },
      });
      setPlan(data);
    } catch {
      setPlan(null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { ask(12500); }, [ask]);

  return (
    <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
      <div className="text-xs muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>
        Try it — a Hero Eco 150 at any reading
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="number" value={km} min="0" step="500" onChange={(e) => setKm(e.target.value)}
          style={{ width: 130 }} aria-label="Odometer reading in kilometres" />
        <span className="text-sm muted">km</span>
        <button className="btn btn-sm" onClick={() => ask(km)} disabled={loading}>{loading ? 'Checking…' : 'What is due?'}</button>
        {[600, 12500, 30500, 42500].map((value) => (
          <button key={value} className="btn btn-sm btn-secondary" style={{ fontSize: 11 }}
            onClick={() => { setKm(value); ask(value); }}>{value.toLocaleString()} km</button>
        ))}
      </div>

      {plan?.has_schedule === false && <div className="text-sm muted mt-2">No schedule is loaded for that bike.</div>}
      {plan?.has_schedule && (
        <div style={{ marginTop: 10 }}>
          <div className="text-sm" style={{ fontWeight: 600 }}>
            Service {plan.service?.service_no}
            {plan.service?.repeat_of ? ` (repeating the ${plan.service.repeat_of}th list)` : ''}
            <span className="muted"> · {plan.parts_due.length} part{plan.parts_due.length === 1 ? '' : 's'} due · {money(plan.parts_due_total_ex_vat)} excl. VAT</span>
          </div>
          {plan.parts_due.map((part) => (
            <div key={`${part.part_number}-${part.description}`} style={{ display: 'flex', gap: 10, padding: '4px 0', fontSize: 13 }}>
              <Wrench size={12} style={{ marginTop: 3, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{part.description}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{part.part_number}</span>
              <span style={{ whiteSpace: 'nowrap' }}>{money(part.price_ex_vat)}</span>
            </div>
          ))}
          {plan.parts_soon.length > 0 && (
            <div className="text-sm muted" style={{ marginTop: 6 }}>
              Worth doing while it is here: {plan.parts_soon.map((p) => `${p.description} (in ${Number(p.km_until).toLocaleString()} km)`).join(', ')}
            </div>
          )}
          <div className="text-xs muted" style={{ marginTop: 6 }}>
            Check list for this service: {plan.tasks.length} items — {plan.tasks.filter((t) => t.replaces).length} to replace
          </div>
        </div>
      )}
    </div>
  );
}

// ── The guide ────────────────────────────────────────────────────────────────

export default function WorkshopGuide({ portal = 'workshop' }) {
  const [done, setDone] = useState(() => new Set());
  const [open, setOpen] = useState('job-card');
  const [filter, setFilter] = useState('');
  const [team, setTeam] = useState(null);
  const isAdmin = portal === 'admin';

  const sections = useMemo(
    () => SECTIONS.filter((s) => (isAdmin || s.forRole !== 'admin')),
    [isAdmin],
  );
  const allSteps = useMemo(
    () => sections.flatMap((s) => (s.steps || []).map(([key]) => `${s.id}.${key}`)),
    [sections],
  );

  useEffect(() => {
    api.get('/workshop/guide/progress').then(({ data }) => setDone(new Set(data.done))).catch(() => {});
    if (isAdmin) api.get('/workshop/guide/progress/team').then(({ data }) => setTeam(data)).catch(() => {});
  }, [isAdmin]);

  const toggle = async (stepKey) => {
    const next = new Set(done);
    const nowDone = !next.has(stepKey);
    if (nowDone) next.add(stepKey); else next.delete(stepKey);
    setDone(next);
    try {
      await api.put('/workshop/guide/progress', { step_key: stepKey, done: nowDone });
    } catch {
      toast.error('Could not save your progress — it will still be here on this screen.');
    }
  };

  const doneCount = allSteps.filter((key) => done.has(key)).length;
  const pct = allSteps.length ? Math.round((doneCount / allSteps.length) * 100) : 0;
  const matches = (section) => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return true;
    const hay = [section.title, section.summary,
      ...(section.steps || []).flatMap(([, title, detail]) => [title, detail || '']),
      ...(section.trouble || []).flat()].join(' ').toLowerCase();
    return hay.includes(needle);
  };
  const visible = sections.filter(matches);

  return (
    <div>
      <h1 className="page-title">Workshop guide</h1>
      <p className="page-sub">
        How to run a job card, read the service schedule, find a part{isAdmin ? ' and order from Hero' : ''}.
        Tick a step once you have done it — the platform remembers where you got to.
      </p>

      <div className="card mb-3">
        <div className="flex-between" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: '1 1 260px' }}>
            <div className="text-sm" style={{ fontWeight: 600 }}>
              {doneCount} of {allSteps.length} steps done
              {pct === 100 && <span style={{ color: 'var(--success)' }}> · you have been through all of it</span>}
            </div>
            <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, marginTop: 6, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? 'var(--success)' : 'var(--primary)', transition: 'width .2s' }} />
            </div>
          </div>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search the guide…" style={{ flex: '0 1 240px' }} />
        </div>
      </div>

      {visible.map((section) => {
        const Icon = section.icon;
        const isOpen = open === section.id || !!filter.trim();
        const sectionSteps = (section.steps || []).map(([key]) => `${section.id}.${key}`);
        const sectionDone = sectionSteps.filter((k) => done.has(k)).length;

        return (
          <div key={section.id} className="card mb-2" style={{ padding: 0, overflow: 'hidden' }}>
            <button
              onClick={() => setOpen(isOpen && !filter.trim() ? null : section.id)}
              aria-expanded={isOpen}
              style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: 'inherit',
                padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }}>
              <Icon size={18} style={{ color: 'var(--primary)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600, display: 'block' }}>
                  {section.title}
                  {section.forRole === 'admin' && <span className="badge badge-info" style={{ marginLeft: 8, fontSize: 9 }}>ADMIN</span>}
                </span>
                <span className="text-sm muted">{section.summary}</span>
              </span>
              {sectionSteps.length > 0 && (
                <span className="text-xs muted" style={{ whiteSpace: 'nowrap' }}>{sectionDone}/{sectionSteps.length}</span>
              )}
              <ChevronRight size={16} style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s', flexShrink: 0 }} />
            </button>

            {isOpen && (
              <div style={{ padding: '0 16px 16px' }}>
                {(section.steps || []).map(([key, title, detail], index) => {
                  const stepKey = `${section.id}.${key}`;
                  const isDone = done.has(stepKey);
                  return (
                    <div key={stepKey} style={{ display: 'flex', gap: 10, padding: '7px 0', borderTop: index ? '1px solid var(--border)' : 'none' }}>
                      <button onClick={() => toggle(stepKey)} aria-pressed={isDone}
                        aria-label={isDone ? `Mark "${title}" not done` : `Mark "${title}" done`}
                        style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: isDone ? 'var(--success)' : 'var(--muted)', flexShrink: 0, marginTop: 2 }}>
                        {isDone ? <CheckCircle2 size={17} /> : <Circle size={17} />}
                      </button>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, textDecoration: isDone ? 'line-through' : 'none', opacity: isDone ? 0.6 : 1 }}>{title}</div>
                        {detail && <div className="text-sm muted">{detail}</div>}
                      </div>
                    </div>
                  );
                })}

                {section.trouble && (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="table">
                      <thead><tr><th>What you see</th><th>What it means</th><th>What to do</th></tr></thead>
                      <tbody>
                        {section.trouble.map(([seen, means, fix]) => (
                          <tr key={seen}><td>{seen}</td><td className="text-sm muted">{means}</td><td className="text-sm">{fix}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {section.interactive === 'parts' && <div className="mt-2"><TryPartsSearch /></div>}
                {section.interactive === 'schedule' && <div className="mt-2"><TrySchedule /></div>}

                {section.links && (
                  <div className="row mt-3" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {section.links.map((link) => (
                      <Link key={link.label} className="btn btn-sm btn-secondary" to={isAdmin ? link.adminTo : link.to}>
                        {link.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {!visible.length && <p className="text-sm muted">Nothing in the guide matches “{filter.trim()}”.</p>}

      {/* Reference tables — short enough to leave open */}
      <div className="grid grid-2 mt-3" style={{ gap: 16 }}>
        <div className="card">
          <h3 style={{ marginTop: 0, fontSize: 15 }}>What the chart's letters mean</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px' }}>
            {ACTION_CODES.map(([code, label]) => (
              <div key={code} className="text-sm"><strong style={{ fontFamily: 'monospace' }}>{code}</strong> — {label}</div>
            ))}
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0, fontSize: 15 }}>Intervals worth knowing</h3>
          {INTERVALS.map(([item, rule]) => (
            <div key={item} className="text-sm" style={{ marginBottom: 4 }}>
              <strong>{item}</strong> — <span className="muted">{rule}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card mt-3">
        <h3 style={{ marginTop: 0, fontSize: 15 }}>Who to contact</h3>
        <div className="text-sm">Parts orders and quotations — <strong>parts@heromotorcycles.co.za</strong></div>
        <div className="text-sm">OnFleet office, weekdays 08:00–17:00 — <strong>010 141 1165</strong></div>
        <div className="text-sm">After hours, weekends and public holidays — <strong>081 539 5612</strong></div>
      </div>

      {isAdmin && team && (
        <div className="card mt-3">
          <h3 style={{ marginTop: 0, fontSize: 15 }}><Users size={14} /> Who has been through the guide</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead><tr><th>Name</th><th>Role</th><th style={{ textAlign: 'right' }}>Steps done</th><th>Last opened</th></tr></thead>
              <tbody>
                {team.map((person) => (
                  <tr key={person.id}>
                    <td>{person.full_name}</td>
                    <td className="text-sm muted">{person.role}</td>
                    <td style={{ textAlign: 'right' }}>{person.steps_done}</td>
                    <td className="text-sm muted">{person.last_activity ? new Date(person.last_activity).toLocaleDateString('en-ZA') : 'Not started'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs muted" style={{ marginBottom: 0 }}>
            <AlertTriangle size={11} /> Steps are ticked by the person themselves — useful for bringing someone on, not a test.
          </p>
        </div>
      )}

      <p className="text-xs muted mt-3">
        <BookOpen size={11} /> Something here out of date, or a rule of the shop missing? Tell an admin and it can be changed for everyone.
      </p>
    </div>
  );
}
