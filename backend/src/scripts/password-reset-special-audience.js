const crypto = require('crypto');
const db = require('../db');
const { sendNotification } = require('../services/notifier');

const DEFAULT_TAG = process.env.SPECIAL_AUDIENCE_TAG || 'password-reset-batch-2026-05';
const DRY_RUN = ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN || '').toLowerCase());
const TARGET_EMAILS = [
  'Oddylamakitubi@gmail.com',
  'brianchikakula2@gmail.com',
  'bensonmagwaya1970@gmail.com',
  'finiaszimba@gmail.com',
  'alfredeneya3@gmail.com',
  'chingetimancharles@gmail.com',
  'alexkachilomboh@gmail.com',
  'carrelsodi01@gmail.com',
  'imaluwa996@gmail.com',
  'lolionesemberamiheto65@gmail.com',
  'manirakizajackson33@gmail.com',
  'kumuryangomuha@gmail.com',
  'Kasongatresor38@gmail.com',
  'meshackntahonkiriye@gmail.com',
  'robertgondwe79@gmail.com',
  'Reasonmhlanga457@gmail.com',
  'cananlapias@gmail.com',
  'chindikanikumwenda63@gmail.com',
  'kaweramaibrahim1@gmail.com',
  'fauzaahmedshaban@gmail.com',
  'mpofusaffy@gmail.com',
  'descentncube69@gmail.com',
  'smartmudhina84@gmail.com',
  'giftngwira029@gmail.com',
  'mugojomisimbarashe@gmail.com',
  'boscolouiskuntawira@gmail.com',
  'sanidazulu78@gmail.com',
  'nyukapatrick98@gmail.com',
  'kassimumustafa772@gmail.com',
  'shaibstambuli70@gmail.com',
  'chibuwanier@gmail.com',
  'jossamrodrick35@gmail.com',
  'criftondzumani55@gmail.com',
  'hanneckchinganda@gmail.com',
  'mbuyiseniinnocent1@gmail.com',
  'lawrencemaera@gmail.com',
  'kamyabruce313@gmail.com',
  'mhone4253@gmail.com',
  'zathamhango74@gmail.com',
  'teriakalenga@gmail.com',
  'nkosiprince12@gmail.com',
  'kansiimejinja@gmail.com',
  'mangenahalfredtawanda@gmail.com',
  'mkandawirehenry13@gmail.com',
  'bonganisekabine@gmail.com',
  'josiasmagumbe68@gmail.com',
  'marimbeprosper98@gmail.com',
  'masaisaipiason@gmail.com',
  'thocconamon49@gmail.com',
  'mahlikifreeman@gmail.com',
  'andytimothymbaluko@gmail.com',
  'hlalanathimthombeni3@gmail.com',
  'bosbynicayenzi@gmail.com',
  'chimwemwemwitha100@gmail.com',
  'teedouble349@gmail.com',
  'nyawashamarko@gmail.com',
  'gwambilekakasile@gmail.com',
  'phwetekeleablaham@gmail.com',
  'orlandophiri38@gmail.com',
  'amandankomo128@gmail.com',
  'kmavimbela883@gmail.com',
  'johannesmanzana37@gmail.com',
  'egesimayeni4@gmail.com',
  'elishakachitigu66@gmail.com',
  'brightmdlongwa@gmail.com',
  'achirwa598@gmail.com',
  'ezekielmosala2@gmail.com',
  'ndlovubongani927@gmail.com',
  'danisomo57@gmail.com',
  'chimalizenimasauko4@gmail.com',
  'siphodanmlotshwa@gmail.com',
  'lorganmabhikwa91@gmail.com',
  'sbonisomasoka@gmail.com',
  'mbolerachristophergodfry@gmail.com',
  'colfet1998@gmail.com',
  'bujatolusaka@gmail.com',
  'simangazungu71@gmail.com',
  'moretreefelling@gmail.com',
  'mvulajamesdaniel@gmail.com',
  'hygienemwale15@gmail.com',
  'chrisngwenya394@gmail.com',
  'lovemoremitumbu0@gmail.com',
  'khumbomwandira@gmail.com',
  'nkomothamsanqa932@gmail.com',
  'yvesdjimbele79@gmail.com',
  'kazadizadio71@gmail.com',
  'richietshabalala97@gmail.com',
  'menzitompson@gmail.com',
  'jawadudavies430@gmail.com',
  'bennetnkhalamba39@gmail.com',
  'buluhanamidu@gmail.com',
  'louismkandawire491@gmail.com',
  'lazarussibelo9@gmail.com',
  'sengailenon@gmail.com',
  'mbalingakaluwa@gmail.com'
];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function readEnv(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function parseTags(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeTag(existingValue, tag) {
  const merged = new Set(parseTags(existingValue));
  merged.add(tag);
  return [...merged].join(', ');
}

function passwordResetExpiryIso() {
  const ttlMinutes = Number(readEnv('PASSWORD_RESET_TOKEN_TTL_MINUTES', '60') || 60);
  return new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function buildResetUrl(token) {
  const base = readEnv('FRONTEND_URL', 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

function buildResetMessage(fullName, resetUrl) {
  const firstName = String(fullName || '').split(' ')[0] || 'there';
  const ttlMinutes = readEnv('PASSWORD_RESET_TOKEN_TTL_MINUTES', '60') || 60;
  return `Hi ${firstName},\n\nWe received a request to reset your OnFleet password.\n\nReset link: ${resetUrl}\n\nThis link expires in ${ttlMinutes} minutes. If you did not request this, you can ignore this email.\n\nKind Regards\nOnFleet Team`;
}

async function main() {
  const normalizedEmails = [...new Set(TARGET_EMAILS.map(normalizeEmail).filter(Boolean))];
  if (!normalizedEmails.length) throw new Error('No target emails configured');

  const placeholders = normalizedEmails.map(() => '?').join(',');
  const matchedUsers = db.prepare(`SELECT id, email, full_name, status, user_tags FROM users WHERE deleted_at IS NULL AND lower(email) IN (${placeholders})`).all(...normalizedEmails);
  const matchedEmailSet = new Set(matchedUsers.map((user) => normalizeEmail(user.email)));
  const missingEmails = normalizedEmails.filter((email) => !matchedEmailSet.has(email));

  let taggedCount = 0;
  let emailedCount = 0;
  let skippedInactive = 0;
  let failedCount = 0;
  const failures = [];

  for (const user of matchedUsers) {
    const nextTags = mergeTag(user.user_tags, DEFAULT_TAG);
    if (!DRY_RUN) {
      db.prepare(`UPDATE users SET user_tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(nextTags, user.id);
    }
    taggedCount += 1;

    if (user.status !== 'active') {
      skippedInactive += 1;
      continue;
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(rawToken);
    const resetUrl = buildResetUrl(rawToken);

    try {
      if (!DRY_RUN) {
        db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL`).run(user.id);
        db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, user_agent)
          VALUES (?,?,?,?,?)`).run(user.id, tokenHash, passwordResetExpiryIso(), 'campaign-script', 'password-reset-special-audience');
        await sendNotification({
          userId: user.id,
          channel: 'email',
          type: 'password_reset',
          title: 'Reset your OnFleet password',
          message: buildResetMessage(user.full_name, resetUrl)
        });
      }
      emailedCount += 1;
    } catch (error) {
      failedCount += 1;
      failures.push({ email: user.email, error: error.message });
    }
  }

  console.log('--- Password reset special audience summary ---');
  console.log(`Tag applied: ${DEFAULT_TAG}`);
  console.log(`Dry run: ${DRY_RUN ? 'yes' : 'no'}`);
  console.log(`Target emails supplied: ${normalizedEmails.length}`);
  console.log(`Matched users: ${matchedUsers.length}`);
  console.log(`Tagged users: ${taggedCount}`);
  console.log(`Password reset emails sent: ${emailedCount}`);
  console.log(`Inactive users skipped: ${skippedInactive}`);
  console.log(`Failures: ${failedCount}`);
  if (missingEmails.length) {
    console.log('Missing emails:');
    missingEmails.forEach((email) => console.log(` - ${email}`));
  }
  if (failures.length) {
    console.log('Email failures:');
    failures.forEach((item) => console.log(` - ${item.email}: ${item.error}`));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
