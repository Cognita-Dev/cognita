// Test harness: fakes Firestore, Paystack, Resend, Identity Toolkit, Google certs, KV.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const ROOT = process.env.ROOT || path.join(HERE, '..');
const KEY = fs.readFileSync(path.join(HERE, 'key.pem'), 'utf8');
const CERT = fs.readFileSync(path.join(HERE, 'cert.pem'), 'utf8');
const SA = fs.readFileSync(path.join(HERE, 'sa.pem'), 'utf8');
export const SECRET = 'sk_test_secret';
const PROJECT = 'proj';
export const PLUS = 'PLN_yoh2zim6qlr20c0';
export const STUDIO = 'PLN_23azph4eskh5wwj';

export async function load(file) { return import(pathToFileURL(path.join(ROOT, file)).href); }

export function makeWorld(envOverrides = {}) {
  const docs = new Map();           // path -> encoded fields
  const kv = new Map();
  const emails = [];
  const log = { paystack: [], disableCalls: [] };
  const ps = {
    plans: { [PLUS]: { amount: 450000, currency: 'NGN', interval: 'monthly' }, [STUDIO]: { amount: 1200000, currency: 'NGN', interval: 'monthly' } },
    subs: {}, customers: {}, txs: {}, failNext: null,
  };
  const users = {}; // uid -> {uid,email}
  const fsFail = { n: 0, match: null };

  const env = {
    FIREBASE_PROJECT_ID: PROJECT, FIREBASE_CLIENT_EMAIL: 'sa@proj.iam', FIREBASE_PRIVATE_KEY: SA,
    PAYSTACK_SECRET_KEY: SECRET, APP_ORIGIN: 'https://app.cognita.com.ng', RESEND_API_KEY: 're_x',
    COGNITA_USAGE: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
    },
    ...envOverrides,
  };

  const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    let body = null; try { body = init.body ? JSON.parse(init.body) : null; } catch (_) { body = null; }

    if (u.host === 'oauth2.googleapis.com') return jsonRes({ access_token: 'tok', expires_in: 3600 });
    if (u.host === 'www.googleapis.com' && u.pathname.includes('securetoken')) {
      return new Response(JSON.stringify({ kid1: CERT }), { status: 200, headers: { 'cache-control': 'max-age=3600' } });
    }
    if (u.host === 'identitytoolkit.googleapis.com') {
      const found = Object.values(users).filter(x => (body.localId && body.localId.includes(x.uid)) || (body.email && body.email.includes(x.email)));
      return jsonRes({ users: found.map(x => ({ localId: x.uid, email: x.email, displayName: x.name || '', emailVerified: true })) });
    }
    if (u.host === 'api.resend.com') { emails.push(body); return jsonRes({ id: 'em' }); }

    if (u.host === 'firestore.googleapis.com') {
      const p = decodeURIComponent(u.pathname.split('/documents/')[1] || '');
      if (fsFail.n > 0 && method !== 'GET' && (!fsFail.match || fsFail.match(p, method))) {
        fsFail.n--; return new Response('boom', { status: 500 });
      }
      if (method === 'GET') { if (!docs.has(p)) return new Response('{}', { status: 404 }); return jsonRes({ fields: docs.get(p) }); }
      if (method === 'DELETE') { docs.delete(p); return jsonRes({}); }
      if (method === 'PATCH') {
        const masks = u.searchParams.getAll('updateMask.fieldPaths');
        if (u.searchParams.get('currentDocument.exists') === 'false' && docs.has(p)) {
          return new Response(JSON.stringify({ error: { status: 'ALREADY_EXISTS' } }), { status: 409 });
        }
        const incoming = body.fields || {};
        if (masks.length) {
          const cur = { ...(docs.get(p) || {}) };
          for (const m of masks) if (m in incoming) cur[m] = incoming[m];
          docs.set(p, cur);
        } else docs.set(p, incoming);
        return jsonRes({ fields: docs.get(p) });
      }
    }

    if (u.host === 'api.paystack.co') {
      log.paystack.push(method + ' ' + u.pathname + u.search);
      if (ps.failNext && ps.failNext(method, u.pathname)) return jsonRes({ status: false, message: 'fail' }, 500);
      const pth = u.pathname;
      let m;
      if ((m = pth.match(/^\/plan\/(.+)$/))) {
        const pl = ps.plans[m[1]]; return pl ? jsonRes({ status: true, data: { plan_code: m[1], ...pl } }) : jsonRes({ status: false }, 404);
      }
      if (pth === '/transaction/initialize') {
        const ref = body.reference; ps.txs[ref] = ps.txs[ref] || { status: 'abandoned', reference: ref, amount: ps.plans[body.plan].amount, currency: 'NGN', init: body };
        return jsonRes({ status: true, data: { authorization_url: 'https://checkout.paystack.com/x', access_code: 'a', reference: ref } });
      }
      if ((m = pth.match(/^\/transaction\/verify\/(.+)$/))) {
        const tx = ps.txs[m[1]]; return tx ? jsonRes({ status: true, data: tx }) : jsonRes({ status: false }, 404);
      }
      if ((m = pth.match(/^\/customer\/(.+)$/))) {
        const c = ps.customers[m[1]]; return c ? jsonRes({ status: true, data: { customer_code: m[1], ...c } }) : jsonRes({ status: false }, 404);
      }
      if (pth === '/subscription' && method === 'GET') {
        const cid = Number(u.searchParams.get('customer'));
        return jsonRes({ status: true, data: Object.values(ps.subs).filter(s => s.customerId === cid) });
      }
      if (pth === '/subscription/disable') {
        log.disableCalls.push(body);
        const s = ps.subs[body.code];
        if (!s || s.email_token !== body.token) return jsonRes({ status: false, message: 'bad token' }, 400);
        s.status = 'non-renewing'; return jsonRes({ status: true });
      }
      if ((m = pth.match(/^\/subscription\/(.+)$/))) {
        const s = ps.subs[m[1]]; return s ? jsonRes({ status: true, data: s }) : jsonRes({ status: false }, 404);
      }
    }
    throw new Error('Unmocked fetch: ' + method + ' ' + url);
  };

  const dec = (v) => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'nullValue' in v ? null : 'booleanValue' in v ? v.booleanValue : v;
  const world = {
    env, docs, emails, log, ps, users, fsFail, kv,
    doc(p) { const f = docs.get(p); if (!f) return null; const o = {}; for (const k in f) o[k] = dec(f[k]); return o; },
    setDoc(p, obj) { const f = {}; for (const k in obj) { const v = obj[k]; f[k] = v === null ? { nullValue: null } : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v }; } docs.set(p, f); },
    docsWithPrefix(pre) { return [...docs.keys()].filter(k => k.startsWith(pre)); },
    addUser(uid, email, name) { users[uid] = { uid, email, name }; },
    addCustomer(code, id, email) { ps.customers[code] = { id, email }; },
    addSub(code, o) { ps.subs[code] = { subscription_code: code, email_token: 'tok_' + code, status: 'active', createdAt: new Date().toISOString(), next_payment_date: new Date(Date.now() + 30 * 86400000).toISOString(), ...o }; },
    restore() { globalThis.fetch = realFetch; },
  };
  return world;
}

