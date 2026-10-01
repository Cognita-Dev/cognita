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
// Every email follows the same plan, so they feel like one family:
//   banner  ->  short heading and intro  ->  the main button  ->
//   the explanation (steps, details)  ->  questions and answers  ->
//   the button again (long emails)  ->  footer
//
// Rules for the wording (please keep them when editing)
//  - Plain, short sentences. Say what happened, what it means, what to do.
//  - Say only what the app really does. Every claim below was checked against
//    the code or the public site:
//      grace period ......... subscription.js (GRACE_PERIOD_DAYS, passed in)
//      plans and perks ...... entitlements.js (billing-emails.js builds the lists)
//      Starter is the free plan, no card ... entitlements.js and the pricing page
//      one-time links ....... Firebase action codes (see auth-email-endpoint.js)
//      resend cooldown ...... verify-email.html (one minute)
//      digest link lasts 7 days ... insights-digest.js (buildInsightsFileUrl)
//      not used to train models ... the site FAQ and the Privacy Policy
//      connected apps ....... the site FAQ (GitHub, Google, Facebook and Instagram, Canva)
//  - No invented numbers, dates, refund rules or payment details. A row or
//    section is only drawn when its data exists.
//  - Anything that comes from a person or the AI (names, reminder notes,
//    digest text) is plain text. Only text wrapped in md() can carry links.

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
  iconGrid,
  faq,
  quote,
  callouts,
  dateTile,
  note,
  md,
} from './email-kit.js';

function hello(name) {
  return name ? 'Hi ' + name + ',' : 'Hi there,';
}

const EMAIL_US = md('Email us at [' + BRAND.contactAddress + '](' + BRAND.contact + ').');

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

export function buildVerifyEmail({ name, link }) {
  return renderEmail({
    subject: 'Confirm your email to finish setting up Cognita',
    preheader: 'Press the button to confirm this address. Did not sign up? You can ignore this email.',
    title: 'Confirm your email address',
    reason: 'You are receiving this email because this address was used to sign up for Cognita.',
    hero: { name: 'verify', tone: 'accent' },
    blocks: [
      masthead({ label: 'Account' }),
      heading('Confirm your email address'),
      para(hello(name), { gap: 10 }),
      para('Thanks for signing up for Cognita. Before you can start, we need to check that this email address belongs to you. It takes one press.', { lead: true, gap: 24 }),
      button('Confirm email address', link, { gap: 14 }),
      para('This link works once and can expire.', { small: true, muted: true }),

      sectionTitle('What happens next'),
      steps([
        ['Press the button', 'It opens a Cognita page that confirms your address.'],
        ['Sign in', 'Sign in the same way you signed up.'],
        ['Start using Cognita', 'We send one short welcome email with ideas for where to start.'],
      ]),

      sectionTitle('Why we ask you to confirm'),
      para('Confirming stops anyone from using an email address that is not theirs. Until you confirm, the account cannot be used.', { gap: 0 }),

      sectionTitle('Common questions'),
      faq([
        ['I did not sign up for Cognita. What should I do?', 'Ignore this email. The account cannot be used until this address is confirmed, so nothing else will happen.'],
        ['The button does not work.', 'Copy the link at the bottom of this email and paste it into your browser.'],
        ['The link says it expired or was already used.', 'Open Cognita and go to the verification page. Choose Resend verification email and we will send a new link. You can ask again after one minute.'],
        ['I typed the wrong email address.', 'On the verification page, choose Wrong email? Sign out. Then sign up again with the right address.'],
      ]),
      linkFallback(link),
    ],
  });
}

