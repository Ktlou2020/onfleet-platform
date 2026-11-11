import LegalPage from '../components/LegalPage';
import { LEGAL_DOCS } from '../lib/legalContent';

export default function Terms() {
  return <LegalPage doc={LEGAL_DOCS.terms} />;
}
