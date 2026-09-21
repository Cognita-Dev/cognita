import { test, eq, ok, summary, callWorker, sendWebhook, ev, PLUS, STUDIO, load } from './harness.mjs';

const UID = 'uid_alice_1234', EMAIL = 'alice@example.com';
const PRICE = { plus: 450000, studio: 1200000 };

async function initialize(w, planId, uid = UID, email = EMAIL) {
  const r = await callWorker(w, 'POST', '/api/payment/initialize', { body: { planId }, uid, email });
  return r;
}
async function pay(w, planId = 'plus', opts = {}) {
  const r = await initialize(w, planId, opts.uid || UID, opts.email || EMAIL);
  ok(r.status === 200, 'initialize should succeed, got ' + r.status + ' ' + r.text);
  const reference = r.json.reference;
  return { reference, charge: ev.charge({ reference, amount: PRICE[planId], uid: opts.uid || UID, planId, email: opts.email || EMAIL, customerCode: opts.customerCode || 'CUS_abc', id: opts.id || 111 }) };
}
const acct = (w, uid = UID) => w.doc('accounts/' + uid);
const receipts = (w) => w.emails.filter(e => /receipt|renewed/i.test(e.subject));
const cancels = (w) => w.emails.filter(e => /cancelled/i.test(e.subject));

console.log('\nWebhook security');
await test('bad signature is rejected (401)', async (w) => {
  const r = await sendWebhook(w, ev.charge({ reference: 'x', amount: 1 }), { badSig: true });
  eq(r.status, 401);
});
await test('signature made with a different secret is rejected', async (w) => {
  const r = await sendWebhook(w, ev.charge({ reference: 'x', amount: 1 }), { secret: 'sk_test_other' });
  eq(r.status, 401);
});
await test('unhandled event types are acknowledged (200) and ignored', async (w) => {
  const r = await sendWebhook(w, { event: 'transfer.success', data: { id: 1 } });
  eq(r.status, 200);
});

console.log('\nInitialize');
await test('initialize records attempt with exact amount and sends plan + cancel_action', async (w) => {
  w.addUser(UID, EMAIL);
  const r = await initialize(w, 'plus');
  eq(r.status, 200);
  ok(/^cog-[A-Za-z0-9]+-\d+-[a-z0-9]+$/.test(r.json.reference), 'reference charset: ' + r.json.reference);
  const a = w.doc('paymentAttempts/' + r.json.reference);
  eq(a.amountKobo, 450000); eq(a.planId, 'plus'); eq(a.uid, UID);
  const sent = w.ps.txs[r.json.reference].init;
  eq(sent.plan, PLUS);
  ok(sent.metadata.cancel_action.endsWith('/payment-failed.html'), 'cancel_action');
});
await test('invalid / free / admin plans are refused', async (w) => {
  for (const p of ['free', 'admin', 'nope', undefined]) eq((await initialize(w, p)).status, 400, String(p));
});
await test('unauthenticated initialize is refused', async (w) => {
  eq((await callWorker(w, 'POST', '/api/payment/initialize', { body: { planId: 'plus' } })).status, 401);
});
await test('already-active subscriber cannot start a second subscription to the same plan', async (w) => {
  w.setDoc('accounts/' + UID, { uid: UID, planId: 'plus', status: 'active', periodEnd: new Date(Date.now() + 10 * 86400000).toISOString() });
  eq((await initialize(w, 'plus')).status, 409);
});
await test('paystack plan with wrong amount blocks checkout before any charge', async (w) => {
  w.ps.plans[PLUS].amount = 4500; // classic naira/kobo typo
  const r = await initialize(w, 'plus');
  eq(r.status, 500);
  eq(Object.keys(w.ps.txs).length, 0, 'no transaction should be created');
});
await test('LIVE key without PAYSTACK_PLAN_* refuses to use test plan codes', async (w) => {
  w.env.PAYSTACK_SECRET_KEY = 'sk_live_abc';
  eq((await initialize(w, 'plus')).status, 500);
});
await test('LIVE key with PAYSTACK_PLAN_* variables works and uses the live code', async (w) => {
  w.env.PAYSTACK_SECRET_KEY = 'sk_live_abc';
  w.env.PAYSTACK_PLAN_PLUS = 'PLN_live_plus';
  w.ps.plans['PLN_live_plus'] = { amount: 450000, currency: 'NGN', interval: 'monthly' };
  const r = await initialize(w, 'plus');
  eq(r.status, 200);
  eq(w.ps.txs[r.json.reference].init.plan, 'PLN_live_plus');
});

