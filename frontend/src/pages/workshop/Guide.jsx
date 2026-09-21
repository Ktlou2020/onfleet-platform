import WorkshopGuidePage from '../../components/WorkshopGuidePage';

// The guide as the workshop floor sees it: the admin-only sections (ordering
// from Hero, loading a price list) are left out.
export default function WorkshopGuideRoute() {
  return <WorkshopGuidePage portal="workshop" />;
}
