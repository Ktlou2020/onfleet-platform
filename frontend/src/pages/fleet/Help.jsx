import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bike,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  CreditCard,
  FileText,
  HelpCircle,
  LayoutDashboard,
  Search,
  ShieldCheck,
  Users,
  Wrench
} from 'lucide-react';
import { Badge, EmptyState, SearchInput } from '../../components/ui';

const HELP_SECTIONS = [
  {
    id: 'getting-started',
    title: 'Getting started',
    icon: BookOpen,
    tone: 'info',
    summary: 'Start with the dashboard, confirm your company setup, and work through the platform in the right order.',
    keywords: ['start', 'setup', 'first steps', 'onboarding', 'begin', 'company setup'],
    quickLinks: [
      { label: 'Open dashboard', to: '/fleet/app' },
      { label: 'Open help', to: '/fleet/app/help' }
    ],
    steps: [
      'Sign in to the Fleet Owner Console and land on the Dashboard.',
      'Check the organization account card to confirm your company name, plan, and team details are correct.',
      'Review the operations snapshot so you know how many bikes are ready, how many agreements are open, and whether any collections need follow-up.',
      'Use the sidebar to move through the platform in this order: Bikes → Riders → Agreements → Payments.',
      'Use the search bar at the top of the portal to jump between fleet sections quickly.'
    ]
  },
  {
    id: 'dashboard',
    title: 'Using the dashboard',
    icon: LayoutDashboard,
    tone: 'success',
    summary: 'The dashboard is your control room for live status, collections, service reminders, and quick actions.',
    keywords: ['dashboard', 'overview', 'snapshot', 'collections', 'service reminders', 'live sync'],
    quickLinks: [
      { label: 'Open dashboard', to: '/fleet/app' }
    ],
    steps: [
      'Review the top stats for active bikes, open agreements, overdue amount, and upcoming services.',
      'Use Refresh whenever you want the latest numbers from the system.',
      'Check the Collections Queue to see which agreements need payment follow-up first.',
      'Check Upcoming Services to see which bikes need maintenance scheduling soon.',
      'Use the quick buttons in the Operations Snapshot card to jump directly to Bikes, Agreements, or Payments.'
    ]
  },
  {
    id: 'bikes',
    title: 'Managing bikes',
    icon: Bike,
    tone: 'info',
    summary: 'Add bikes, edit bike details, assign them to the right fleet, and keep statuses updated.',
    keywords: ['bikes', 'bike fleet', 'registration', 'status', 'fleet tag', 'edit bike', 'add bike'],
    quickLinks: [
      { label: 'Open Bikes Fleet', to: '/fleet/app/bikes' }
    ],
    steps: [
      'Go to Bikes Fleet from the sidebar.',
      'Use Add bike to capture a new bike with VIN, registration, make, model, fleet name, pricing, and status.',
      'Use the search bar to find a bike by registration, VIN, fleet, rider, or agreement number.',
      'Use the fleet filter and status buttons to narrow the list to the bikes you need to work on.',
      'Use Save status when a bike moves between ready to go, active, repairs, stolen, sold, or other lifecycle states.',
      'Use Edit to update the bike record whenever details such as registration, rental amount, disc expiry, or notes change.'
    ]
  },
  {
    id: 'riders',
    title: 'Managing rider applications',
    icon: Users,
    tone: 'warn',
    summary: 'Collect rider applications, review documents, approve and allocate a bike, or decline with a reason.',
    keywords: ['riders', 'applications', 'approve', 'decline', 'documents', 'share link', 'allocate bike'],
    quickLinks: [
      { label: 'Open Riders', to: '/fleet/app/riders' }
    ],
    steps: [
      'Go to Riders from the sidebar.',
      'Copy or open the public rider application link if you want riders to apply themselves.',
      'Use Add rider if your team is capturing an application manually on behalf of a rider.',
      'Open a rider application to review personal details, payout method, preferred bike, and uploaded documents.',
      'Upload any missing documents from the rider detail screen if the application is incomplete.',
      'Use the decision panel to approve the application, select the bike, set the weekly amount, and confirm the start date.',
      'Use Decline if the application should not proceed, and add a clear reason so the outcome is recorded properly.'
    ]
  },
  {
    id: 'agreements',
    title: 'Creating and managing agreements',
    icon: FileText,
    tone: 'success',
    summary: 'Create agreements, reassign bikes, change agreement status, and adjust remaining balance when needed.',
    keywords: ['agreements', 'contracts', 'reassign', 'pause', 'resume', 'remaining balance', 'default', 'complete'],
    quickLinks: [
      { label: 'Open Agreements', to: '/fleet/app/agreements' }
    ],
    steps: [
      'Go to Agreements from the sidebar.',
      'Use Add agreement when you want to create a new allocation between a ready bike and an available rider.',
      'Choose the bike, choose the rider, set the start date, weekly amount, and total weeks, then save.',
      'Use Reassign when a rider should continue on a different ready bike without starting a brand-new contract.',
      'Use Pause, Resume, Default, Complete, Cancel, or Discontinue to keep the agreement lifecycle accurate.',
      'Click the Remaining amount in the table if you need to edit the balance still owed. Save the new value to recalculate the outstanding schedule.'
    ]
  },
  {
    id: 'payments',
    title: 'Recording and tracking payments',
    icon: CreditCard,
    tone: 'success',
    summary: 'Track rental collections, record manual payments, and clean up incorrect payment rows when necessary.',
    keywords: ['payments', 'collections', 'manual payment', 'delete payment', 'overdue', 'rental'],
    quickLinks: [
      { label: 'Open Payments', to: '/fleet/app/payments' }
    ],
    steps: [
      'Go to Payments from the sidebar.',
      'Use the filters and search tools to find a rider, agreement, method, or reference quickly.',
      'Use Record manual payment when you receive EFT, cash, card, or another off-platform payment.',
      'Enter the agreement, amount, method, reference, and date, then save the payment.',
      'Review overdue and credited amounts regularly to keep collections current.',
      'If a payment was captured incorrectly, use the bulk delete tools carefully so the schedule can be recalculated.'
    ]
  },
  {
    id: 'operations-best-practice',
    title: 'Recommended daily workflow',
    icon: ClipboardCheck,
    tone: 'info',
    summary: 'A simple routine that helps your team stay organized and reduce missed actions.',
    keywords: ['daily workflow', 'routine', 'best practice', 'how to use platform', 'step by step'],
    quickLinks: [
      { label: 'Open dashboard', to: '/fleet/app' },
      { label: 'Open riders', to: '/fleet/app/riders' },
      { label: 'Open payments', to: '/fleet/app/payments' }
    ],
    steps: [
      'Start on the Dashboard and refresh live data.',
      'Review rider applications and finish any pending approvals or declines.',
      'Check Bikes Fleet for bikes in repairs, stolen status, or discs approaching expiry.',
      'Review Agreements for overdue balances, paused contracts, or reassignments needed.',
      'Capture or verify Payments before the day ends so balances stay accurate.',
      'Finish by checking Upcoming Services so your operations team can plan maintenance ahead of time.'
    ]
  },
  {
    id: 'access-and-roles',
    title: 'Who can do what',
    icon: ShieldCheck,
    tone: 'warn',
    summary: 'Different fleet roles can see different sections, so missing actions may be permission-related.',
    keywords: ['roles', 'permissions', 'access', 'viewer', 'ops', 'billing', 'admin'],
    quickLinks: [],
    steps: [
      'Company admin can access the full fleet workflow.',
      'Operations lead can work on bikes, riders, and agreements needed for daily operations.',
      'Billing lead can focus on financial and payment-related work.',
      'Viewer access is read-only and may not show every operational section.',
      'If a page or action is missing, first confirm that the signed-in account has the right fleet role.'
    ]
  },
  {
    id: 'common-questions',
    title: 'Common questions',
    icon: HelpCircle,
    tone: 'info',
    summary: 'Quick answers for the actions fleet teams ask for most often.',
    keywords: ['faq', 'questions', 'common issues', 'search help', 'how do i'],
    quickLinks: [
      { label: 'Open Bikes Fleet', to: '/fleet/app/bikes' },
      { label: 'Open Agreements', to: '/fleet/app/agreements' }
    ],
    steps: [
      'How do I find a bike fast? Use the Bikes Fleet search with registration, VIN, fleet name, rider name, or agreement number.',
      'How do I approve a rider? Open the rider application, review documents, then approve and allocate the correct bike.',
      'How do I change the balance owed? Open Agreements and click the remaining balance value on the row you want to edit.',
      'How do I know what needs attention first? Start with Dashboard collections, defaulted agreements, and upcoming services.',
      'How do I correct a wrong payment? Use the Payments page and remove the incorrect row so the schedule can recalculate.'
    ]
  },
  {
    id: 'maintenance-and-accuracy',
    title: 'Keeping records accurate',
    icon: Wrench,
    tone: 'warn',
    summary: 'A few habits that keep the fleet data clean and make reporting more reliable.',
    keywords: ['maintenance', 'accuracy', 'records', 'data quality', 'clean data'],
    quickLinks: [
      { label: 'Open Bikes Fleet', to: '/fleet/app/bikes' },
      { label: 'Open Payments', to: '/fleet/app/payments' }
    ],
    steps: [
      'Always keep bike status current so the team knows which bikes are deployable.',
      'Keep registration, fleet name, and licence disc details updated on every bike record.',
      'Record payments on time so overdue and remaining balances stay trustworthy.',
      'Use clear notes when creating or reassigning agreements so future audits make sense.',
      'Review service dates and next service targets every week to avoid missed maintenance.'
    ]
  }
];

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

