import { useRef, useState } from 'react';
import { Camera, Loader2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api';
import { resizeImage } from '../lib/resizeImage';

// What a part looks like, and the way that gets filled in.
//
// A technician does not know the part number — it is not written on the part.
// So the row shows a photograph, and where there is no photograph yet the same
// square is the camera button that takes one. The catalogue fills itself in
// the order parts actually get used, which means the parts that matter are
// covered first and the long tail never needs doing at all.
//
// `capture="environment"` asks a phone for the back camera directly, so it is
// one tap from the row to the shutter rather than a trip through the gallery.

const SIZE = 56;

export default function PartPhoto({ photos = [], partNumber, make, model, onAdded, size = SIZE }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const photo = photos[0] || null;

  const upload = async (file) => {
    if (!file) return;
    if (!partNumber || !make || !model) {
      toast.error('This part has no number on it yet, so a photo has nowhere to file');
      return;
    }
    setBusy(true);
    try {
      // Shrunk on the phone: the bytes never leave it, which is what makes
      // this usable on workshop signal.
      const resized = await resizeImage(file);
      const form = new FormData();
      form.append('photo', resized);
      form.append('part_number', partNumber);
      form.append('make', make);
      form.append('model', model);
      const { data } = await api.post('/workshop/part-photos', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Photo saved — every technician sees it now');
      onAdded?.(data.photo);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not save that photo');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const box = {
    width: size, height: size, flexShrink: 0,
    borderRadius: 8, overflow: 'hidden',
    border: '1px solid var(--border)', background: 'var(--surface-2)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', padding: 0,
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => upload(e.target.files?.[0])}
      />

      <button
        type="button"
        style={box}
        disabled={busy}
        title={photo ? 'Tap to see it bigger' : 'No photo yet — tap to take one'}
        onClick={(e) => {
          e.stopPropagation();
          if (photo) setZoomed(true);
          else inputRef.current?.click();
        }}
      >
        {busy ? (
          <Loader2 size={18} className="spin" style={{ color: 'var(--muted)' }} />
        ) : photo ? (
          <img
            src={photo.url}
            alt={partNumber}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Camera size={18} style={{ color: 'var(--muted)' }} />
        )}
      </button>

      {zoomed && photo && (
        <div
          className="modal-overlay"
          onClick={() => setZoomed(false)}
          style={{ cursor: 'zoom-out' }}
        >
          <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="flex-between" style={{ gap: 12, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{partNumber}</div>
                {photo.taken_by && (
                  <div className="text-xs muted">Photographed by {photo.taken_by}</div>
                )}
              </div>
              <button className="icon-btn" onClick={() => setZoomed(false)} title="Close">
                <X size={18} />
              </button>
            </div>
            <img
              src={photo.url}
              alt={partNumber}
              style={{ width: '100%', marginTop: 12, borderRadius: 8, display: 'block' }}
            />
            <button
              className="btn btn-secondary mt-2"
              style={{ width: '100%' }}
              onClick={() => { setZoomed(false); inputRef.current?.click(); }}
            >
              <Camera size={14} /> Take a better one
            </button>
          </div>
        </div>
      )}
    </>
  );
}