export function idToken(uid, email) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b({ alg: 'RS256', kid: 'kid1', typ: 'JWT' });
  const pay = b({ iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, sub: uid, iat: now - 5, exp: now + 3000, email, email_verified: true, auth_time: now - 5, firebase: { sign_in_provider: 'google.com' } });
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + pay).sign(KEY).toString('base64url');
  return head + '.' + pay + '.' + sig;
}

export async function callWorker(world, method, pathname, { body, uid, email, raw, headers = {} } = {}) {
  const worker = (await load('worker.js')).default;
  const h = { ...headers };
  if (uid) h.Authorization = 'Bearer ' + idToken(uid, email);
  if (body && !raw) h['Content-Type'] = 'application/json';
  const req = new Request('https://api.cognita.com.ng' + pathname, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const res = await worker.fetch(req, world.env, { waitUntil() {} });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

export function sign(rawBody, secret = SECRET) { return crypto.createHmac('sha512', secret).update(rawBody).digest('hex'); }

export async function sendWebhook(world, event, { secret = SECRET, badSig = false } = {}) {
  const raw = JSON.stringify(event);
  return callWorker(world, 'POST', '/api/payment/webhook', { raw, headers: { 'x-paystack-signature': badSig ? 'deadbeef' : sign(raw, secret) } });
}

// Payload builders that follow Paystack's documented shapes (only charge.success has data.id).
export const ev = {
  charge: ({ reference, amount, uid, planId, email, customerCode = 'CUS_abc', id = 111, currency = 'NGN', paid_at = new Date().toISOString(), metadata } = {}) => ({
    event: 'charge.success',
    data: { id, domain: 'test', status: 'success', reference, amount, currency, paid_at, metadata: metadata ?? { uid, planId }, customer: { id: 5, email, customer_code: customerCode }, plan: {} },
  }),
  subCreate: ({ code = 'SUB_new1', planCode = PLUS, email, customerCode = 'CUS_abc', next } = {}) => ({
    event: 'subscription.create',
    data: { domain: 'test', status: 'active', subscription_code: code, email_token: 'tok_' + code, amount: 450000, plan: { plan_code: planCode, name: 'x', interval: 'monthly' }, customer: { email, customer_code: customerCode }, next_payment_date: next || new Date(Date.now() + 30 * 86400000).toISOString(), createdAt: new Date().toISOString() },
  }),
  notRenew: ({ code, email, customerCode = 'CUS_abc' } = {}) => ({ event: 'subscription.not_renew', data: { domain: 'test', status: 'non-renewing', subscription_code: code, customer: { email, customer_code: customerCode } } }),
  disable: ({ code, email, customerCode = 'CUS_abc' } = {}) => ({ event: 'subscription.disable', data: { domain: 'test', status: 'complete', subscription_code: code, customer: { email, customer_code: customerCode } } }),
  invoiceUpdate: ({ code, email, invoice = 'INV_1', amount = 450000, customerCode = 'CUS_abc', status = 'success', paid_at = new Date().toISOString() } = {}) => ({
    event: 'invoice.update', data: { domain: 'test', invoice_code: invoice, amount, status, paid: status === 'success', paid_at, subscription: { subscription_code: code, status: 'active' }, customer: { email, customer_code: customerCode }, transaction: { reference: 'ref_' + invoice, status: 'success', amount, currency: 'NGN' } },
  }),
  invoiceFailed: ({ code, email, invoice = 'INV_2', customerCode = 'CUS_abc' } = {}) => ({
    event: 'invoice.payment_failed', data: { domain: 'test', invoice_code: invoice, amount: 450000, status: 'failed', paid: false, subscription: { subscription_code: code }, customer: { email, customer_code: customerCode } },
  }),
};

// tiny test runner
const results = [];
export async function test(name, fn) {
  const world = makeWorld();
  try { await fn(world); results.push([name, true]); console.log('  PASS  ' + name); }
  catch (e) { results.push([name, false, e.message]); console.log('  FAIL  ' + name + '\n        -> ' + e.message.split('\n')[0]); }
  finally { world.restore(); }
}
export function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
export function ok(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
export function summary() { const f = results.filter(r => !r[1]); console.log('\n' + (results.length - f.length) + '/' + results.length + ' passed'); return f.length; }