export default function FleetOwnerHelp() {
  const [search, setSearch] = useState('');
  const query = normalizeText(search).trim();

  const filteredSections = useMemo(() => {
    if (!query) return HELP_SECTIONS;
    return HELP_SECTIONS.filter((section) => {
      const haystack = [
        section.title,
        section.summary,
        ...(section.keywords || []),
        ...(section.steps || [])
      ].join(' \n ').toLowerCase();
      return haystack.includes(query);
    });
  }, [query]);

  const matchCount = filteredSections.reduce((sum, section) => {
    if (!query) return sum + section.steps.length;
    return sum + section.steps.filter((step) => step.toLowerCase().includes(query)).length;
  }, 0);

  return (
    <>
      <div className="flex-between mb-2" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Help & step-by-step guide</h1>
          <p className="page-sub">Search the full Fleet Owner guide, jump to the right section, and follow simple step-by-step instructions for the tasks your team does every day.</p>
        </div>
        <div className="badge badge-info"><CheckCircle2 size={12} /> Searchable guide</div>
      </div>

      <div className="card mb-4 fleet-help-hero">
        <div className="fleet-help-hero-copy">
          <div className="badge badge-muted mb-3"><Search size={12} /> Quick help</div>
          <h3 style={{ fontSize: 22, marginBottom: 10 }}>Find the exact workflow you need</h3>
          <p className="muted" style={{ maxWidth: 760 }}>
            Search for anything like <strong>approve rider</strong>, <strong>record payment</strong>, <strong>change remaining balance</strong>, <strong>add bike</strong>, or <strong>reassign agreement</strong>.
          </p>
        </div>
        <div className="fleet-help-search-wrap">
          <SearchInput value={search} onChange={setSearch} placeholder="Search the Fleet Owner guide" style={{ width: '100%' }} />
          <div className="muted text-sm mt-2">{filteredSections.length} sections · {matchCount} matching step{matchCount === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div className="card mb-4">
        <div className="card-title"><h3>Quick jump</h3><Badge status="active">{HELP_SECTIONS.length} topics</Badge></div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {filteredSections.map((section) => (
            <a key={section.id} href={`#${section.id}`} className="btn btn-sm btn-secondary">{section.title}</a>
          ))}
        </div>
      </div>

      {filteredSections.length ? (
        <div className="grid grid-2 fleet-help-grid">
          {filteredSections.map((section) => {
            const Icon = section.icon || BookOpen;
            return (
              <section key={section.id} id={section.id} className="card fleet-help-card">
                <div className="card-title" style={{ alignItems: 'flex-start', gap: 16 }}>
                  <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                    <div className={`fleet-help-icon fleet-help-icon-${section.tone || 'info'}`}>
                      <Icon size={18} />
                    </div>
                    <div>
                      <h3 style={{ marginBottom: 8 }}>{section.title}</h3>
                      <p className="muted text-sm">{section.summary}</p>
                    </div>
                  </div>
                  <Badge status={section.tone === 'success' ? 'approved' : section.tone === 'warn' ? 'pending' : 'active'}>
                    {(section.steps || []).length} steps
                  </Badge>
                </div>

                {!!section.quickLinks?.length && (
                  <div className="row mb-3" style={{ flexWrap: 'wrap', gap: 8 }}>
                    {section.quickLinks.map((item) => (
                      <Link key={`${section.id}-${item.to}`} to={item.to} className="btn btn-sm btn-secondary">{item.label}</Link>
                    ))}
                  </div>
                )}

                <ol className="fleet-help-steps">
                  {section.steps.map((step, index) => {
                    const isMatch = query && step.toLowerCase().includes(query);
                    return (
                      <li key={`${section.id}-${index}`} className={isMatch ? 'is-match' : ''}>
                        <span className="fleet-help-step-number">{index + 1}</span>
                        <span>{step}</span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
        </div>
      ) : (
        <EmptyState title="No guide topics matched your search" sub="Try broader words like bike, riders, payments, agreements, dashboard, or remaining balance." />
      )}
    </>
  );
}
