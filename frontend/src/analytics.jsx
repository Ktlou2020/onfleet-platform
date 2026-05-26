import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const GA_MEASUREMENT_ID = 'G-RZFE5KMNCD';
const GA_SCRIPT_ID = 'onfleet-ga4-script';

function ensureDataLayer() {
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() {
    window.dataLayer.push(arguments);
  };
}

function loadGa4Script() {
  if (document.getElementById(GA_SCRIPT_ID)) return;
  const script = document.createElement('script');
  script.id = GA_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);
}

function initializeGa4() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__onfleetGaInitialized) return;

  ensureDataLayer();
  loadGa4Script();
  window.gtag('js', new Date());
  window.gtag('config', GA_MEASUREMENT_ID, { send_page_view: false });
  window.__onfleetGaInitialized = true;
}

function trackPageView(pathname, search = '') {
  if (typeof window === 'undefined') return;
  ensureDataLayer();
  const pagePath = `${pathname || '/'}${search || ''}`;
  if (window.__onfleetLastTrackedPath === pagePath) return;
  window.__onfleetLastTrackedPath = pagePath;

  window.gtag('event', 'page_view', {
    page_title: document.title,
    page_location: window.location.href,
    page_path: pagePath,
    send_to: GA_MEASUREMENT_ID
  });
}

export default function AnalyticsTracker() {
  const location = useLocation();

  useEffect(() => {
    initializeGa4();
  }, []);

  useEffect(() => {
    initializeGa4();
    trackPageView(location.pathname, location.search);
  }, [location.pathname, location.search]);

  return null;
}
