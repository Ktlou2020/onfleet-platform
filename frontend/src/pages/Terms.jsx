import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import Logo from '../components/Logo';
import { brandName, brandFullName, brandLegal } from '../brand';

// The subscription terms, as the billing code actually charges them.
//
// These numbers are the contract, so they are written out rather than fetched:
// a terms page that says something different depending on what an endpoint
// returns today is not a document anyone can hold us to. They are the same
// numbers as backend/src/services/subscriptionPricing.js (TIERS,
// MINIMUM_BILLABLE_BIKES, ANNUAL_MONTHS_CHARGED), the 14-day trial set in
// backend/src/routes/auth.js, and GRACE_DAYS in subscriptionDunning.js — change
// a rate there and this clause has to be changed with it.
//
// The previous version of this clause said R750 per bike and a free first
// month. That was the pilot pricing in routes/pilot.js, which nothing serves
// any more, so every fleet on the platform had agreed to a rate we do not
// charge and a trial we do not give.
const PLANS = [
  { name: 'Track', perBikeMonthly: 199 },
  { name: 'Manage', perBikeMonthly: 299 },
  { name: 'Complete', perBikeMonthly: 379 },
];
const TRIAL_DAYS = 14;
const MINIMUM_BILLABLE_BIKES = 10;
const ANNUAL_MONTHS_CHARGED = 10;
const GRACE_DAYS = 14;
const MAX_PAYMENT_ATTEMPTS = 4;

export default function Terms() {
  useEffect(() => {
    document.title = `Terms of Service — ${brandFullName}`;
    return () => { document.title = brandFullName; };
  }, []);

  return (
    <div style={{ background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh' }}>
      <header style={{
        borderBottom: '1px solid var(--border)', padding: '0 24px', height: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <Link to="/fleet" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
          <Logo />
        </Link>
        <Link to="/fleet/login" className="btn btn-secondary" style={{ padding: '6px 16px', fontSize: 13 }}>Sign in</Link>
      </header>

      <main style={{ maxWidth: 720, margin: '0 auto', padding: '56px 24px 80px' }}>
        <h1 style={{ marginBottom: 8, fontSize: 'clamp(24px, 4vw, 36px)' }}>Terms of Service</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 48 }}>Last updated: September 2026</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Who these terms apply to</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              These terms apply to fleet owners ("you") who register a company account on the
              {' '}{brandName} platform operated by {brandLegal.provider} ("we", "us", "{brandName}").
              By creating an account you agree to these terms.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>What the platform does</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              {brandName} provides software for managing motorcycle fleets, recording rider agreements,
              collecting weekly rental payments via Paystack, and remotely immobilising bikes fitted
              with compatible GPS trackers. We are a software platform — we are not a party to the
              rental agreement between you and your riders.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Your account</h2>
            <ul style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.85, paddingLeft: 20 }}>
              <li>You must provide accurate company and contact information when registering.</li>
              <li>You are responsible for keeping your login credentials secure.</li>
              <li>You must not share credentials between multiple companies.</li>
              <li>You must be 18 or older and authorised to bind your company to these terms.</li>
            </ul>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Billing</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15, marginBottom: 12 }}>
              Your first {TRIAL_DAYS} days are free. After the trial, the subscription is charged
              via Paystack at your plan's rate per bike per month:{' '}
              {PLANS.map((p, i) => (
                <span key={p.name}>
                  {i === 0 ? '' : i === PLANS.length - 1 ? ' or ' : ', '}
                  {p.name} at R{p.perBikeMonthly}
                </span>
              ))}. Billing begins automatically when the trial ends.
            </p>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15, marginBottom: 12 }}>
              A fleet with fewer than {MINIMUM_BILLABLE_BIKES} bikes on the platform is charged as
              though it had {MINIMUM_BILLABLE_BIKES}. Bikes you have marked sold, paid off or
              written off are not counted. Choosing to pay annually is charged as{' '}
              {ANNUAL_MONTHS_CHARGED} months rather than twelve. Every invoice shows the rate, the
              number of bikes charged for, and the bikes that were excluded.
            </p>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              If a payment fails we will tell you and present the card again, up to{' '}
              {MAX_PAYMENT_ATTEMPTS} attempts in total. You keep full access for {GRACE_DAYS} days
              from the start of the billing period; after that the account is paused until the
              payment goes through, and while it is paused you retain access to the billing screens
              only. There is no contract — you can cancel at any time from the billing screen.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Payment collection fees</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              When you use the platform to collect weekly rider payments via Paystack, a
              processing fee of 3.5% + R1.00 is deducted from each weekly charge before
              the net amount is credited to your Fleet Wallet. A withdrawal fee of 0.5%
              applies when you request a payout to your bank account.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Remote immobilisation</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              The remote immobilisation feature is provided as a debt-recovery tool. You are
              solely responsible for ensuring that your use of it complies with applicable
              South African law, including the National Credit Act and any applicable consumer
              protection legislation. {brandName} is not liable for any loss or damage arising from
              the use or misuse of the immobilisation feature.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Your responsibilities</h2>
            <ul style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.85, paddingLeft: 20 }}>
              <li>You must have a lawful basis to process your riders' personal information.</li>
              <li>You must ensure your rider agreements are legally sound and POPIA-compliant.</li>
              <li>You must not use the platform for any unlawful purpose.</li>
              <li>You must not attempt to circumvent access controls or reverse-engineer the platform.</li>
              <li>You are responsible for the accuracy of data you enter about bikes, riders, and payments.</li>
            </ul>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Uptime and availability</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              We aim to keep the platform available during business hours. We do not guarantee
              uninterrupted access and are not liable for losses caused by downtime, including
              inability to issue remote immobilisation commands during an outage.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Limitation of liability</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              To the maximum extent permitted by law, {brandLegal.provider}'s liability to you is
              limited to the amount you paid us in the three months before the relevant claim.
              We are not liable for indirect, consequential, or special damages, including
              lost revenue, unpaid rider debts, or stolen or damaged bikes.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Termination</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              Either party may terminate the agreement at any time. You can cancel from the
              billing screen. We may suspend or terminate your account if you breach these
              terms or if your subscription remains unpaid beyond the grace period.
              On termination you retain access to export your data for 30 days.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Governing law</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              These terms are governed by South African law. Disputes will be resolved in the
              courts of Gauteng, South Africa.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Changes to these terms</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              We will notify you of material changes by email with at least 14 days' notice.
              Continued use of the platform after the effective date constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Contact</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              Questions about these terms:{' '}
              <a href={`mailto:${brandLegal.legalEmail}`} style={{ color: 'var(--primary-light)' }}>
                {brandLegal.legalEmail}
              </a>
            </p>
          </section>
        </div>
      </main>

      <footer style={{ borderTop: '1px solid var(--border)', padding: '24px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
        <Link to="/fleet" style={{ color: 'var(--muted)', textDecoration: 'none' }}>← Back to {brandName} Fleet</Link>
      </footer>
    </div>
  );
}
