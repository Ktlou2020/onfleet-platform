import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import Logo from '../components/Logo';

export default function Terms() {
  useEffect(() => {
    document.title = 'Terms of Service — OnFleet Africa';
    return () => { document.title = 'OnFleet Africa'; };
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
        <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 48 }}>Last updated: July 2026</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Who these terms apply to</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              These terms apply to fleet owners ("you") who register a company account on the
              OnFleet platform operated by OnFleet Africa (Pty) Ltd ("we", "us", "OnFleet").
              By creating an account you agree to these terms.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>What the platform does</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              OnFleet provides software for managing motorcycle fleets, recording rider agreements,
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
              The platform subscription is charged at R750 per bike per month, billed monthly
              via Paystack. Your first month is free. After the trial, billing begins automatically.
            </p>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              If a payment fails, we will notify you and allow a grace period before restricting
              access. During a billing failure, you retain access to billing screens only.
              There is no contract — you can cancel at any time from the billing screen.
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
              protection legislation. OnFleet is not liable for any loss or damage arising from
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
              To the maximum extent permitted by law, OnFleet Africa's liability to you is
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
              <a href="mailto:legal@onfleetafrica.co.za" style={{ color: 'var(--primary-light)' }}>
                legal@onfleetafrica.co.za
              </a>
            </p>
          </section>
        </div>
      </main>

      <footer style={{ borderTop: '1px solid var(--border)', padding: '24px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
        <Link to="/fleet" style={{ color: 'var(--muted)', textDecoration: 'none' }}>← Back to OnFleet Fleet</Link>
      </footer>
    </div>
  );
}
