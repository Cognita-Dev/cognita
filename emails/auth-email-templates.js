// emails/auth-email-templates.js
// The wording and layout of every email Cognita sends: account emails
// (verify, reset, welcome, password changed), billing emails (payment
// received, payment failed, subscription cancelled), reminders and the
// performance digest.
//
// To change WHAT an email says or how it is arranged, edit this file.
// To change colours, fonts or the look of a shared piece (buttons, panels,
// footer), edit email-kit.js. Nothing else in the app builds email HTML.
//
// Each builder returns { subject, html, text, headers? }, which is exactly
// what sendEmail() in mailer.js takes.
//
// Rules for the wording (please keep them when editing)
//  - Say only what the app really does. Every claim about links, grace
//    periods, plans or features below was checked against the code:
//      grace period ......... subscription.js (GRACE_PERIOD_DAYS, passed in)
//      plans after cancelling  entitlements.js (Cognita Starter is the free plan)
//      one-time links ....... Firebase action codes (see auth-email-endpoint.js)
//      digest link lasts 7 days  insights-digest.js (buildInsightsFileUrl)
//    tests/emails.test.mjs fails if the plan claims stop being true.
//  - No invented numbers, dates, tax lines or payment details. A row or
//    section is only drawn when its data exists.
//  - Anything that comes from a person or the AI (names, reminder notes,
//    digest text) is plain text. Only wrapped in md() can text carry links.

import {
  BRAND,
  renderEmail,
  masthead,
  heading,
  sectionTitle,
  para,
  button,
  linkFallback,
  bullets,
  panel,
  details,
  amountHero,
  timeline,
  steps,
  featureCards,
  quote,
  callouts,
  dateTile,
  note,
  md,
} from './email-kit.js';

function hello(name) {
  return name ? 'Hi ' + name + ',' : 'Hi there,';
}

const ASK_US = md('Questions? [Email us](' + BRAND.contact + ').');

// Keeps AI-written paragraphs from stretching an email. The full text is in the PDF.
function clip(value, max) {
  const s = String(value == null ? '' : value).trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, '') + '\u2026';
}