export function buildResetEmail({ link }) {
  return renderEmail({
    subject: 'Reset your Cognita password',
    preheader: 'Use the link inside to choose a new password. If it was not you, ignore this email.',
    title: 'Choose a new password',
    reason: 'You are receiving this email because a password reset was requested for your Cognita account.',
    hero: { name: 'reset', tone: 'accent' },
    blocks: [
      masthead({ label: 'Security' }),
      heading('Choose a new password'),
      para('We received a request to reset the password for your Cognita account. If this was you, press the button below to choose a new one.', { lead: true, gap: 24 }),
      button('Choose a new password', link, { gap: 14 }),
      para('This link works once and can expire.', { small: true, muted: true }),

      sectionTitle('How it works'),
      steps([
        ['Press the button', 'It opens a Cognita page where you can set a new password.'],
        ['Save your new password', 'Pick one you have not used anywhere else.'],
        ['Sign in again', 'Use your new password. We also email you to confirm that it changed.'],
      ]),

      panel({
        tone: 'warn',
        title: 'Tips for a safe password',
        items: [
          'Use a different password for every site and app.',
          'Longer is stronger. A few random words are easy to remember and hard to guess.',
          'Keep it private. Cognita never asks for your password by email or message.',
        ],
      }),

      sectionTitle('Common questions'),
      faq([
        ['I did not ask for this.', 'Ignore this email. Your password stays the same unless the link is used. If these emails keep coming, write to us.'],
        ['The button does not work.', 'Copy the link at the bottom of this email and paste it into your browser.'],
        ['The link stopped working.', 'Reset links work once and can expire. Open the sign-in page, type your email and choose Forgot password? to get a new link.'],
        ['Will I be signed out on my other devices?', 'You may need to sign in again on your other devices after the change.'],
        ['How will I know the change worked?', 'We send you an email as soon as your password changes.'],
      ]),
      linkFallback(link),
      note(EMAIL_US),
    ],
  });
}

export function buildWelcomeEmail({ name }) {
  return renderEmail({
    subject: 'Your Cognita account is ready',
    preheader: 'Here is what Cognita can do, and four easy things to try first.',
    title: 'Welcome to Cognita',
    reason: 'You are receiving this email because you created a Cognita account.',
    hero: { name: 'welcome', tone: 'accent' },
    blocks: [
      heading('Welcome to Cognita'),
      para(hello(name), { gap: 10 }),
      para('Cognita is an AI assistant for real work. You can use it to write, study, plan and think through decisions. Your account is ready, and there is nothing to install. It runs in your browser.', { lead: true, gap: 24 }),
      button('Open Cognita', BRAND.site + '/app.html', { gap: 0 }),

      sectionTitle('What you can do in Cognita'),
      iconGrid([
        ['message', 'Chat and think things through'],
        ['file-text', 'Make Word documents'],
        ['clipboard', 'Build class and study material'],
        ['mic', 'Turn meetings into notes'],
        ['bell', 'Get reminders for dates'],
        ['image', 'Create images and diagrams'],
      ]),

      sectionTitle('Four easy things to try first'),
      steps([
        ['Ask about something you are working on', 'Open a chat and type or paste what you have: rough notes, a question or a draft. Then say what you want, such as "Make this clearer" or "What are the pros and cons?".'],
        ['Turn it into a document', 'When the answer looks right, ask for a report, letter, memo, proposal or brief. Cognita prepares it and you can download it as a Word file.'],
        ['Try Resources if you teach or study', 'Open Resources in the sidebar, pick a type such as a lesson plan, quiz or flashcards, and describe what you need. You can edit the result.'],
        ['Set a reminder', 'Open Reminders, add a date and choose when to hear about it: a week before, a day before, the morning of, an hour before, or at the time. Cognita tells you by email or notification.'],
      ]),

      sectionTitle('Good to know'),
      faq([
        ['Do I need to install anything?', 'No. Cognita runs in your browser, on a computer or a phone.'],
        ['Is Cognita free?', md('You can start for free on Cognita Starter, with no card needed. Paid plans give you higher daily limits and more features. You can see them on the [pricing page](' + BRAND.site + '/pricing.html).')],
        ['Can I connect my other apps?', 'Yes, on paid plans. Cognita can connect to GitHub, Google, Facebook and Instagram, and Canva. It only acts when you ask, and it always asks you to confirm before it changes anything.'],
        ['Are my chats used to train AI models?', 'No. Your conversations are used only to write your replies, never to train models.'],
        ['What if I get stuck?', md('Email us at [' + BRAND.contactAddress + '](' + BRAND.contact + ') and tell us what you were trying to do.')],
      ]),
      button('Open Cognita', BRAND.site + '/app.html', { gap: 12 }),
      button('See the plans', BRAND.site + '/pricing.html', { secondary: true, gap: 0 }),
    ],
  });
}

