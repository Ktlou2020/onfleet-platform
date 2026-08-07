import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'sw', label: 'Kiswahili' },
  { code: 'ny', label: 'Chichewa' },
  { code: 'sn', label: 'chiShona' },
];

export default function LanguageSwitcher({ style }) {
  const { i18n } = useTranslation();
  const current = LANGUAGES.some((l) => l.code === i18n.language) ? i18n.language : 'en';

  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, ...style }}>
      <Globe size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      <select
        value={current}
        onChange={(e) => i18n.changeLanguage(e.target.value)}
        aria-label="Language"
        style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}
      >
        {LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>{lang.label}</option>
        ))}
      </select>
    </label>
  );
}
