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
// ── Live parts search, against the real catalogue ────────────────────────────

export function TryPartsSearch() {
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

export function TrySchedule() {
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

// The guide shell: sections that open, steps that tick off and remember who
// ticked them, a search across the whole thing, and slots where a section can
// put something live to try. Content comes from lib/*GuideContent.js.
export default function Guide({
  guide = 'workshop',
  sections: allSections,
  portal = 'workshop',
  title = 'Guide',
  intro = '',
  widgets = {},
  footer = null,
}) {
  const [done, setDone] = useState(() => new Set());
  const [open, setOpen] = useState('job-card');
  const [filter, setFilter] = useState('');
  const [team, setTeam] = useState(null);
  const isAdmin = portal === 'admin';

  const sections = useMemo(
    () => allSections.filter((s) => (isAdmin || s.forRole !== 'admin')),
    [allSections, isAdmin],
  );
  const allSteps = useMemo(
    () => sections.flatMap((s) => (s.steps || []).map(([key]) => `${s.id}.${key}`)),
    [sections],
  );

  useEffect(() => {
    api.get('/guide/progress', { params: { guide } }).then(({ data }) => setDone(new Set(data.done))).catch(() => {});
    if (isAdmin) api.get('/guide/progress/team', { params: { guide } }).then(({ data }) => setTeam(data)).catch(() => {});
  }, [isAdmin, guide]);

  const toggle = async (stepKey) => {
    const next = new Set(done);
    const nowDone = !next.has(stepKey);
    if (nowDone) next.add(stepKey); else next.delete(stepKey);
    setDone(next);
    try {
      await api.put('/guide/progress', { guide, step_key: stepKey, done: nowDone });
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
      <h1 className="page-title">{title}</h1>
      <p className="page-sub">{intro} Tick a step once you have done it — the platform remembers where you got to.</p>

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

                {section.interactive && widgets[section.interactive] && (
                  <div className="mt-2">{widgets[section.interactive]}</div>
                )}

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

      {footer}

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
