import LegalPage from '../components/LegalPage';
import { LEGAL_DOCS } from '../lib/legalContent';

export default function Privacy() {
  return <LegalPage doc={LEGAL_DOCS.privacy} />;
}
