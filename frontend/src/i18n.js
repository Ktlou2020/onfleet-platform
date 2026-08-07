import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import sw from './locales/sw.json';
import ny from './locales/ny.json';
import sn from './locales/sn.json';

// Only the rider-onboarding flow (Signup, FleetRiderApply) is translated so
// far — everything else falls back to English via i18next's fallbackLng.
i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      sw: { translation: sw },
      ny: { translation: ny },
      sn: { translation: sn },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'sw', 'ny', 'sn'],
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: { order: ['localStorage', 'navigator'], caches: ['localStorage'] },
  });

export default i18n;
