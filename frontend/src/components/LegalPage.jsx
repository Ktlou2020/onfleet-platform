import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import Logo from './Logo';
import brand from '../brand';
import { entity, entityUnconfirmed, contractingParty, LEGAL_LINKS } from '../lib/legalContent';

// One renderer for every legal page.
//
// The documents themselves are data in lib/legalContent.js. This file is only
// how they look, so adding a policy is adding an entry there and a route —
// not another 160-line page that quietly drifts from the others.

const muted = { color: 'var(--muted)', lineHeight: 1.75, fontSize: 15 };

function Block({ block }) {
  if (block.type === 'lead') {
    return (
      <p style={{ ...muted, fontSize: 16, borderLeft: '3px solid var(--primary-light, #1E88D1)', paddingLeft: 14, margin: '0 0 8px' }}>
        {block.text}
      </p>
    );
  }
  if (block.type === 'p') return <p style={{ ...muted, margin: '0 0 12px' }}>{block.text}</p>;
  if (block.type === 'ul') {
    return (
      <ul style={{ ...muted, paddingLeft: 20, margin: '0 0 12px' }}>
        {block.items.map((item, i) => <li key={i} style={{ marginBottom: 6 }}>{item}</li>)}
      </ul>
    );
  }
  if (block.type === 'note') {
    return (
      <p style={{
        ...muted, margin: '0 0 12px', padding: '10px 14px', borderRadius: 8,
        border: '1px solid #d9a44155', background: '#d9a4411a', color: 'var(--text)', fontSize: 14,
      }}>
        {block.text}
      </p>
    );
  }
  if (block.type === 'table') {
    // An empty-string header means the table is a list of labelled values, not
    // a comparison — so the header row is dropped rather than rendered blank.
    const showHead = block.head.some(Boolean);
    return (
      <div style={{ overflowX: 'auto', margin: '0 0 16px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          {showHead && (
            <thead>
              <tr>
                {block.head.map((h, i) => (
                  <th key={i} style={{
                    textAlign: 'left', padding: '0 12px 6px 0', fontSize: 11, letterSpacing: '.06em',
                    textTransform: 'uppercase', color: 'var(--muted)', borderBottom: '1px solid var(--border)',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} style={{
                    padding: '10px 12px 10px 0', borderBottom: '1px solid var(--border)',
                    verticalAlign: 'top', color: j === 0 ? 'var(--text)' : 'var(--muted)', lineHeight: 1.6,
                  }}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

export default function LegalPage({ doc }) {
  useEffect(() => {
    document.title = `${doc.title} — ${brand.fullName}`;
    return () => { document.title = brand.fullName; };
  }, [doc.title]);

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

      <main style={{ maxWidth: 760, margin: '0 auto', padding: '56px 24px 64px' }}>
        <h1 style={{ marginBottom: 8, fontSize: 'clamp(24px, 4vw, 36px)' }}>{doc.title}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 32 }}>Last updated: {doc.updated}</p>

        {/* Terms that name no company bind nobody. Saying so is better than
            printing a placeholder and hoping nobody reads that far. */}
        {entityUnconfirmed && (
          <p style={{
            padding: '12px 16px', borderRadius: 8, marginBottom: 32, fontSize: 14, lineHeight: 1.7,
            border: '1px solid #d9a44155', background: '#d9a4411a', color: 'var(--text)',
          }}>
            <strong>Being finalised.</strong> The registered company behind {brand.name} is not yet recorded on
            this page, and these documents are not in force until it is. For anything you need in writing now,
            contact <a href={`mailto:${entity.legalEmail}`} style={{ color: 'var(--primary-light)' }}>{entity.legalEmail}</a>.
          </p>
        )}

        {doc.intro && <div style={{ marginBottom: 36 }}><Block block={doc.intro} /></div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
          {doc.sections.map((section, i) => (
            <section key={i}>
              <h2 style={{ fontSize: 18, marginBottom: 12 }}>{`${i + 1}. ${section.heading}`}</h2>
              {section.blocks.map((block, j) => <Block key={j} block={block} />)}
            </section>
          ))}

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Contact</h2>
            <p style={{ ...muted, margin: 0 }}>
              {contractingParty && <>{contractingParty}<br /></>}
              {entity.address && <>{entity.address}<br /></>}
              {entity.phone && <>{entity.phone}<br /></>}
              <a href={`mailto:${entity.legalEmail}`} style={{ color: 'var(--primary-light)' }}>{entity.legalEmail}</a>
            </p>
          </section>
        </div>
      </main>

      <footer style={{ borderTop: '1px solid var(--border)', padding: '24px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center', marginBottom: 14 }}>
          {LEGAL_LINKS.filter(l => l.to !== `/${doc.slug}`).map(l => (
            <Link key={l.to} to={l.to} style={{ color: 'var(--muted)' }}>{l.label}</Link>
          ))}
        </div>
        {/* A brand with its own marketing domain sends visitors there; /fleet
            is the other product's pitch and would be the wrong front door. */}
        {brand.marketingUrl
          ? <a href={brand.marketingUrl} style={{ color: 'var(--muted)', textDecoration: 'none' }}>← Back to {brand.name}</a>
          : <Link to="/fleet" style={{ color: 'var(--muted)', textDecoration: 'none' }}>← Back to {brand.name}</Link>}
      </footer>
    </div>
  );
}