console.log('\nFirst payment');
await test('charge.success then subscription.create: plan active, sub code stored, one receipt', async (w) => {
  w.addUser(UID, EMAIL); w.addCustomer('CUS_abc', 5, EMAIL);
  const { charge } = await pay(w);
  eq((await sendWebhook(w, charge)).status, 200);
  w.addSub('SUB_new1', { customerId: 5, plan: { plan_code: PLUS } });
  eq((await sendWebhook(w, ev.subCreate({ email: EMAIL }))).status, 200);
  const a = acct(w);
  eq(a.planId, 'plus'); eq(a.status, 'active'); eq(a.paystackSubscriptionCode, 'SUB_new1');
  ok(a.paystackCustomerCode === 'CUS_abc');
  eq(receipts(w).length, 1);
});
await test('subscription.create BEFORE charge.success gives the same final state', async (w) => {
  w.addUser(UID, EMAIL); w.addCustomer('CUS_abc', 5, EMAIL);
  const { charge } = await pay(w);
  eq((await sendWebhook(w, ev.subCreate({ email: EMAIL }))).status, 200);
  w.addSub('SUB_new1', { customerId: 5, plan: { plan_code: PLUS } });
  eq((await sendWebhook(w, charge)).status, 200);
  const a = acct(w);
  eq(a.planId, 'plus'); eq(a.status, 'active'); eq(a.paystackSubscriptionCode, 'SUB_new1');
});
await test('replayed webhooks change nothing and send no extra email', async (w) => {
  w.addUser(UID, EMAIL); w.addCustomer('CUS_abc', 5, EMAIL);
  const { charge } = await pay(w);
  await sendWebhook(w, charge);
  const before = JSON.stringify(acct(w));
  for (let i = 0; i < 3; i++) eq((await sendWebhook(w, charge)).status, 200);
  eq(JSON.stringify(acct(w)), before); eq(receipts(w).length, 1);
});
await test('two simultaneous deliveries of the same event: one receipt, correct state', async (w) => {
  w.addUser(UID, EMAIL);
  const { charge } = await pay(w);
  const rs = await Promise.all([sendWebhook(w, charge), sendWebhook(w, charge), sendWebhook(w, charge)]);
  ok(rs.every(r => [200, 503].includes(r.status)), 'statuses ' + rs.map(r => r.status));
  eq(acct(w).planId, 'plus'); eq(receipts(w).length, 1);
});
await test('a transient Firestore failure returns 500 (so Paystack retries) and the retry succeeds', async (w) => {
  w.addUser(UID, EMAIL);
  const { charge } = await pay(w);
  w.fsFail.n = 1; w.fsFail.match = (p) => p === 'accounts/' + UID;
  eq((await sendWebhook(w, charge)).status, 500);
  ok(!acct(w) || acct(w).planId !== 'plus', 'not granted yet');
  eq((await sendWebhook(w, charge)).status, 200);
  eq(acct(w).planId, 'plus'); eq(receipts(w).length, 1);
});
await test('wrong amount paid: no plan granted, issue recorded', async (w) => {
  w.addUser(UID, EMAIL);
  const { reference } = await pay(w);
  const bad = ev.charge({ reference, amount: 10000, uid: UID, planId: 'studio', email: EMAIL });
  eq((await sendWebhook(w, bad)).status, 200);
  ok(!acct(w) || acct(w).planId !== 'studio');
  eq(w.docsWithPrefix('billingIssues/').length, 1);
});
await test('wrong currency: no plan granted', async (w) => {
  w.addUser(UID, EMAIL);
  const { reference } = await pay(w);
  await sendWebhook(w, ev.charge({ reference, amount: 450000, currency: 'USD', uid: UID, planId: 'plus', email: EMAIL }));
  ok(!acct(w) || acct(w).planId !== 'plus');
});
await test('forged metadata with no matching attempt grants nothing (cheap-upgrade attack)', async (w) => {
  const forged = ev.charge({ reference: 'attacker-ref-1', amount: 10000, uid: UID, planId: 'studio', email: EMAIL, metadata: { uid: UID, planId: 'studio' } });
  eq((await sendWebhook(w, forged)).status, 200);
  eq(acct(w), null);
});
await test('metadata planId cannot override the plan chosen at initialize', async (w) => {
  w.addUser(UID, EMAIL);
  const { reference } = await pay(w, 'plus');
  await sendWebhook(w, ev.charge({ reference, amount: 450000, uid: UID, planId: 'admin', email: EMAIL }));
  eq(acct(w).planId, 'plus');
});
await test('subscription.create for an unknown customer returns 500 so it is retried', async (w) => {
  eq((await sendWebhook(w, ev.subCreate({ email: 'nobody@example.com', customerCode: 'CUS_zzz' }))).status, 500);
});

