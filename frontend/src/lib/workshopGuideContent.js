import { ClipboardList, CalendarClock, FileSpreadsheet, LifeBuoy, Search, Upload } from 'lucide-react';

// What the workshop guide says. Kept apart from the guide shell so the tracking
// guide can use the same shell with its own content.

export const WORKSHOP_SECTIONS = [
  {
    id: 'job-card',
    title: 'Running a job card',
    icon: ClipboardList,
    forRole: 'everyone',
    summary: 'One visit by one bike: what was found, what was fitted, what it cost, and the odometer when it left.',
    steps: [
      ['open', 'Open the card and check the registration against the bike in front of you.',
        'The card shows the rider, the fleet, the odometer the trackers have recorded, and the bike\'s service history.'],
      ['start', 'Press Start job.',
        'This starts the work timer, which is what the Technicians tab reports on. Stopping for parts or lunch? Press Pause work timer — paused time is not counted against you.'],
      ['schedule', 'Read the Service schedule panel, under the bike details.',
        'It tells you what Hero say this bike needs at the kilometres on its clock.'],
      ['odometer', 'Type the real odometer reading into Current km.',
        'The schedule panel re-reads itself as you type, so the recommendation matches the bike rather than the last thing a tracker saw.'],
      ['lines', 'Add every part and every hour.',
        'Parts the schedule recommends go on with one press of Add, carrying their part number and price. Typing a part? Pick it from the catalogue so the number comes with it.'],
      ['photos', 'Photograph anything worn, damaged or disputable.'],
      ['complete', 'Complete the job: notes, odometer, and the bike\'s status afterwards.',
        'Two things will stop you: a job on a bike cannot close without an odometer reading, and a job with no parts and no labour asks you to confirm you are closing it uncosted.'],
    ],
    links: [{ label: 'Open job cards', to: '/workshop/app/job-cards', adminTo: '/admin/workshop' }],
  },
  {
    id: 'schedule',
    title: 'The service schedule',
    icon: CalendarClock,
    forRole: 'everyone',
    summary: 'Hero\'s maintenance chart and 36-month schedule, loaded — so the job card says what this bike needs.',
    steps: [
      ['services', 'Know which service the bike is at.',
        'Eleven services from 500 km to 30 500 km, then repeating every 3 000 km. Each has a 500 km window, so 12 400 km and 12 500 km are both service 5.'],
      ['due', 'Fit everything under Replace now.',
        'Each part comes with its Hero number and price. A part fitted recently is left out, and says when it was last fitted.'],
      ['soon', 'Consider what is under Worth doing while it is here.',
        'Anything falling due within the next 1 500 km — cheaper now than bringing the bike back.'],
      ['checklist', 'Work the check list for that service.',
        'Every item from Hero\'s chart, in words: Inspect, Clean, Adjust if required, Lubricate, Replace, Oil change, Top up, Emission check.'],
    ],
    interactive: 'schedule',
  },
  {
    id: 'parts',
    title: 'Finding a part',
    icon: Search,
    forRole: 'everyone',
    summary: '860 parts and 21 kits from Hero\'s dealer price list, every one priced.',
    steps: [
      ['name', 'Search by what the part is called — "brake pads" finds KIT, BRAKE SHOE.',
        'Each word is matched separately and the parts matching more of them come first.'],
      ['number', 'Or search the number stamped on the part.',
        'Dashes, spaces and capitals make no difference: 12391AAK900S, 12391-aak-900-s and 12391 AAK 900 S all find the same part.'],
      ['old', 'The old number works too.',
        'Searching 90463-ML7-000 finds 90463KRM840S, the part that replaced it.'],
      ['exact', 'Order the number the price list gives you — never one off a note or from memory.',
        'Hero supply only against the number requested, and issue no quotation at all if the numbers are missing. A wrong number comes back rejected and the bike waits.'],
    ],
    interactive: 'parts',
    links: [{ label: 'Open parts search', to: '/workshop/app/parts', adminTo: '/admin/workshop?tab=Parts' }],
  },
  {
    id: 'ordering',
    title: 'Ordering from Hero',
    icon: FileSpreadsheet,
    forRole: 'admin',
    summary: 'The platform builds the request from the work, writes it onto Hero\'s own form, and tracks what comes back.',
    steps: [
      ['needs', 'Read "What the workshop needs" under Workshop → Parts orders.',
        'Built from bikes whose service is due and parts on open job cards. The same part across several bikes is added up; anything already on an open order is left off.'],
      ['untick', 'Untick anything you do not want. The Why column says where each line came from.'],
      ['blocked', 'Deal with any line marked "not in the price list".',
        'Use the number Hero do sell, order it anyway with a reason, or untick it. Read the description, not just the number — the clutch cable\'s nearest number was the cable\'s rubber boot at a tenth of the price.'],
      ['create', 'Press Create RFQ. This makes a draft — nothing has left the building yet.'],
      ['check', 'Open it and download the RFQ to check the finished form.',
        'It is Hero\'s own template: their letterhead, their field order, their line numbering, with only the dates, our details and the lines filled in.'],
      ['send', 'Email it to Hero, stating whether we collect or they courier.',
        'Goes to parts@heromotorcycles.co.za with the form attached. You will be asked to confirm — this is a real request for quotation.'],
      ['track', 'Record their quote reference when it lands, then mark the order placed and received.',
        'Quotes are valid 30 days. They pick and dispatch within 48 hours of payment or a purchase order. Parts on a received order count as needed again next time.'],
    ],
    links: [{ label: 'Open parts orders', to: '/admin/workshop?tab=Parts%20orders', adminTo: '/admin/workshop?tab=Parts%20orders' }],
  },
  {
    id: 'price-list',
    title: 'Loading a price list',
    icon: Upload,
    forRole: 'admin',
    summary: 'When Hero send an updated list, load it yourself.',
    steps: [
      ['fields', 'Workshop → Parts → Upload a parts list. Set make and model to match the bikes: Hero, Eco 150.',
        'The catalogue is searched from job cards by make and model, so a list filed under "ECO 150 (Dec, 2019)" would never be found.'],
      ['preview', 'Press "Check it first".',
        'It reads the file without saving anything and reports what it found on each sheet.'],
      ['upload', 'Press Upload.',
        'Re-uploading refreshes prices rather than duplicating parts. A sheet named Kits is marked as kits.'],
    ],
  },
  {
    id: 'trouble',
    title: 'When something is wrong',
    icon: LifeBuoy,
    forRole: 'everyone',
    summary: 'The messages you will actually meet, and what to do about each.',
    trouble: [
      ['No service schedule loaded', 'The bike is not a Hero Eco 150', 'Service it from the manufacturer\'s book; ask an admin to load that model\'s chart.'],
      ['A part shows "not in the price list"', 'The schedule\'s number is not one Hero sell', 'Use the closest number if the description matches, or check with Hero. One is known: the tappet cover gasket.'],
      ['A part number finds nothing', 'Not in this list, or a typo', 'Search the part\'s name instead. Two letters is the minimum.'],
      ['"This job has no parts or labour recorded"', 'Nothing was costed on the card', 'Add the lines. If it genuinely cost nothing, confirm and close.'],
      ['"Odometer reading is required"', 'A bike\'s card cannot close without the clock reading', 'Read it off the bike and enter it.'],
      ['An order will not create', 'A line carries a number Hero do not sell', 'Swap it, override it with a reason, or untick it.'],
      ['"No email provider is configured"', 'The RFQ could not be emailed', 'Download it and send it from your own mail. The order stays a draft.'],
    ],
  },
];

export const ACTION_CODES = [
  ['I', 'Inspect'], ['C', 'Clean'], ['A', 'Adjust if required'], ['R', 'Replace'],
  ['O', 'Oil change'], ['T', 'Top up'], ['L', 'Lubricate'], ['E', 'Emission check'],
];

export const INTERVALS = [
  ['Engine oil', 'Replace every 6 000 km; top up every 3 000 km'],
  ['Air cleaner element', 'Clean at every service; replace every 15 000 km, sooner in dust'],
  ['Drive chain', 'Inspect, clean, lubricate and adjust every 2 000 km'],
  ['Front fork oil', 'Replace every two years or 30 000 km, whichever is first'],
  ['Services', '500 km, then every 3 000 km — 11 published, repeating after 30 500 km'],
];

