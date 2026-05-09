import { useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { SearchInput, matchesSearch } from '../../components/ui';

function ResultCard({ title, result }) {
  if (!result) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 className="mb-2">{title}</h3>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5 }}>{JSON.stringify(result, null, 2)}</pre>
    </div>
  );
}

function UploadCard({ title, sub, endpoint, fieldName = 'file', files, setFiles, resultKey, setResults }) {
  const [busy, setBusy] = useState(false);
  const selected = files?.[fieldName] || null;

  const upload = async () => {
    if (!selected) return toast.error('Choose a CSV file first');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append(fieldName, selected);
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
        <input type="file" accept=".csv,text/csv" onChange={(e) => setFiles((prev) => ({ ...prev, [fieldName]: e.target.files?.[0] || null }))} />
      </div>
      {selected && <div className="muted text-sm mb-3">Selected: {selected.name}</div>}
      <button className="btn" onClick={upload} disabled={busy}>{busy ? 'Uploading…' : 'Import CSV'}</button>
    </div>
  );
}

export default function AdminImports() {
  const [singleFiles, setSingleFiles] = useState({});
  const [bundleFiles, setBundleFiles] = useState({ riders_file: null, bikes_file: null, payments_file: null });
  const [results, setResults] = useState({});
  const [bundleBusy, setBundleBusy] = useState(false);
  const [search, setSearch] = useState('');

  const uploadBundle = async () => {
    if (!bundleFiles.riders_file && !bundleFiles.bikes_file && !bundleFiles.payments_file) {
      return toast.error('Choose at least one CSV file first');
    }
    setBundleBusy(true);
    try {
      const fd = new FormData();
      if (bundleFiles.riders_file) fd.append('riders_file', bundleFiles.riders_file);
      if (bundleFiles.bikes_file) fd.append('bikes_file', bundleFiles.bikes_file);
      if (bundleFiles.payments_file) fd.append('payments_file', bundleFiles.payments_file);
      const { data } = await api.post('/imports/legacy-bundle', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResults((prev) => ({ ...prev, legacy_bundle: data }));
      toast.success('Legacy bundle import completed');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Bundle import failed');
    } finally {
      setBundleBusy(false);
    }
  };

  const cardMatches = {
    bundle: matchesSearch(search, 'Legacy bundle import', 'Drivers Fleet Collections', 'bundle', 'riders bikes payments'),
    riders: matchesSearch(search, 'Import riders', 'drivers export create update rider profiles selfie country origin linked KYC documents', results.riders && JSON.stringify(results.riders)),
    bikes: matchesSearch(search, 'Import bikes', 'fleet export create update bikes registration VIN', results.bikes && JSON.stringify(results.bikes)),
    agreements: matchesSearch(search, 'Import agreements', 'fleet export create agreements imported bike rider name', results.agreements && JSON.stringify(results.agreements)),
    payments: matchesSearch(search, 'Import payments', 'collections export resolves agreement bike registration VIN', results.payments && JSON.stringify(results.payments))
  };

  const visibleCards = Object.values(cardMatches).filter(Boolean).length;

  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">CSV Imports</h1>
          <p className="page-sub">Import rider profiles, bikes, agreements, and payments. The legacy bundle links the uploaded riders, fleet, and collections exports together automatically.</p>
        </div>
      </div>

      <div className="row mb-4" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search import type, result, or CSV workflow" style={{ flex: '1 1 320px', maxWidth: 460 }} />
        <div className="muted text-sm">Showing {visibleCards} import sections</div>
      </div>

      {cardMatches.bundle && (
        <div className="card mb-4">
          <h3 className="mb-1">Legacy bundle import</h3>
          <p className="page-sub" style={{ marginBottom: 16 }}>Recommended for your current exports: Drivers → Fleet → Collections. This creates rider profiles, adds country/selfie data, imports bikes, builds agreements from the fleet export, and applies imported collections to the matching agreement.</p>
          <div className="grid grid-3">
            <div className="field">
              <label className="label">Drivers CSV</label>
              <input type="file" accept=".csv,text/csv" onChange={(e) => setBundleFiles((prev) => ({ ...prev, riders_file: e.target.files?.[0] || null }))} />
            </div>
            <div className="field">
              <label className="label">Fleet CSV</label>
              <input type="file" accept=".csv,text/csv" onChange={(e) => setBundleFiles((prev) => ({ ...prev, bikes_file: e.target.files?.[0] || null }))} />
            </div>
            <div className="field">
              <label className="label">Collections CSV</label>
              <input type="file" accept=".csv,text/csv" onChange={(e) => setBundleFiles((prev) => ({ ...prev, payments_file: e.target.files?.[0] || null }))} />
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={uploadBundle} disabled={bundleBusy}>{bundleBusy ? 'Importing…' : 'Run bundle import'}</button>
          </div>
        </div>
      )}

      <div className="grid grid-2">
        {cardMatches.riders && <UploadCard title="Import riders" sub="Use the drivers export to create or update rider profiles, selfie, country of origin, and linked KYC documents." endpoint="/imports/riders" files={singleFiles} setFiles={setSingleFiles} resultKey="riders" setResults={setResults} />}
        {cardMatches.bikes && <UploadCard title="Import bikes" sub="Use the fleet export to create or update bikes. Matching happens with registration and VIN." endpoint="/imports/bikes" files={singleFiles} setFiles={setSingleFiles} resultKey="bikes" setResults={setResults} />}
        {cardMatches.agreements && <UploadCard title="Import agreements" sub="Use the fleet export to create agreements by matching the imported bike to the rider name." endpoint="/imports/agreements" files={singleFiles} setFiles={setSingleFiles} resultKey="agreements" setResults={setResults} />}
        {cardMatches.payments && <UploadCard title="Import payments" sub="Use the collections export. The importer now resolves by agreement first and falls back to the bike registration or VIN." endpoint="/imports/payments" files={singleFiles} setFiles={setSingleFiles} resultKey="payments" setResults={setResults} />}
      </div>

      {cardMatches.bundle && <ResultCard title="Latest bundle result" result={results.legacy_bundle} />}
      {cardMatches.riders && <ResultCard title="Riders import result" result={results.riders} />}
      {cardMatches.bikes && <ResultCard title="Bikes import result" result={results.bikes} />}
      {cardMatches.agreements && <ResultCard title="Agreements import result" result={results.agreements} />}
      {cardMatches.payments && <ResultCard title="Payments import result" result={results.payments} />}
      {!visibleCards && <div className="card muted" style={{ textAlign: 'center' }}>No import sections match your search.</div>}
    </>
  );
}