console.log('\nRenewals and failures (payloads without data.id)');
async function activeAccount(w, extra = {}) {
  w.addUser(UID, EMAIL); w.addCustomer('CUS_abc', 5, EMAIL);
  w.setDoc('accounts/' + UID, { uid: UID, planId: 'plus', status: 'active', periodEnd: new Date(Date.now() + 1 * 86400000).toISOString(), paystackSubscriptionCode: 'SUB_new1', paystackCustomerCode: 'CUS_abc', paystackPlanCode: PLUS, ...extra });
  w.setDoc('customerCodeIndex/CUS_abc', { uid: UID });
  w.addSub('SUB_new1', { customerId: 5, plan: { plan_code: PLUS } });
}
await test('invoice.update success extends the period, sends one renewal email, replay is a no-op', async (w) => {
  await activeAccount(w);
  const e = ev.invoiceUpdate({ code: 'SUB_new1', email: EMAIL });
  eq((await sendWebhook(w, e)).status, 200);
  ok(new Date(acct(w).periodEnd) > new Date(Date.now() + 20 * 86400000), 'period extended');
  eq((await sendWebhook(w, e)).status, 200);
  eq(receipts(w).length, 1);
});
await test('invoice.payment_failed moves active -> past_due and emails once', async (w) => {
  await activeAccount(w);
  const e = ev.invoiceFailed({ code: 'SUB_new1', email: EMAIL });
  eq((await sendWebhook(w, e)).status, 200);
  eq(acct(w).status, 'past_due');
  eq(w.emails.filter(x => /could not process/i.test(x.subject)).length, 1);
});
await test('payment failure never resurrects a cancelled account', async (w) => {
  await activeAccount(w, { status: 'cancelled' });
  await sendWebhook(w, ev.invoiceFailed({ code: 'SUB_new1', email: EMAIL }));
  eq(acct(w).status, 'cancelled');
});
await test('renewal after past_due restores active', async (w) => {
  await activeAccount(w, { status: 'past_due' });
  await sendWebhook(w, ev.invoiceUpdate({ code: 'SUB_new1', email: EMAIL }));
  eq(acct(w).status, 'active');
});
await test('renewal that lands after the account was downgraded to free restores the paid plan', async (w) => {
  await activeAccount(w, { planId: 'free', status: 'expired' });
  await sendWebhook(w, ev.invoiceUpdate({ code: 'SUB_new1', email: EMAIL }));
  eq(acct(w).planId, 'plus'); eq(acct(w).status, 'active');
});
await test('failed invoice.update (status failed) does nothing', async (w) => {
  await activeAccount(w);
  const before = JSON.stringify(acct(w));
  await sendWebhook(w, ev.invoiceUpdate({ code: 'SUB_new1', email: EMAIL, status: 'failed' }));
  eq(JSON.stringify(acct(w)), before);
});