function listOf(value, maxItems, maxChars) {
  return (Array.isArray(value) ? value : [])
    .map((v) => clip(v, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

// ══════════════════════════════════════════════════════════════
// Account emails
// ══════════════════════════════════════════════════════════════

/** Action email: short, one clear button. */
export function buildVerifyEmail({ name, link }) {
  return renderEmail({
    subject: 'Confirm your email to finish setting up Cognita',
    preheader: 'Tap the button to confirm this address. Did not sign up? You can ignore this email.',
    title: 'Confirm your email address',
    reason: 'You are receiving this email because this address was used to sign up for Cognita.',
    blocks: [
      masthead({ icon: 'mail-check', label: 'Account' }),
      heading('Confirm your email address'),
      para(hello(name), { gap: 10 }),
      para('Someone signed up for Cognita with this address. Confirm that it is yours and your account is ready to use.', { lead: true, gap: 22 }),
      button('Confirm email address', link, { gap: 26 }),
      sectionTitle('After you confirm'),
      bullets([
        'You can sign in and start using Cognita.',
        'We send one short welcome email with a few places to start.',
      ], { gap: 22 }),
      panel({
        tone: 'neutral',
        title: 'Did not sign up?',
        body: 'You can ignore this email. The account stays unverified and cannot be used until this address is confirmed.',
      }),
      linkFallback(link),
      para('This link works once and can expire. If it stops working, ask for a new one from the verification page in Cognita.', { small: true, muted: true, gap: 0 }),
    ],
  });
}

/** Security email: calm, direct, the safety guidance stands out. */
export function buildResetEmail({ link }) {
  return renderEmail({
    subject: 'Reset your Cognita password',
    preheader: 'Use the link inside to choose a new password. If it was not you, ignore this email.',
    title: 'Choose a new password',
    reason: 'You are receiving this email because a password reset was requested for your Cognita account.',
    blocks: [
      masthead({ icon: 'lock', label: 'Security' }),
      heading('Choose a new password'),
      para('We received a request to reset the password for your Cognita account. Use the button below to set a new one.', { lead: true, gap: 22 }),
      button('Choose a new password', link, { gap: 16 }),
      para('After you save it, we email you a confirmation that your password changed.', { small: true, muted: true, gap: 24 }),
      panel({
        tone: 'warn',
        title: 'If you did not ask for this',
        body: 'Ignore this email. Your password does not change unless the link above is used.',
        items: [
          'Cognita never asks for your password by email or message.',
          'Choose a password you have not used anywhere else.',
        ],
      }),
      linkFallback(link),
      para('This link works once and can expire. If it stops working, open the sign-in page, enter your email and choose Forgot password? to get a new one.', { small: true, muted: true, gap: 0 }),
    ],
  });
}

/** The richest account email: says what Cognita is and where to start. */
export function buildWelcomeEmail({ name }) {
  return renderEmail({
    subject: 'Your Cognita account is ready',
    preheader: 'Four things you can do today, and three good first steps.',
    title: 'Welcome to Cognita',
    reason: 'You are receiving this email because you created a Cognita account.',
    blocks: [
      heading('Welcome to Cognita'),
      para(hello(name), { gap: 10 }),
      para('Cognita is an AI assistant for real work: writing, studying, planning and making sense of information. Your account is ready, and there is nothing to install. It runs in your browser.', { lead: true, gap: 28 }),
      sectionTitle('What you can do'),
      featureCards([
        ['Think it through', 'Share some context and keep asking. Cognita can compare options, point out trade-offs and question an assumption.'],
        ['Make a real document', 'Ask for a report, proposal, memo, letter or brief and download it as a Word file.'],
        ['Build class and study material', 'Resources creates lesson plans, exams, quizzes, worksheets, flashcards, marking schemes and more.'],
        ['Keep your meetings', 'Note Taker turns a meeting into a summary with action items, and you can ask it questions afterwards.'],
      ]),
      sectionTitle('Three good first steps'),
      steps([
        ['Ask about something real', 'Open a chat and paste in the notes, question or draft you are working on.'],
        ['Try a resource', 'Open Resources in the sidebar, pick a type, describe what you need and edit the result.'],
        ['Set a reminder', 'Add a date in Reminders and choose when to hear about it, from a week before to the event itself.'],
      ]),
      button('Open Cognita', BRAND.site + '/app.html', { gap: 26 }),
      note(md('Something not working, or not sure where to start? [Email us](' + BRAND.contact + ').')),
    ],
  });
}

/** Security notice: the "not me" path is the most prominent thing on the page. */
export function buildPasswordChangedEmail({ name, email, when }) {
  return renderEmail({
    subject: 'Security notice: your Cognita password was changed',
    preheader: when
      ? 'Changed ' + when + '. If this was not you, secure your account now.'
      : 'If this was not you, secure your account now.',
    title: 'Your password was changed',
    reason: 'You are receiving this security notice because the password on your Cognita account changed.',
    blocks: [
      masthead({ icon: 'shield-alert', label: 'Security notice' }),
      heading('Your password was changed'),
      para(hello(name), { gap: 10 }),
      para('The password for your Cognita account was just changed.', { lead: true, gap: 20 }),
      details([
        ['Account', email],
        ['Changed', when],
      ]),
      para(md('**If you made this change,** there is nothing more to do. You may need to sign in again on your other devices.'), { gap: 22 }),
      panel({
        tone: 'danger',
        title: 'If you did not make this change',
        body: 'Someone else may have access to your account. Secure it now:',
        items: [
          'Open the sign-in page, enter your email and choose Forgot password?',
          'Choose a password you have not used anywhere else.',
          md('Tell us at [' + BRAND.contactAddress + '](' + BRAND.contact + ') so we can look into it.'),
        ],
      }),
      button('Secure your account', BRAND.site + '/login.html', { gap: 26 }),
      note('Cognita never asks for your password by email or message.'),
    ],
  });
}

// ══════════════════════════════════════════════════════════════
// Billing emails
// ══════════════════════════════════════════════════════════════

/** A receipt: the amount first, then when it covers, then the reference. */
export function buildPaymentReceiptEmail({ name, planName, amountText, dateText, periodEndText, reference, renewal, accountEmail }) {
  const plan = planName || 'Cognita';
  const stages = [];
  if (dateText) stages.push({ label: 'Paid', value: dateText, state: 'done', tone: 'success' });
  if (periodEndText) stages.push({ label: 'Valid until', value: periodEndText, state: 'now', tone: 'success' });

  const renewsLine = periodEndText
    ? 'Unless you cancel first, your subscription renews on ' + periodEndText + '. You can cancel any time from your account.'
    : 'You can cancel any time from your account.';

  return renderEmail({
    subject: renewal ? 'Your Cognita subscription was renewed' : 'Your Cognita payment was received',
    preheader: periodEndText ? 'Your ' + plan + ' plan is active through ' + periodEndText + '.' : 'Your ' + plan + ' plan is active.',
    title: renewal ? 'Subscription renewed' : 'Payment received',
    reason: 'You are receiving this receipt because a payment was made on your Cognita account.',
    blocks: [
      masthead({ icon: 'receipt-check', label: renewal ? 'Subscription renewal' : 'Payment receipt' }),
      heading(renewal ? 'Subscription renewed' : 'Payment received'),
      para(hello(name), { gap: 10 }),
      para(
        renewal
          ? 'Your ' + plan + ' subscription renewed, so your access carries on without a break.'
          : 'Your payment went through and your ' + plan + ' plan is active.',
        { lead: true, gap: 22 }
      ),
      amountHero({ badge: 'Paid', amount: amountText || plan, caption: amountText ? plan : '' }),
      stages.length ? timeline(stages) : null,
      details([
        ['Account', accountEmail],
        ['Reference', reference, { break: true }],
      ]),
      para(renewsLine, { small: true, muted: true, gap: 22 }),
      button('View your account', BRAND.site + '/account.html', { gap: 26 }),
      note(
        md(
          'Keep this email as your receipt. Something look wrong? [Email us](' + BRAND.contact + ')' +
            (reference ? ' and quote the reference above.' : ' and tell us the date of the payment.')
        )
      ),
    ],
  });
}

/**
 * A payment problem: what failed, what happens to access, and what to do.
 * graceEndText: the last day of the grace period, when it is still ahead.
 * graceDays:    the length of the grace period, used when the date is unknown.
 * graceOver:    true when the grace period has already run out, so the email
 *               must not say access continues.
 */
export function buildPaymentFailedEmail({ name, planName, graceEndText, graceDays, graceOver }) {
  const plan = planName || 'Cognita';
  const graceValue = graceOver
    ? 'May already have ended'
    : graceEndText
    ? graceEndText
    : graceDays
      ? 'Up to ' + graceDays + ' days after your billing date'
      : 'A short grace period';
  const accessLine = graceOver
    ? 'The grace period for this payment has already run out, so your account may have moved to Cognita Starter.'
    : graceEndText
    ? 'You keep your ' + plan + ' features until ' + graceEndText + '.'
    : graceDays
      ? 'You keep your ' + plan + ' features for up to ' + graceDays + ' days after your billing date.'
      : 'You keep your ' + plan + ' features for a short grace period.';

  return renderEmail({
    subject: 'We could not process your Cognita payment',
    preheader: graceOver
      ? 'The latest payment for your ' + plan + ' plan did not go through. Pay again to restore it.'
      : graceEndText
      ? 'Your ' + plan + ' access continues until ' + graceEndText + '. Pay again to keep your plan.'
      : 'The latest payment for your ' + plan + ' plan did not go through.',
    title: 'Your payment did not go through',
    reason: 'You are receiving this billing notice because a payment on your Cognita account failed.',
    blocks: [
      masthead({ icon: 'card-alert', label: 'Billing', badge: 'Action needed', badgeTone: 'danger' }),
      heading('Your payment did not go through'),
      para(hello(name), { gap: 10 }),
      para('We could not process the latest payment for your ' + plan + ' plan, so your subscription is now past due.', { lead: true, gap: 24 }),
      timeline([
        { label: 'Payment failed', value: 'Today', state: 'done', tone: 'danger' },
        { label: graceOver ? 'Plan access' : 'Access continues until', value: graceValue, state: 'now', tone: 'warn' },
        { label: 'Then', value: 'Cognita Starter (free plan)', state: 'next' },
      ]),
      sectionTitle('What to do'),
      steps([
        ['Open your account', 'Go to Account and choose Change plan.'],
        ['Pay for your plan again', 'Select ' + plan + ' and complete the payment.'],
      ]),
      button('Open your account', BRAND.site + '/account.html', { gap: 26 }),
      sectionTitle('What happens to your access'),
      bullets([
        accessLine,
        graceOver
          ? 'Cognita Starter is the free plan, with lower daily limits and without paid features.'
          : 'After that, your account moves to Cognita Starter, the free plan, with lower daily limits and without paid features.',
        'If a later payment goes through, your account returns to normal and we email you a receipt.',
      ], { gap: 22 }),
      note(md('Already sorted this out? You can ignore this email. ' + 'Questions? [Email us](' + BRAND.contact + ').')),
    ],
  });
}

/** Status email: access is the thing the reader wants to know about. */
export function buildSubscriptionCancelledEmail({ name, planName, accessUntilText }) {
  const plan = planName || 'Cognita';
  const until = accessUntilText || 'the end of your current billing period';

  return renderEmail({
    subject: 'Your Cognita subscription was cancelled',
    preheader: 'You keep ' + plan + ' access until ' + until + ', then your account moves to Starter.',
    title: 'Your subscription will not renew',
    reason: 'You are receiving this email because a subscription on your Cognita account was cancelled.',
    blocks: [
      masthead({ icon: 'calendar-x', label: 'Billing', badge: 'Cancelled', badgeTone: 'neutral' }),
      heading('Your subscription will not renew'),
      para(hello(name), { gap: 10 }),
      para('Your ' + plan + ' subscription is cancelled and you will not be charged again.', { lead: true, gap: 24 }),
      sectionTitle('Your access'),
      timeline([
        { label: 'Cancelled', value: 'Today', state: 'done', tone: 'warn' },
        { label: plan + ' access ends', value: accessUntilText || 'End of billing period', state: 'now', tone: 'accent' },
        { label: 'Then', value: 'Cognita Starter (free plan)', state: 'next' },
      ]),
      para('You keep full ' + plan + ' access until ' + until + '.', { gap: 22 }),
      sectionTitle('What changes after that'),
      bullets([
        'Cognita Starter is free and needs no card.',
        'It has lower daily limits than the paid plans, and it does not include connected apps, AI Inbox or Insights Digest.',
        'Chat, document downloads, Resources, Reminders and Note Taker are still there.',
      ], { gap: 22 }),
      sectionTitle('Changed your mind?'),
      para('You can resubscribe at any time.', { gap: 18 }),
      button('Resubscribe', BRAND.site + '/pricing.html', { gap: 12 }),
      button('Manage your account', BRAND.site + '/account.html', { secondary: true, gap: 26 }),
      note(md('Questions about billing? [Email us](' + BRAND.contact + ').')),
    ],
  });
}

// ══════════════════════════════════════════════════════════════
// Reminders and digests
// ══════════════════════════════════════════════════════════════

/**
 * A reminder. `when` is optional: { month, day, weekday, dateText, timeText,
 * timezoneText, timezone, offsetLabel }. Without it the email falls back to
 * whenText, so older callers (and the test email) still work.
 */
export function buildReminderEmail({ title, whenText, notes, url, unsubscribeUrl, when }) {
  const w = when || null;
  const hasTile = !!(w && w.month && w.day);
  const timeLine = w && (w.timeText ? w.timeText + (w.timezoneText ? ' ' + w.timezoneText : '') : 'All day');

  return renderEmail({
    subject: 'Reminder: ' + title,
    preheader: whenText || (w && w.dateText) || 'A reminder you set in Cognita.',
    title: title,
    reason: 'You are receiving this email because you set a reminder in Cognita.',
    unsubscribe: { url: unsubscribeUrl, label: 'Unsubscribe from reminder emails' },
    blocks: [
      masthead({ icon: 'bell', label: 'Reminder' }),
      heading(title),
      hasTile
        ? dateTile({ month: w.month, day: w.day, weekday: w.weekday, headline: timeLine, sub: w.dateText })
        : para(whenText || '', { lead: true, gap: 22 }),
      hasTile
        ? details([
            ['Reminder', w.offsetLabel],
            ['Time zone', w.timezone],
          ])
        : null,
      quote(notes),
      button('Open your reminders', url, { gap: 24 }),
      note('Edit or turn off this reminder any time from Reminders in Cognita.'),
    ],
  });
}

/**
 * The performance digest. Everything shown comes from the digest's own
 * summary: highlights, what worked, what did not, suggestions and best times.
 * There are no numbers here because the summary holds none, so none are shown.
 */
export function buildInsightsDigestEmail({ name, periodLabel, highlights, pdfUrl, unsubscribeUrl, whatWorked, whatDidnt, suggestions, postingTimes }) {
  const points = listOf(highlights, 6, 240);
  const worked = clip(whatWorked, 480);
  const didnt = clip(whatDidnt, 480);
  const tryNext = listOf(suggestions, 5, 200);
  const times = listOf(postingTimes, 4, 120);

  return renderEmail({
    subject: periodLabel ? 'Your Cognita performance digest for ' + periodLabel : 'Your latest Cognita performance digest',
    preheader: points[0] ? clip(points[0], 110) : 'Your performance digest is ready to download.',
    title: 'Your performance digest',
    reason: 'You are receiving this email because you turned on emailed performance digests in Cognita.',
    unsubscribe: { url: unsubscribeUrl, label: 'Unsubscribe from digest emails' },
    blocks: [
      masthead({ icon: 'chart', label: 'Insights' }),
      heading('Your performance digest'),
      para(hello(name), { gap: 10 }),
      para(
        (periodLabel ? 'Here is how your Facebook and Instagram pages did from ' + periodLabel + '.' : 'Here is how your Facebook and Instagram pages did.') +
          ' The full report is a PDF you can download below.',
        { lead: true, gap: 26 }
      ),
      points.length ? sectionTitle('Highlights') : null,
      callouts(points, 'accent'),
      worked ? panel({ tone: 'success', title: 'What worked', body: worked }) : null,
      didnt ? panel({ tone: 'warn', title: 'What did not', body: didnt }) : null,
      tryNext.length ? sectionTitle('What to try next') : null,
      bullets(tryNext, { gap: 24 }),
      times.length ? sectionTitle('Best times to post') : null,
      bullets(times, { gap: 26 }),
      button('Download the full report', pdfUrl, { gap: 26 }),
      panel({
        tone: 'neutral',
        title: 'About this report',
        body: 'The PDF has the full text of each section above. The download link is private to you and works for 7 days; after that, open the digest again from Insights in Cognita.',
      }),
      note('This digest is written by AI from your page insights. Check anything important against Facebook or Instagram before you act on it.'),
    ],
  });
}