export function buildPasswordChangedEmail({ name, email, when }) {
  return renderEmail({
    subject: 'Security notice: your Cognita password was changed',
    preheader: when
      ? 'Changed ' + when + '. If this was not you, secure your account now.'
      : 'If this was not you, secure your account now.',
    title: 'Your password was changed',
    reason: 'You are receiving this security notice because the password on your Cognita account changed.',
    hero: { name: 'password-changed', tone: 'warn' },
    blocks: [
      masthead({ label: 'Security notice' }),
      heading('Your password was changed'),
      para(hello(name), { gap: 10 }),
      para('The password for your Cognita account was just changed. Here is what we recorded:', { lead: true, gap: 20 }),
      details([
        ['Account', email],
        ['Changed', when],
      ]),

      sectionTitle('Was this you?'),
      panel({
        tone: 'success',
        title: 'Yes, I changed it',
        body: 'Great. There is nothing more to do. You may need to sign in again on your other devices, using your new password.',
      }),
      panel({
        tone: 'danger',
        title: 'No, I did not change it',
        body: 'Someone else may have access to your account. Please act now.',
      }),
      steps([
        ['Reset your password', 'Open the sign-in page, type your email and choose Forgot password?'],
        ['Choose a new password', 'Pick one you have not used anywhere else.'],
        ['Tell us', md('Email us at [' + BRAND.contactAddress + '](' + BRAND.contact + ') so we can look into it.')],
      ]),
      button('Secure your account', BRAND.site + '/login.html', { gap: 0 }),

      sectionTitle('Keeping your account safe'),
      bullets([
        'Use a different password for every site and app. If you used this one elsewhere, change it there too.',
        'Never share your password, even with someone who says they work for Cognita.',
        'Cognita never asks for your password by email or message.',
      ], { gap: 0 }),

      sectionTitle('Common questions'),
      faq([
        ['Why did I get this email?', 'We send this notice after a password reset, so you can spot a change you did not make.'],
        ['How do I know this email is really from Cognita?', 'It comes from noreply@cognita.com.ng and never asks for your password. If you are unsure, do not use the button. Type app.cognita.com.ng into your browser instead.'],
        ['I cannot sign in any more.', 'Open the sign-in page and choose Forgot password? to set a new one. If that does not work, email us and we will help.'],
      ]),
    ],
  });
}

// ══════════════════════════════════════════════════════════════
// Billing emails
// ══════════════════════════════════════════════════════════════

/**
 * A receipt: the amount first, then what it covers, then the reference.
 * perks: plain sentences about what the plan includes (from billing-emails.js).
 */
