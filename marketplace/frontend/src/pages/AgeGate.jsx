import { BRAND } from '../lib.jsx';

// The first, light-touch gate. The real check is the SA ID verification at
// checkout and the ID check at the door.
export default function AgeGate({ onConfirm }) {
  const yes = () => {
    try { localStorage.setItem('cloud9.adult', 'yes'); } catch { /* private mode */ }
    onConfirm();
  };
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="logo big"><span className="logo-mark">☁</span> {BRAND.name}</div>
        <h1>Are you 18 or older?</h1>
        <p className="muted">You must be an adult to browse. We check your SA ID before your first order, and our riders check it again at the door.</p>
        <div className="gate-actions">
          <button className="btn btn-lg" onClick={yes}>Yes, I'm 18+</button>
          <a className="btn btn-ghost btn-lg" href="https://www.google.com">No, take me back</a>
        </div>
      </div>
    </div>
  );
}
