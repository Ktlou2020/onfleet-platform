import { useCallback, useEffect, useState } from 'react';
import { BRAND, api, useAuth, useToast } from './lib.jsx';

// Installing ClickNPuff to the home screen, and push notifications.

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && typeof document !== 'undefined' && 'ontouchend' in document);
export const isStandalone = () => safe(() => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true, false);
export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

// ---- Install -----------------------------------------------------------------
// Android/desktop Chrome hand us a prompt to show when we choose; iPhone
// needs the person to use Share → Add to Home Screen themselves.
let deferredPrompt = null;
const installListeners = new Set();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installListeners.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; installListeners.forEach((fn) => fn()); });
}

export function useInstall() {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    installListeners.add(fn);
    return () => installListeners.delete(fn);
  }, []);
  const installed = isStandalone();
  return {
    installed,
    canPrompt: !!deferredPrompt && !installed,
    iosManual: isIOS && !installed,
    prompt: async () => {
      if (!deferredPrompt) return false;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      tick((n) => n + 1);
      return outcome === 'accepted';
    },
  };
}

function base64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// ---- Push ------------------------------------------------------------------
export function usePush() {
  const { user } = useAuth();
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState(() => safe(() => Notification.permission, 'default'));
  const supported = pushSupported();
  // iPhone only allows push for an app added to the home screen.
  const needsInstall = isIOS && !isStandalone();

  const refresh = useCallback(async () => {
    if (!supported) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    setSubscribed(!!sub);
    setPermission(safe(() => Notification.permission, 'default'));
  }, [supported]);
  useEffect(() => { refresh(); }, [refresh, user?.id]);

  const enable = useCallback(async () => {
    if (!supported || needsInstall) return { ok: false, reason: needsInstall ? 'install' : 'unsupported' };
    const p = await Notification.requestPermission();
    setPermission(p);
    if (p !== 'granted') return { ok: false, reason: 'denied' };
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/push/key');
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) }));
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    setSubscribed(true);
    return { ok: true };
  }, [supported, needsInstall]);

  const disable = useCallback(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    setSubscribed(false);
  }, []);

  return { supported, needsInstall, permission, subscribed, enable, disable, test: () => api('/push/test', { method: 'POST' }) };
}

// Keeps this phone's push subscription with whoever is signed in, and drops
// it on sign-out so the next person doesn't get someone else's alerts.
export function PushSync() {
  const { user, ready } = useAuth();
  useEffect(() => {
    if (!ready || !pushSupported()) return;
    (async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (!sub) return;
      if (user) await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } }).catch(() => {});
      else await sub.unsubscribe().catch(() => {});
    })();
  }, [user?.id, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// A one-tap "turn on notifications" control, worded for who's using it.
export function PushButton({ why, className = '', compact = false }) {
  const push = usePush();
  const notify = useToast();
  const install = useInstall();
  const [busy, setBusy] = useState(false);
  if (!push.supported && !push.needsInstall) return null;
  if (push.subscribed) {
    return compact ? <span className={`push-on ${className}`}>🔔 Notifications on</span> : (
      <div className={`push-box on ${className}`}>
        <span>🔔 Notifications are on{why ? ` — ${why}` : ''}.</span>
        <button className="link" onClick={() => push.test().then((r) => notify(r.sent ? 'Test sent — check your notifications' : "Couldn't reach this phone — try turning them off and on", r.sent ? 'ok' : 'bad'))}>Send a test</button>
        <button className="link" onClick={() => push.disable().then(() => notify('Notifications off'))}>Turn off</button>
      </div>
    );
  }
  if (push.needsInstall) {
    return (
      <div className={`push-box ${className}`}>
        <span>🔔 To get notifications on iPhone, add {BRAND.name} to your home screen first: tap <b>Share</b> <span aria-hidden="true">⎋</span>, then <b>Add to Home Screen</b>, and open it from there.</span>
      </div>
    );
  }
  if (push.permission === 'denied') {
    const how = `Notifications are blocked for ${BRAND.name}. Turn them on in your browser or phone settings${install.installed ? ' for the app' : ''}.`;
    if (compact) return <span className={`push-blocked small muted ${className}`} title={how}>🔕 Notifications blocked</span>;
    return <div className={`push-box ${className}`}><span>🔕 Notifications are blocked for {BRAND.name}. Turn them on in your browser or phone settings{install.installed ? ' for the app' : ''}.</span></div>;
  }
  return (
    <button className={`btn ${compact ? 'btn-sm btn-ghost' : 'full'} push-btn ${className}`} disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const r = await push.enable();
        notify(r.ok ? "Notifications on — we'll let you know" : r.reason === 'denied' ? 'Notifications were not allowed' : "This phone can't do notifications", r.ok ? 'ok' : 'bad');
      } catch (e) { notify(e.message, 'bad'); } finally { setBusy(false); }
    }}>🔔 {compact ? 'Notify me' : `Turn on notifications${why ? ` — ${why}` : ''}`}</button>
  );
}

// "Install the app" banner. Hidden once installed or dismissed.
const DISMISS_KEY = 'clicknpuff.installDismissed';
export function InstallBanner({ audience = 'customer' }) {
  const install = useInstall();
  const [hidden, setHidden] = useState(() => safe(() => Number(localStorage.getItem(DISMISS_KEY) || 0) > Date.now(), false));
  if (install.installed || hidden || (!install.canPrompt && !install.iosManual)) return null;
  const dismiss = () => {
    safe(() => localStorage.setItem(DISMISS_KEY, String(Date.now() + 7 * 864e5)));
    setHidden(true);
  };
  const pitch = audience === 'rider' ? 'Install the rider app for full-screen driving and trip alerts.' : 'Install the app — faster ordering and live updates on your order.';
  return (
    <div className={`install-banner ${audience}`} role="region" aria-label={`Install ${BRAND.name}`}>
      <img src="/icons/icon-192.png" alt="" width="40" height="40" />
      <div className="grow">
        <strong>{BRAND.name} app</strong>
        <p>{install.iosManual ? <>Tap <b>Share</b> ⎋ then <b>Add to Home Screen</b>.</> : pitch}</p>
      </div>
      {install.canPrompt && <button className="btn btn-sm" onClick={() => install.prompt()}>Install</button>}
      <button className="install-x" onClick={dismiss} aria-label="Not now">✕</button>
    </div>
  );
}

// A thin bar when the phone has no connection, so an empty screen isn't
// mistaken for "no stores" or a lost order.
export function OfflineBanner() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  if (online) return null;
  return <div className="offline-bar" role="status">📶 You're offline. We'll refresh as soon as you're back.</div>;
}
