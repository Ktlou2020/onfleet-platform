import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api';
import { resizeImage } from '../lib/resizeImage';

// Photographs on a theft case, shared by the operator console and the fleet
// portal so the two cannot drift into showing the same evidence differently.
//
// Two things here are not like the rest of the app's images.
//
// These are fetched as blobs rather than put in an <img src>. Every other
// photograph in the platform is served by /uploads, which has no authorization
// check — so a plain src works there. These are deliberately behind a scoped,
// authenticated endpoint (see services/theftCasePhotos.js), and the browser
// will not attach a bearer token to an <img>. So each one is requested through
// the same api client as everything else and handed to the page as an object
// URL, which is revoked when it goes away.
//
// And they are resized larger than parts photographs are. A part on a bench
// needs to be recognisable; a recovered bike may need its plate or its VIN
// plate legible to an insurer or a court, and 1000px on the long edge is not
// enough for that.
const EVIDENCE_MAX_EDGE = 1600;
const EVIDENCE_QUALITY = 0.85;

const STAGE_LABEL = { sighting: 'Sighting', outcome: 'Outcome' };

/** One photograph, fetched with the caller's token and shown as a thumbnail. */
function CasePhoto({ photo, size = 72, onOpen }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url = null;
    let live = true;
    api.get(photo.url, { responseType: 'blob' })
      .then((r) => {
        if (!live) return;
        url = URL.createObjectURL(r.data);
        setSrc(url);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [photo.url]);

  const box = {
    width: size, height: size, flexShrink: 0, borderRadius: 8, overflow: 'hidden',
    border: '1px solid var(--border)', background: 'var(--surface-2)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
    cursor: src ? 'zoom-in' : 'default',
  };

  if (failed) {
    return <div style={{ ...box, cursor: 'default' }} title="This photograph could not be loaded">
      <X size={16} style={{ opacity: 0.5 }} />
    </div>;
  }
  if (!src) {
    return <div style={{ ...box, cursor: 'default' }}>
      <Loader2 size={16} className="spin" style={{ opacity: 0.5 }} />
    </div>;
  }
  return (
    <button type="button" style={box} onClick={() => onOpen?.(src)} title={photo.caption || 'Open'}>
      <img src={src} alt={photo.caption || 'Case photograph'}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    </button>
  );
}

/**
 * The gallery on a case, oldest first — the order it happened in.
 *
 * Shows the stage, because "a bike seen in a yard on Tuesday" and "the bike as
 * it came back" are different claims and the difference is the whole reason
 * the column exists.
 */
export function CasePhotoStrip({ photos = [], canDelete = false, onDeleted }) {
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);

  if (!photos.length) return null;

  const remove = async (photo) => {
    setBusy(photo.id);
    try {
      await api.delete(photo.url.replace(/\/image$/, ''));
      toast.success('Photograph removed');
      onDeleted?.(photo);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not remove that photograph');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {photos.map((p) => (
          <div key={p.id} style={{ width: 72 }}>
            <CasePhoto photo={p} onOpen={setOpen} />
            <div className="text-xs muted" style={{ marginTop: 3, lineHeight: 1.3 }}>
              {STAGE_LABEL[p.stage] || p.stage}
            </div>
            {p.caption && <div className="text-xs" style={{ lineHeight: 1.3 }}>{p.caption}</div>}
            {canDelete && (
              <button className="btn btn-sm btn-secondary" style={{ padding: '1px 5px', marginTop: 3 }}
                disabled={busy === p.id} onClick={() => remove(p)} title="Remove this photograph">
                <Trash2 size={11} />
              </button>
            )}
          </div>
        ))}
      </div>

      {open && (
        <div onClick={() => setOpen(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
          }}>
          <img src={open} alt="Case photograph" style={{ maxWidth: '94vw', maxHeight: '94vh' }} />
        </div>
      )}
    </>
  );
}

/**
 * Pick photographs to attach. Holds files locally and uploads nothing yet:
 * the close flow uploads them only once the person has confirmed, so a
 * cancelled close leaves nothing behind.
 *
 * capture="environment" asks a phone for its back camera directly. Whoever is
 * closing this case may be standing next to the bike.
 */
export function CasePhotoPicker({ files, onChange, max = 12, label = 'Photographs' }) {
  const inputRef = useRef(null);
  const [preparing, setPreparing] = useState(false);

  const add = async (picked) => {
    const chosen = Array.from(picked || []);
    if (!chosen.length) return;
    const room = max - files.length;
    if (room <= 0) { toast.error(`That is already ${max} photographs`); return; }
    const taking = chosen.slice(0, room);
    if (taking.length < chosen.length) toast(`Only ${room} more will fit`);

    setPreparing(true);
    try {
      // Shrunk here, so the bytes never leave the phone. Bigger than a part
      // photograph, because a plate may need to be readable.
      const resized = await Promise.all(taking.map((f) =>
        resizeImage(f, { maxEdge: EVIDENCE_MAX_EDGE, quality: EVIDENCE_QUALITY })));
      onChange([...files, ...resized]);
    } finally {
      setPreparing(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div>
      <label className="label" style={{ fontSize: 12 }}>{label} <span className="muted">(optional)</span></label>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" multiple
        style={{ display: 'none' }} onChange={(e) => add(e.target.files)} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-sm btn-secondary" disabled={preparing}
          onClick={() => inputRef.current?.click()}>
          {preparing ? <Loader2 size={13} className="spin" /> : <Camera size={13} />}
          {preparing ? ' Preparing…' : ' Add photographs'}
        </button>
        {files.map((f, i) => (
          <span key={`${f.name}-${i}`} className="text-xs"
            style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '2px 6px' }}>
            {f.name || `photo ${i + 1}`}
            <button type="button" className="btn btn-sm" style={{ padding: '0 3px', marginLeft: 4 }}
              onClick={() => onChange(files.filter((_, j) => j !== i))} title="Remove">
              <X size={10} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Upload the picked photographs, then say what happened.
 *
 * Sequential on purpose: twelve parallel multipart uploads on a phone at the
 * roadside is how you get three of them. The caller decides what to do with a
 * partial result — the close flows refuse to close on one, because a case
 * closed without the evidence somebody just photographed is harder to notice
 * than one still open.
 */
export async function uploadCasePhotos({ base, caseId, files, stage = 'outcome' }) {
  const uploaded = [];
  const failed = [];
  for (const file of files) {
    try {
      const form = new FormData();
      form.append('photo', file, file.name || 'photo.jpg');
      form.append('stage', stage);
      const { data } = await api.post(`${base}/${caseId}/photos`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      uploaded.push(data.photo);
    } catch (e) {
      failed.push({ file, error: e.response?.data?.error || 'upload failed' });
    }
  }
  return { uploaded, failed };
}
