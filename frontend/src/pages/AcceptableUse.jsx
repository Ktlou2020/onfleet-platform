import LegalPage from '../components/LegalPage';
import { LEGAL_DOCS } from '../lib/legalContent';

export default function AcceptableUse() {
  return <LegalPage doc={LEGAL_DOCS.acceptableUse} />;
}
