import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Download, PlusSquare, Smartphone, Bell, BellOff, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../auth';
import { isMobileDevice } from '../deviceDetect';
import { enablePush, getPushSubscriptionState, isPushSupported } from '../pushSubscribe';
import { brandName } from '../brand';

const INSTALL_DISMISS_KEY = 'of_install_prompt_dismissed_at';
const INSTALLED_KEY = 'of_app_installed';
const PUSH_DISMISS_KEY = 'of_push_prompt_dismissed_at';
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Long enough that the page they asked for is on screen and read, short
// enough that the prompt still gets seen in a normal session.
const SETTLE_MS = 8000;

function isStandaloneMode() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIosSafari() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIOS && isSafari;
}

// Sequenced onboarding: install prompt first, notification prompt second.
// Not just ordering for its own sake — on iOS, push notifications only work
// inside an installed (standalone) PWA, so offering notifications before
// install is offered would be a dead end there. Once install is resolved
// (installed, dismissed, or not applicable/not supported), the notification
// step becomes eligible in the same session.
export default function MobileOnboardingPrompt() {
  const { user } = useAuth();
  const location = useLocation();
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushState, setPushState] = useState({ supported: false, subscribed: false, permission: 'default' });
  const [dismissTick, setDismissTick] = useState(0);
  // Whether the person has had a chance to do what they opened the app for.
  const [settled, setSettled] = useState(false);
  const [moved, setMoved] = useState(false);

  const mobile = useMemo(() => isMobileDevice(), []);
  const iosMode = useMemo(() => isIosSafari(), []);
  const standalone = useMemo(() => isStandaloneMode(), [location.pathname]);

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setDeferredPrompt(event);
    };
    const onInstalled = () => {
      localStorage.setItem(INSTALLED_KEY, '1');
      setDeferredPrompt(null);
      setDismissTick((t) => t + 1);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!user || !isPushSupported()) return;
    getPushSubscriptionState().then(setPushState).catch(() => {});
  }, [user, dismissTick]);

  // Do not interrupt the first thing somebody does.
  //
  // This is a full-screen sheet, and it used to appear the moment a mobile
  // user was authenticated — so a technician opening a job card at the bike
  // got "Add to your Home Screen" over the top of the job card. Asking is
  // fine; asking before they have reached what they came for is not.
  //
  // So it waits for both: a few seconds settled, and one deliberate
  // navigation. Together those mean the app is in use rather than loading.
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, []);

  // A ref rather than state: this is the path the session started on and must
  // never change, which is exactly what a ref says and a memo only implies.
  const firstPath = useRef(location.pathname);
  useEffect(() => {
    if (location.pathname !== firstPath.current) setMoved(true);
  }, [location.pathname]);

  if (!user || !mobile) return null;
  if (!settled || !moved) return null;

  if (standalone) localStorage.setItem(INSTALLED_KEY, '1');

  const installDismissedAt = Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0);
  const installMarked = localStorage.getItem(INSTALLED_KEY) === '1';
  const installInCooldown = Date.now() - installDismissedAt < DISMISS_COOLDOWN_MS;
  const installSupported = !standalone && !installMarked && (iosMode || !!deferredPrompt);
  const showInstall = installSupported && !installInCooldown;

  const pushDismissedAt = Number(localStorage.getItem(PUSH_DISMISS_KEY) || 0);
  const pushInCooldown = Date.now() - pushDismissedAt < DISMISS_COOLDOWN_MS;
  const pushEligible = pushState.supported && pushState.permission === 'default' && !pushState.subscribed;
  const showNotifications = !showInstall && pushEligible && !pushInCooldown;

  const step = showInstall ? 'install' : showNotifications ? 'notifications' : null;
  if (!step) return null;

  const dismissInstall = () => {
    localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
    setDismissTick((t) => t + 1);
  };

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    setInstalling(true);
    try {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice?.outcome === 'accepted') {
        localStorage.setItem(INSTALLED_KEY, '1');
      } else {
        localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
      }
      setDismissTick((t) => t + 1);
    } finally {
      setDeferredPrompt(null);
      setInstalling(false);
    }
  };

  const dismissPush = () => {
    localStorage.setItem(PUSH_DISMISS_KEY, String(Date.now()));
    setDismissTick((t) => t + 1);
  };

  const handleEnablePush = async () => {
    setPushBusy(true);
    try {
      await enablePush();
      toast.success('Notifications enabled');
      setPushState(await getPushSubscriptionState());
    } catch {
      localStorage.setItem(PUSH_DISMISS_KEY, String(Date.now()));
      setDismissTick((t) => t + 1);
    } finally {
      setPushBusy(false);
    }
  };

  if (step === 'install') {
    return (
      <div className="install-prompt-overlay" role="dialog" aria-modal="true" aria-labelledby="install-prompt-title">
        <div className="install-prompt-card">
          <button type="button" className="install-prompt-close" onClick={dismissInstall} aria-label="Close add to home screen prompt">
            <X size={16} />
          </button>

          <div className="install-prompt-icon-wrap">
            <div className="install-prompt-icon"><Smartphone size={22} /></div>
            <div className="badge badge-info">Recommended</div>
          </div>

          <h2 id="install-prompt-title">Add {brandName} to your Home Screen</h2>
          <p className="muted">
            Get faster access, an app-like full-screen experience, and a shortcut you can open in one tap after login.
          </p>

          {iosMode && !deferredPrompt ? (
            <div className="install-prompt-steps">
              <div className="install-step"><span>1</span> Tap <strong>Share</strong> in Safari.</div>
              <div className="install-step"><span>2</span> Choose <strong>Add to Home Screen</strong>.</div>
              <div className="install-step"><span>3</span> Tap <strong>Add</strong> to save {brandName} on your phone.</div>
            </div>
          ) : (
            <button type="button" className="btn btn-block install-prompt-action" onClick={handleInstall} disabled={installing || !deferredPrompt}>
              <Download size={16} /> {installing ? 'Preparing install…' : 'Add to Home Screen'}
            </button>
          )}

          <button type="button" className="btn btn-secondary btn-block install-prompt-secondary" onClick={dismissInstall}>
            <PlusSquare size={16} /> Maybe later
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="install-prompt-overlay" role="dialog" aria-modal="true" aria-labelledby="push-prompt-title">
      <div className="install-prompt-card">
        <button type="button" className="install-prompt-close" onClick={dismissPush} aria-label="Close enable notifications prompt">
          <X size={16} />
        </button>

        <div className="install-prompt-icon-wrap">
          <div className="install-prompt-icon"><Bell size={22} /></div>
          <div className="badge badge-info">Recommended</div>
        </div>

        <h2 id="push-prompt-title">Turn on notifications</h2>
        <p className="muted">
          Get an alert on this device for payment reminders, application updates, and other important changes — no need to keep checking the app.
        </p>

        <button type="button" className="btn btn-block install-prompt-action" onClick={handleEnablePush} disabled={pushBusy}>
          {pushBusy ? <BellOff size={16} /> : <Bell size={16} />} {pushBusy ? 'Working…' : 'Enable notifications'}
        </button>

        <button type="button" className="btn btn-secondary btn-block install-prompt-secondary" onClick={dismissPush}>
          <PlusSquare size={16} /> Maybe later
        </button>
      </div>
    </div>
  );
}
