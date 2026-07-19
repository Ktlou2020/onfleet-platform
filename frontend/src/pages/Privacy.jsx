import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import Logo from '../components/Logo';

export default function Privacy() {
  useEffect(() => {
    document.title = 'Privacy Policy — OnFleet Africa';
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
        <h1 style={{ marginBottom: 8, fontSize: 'clamp(24px, 4vw, 36px)' }}>Privacy Policy</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 48 }}>Last updated: July 2026</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Who we are</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              OnFleet Africa (Pty) Ltd operates the OnFleet platform, a fleet management and rider
              payment system for South African delivery motorcycle operators. Our offices are at
              Kya Sand, Johannesburg. If you have questions about this policy, contact us at{' '}
              <a href="mailto:privacy@onfleetafrica.co.za" style={{ color: 'var(--primary-light)' }}>
                privacy@onfleetafrica.co.za
              </a>.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>What we collect and why</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15, marginBottom: 16 }}>
              We collect personal information to operate the platform and to meet our legal
              obligations under the Protection of Personal Information Act (POPIA), Act 4 of 2013.
            </p>
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Riders</div>
              <ul style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.85, paddingLeft: 20, margin: 0 }}>
                <li>Full name, ID number, and date of birth (to verify identity under FICA)</li>
                <li>Driver's licence number and licence category</li>
                <li>Contact details: phone number and email address</li>
                <li>Banking details (for payment collection via Paystack)</li>
                <li>Proof of address</li>
                <li>A photograph (for identity verification)</li>
                <li>GPS location of the bike linked to your agreement, recorded continuously while the bike is active</li>
              </ul>
            </div>
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Fleet owners</div>
              <ul style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.85, paddingLeft: 20, margin: 0 }}>
                <li>Company name and registration number</li>
                <li>Contact name, phone number, and email address</li>
                <li>Billing information (processed via Paystack — we do not store card numbers)</li>
              </ul>
            </div>
            <div className="card">
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Usage and device data</div>
              <ul style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.85, paddingLeft: 20, margin: 0 }}>
                <li>Browser type and device type</li>
                <li>IP address and general location</li>
                <li>Pages visited and actions taken within the platform</li>
              </ul>
            </div>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>How we use your information</h2>
            <ul style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.85, paddingLeft: 20 }}>
              <li>To process and track rider payments and agreements</li>
              <li>To verify rider identity and licence eligibility</li>
              <li>To enable GPS tracking and remote immobilisation of bikes</li>
              <li>To send payment reminders and account notifications</li>
              <li>To comply with POPIA, FICA, and other applicable South African law</li>
              <li>To improve the platform and prevent fraud</li>
            </ul>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>GPS tracking</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              Bikes on our platform are fitted with GPS trackers. Location data is recorded
              continuously while the bike is active and is accessible to the fleet owner and
              to OnFleet Africa staff. By signing an agreement, riders acknowledge and consent
              to this tracking. Location data is retained for a maximum of 12 months.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Who we share your data with</h2>
            <ul style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.85, paddingLeft: 20 }}>
              <li><strong style={{ color: 'var(--text)' }}>Paystack</strong> — payment processing (their privacy policy applies to card and banking data)</li>
              <li><strong style={{ color: 'var(--text)' }}>Fleet owners</strong> — riders' agreement details, payment history, and GPS location are visible to the fleet owner running your agreement</li>
              <li><strong style={{ color: 'var(--text)' }}>Law enforcement</strong> — when required by law or court order</li>
            </ul>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15, marginTop: 16 }}>
              We do not sell personal information to third parties.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Your rights under POPIA</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15, marginBottom: 12 }}>
              You have the right to:
            </p>
            <ul style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.85, paddingLeft: 20 }}>
              <li>Access the personal information we hold about you</li>
              <li>Request correction of inaccurate information</li>
              <li>Request deletion of your data, subject to our legal retention obligations</li>
              <li>Object to processing in certain circumstances</li>
              <li>Lodge a complaint with the Information Regulator of South Africa</li>
            </ul>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15, marginTop: 16 }}>
              To exercise any of these rights, email{' '}
              <a href="mailto:privacy@onfleetafrica.co.za" style={{ color: 'var(--primary-light)' }}>
                privacy@onfleetafrica.co.za
              </a>.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Data retention</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              We retain personal information for as long as the account or agreement is active
              and for a further period as required by FICA and tax law (typically 5 years). GPS
              ping data is retained for 12 months. You may request earlier deletion of data that
              we are not legally required to keep.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Security</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              All data is encrypted in transit (TLS) and at rest. Payment card data is never
              stored on our servers — it is tokenised by Paystack. Access to the platform is
              role-based and access logs are retained for audit purposes.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Changes to this policy</h2>
            <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 }}>
              We will notify registered users of material changes by email. Continued use of
              the platform after the effective date constitutes acceptance of the updated policy.
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
