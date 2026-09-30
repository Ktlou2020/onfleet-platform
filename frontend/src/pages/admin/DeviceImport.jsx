import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { UploadCloud, FileText, AlertTriangle, CheckCircle2, Package, ArrowRight } from 'lucide-react';

// Loading a batch of trackers.
//
// Devices arrive from a supplier as a list — a spreadsheet column of IMEIs,
// sometimes with the registration of the bike each one is going on. The
// single-device form means opening it once per tracker, which on a fifty-unit
// order is fifty chances to fumble a fifteen-digit number.
//
// The shape of this screen is the shape of the risk. A half-loaded batch
// cannot be re-run and cannot be undone, so nothing is written until the
// whole list has been checked and somebody has looked at what the check
// found. Every line that will not load says why, on its own row, before
// anything happens.

const MODELS = ['FMB920', 'FMB965', 'FMC920', 'other'];

const EXAMPLE = `IMEI,Registration,Model
353201350123456,JHB123GP,FMB920
353201350123457,JHB124GP,FMB920
353201350123458,,FMB920`;

function Problems({ row }) {
  if (row.ok) {
    return row.bike_id ? (
      <span style={{ color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <CheckCircle2 size={13} /> onto {row.bike_registration}
        {row.organization_name ? <span className="muted"> · {row.organization_name}</span> : null}
      </span>
    ) : (
      <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <Package size={13} /> into stock
      </span>
    );
  }
  return (
    <span style={{ color: 'var(--danger)' }}>
      {row.problems.join(' · ')}
    </span>
  );
}

export default function DeviceImport() {
  const [text, setText] = useState('');
  const [checking, setChecking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);   // { rows, summary, header_skipped }
  const [skipProblems, setSkipProblems] = useState(false);
  const [done, setDone] = useState(null);         // { loaded, count, skipped }
  const fileInput = useRef(null);

  const lines = useMemo(() => text.split('\n').filter((l) => l.trim()).length, [text]);

  // A preview belongs to the text it was made from. Editing the list after
  // checking it and then pressing Load would load something nobody looked at.
  const setList = (next) => {
    setText(next);
    setPreview(null);
    setDone(null);
    setSkipProblems(false);
  };

  const readFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setList(String(reader.result || ''));
    reader.onerror = () => toast.error('Could not read that file');
    reader.readAsText(file);
  };

  const check = async () => {
    if (!text.trim()) return toast.error('Paste the list first');
    setChecking(true);
    try {
      const { data } = await api.post('/tracking/devices/import/preview', { text });
      setPreview(data);
      setDone(null);
      if (!data.rows.length) toast.error('Nothing in that list looks like a tracker');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not check that list');
    } finally {
      setChecking(false);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.post('/tracking/devices/import', {
        text, skip_problem_rows: skipProblems,
      });
      setDone(data);
      setPreview(null);
      setText('');
      toast.success(`${data.count} tracker${data.count === 1 ? '' : 's'} loaded`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load that batch');
    } finally {
      setLoading(false);
    }
  };

  const summary = preview?.summary;
  const blocked = !!summary?.problems && !skipProblems;
  // The number on the button is the number that would actually be written. A
  // list with five bad lines in it used to offer to load all seven, which is
  // the one place on this screen where a wrong number would be believed.
  const willLoad = summary ? (skipProblems ? summary.ok : summary.total) : 0;
  const loadLabel = blocked
    ? `${summary.problems} line${summary.problems === 1 ? '' : 's'} to fix first`
    : `Load ${willLoad} tracker${willLoad === 1 ? '' : 's'}`;

  return (
    <>
      <h1 className="page-title">Load trackers</h1>
      <p className="page-sub">
        A supplier's list, checked line by line before anything is written. Nothing loads
        until you have seen what the check found.
      </p>

      {done && (
        <div className="card" style={{ borderColor: 'rgba(34,197,94,0.4)', marginTop: 16 }}>
          <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div>
              <strong style={{ color: 'var(--success)' }}>
                {done.count} tracker{done.count === 1 ? '' : 's'} loaded
                {done.skipped ? `, ${done.skipped} line${done.skipped === 1 ? '' : 's'} skipped` : ''}
              </strong>
              <div className="text-sm muted" style={{ marginTop: 4 }}>
                {done.loaded.slice(0, 6).map((d) => d.imei).join(', ')}
                {done.loaded.length > 6 ? ` and ${done.loaded.length - 6} more` : ''}
              </div>
            </div>
            <Link className="btn btn-sm" to="/admin/tracking">Devices &amp; map <ArrowRight size={14} /></Link>
          </div>
        </div>
      )}

      <div className="grid grid-2" style={{ gap: 16, marginTop: 16, alignItems: 'start' }}>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>The list</h2>
          <p className="muted text-sm" style={{ marginTop: 0 }}>
            One tracker a line: <strong>IMEI, registration, model</strong>. Commas, tabs or
            semicolons. A header line is skipped if it has no digits in it.
          </p>
          <ul className="text-sm muted" style={{ margin: '0 0 12px 18px' }}>
            <li>Leave the registration out and the tracker goes into stock.</li>
            <li>Model is one of {MODELS.join(', ')} — blank counts as other.</li>
          </ul>

          <textarea
            rows={12}
            value={text}
            onChange={(e) => setList(e.target.value)}
            placeholder={EXAMPLE}
            spellCheck={false}
            style={{ width: '100%', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 }}
          />

          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn" disabled={checking || !text.trim()} onClick={check}>
              <FileText size={15} /> {checking ? 'Checking…' : 'Check the list'}
            </button>
            <button className="btn btn-secondary" onClick={() => fileInput.current?.click()}>
              <UploadCloud size={15} /> Open a file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              style={{ display: 'none' }}
              onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }}
            />
            {lines > 0 && <span className="text-sm muted">{lines} line{lines === 1 ? '' : 's'}</span>}
          </div>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>What the check looks for</h2>
          <ul className="text-sm muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>An IMEI that is ten to twenty digits.</li>
            <li>An IMEI that is not already registered here.</li>
            <li>The same IMEI twice in one list.</li>
            <li>A registration that matches exactly one bike.</li>
            <li>A bike that does not already have a tracker on it.</li>
          </ul>
          <p className="text-sm muted" style={{ marginTop: 14, marginBottom: 0 }}>
            A batch with a problem in it loads nothing at all, unless you tick the box to
            skip those lines. That is deliberate: half a batch cannot be re-run and cannot
            be undone.
          </p>
        </div>
      </div>

      {preview && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
            <div>
              <h2 style={{ margin: 0 }}>{summary.total} line{summary.total === 1 ? '' : 's'} checked</h2>
              <div className="text-sm" style={{ marginTop: 4 }}>
                <span style={{ color: 'var(--success)' }}>{summary.ok} ready</span>
                {summary.to_stock ? <span className="muted"> · {summary.to_stock} into stock</span> : null}
                {summary.problems ? (
                  <span style={{ color: 'var(--danger)' }}> · {summary.problems} with problems</span>
                ) : null}
              </div>
            </div>
            <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {!!summary.problems && (
                <label className="row text-sm" style={{ gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={skipProblems}
                         onChange={(e) => setSkipProblems(e.target.checked)} />
                  Skip the {summary.problems} problem line{summary.problems === 1 ? '' : 's'}
                </label>
              )}
              <button className="btn" disabled={loading || blocked || !summary.ok} onClick={load}>
                {loading ? 'Loading…' : loadLabel}
              </button>
            </div>
          </div>

          {preview.header_skipped && (
            <p className="text-sm muted" style={{ marginTop: 0 }}>
              First line treated as a header and skipped: <code>{preview.header_skipped}</code>
            </p>
          )}

          {blocked && (
            <p className="text-sm" style={{ color: 'var(--warn)' }}>
              <AlertTriangle size={13} style={{ verticalAlign: -2 }} />{' '}
              Fix the lines below, or tick the box to load the rest without them.
            </p>
          )}

          <div className="table-wrap">
            <table className="table" style={{ width: '100%' }}>
              <thead><tr><th>Line</th><th>IMEI</th><th>Model</th><th>Goes</th></tr></thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={`${row.line}-${row.imei}`}
                      style={row.ok ? undefined : { background: 'rgba(239,68,68,0.06)' }}>
                    <td className="text-xs muted">{row.line}</td>
                    <td style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{row.imei}</td>
                    <td>{row.model}</td>
                    <td className="text-sm"><Problems row={row} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
