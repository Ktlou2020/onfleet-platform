import brand from '../brand';

// The legal pages, as data rather than as six hand-built React trees.
//
// There is one platform and two products on it, and the pages they need are
// the same pages with a different company's name on them. Writing them twice
// is how the old /terms page ended up telling Pillion's customers they had
// contracted with OnFleet Africa at a price nobody has charged since the
// tiers were rebuilt — a signup form cannot link to the terms of a company
// the visitor has never heard of.
//
// So the documents live here once, parameterised by the brand, and LegalPage
// renders them. A number a customer could hold us to — a tier price, the
// minimum, the VAT rate — is written in ONE place in this file and nowhere
// else on the site.

// ---------------------------------------------------------------------------
// Who contracts with the customer
//
// `legalName` is the registered company the customer is agreeing with, which
// is not the same thing as the brand on the page. Both products are sold by
// the same company; Pillion is a trading name of it, which is why the two
// entries differ only in `tradingAs` and in whether that company runs its own
// motorcycles.
//
// A brand whose legalName is null renders its documents with a visible
// "being finalised" notice rather than a silent placeholder, because terms
// with no named counterparty bind nobody and should not look as though they
// do. That guard is inert while both brands below are named — it is here for
// the next brand, not this one.
const CONTACT_EMAIL = 'admin@onfleet.africa';
const ADDRESS = '63 Peter Place, Bryanston, 2191';
const PHONE = '081 539 5612';

// Companies Act registration number, for the PAIA manual. The row is left out
// of the manual until this is filled in — an incomplete field on a published
// compliance document is worse than one that is not there yet.
const REGISTRATION_NUMBER = '2020/101046/07';

// The registered company, which is not the brand on the page: the brand is
// "OnFleet Africa", the company is Onfleet (Pty) Ltd, and a contract has to
// name the latter.
const ENTITIES = {
  onfleet: {
    legalName: 'Onfleet (Pty) Ltd',
    tradingAs: null,
    address: ADDRESS,
    phone: PHONE,
    legalEmail: CONTACT_EMAIL,
    supportEmail: CONTACT_EMAIL,
    site: 'onfleet.africa',
    // OnFleet runs its own motorcycles as well as selling the platform, so it
    // is a responsible party for its own riders' information, not only an
    // operator for its customers'. Under the Pillion brand it is never that.
    runsOwnFleet: true,
  },
  pillion: {
    legalName: 'Onfleet (Pty) Ltd',
    tradingAs: 'Pillion',
    address: ADDRESS,
    phone: PHONE,
    legalEmail: CONTACT_EMAIL,
    supportEmail: CONTACT_EMAIL,
    site: 'pillion.co.za',
    runsOwnFleet: false,
  },
};

export const entity = ENTITIES[brand.key] || ENTITIES.onfleet;

/** True while this brand has no registered company behind its documents. */
export const entityUnconfirmed = !entity.legalName;

/** "Onfleet (Pty) Ltd" — with "trading as Pillion" where that applies. */
export const contractingParty = entity.tradingAs
  ? `${entity.legalName} trading as ${entity.tradingAs}`
  : entity.legalName;

const US = contractingParty || `the company operating ${brand.name}`;

// ---------------------------------------------------------------------------
// The commercial terms, from the one module that actually bills people.
// Mirrored from backend/src/services/subscriptionPricing.js — if a tier moves
// there, it moves here.
const TIERS = [
  ['Basic', 'R95'],
  ['Workshop', 'R195'],
  ['Fleet', 'R295'],
  ['Complete', 'R375'],
];
const MINIMUM_BIKES = 10;
const VAT_RATE = '15%';
const ANNUAL_MONTHS = 10;
const EXPORT_DAYS = 30;

const SUB_PROCESSORS = [
  ['Railway', 'Hosting and the database'],
  ['Cloudflare R2', 'Stored files — documents, photographs'],
  ['Brevo', 'Email notifications'],
  ['Twilio', 'SMS notifications'],
  ['Paystack', 'Card and EFT payments'],
  ['MTN MoMo', 'Mobile-money collections and payouts'],
];

const UPDATED = 'November 2026';

