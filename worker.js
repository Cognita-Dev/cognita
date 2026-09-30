// worker.js
// Main Cloudflare Worker entry point. 

import { handlePlansRequest } from './plans-endpoint.js';
import { handleChatRequest } from './chat-endpoint.js';
import { handleImageRequest } from './image-endpoint.js';
import { handleDocumentRequest } from './document-endpoint.js';
import {
  handleResourceGenerate,
  handleResourceDownload,
  handleResourceFileProxy,
  handleResourceImageProxy,
  handleResourceCardImage,
  handleResourceList,
  handleResourceEdit,
  handleResourceRegenerate,
} from './resources-endpoint.js';
import { handlePaymentInitialize, handlePaymentStatus } from './payment-endpoint.js';
import { handlePaystackWebhook } from './webhook-endpoint.js';
import { handleAccountRequest, handleUsageRequest } from './account-endpoint.js';
import { handleAccountDeletionRequest } from './account-deletion-endpoint.js';
import { handleSubscriptionCancel } from './cancel-endpoint.js';
import { handleChatSave, handleChatDelete, handleChatList, handleChatGet } from './chat-sync-endpoint.js';
import { handleFilesList, handleFileGet } from './files-endpoint.js';
import {
  handleAdminResourceCreate,
  handleAdminResourceBatchCreate,
  handleAdminResourceEdit,
  handleAdminResourceTransition,
  handleAdminResourceList,
  handleAdminResourceGet,
  handleAdminResourceVersions,
  handleAdminResourceDelete,
} from './admin-resources-endpoint.js';
import {
  handleCollectionCreate,
  handleCollectionEdit,
  handleCollectionResourceEdit,
  handleAdminCollectionList,
  handleCollectionDelete,
  handlePublicCollectionList,
} from './collections-endpoint.js';
import {
  handleLibraryList,
  handleLibraryGet,
  handleLibraryDownload,
  handleLibraryFileProxy,
  handleLibraryCollectionGet,
} from './library-endpoint.js';
import {
  handleAdminBootstrap,
  handleAdminWhoAmI,
  handleAdminRoleList,
  handleAdminRoleGrant,
  handleAdminRoleRevoke,
  handleAdminRoleLookupEmail,
} from './admin-roles-endpoint.js';
import {
  handleNoteSessionCreate,
  handleNoteSession,
  handleNoteSessionSegment,
  handleNoteChunkTranscribe,
  handleNoteQuota,
} from './note-taker-endpoint.js';
import { handleNotesList, handleNoteGet, handleNoteSave, handleNoteDelete, handleNoteSummary } from './saved-notes-endpoint.js';
import { handleSendVerificationEmail, handleSendPasswordReset } from './emails/auth-email-endpoint.js';
import { handleSendWelcomeEmail, handlePasswordChangedNotice } from './emails/account-email-endpoint.js';
import {
  handleConnectorStart,
  handleConnectorCallback,
  handleConnectorStatus,
  handleConnectorDisconnect,
} from './connectors-endpoint.js';
import {
  handleFacebookDataDeletion,
  handleDataDeletionStatus,
  handleLinkFacebookLogin,
} from './facebook-data-deletion.js';
import {
  handleReminderCreate,
  handleReminderList,
  handleReminderUpdate,
  handleReminderDelete,
  handleSubscribe,
  handleUnsubscribe,
  handleTestNotification,
  handleReminderEmailStatus,
  handleReminderEmailResubscribe,
} from './reminders/reminders-endpoint.js';
import { runReminderScheduler } from './reminders/reminders-scheduler.js';
import {
  handleSocialPagesList,
  handleScheduleCreate,
  handleScheduleList,
  handleScheduleCancel,
  handleSocialMediaUpload,
  handleSocialMediaProxy,
} from './social-scheduler-endpoint.js';
import { runSocialScheduler } from './social-scheduler.js';
import { checkIpRateLimit, checkRateBinding, clientIp } from './rate-limit.js';
import { verifyFirebaseIdToken } from './auth-middleware.js';
import {
  handleInboxList,
  handleInboxSubscribe,
  handleInboxRegenerate,
  handleInboxReply,
  handleInboxDismiss,
  handleInboxMarkSpam,
} from './social-inbox-endpoint.js';
import { handleMetaWebhookVerify, handleMetaWebhookEvent } from './webhooks/meta-webhook-endpoint.js';
import {
  handleInsightsScheduleGet,
  handleInsightsScheduleUpsert,
  handleInsightsGenerate,
  handleInsightsHistory,
  handleInsightsFileProxy,
} from './insights-endpoint.js';
import { runInsightsDigestScheduler } from './insights-digest.js';
import { handleEmailUnsubscribe } from './emails/unsubscribe.js';

