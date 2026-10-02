import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '../src');

// What a person reads.
//
// The mark, the tab icon and the email sender were made to follow the brand
// some time ago. The words were not: fifteen titles and bodies still said
// OnFleet in their own text, so a fleet on a Pillion deployment got "OnFleet
// application approved", and the first email any of their people ever
// received — the password reset — was signed by a company they had never
// bought anything from.
//
// This is a lint rather than a behaviour test, because the failure mode is
// somebody adding the sixteenth. A hard-coded name in a string that goes to a
// person is the thing being prevented; one in a comment, a webhook header or
// a machine's user-agent is not.

const FILES_THAT_TALK_TO_PEOPLE = [
  'routes/applications.js', 'routes/auth.js', 'routes/fleet.js',
  'routes/payments.js', 'routes/pilot.js', 'routes/admin.js',
  'services/notifierPg.js', 'services/dunningService.js', 'services/emailTemplates.js',
];

// Lines that carry words to a person, rather than to a machine or a reader of
// the source.
const SPEAKS_TO_A_PERSON = /(title:|message:|subject|sendEmail\(|body\s*=)/;
const IS_A_COMMENT = /^\s*(\/\/|\*|\/\*)/;

describe('the words a person reads carry the deployment\'s own name', () => {
  it.each(FILES_THAT_TALK_TO_PEOPLE)('%s', (file) => {
    const full = path.join(SRC, file);
    if (!fs.existsSync(full)) return;
    const offenders = fs.readFileSync(full, 'utf8').split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !IS_A_COMMENT.test(line))
      .filter(({ line }) => SPEAKS_TO_A_PERSON.test(line))
      .filter(({ line }) => /OnFleet/.test(line))
      .map(({ line, n }) => `${file}:${n} ${line.trim().slice(0, 90)}`);

    expect(offenders, `hard-coded brand in something a person reads:\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});

describe('and the sign-off tells the truth about who is writing', () => {
  // The address and telephone number belong to the company that trades under
  // the brand. A deployment that owns no motorcycles has no legal entity on
  // purpose, and must not borrow somebody else's door.
  it('OnFleet signs with its own address', () => {
    const { BRANDS } = require_(path.join(SRC, 'brand.js'));
    expect(BRANDS.onfleet.legalEntity.address).toMatch(/Johannesburg/);
  });

  it('and Pillion has none to sign with, rather than OnFleet\'s', () => {
    const { BRANDS } = require_(path.join(SRC, 'brand.js'));
    expect(BRANDS.pillion.legalEntity).toBeNull();
  });
});
