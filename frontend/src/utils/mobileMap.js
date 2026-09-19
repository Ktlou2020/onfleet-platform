import { useEffect, useState } from 'react';

// Tracking pages switch to a phone layout below this width: the map fills the
// page, the list opens over it, and the selected bike's details sit in a
// bottom sheet. Matches the breakpoint where the app's sidebar gives way to
// the bottom menu (styles.css).
export const MOBILE_QUERY = '(max-width: 640px)';

// Bottom-sheet heights, as CSS lengths relative to the tracking page
export const SHEET_HEIGHTS = { peek: '148px', half: '52%', full: 'calc(100% - 52px)' };
export const SHEET_NEXT = { peek: 'half', half: 'full', full: 'peek' };
export const SHEET_HALF_SHARE = 0.52;

export function useIsMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

// Height available between the element's top and the fixed bottom menu, so a
// full-bleed page fits the phone without scrolling behind the menu.
export function useFitHeight(ref, enabled) {
  const [height, setHeight] = useState(null);
  useEffect(() => {
    if (!enabled) { setHeight(null); return undefined; }
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const nav = document.querySelector('.mobile-bottom-nav');
      const h = window.innerHeight - el.getBoundingClientRect().top - (nav?.offsetHeight || 0);
      setHeight(Math.max(320, Math.round(h)));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('orientationchange', measure); };
  }, [ref, enabled]);
  return height;
}