console.log('\nCancellation');
await test('cancel via app: Paystack disabled with the right token, account cancelled, one email', async (w) => {
  await activeAccount(w);
  const r = await callWorker(w, 'POST', '/api/subscription/cancel', { uid: UID, email: EMAIL });
  eq(r.status, 200, r.text);
  eq(w.log.disableCalls[0].code, 'SUB_new1'); eq(w.log.disableCalls[0].token, 'tok_SUB_new1');
  eq(acct(w).status, 'cancelled');
  await sendWebhook(w, ev.notRenew({ code: 'SUB_new1', email: EMAIL })); // Paystack then sends not_renew
  eq(cancels(w).length, 1, 'only one cancellation email');
});
await test('SCREENSHOT BUG: account with no stored subscription code is recovered from Paystack and cancelled', async (w) => {
  await activeAccount(w, { paystackSubscriptionCode: null });
  const r = await callWorker(w, 'POST', '/api/subscription/cancel', { uid: UID, email: EMAIL });
  eq(r.status, 200, r.text);
  eq(w.log.disableCalls[0].code, 'SUB_new1');
  eq(acct(w).paystackSubscriptionCode, 'SUB_new1');
});
await test('account whose stored code is really a plan code (PLN_) is recovered too', async (w) => {
  await activeAccount(w, { paystackSubscriptionCode: PLUS });
  eq((await callWorker(w, 'POST', '/api/subscription/cancel', { uid: UID, email: EMAIL })).status, 200);
  eq(w.log.disableCalls[0].code, 'SUB_new1');
});
await test('no findable subscription: clear error, nothing cancelled locally', async (w) => {
  await activeAccount(w, { paystackSubscriptionCode: null, paystackCustomerCode: null });
  const r = await callWorker(w, 'POST', '/api/subscription/cancel', { uid: UID, email: EMAIL });
  eq(r.status, 500); eq(acct(w).status, 'active');
});
await test('Paystack failure during cancel leaves the account active and reports an error', async (w) => {
  await activeAccount(w);
  w.ps.failNext = (m, p) => p === '/subscription/disable';
  eq((await callWorker(w, 'POST', '/api/subscription/cancel', { uid: UID, email: EMAIL })).status, 502);
  eq(acct(w).status, 'active');
});
await test('subscription already cancelled on Paystack (e.g. via their emailed link): no disable call, local state fixed', async (w) => {
  await activeAccount(w);
  w.ps.subs['SUB_new1'].status = 'non-renewing';
  eq((await callWorker(w, 'POST', '/api/subscription/cancel', { uid: UID, email: EMAIL })).status, 200);
  eq(w.log.disableCalls.length, 0); eq(acct(w).status, 'cancelled');
});
await test('cancelling twice is harmless', async (w) => {
  await activeAccount(w);
  await callWorker(w, 'POST', '/api/subscription/cancel', { uid: UID, email: EMAIL });
  const r = await callWorker(w, 'POST', '/api/subscription/cancel', { uid: UID, email: EMAIL });
  eq(r.status, 200); eq(w.log.disableCalls.length, 1);
});
await test('free user cannot cancel', async (w) => {
  eq((await callWorker(w, 'POST', '/api/subscription/cancel', { uid: UID, email: EMAIL })).status, 400);
});
await test('past_due user can cancel to stop future charges', async (w) => {
  await activeAccount(w, { status: 'past_due' });
  eq((await callWorker(w, 'POST', '/api/subscription/cancel', { uid: UID, email: EMAIL })).status, 200);
});
await test('cancelled user keeps access until periodEnd, then falls to free', async (w) => {
  const { getAccount } = await load('subscription.js');
  w.setDoc('accounts/a', { uid: 'a', planId: 'plus', status: 'cancelled', periodEnd: new Date(Date.now() + 86400000).toISOString() });
  eq((await getAccount('a', w.env)).planId, 'plus');
  w.setDoc('accounts/b', { uid: 'b', planId: 'plus', status: 'cancelled', periodEnd: new Date(Date.now() - 86400000).toISOString() });
  eq((await getAccount('b', w.env)).planId, 'free');
});

console.log('\nPlan changes and resubscribing');
await test('upgrade Plus -> Studio: old subscription is disabled, old sub events cannot cancel the new plan', async (w) => {
  await activeAccount(w);
  const { charge } = await pay(w, 'studio');
  w.addSub('SUB_studio1', { customerId: 5, plan: { plan_code: STUDIO } });
  await sendWebhook(w, charge);
  await sendWebhook(w, ev.subCreate({ code: 'SUB_studio1', planCode: STUDIO, email: EMAIL }));
  eq(acct(w).planId, 'studio'); eq(acct(w).paystackSubscriptionCode, 'SUB_studio1');
  eq(w.ps.subs['SUB_new1'].status, 'non-renewing', 'old plan billing stopped');
  await sendWebhook(w, ev.notRenew({ code: 'SUB_new1', email: EMAIL }));
  await sendWebhook(w, ev.disable({ code: 'SUB_new1', email: EMAIL }));
  eq(acct(w).status, 'active', 'new plan must survive the old plan ending');
});
await test('cancel then resubscribe: the old subscription ending later does not cancel the new one', async (w) => {
  await activeAccount(w);
  await callWorker(w, 'POST', '/api/subscription/cancel', { uid: UID, email: EMAIL });
  const { charge } = await pay(w, 'plus', { id: 222 });
  w.addSub('SUB_new2', { customerId: 5, plan: { plan_code: PLUS } });
  await sendWebhook(w, charge);
  await sendWebhook(w, ev.subCreate({ code: 'SUB_new2', email: EMAIL }));
  eq(acct(w).status, 'active');
  await sendWebhook(w, ev.disable({ code: 'SUB_new1', email: EMAIL }));
  eq(acct(w).status, 'active'); eq(acct(w).paystackSubscriptionCode, 'SUB_new2');
});