function _corsPreflight(env) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': env.APP_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Note-Language, X-Note-Context, X-Audio-Duration-Ms',
      'Access-Control-Max-Age': '86400',
    },
  });
}

const _app = {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return _corsPreflight(env);

  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/api/note-quota') return handleNoteQuota(request, env);
  if (request.method === 'POST' && url.pathname === '/api/note-sessions') return handleNoteSessionCreate(request, env);
  if (/^\/api\/note-sessions\/[^/]+\/segments$/.test(url.pathname) && request.method === 'POST') return handleNoteSessionSegment(request, env, url.pathname.split('/')[3]);
  if (/^\/api\/note-sessions\/[^/]+\/transcribe$/.test(url.pathname) && request.method === 'POST') return handleNoteChunkTranscribe(request, env, url.pathname.split('/')[3]);
  if (/^\/api\/note-sessions\/[^/]+$/.test(url.pathname) && ['GET', 'PATCH'].includes(request.method)) return handleNoteSession(request, env, url.pathname.split('/')[3]);

  if (url.pathname === '/api/notes' && request.method === 'GET') return handleNotesList(request, env);
  if (url.pathname === '/api/notes' && request.method === 'POST') return handleNoteSave(request, env);
  if (url.pathname === '/api/note-summary' && request.method === 'POST') return handleNoteSummary(request, env);
  if (/^\/api\/notes\/[^/]+$/.test(url.pathname) && request.method === 'GET') return handleNoteGet(request, env, url.pathname.split('/')[3]);
  if (/^\/api\/notes\/[^/]+$/.test(url.pathname) && request.method === 'DELETE') return handleNoteDelete(request, env, url.pathname.split('/')[3]);

  if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Cognita Worker is running.', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/send-verification') {
      return handleSendVerificationEmail(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/send-password-reset') {
      return handleSendPasswordReset(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/send-welcome') {
      return handleSendWelcomeEmail(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/notify-password-changed') {
      return handlePasswordChangedNotice(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/plans') {
      return handlePlansRequest(env);
    }

    if (request.method === 'GET' && url.pathname === '/api/account') {
      return handleAccountRequest(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/usage') {
      return handleUsageRequest(request, env);
    }

    // Self-serve "delete my account"
    if (request.method === 'POST' && url.pathname === '/api/account/delete') {
      return handleAccountDeletionRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      return handleChatRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/chat/save') {
      return handleChatSave(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/chat/delete') {
      return handleChatDelete(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/chat/list') {
      return handleChatList(request, env);
    }

    if (request.method === 'GET' && /^\/api\/chat\/[^/]+$/.test(url.pathname)) {
      const conversationId = url.pathname.split('/')[3];
      return handleChatGet(request, env, conversationId);
    }

    if (request.method === 'POST' && url.pathname === '/api/image') {
      return handleImageRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/document') {
      return handleDocumentRequest(request, env);
    }

    if (request.method === 'GET' && /^\/api\/files\/[^/]+$/.test(url.pathname)) {
      const conversationId = url.pathname.split('/')[3];
      return handleFilesList(request, env, conversationId);
    }

    if (request.method === 'GET' && /^\/api\/files\/[^/]+\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split('/');
      const conversationId = parts[3];
      const fileId = parts[4];
      return handleFileGet(request, env, conversationId, fileId);
    }

    if (request.method === 'POST' && url.pathname === '/api/resources/generate') {
      return handleResourceGenerate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/resources/list') {
      return handleResourceList(request, env);
    }

    if (request.method === 'POST' && /^\/api\/resources\/[^/]+\/download$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[3];
      return handleResourceDownload(request, env, resourceId);
    }

    if (request.method === 'GET' && /^\/api\/resources\/[^/]+\/file$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[3];
      return handleResourceFileProxy(request, env, resourceId);
    }

    // Makes the picture for one flashcard (one small request per card).
    if (request.method === 'POST' && /^\/api\/resources\/[^/]+\/cards\/\d+\/image$/.test(url.pathname)) {
      const parts = url.pathname.split('/');
      return handleResourceCardImage(request, env, parts[3], parts[5]);
    }

    if (request.method === 'GET' && /^\/api\/resources\/[^/]+\/image$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[3];
      return handleResourceImageProxy(request, env, resourceId);
    }

    if (request.method === 'POST' && /^\/api\/resources\/[^/]+\/edit$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[3];
      return handleResourceEdit(request, env, resourceId);
    }

    if (request.method === 'POST' && /^\/api\/resources\/[^/]+\/regenerate$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[3];
      return handleResourceRegenerate(request, env, resourceId);
    }

    if (request.method === 'POST' && url.pathname === '/api/payment/initialize') {
      return handlePaymentInitialize(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/payment/status') {
      return handlePaymentStatus(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/payment/webhook') {
      return handlePaystackWebhook(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/subscription/cancel') {
      return handleSubscriptionCancel(request, env);
    }

    // ── Reminders ──────────────────────────────────────

    if (request.method === 'POST' && url.pathname === '/api/reminders') {
      return handleReminderCreate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/reminders') {
      return handleReminderList(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/reminders/subscribe') {
      return handleSubscribe(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/reminders/unsubscribe') {
      return handleUnsubscribe(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/reminders/email-status') {
      return handleReminderEmailStatus(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/reminders/email-resubscribe') {
      return handleReminderEmailResubscribe(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/reminders/test-notification') {
      return handleTestNotification(request, env);
    }

    if (request.method === 'PATCH' && /^\/api\/reminders\/[^/]+$/.test(url.pathname)) {
      const reminderId = url.pathname.split('/')[3];
      return handleReminderUpdate(request, env, reminderId);
    }

    if (request.method === 'DELETE' && /^\/api\/reminders\/[^/]+$/.test(url.pathname)) {
      const reminderId = url.pathname.split('/')[3];
      return handleReminderDelete(request, env, reminderId);
    }

    // ── Social Scheduler (Facebook/Instagram, via the Facebook connector) ─
    if (request.method === 'GET' && url.pathname === '/api/social/pages') {
      return handleSocialPagesList(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/social/schedule') {
      return handleScheduleCreate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/social/schedule') {
      return handleScheduleList(request, env);
    }

    if (request.method === 'DELETE' && /^\/api\/social\/schedule\/[^/]+$/.test(url.pathname)) {
      const postId = url.pathname.split('/')[4];
      return handleScheduleCancel(request, env, postId);
    }

    // Upload a photo/video to attach to a scheduled post (requireAuth,
    // like every other /api/social/* route above).
    if (request.method === 'POST' && url.pathname === '/api/social/media') {
      return handleSocialMediaUpload(request, env);
    }

    // Hit directly by Meta's Graph API servers when publishing a post
    // that has media attached — never by the browser, so it deliberately
    // sits outside requireAuth. See social-media-endpoint.js's header
    // comment for why a signed token is the access check here instead.
    if (request.method === 'GET' && url.pathname === '/api/social/media/file') {
      return handleSocialMediaProxy(request, env);
    }

    // ── AI Inbox (unified Facebook/Instagram comment + DM triage) ──────
    // Sits right after Social Scheduler, same style of comment header.

    if (request.method === 'GET' && url.pathname === '/api/inbox') {
      return handleInboxList(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/inbox/subscribe') {
      return handleInboxSubscribe(request, env);
    }

    if (request.method === 'POST' && /^\/api\/inbox\/[^/]+\/regenerate$/.test(url.pathname)) {
      const itemId = url.pathname.split('/')[3];
      return handleInboxRegenerate(request, env, itemId);
    }

    if (request.method === 'POST' && /^\/api\/inbox\/[^/]+\/reply$/.test(url.pathname)) {
      const itemId = url.pathname.split('/')[3];
      return handleInboxReply(request, env, itemId);
    }

    if (request.method === 'POST' && /^\/api\/inbox\/[^/]+\/dismiss$/.test(url.pathname)) {
      const itemId = url.pathname.split('/')[3];
      return handleInboxDismiss(request, env, itemId);
    }

    if (request.method === 'POST' && /^\/api\/inbox\/[^/]+\/spam$/.test(url.pathname)) {
      const itemId = url.pathname.split('/')[3];
      return handleInboxMarkSpam(request, env, itemId);
    }

    // Hit directly by Meta's servers — Webhooks product, separate from
    // the OAuth login flow. No Authorization header will ever be
    // present, same category as the Data Deletion callback above, so it
    // deliberately sits outside requireAuth; handleMetaWebhookEvent does
    // its own HMAC-signature check on the raw body instead.
    if (request.method === 'GET' && url.pathname === '/webhooks/meta') {
      return handleMetaWebhookVerify(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/meta') {
      return handleMetaWebhookEvent(request, env, ctx);
    }

    // ── AI Insights Digest (AI-written performance report as PDF) ─────

    if (request.method === 'GET' && url.pathname === '/api/insights/schedule') {
      return handleInsightsScheduleGet(request, env);
    }

    if (request.method === 'PUT' && url.pathname === '/api/insights/schedule') {
      return handleInsightsScheduleUpsert(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/insights/generate') {
      return handleInsightsGenerate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/insights/history') {
      return handleInsightsHistory(request, env);
    }

    // ── Email unsubscribe ──────────────────────────────
    // Opened from a link in an email, or POSTed to by Gmail / Yahoo / Apple
    // Mail's own Unsubscribe button. No login: the signed token in the link
    // is the access check. See emails/unsubscribe.js.
    if (url.pathname === '/api/email/unsubscribe' && (request.method === 'GET' || request.method === 'POST')) {
      return handleEmailUnsubscribe(request, env);
    }

    // Hit directly by the browser (email link click) or a WhatsApp link
    // preview fetch — no Authorization header possible, signed token is
    // the access check, same pattern as /api/social/media/file above.
    if (request.method === 'GET' && url.pathname === '/api/insights/file') {
      return handleInsightsFileProxy(request, env);
    }

    // ── Connectors (GitHub, Google, Facebook, Canva) ─────

    // Must come before the /:provider/start check below, since both
    // match a "/api/connectors/<segment>" shape.
    if (request.method === 'GET' && url.pathname === '/api/connectors/status') {
      return handleConnectorStatus(request, env);
    }

    if (request.method === 'GET' && /^\/api\/connectors\/[^/]+\/start$/.test(url.pathname)) {
      const provider = url.pathname.split('/')[3];
      return handleConnectorStart(request, env, provider);
    }

    if (request.method === 'POST' && /^\/api\/connectors\/[^/]+\/disconnect$/.test(url.pathname)) {
      const provider = url.pathname.split('/')[3];
      return handleConnectorDisconnect(request, env, provider);
    }

    // Hit directly by the provider's redirect after the user approves
    // (or denies) access — not an /api/ route, no Authorization header
    // will ever be present here. See connectors-endpoint.js for why.
    if (request.method === 'GET' && /^\/auth\/[^/]+\/callback$/.test(url.pathname)) {
      const provider = url.pathname.split('/')[2];
      return handleConnectorCallback(request, env, provider);
    }

    // ── Meta "Data Deletion Request" callback ──────────────────────────
    // Hit directly by Meta's servers (both the login app and the social/
    // connector app point at this same URL — see facebook-data-deletion.js
    // for how it tells the two apart). No Authorization header, no CORS
    // concerns: this is a server-to-server POST, never a browser fetch.
    if (request.method === 'POST' && url.pathname === '/auth/facebook/data-deletion') {
      return handleFacebookDataDeletion(request, env);
    }

    // Public status lookup for the confirmation code the callback above
    // hands back to Meta (and that a person may be shown by Meta's UI, or
    // type into data-deletion-status.html's manual-entry form). Codes
    // themselves are 80-bit random tokens — not practically guessable —
    // but the endpoint is public and unauthenticated by necessity, so it
    // gets its own IP-based throttle rather than none at all, to blunt
    // scripted hammering. 20 requests/minute per IP is generous for a
    // person checking their own status by hand, and low value for anyone
    // trying to script abuse.
    if (request.method === 'GET' && /^\/api\/data-deletion-status\/[^/]+$/.test(url.pathname)) {
      const rl = await checkIpRateLimit(request, env, 'del-status', { limit: 20, windowSeconds: 60 });
      if (!rl.allowed) {
        return new Response(JSON.stringify({ error: 'Too many requests. Please try again in a minute.' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.resetInSeconds) },
        });
      }
      const code = url.pathname.split('/')[3];
      return handleDataDeletionStatus(request, env, code);
    }

    // Called by the frontend right after "Continue with Facebook" signs
    // someone in, so a later data-deletion callback from the login app
    // can be traced back to this uid. Authenticated — see js/auth.js.
    if (request.method === 'POST' && url.pathname === '/api/auth/link-facebook') {
      return handleLinkFacebookLogin(request, env);
    }

    // ── One-time first-admin bootstrap ────────────────────────────────

    if (request.method === 'POST' && url.pathname === '/api/admin/bootstrap') {
      return handleAdminBootstrap(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/whoami') {
      return handleAdminWhoAmI(request, env);
    }

    // ── Admin/moderator role management (requires role: 'admin') ─────

    if (request.method === 'GET' && url.pathname === '/api/admin/roles') {
      return handleAdminRoleList(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/roles/grant') {
      return handleAdminRoleGrant(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/roles/revoke') {
      return handleAdminRoleRevoke(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/roles/lookup-email') {
      return handleAdminRoleLookupEmail(request, env);
    }

    // ── Admin: resources ──────────────────────────────────────────────

    if (request.method === 'POST' && url.pathname === '/api/admin/resources/batch') {
      return handleAdminResourceBatchCreate(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/resources') {
      return handleAdminResourceCreate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/resources') {
      return handleAdminResourceList(request, env);
    }

    // Must come before the plain "/api/admin/resources/:id" checks below,
    // since /transition and /versions both match a two-segment tail too.
    if (request.method === 'POST' && /^\/api\/admin\/resources\/[^/]+\/transition$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleAdminResourceTransition(request, env, resourceId);
    }

    if (request.method === 'GET' && /^\/api\/admin\/resources\/[^/]+\/versions$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleAdminResourceVersions(request, env, resourceId);
    }

    if (request.method === 'GET' && /^\/api\/admin\/resources\/[^/]+$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleAdminResourceGet(request, env, resourceId);
    }

    if (request.method === 'POST' && /^\/api\/admin\/resources\/[^/]+$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleAdminResourceEdit(request, env, resourceId);
    }

    if (request.method === 'DELETE' && /^\/api\/admin\/resources\/[^/]+$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleAdminResourceDelete(request, env, resourceId);
    }

    // ── Admin: collections ───────────────────────────────────────────

    if (request.method === 'POST' && url.pathname === '/api/admin/collections') {
      return handleCollectionCreate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/collections') {
      return handleAdminCollectionList(request, env);
    }

    if (request.method === 'POST' && /^\/api\/admin\/collections\/[^/]+\/resources$/.test(url.pathname)) {
      const collectionId = url.pathname.split('/')[4];
      return handleCollectionResourceEdit(request, env, collectionId);
    }

    if (request.method === 'POST' && /^\/api\/admin\/collections\/[^/]+$/.test(url.pathname)) {
      const collectionId = url.pathname.split('/')[4];
      return handleCollectionEdit(request, env, collectionId);
    }

    if (request.method === 'DELETE' && /^\/api\/admin\/collections\/[^/]+$/.test(url.pathname)) {
      const collectionId = url.pathname.split('/')[4];
      return handleCollectionDelete(request, env, collectionId);
    }

    // ── User-facing library (published curated resources) ────────────

    if (request.method === 'GET' && url.pathname === '/api/library/collections') {
      return handlePublicCollectionList(request, env);
    }

    if (request.method === 'GET' && /^\/api\/library\/collections\/[^/]+$/.test(url.pathname)) {
      const collectionId = url.pathname.split('/')[4];
      return handleLibraryCollectionGet(request, env, collectionId);
    }

    if (request.method === 'GET' && url.pathname === '/api/library/resources') {
      return handleLibraryList(request, env);
    }

    if (request.method === 'POST' && /^\/api\/library\/resources\/[^/]+\/download$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleLibraryDownload(request, env, resourceId);
    }

    if (request.method === 'GET' && /^\/api\/library\/resources\/[^/]+\/file$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleLibraryFileProxy(request, env, resourceId);
    }

    if (request.method === 'GET' && /^\/api\/library\/resources\/[^/]+$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleLibraryGet(request, env, resourceId, ctx);
    }

    return new Response(JSON.stringify({ error: 'Not found.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // Fires on the Cron Trigger set in wrangler.jsonc (currently every 5
  // minutes — frequent enough for all four jobs below without changing
  // any of their existing latency).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminderScheduler(env));
    ctx.waitUntil(runSocialScheduler(env));
    ctx.waitUntil(runInsightsDigestScheduler(env));
  },
};


// ═══════════════════════════════════════════════════════════════════════
// Security layer
// Wraps every request. Everything above (routing) is unchanged; this only
// adds checks BEFORE a request reaches it and safe headers AFTER it leaves.
//
//   1. Body-size caps      - refuse absurdly large request bodies early.
//   2. Rate limiting       - per-IP for everything, per-user for the
//                            expensive AI routes. Uses Cloudflare's rate
//                            limit bindings (see wrangler.jsonc), fails open.
//   3. CORS enforcement    - only our own site(s) may read API responses,
//                            whatever an individual endpoint says.
//   4. Safe response headers.
// ═══════════════════════════════════════════════════════════════════════

const KB = 1024;
const MB = 1024 * 1024;

// Routes that legitimately receive raw files or signed third-party calls.
// They are not size-capped here (they enforce their own limits / signatures).
function _isExemptFromBodyCap(path) {
  return path === '/api/social/media' ||
    path.startsWith('/api/note-sessions');
}

// Routes whose real bodies are tiny (a few fields). 100 KB is generous.
const SMALL_BODY_PREFIXES = [
  '/api/auth/', '/api/payment/initialize', '/api/subscription/', '/api/account/',
  '/api/reminders', '/api/inbox', '/api/admin/roles', '/api/connectors/',
  '/api/insights/schedule',
];

function _maxBodyBytes(path) {
  // Payment and social-network callbacks are small JSON messages. They are
  // signature-checked, but the server still has to read the whole body
  // before it can check the signature, so refuse anything oversized first.
  if (path === '/api/payment/webhook') return 256 * KB;
  if (path.startsWith('/webhooks/')) return 1 * MB;
  if (path === '/auth/facebook/data-deletion') return 100 * KB;
  if (path === '/api/chat') return 36 * MB;       // up to 4 images as base64
  if (SMALL_BODY_PREFIXES.some((p) => path === p || path.startsWith(p))) return 100 * KB;
  return 15 * MB;
}

// The expensive, money-costing routes (AI generation, image generation,
// uploads). These get a stricter per-user limit.
function _isHeavyRoute(method, path) {
  if (method !== 'POST') return false;
  return path === '/api/chat' ||
    path === '/api/image' ||
    path === '/api/document' ||
    path === '/api/resources/generate' ||
    path === '/api/insights/generate' ||
    path === '/api/note-summary' ||
    /^\/api\/note-sessions\/[^/]+\/transcribe$/.test(path) ||
    path === '/api/social/media' ||
    /^\/api\/resources\/[^/]+\/(regenerate|edit)$/.test(path) ||
    /^\/api\/resources\/[^/]+\/cards\/\d+\/image$/.test(path);
}

// Money-related actions that start or stop a subscription. Each one talks to
// Paystack, so a single user has no reason to trigger them more than a few
// times a minute. (The payment "status" check is left out on purpose: the
// payment-success page checks it every 2 seconds while it waits.)
function _isPaymentAction(method, path) {
  return method === 'POST' &&
    (path === '/api/payment/initialize' || path === '/api/subscription/cancel');
}

// Calls that come from Meta / Paystack servers, or are cheap OAuth
// redirects. Not IP rate-limited here (their own signatures protect them, and
// a burst from the provider must never be dropped).
function _isProviderCall(path) {
  return path === '/api/payment/webhook' || path.startsWith('/webhooks/');
}

function _allowedOrigins(env) {
  const list = [];
  if (env.APP_ORIGIN) list.push(String(env.APP_ORIGIN).trim().replace(/\/+$/, ''));
  if (env.EXTRA_ALLOWED_ORIGINS) {
    for (const o of String(env.EXTRA_ALLOWED_ORIGINS).split(',')) {
      const v = o.trim().replace(/\/+$/, '');
      if (v) list.push(v);
    }
  }
  return list;
}

function _blockedJson(message, status, extraHeaders) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  });
}

async function _verifiedUid(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m || !env.FIREBASE_PROJECT_ID) return null;
  try {
    const identity = await verifyFirebaseIdToken(m[1], env.FIREBASE_PROJECT_ID);
    return identity.uid;
  } catch (_) {
    return null;
  }
}

// Returns a Response to send INSTEAD of handling the request, or null to
// let the request through.
async function _guard(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 1. Body-size cap (declared size; Cloudflare itself caps the absolute max).
  if (['POST', 'PUT', 'PATCH'].includes(method) && !_isExemptFromBodyCap(path)) {
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > _maxBodyBytes(path)) {
      return _blockedJson('That request is too large.', 413);
    }
  }

  // 2. Rate limiting.
  if (!_isProviderCall(path)) {
    const ip = clientIp(request);
    const general = await checkRateBinding(env, 'RL_GENERAL', 'ip:' + ip);
    if (!general.allowed) {
      return _blockedJson('Too many requests. Please slow down and try again shortly.', 429, { 'Retry-After': '30' });
    }

    if (_isPaymentAction(method, path)) {
      const uid = await _verifiedUid(request, env);
      const pay = await checkRateBinding(env, 'RL_PAYMENT', uid ? 'uid:' + uid : 'ip:' + ip);
      if (!pay.allowed) {
        return _blockedJson('Too many payment attempts. Please wait a minute and try again.', 429, { 'Retry-After': '60' });
      }
    }

    if (_isHeavyRoute(method, path)) {
      // Count by verified user when we can tell who it is, else by IP.
      const uid = await _verifiedUid(request, env);
      const heavy = await checkRateBinding(env, 'RL_HEAVY', uid ? 'uid:' + uid : 'ip:' + ip);
      if (!heavy.allowed) {
        return _blockedJson('You are going a little too fast. Please wait a few seconds and try again.', 429, { 'Retry-After': '20' });
      }
    }
  }

  return null;
}

// Applies CORS enforcement and safe headers to a finished response.
function _harden(response, request, env) {
  const headers = new Headers(response.headers);

  // CORS: only our own origin(s) may read responses, no matter what the
  // individual endpoint set (some fell back to '*'). Same-site navigations
  // and server-to-server calls send no Origin and need no CORS.
  const origin = request.headers.get('Origin');
  const allowed = _allowedOrigins(env);
  if (origin && allowed.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  } else {
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith('access-control-')) headers.delete(name);
    }
  }
  headers.append('Vary', 'Origin');

  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('Permissions-Policy', 'camera=(), geolocation=(), payment=()');

  const type = (headers.get('Content-Type') || '').toLowerCase();
  if (type.includes('application/json') || type.startsWith('text/plain')) {
    // A data response should never be treated as a web page.
    headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const blocked = await _guard(request, env);
    if (blocked) return _harden(blocked, request, env);
    const response = await _app.fetch(request, env, ctx);
    return _harden(response, request, env);
  },

  async scheduled(event, env, ctx) {
    return _app.scheduled(event, env, ctx);
  },
};