// ---------------------------------------------------------------------------
// Block helpers. A document is a list of sections; a section is a heading and
// a list of blocks.
const p = (text) => ({ type: 'p', text });
const ul = (items) => ({ type: 'ul', items });
const table = (head, rows) => ({ type: 'table', head, rows });
const note = (text) => ({ type: 'note', text });
const lead = (text) => ({ type: 'lead', text });

// ---------------------------------------------------------------------------
// Terms of Use

const terms = {
  slug: 'terms',
  title: 'Terms of Use',
  updated: UPDATED,
  intro: lead(
    `These terms govern the use of ${brand.name}, fleet-management software for two-wheeler operators. ` +
    `They are an agreement between ${US} and the business that puts its bikes on the platform. ` +
    `${brand.name} supplies software; it does not own, rent out, finance or insure any motorcycle.`
  ),
  sections: [
    {
      heading: 'Who these terms cover',
      blocks: [
        p('Three groups use the platform, and they do not have the same agreement with us.'),
        table(['Who', 'What they are to us'], [
          ['The fleet operator — the business that registers a company account and whose bikes are on the platform. Called "you" throughout.',
            'Our customer. These terms are our contract with you.'],
          ['Your users — the people you give logins to: operations staff, bookkeepers, workshop staff, read-only viewers.',
            'They use the platform under your account. You are responsible for what they do on it.'],
          ['Your riders — the people riding your bikes, who use the rider app to pay, see their balance and release a bike at night.',
            'The rider section below applies to them. Their rental or credit agreement is with you, not with us.'],
        ]),
        p('By registering a company account, or by using the platform on behalf of a fleet operator, you accept these terms. If you are accepting on behalf of a business, you confirm that you are authorised to bind it.'),
        p('If you have signed a separate written agreement with us — a pilot agreement, an enterprise order form — that agreement governs where it conflicts with these terms.'),
      ],
    },
    {
      heading: `What ${brand.name} is, and what it is not`,
      blocks: [
        p(`${brand.name} is software. It records where your bikes are, what your riders owe, what the workshop did, and it sends commands to tracking devices fitted to your bikes.`),
        p(`${brand.name} is not:`),
        ul([
          'The owner or lessor of your motorcycles. Every bike you put on the platform belongs to you. We are not a party to any rental, rent-to-own or credit agreement between you and a rider.',
          'A credit provider. We do not lend money and we are not a registered credit provider. If your agreements with riders are credit agreements under the National Credit Act, meeting that Act is yours.',
          'A bank, payment institution or money remitter. Payments run through third-party providers. We do not hold client funds as a financial institution.',
          'An insurer. Tracking, geofencing and immobilisation are not insurance and are not a substitute for it. Nothing here is a warranty that a bike will be recovered.',
          'A vehicle-recovery or security company. We do not dispatch anyone. The platform raises alerts and sends commands; acting on them is yours.',
        ]),
        p('We may change what the platform does — add features, retire them, alter how one works. We will give reasonable notice before removing something you rely on.'),
      ],
    },
    {
      heading: 'Your account',
      blocks: [
        p('You give each person their own login and the role their job needs. You keep those credentials secure, and you remove a login when someone leaves. Anything done through your account is treated as done by you.'),
        p('You must give accurate company and contact details, and keep them current. We may suspend an account where we cannot reach you.'),
        p('You are responsible for the accuracy of what you enter — bikes, riders, agreements, odometer readings, payments. The platform acts on that data, including when it decides to immobilise a bike.'),
        p('What you may and may not do with the platform is set out in the Acceptable Use Policy, which forms part of these terms.'),
      ],
    },
    {
      heading: 'What you pay',
      blocks: [
        p('The platform is priced per bike per month, on the tier you choose. All rates are exclusive of VAT.'),
        table(['Tier', 'Per bike / month'], TIERS),
        p('What counts as a bike. You are billed for every bike on your account except those marked sold, paid off or written off. A stolen bike is still billed — that is when the tracking is working hardest. Your invoice shows the count, the rate and which bikes were excluded.'),
        p(`Minimum. A fleet of fewer than ${MINIMUM_BIKES} bikes is billed as though it had ${MINIMUM_BIKES}.`),
        p(`VAT. South African VAT is added at the prevailing rate, ${VAT_RATE} at the date of these terms, and shown separately on the invoice.`),
        p(`Annual. On an annual cycle you pay ${ANNUAL_MONTHS} months for twelve, charged up front.`),
        p('Card processing. Where you pay by card, a processing fee is added so that the amount we receive is the amount quoted. The fee is calculated per invoice and printed on it as a separate line. We may change how it is calculated on 30 days’ notice.'),
        p('Changing tier. You may move between tiers. A change takes effect from the next billing cycle unless we agree otherwise.'),
        p('Late or failed payment. We will tell you if a payment fails and allow a grace period before restricting access. During a restriction you keep access to your billing screens and to exporting your data. We do not use the immobiliser to collect what you owe us, and we never will.'),
        p('Cancellations and refunds are dealt with in the Refund and Cancellation Policy.'),
      ],
    },
    {
      heading: 'Money you collect from your riders',
      blocks: [
        p('The platform can collect rider payments by card, EFT and MTN MoMo, and can pay out to your account. This is separate from what you pay us for the subscription.'),
        p('The money is yours, not ours. Rider payments are collected for your account. We record them and show them to you; we do not take ownership of them.'),
        p('Third-party providers. Collections and payouts run through payment providers — currently Paystack for cards and EFT, and MTN MoMo for mobile money. Their own terms apply to those transactions, and their fees are theirs. We are not responsible for a provider’s outage, a declined transaction, a reversal, a chargeback or a delayed settlement.'),
        p('Your own merchant relationship. Where the platform collects into your own merchant or mobile-money account, you are the merchant. You are responsible for your onboarding, your verification, and for meeting your provider’s rules.'),
        p('Wallet balances. A balance shown in the platform is a record of what has been collected and reconciled, not a deposit held by us and not a guarantee of availability. Payouts depend on the provider.'),
        p('Reconciliation. We reconcile against the provider’s records. Where the platform and the provider disagree, the provider’s record is the one that counts, and we will correct ours.'),
        p('Your agreements with riders. What a rider owes, when, and what happens if they do not pay is between you and the rider. We only carry out the collection you configure.'),
      ],
    },
    {
      heading: 'Trackers and other hardware',
      blocks: [
        p('The platform works with supported Teltonika tracking devices, which talk to it directly. Hardware is bought, supplied and fitted separately from your subscription, under whatever terms cover that supply.'),
        p('Ownership. Devices fitted to your bikes are yours unless a separate agreement says otherwise.'),
        p('Fitment. A device must be fitted correctly for the platform to work as described — in particular the ignition wire and the output used for immobilisation. A badly fitted device can report a bike as stationary when it is moving, or fail to cut when asked. Fitment carried out by you or your contractor is your responsibility.'),
        p('Connectivity. A tracker reports over a mobile network. No position arrives while a device is out of coverage, powered down, or has been removed or tampered with. Queued commands are delivered when the device next connects, which may be hours later or not at all.'),
        p('What a tracker cannot do. A GPS fix can be wrong by tens of metres, and in poor conditions by much more. The platform discards fixes it judges too old or too weak to act on, but it cannot make a bad fix good. Do not treat a position as proof of where a bike or a person was.'),
        p('Keeping devices healthy. The platform reports which trackers have gone quiet. Acting on that — getting the bike in, checking the wiring, replacing the unit — is yours.'),
      ],
    },
    {
      heading: 'Immobilising a bike',
      blocks: [
        p('The platform can prevent a bike’s engine from starting, either on your command or automatically under rules you switch on. This is the most serious thing it does, and this section is the one to read carefully.'),
        p('Safety limits built into the platform. We do not rely on the operator to apply these:'),
        ul([
          'A cut is never sent to a bike travelling above walking pace. The command waits until the bike is slow or its ignition is off.',
          'A position that is too old or too weak to act on is not acted on.',
          'Immobilisation prevents an engine from being started. It is not a brake and does not stop a moving motorcycle.',
          'A bike cut because of a suspected theft is not released by a timer, by a payment, or by the morning restore. Only a person releases it.',
          'Where you enable the overnight lock, a rider can release their own bike from the rider app, and individual bikes can be exempted.',
        ]),
        p('What we do not promise. We cannot guarantee that a command is delivered, delivered promptly, or carried out by the device. Delivery depends on mobile coverage, the device, its power and its wiring. Do not build a process that depends on a cut being immediate or certain.'),
        p('Your decisions, your law to meet. You decide whether to use immobilisation at all, on which bikes, under which rules, and with what notice to your riders. You are responsible for ensuring that use is lawful, including under the National Credit Act, the Consumer Protection Act, the Protection of Personal Information Act, and the law on unlawful deprivation of property and self-help remedies. Where immobilisation is used against a rider in arrears, the right to do so must come from your agreement with that rider, and you must follow whatever process that agreement and the law require.'),
        p('What you must not do with it. You must not immobilise a bike to endanger a rider, to punish someone, or where you have been told a rider is in distress, in an unsafe place, or carrying a passenger who would be stranded. You must not use it against a bike or a person outside your fleet.'),
        p('Our liability. Subject to the limitation of liability below, we are not liable for loss arising from a bike being immobilised, from a bike failing to be immobilised, or from the timing of either.'),
      ],
    },
    {
      heading: 'Riders using the platform',
      blocks: [
        p('This section is for riders. If you are a rider, the business you ride for is your fleet operator.'),
        p(`Your agreement is with your fleet operator. Your rental, rent-to-own or employment agreement is with them. ${brand.name} supplies the software they run. We do not own your bike, we are not owed your payments, and we cannot change what you owe or the terms you ride under.`),
        p('What the rider app does. It shows your balance and payment history, lets you pay, and — where your fleet has switched it on — lets you release your own bike during the overnight lock.'),
        p('Your bike may be immobilised. Your fleet operator can stop your bike’s engine from starting, and may have automatic rules that do so. The platform will not do this while you are riding above walking pace. Your fleet operator must tell you when and why this can happen; if they have not, ask them.'),
        p('Your location is recorded. While a tracker is fitted and powered, the bike’s position is recorded continuously, including outside working hours, and your fleet operator can see it.'),
        p('Your rights over your information. Your fleet operator decides what happens to your personal information. Send requests to see, correct or delete it to them. If you contact us, we will pass it on and tell you we have.'),
        p('Use the app honestly. Do not use someone else’s login, do not try to defeat the tracker or the immobiliser, and do not report false information through the app.'),
      ],
    },
    {
      heading: 'Availability and support',
      blocks: [
        p('We work to keep the platform available and to restore it quickly when it is not, but we do not guarantee uninterrupted access. We may take it down for maintenance, with notice where we can give it.'),
        p('During an outage. Positions may not be recorded, alerts may not be raised, and commands — including engine cut and restore — may not be sent or delivered. Do not rely on the platform as your only control over a bike.'),
        p('Support. We provide support by email during South African business hours. Response targets, if any, are set in a separate agreement or on the tier you are on.'),
      ],
    },
    {
      heading: 'Limitation of liability',
      blocks: [
        p('To the fullest extent the law allows, we are not liable for:'),
        ul([
          'A stolen, lost or damaged motorcycle, whether or not it was tracked.',
          'Money a rider does not pay you.',
          'Loss of profit, revenue, business or goodwill, or any indirect or consequential loss.',
          'Loss arising from an immobilisation, or from an immobilisation not happening.',
          'Loss arising from a third party we depend on — a mobile network, a payment provider, a hosting provider, a device manufacturer.',
          'Loss arising from data you entered incorrectly, or from a configuration you chose.',
        ]),
        p('Cap. Where we are liable, our total liability for all claims in any twelve-month period is limited to the subscription fees you paid us in the three months before the first claim arose.'),
        p('What is not limited. Nothing in these terms limits liability for death or personal injury caused by our negligence, for fraud, or for anything else that cannot be limited under South African law — including rights you have under the Consumer Protection Act where it applies to you.'),
      ],
    },
    {
      heading: 'Ending the agreement',
      blocks: [
        p('You may cancel at any time, effective at the end of your current billing cycle. On an annual term, cancellation takes effect at the end of that term unless we agree otherwise. The Refund and Cancellation Policy sets out what is refundable.'),
        p('We may suspend or terminate your account if you breach these terms, if your subscription is unpaid beyond the grace period, or if your use of the platform creates a legal risk or a risk to other users. Where the circumstances allow, we will give notice and a chance to put it right first.'),
        p(`Getting your data out. For ${EXPORT_DAYS} days after termination you may export your data from the platform. After that we may delete it, subject to the Privacy Policy and to anything we must keep by law.`),
        p('Immobilisation at termination. We do not immobilise bikes because an account has ended. When your account closes, the platform stops sending commands to your devices — including restore commands. Restore any cut bike before you leave.'),
      ],
    },
    {
      heading: 'General',
      blocks: [
        p('Changes to these terms. We may change these terms. For a material change we will give at least 14 days’ notice by email to your registered address. Continuing to use the platform after the effective date is acceptance. If you do not accept, you may cancel before the change takes effect.'),
        p('Intellectual property. The platform, its software and its designs are ours and stay ours. You get a non-exclusive, non-transferable right to use it while your subscription is current. Your data stays yours.'),
        p('Transfer. You may not transfer these terms without our written consent. We may transfer them to a company in our group or to a buyer of the business, on notice to you.'),
        p('The whole agreement. These terms, the Acceptable Use Policy, the Privacy Policy and the Refund and Cancellation Policy, plus any order form or written agreement we have signed with you, are the whole agreement between us. If a clause is unenforceable, the rest stands.'),
        p('Governing law. South African law governs these terms. Disputes go to the courts of Gauteng, South Africa.'),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Privacy Policy

const privacy = {
  slug: 'privacy',
  title: 'Privacy Policy',
  updated: UPDATED,
  intro: lead(
    `This policy explains what ${US} does with personal information on the ${brand.name} platform, ` +
    'and who is answerable for it. It is written to the Protection of Personal Information Act, 2013 (POPIA).'
  ),
  sections: [
    {
      heading: 'Who is responsible for what',
      blocks: [
        p('POPIA distinguishes a responsible party, who decides why and how information is processed, from an operator, who processes it on the responsible party’s behalf. Which one we are depends on whose information it is.'),
        table(['Whose information', 'Our role'], [
          ['A fleet operator’s own account, users and billing',
            'We are the responsible party.'],
          ['The riders, applicants and staff of a fleet operator using the platform',
            'That fleet operator is the responsible party. We are their operator, and we process it only to run the platform for them and on their instructions.'],
          ...(entity.runsOwnFleet ? [[
            `Riders and applicants of ${entity.legalName}’s own fleet`,
            'We are the responsible party, because those are our own agreements.',
          ]] : []),
        ]),
        p('If you are a rider and you want to see, correct or delete your information, ask the business you ride for. They decide. If you ask us, we will pass the request to them and tell you we have.'),
      ],
    },
    {
      heading: 'What we process',
      blocks: [
        p('For a fleet operator’s account: company name and registration number, contact names, phone numbers and email addresses, billing details, and a log of what each user did on the platform.'),
        p('For riders and applicants, as instructed by the fleet operator: identity and contact details, licence details, documents and photographs uploaded in support of an application, agreement and payment records, and the position of the bike they ride.'),
        p('Technical information: IP address, device and browser type, and the pages and actions taken on the platform. We use it to keep the service secure and working.'),
        p('We do not store card numbers. Card details are handled by the payment provider.'),
      ],
    },
    {
      heading: 'Location data',
      blocks: [
        p('The platform records the position of a tracked bike continuously, at intervals set by the device, including outside working hours. It keeps a trip history and can replay where a bike has been.'),
        p('Where the same person always rides the same bike, that is information about a person as much as about a vehicle. A fleet operator using the platform must have a lawful basis for collecting it and must tell its riders what is collected, why, and who can see it.'),
      ],
    },
    {
      heading: 'Why we process it',
      blocks: [
        ul([
          'To provide the platform to the fleet operator who holds the account.',
          'To record agreements, collect payments and show balances.',
          'To raise alerts, run the theft and curfew rules, and send engine commands as configured.',
          'To send operational notifications by email and SMS.',
          'To bill for the subscription and to recover what is owed to us.',
          'To keep the platform secure, investigate abuse and prevent fraud.',
          'To meet obligations under South African law.',
        ]),
      ],
    },
    {
      heading: 'Who else processes it',
      blocks: [
        p('We use these sub-processors:'),
        table(['Provider', 'What for'], SUB_PROCESSORS),
        p('Some of these process information outside South Africa. We will give a fleet operator reasonable notice before adding a sub-processor that handles rider personal information.'),
        p('A fleet operator sees only its own data. We do not share one operator’s information with another.'),
      ],
    },
    {
      heading: 'Security',
      blocks: [
        p('We take reasonable technical and organisational measures to protect the information we hold: encryption in transit, role-based access control, and audit logging of sensitive actions including every engine cut and restore. No system is perfectly secure.'),
        p('If we become aware of a compromise of personal information we process for a fleet operator, we will notify them without undue delay and give them what they reasonably need to meet their own notification duties under POPIA.'),
      ],
    },
    {
      heading: 'How long we keep it',
      blocks: [
        p('We keep information for as long as the account is active and afterwards for as long as the law requires, or as long as it is needed to resolve a dispute or enforce an agreement.'),
        p(`After an account is terminated, the fleet operator has ${EXPORT_DAYS} days to export its data. On request we will delete or return personal information we process on a fleet operator’s behalf, except where we must keep it by law.`),
      ],
    },
    {
      heading: 'Your rights',
      blocks: [
        p('Where we are the responsible party, you may ask to see the personal information we hold about you, ask us to correct it, ask us to delete it subject to our legal retention duties, and object to processing in certain circumstances.'),
        p(`Send a request to ${entity.legalEmail}. You may also complain to the Information Regulator of South Africa.`),
        p('How to make a formal request for access to a record is set out in our PAIA Manual.'),
      ],
    },
    {
      heading: 'Cookies',
      blocks: [
        p('What the platform stores in your browser, and why, is set out in the Cookie Notice.'),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Acceptable Use Policy

const acceptableUse = {
  slug: 'acceptable-use',
  title: 'Acceptable Use Policy',
  updated: UPDATED,
  intro: lead(
    'This policy forms part of the Terms of Use. It sets out what may and may not be done with the platform. ' +
    'It exists mainly because the platform can immobilise a motorcycle, and a tool like that needs limits stated plainly.'
  ),
  sections: [
    {
      heading: 'Accounts and access',
      blocks: [
        ul([
          'Give each person their own login. Do not share one login between people.',
          'Do not share credentials across companies.',
          'Remove a login when someone leaves.',
          'Do not attempt to reach another operator’s data.',
          'Do not test the platform’s security without our written permission. If you find a vulnerability, tell us before you tell anyone else.',
        ]),
      ],
    },
    {
      heading: 'Tracking people',
      blocks: [
        p('A tracker on a bike that one person always rides reports on that person.'),
        ul([
          'Do not track a vehicle you do not own or control.',
          'Do not use the platform to monitor a person who has not been told that the bike they ride is tracked.',
          'Do not use trip history to build a picture of a rider’s life outside their work with you.',
          'Do not pass a rider’s location to anyone who has no lawful reason to have it.',
        ]),
      ],
    },
    {
      heading: 'The immobiliser',
      blocks: [
        p('These are hard limits, not guidance:'),
        ul([
          'Do not immobilise a bike you do not own or control.',
          'Do not immobilise a bike to endanger, punish or coerce a rider.',
          'Do not immobilise a bike when you have been told the rider is in distress or in an unsafe place.',
          'Do not use the immobiliser against a rider in arrears unless your agreement with that rider gives you the right, and you have followed whatever process that agreement and the law require.',
          'Restore a bike promptly once the reason for cutting it has gone.',
        ]),
        p('We may suspend an account where we have reason to believe the immobiliser is being used this way.'),
      ],
    },
    {
      heading: 'Data and content',
      blocks: [
        ul([
          'Do not load personal information you have no right to load.',
          'Do not upload malware, or content that is unlawful, defamatory or infringing.',
          'Do not enter false records — payments not received, inspections not done, readings not taken. Other parts of the platform act on them.',
        ]),
      ],
    },
    {
      heading: 'The platform itself',
      blocks: [
        ul([
          'Do not reverse-engineer, decompile or copy the platform.',
          'Do not resell access, or use the platform to build a competing product.',
          'Do not scrape it outside the documented API, or put load on it that degrades it for other users.',
          'Do not interfere with the tracking endpoint or send commands to devices other than through the platform.',
        ]),
      ],
    },
    {
      heading: 'If this policy is broken',
      blocks: [
        p('We may restrict a feature, suspend an account, or terminate it, depending on what happened and how serious it is. Where the circumstances allow, we will tell you first and give you a chance to put it right. Where a person is at risk, or the law requires it, we may act immediately.'),
        p(`Report a breach of this policy to ${entity.supportEmail}.`),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Cookie Notice

const cookies = {
  slug: 'cookies',
  title: 'Cookie Notice',
  updated: UPDATED,
  intro: lead(
    `${brand.name} keeps a small amount of data in your browser. This notice says what, and why. ` +
    'We do not use advertising cookies and we do not sell anything about your browsing.'
  ),
  sections: [
    {
      heading: 'What we store',
      blocks: [
        table(['What', 'Why', 'How long'], [
          ['Session token', 'Keeps you signed in as you move between screens. Without it you would sign in on every page.', 'Until you sign out or it expires'],
          ['Preferences', 'Remembers choices such as a filter, a chosen view or a collapsed panel.', 'Until you clear your browser'],
          ['Offline cache', 'Lets parts of the rider and fleet apps work on a weak connection.', 'Until you clear your browser'],
          ['Push subscription', 'Delivers alerts to your device, where you have allowed notifications.', 'Until you turn notifications off'],
        ]),
        p('All of these are strictly necessary for the platform to work as a signed-in application, or are set only after you have asked for the feature that needs them.'),
      ],
    },
    {
      heading: 'What we do not do',
      blocks: [
        ul([
          'We do not use advertising or tracking cookies.',
          'We do not share browsing data with advertisers or data brokers.',
          'We do not build a profile of you across other websites.',
        ]),
      ],
    },
    {
      heading: 'Controlling them',
      blocks: [
        p('You can clear or block browser storage in your browser settings. Blocking it will sign you out and may stop parts of the platform from working.'),
        p(`Questions about this notice: ${entity.supportEmail}.`),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Refund and Cancellation Policy

const refunds = {
  slug: 'refunds',
  title: 'Refund and Cancellation Policy',
  updated: UPDATED,
  intro: lead(
    'How to cancel a subscription, and what is refundable. This policy forms part of the Terms of Use and ' +
    'sets out the disclosures required for an electronic transaction under the Electronic Communications and Transactions Act, 2002.'
  ),
  sections: [
    {
      heading: 'What you are buying',
      blocks: [
        p(`A subscription to the ${brand.name} platform, charged per bike per month on the tier you choose, exclusive of VAT. The tiers and what each includes are on the Terms of Use and on the pricing page.`),
        p('Hardware — trackers and fitment — is a separate supply and is not covered by this policy.'),
      ],
    },
    {
      heading: 'Cancelling',
      blocks: [
        p('You can cancel from the billing screen, at any time, without giving a reason.'),
        p('A monthly subscription ends at the end of the cycle you have paid for. You keep full access until then.'),
        p(`An annual subscription ends at the end of the annual term. Because an annual term is charged at ${ANNUAL_MONTHS} months for twelve, the discount is given up front for the whole term.`),
      ],
    },
    {
      heading: 'Refunds',
      blocks: [
        ul([
          'Fees already paid for a period that has started are not refunded, except where the law requires it.',
          'Where we have charged you in error — the wrong bike count, a double charge, a tier you did not select — we refund the difference in full.',
          'Where we terminate your account for a reason that is not your breach, we refund the unused part of what you have paid.',
          'A refund is paid back to the method you paid with, within 30 days of us agreeing it.',
        ]),
        p('Nothing here limits any right you have under the Consumer Protection Act where it applies to you.'),
      ],
    },
    {
      heading: 'Your data when you leave',
      blocks: [
        p(`You have ${EXPORT_DAYS} days after termination to export your data from the platform. Restore any immobilised bike before your account closes — once it is closed, the platform stops sending commands to your devices, including restore commands.`),
      ],
    },
    {
      heading: 'How to ask',
      blocks: [
        p(`Write to ${entity.supportEmail} with your company name and what you are asking for. We will respond within five business days.`),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// PAIA Manual
//
// Section 51 of the Promotion of Access to Information Act requires a private
// body to publish a manual. The page exists so there is somewhere to publish
// it; the parts that need the registered company's own details are marked
// rather than invented.

const paia = {
  slug: 'paia',
  title: 'PAIA Manual',
  updated: UPDATED,
  intro: lead(
    'This manual is published under section 51 of the Promotion of Access to Information Act, 2000 (PAIA). ' +
    'It says what records we hold and how to ask for one.'
  ),
  sections: [
    {
      heading: 'Who we are',
      blocks: [
        entity.legalName
          ? table(['', ''], [
            ['Registered name', entity.legalName],
            ...(entity.tradingAs ? [['Trading as', entity.tradingAs]] : []),
            ...(REGISTRATION_NUMBER ? [['Registration number', REGISTRATION_NUMBER]] : []),
            ['Physical address', entity.address],
            ['Telephone', entity.phone],
            ['Email for PAIA requests', entity.legalEmail],
          ])
          : note('The registered company behind this brand has not yet been recorded here. This manual is incomplete until it is.'),
      ],
    },
    {
      heading: 'The guide published by the Information Regulator',
      blocks: [
        p('The Information Regulator has published a guide on how to use PAIA. It is available from the Regulator in any official language, and explains how to make a request for access to a record.'),
        p('Information Regulator of South Africa, JD House, 27 Stiemens Street, Braamfontein, Johannesburg. Email: inforeg@justice.gov.za'),
      ],
    },
    {
      heading: 'Records we hold',
      blocks: [
        ul([
          'Company records: registration documents, statutory records, financial records, tax records.',
          'Customer records: fleet operator accounts, subscriptions, invoices and correspondence.',
          'Platform records held for customers: bikes, devices, agreements, payments, alerts, position history and audit logs. These are held on behalf of the fleet operator who owns the account.',
          'Employee records.',
          'Supplier and service-provider contracts.',
        ]),
        p('Records held on behalf of a fleet operator belong to that operator. A request for them will normally be referred to them, and we will tell you that we have done so.'),
      ],
    },
    {
      heading: 'How to make a request',
      blocks: [
        p(`Use the prescribed form, available from the Information Regulator’s website, and send it to ${entity.legalEmail}.`),
        ul([
          'Say which record you want and in what form you want it.',
          'Give enough detail for us to identify you and to reach you.',
          'If you are asking for a record in order to exercise or protect a right, say which right and how the record would help.',
        ]),
        p('We will decide within 30 days and tell you. We may extend that period where the Act allows. Where a fee is payable, we will tell you the amount before we proceed. A request may be refused on the grounds set out in the Act, and we will give the reasons.'),
      ],
    },
    {
      heading: 'Records available without a request',
      blocks: [
        p('The Terms of Use, Privacy Policy, Acceptable Use Policy, Cookie Notice and Refund and Cancellation Policy are published on this site and need no request.'),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------

export const LEGAL_DOCS = { terms, privacy, acceptableUse, cookies, refunds, paia };

/** The links shown at the foot of every legal page, and anywhere else they are listed. */
export const LEGAL_LINKS = [
  { to: '/terms', label: 'Terms of Use' },
  { to: '/privacy', label: 'Privacy Policy' },
  { to: '/acceptable-use', label: 'Acceptable Use' },
  { to: '/cookies', label: 'Cookies' },
  { to: '/refunds', label: 'Refunds' },
  { to: '/paia', label: 'PAIA Manual' },
];
