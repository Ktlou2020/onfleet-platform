import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Download, PlusSquare, Smartphone, X } from 'lucide-react';
import { useAuth } from '../auth';

const DISMISS_KEY = 'of_install_prompt_dismissed_at';
const INSTALLED_KEY = 'of_app_installed';
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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

export default function InstallPrompt() {
  const { user } = useAuth();
  const location = useLocation();
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);

  const iosMode = useMemo(() => isIosSafari(), []);
  const standalone = useMemo(() => isStandaloneMode(), [location.pathname]);

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setDeferredPrompt(event);
    };

    const onInstalled = () => {
      localStorage.setItem(INSTALLED_KEY, '1');
      setOpen(false);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setOpen(false);
      return;
    }

    if (standalone) {
      localStorage.setItem(INSTALLED_KEY, '1');
      setOpen(false);
      return;
    }

    const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
    const installMarked = localStorage.getItem(INSTALLED_KEY) === '1';
    const inCooldown = Date.now() - dismissedAt < DISMISS_COOLDOWN_MS;
    const supported = iosMode || !!deferredPrompt;

    if (!installMarked && supported && !inCooldown) {
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [user, deferredPrompt, iosMode, standalone, location.pathname]);

  if (!user || standalone || !open) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setOpen(false);
  };

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    setInstalling(true);
    try {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice?.outcome === 'accepted') {
        localStorage.setItem(INSTALLED_KEY, '1');
        setOpen(false);
      } else {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
      }
    } finally {
      setDeferredPrompt(null);
      setInstalling(false);
    }
  };

  return (
    <div className="install-prompt-overlay" role="dialog" aria-modal="true" aria-labelledby="install-prompt-title">
      <div className="install-prompt-card">
        <button type="button" className="install-prompt-close" onClick={dismiss} aria-label="Close add to home screen prompt">
          <X size={16} />
        </button>

        <div className="install-prompt-icon-wrap">
          <div className="install-prompt-icon"><Smartphone size={22} /></div>
          <div className="badge badge-info">Recommended</div>
        </div>

        <h2 id="install-prompt-title">Add OnFleet to your Home Screen</h2>
        <p className="muted">
          Get faster access, an app-like full-screen experience, and a shortcut your riders or admins can open in one tap after login.
        </p>

        {iosMode && !deferredPrompt ? (
          <div className="install-prompt-steps">
            <div className="install-step"><span>1</span> Tap <strong>Share</strong> in Safari.</div>
            <div className="install-step"><span>2</span> Choose <strong>Add to Home Screen</strong>.</div>
            <div className="install-step"><span>3</span> Tap <strong>Add</strong> to save OnFleet on your phone.</div>
          </div>
        ) : (
          <button type="button" className="btn btn-block install-prompt-action" onClick={handleInstall} disabled={installing || !deferredPrompt}>
            <Download size={16} /> {installing ? 'Preparing install…' : 'Add to Home Screen'}
          </button>
        )}

        <button type="button" className="btn btn-secondary btn-block install-prompt-secondary" onClick={dismiss}>
          <PlusSquare size={16} /> Maybe later
        </button>
      </div>
    </div>
  );
}
