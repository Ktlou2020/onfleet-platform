import WorkshopGuide from '../../components/WorkshopGuide';

// The guide as the workshop floor sees it: the admin-only sections (ordering
// from Hero, loading a price list) are left out.
export default function WorkshopGuidePage() {
  return <WorkshopGuide portal="workshop" />;
}
