// learna/certificates-endpoint.js
// Claiming and checking certificates.
//   GET  /api/learna/courses/:id/certificate   the learner's eligibility, and their certificate if issued
//   POST /api/learna/courses/:id/certificate   claim: { name }. Issued only if the server finds every requirement met
//   GET  /api/learna/certificates/verify?id=   public check: name, course, date, and whether it was revoked
//
// One certificate per learner per course. The claim is made safe against double clicks and parallel requests by creating
// an index document with fsCreate (create-only), which only one request can win.
import { fsGet, fsSet, fsCreate, fsDelete } from '../firestore-rest.js';
import { evaluateEligibility, newCertificateId, publicCertificate, cleanName, CERT_ID } from './certificates.js';
import { hasCertificate } from './engine.js';
import { ok, fail } from './http.js';

export const CERT = 'learna_certificates/';
const INDEX = (uid, courseId) => 'learna_cert_index/' + uid + '_' + courseId;

export async function handleCertificate({ env, request, uid, course, p, identity }) {
  if (!hasCertificate(course)) return fail('This course does not issue a certificate.', 404, env, 'NO_CERTIFICATE');
  const idx = await fsGet(INDEX(uid, course.id), env);
  const existing = idx ? await fsGet(CERT + idx.certId, env) : null;
  const elig = evaluateEligibility(course, p);
  if (request.method === 'GET') {
    return ok({ eligible: elig.eligible, requirements: elig.requirements, certificate: existing ? publicCertificate(existing) : null, suggestedName: (identity && identity.name) || '' }, env);
  }
  if (request.method !== 'POST') return fail('Not found.', 404, env);
  if (existing) return ok({ certificate: publicCertificate(existing), already: true }, env);
  if (!elig.eligible) return fail('Not every requirement is met yet.', 409, env, 'NOT_ELIGIBLE', { requirements: elig.requirements });
  const body = await request.json().catch(() => ({}));
  const name = cleanName(body.name);
  if (!name) return fail('Enter your full name as it should appear (2 to 80 characters).', 400, env, 'BAD_NAME');
  const certId = newCertificateId();
  const now = new Date().toISOString();
  const won = await fsCreate(INDEX(uid, course.id), { uid, courseId: course.id, certId, createdAt: now }, env);
  if (!won) {
    const again = await fsGet(INDEX(uid, course.id), env);
    const c = again ? await fsGet(CERT + again.certId, env) : null;
    return c ? ok({ certificate: publicCertificate(c), already: true }, env) : fail('Your certificate is being prepared. Try again in a moment.', 409, env);
  }
  const doc = {
    kind: 'certificate', id: certId, uid, courseId: course.id, courseVersion: course.version, courseTitle: course.title, certificateTitle: (course.certificate && course.certificate.title) || 'Certificate of Completion',
    name, issuedAt: now, revoked: false, requirementsMet: elig.requirements.map((r) => ({ label: r.label, detail: r.detail })),
  };
  try { await fsSet(CERT + certId, doc, env); }
  catch (e) { await fsDelete(INDEX(uid, course.id), env).catch(() => {}); throw e; }
  return ok({ certificate: publicCertificate(doc), already: false }, env, 201);
}

export async function verifyCertificate(request, env) {
  const id = String(new URL(request.url).searchParams.get('id') || '').trim().toUpperCase();
  if (!CERT_ID.test(id)) return fail('That is not a valid certificate number. It looks like CGN-XXXX-XXXX-XXXX.', 400, env, 'BAD_ID');
  const doc = await fsGet(CERT + id, env).catch(() => null);
  if (!doc || doc.kind !== 'certificate') return ok({ valid: false }, env);
  return ok({ valid: !doc.revoked, certificate: publicCertificate(doc) }, env);
}
