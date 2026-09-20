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
import { handlePaymentInitialize } from './payment-endpoint.js';
import { handlePaystackWebhook } from './webhook-endpoint.js';
import { handleAccountRequest, handleUsageRequest } from './account-endpoint.js';
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
} from './note-taker-endpoint.js';
import {
  handleConnectorStart,
  handleConnectorCallback,
  handleConnectorStatus,
  handleConnectorDisconnect,
} from './connectors-endpoint.js';

function _corsPreflight(env) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': env.APP_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Note-Language',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return _corsPreflight(env);

  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/api/note-sessions') return handleNoteSessionCreate(request, env);
  if (/^\/api\/note-sessions\/[^/]+\/segments$/.test(url.pathname) && request.method === 'POST') return handleNoteSessionSegment(request, env, url.pathname.split('/')[3]);
  if (/^\/api\/note-sessions\/[^/]+\/transcribe$/.test(url.pathname) && request.method === 'POST') return handleNoteChunkTranscribe(request, env, url.pathname.split('/')[3]);
  if (/^\/api\/note-sessions\/[^/]+$/.test(url.pathname) && ['GET', 'PATCH'].includes(request.method)) return handleNoteSession(request, env, url.pathname.split('/')[3]);

  if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Cognita Worker is running.', { status: 200 });
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

    // Must come after the /api/chat/list check above, since both match
    // the same "/api/chat/<segment>" shape.
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

    // GET /api/files/:conversationId -> list generated files for that chat
    if (request.method === 'GET' && /^\/api\/files\/[^/]+$/.test(url.pathname)) {
      const conversationId = url.pathname.split('/')[3];
      return handleFilesList(request, env, conversationId);
    }

    // GET /api/files/:conversationId/:fileId?filename=... -> fetch one file's content.
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

    // Flashcard pictures (stored in B2, served through a signed link so a
    // plain <img> tag can load them).
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

    if (request.method === 'POST' && url.pathname === '/api/payment/webhook') {
      return handlePaystackWebhook(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/subscription/cancel') {
      return handleSubscriptionCancel(request, env);
    }

    // ── Connectors (GitHub, Google, Figma, Canva) ─────

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
};