export function buildPaymentReceiptEmail({ name, planName, amountText, dateText, periodEndText, reference, renewal, accountEmail, perks }) {
  const plan = planName || 'Cognita';
  const stages = [];
  if (dateText) stages.push({ label: 'Paid', value: dateText, state: 'done', tone: 'success' });
  if (periodEndText) stages.push({ label: 'Valid until', value: periodEndText, state: 'now', tone: 'success' });
  const perkList = (Array.isArray(perks) ? perks : []).filter(Boolean);

  return renderEmail({
    subject: renewal ? 'Your Cognita subscription was renewed' : 'Your Cognita payment was received',
    preheader: periodEndText ? 'Your ' + plan + ' plan is active through ' + periodEndText + '.' : 'Your ' + plan + ' plan is active.',
    title: renewal ? 'Subscription renewed' : 'Payment received',
    reason: 'You are receiving this receipt because a payment was made on your Cognita account.',
    hero: { name: 'receipt', tone: 'success' },
    blocks: [
      masthead({ label: renewal ? 'Subscription renewal' : 'Payment receipt' }),
      heading(renewal ? 'Subscription renewed' : 'Payment received'),
      para(hello(name), { gap: 10 }),
      para(
        renewal
          ? 'Your ' + plan + ' subscription has renewed, so your access carries on without a break. Here is your receipt.'
          : 'Your payment went through and your ' + plan + ' plan is now active. Here is your receipt.',
        { lead: true, gap: 22 }
      ),
      amountHero({ badge: 'Paid', amount: amountText || plan, caption: amountText ? plan : '' }),
      stages.length ? timeline(stages) : null,
      details([
        ['Account', accountEmail],
        ['Reference', reference, { break: true }],
      ], { gap: 24 }),
      button('View your account', BRAND.site + '/account.html', { gap: 0 }),

      perkList.length ? sectionTitle('What is included in ' + plan) : null,
      bullets(perkList, { gap: 0 }),

      sectionTitle('About your subscription'),
      bullets([
        periodEndText
          ? 'Your subscription renews on ' + periodEndText + ', unless you cancel first.'
          : 'Your subscription renews automatically, unless you cancel first.',
        'You can cancel any time in your account. You keep your access until the end of the period you paid for.',
        'We email a receipt each time you are charged.',
      ], { gap: 0 }),

      sectionTitle('Common questions'),
      faq([
        ['Where can I see my plan?', 'Open Account in Cognita. It shows your plan and its status.'],
        ['How do I change or cancel my plan?', 'Open Account, then choose Change plan or Cancel subscription.'],
        ['Something looks wrong on this receipt.', md('Email us at [' + BRAND.contactAddress + '](' + BRAND.contact + ')' + (reference ? ' and include the reference above.' : ' and tell us the date of the payment.'))],
        ['Who handles my payment?', 'Payments are processed by Paystack. Cognita does not see or keep your card details.'],
      ]),
      note('Keep this email as your receipt.'),
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
    ? 'The extra time for this payment has already run out, so your account may have moved to Cognita Starter.'
    : graceEndText
    ? 'You keep your ' + plan + ' features until ' + graceEndText + '.'
    : graceDays
      ? 'You keep your ' + plan + ' features for up to ' + graceDays + ' days after your billing date.'
      : 'You keep your ' + plan + ' features for a short time.';

  return renderEmail({
    subject: 'We could not process your Cognita payment',
    preheader: graceOver
      ? 'The latest payment for your ' + plan + ' plan did not go through. Pay again to restore it.'
      : graceEndText
      ? 'Your ' + plan + ' access continues until ' + graceEndText + '. Pay again to keep your plan.'
      : 'The latest payment for your ' + plan + ' plan did not go through.',
    title: 'Your payment did not go through',
    reason: 'You are receiving this billing notice because a payment on your Cognita account failed.',
    hero: { name: 'payment-failed', tone: 'danger' },
    blocks: [
      masthead({ label: 'Billing', badge: 'Action needed', badgeTone: 'danger' }),
      heading('Your payment did not go through'),
      para(hello(name), { gap: 10 }),
      para('We tried to take the latest payment for your ' + plan + ' plan, but it did not go through. Your subscription is now past due.', { lead: true, gap: graceOver ? 24 : 12 }),
      graceOver ? null : para('You do not lose anything yet. You still have access while you sort this out.', { gap: 24 }),
      timeline([
        { label: 'Payment failed', value: 'Today', state: 'done', tone: 'danger' },
        { label: graceOver ? 'Plan access' : 'Access continues until', value: graceValue, state: 'now', tone: 'warn' },
        { label: 'Then', value: 'Cognita Starter (free plan)', state: 'next' },
      ]),

      sectionTitle('How to fix it'),
      steps([
        ['Open your account', 'Go to Account in Cognita and choose Change plan.'],
        ['Choose ' + plan, 'Select the same plan you already have.'],
        ['Pay again', 'You will go to a secure Paystack page to complete the payment.'],
      ]),
      button('Open your account', BRAND.site + '/account.html', { gap: 0 }),

      sectionTitle('What happens to your access'),
      bullets([
        accessLine,
        graceOver
          ? 'Cognita Starter is the free plan, with lower daily limits and without paid features.'
          : 'After that, your account moves to Cognita Starter. It is free, with lower daily limits and without paid features.',
        'If a later payment goes through, your account goes back to normal and we email you a receipt.',
      ], { gap: 0 }),

      sectionTitle('Common questions'),
      faq([
        ['Why did the payment fail?', 'We do not always get a reason. Payments can fail if a card has expired, the balance is too low, or the bank declined the charge. Your bank can tell you more.'],
        ['I already paid.', 'Then you can ignore this email. Once a payment goes through, your account goes back to normal and we send you a receipt.'],
        ['I do not want to keep this plan.', 'You can cancel in Account. Cancelling stops future charges.'],
        ['I need help.', md('Email us at [' + BRAND.contactAddress + '](' + BRAND.contact + ') and tell us what happened.')],
      ]),
    ],
  });
}

/**
 * A cancellation. losses: what the plan had that Starter does not (from
 * billing-emails.js).
 */
export function buildSubscriptionCancelledEmail({ name, planName, accessUntilText, losses }) {
  const plan = planName || 'Cognita';
  const until = accessUntilText || 'the end of your current billing period';
  const lossList = (Array.isArray(losses) ? losses : []).filter(Boolean);

  return renderEmail({
    subject: 'Your Cognita subscription was cancelled',
    preheader: 'You keep ' + plan + ' access until ' + until + ', then your account moves to Starter.',
    title: 'Your subscription will not renew',
    reason: 'You are receiving this email because a subscription on your Cognita account was cancelled.',
    hero: { name: 'cancelled', tone: 'stone' },
    blocks: [
      masthead({ label: 'Billing', badge: 'Cancelled', badgeTone: 'neutral' }),
      heading('Your subscription will not renew'),
      para(hello(name), { gap: 10 }),
      para('Your ' + plan + ' subscription is cancelled, and you will not be charged again. You can keep using ' + plan + ' until ' + until + '.', { lead: true, gap: 24 }),
      timeline([
        { label: 'Cancelled', value: 'Today', state: 'done', tone: 'warn' },
        { label: plan + ' access ends', value: accessUntilText || 'End of billing period', state: 'now', tone: 'accent' },
        { label: 'Then', value: 'Cognita Starter (free plan)', state: 'next' },
      ]),

      sectionTitle('What happens after ' + (accessUntilText || 'that')),
      para('Your account moves to Cognita Starter. It is free and needs no card.', { gap: 18 }),
      sectionTitle('What you keep on Starter'),
      bullets([
        'Chat, with lower daily limits',
        'Document downloads',
        'Resources for class and study material',
        'Reminders',
        'Note Taker for meetings',
      ], { gap: 0 }),
      lossList.length ? sectionTitle('What you will no longer have') : null,
      bullets(lossList, { gap: 0 }),

      sectionTitle('Changed your mind?'),
      para('You can come back any time. Choose Resubscribe and pick a plan.', { gap: 18 }),
      button('Resubscribe', BRAND.site + '/pricing.html', { gap: 12 }),
      button('Manage your account', BRAND.site + '/account.html', { secondary: true, gap: 0 }),

      sectionTitle('Common questions'),
      faq([
        ['Will I be charged again?', 'No. Your subscription is cancelled and will not renew.'],
        ['Can I still use Cognita after ' + (accessUntilText || 'that date') + '?', 'Yes. You will be on Cognita Starter, which is free.'],
        ['Can I get my plan back?', 'Yes. Choose Resubscribe on the pricing page at any time.'],
        ['I did not cancel.', md('Email us at [' + BRAND.contactAddress + '](' + BRAND.contact + ') straight away so we can check your account.')],
        ['I have a question about a refund.', md('Email us at [' + BRAND.contactAddress + '](' + BRAND.contact + ') and tell us about the payment.')],
      ]),
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
    hero: { name: 'reminder', tone: 'accent' },
    blocks: [
      masthead({ label: 'Reminder' }),
      heading(title),
      para('You asked Cognita to remind you about this.', { gap: 22 }),
      hasTile
        ? dateTile({ month: w.month, day: w.day, weekday: w.weekday, headline: timeLine, sub: w.dateText })
        : para(whenText || '', { lead: true, gap: 22 }),
      hasTile
        ? details([
            ['You asked to be told', w.offsetLabel],
            ['Time zone', w.timezone],
          ])
        : null,
      quote(notes),
      button('Open your reminders', url, { gap: 0 }),

      sectionTitle('Managing this reminder'),
      bullets([
        'Open Reminders in Cognita to change the date, the notes or when you want to be told.',
        'You can choose a week before, a day before, the morning of, an hour before, or the time itself.',
        'You can delete a reminder from the same page when you no longer need it.',
      ], { gap: 0 }),

      sectionTitle('Common questions'),
      faq([
        ['Why did I get this email?', 'You set a reminder in Cognita, and this is the time you chose to be told.'],
        ['The time looks wrong.', w && w.timezone ? 'The time is shown in the time zone saved with the reminder (' + w.timezone + '). Open the reminder to change it.' : 'The time is shown in the time zone saved with the reminder. Open the reminder to change it.'],
        unsubscribeUrl
          ? ['How do I stop reminder emails?', 'Use the Unsubscribe link at the bottom of this email. You can turn reminder emails back on later from the page it opens. App notifications are separate.']
          : null,
      ]),
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
    hero: { name: 'digest', tone: 'accent' },
    blocks: [
      masthead({ label: 'Insights' }),
      heading('Your performance digest'),
      para(hello(name), { gap: 10 }),
      para(
        (periodLabel ? 'Here is how your Facebook and Instagram pages did from ' + periodLabel + '.' : 'Here is how your Facebook and Instagram pages did.') +
          ' Below is a short summary. The full report is a PDF you can download.',
        { lead: true, gap: 24 }
      ),
      button('Download the full report', pdfUrl, { gap: 0 }),

      points.length ? sectionTitle('Highlights') : null,
      callouts(points, 'accent'),
      worked ? panel({ tone: 'success', title: 'What worked', body: worked }) : null,
      didnt ? panel({ tone: 'warn', title: 'What did not work as well', body: didnt }) : null,
      tryNext.length ? sectionTitle('What to try next') : null,
      bullets(tryNext, { gap: 0 }),
      times.length ? sectionTitle('Best times to post') : null,
      bullets(times, { gap: 0 }),

      sectionTitle('Common questions'),
      faq([
        ['What is in the full report?', 'The PDF has the full text of each section above: highlights, what worked, what did not, ideas to try next, and the best times to post.'],
        ['How is the digest made?', 'Cognita collects your page insights from Facebook and Instagram, and an AI writes the summary from them. It is told to use only your page numbers. Still, check anything important in Facebook or Instagram before you act on it.'],
        ['How often will I get one?', 'Once a week or once a month, depending on your Insights settings.'],
        ['The download link stopped working.', 'The link is private to you and works for 7 days. After that, open Insights in Cognita to get the report again.'],
        unsubscribeUrl
          ? ['How do I stop these emails?', 'Use the Unsubscribe link at the bottom of this email. You can still read every digest in Insights.']
          : null,
      ]),
      button('Download the full report', pdfUrl, { gap: 0 }),
    ],
  });
}
