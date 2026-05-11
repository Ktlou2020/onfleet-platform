import { useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { SearchInput, matchesSearch } from '../../components/ui';

const SPECIAL_AUDIENCE_TAG = 'password-reset-batch-2026-05';

function ResultCard({ title, result }) {
  if (!result) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 className="mb-2">{title}</h3>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5 }}>{JSON.stringify(result, null, 2)}</pre>
    </div>
  );
}

function MappingPreview({ preview, mapping, setMapping }) {
  if (!preview) return null;
  return (
    <div className="card mt-3" style={{ background: 'var(--surface-2)' }}>
      <div className="flex-between" style={{ gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 700 }}>Column verification</div>
          <div className="muted text-sm">Review how the uploaded CSV columns map into OnFleet before importing.</div>
        </div>
        <div className="badge badge-muted">{preview.total_rows} rows</div>
      </div>

      <div className="grid grid-2">
        {preview.expected_fields.map((field) => (
          <div className="field" key={field.key}>
            <label className="label">{field.label}{field.required ? ' *' : ''}</label>
            <select value={mapping[field.key] || ''} onChange={(e) => setMapping((current) => ({ ...current, [field.key]: e.target.value }))}>
              <option value="">— Not mapped —</option>
              {preview.headers.map((header) => <option key={header} value={header}>{header}</option>)}
            </select>
          </div>
        ))}
      </div>

      {!!preview.warnings?.missing_required?.length && (
        <div className="text-sm" style={{ color: 'var(--danger)', marginTop: 8 }}>
          Required fields still missing: {preview.warnings.missing_required.join(', ')}
        </div>
      )}

      <div className="muted text-sm" style={{ marginTop: 14, marginBottom: 8 }}>Sample rows</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              {preview.expected_fields.slice(0, 6).map((field) => <th key={field.key}>{field.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {preview.sample_rows.slice(0, 4).map((row, index) => (
              <tr key={index}>
                {preview.expected_fields.slice(0, 6).map((field) => <td key={field.key}>{mapping[field.key] ? row[mapping[field.key]] || '—' : '—'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UploadCard({ title, sub, endpoint, importType, resultKey, results, setResults }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);

  const missingRequired = preview?.expected_fields?.filter((field) => field.required && !mapping[field.key]) || [];
  const duplicateCount = Object.values(mapping).filter(Boolean).length - new Set(Object.values(mapping).filter(Boolean)).size;

  const previewCsv = async () => {
    if (!file) return toast.error('Choose a CSV file first');
    setPreviewing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('import_type', importType);
      const { data } = await api.post('/imports/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setPreview(data);
      setMapping(data.suggested_mapping || {});
      toast.success(`${title} preview ready`);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not preview this CSV');
    } finally {
      setPreviewing(false);
    }
  };

  const upload = async () => {
    if (!file) return toast.error('Choose a CSV file first');
    if (!preview) return toast.error('Preview the CSV before importing');
    if (missingRequired.length) return toast.error(`Map the required fields first: ${missingRequired.map((field) => field.label).join(', ')}`);
    if (duplicateCount > 0) return toast.error('Each CSV column can only be mapped once');

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('import_type', importType);
      fd.append('mappings', JSON.stringify(mapping));
      const { data } = await api.post(endpoint, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResults((prev) => ({ ...prev, [resultKey]: data }));
      toast.success(`${title} import completed`);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3 className="mb-1">{title}</h3>
      <p className="page-sub" style={{ marginBottom: 16 }}>{sub}</p>
      <div className="field">
        <label className="label">CSV file</label>
        <input type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); setMapping({}); }} />
      </div>
      {file && <div className="muted text-sm mb-3">Selected: {file.name}</div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" onClick={previewCsv} disabled={previewing}>{previewing ? 'Previewing…' : 'Preview CSV'}</button>
        <button className="btn" onClick={upload} disabled={busy || !preview}>{busy ? 'Importing…' : 'Import CSV'}</button>
      </div>
      <MappingPreview preview={preview} mapping={mapping} setMapping={setMapping} />
      <ResultCard title={`${title} result`} result={results[resultKey]} />
    </div>
  );
}

export default function AdminImports() {
  const [results, setResults] = useState({});
  const [search, setSearch] = useState('');

  const cards = useMemo(() => ([
    {
      key: 'riders',
      title: 'Import riders',
      sub: 'Use the drivers export to create or update rider profiles, selfie, country of origin, and linked KYC documents.',
      endpoint: '/imports/riders',
      importType: 'riders'
    },
    {
      key: 'bikes',
      title: 'Import bikes',
      sub: 'Use the fleet export to create or update bikes. Matching happens with registration and VIN.',
      endpoint: '/imports/bikes',
      importType: 'bikes'
    },
    {
      key: 'agreements',
      title: 'Import agreements',
      sub: 'Use the fleet export to create agreements by matching the imported bike to the rider name.',
      endpoint: '/imports/agreements',
      importType: 'agreements'
    },
    {
      key: 'payments',
      title: 'Import payments',
      sub: 'Use the collections export. Match the columns before import so agreement number, amount, and dates land correctly.',
      endpoint: '/imports/payments',
      importType: 'payments'
    },
    {
      key: 'special_tag',
      title: 'Import special email tag',
      sub: `Upload a CSV with an email column. OnFleet will match existing users by email and add the special audience tag ${SPECIAL_AUDIENCE_TAG}.`,
      endpoint: '/imports/special-tag-users',
      importType: 'special_tag_users'
    }
  ]), []);

  const visibleCards = cards.filter((card) => matchesSearch(search, card.title, card.sub, results[card.key] && JSON.stringify(results[card.key])));

  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">CSV Imports</h1>
          <p className="page-sub">Upload a CSV, verify the column mapping, then confirm the import. This prevents bad imports caused by shifted or mislabeled columns.</p>
        </div>
      </div>

      <div className="row mb-4" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search import type, result, or CSV workflow" style={{ flex: '1 1 320px', maxWidth: 460 }} />
        <div className="muted text-sm">Showing {visibleCards.length} import sections</div>
      </div>

      <div className="card mb-4" style={{ background: 'var(--surface-2)' }}>
        <h3 className="mb-1">Legacy bundle workflow</h3>
        <p className="page-sub" style={{ marginBottom: 0 }}>
          To verify column mapping before import, upload the Drivers, Fleet, and Collections CSVs individually using the preview cards below instead of the old one-click bundle flow.
        </p>
      </div>

      <div className="grid grid-2">
        {visibleCards.map((card) => (
          <UploadCard
            key={card.key}
            title={card.title}
            sub={card.sub}
            endpoint={card.endpoint}
            importType={card.importType}
            resultKey={card.key}
            results={results}
            setResults={setResults}
          />
        ))}
      </div>

      {!visibleCards.length && <div className="card muted" style={{ textAlign: 'center' }}>No import sections match your search.</div>}
    </>
  );
}