console.log('\nCallback verification (webhook missing or late)');
await test('status endpoint applies a verified payment when the webhook never arrived', async (w) => {
  w.addUser(UID, EMAIL); w.addCustomer('CUS_abc', 5, EMAIL);
  const { reference } = await pay(w);
  Object.assign(w.ps.txs[reference], { status: 'success', paid_at: new Date().toISOString(), customer: { id: 5, email: EMAIL, customer_code: 'CUS_abc' }, metadata: { uid: UID, planId: 'plus' } });
  const r = await callWorker(w, 'GET', '/api/payment/status?reference=' + reference, { uid: UID, email: EMAIL });
  eq(r.json.status, 'success'); eq(acct(w).planId, 'plus');
  eq((await callWorker(w, 'GET', '/api/payment/status?reference=' + reference, { uid: UID, email: EMAIL })).json.status, 'success');
  eq(receipts(w).length, 1);
});
await test('status endpoint says pending for unpaid and failed for abandoned', async (w) => {
  const { reference } = await pay(w);
  w.ps.txs[reference].status = 'ongoing';
  eq((await callWorker(w, 'GET', '/api/payment/status?reference=' + reference, { uid: UID, email: EMAIL })).json.status, 'pending');
  w.ps.txs[reference].status = 'failed';
  eq((await callWorker(w, 'GET', '/api/payment/status?reference=' + reference, { uid: UID, email: EMAIL })).json.status, 'failed');
});
await test("a user cannot read or trigger someone else's payment", async (w) => {
  const { reference } = await pay(w);
  eq((await callWorker(w, 'GET', '/api/payment/status?reference=' + reference, { uid: 'other', email: 'o@x.com' })).status, 404);
});
await test('status endpoint rejects malformed references', async (w) => {
  eq((await callWorker(w, 'GET', '/api/payment/status?reference=' + encodeURIComponent('../../x'), { uid: UID, email: EMAIL })).status, 400);
});

console.log('\nAccount state rules');
await test('lazy account creation never overwrites a paid account written in the meantime', async (w) => {
  const { fsCreate } = await load('firestore-rest.js');
  w.setDoc('accounts/z', { uid: 'z', planId: 'plus', status: 'active' });
  eq(await fsCreate('accounts/z', { planId: 'free' }, w.env), false);
  eq(w.doc('accounts/z').planId, 'plus');
});
await test('active account far past its period end with no renewal falls to free (missed-webhook safety net)', async (w) => {
  const { getAccount } = await load('subscription.js');
  w.setDoc('accounts/s', { uid: 's', planId: 'plus', status: 'active', periodEnd: new Date(Date.now() - 10 * 86400000).toISOString() });
  eq((await getAccount('s', w.env)).planId, 'free');
  w.setDoc('accounts/t', { uid: 't', planId: 'plus', status: 'active', periodEnd: new Date(Date.now() - 2 * 86400000).toISOString() });
  eq((await getAccount('t', w.env)).planId, 'plus', 'small slack tolerated');
});
await test('cancelled / past_due with no periodEnd fails closed', async (w) => {
  const { getAccount } = await load('subscription.js');
  w.setDoc('accounts/c', { uid: 'c', planId: 'studio', status: 'cancelled' });
  eq((await getAccount('c', w.env)).planId, 'free');
});
await test('past_due keeps access for the 3-day grace period, then ends', async (w) => {
  const { getAccount } = await load('subscription.js');
  w.setDoc('accounts/p1', { uid: 'p1', planId: 'plus', status: 'past_due', periodEnd: new Date(Date.now() - 2 * 86400000).toISOString() });
  eq((await getAccount('p1', w.env)).planId, 'plus');
  w.setDoc('accounts/p2', { uid: 'p2', planId: 'plus', status: 'past_due', periodEnd: new Date(Date.now() - 4 * 86400000).toISOString() });
  eq((await getAccount('p2', w.env)).planId, 'free');
});
await test('addOneMonth matches Paystack billing-day rule', async () => {
  const { addOneMonth } = await load('paystack-client.js');
  eq(addOneMonth(new Date('2026-01-15T10:00:00Z')).toISOString(), '2026-02-15T10:00:00.000Z');
  eq(addOneMonth(new Date('2026-01-31T10:00:00Z')).toISOString(), '2026-02-28T10:00:00.000Z');
  eq(addOneMonth(new Date('2026-12-30T10:00:00Z')).toISOString(), '2027-01-28T10:00:00.000Z');
});

process.exit(summary() ? 1 : 0);
