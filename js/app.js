// js/app.js
// Cognita main app behavior. Talks to the Worker exclusively through
// window.Auth.authedFetch — never calls Groq/OpenRouter/Paystack/etc
// directly, and never constructs a request containing a provider or
// model name. The Worker decides all of that.
//
// Exports mount(), called once by js/router.js the first time the chat
// view is opened. Sidebar chrome (collapse/account menu/sign-out) is
// owned by js/shell.js, not here.

import { escapeHtml, showToast, closeMobileSidebar, renderAccountInfo, openModal, closeModal } from './shell.js';
import { buildCodeBlockHtml, codeTextOf } from './code-highlight.js';
import { SandboxClient } from './sandbox-client.js';
import { renderUiHtml, wireUi, refreshUi, liveUiUpdate, skeletonHtml } from './ui-render.js';
import { validateUi, applyPatches, findUiNode } from '../ui-schema.js';
import { shouldOfferSandbox } from '../sandbox-intent.js';

const WORKER_URL = 'https://api.cognita.com.ng';

// The code sandbox (Tier 1) runs in this browser, in a sandboxed iframe. It is
// created the first time the model asks to run something.
let _sandboxClient = null;
function getSandbox() {
  if (!_sandboxClient) _sandboxClient = new SandboxClient();
  return _sandboxClient;
}
const HISTORY_KEY = 'cognita:conversations';

const QUALITY_META = {
  standard: { label: 'Standard' },
  advanced: { label: 'Advanced' },
  thorough: { label: 'Thorough' },
  v0: { label: 'v0 (Admin)' },
};

// Short phrases only — long sentences don't fit well as a placeholder.
const PLACEHOLDERS = [
  'Message Cognita',
  'Ask anything',
  'Draft, plan, explain',
  "What's on your mind?",
];

const TYPE_SPEED_MS = 65;      // per character while typing
const DELETE_SPEED_MS = 35;    // per character while deleting
const HOLD_AFTER_TYPE_MS = 1800; // pause once a phrase is fully typed
const RESUME_AFTER_IDLE_MS = 4000; // wait after user goes idle before resuming

// Image types we'll try to send to the vision model. Anything else (pdf,
// docx, etc.) is either extracted client-side (see below) or flagged to
// the user rather than silently dropped.
const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp|gif)$/i;
const TEXT_FILE_RE = /\.(txt|csv|tsv|json|md)$/i;
const TEXT_MIME_TYPES = ['text/plain', 'text/csv', 'text/tab-separated-values', 'application/json', 'text/markdown'];
// Files that go straight into the code workspace instead of the prompt.
const WORKSPACE_DATA_RE = /\.(csv|tsv|json|xlsx)$/i;
const WORKSPACE_TEXT_RE = /\.(txt|md)$/i;
const WORKSPACE_TEXT_MIN_BYTES = 4096;   // smaller txt/md files stay in the prompt
const DEFAULT_SANDBOX_FILE_MB = 2;       // used until the plan limits arrive
const PDF_FILE_RE = /\.pdf$/i;
const PDF_MIME = 'application/pdf';
const DOCX_FILE_RE = /\.docx$/i;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_FILE_RE = /\.doc$/i; // legacy .doc — mammoth can't read this, flagged unsupported

// Guard against sending enormous extracted text to the model — trim and
// note that it was trimmed rather than silently truncating.
const MAX_EXTRACTED_CHARS = 40000;

// Mime types for AI-generated document downloads, keyed by the "format"
// the /api/document endpoint returns. Kept in sync with document-endpoint.js.
const EXPORT_MIME_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const PENDING_DELETES_KEY = 'cognita:pendingDeletes';
const RECONCILE_THROTTLE_MS = 60000; // don't hit B2's list endpoint more than once a minute
const RECONCILE_INTERVAL_MS = 120000; // background refresh while the tab is visible
const TITLES_KEY = 'cognita:titles'; // tiny id -> title cache, survives even if full history can't be stored
const HYDRATE_CONCURRENCY = 3;
const HYDRATE_MAX_PER_PASS = 40;
const PLACEHOLDER_TITLE = 'Untitled chat'; // legacy value written by older builds
let _lastReconcileAt = 0;
let _reconcileInFlight = false;
let _hydrating = false;
let loadingConversationId = null; // a synced chat whose body is still being downloaded
const _hydrateFailedAt = new Map(); // id -> timestamp of last failed body fetch
// One-time download links (blob URLs) for documents the server could not
// persist. Keyed by message object so they survive re-renders in this
// session but are never written to storage.
const _transientDownloads = new WeakMap();

let currentQuality = 'standard';
let conversation = []; // { role: 'user'|'assistant', content: string, attachments?: [...], documentFile?: {...} }
let conversationMeta = [];
// Conversation-scoped record of connected-app write actions the user has
// already approved in THIS conversation (see Bug 4 in the audit doc —
// "confirmation re-asked despite explicit prior consent"). Sent back to
// the backend on every /api/chat call for this conversation so it can
// skip re-prompting for the exact same provider+scope+action; never
// copied to a different conversation, never sent for a different one.
// Shape: [{ provider, scope, approvedActionClasses: string[] }]
let conversationApprovals = [];
// Design requirements card (create_design). What the person supplied for this
// chat's designs, so Cognita never asks for the same thing twice. Images are
// kept only in memory; text answers are rebuilt from the saved cards on reload.
let conversationDesignAssets = {};   // { logo, photo, artwork } -> { mime, base64, w, h }
let conversationDesignFacts = {};    // { name, when, venue, contact, price }
let conversationDesignSkipped = [];  // field ids the person chose to leave out
let currentConversationId = null;
let isSending = false;
let activeThinkingTimers = {};
let approvingIndex = null;   // message whose approved action is running right now
let freshAssistantIndex = -1; // index of the just-received assistant reply to type out; -1 = none pending
let streamResume = null;     // { index, shown, hadUi }: the reply was already streaming live, so carry on from `shown` instead of replaying

let placeholderIndex = 0;
let placeholderTimeoutId = null;
let placeholderResumeTimeoutId = null;
let placeholderRunning = false;

// Attachments staged in the composer before the message is sent.
// { name, kind: 'image'|'text'|'unsupported', dataUrl?, base64?, mimeType?, text? }
let pendingAttachments = [];

// ── Streaming reply + scroll-follow state (see "Streaming reply renderer") ──
let activeStream = null;        // the reply currently being revealed, if any
let _renderedConvId = null;     // which chat the message list last showed
let _renderedCount = 0;         // how many messages it showed (so old ones do not replay their entrance animation)
let _animateFromIndex = 0;      // messages below this index render without the entrance animation
const streamScroll = { follow: true, lastAutoTop: -1, wired: false };
const NEAR_BOTTOM_PX = 48;      // how close to the bottom still counts as "reading the latest text"

// Reveal pacing. A calm, steady flow that reads like a model generating,
// not a fast mechanical typewriter.
const STREAM_BASE_CPS = 58;     // characters per second for normal replies (~10 words a second)
const STREAM_MAX_SECONDS = 20;  // very long replies speed up so they never take longer than this
const STREAM_MAX_CPS = 420;     // hard ceiling, however long the reply is
const STREAM_RAMP_MS = 450;     // gentle ease-in over the first moments

let currentAccountPlanId = null;
let currentAccountHasVision = false;
// From /api/usage. Null until it arrives; the defaults below are the Free plan's.
let currentSandboxLimits = null;
let currentAccountHasDocExport = false;
let currentAccountChatTiers = ['fast'];
// Can this plan actually use connected-app tools (GitHub/Google/Facebook/
// Canva) in chat? Mirrors entitlements.js features.connectorTools —
// see updateConnectorsAvailability, which uses this to lock the
// "Connected apps" entry point instead of letting a Free-tier user
// walk through an OAuth flow that chat will never use.
let currentAccountHasConnectorTools = false;
let visualKind = 'diagram';
let documentDocType = 'letter';
let documentFormat = 'docx';

const THINKING_WORDS = [
  'Thinking',
  'Reasoning',
  'Thinking it through',
  'Digging into it',
  'Considering the angles',
  'Piecing it together',
];

/* ════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════ */

export async function mount() {
  const user = await window.Auth.requireAuthOrRedirect();
  if (!user) return; // already redirected to login

  renderAccountInfo(user);
  await refreshUsage();
  await refreshAccount();

  renderSidebarHistory();
  updateConversationTitle();
  wireComposer();
  wireAttachMenu();
  wireQualityPicker();
  wireVisualModal();
  wireDocumentModal();
  wireConnectorsModal();
  showConnectorRedirectBanner();
  wireComposerSuggestions();
  startPlaceholderTypewriter();

  window.addEventListener('cognita:new-chat', startNewConversation);

  reconcileIfDue();
  window.addEventListener('focus', reconcileIfDue);
  window.addEventListener('online', () => reconcileIfDue(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconcileIfDue();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') reconcileIfDue();
  }, RECONCILE_INTERVAL_MS);

  const overlay = document.getElementById('appLoadingOverlay');
  const contentWrap = document.getElementById('appContentWrap');
  if (overlay) overlay.hidden = true;
  if (contentWrap) contentWrap.hidden = false;
}

/* ════════════════════════════════════════════════════════
   ACCOUNT / USAGE DISPLAY
════════════════════════════════════════════════════════ */

async function refreshAccount() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/account');
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('accountPlan').textContent = data.planName;
    document.getElementById('accountPlan').classList.remove('skeleton');
    document.getElementById('accountEmail').classList.remove('skeleton');

    currentAccountPlanId = data.planId;
    currentAccountHasVision = !!(data.models && data.models.vision);
    currentAccountHasDocExport = !!(data.features && data.features.documentExport);
    currentAccountChatTiers = (data.models && Array.isArray(data.models.chat)) ? data.models.chat : ['fast'];
    currentAccountHasConnectorTools = !!(data.features && data.features.connectorTools);

    // Reveal the admin-panel shortcut for curation staff only. Purely
    // cosmetic — admin.html's own server-side checks (requireAdmin) are
    // what actually gate access, this just avoids showing a dead link.
    const adminPanelLink = document.getElementById('adminPanelLink');
    if (adminPanelLink) adminPanelLink.hidden = !(data.role === 'admin' || data.role === 'moderator');

    const upgradeLink = document.getElementById('upgradeLink');
    if (data.planId !== 'studio' && data.planId !== 'admin') {
      upgradeLink.hidden = false;
    }

    // Vision (image attachment / illustration generation) is gated by
    // plan. Reflect that in the attach menu so lower-plan users get a
    // clear affordance instead of a dead click.
    updateImageAttachAvailability();
    // Same idea for the quality picker: lock out tiers the plan doesn't
    // actually have access to, instead of letting the person pick one
    // and silently get a lower tier back with no explanation.
    updateQualityPickerAvailability();
    // Same idea again for connected apps: Free-tier chat can never
    // actually call a connector tool (see chat-endpoint.js
    // connectorToolsEnabled), so reflect that up front instead of
    // letting the person complete a whole OAuth flow for nothing.
    updateConnectorsAvailability();
  } catch (e) {
    console.error('[app] Could not load account:', e.message);
  }
}

function updateImageAttachAvailability() {
  const illustrationItem = document.getElementById('attachIllustrationItem');
  if (illustrationItem) {
    // Picture generation is open to every plan (the daily limit still applies).
    illustrationItem.classList.remove('is-locked');
    illustrationItem.title = 'Generate a realistic illustration';
  }
}

// Maps a quality-picker option's data-quality value to the internal tier
// key used by entitlements.js / the backend, so availability can be
// checked against the plan's actual allowed chat tiers.
function _tierKeyForQuality(quality) {
  if (quality === 'thorough') return 'reasoning';
  if (quality === 'advanced') return 'advanced';
  if (quality === 'v0') return 'v0';
  return 'fast';
}

// Locks out quality-picker options the current plan isn't entitled to,
// so the person can never successfully select a tier they don't have —
// instead of picking one and silently getting a lower tier back with no
// explanation.
function updateQualityPickerAvailability() {
  document.querySelectorAll('.quality-picker-option').forEach((opt) => {
    const tierKey = _tierKeyForQuality(opt.dataset.quality);
    const entitled = currentAccountChatTiers.includes(tierKey);
    opt.classList.toggle('is-locked', !entitled);
    opt.title = entitled ? '' : 'This quality level requires a higher Cognita plan.';
  });

  // v0 isn't just locked for non-admins, it's not a real option for
  // them at all (see entitlements.js PLANS.admin) — hide it outright
  // rather than showing a lock icon for something no upgrade can buy.
  const v0Option = document.getElementById('qualityOptionV0');
  if (v0Option) {
    const hasV0 = currentAccountChatTiers.includes('v0');
    v0Option.hidden = !hasV0;
    v0Option.title = '';
    // If the account lost admin status mid-session while v0 was
    // selected, fall back to standard instead of leaving the picker
    // showing a quality the account can no longer use.
    if (!hasV0 && currentQuality === 'v0') setQuality('standard');
  }
}

// Locks the "Connected apps" attach-menu entry the same way the
// illustration/quality-picker entries are locked: dimmed, with a lock
// badge and an explanatory tooltip, rather than looking identical to
// every other (fully usable) attach option. Unlike those, this item
// still opens the modal when locked (see wireAttachMenu) rather than
// blocking the click outright, because the modal itself is also where
// someone who downgraded mid-subscription would go to disconnect an
// app they can no longer use — that management action has to stay
// reachable regardless of plan. loadConnectorsList() and
// wireConnectorsModal() are what actually stop a Free-tier user from
// finishing a *new* connection once the modal is open.
function updateConnectorsAvailability() {
  const connectorsItem = document.getElementById('attachConnectorsItem');
  if (connectorsItem) {
    connectorsItem.classList.toggle('is-locked', !currentAccountHasConnectorTools);
    connectorsItem.title = currentAccountHasConnectorTools
      ? 'View and manage connected apps'
      : 'Connecting apps requires Cognita Plus or higher. You can still view this here.';
  }
}

// If /api/usage fails, the "00 / 00" skeleton would otherwise shimmer
// forever and read as "still loading". Show a plain dash instead.
function showUsageUnavailable() {
  const el = document.getElementById('usageMessages');
  if (el && el.classList.contains('skeleton')) {
    el.textContent = '\u2014';
    el.classList.remove('skeleton');
  }
}

/* True when this chat has already run code. The Worker then keeps offering the
 * sandbox tools, so a follow-up such as "now put that in a file" works even
 * though the message itself says nothing about code. */
// True when one of the last few replies in this chat holds a generated picture
// or design, so a follow-up like "make it blue" keeps the picture tools on.
function conversationHasMedia() {
  const from = Math.max(0, conversationMeta.length - 6);
  for (let i = from; i < conversationMeta.length; i++) {
    const m = conversationMeta[i];
    if (m && Array.isArray(m.media) && m.media.length) return true;
  }
  return false;
}

function conversationHasSandbox() {
  return conversationMeta.some((m) => m && Array.isArray(m.steps) && m.steps.some((s) => s && s.type === 'sandbox')) ||
    conversation.some((m) => m && Array.isArray(m.attachments) && m.attachments.some((a) => a && a.kind === 'workspace'));
}

/* Fills one usage meter. entitlements.js's UNLIMITED sentinel (999999) is a real,
 * comparable number for the backend's quota math, but showing it raw ("3 / 999999")
 * would be confusing, so it reads "Unlimited" once the limit is clearly not a
 * real day-to-day cap. */
function fillUsageMeter(valueEl, barEl, usage) {
  if (!valueEl || !barEl || !usage) return;
  const { used, limit } = usage;
  const isUnlimited = limit >= 999999;
  valueEl.textContent = isUnlimited ? 'Unlimited' : (used + ' / ' + limit);
  valueEl.classList.remove('skeleton');
  const pct = (!isUnlimited && limit > 0) ? Math.min(100, (used / limit) * 100) : 0;
  barEl.style.width = pct + '%';
  barEl.classList.toggle('is-near-limit', pct >= 70 && pct < 100);
  barEl.classList.toggle('is-at-limit', pct >= 100);
  barEl.parentElement.setAttribute('aria-valuenow', String(Math.round(pct)));
}

async function refreshUsage() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/usage');
    if (!res.ok) { showUsageUnavailable(); return; }
    const data = await res.json();
    if (data.limits) currentSandboxLimits = data.limits;

    fillUsageMeter(document.getElementById('usageMessages'), document.getElementById('usageMessagesBar'), data.usage.messages);

    // Code runs: shown only once there is something to show (a run was used
    // today, or the plan limit is at 70 percent or more), and only in the chat view.
    const sb = data.usage.sandboxRuns;
    const sbWidget = document.getElementById('usageWidgetSandbox');
    if (sb && sbWidget) {
      const pct = sb.limit < 999999 && sb.limit > 0 ? (sb.used / sb.limit) * 100 : 0;
      const show = sb.used > 0 || pct >= 70;
      fillUsageMeter(document.getElementById('usageSandbox'), document.getElementById('usageSandboxBar'), sb);
      sbWidget.dataset.active = show ? '1' : '0';
      const chatWidget = document.getElementById('usageWidgetChat');
      sbWidget.hidden = !(show && chatWidget && !chatWidget.hidden);
    }
  } catch (e) {
    console.error('[app] Could not load usage:', e.message);
    showUsageUnavailable();
  }
}

/* ════════════════════════════════════════════════════════
   CONVERSATION TITLE (live, shown in the topbar)
════════════════════════════════════════════════════════ */

function deriveTitle(messages) {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'New chat';
  const hasImage = !!(firstUser.attachments && firstUser.attachments.some((a) => a.kind === 'image'));
  const text = (firstUser.content || (hasImage ? 'Image' : '')).trim().replace(/\s+/g, ' ');
  return text.length > 60 ? text.slice(0, 60) + '…' : (text || 'New chat');
}

function updateConversationTitle() {
  const titleEl = document.getElementById('conversationTitle');
  if (loadingConversationId && loadingConversationId === currentConversationId) return;
  titleEl.textContent = deriveTitle(conversation);
}

/* ════════════════════════════════════════════════════════
   CHAT HISTORY (persisted client-side in localStorage, mirrored to
   Backblaze B2 server-side so it isn't lost if local storage is cleared)
════════════════════════════════════════════════════════ */

function loadAllConversations() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('[app] Could not read chat history:', e.message);
    return [];
  }
}

// Writes the history list. If the browser's storage quota is hit (large
// image attachments/visuals fill it quickly), the oldest already-synced
// chats are shrunk back to lightweight placeholders — same shape as a
// chat found on a new device, with its real title kept — until the write
// fits. Chats with unsynced edits are never shrunk. Returns whether the
// list was stored.
function saveAllConversations(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    const evictable = list
      .filter((c) => c && c.id !== currentConversationId && !c.notLoaded &&
        c.remoteSyncedAt && c.updatedAt <= c.remoteSyncedAt)
      .sort((a, b) => a.updatedAt - b.updatedAt);

    for (const victim of evictable) {
      const idx = list.findIndex((c) => c.id === victim.id);
      if (idx < 0) continue;
      list[idx] = _toPlaceholder(victim);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
        return true;
      } catch (e2) { /* keep shrinking */ }
    }
    console.error('[app] Could not persist chat history:', e.message);
    return false;
  }
}

function _toPlaceholder(c) {
  return {
    id: c.id,
    title: c.title && c.title !== PLACEHOLDER_TITLE ? c.title : deriveTitle(c.messages || []),
    messages: [],
    meta: [],
    quality: c.quality || 'standard',
    updatedAt: c.updatedAt,
    remoteSyncedAt: c.remoteSyncedAt,
    notLoaded: true,
  };
}

function _loadTitleCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TITLES_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) { return {}; }
}

function rememberTitle(id, title) {
  if (!id || !title || title === PLACEHOLDER_TITLE || title === 'New chat') return;
  try {
    const cache = _loadTitleCache();
    if (cache[id] === title) return;
    cache[id] = title;
    localStorage.setItem(TITLES_KEY, JSON.stringify(cache));
  } catch (e) { /* cache is best-effort */ }
}

function forgetTitle(id) {
  try {
    const cache = _loadTitleCache();
    if (!(id in cache)) return;
    delete cache[id];
    localStorage.setItem(TITLES_KEY, JSON.stringify(cache));
  } catch (e) { /* best-effort */ }
}

// A title is "real" once it came from actual conversation content.
function _hasRealTitle(c) {
  return !!(c && c.title && c.title !== PLACEHOLDER_TITLE && c.title !== 'New chat');
}

// What the sidebar should show for a chat. Never the legacy "Untitled
// chat" placeholder: falls back to the remembered title, then to a title
// derived from loaded messages, then to a neutral loading label.
function displayTitleFor(c) {
  if (_hasRealTitle(c)) return c.title;
  const remembered = _loadTitleCache()[c.id];
  if (remembered) return remembered;
  if (Array.isArray(c.messages) && c.messages.length) return deriveTitle(c.messages);
  return c.notLoaded ? 'Loading…' : 'New chat';
}

function makeConversationId() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

// Ensures a conversation id exists before an action that needs one to
// scope server-side data (e.g. generating a document that should be
// retrievable later). Does NOT persist anything by itself — the caller
// still needs to trigger persistCurrentConversation() once there's an
// actual message to save, same as before. This just avoids generating a
// document against a null id and losing the ability to re-fetch it.
function ensureConversationId() {
  if (!currentConversationId) {
    currentConversationId = makeConversationId();
  }
  return currentConversationId;
}

function loadPendingDeletes() {
  try {
    const raw = localStorage.getItem(PENDING_DELETES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function savePendingDeletes(list) {
  try {
    localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('[app] Could not persist pending deletes:', e.message);
  }
}

// Best-effort mirror of a sidebar delete to B2. Returns whether it
// actually succeeded, so callers can track it as pending and retry later
// rather than assuming a fire-and-forget call landed.
async function deleteConversationFromB2(conversationId) {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });
    return res.ok;
  } catch (e) {
    console.error('[app] Could not delete conversation from storage:', e.message);
    return false;
  }
}

// Retries any deletes that haven't been confirmed by the server yet.
// Called at the start of every reconciliation pass so a delete made while
// offline doesn't get silently forgotten, and — critically — so a
// not-yet-confirmed delete never gets treated as "missing" and resurrected
// during reconciliation (see reconcileWithB2's pendingDeletes.includes check).
async function flushPendingDeletes() {
  const pending = loadPendingDeletes();
  if (pending.length === 0) return;

  const stillPending = [];
  for (const id of pending) {
    const ok = await deleteConversationFromB2(id);
    if (!ok) stillPending.push(id);
  }
  savePendingDeletes(stillPending);
}

// Best-effort mirror of a conversation to B2. Never blocks the UI and
// never surfaces errors to the user. On success, records the server's own
// timestamp for this save (remoteSyncedAt) so later reconciliation can
// tell "I already have this version" from "the server has something
// newer" without trusting client clocks.
async function syncConversationToB2(entry) {
  // A placeholder has no messages — pushing it would overwrite the real
  // conversation on the server with an empty one.
  if (!entry || entry.notLoaded) return;
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: entry.id, conversation: entry }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.serverUpdatedAt) return;

    const all = loadAllConversations();
    const idx = all.findIndex((c) => c.id === entry.id);
    if (idx >= 0) {
      all[idx].remoteSyncedAt = data.serverUpdatedAt;
      saveAllConversations(all);
    }
  } catch (e) {
    console.error('[app] Could not sync conversation to storage:', e.message);
  }
}

// Fetches one conversation's full body from B2 and merges it into local
// storage, replacing whatever placeholder or stale copy was there. If
// it's the conversation currently open on screen, re-renders it too
// (keeping the scroll position). Returns true if the body was fetched.
async function fetchAndMergeConversation(id, serverUpdatedAt) {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat/' + encodeURIComponent(id));
    if (!res.ok) { _hydrateFailedAt.set(id, Date.now()); return false; }
    const data = await res.json();
    if (!data.conversation) { _hydrateFailedAt.set(id, Date.now()); return false; }

    const all = loadAllConversations();
    const idx = all.findIndex((c) => c.id === id);
    const local = idx >= 0 ? all[idx] : null;

    // Never overwrite edits that haven't reached the server yet, and never
    // swap the conversation out from under an in-flight reply.
    const hasUnpushedEdit = local && !local.notLoaded && local.remoteSyncedAt && local.updatedAt > local.remoteSyncedAt;
    const midReply = id === currentConversationId && isSending;
    if (hasUnpushedEdit || midReply) return true;

    const merged = {
      ...data.conversation,
      id,
      remoteSyncedAt: serverUpdatedAt || (local && local.remoteSyncedAt) || data.conversation.updatedAt,
      notLoaded: false,
    };
    if (!_hasRealTitle(merged)) merged.title = deriveTitle(merged.messages || []);
    if (idx >= 0) all[idx] = merged; else all.push(merged);
    saveAllConversations(all);
    rememberTitle(id, merged.title);
    _hydrateFailedAt.delete(id);

    if (id === currentConversationId) {
      const convEl = document.getElementById('conversation');
      const prevScroll = convEl ? convEl.scrollTop : 0;
      const wasLoading = loadingConversationId === id;
      const nextMessages = merged.messages || [];
      const changed = wasLoading ||
        nextMessages.length !== conversation.length ||
        JSON.stringify(nextMessages[nextMessages.length - 1] || null) !== JSON.stringify(conversation[conversation.length - 1] || null) ||
        JSON.stringify(merged.meta || []).length !== JSON.stringify(conversationMeta || []).length;

      if (changed) {
        conversation = nextMessages;
        conversationMeta = merged.meta || [];
        conversationApprovals = merged.approvals || [];
        if (merged.quality) setQuality(merged.quality);
        renderConversation();
        if (!wasLoading && convEl) convEl.scrollTop = prevScroll;
      }
      updateConversationTitle();
    }
    if (loadingConversationId === id) loadingConversationId = null;
    renderSidebarHistory();
    return true;
  } catch (e) {
    console.error('[app] Could not fetch conversation from storage:', e.message);
    _hydrateFailedAt.set(id, Date.now());
    return false;
  }
}

// Downloads the bodies of synced chats whose title isn't known yet, a few
// at a time, newest first, so the sidebar shows real titles without the
// user having to open each chat. Chats that already have a title (even
// as a shrunken placeholder) are left alone until opened.
async function hydrateUnloadedConversations() {
  if (_hydrating) return;
  _hydrating = true;
  try {
    const now = Date.now();
    const queue = loadAllConversations()
      .filter((c) => c.notLoaded && !_hasRealTitle(c) && !_loadTitleCache()[c.id])
      .filter((c) => !(_hydrateFailedAt.get(c.id) > now - RECONCILE_THROTTLE_MS * 5))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, HYDRATE_MAX_PER_PASS);

    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const c = queue[cursor++];
        await fetchAndMergeConversation(c.id, c.remoteSyncedAt);
      }
    };
    await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, queue.length) }, worker));
  } finally {
    _hydrating = false;
  }
}

// Reconciles local chat history against what B2 actually has. Timestamp
// rule throughout: whichever of "edited" vs "deleted" happened later,
// wins. Never mutates local storage on a failed or malformed server
// response — a network hiccup must never be read as "everything's gone."
async function reconcileWithB2() {
  if (_reconcileInFlight) return;
  _reconcileInFlight = true;
  try {
    await _reconcileWithB2Inner();
  } finally {
    _reconcileInFlight = false;
  }
}

async function _reconcileWithB2Inner() {
  await flushPendingDeletes();

  let serverList;
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat/list');
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.conversations)) return;
    serverList = data.conversations;
  } catch (e) {
    console.error('[app] Could not list remote conversations:', e.message);
    return;
  }

  const pendingDeletes = loadPendingDeletes();
  const serverMap = new Map(serverList.map((c) => [c.conversationId, c]));
  const all = loadAllConversations();
  let changed = false;

  for (const local of all.slice()) {
    if (pendingDeletes.includes(local.id)) continue; // delete not yet confirmed — don't touch

    const remote = serverMap.get(local.id);

    if (!remote) {
      // Server has never seen this one. Only push it if we've never
      // successfully synced it — otherwise it may have fallen off an old
      // listing page or is mid-lifecycle-purge, not worth re-pushing blind.
      if (!local.remoteSyncedAt) syncConversationToB2(local);
      continue;
    }

    if (remote.status === 'deleted') {
      if (local.updatedAt > remote.serverUpdatedAt) {
        // Edited here after it was deleted elsewhere — the edit is the
        // more recent intent, so it wins and gets pushed back up.
        syncConversationToB2(local);
      } else {
        const idx = all.findIndex((c) => c.id === local.id);
        if (idx >= 0) { all.splice(idx, 1); changed = true; }
        forgetTitle(local.id);
        if (local.id === currentConversationId) {
          currentConversationId = null;
          loadingConversationId = null;
          conversation = [];
          conversationMeta = [];
          conversationApprovals = [];
          resetDesignState(false);
          renderConversation();
          updateConversationTitle();
          showToast('This chat was deleted from another device.');
        }
      }
      continue;
    }

    // remote.status === 'live'
    if (local.notLoaded) {
      // Placeholder: the body is fetched by hydrateUnloadedConversations
      // (or on open). Just keep its server timestamp current.
      if (local.remoteSyncedAt !== remote.serverUpdatedAt) {
        local.remoteSyncedAt = remote.serverUpdatedAt;
        if (remote.serverUpdatedAt > local.updatedAt) local.updatedAt = remote.serverUpdatedAt;
        changed = true;
      }
      continue;
    }

    const serverIsNewer = !local.remoteSyncedAt || remote.serverUpdatedAt > local.remoteSyncedAt;
    const hasUnpushedEdit = !local.remoteSyncedAt || local.updatedAt > local.remoteSyncedAt;

    if (serverIsNewer && !hasUnpushedEdit) {
      fetchAndMergeConversation(local.id, remote.serverUpdatedAt);
    } else if (hasUnpushedEdit) {
      // Either the last push never landed (offline / failed request) or
      // both sides changed. The later edit wins, same rule as deletes.
      if (local.updatedAt >= remote.serverUpdatedAt) {
        syncConversationToB2(local);
      } else {
        fetchAndMergeConversation(local.id, remote.serverUpdatedAt);
      }
    }
  }

  // Chats that exist on the server but not locally at all (new device, or
  // started elsewhere) — add a lightweight placeholder; full content
  // loads lazily only when opened, so this never downloads N bodies
  // just to populate the sidebar.
  for (const remote of serverList) {
    if (remote.status !== 'live') continue;
    if (all.some((c) => c.id === remote.conversationId)) continue;
    all.push({
      id: remote.conversationId,
      title: _loadTitleCache()[remote.conversationId] || '',
      messages: [],
      meta: [],
      quality: 'standard',
      updatedAt: remote.serverUpdatedAt,
      remoteSyncedAt: remote.serverUpdatedAt,
      notLoaded: true,
    });
    changed = true;
  }

  if (changed) {
    saveAllConversations(all);
    renderSidebarHistory();
  }

  // Fill in real titles for any chats that only exist as placeholders.
  hydrateUnloadedConversations();
}

function reconcileIfDue(force) {
  const now = Date.now();
  if (force !== true && now - _lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  _lastReconcileAt = now;
  reconcileWithB2();
}

// ── Generative UI: live blocks, state and patches ──────────────────────
// The validated blocks (with ids and state) live in conversationMeta[i].ui, so
// they are saved and restored with the conversation. Everything is re-validated
// on the way in; nothing executable is ever stored.
function getUiBlocks(i) {
  const m = conversationMeta[i];
  if (!m || !Array.isArray(m.ui) || !m.ui.length) return null;
  if (m.ui.some((b) => !b || !b.id)) m.ui = validateUi(m.ui); // older saves had no ids
  return m.ui;
}

// Applies validated patches from a reply to the newest message that holds the
// target component. Returns the message indexes that changed.
function applyIncomingUiPatches(patches) {
  const touched = new Set();
  if (!Array.isArray(patches)) return [];
  patches.slice(0, 8).forEach((p) => {
    let found = false;
    for (let i = conversationMeta.length - 1; i >= 0; i--) {
      if (!getUiBlocks(i)) continue;
      const m = conversationMeta[i];
      const key = p.op === 'create' ? p.parent : p.target;
      if (key && !findUiNode(m.ui, key)) continue;
      const r = applyPatches(m.ui, [p]);
      if (r.applied) { m.ui = r.blocks; touched.add(i); }
      found = true;
      break;
    }
    // A replacement for a component that no longer exists is simply a new component on the newest answer.
    if (!found && p.op === 'replace' && p.node) {
      const last = conversation.length - 1;
      const m = conversationMeta[last];
      if (m && conversation[last] && conversation[last].role === 'assistant') {
        m.ui = validateUi((Array.isArray(m.ui) ? m.ui : []).concat(p.node));
        touched.add(last);
      }
    }
  });
  return Array.from(touched);
}


// Called after every completed exchange so the sidebar and title always
// reflect what's on screen. Creates a new saved entry on first message,
// updates the existing one afterward.
function persistCurrentConversation() {
  if (conversation.length === 0) return;
  // Never save while a synced chat's real messages are still downloading.
  if (loadingConversationId && loadingConversationId === currentConversationId) return;

  if (!currentConversationId) {
    currentConversationId = makeConversationId();
  }

  const all = loadAllConversations();
  const existingIndex = all.findIndex((c) => c.id === currentConversationId);
  const existing = existingIndex >= 0 ? all[existingIndex] : null;

  const entry = {
    id: currentConversationId,
    title: deriveTitle(conversation),
    messages: conversation,
    meta: conversationMeta,
    approvals: conversationApprovals,
    quality: currentQuality,
    updatedAt: Date.now(),
    remoteSyncedAt: existing ? existing.remoteSyncedAt : undefined,
  };

  if (existingIndex >= 0) {
    all[existingIndex] = entry;
  } else {
    all.unshift(entry);
  }

  saveAllConversations(all);
  rememberTitle(entry.id, entry.title);
  renderSidebarHistory();
  syncConversationToB2(entry);
}

function renderSidebarHistory() {
  const nav = document.getElementById('sidebarHistory');
  const all = loadAllConversations().sort((a, b) => b.updatedAt - a.updatedAt);

  if (all.length === 0) {
    nav.innerHTML = '<div class="sidebar-history-empty">Your chats will appear here</div>';
    return;
  }

  nav.innerHTML = all.map((c) => {
    const isActive = c.id === currentConversationId;
    const title = escapeHtml(displayTitleFor(c));
    const isPending = c.notLoaded && !_hasRealTitle(c) && !_loadTitleCache()[c.id];
    return (
      '<div class="sidebar-history-row' + (isActive ? ' is-active' : '') + '">' +
        '<button class="sidebar-history-item' + (isPending ? ' is-pending' : '') + '" data-id="' + escapeHtml(c.id) + '" title="' + title + '"' + (isActive ? ' aria-current="true"' : '') + '>' +
          '<span>' + title + '</span>' +
        '</button>' +
        '<button class="history-delete-btn" data-delete-id="' + escapeHtml(c.id) + '" aria-label="Delete chat: ' + title + '" title="Delete chat">' +
          '<i class="ph ph-x" aria-hidden="true"></i>' +
        '</button>' +
      '</div>'
    );
  }).join('');

  nav.querySelectorAll('.sidebar-history-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      loadConversation(btn.dataset.id);
    });
  });

  nav.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(btn.dataset.deleteId);
    });
  });
}

function loadConversation(id) {
  if (isSending && id !== currentConversationId) {
    // A reply commits into whichever chat is open — switching now would
    // put it in the wrong one.
    showToast('Please wait for the reply to finish before switching chats.');
    return;
  }
  const all = loadAllConversations();
  const entry = all.find((c) => c.id === id);
  if (!entry) return;

  currentConversationId = entry.id;
  loadingConversationId = null;

  if (entry.notLoaded) {
    conversation = [];
    conversationMeta = [];
    conversationApprovals = [];
    resetDesignState(false);
    loadingConversationId = entry.id;
    renderConversationLoading();
    document.getElementById('conversationTitle').textContent = displayTitleFor(entry);
    renderSidebarHistory();
    closeMobileSidebar();
    fetchAndMergeConversation(id, entry.remoteSyncedAt).then((ok) => {
      if (ok || loadingConversationId !== id) return;
      // Couldn't download it: leave the chat in the sidebar (never blank
      // it or overwrite it) and tell the user so they can retry.
      loadingConversationId = null;
      if (currentConversationId === id) {
        renderConversation();
        updateConversationTitle();
      }
      showToast('Could not load this chat. Check your connection and try again.');
    });
    return;
  }

  conversation = entry.messages;
  conversationMeta = entry.meta || [];
  conversationApprovals = entry.approvals || [];
  resetDesignState(true);
  if (entry.quality) setQuality(entry.quality);
  renderConversation();
  updateConversationTitle();
  renderSidebarHistory();
  closeMobileSidebar();
}

function deleteConversation(id) {
  const all = loadAllConversations().filter((c) => c.id !== id);
  saveAllConversations(all);
  forgetTitle(id);

  const pending = loadPendingDeletes();
  if (!pending.includes(id)) {
    pending.push(id);
    savePendingDeletes(pending);
  }

  deleteConversationFromB2(id).then((ok) => {
    if (ok) savePendingDeletes(loadPendingDeletes().filter((pid) => pid !== id));
  });

  if (id === currentConversationId) {
    currentConversationId = null;
    loadingConversationId = null;
    conversation = [];
    conversationMeta = [];
    conversationApprovals = [];
    resetDesignState(false);
    renderConversation();
    updateConversationTitle();
  }

  renderSidebarHistory();
}

/* ════════════════════════════════════════════════════════
   SIDEBAR
════════════════════════════════════════════════════════ */

// Reset-to-a-blank-conversation, triggered either by clicking New Chat
// while already on the chat view, or via the 'cognita:new-chat' event
// dispatched by js/router.js when New Chat is clicked from another view.
function startNewConversation() {
  if (isSending) {
    showToast('Please wait for the reply to finish before starting a new chat.');
    return;
  }
  currentConversationId = null;
  loadingConversationId = null;
  conversation = [];
  conversationMeta = [];
  conversationApprovals = [];
  resetDesignState(false);
  renderConversation();
  updateConversationTitle();
  renderSidebarHistory();
  closeMobileSidebar();
}

/* ════════════════════════��═══════════════════════════════
   QUALITY PICKER
════════════════════════════════════════════════════════ */

function setQuality(quality) {
  currentQuality = quality;
  const meta = QUALITY_META[quality] || QUALITY_META.standard;

  document.getElementById('qualityPickerLabel').textContent = meta.label;

  document.querySelectorAll('.quality-picker-option').forEach((opt) => {
    opt.classList.toggle('is-active', opt.dataset.quality === quality);
  });
}

function wireQualityPicker() {
  const trigger = document.getElementById('qualityPickerTrigger');
  const menu = document.getElementById('qualityPickerMenu');
  const options = document.querySelectorAll('.quality-picker-option');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('is-open');
    menu.classList.toggle('is-open', !isOpen);
    trigger.classList.toggle('is-open', !isOpen);
    trigger.setAttribute('aria-expanded', String(!isOpen));
  });

  document.addEventListener('click', () => {
    menu.classList.remove('is-open');
    trigger.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
  });

  options.forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const tierKey = _tierKeyForQuality(opt.dataset.quality);
      if (!currentAccountChatTiers.includes(tierKey)) {
        showToast('This quality level requires a higher Cognita plan. Upgrade to unlock it.');
        menu.classList.remove('is-open');
        trigger.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
        return;
      }
      setQuality(opt.dataset.quality);
      menu.classList.remove('is-open');
      trigger.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
    });
  });
}

/* ════════════════════════════════════════════════════════
   COMPOSER PLACEHOLDER — TYPEWRITER EFFECT
════════════════════════════════════════════════════════ */

function startPlaceholderTypewriter() {
  if (placeholderRunning) return;
  placeholderRunning = true;
  typeCurrentPlaceholder(0);
}

function stopPlaceholderTypewriter() {
  placeholderRunning = false;
  if (placeholderTimeoutId) {
    clearTimeout(placeholderTimeoutId);
    placeholderTimeoutId = null;
  }
}

function typeCurrentPlaceholder(charIndex) {
  if (!placeholderRunning) return;
  const input = document.getElementById('composerInput');
  if (!input || input.value) { placeholderRunning = false; return; }

  const phrase = PLACEHOLDERS[placeholderIndex];
  input.placeholder = phrase.slice(0, charIndex);

  if (charIndex < phrase.length) {
    placeholderTimeoutId = setTimeout(() => typeCurrentPlaceholder(charIndex + 1), TYPE_SPEED_MS);
  } else {
    placeholderTimeoutId = setTimeout(() => deleteCurrentPlaceholder(phrase.length), HOLD_AFTER_TYPE_MS);
  }
}

function deleteCurrentPlaceholder(charIndex) {
  if (!placeholderRunning) return;
  const input = document.getElementById('composerInput');
  if (!input || input.value) { placeholderRunning = false; return; }

  const phrase = PLACEHOLDERS[placeholderIndex];
  input.placeholder = phrase.slice(0, charIndex);

  if (charIndex > 0) {
    placeholderTimeoutId = setTimeout(() => deleteCurrentPlaceholder(charIndex - 1), DELETE_SPEED_MS);
  } else {
    placeholderIndex = (placeholderIndex + 1) % PLACEHOLDERS.length;
    placeholderTimeoutId = setTimeout(() => typeCurrentPlaceholder(0), 300);
  }
}

// Called on any composer activity: pause the effect immediately, and
// schedule it to resume a few seconds after the user goes quiet again.
function notifyComposerActivity() {
  stopPlaceholderTypewriter();
  if (placeholderResumeTimeoutId) clearTimeout(placeholderResumeTimeoutId);

  placeholderResumeTimeoutId = setTimeout(() => {
    const input = document.getElementById('composerInput');
    if (input && !input.value) {
      startPlaceholderTypewriter();
    }
  }, RESUME_AFTER_IDLE_MS);
}

/* ════════════════════════════════════════════════════════
   "+" ATTACH MENU
════════════════════════════════════════════════════════ */

function wireAttachMenu() {
  const trigger = document.getElementById('attachMenuTrigger');
  const menu = document.getElementById('attachMenuList');
  const filesItem = document.getElementById('attachFilesItem');
  const diagramItem = document.getElementById('attachDiagramItem');
  const illustrationItem = document.getElementById('attachIllustrationItem');
  const documentItem = document.getElementById('attachDocumentItem');
  const connectorsItem = document.getElementById('attachConnectorsItem');
  const noteTakerItem = document.getElementById('attachNoteTakerItem');
  const fileInput = document.getElementById('fileInput');

  function closeMenu() {
    menu.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('is-open');
    menu.classList.toggle('is-open', !isOpen);
    trigger.setAttribute('aria-expanded', String(!isOpen));
  });

  document.addEventListener('click', closeMenu);
  menu.addEventListener('click', (e) => e.stopPropagation());

  filesItem.addEventListener('click', () => {
    closeMenu();
    fileInput.click();
  });

  diagramItem.addEventListener('click', () => {
    closeMenu();
    openVisualModal('diagram');
  });

  illustrationItem.addEventListener('click', () => {
    closeMenu();
    openVisualModal('illustration');
  });

  documentItem.addEventListener('click', () => {
    closeMenu();
    openDocumentModal();
  });

  connectorsItem.addEventListener('click', () => {
  closeMenu();
  openConnectorsModal();
  });
  noteTakerItem.addEventListener('click', () => {
  closeMenu();
  window.dispatchEvent(new CustomEvent('cognita:open-note-taker'));
  });
  }

/* ════════════════════════════════════════════════════════
   COMPOSER + ATTACHMENTS + SENDING MESSAGES
════════════════════════════════════════════════════════ */

// Detects whether this device's primary input is touch (phones/tablets)
// rather than a mouse/trackpad with a real keyboard. Used to decide
// whether Enter should send the message or just insert a line break —
// on touch devices there's no reliable Shift key, so intercepting Enter
// there makes it impossible to ever add a line break.
function _isTouchPrimaryDevice() {
  return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
}

function wireComposer() {
  const input = document.getElementById('composerInput');
  const sendBtn = document.getElementById('sendBtn');
  const fileInput = document.getElementById('fileInput');

  function refreshSendEnabled() {
    sendBtn.disabled = (!input.value.trim() && pendingAttachments.length === 0) || isSending;
  }

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    refreshSendEnabled();
    notifyComposerActivity();
  });

  input.addEventListener('focus', notifyComposerActivity);

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;

    // Never treat Enter as "send" while an IME composition is in
    // progress (e.g. typing accented characters, or Chinese/Japanese/
    // Korean input) — that Enter is confirming the composed character,
    // not submitting the message. e.keyCode === 229 is the older
    // cross-browser signal some engines still rely on alongside
    // isComposing.
    if (e.isComposing || e.keyCode === 229) return;

    // On touch-primary devices (phones/tablets) there's no dependable
    // Shift key, so Enter always inserts a line break there — sending
    // happens via the send button instead. On keyboard-primary devices,
    // Enter sends and Shift+Enter inserts a line break, as before.
    if (_isTouchPrimaryDevice()) return;

    if (e.shiftKey) return;

    e.preventDefault();
    if (!sendBtn.disabled) sendMessage(input.value.trim());
  });

  sendBtn.addEventListener('click', () => {
    sendMessage(input.value.trim());
  });

  // Single picker handles images, plain text/csv, PDFs, and Word docs —
  // routed by mime type/extension once a file is chosen.
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;

    await handlePickedFile(file);
    renderComposerAttachments();
    refreshSendEnabled();
    input.focus();
  });
}

async function handlePickedFile(file) {
  const isImage = IMAGE_MIME_RE.test(file.type);
  const isTextLike = TEXT_MIME_TYPES.includes(file.type) || TEXT_FILE_RE.test(file.name);
  const isPdf = file.type === PDF_MIME || PDF_FILE_RE.test(file.name);
  const isDocx = file.type === DOCX_MIME || DOCX_FILE_RE.test(file.name);
  const isLegacyDoc = DOC_FILE_RE.test(file.name) && !isDocx;

  if (isImage) {
    await handleImageFile(file);
    return;
  }

  // Spreadsheets and data files go into the code workspace, so a big file is
  // never pasted into the prompt. Small txt/md files stay inline as before.
  if (WORKSPACE_DATA_RE.test(file.name) || (WORKSPACE_TEXT_RE.test(file.name) && file.size > WORKSPACE_TEXT_MIN_BYTES)) {
    const maxBytes = sandboxFileLimitBytes();
    const isXlsx = /\.xlsx$/i.test(file.name);
    if (file.size <= maxBytes) {
      try {
        const data = await file.arrayBuffer();
        pendingAttachments.push({
          name: file.name, kind: 'data', size: file.size, data,
          preview: isXlsx ? '' : previewOfText(new TextDecoder('utf-8', { fatal: false }).decode(data.slice(0, 16384))),
        });
      } catch (err) {
        console.error('[app] Could not read file:', err.message);
        showToast('Could not read that file.');
      }
      return;
    }
    showToast(file.name + ' is bigger than the ' + Math.round(maxBytes / 1048576) + ' MB your plan allows for code runs.');
    if (isXlsx) { pendingAttachments.push({ name: file.name, kind: 'unsupported' }); return; }
    // Text formats fall through to the inline path below (capped as before).
  }

  if (isTextLike) {
    try {
      const text = await file.text();
      pendingAttachments.push({ name: file.name, kind: 'text', text: _capText(text) });
    } catch (err) {
      console.error('[app] Could not read file:', err.message);
      showToast('Could not read that file.');
    }
    return;
  }

  if (isPdf) {
    if (!window.pdfjsLib) {
      pendingAttachments.push({ name: file.name, kind: 'unsupported' });
      showToast('PDF reading is still loading — try again in a moment.');
      return;
    }
    try {
      const text = await extractPdfText(file);
      pendingAttachments.push({ name: file.name, kind: 'text', text: _capText(text) });
    } catch (err) {
      console.error('[app] Could not read PDF:', err.message);
      pendingAttachments.push({ name: file.name, kind: 'unsupported' });
      showToast('Could not extract text from that PDF.');
    }
    return;
  }

  if (isDocx) {
    if (!window.mammoth) {
      pendingAttachments.push({ name: file.name, kind: 'unsupported' });
      showToast('Word document reading is still loading — try again in a moment.');
      return;
    }
    try {
      const text = await extractDocxText(file);
      pendingAttachments.push({ name: file.name, kind: 'text', text: _capText(text) });
    } catch (err) {
      console.error('[app] Could not read Word document:', err.message);
      pendingAttachments.push({ name: file.name, kind: 'unsupported' });
      showToast('Could not extract text from that document.');
    }
    return;
  }

  if (isLegacyDoc) {
    // Legacy binary .doc isn't readable by mammoth (which only handles
    // .docx). Flag it rather than pretending to read it.
    pendingAttachments.push({ name: file.name, kind: 'unsupported' });
    showToast('Old .doc files aren\'t supported yet — please use .docx.');
    return;
  }

  // pptx, xlsx, and anything else not yet wired for extraction.
  pendingAttachments.push({ name: file.name, kind: 'unsupported' });
}

function _capText(text) {
  if (text.length <= MAX_EXTRACTED_CHARS) return text;
  return text.slice(0, MAX_EXTRACTED_CHARS) + '\n\n[Content truncated — file was longer than could be included.]';
}

function sandboxFileLimitBytes() {
  const mb = currentSandboxLimits && currentSandboxLimits.maxFileMB ? currentSandboxLimits.maxFileMB : DEFAULT_SANDBOX_FILE_MB;
  return mb * 1024 * 1024;
}

/* The first 12 lines, at most 1,500 characters. Enough for the model to see the
 * columns and a few rows without the whole file going through the prompt. */
function previewOfText(text) {
  const lines = String(text || '').split(/\r?\n/).slice(0, 12).join('\n');
  return lines.length > 1500 ? lines.slice(0, 1500) + '\n[preview cut]' : lines;
}

/* What the model is told about a file that was put in the workspace. It stays
 * in the chat history, so later messages still know the file exists. */
function workspaceStub(att) {
  const kb = att.size < 1024 ? att.size + ' B' : Math.max(1, Math.round(att.size / 1024)) + ' KB';
  if (/\.xlsx$/i.test(att.name)) {
    return '[Attached Excel workbook "' + att.name + '" (' + kb + ') is in the workspace at ' + att.path +
      '. Open it with pandas.read_excel. If it is missing later, ask the user to attach it again.]';
  }
  const header = /\.(csv|tsv)$/i.test(att.name) && att.preview ? '\nHeader row: ' + att.preview.split('\n')[0] : '';
  return '[Attached file "' + att.name + '" (' + kb + ') is in the workspace at ' + att.path +
    '. If it is missing later, ask the user to attach it again.' + header + '\nPreview (first lines):\n' + (att.preview || '(empty)') + ']';
}

async function extractPdfText(file) {
  const arrayBuffer = await file.arrayBuffer();
  if (window.pdfjsLib.GlobalWorkerOptions && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  const maxPages = Math.min(pdf.numPages, 30); // guard against huge scans
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(' ') + '\n\n';
  }
  if (pdf.numPages > maxPages) {
    text += '[Only the first ' + maxPages + ' of ' + pdf.numPages + ' pages were read.]';
  }
  return text.trim();
}

async function extractDocxText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer });
  return (result.value || '').trim();
}

async function handleImageFile(file) {
  if (!IMAGE_MIME_RE.test(file.type)) {
    pendingAttachments.push({ name: file.name, kind: 'unsupported' });
    return;
  }
  if (!currentAccountHasVision) {
    showToast('Image understanding is available on Cognita Plus and above.');
    return;
  }

  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.split(',')[1];
    pendingAttachments.push({
      name: file.name,
      kind: 'image',
      dataUrl,
      base64,
      mimeType: file.type,
    });
  } catch (err) {
    console.error('[app] Could not read image:', err.message);
    showToast('Could not read that image.');
  }
}

function renderComposerAttachments() {
  const wrap = document.getElementById('composerAttachments');
  if (pendingAttachments.length === 0) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }

  wrap.hidden = false;
  wrap.innerHTML = pendingAttachments.map((att, i) => {
    if (att.kind === 'image') {
      return '<span class="attachment-chip attachment-chip-image">' +
        '<img src="' + att.dataUrl + '" alt="">' +
        '<span class="attachment-chip-name">' + escapeHtml(att.name) + '</span>' +
        '<button type="button" data-remove-attachment="' + i + '"><i class="ph ph-x"></i></button>' +
      '</span>';
    }
    const icon = att.kind === 'unsupported' ? 'warning' : 'file-text';
    const suffix = att.kind === 'unsupported' ? ' (not readable yet)' : '';
    return '<span class="attachment-chip">' +
      '<i class="ph ph-' + icon + '"></i>' +
      '<span class="attachment-chip-name">' + escapeHtml(att.name) + suffix + '</span>' +
      '<button type="button" data-remove-attachment="' + i + '"><i class="ph ph-x"></i></button>' +
    '</span>';
  }).join('');

  wrap.querySelectorAll('[data-remove-attachment]').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingAttachments.splice(parseInt(btn.dataset.removeAttachment, 10), 1);
      renderComposerAttachments();
      const input = document.getElementById('composerInput');
      document.getElementById('sendBtn').disabled = !input.value.trim() && pendingAttachments.length === 0;
    });
  });
}

// The four prompt chips live at the top of the composer now (not in the
// empty state), and are meant to be a brief nudge on a fresh sign-in —
// not a permanent fixture the user has to look past every time they
// open the chat. sessionStorage means they reappear on the next real
// login (new tab/session) but not on every view switch within one.
//
// Behaviour:
//  - Tapping a chip only FILLS the message box with that prompt (and
//    focuses it) so the user can edit it before sending. Nothing is sent.
//  - The auto-hide countdown is paused while the user is interacting
//    with the chips (touching, scrolling, hovering, keyboard focus) and
//    starts again from the full delay once they let go.
const SUGGESTIONS_SEEN_KEY = 'cognita:composerSuggestionsSeen';
const SUGGESTIONS_AUTOHIDE_MS = 6000;

function wireComposerSuggestions() {
  const el = document.getElementById('composerSuggestions');
  if (!el) return;

  if (sessionStorage.getItem(SUGGESTIONS_SEEN_KEY)) {
    el.remove();
    return;
  }
  sessionStorage.setItem(SUGGESTIONS_SEEN_KEY, '1');

  const input = document.getElementById('composerInput');

  let hidden = false;
  let autohideTimer = null;

  const stopTimer = () => {
    if (autohideTimer) { clearTimeout(autohideTimer); autohideTimer = null; }
  };
  const hide = () => {
    if (hidden) return;
    hidden = true;
    stopTimer();
    el.classList.add('is-hidden');
    setTimeout(() => el.remove(), 400);
  };
  // (Re)starts the full countdown. Calling it again always resets it.
  const startTimer = () => {
    if (hidden) return;
    stopTimer();
    autohideTimer = setTimeout(hide, SUGGESTIONS_AUTOHIDE_MS);
  };

  startTimer();

  // Pause while the user is interacting with the chips; restart the
  // countdown once they stop.
  el.addEventListener('pointerdown', stopTimer);
  el.addEventListener('pointerup', startTimer);
  el.addEventListener('pointercancel', startTimer); // browser took over the touch to scroll
  el.addEventListener('mouseenter', stopTimer);
  el.addEventListener('mouseleave', startTimer);
  el.addEventListener('focusin', stopTimer);
  el.addEventListener('focusout', startTimer);
  // Sideways swiping (including the momentum after the finger lifts):
  // every scroll tick resets the countdown, so it only runs once the
  // strip has stopped moving.
  el.addEventListener('scroll', startTimer, { passive: true });

  // As soon as the user types anything themselves, the chips have done
  // their job.
  if (input) {
    input.addEventListener('input', hide, { once: true });
  }

  el.querySelectorAll('.composer-suggestion-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (!input) return;
      input.value = chip.dataset.prompt || '';
      // Fire the normal "input" handler so the box resizes to fit the
      // text, the send button becomes enabled, and the animated
      // placeholder stops — exactly as if the user had typed it.
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      // Put the cursor at the end so the user can keep typing/editing.
      const end = input.value.length;
      input.setSelectionRange(end, end);
      hide();
    });
  });
}

// Builds the text actually sent to the API for a given conversation
// message: the user's typed text plus any attached file content/notes.
// This is kept separate from what's rendered on screen, so a big PDF,
// DOCX, or text file never dumps its raw content into the visible chat
// bubble — only the typed text and a small attachment chip show up there.
function buildEffectiveContent(msg) {
  let text = msg.content || '';
  if (msg.attachments && msg.attachments.length) {
    const fileAtts = msg.attachments.filter((a) => a.kind === 'file');
    const unsupportedAtts = msg.attachments.filter((a) => a.kind === 'unsupported');
    const workspaceAtts = msg.attachments.filter((a) => a.kind === 'workspace' && a.stub);

    if (fileAtts.length) {
      text += fileAtts.map((a) =>
        '\n\n--- Content of attached file "' + a.name + '" ---\n' + a.text
      ).join('');
    }
    if (workspaceAtts.length) {
      text += workspaceAtts.map((a) => '\n\n' + a.stub).join('');
    }
    if (unsupportedAtts.length) {
      text += unsupportedAtts.map((a) =>
        '\n\n[The user attached "' + a.name + '" but this file type cannot be read yet — let them know.]'
      ).join('');
    }
  }
  return text.trim();
}

// What the model is shown for an earlier assistant answer. The saved text has the component blocks
// removed, so without this a follow-up like "make the rent 30% higher and update the chart" cannot
// name the component to patch and the model rewrites everything as plain text instead.
function historyContent(m, i) {
  const base = buildEffectiveContent(m);
  if (!m || m.role !== 'assistant') return base;
  const meta = conversationMeta[i];
  const blocks = meta && Array.isArray(meta.ui) ? meta.ui : [];
  if (!blocks.length) return base;
  const slim = (b) => ({ id: b.id, type: b.type, props: b.props, children: Array.isArray(b.children) && b.children.length ? b.children.map(slim) : undefined });
  let json = '';
  try { json = JSON.stringify(blocks.map(slim)); } catch (_) { json = ''; }
  if (json.length > 6000) json = JSON.stringify(blocks.map((b) => ({ id: b.id, type: b.type, title: b.props && b.props.title })));
  return (base + '\n\n[Components already shown on screen with this answer (not text to repeat): ' + json +
    ' To change one, answer with a short sentence and a cognita-ui patch for its id; do not rewrite the answer.]').trim();
}

/* Copies the attached data files into this chat's workspace. Resolves a Map
 * from each pending attachment to the saved message attachment. A file that
 * could not be saved falls back to the old inline text for text formats, or to
 * "not readable" for spreadsheets, and the person is told why. */
async function putDataAttachments(list) {
  const out = new Map();
  if (!list.length) return out;
  const conversationId = ensureConversationId();
  const lim = currentSandboxLimits || {};
  let res;
  try {
    res = await getSandbox().putFiles(
      conversationId,
      list.map((a) => ({ name: a.name, data: a.data.slice(0) })),
      { maxFileBytes: sandboxFileLimitBytes(), maxWorkspaceBytes: (lim.maxWorkspaceMB || 10) * 1024 * 1024 }
    );
  } catch (e) {
    res = { saved: [], errors: list.map((a) => ({ name: a.name, error: 'The code sandbox could not start.' })) };
  }
  const byName = new Map((res.saved || []).map((s) => [s.name, s]));
  const failed = new Map((res.errors || []).map((e) => [e.name, e.error]));
  list.forEach((a) => {
    const saved = byName.get(a.name);
    if (saved) {
      const att = { kind: 'workspace', name: a.name, path: saved.path, size: a.size, preview: a.preview };
      att.stub = workspaceStub(att);
      delete att.preview;
      out.set(a, att);
      return;
    }
    showToast(a.name + ': ' + (failed.get(a.name) || 'could not be added to the workspace.'));
    if (/\.xlsx$/i.test(a.name)) { out.set(a, { kind: 'unsupported', name: a.name }); return; }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(a.data);
    out.set(a, { kind: 'file', name: a.name, text: _capText(text) });
  });
  return out;
}

/* Starts loading the Python core in the background, but only when it is likely
 * to be needed and the connection can afford it: this chat already ran code, a
 * data file is attached, or the message matches the sandbox gate. Never on
 * page load, never on Data Saver or a 2G link. Loads the core only (never
 * pandas), so the cost is small. */
function warmSandboxIfUseful(text, hasDataFile) {
  const c = navigator.connection;
  if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return;
  if (hasDataFile || conversationHasSandbox() || shouldOfferSandbox({ text }).offer) {
    getSandbox().warm();
  }
}

async function sendMessage(text) {
  if (isSending || (!text && pendingAttachments.length === 0)) return;
  if (loadingConversationId && loadingConversationId === currentConversationId) {
    // The saved messages haven't downloaded yet. Sending now would save a
    // new conversation over the real one.
    showToast('This chat is still loading. Please wait a moment.');
    return;
  }
  isSending = true;
  streamScroll.follow = true; // sending means the person wants to see the answer arrive

  const input = document.getElementById('composerInput');
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('sendBtn').disabled = true;
  notifyComposerActivity();

  // Attachments kept for display (thumbnails/chips) — never the raw
  // base64 string or full file text is put into the visible message.
  const attachmentsForMessage = pendingAttachments.map((a) => {
    if (a.kind === 'data') return savedToWorkspace.get(a) || { kind: 'unsupported', name: a.name };
    if (a.kind === 'workspace') return { kind: 'workspace', name: a.name, path: a.path, size: a.size, stub: a.stub };
    if (a.kind === 'image') return { kind: 'image', name: a.name, dataUrl: a.dataUrl, mimeType: a.mimeType };
    if (a.kind === 'text') return { kind: 'file', name: a.name, text: a.text };
    return { kind: 'unsupported', name: a.name };
  });

  // A data file (csv, xlsx, ...) goes straight into the workspace, so the
  // sandbox tools must be offered for this message (see sandboxHint below).
  const sendingDataFile = pendingAttachments.some((a) => a.kind === 'data' || a.kind === 'workspace');
  const savedToWorkspace = await putDataAttachments(pendingAttachments.filter((a) => a.kind === 'data'));

  // What actually goes to the vision model — base64 + mime only, never
  // rendered as text anywhere.
  const outgoingImages = pendingAttachments
    .filter((a) => a.kind === 'image')
    .map((a) => ({ base64: a.base64, mimeType: a.mimeType }));

  pendingAttachments = [];
  renderComposerAttachments();

  const userMessage = { role: 'user', content: text || '' };
  if (attachmentsForMessage.length > 0) userMessage.attachments = attachmentsForMessage;
  conversation.push(userMessage);
  renderConversation();
  updateConversationTitle();

  const payload = {
    messages: conversation.map((m, i) => ({ role: m.role, content: historyContent(m, i) })),
    quality: currentQuality,
    approvals: conversationApprovals,
    sandboxHint: sendingDataFile || conversationHasSandbox(),
    mediaHint: conversationHasMedia(),
    ...designPayload(text),
  };
  if (outgoingImages.length > 0) payload.images = outgoingImages;

  warmSandboxIfUseful(text, sendingDataFile);
  await runStreamedTurn(payload);
  isSending = false;
}

/* Shared by a fresh message send and a confirmed tool-call resume (see
 * resolvePendingToolCall) — both are just a POST to /api/chat that comes
 * back as an SSE stream of `round` / `step` / `error` / `done` events
 * (see the big comment above the streaming section in chat-endpoint.js).
 * This drives a single live indicator bubble in real time as each event
 * arrives, then commits the finished turn into `conversation` /
 * `conversationMeta` exactly once, on `done`. */
async function runStreamedTurn(payload, resume) {
  // `resume` is set when this request continues a turn that paused so the
  // browser could run code (see continueAfterSandbox). It carries the live
  // indicator, the start time and the steps already finished, so the person
  // sees one unbroken turn instead of several.
  const turn = resume || { live: createLiveTurnIndicator(), startedAt: performance.now(), carry: [], media: [] };
  if (!Array.isArray(turn.media)) turn.media = [];
  const live = turn.live;
  const startedAt = turn.startedAt;
  payload.conversationId = payload.conversationId || ensureConversationId();
  let settled = false;
  let paused = null;

  const finishWithError = (message, status) => {
    if (settled) return;
    settled = true;
    // Steps that already ran stay on screen (marked stopped) so the person can
    // see what was done before the error; otherwise the bubble just goes away.
    if (live.stepsShown() > 0) live.interrupt(); else live.remove();
    const wasApproving = approvingIndex;
    approvingIndex = null;
    if (wasApproving != null) refreshActivity(wasApproving);
    appendSystemNotice(message || 'Something went wrong. Please try again.', status === 429 ? 'limit' : 'error');
  };

  const finishWithData = (data) => {
    if (settled) return;
    settled = true;
    live.stopWorkClock();
    const workMs = live.workElapsedMs();
    const liveShown = live.shownText();
    const liveHadUi = live.uiShown();
    live.remove();
    approvingIndex = null;
    const elapsedMs = performance.now() - startedAt;
    conversation.push({ role: 'assistant', content: data.reply || '' });
    conversationMeta[conversation.length - 1] = {
      // Time the backend was really thinking before the first output (see createLiveTurnIndicator).
      thoughtMs: live.thoughtMs(),
      sources: data.sources || null,
      elapsedMs,
      workMs,
      pendingToolCall: data.pendingToolCall ? { ...data.pendingToolCall, status: 'pending' } : null,
      // create_design is waiting for details or files (see renderDesignRequestHtml).
      designRequest: data.pendingDesignRequest ? { ...data.pendingDesignRequest, status: 'pending' } : null,
      // Files from the workspace the person can download, shown under the
      // answer (see renderDeliverablesHtml). Only path, title and size are kept.
      deliverables: cleanDeliverables(data.deliverables),
      // Structured components the model chose for this answer (see ui-schema.js). Validated again here and again at render time.
      ui: validateUi(data.ui),
      // Pictures and designs made this turn (each arrived as a `media` event).
      media: cleanMedia(turn.media),
      // `steps` is the full recorded action chain for this turn (Bug 2) —
      // may contain several entries (read → write → verify, etc.), not
      // just one. Falls back to the legacy single-object `toolExecuted`
      // field for compatibility with any cached older responses. Steps
      // finished before a sandbox pause (turn.carry) come first.
      steps: turn.carry.concat(Array.isArray(data.steps) ? data.steps : (data.toolExecuted ? [data.toolExecuted] : [])),
    };
    // The backend echoes back the full, updated approvals list — including
    // anything newly approved this turn — so this conversation never
    // re-asks for the same write again (Bug 4).
    if (Array.isArray(data.approvals)) conversationApprovals = data.approvals;
    // Text already streamed live from the model: the finished reply continues from what is on
    // screen (no replay from the start, no jump to the full text).
    freshAssistantIndex = conversation.length - 1;
    streamResume = liveShown || liveHadUi ? { index: freshAssistantIndex, shown: liveShown, hadUi: liveHadUi } : null;
    const uiTouched = applyIncomingUiPatches(data.uiPatches);
    renderConversation();
    uiTouched.forEach((i) => { if (conversationMeta[i]) refreshUi(document, i, conversationMeta[i].ui); });
    refreshUsage();
    persistCurrentConversation();
  };

  try {
    await streamChatSSE(WORKER_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, {
      onSignal: () => live.signal(),
      onRound: () => live.addPendingRow(),
      onStepStart: (m) => live.addStepStart(m),
      onStep: (step) => live.addStep(step),
      onMedia: (m) => { if (m && turn.media.length < 6) turn.media.push(m); },
      onUi: (d) => { if (d && Array.isArray(d.ui)) live.showUi(d.ui, d.pending); },
      onText: (d) => { if (d && typeof d.t === 'string') live.showText(d.t); },
      onTextReset: () => live.resetStream(),
      onSandboxCall: (c) => live.addPendingRow(c && c.summary),
      onDone: (data) => {
        if (data && data.pendingSandboxCall) { paused = data; return; }
        finishWithData(data);
      },
      onError: (data) => finishWithError(data && data.message, data && data.status),
      onFatal: (message, status) => finishWithError(message, status),
    });
  } catch (e) {
    console.error('[app] chat stream failed:', e.message);
    finishWithError('Could not reach Cognita. Please check your connection.', 0);
    return;
  }

  // The turn paused because the model asked to run code. Run it here, in
  // the browser sandbox, then send the real result back to continue.
  if (paused && !settled) {
    await continueAfterSandbox(payload, paused, turn);
    return;
  }

  // The connection closed without ever sending an `error` or `done`
  // event — e.g. the Worker crashed mid-stream, or a proxy cut the
  // connection. Never leave the user staring at a spinner forever, and
  // never silently pretend the turn succeeded.
  if (!settled) {
    finishWithError('Connection to Cognita was interrupted before a response was received.', 0);
  }
}

/* Runs the sandbox call the Worker handed over, shows it live, then
 * resumes the same turn with the real result. Everything the model sees
 * about the run (output, exit code, files) comes from this execution. */
async function continueAfterSandbox(payload, paused, turn) {
  const call = paused.pendingSandboxCall;
  const live = turn.live;
  if (Array.isArray(paused.steps)) turn.carry.push(...paused.steps);
  if (Array.isArray(paused.approvals)) conversationApprovals = paused.approvals;

  const run = live.startSandboxRun(call);
  let outcome;
  try {
    outcome = await getSandbox().run(call, payload.conversationId, {
      onOutput: run.onOutput,
      onStatus: run.onStatus,
    });
  } catch (e) {
    outcome = { result: { command: call.summary || call.name, cwd: '/workspace', stdout: '', stderr: 'The sandbox could not run this: ' + (e && e.message ? e.message : 'unknown error'), exitCode: 1, durationMs: 0 }, cancelled: false };
  }
  const result = outcome.result || {};

  const step = {
    type: 'sandbox', name: call.name, provider: 'sandbox',
    providerLabel: /browser/i.test(String(call.name || '')) ? 'Browser' : 'Code', kind: 'run',
    ok: result.exitCode === 0, cancelled: !!outcome.cancelled,
    summary: call.summary || call.name,
    sandbox: trimSandboxResultForStorage(result),
  };
  run.finish(step);
  turn.carry.push(step);

  await runStreamedTurn({
    messages: payload.messages,
    quality: payload.quality,
    approvals: conversationApprovals,
    conversationId: payload.conversationId,
    sandboxHint: payload.sandboxHint,
    mediaHint: payload.mediaHint,
    sandboxResume: {
      // Long string arguments (such as imported file text) are not sent back;
      // the server only needs the tool name for its log and the trace.
      call: { id: call.id, name: call.name, args: shortenArgs(call.args) },
      assistantText: call.assistantText || '',
      // The screenshot and the page copy are only for the person's screen; the server never needs them.
      result: withoutPreviewFields(result),
      cancelled: !!outcome.cancelled,
      trace: Array.isArray(paused.turnTrace) ? paused.turnTrace : [],
    },
  }, turn);
}

function withoutPreviewFields(r) {
  const out = Object.assign({}, r);
  delete out.screenshot; delete out.previewHtml; delete out.previewSize;
  return out;
}

function shortenArgs(args) {
  const out = {};
  Object.keys(args || {}).slice(0, 10).forEach((k) => {
    const v = args[k];
    out[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) : v;
  });
  return out;
}

// What is kept in the saved conversation for a sandbox step: enough to show
// the command, its output and the files it touched, not unbounded text.
function trimSandboxResultForStorage(r) {
  const cut = (t) => (typeof t === 'string' && t.length > 4000 ? t.slice(0, 4000) + '\n[output cut]' : (t || ''));
  return {
    command: String(r.command || '').slice(0, 300),
    cwd: r.cwd || '/workspace',
    stdout: cut(r.stdout), stderr: cut(r.stderr),
    exitCode: Number.isInteger(r.exitCode) ? r.exitCode : 0,
    durationMs: r.durationMs || 0,
    truncated: !!r.truncated,
    files: (Array.isArray(r.files) ? r.files : []).slice(0, 20),
    images: imageFilesOf(r.files),
    offered: (Array.isArray(r.offered) ? r.offered : []).slice(0, 10),
    // Kept so the picture and live preview survive a reload; dropped when too big for storage.
    screenshot: r.screenshot && typeof r.screenshot.dataUrl === 'string' && r.screenshot.dataUrl.length <= 150000 &&
      /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(r.screenshot.dataUrl) ? { dataUrl: r.screenshot.dataUrl, width: r.screenshot.width, height: r.screenshot.height } : undefined,
    previewHtml: typeof r.previewHtml === 'string' && r.previewHtml.length <= 60000 ? r.previewHtml : undefined,
    previewSize: r.previewSize && Number.isFinite(r.previewSize.height) ? { width: r.previewSize.width, height: r.previewSize.height } : undefined,
  };
}

/* ── SSE client ──────────────────────────────────────────────────────
 * Parses a text/event-stream response from /api/chat by hand (rather
 * than EventSource, which can't send the Authorization header or a POST
 * body). Buffers raw bytes across chunk boundaries and splits on the
 * blank-line event separator per the SSE spec; `: ping` heartbeat
 * comments (sent periodically by the backend to keep the connection
 * alive during long tool-call rounds) are recognized and ignored. */
async function streamChatSSE(url, options, handlers) {
  let res;
  try {
    res = await window.Auth.authedFetch(url, options);
  } catch (e) {
    handlers.onFatal && handlers.onFatal('Could not reach Cognita. Please check your connection.', 0);
    return;
  }

  if (!res.ok) {
    // A failure caught before the stream ever opened (auth, quota, plan
    // checks, request validation) still comes back as a plain JSON error
    // with a real HTTP status — see the top of handleChatRequest.
    let data = {};
    try { data = await res.json(); } catch (_) {}
    handlers.onFatal && handlers.onFatal(data.error, res.status);
    return;
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    // Streaming reads aren't available in this environment. Fall back to
    // treating the whole response as one JSON payload in case the server
    // ever answers this way.
    try {
      const data = await res.json();
      handlers.onDone && handlers.onDone(data);
    } catch (e) {
      handlers.onFatal && handlers.onFatal('Could not read the response from Cognita.', 500);
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const dispatch = (eventName, data) => {
    if (eventName === 'round') handlers.onRound && handlers.onRound(data);
    else if (eventName === 'step') handlers.onStep && handlers.onStep(data);
    else if (eventName === 'step_start') handlers.onStepStart && handlers.onStepStart(data);
    else if (eventName === 'sandbox_call') handlers.onSandboxCall && handlers.onSandboxCall(data);
    else if (eventName === 'media') handlers.onMedia && handlers.onMedia(data);
    else if (eventName === 'ui') handlers.onUi && handlers.onUi(data);
    else if (eventName === 'text') handlers.onText && handlers.onText(data);
    else if (eventName === 'text_reset') handlers.onTextReset && handlers.onTextReset(data);
    else if (eventName === 'error') handlers.onError && handlers.onError(data);
    else if (eventName === 'done') handlers.onDone && handlers.onDone(data);
    // Unknown event names are ignored rather than treated as fatal, so a
    // future server-added event type never breaks older clients.
  };

  const consumeBuffered = () => {
    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      if (!rawEvent || rawEvent.startsWith(':')) continue; // heartbeat/comment-only

      let eventName = 'message';
      const dataLines = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      const dataStr = dataLines.join('\n');
      if (!dataStr) continue;
      let data;
      try {
        data = JSON.parse(dataStr);
      } catch (e) {
        continue; // malformed frame — skip rather than crash the whole turn
      }
      dispatch(eventName, data);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      handlers.onSignal && handlers.onSignal();
      buffer += decoder.decode(value, { stream: true });
      consumeBuffered();
    }
    // Flush any trailing decoder state and process a final frame that
    // wasn't terminated by a trailing blank line.
    buffer += decoder.decode();
    consumeBuffered();
  } catch (e) {
    console.error('[app] SSE read failed:', e.message);
    handlers.onFatal && handlers.onFatal('Connection to Cognita was interrupted.', 0);
  }
}

/* Live version of the Activity component (see renderActivityHtml for the
 * finished one). It starts as the calm "thinking" line with the cycling
 * words, and turns into the same timeline the saved message uses the moment
 * the first step arrives. Step titles can contain text from repos, files or
 * emails, so every string goes in through escapeHtml or textContent. */
function createLiveTurnIndicator() {
  const list = document.getElementById('messageList');
  const id = 'live-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const el = document.createElement('div');
  el.className = 'message is-assistant';
  el.id = id;
  el.innerHTML =
    '<div class="message-body">' +
      '<div class="thinking-indicator" data-role="idle-indicator">' +
        '<span class="thinking-dot"></span>' +
        '<span class="thinking-word" data-role="word"></span>' +
        '<span class="thinking-timer" data-role="timer">0.0s</span>' +
      '</div>' +
      '<section class="act is-open is-live" data-role="act" hidden>' +
        '<button type="button" class="act-head" aria-expanded="true">' +
          '<span class="act-label" data-role="act-label">Working</span>' +
          '<span class="act-time" data-role="act-time">0s</span>' +
          '<i class="ph ph-caret-down act-caret" aria-hidden="true"></i>' +
        '</button>' +
        '<div class="act-body"><ol class="act-rail" role="list" data-role="rail"></ol></div>' +
        '<span class="act-sr" aria-live="polite" data-role="status"></span>' +
      '</section>' +
    '</div>';
  document.getElementById('emptyState').hidden = true;
  list.hidden = false;
  list.appendChild(el);
  scrollToBottom();

  const wordEl = el.querySelector('[data-role="word"]');
  const timerEl = el.querySelector('[data-role="timer"]');
  const idleEl = el.querySelector('[data-role="idle-indicator"]');
  const actEl = el.querySelector('[data-role="act"]');
  const railEl = el.querySelector('[data-role="rail"]');
  const actTimeEl = el.querySelector('[data-role="act-time"]');
  const statusEl = el.querySelector('[data-role="status"]');
  const labelEl = el.querySelector('[data-role="act-label"]');
  let stepCount = 0;
  let failCount = 0;
  let interrupted = false;
  if (wordEl) wordEl.textContent = THINKING_WORDS[0];

  const startedAt = performance.now();
  // Two clocks. The thinking timer runs from the moment the message is sent.
  // The work timer starts only when the first real step begins (a tool call or
  // a code run), so "Worked for" measures the work and not the wait for the
  // model to decide whether any work was needed.
  let workStartedAt = null;
  let workEndedAt = null;
  // Thinking time is only counted while the backend is demonstrably alive: bytes (or heartbeats)
  // keep arriving and the browser is online. A stalled connection pauses the clock and says so.
  // The count stops for good when the first real output (text, UI or a step) appears.
  const STALL_MS = 25000;       // the server heartbeat is far more frequent than this
  let lastSignalAt = performance.now();
  let thoughtMs = 0;
  let thinkingOver = false;
  let lastTick = performance.now();
  let wordIdx = 0;
  let wordShownAt = performance.now();
  let stallCredited = false;
  const stateOf = () => (!navigator.onLine ? 'offline' : (performance.now() - lastSignalAt > STALL_MS ? 'stalled' : 'ok'));
  const wordInterval = setInterval(() => {
    if (thinkingOver || stateOf() !== 'ok') return;
    if (wordIdx < THINKING_WORDS.length - 1) wordIdx++;   // in order, then hold the last one
    if (wordEl) wordEl.textContent = THINKING_WORDS[wordIdx];
  }, 2200);
  const timerInterval = setInterval(() => {
    const now = performance.now();
    const st = stateOf();
    if (!thinkingOver && st === 'ok') thoughtMs += now - lastTick;
    // The stall is only noticed STALL_MS after the last byte; that silent stretch was counted as
    // thinking while it was still "ok", so take it back once, when the stall is first detected.
    if (st === 'stalled' && !stallCredited) { thoughtMs = Math.max(0, thoughtMs - Math.min(STALL_MS, now - lastSignalAt)); stallCredited = true; }
    else if (st === 'ok') stallCredited = false;
    lastTick = now;
    if (wordEl && !thinkingOver) {
      wordEl.textContent = st === 'offline' ? 'You are offline' : st === 'stalled' ? 'Waiting for connection' : THINKING_WORDS[wordIdx];
    }
    if (timerEl && !thinkingOver) timerEl.textContent = formatClock(thoughtMs);
    if (actTimeEl && workStartedAt !== null) {
      actTimeEl.textContent = formatClock(performance.now() - workStartedAt);
    }
  }, 100);
  activeThinkingTimers[id] = { wordInterval, timerInterval };
  function signal() { lastSignalAt = performance.now(); }
  function endThinking() { if (!thinkingOver) { thinkingOver = true; } }

  let pendingItem = null;   // the one "in progress" row, if any

  function reveal() {
    endThinking();
    if (workStartedAt === null) workStartedAt = performance.now();
    if (idleEl) idleEl.style.display = 'none';
    actEl.hidden = false;
  }
  function say(text) { if (statusEl) statusEl.textContent = text || ''; }

  // "Working · 3 steps, 1 failed" — kept in step with what the rail shows.
  function updateHead() {
    if (!labelEl || interrupted) return;
    labelEl.textContent = 'Working' + (stepCount ? ' · ' + plural(stepCount, 'step', 'steps') : '') + (failCount ? ', ' + failCount + ' failed' : '');
    actEl.classList.toggle('has-fail', failCount > 0);
  }
  function appendItem(item, animate) {
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) item.classList.add('act-item--enter');
    railEl.appendChild(item);
  }

  function putPending(title, sub, icon) {
    if (interrupted) return;
    reveal();
    if (!pendingItem) {
      pendingItem = htmlToElement(actItemHtml({ state: 'running', title: title || 'Working', sub: sub || '', icon: icon || 'ph-sparkle' }));
      appendItem(pendingItem, true);
    } else {
      if (title) pendingItem.querySelector('.act-title').textContent = title;
      const subEl = pendingItem.querySelector('.act-sub');
      if (subEl) subEl.textContent = sub || '';
    }
    say(title);
    scrollToBottom();
  }

  // The server sends `round` every time the model starts a turn, including the
  // very first one, before anyone knows whether work is needed. Without text
  // that is still just thinking, so the "Working" view stays hidden until a
  // real step has started. Between steps it shows the next row as before.
  function addPendingRow(text) {
    if (!text && workStartedAt === null) return;
    putPending(text, '');
  }
  // Placeholder shaped like the picture/design being made; swapped for the real
  // result when the message arrives.
  let skelEl = null;
  function showSkeleton(kind) {
    if (skelEl) return;
    skelEl = htmlToElement(skeletonHtml(kind));
    el.querySelector('.message-body').appendChild(skelEl);
    scrollToBottom();
  }
  function clearSkeleton() { if (skelEl) { skelEl.remove(); skelEl = null; } }

  function addStepStart(m) {
    if (!m || interrupted) return;
    putPending(m.summary, m.providerLabel, stepIconFor(m));
    if (m.name === 'generate_image') showSkeleton('image');
    else if (m.name === 'create_design') showSkeleton('design');
  }

  function addStep(step) {
    if (!step || interrupted) return;
    clearSkeleton();
    reveal();
    if (step.type === 'awaiting_confirmation') {
      if (pendingItem) { pendingItem.remove(); pendingItem = null; }
      return;
    }
    const item = htmlToElement(step.type === 'sandbox' ? renderSandboxStepHtml(step) : renderStepItemHtml(step));
    if (pendingItem) { pendingItem.replaceWith(item); pendingItem = null; }
    else appendItem(item, true);
    stepCount++;
    if (step.ok === false && step.type !== 'blocked') failCount++;
    updateHead();
    hydrateFigures(item);
    say(step.summary);
    scrollToBottom();
  }

  // The running view of one code call: a row with the elapsed time and a Stop
  // button, and a terminal block that fills as output arrives. When the run
  // ends, finish() swaps it for the settled row that saved chats also use.
  function startSandboxRun(call) {
    reveal();
    if (pendingItem) { pendingItem.remove(); pendingItem = null; }
    const item = htmlToElement(actItemHtml({
      state: 'running', title: call.summary || 'Running code',
      sub: /browser/i.test(String(call.name || '')) ? 'Browser' : 'Code', icon: /browser/i.test(String(call.name || '')) ? 'ph-globe' : 'ph-terminal-window', live: true,
      detailHtml: '<div class="sbx-body"><pre class="sbx-out" aria-live="off"></pre></div>', openDetail: true,
    }));
    const timeEl = item.querySelector('.act-ms');
    const outEl = item.querySelector('.sbx-out');
    const titleEl = item.querySelector('.act-title');
    const t0 = performance.now();
    const tick = setInterval(() => { timeEl.textContent = formatClock(performance.now() - t0); }, 100);
    item.querySelector('.sbx-stop').addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      ev.currentTarget.disabled = true;
      getSandbox().cancel(call.id);
    });
    appendItem(item, true);
    say(call.summary);
    scrollToBottom();

    let shown = 0;
    const MAX_SHOWN = 20000;
    return {
      onOutput(stream, text) {
        if (shown >= MAX_SHOWN) return;
        const piece = text.length > MAX_SHOWN - shown ? text.slice(0, MAX_SHOWN - shown) : text;
        shown += piece.length;
        // Keep following the output only while the person has not scrolled it up.
        const stick = outEl.scrollHeight - outEl.scrollTop - outEl.clientHeight < 24;
        const span = document.createElement('span');
        if (stream === 'stderr') span.className = 'sbx-err';
        span.textContent = piece;
        outEl.appendChild(span);
        if (stick) outEl.scrollTop = outEl.scrollHeight;
        scrollToBottom();
      },
      onStatus(text) { titleEl.textContent = text; },
      finish(step) {
        clearInterval(tick);
        const settled = htmlToElement(renderSandboxStepHtml(step));
        item.replaceWith(settled);
        stepCount++;
        if (step.ok === false && !step.cancelled) failCount++;
        updateHead();
        hydrateFigures(settled);
        scrollToBottom();
      },
    };
  }

  function remove() {
    const timers = activeThinkingTimers[id];
    if (timers) {
      clearInterval(timers.wordInterval);
      clearInterval(timers.timerInterval);
      delete activeThinkingTimers[id];
    }
    el.remove();
  }

  // Milliseconds of actual work (first step to now), or null if the turn never
  // needed any. Safe to call after remove().
  function workElapsedMs() {
    if (workStartedAt === null) return null;
    return Math.round((workEndedAt !== null ? workEndedAt : performance.now()) - workStartedAt);
  }
  function stopWorkClock() { if (workStartedAt !== null && workEndedAt === null) workEndedAt = performance.now(); }

  // Progressive structured UI (SSE `ui` frames). Hides the idle dots and draws
  // components as they become valid; the final message replaces this preview.
  // Real model text as it arrives (SSE `text` frames). Every chunk goes into a
  // queue (liveFull); a time-based loop reveals it a whole word at a time
  // through the same markdown renderer the finished reply uses, so chunks that
  // arrive in bursts are smoothed out instead of pasted in. The loop speeds up
  // when the queue grows, so it can never fall behind for long. When `done`
  // arrives, shownText() says exactly what is on screen, and the finished
  // reply carries on from there (see startAssistantStream). `text_reset` drops
  // a model turn that was not the final answer, queue included.
  let liveTextEl = null;
  let liveFull = '';   // everything received for the current model turn
  let livePos = 0;     // characters revealed so far (fractional, time based)
  let liveCut = 0;     // end of the last word actually drawn
  let liveRaf = 0;
  let liveLastT = 0;
  let liveStartT = 0;
  let liveUiShown = false;

  function stopLiveLoop() {
    if (liveRaf) cancelAnimationFrame(liveRaf);
    liveRaf = 0;
    liveLastT = 0;
  }
  function liveFrame(t) {
    liveRaf = 0;
    if (!liveTextEl || !el.isConnected) return;   // removed, or the chat was switched
    if (!liveLastT) { liveLastT = t; if (!liveStartT) liveStartT = t; }
    const dt = Math.min(t - liveLastT, 100);      // a background tab must not make the text lurch forward
    liveLastT = t;
    const backlog = liveFull.length - livePos;
    // Base pace, but never more than ~1.2 s behind what has already arrived.
    const cps = streamClamp(Math.max(STREAM_BASE_CPS, backlog / 1.2), STREAM_BASE_CPS, STREAM_MAX_CPS);
    const ramp = Math.min(1, 0.5 + 0.5 * ((t - liveStartT) / STREAM_RAMP_MS));
    livePos = Math.min(liveFull.length, livePos + cps * ramp * (dt / 1000));
    const nextCut = livePos >= liveFull.length ? liveFull.length : streamWordEnd(liveFull, Math.floor(livePos));
    if (nextCut !== liveCut) {
      liveCut = nextCut;
      streamPatch(liveTextEl, streamSafePrefix(liveFull.slice(0, liveCut)), null, 'live-');
      scrollToBottom();
    }
    if (livePos < liveFull.length) liveRaf = requestAnimationFrame(liveFrame);
    else liveLastT = 0;                            // caught up: sleep until the next chunk
  }
  function showText(t) {
    const body = el.querySelector('.message-body');
    if (!body || !t) return;
    const idle = el.querySelector('[data-role="idle-indicator"]');
    if (idle) idle.hidden = true;
    if (!liveTextEl || !liveTextEl.isConnected) {
      liveTextEl = document.createElement('div');
      liveTextEl.className = 'message-content live-stream-text';
      const liveUi = body.querySelector('[data-cui-live]');
      if (liveUi) body.insertBefore(liveTextEl, liveUi); else body.appendChild(liveTextEl);
    }
    endThinking();
    // The answer has started, so the generic "Working" row has nothing left to wait for.
    if (pendingItem) { pendingItem.remove(); pendingItem = null; }
    liveFull += t;
    if (!liveRaf) liveRaf = requestAnimationFrame(liveFrame);
  }
  function showUi(blocks, pending) {
    const idle = el.querySelector('[data-role="idle-indicator"]');
    if (idle) idle.hidden = true;
    endThinking();
    liveUiUpdate(el.querySelector('.message-body'), blocks, pending);
    if (el.querySelector('[data-cui-live]')) liveUiShown = true;
    scrollToBottom();
  }
  function resetStream() {
    stopLiveLoop();
    if (liveTextEl) { liveTextEl.remove(); liveTextEl = null; }
    liveFull = ''; livePos = 0; liveCut = 0; liveStartT = 0; liveUiShown = false;
    const liveUi = el.querySelector('[data-cui-live]');
    if (liveUi) liveUi.remove();
    // That text was only a lead-in to a tool call: show the work as ongoing again.
    if (workStartedAt !== null && !pendingItem && !interrupted) putPending('Working', '');
  }

  // The turn failed after some steps had already run. Keep them on screen,
  // stop every clock and spinner, and say plainly that it stopped.
  function interrupt() {
    if (interrupted) return;
    interrupted = true;
    stopLiveLoop();
    const timers = activeThinkingTimers[id];
    if (timers) { clearInterval(timers.wordInterval); clearInterval(timers.timerInterval); delete activeThinkingTimers[id]; }
    if (pendingItem) { pendingItem.remove(); pendingItem = null; }
    railEl.querySelectorAll('.act-item[data-state="running"]').forEach((li) => {
      li.dataset.state = 'stopped';
      const n = li.querySelector('.act-node');
      if (n) n.innerHTML = '<i class="ph ph-minus"></i>';
      const stop = li.querySelector('.sbx-stop'); if (stop) stop.remove();
    });
    if (idleEl) idleEl.style.display = 'none';
    actEl.classList.remove('is-live');
    actEl.classList.add('has-fail');
    if (labelEl) labelEl.textContent = 'Stopped' + (stepCount ? ' after ' + plural(stepCount, 'step', 'steps') : '');
    say('Stopped');
  }

  return {
    stepsShown: () => stepCount, interrupt,
    id, addPendingRow, addStepStart, addStep, startSandboxRun, workElapsedMs, stopWorkClock, showUi, showText, resetStream,
    signal, thoughtMs: () => Math.round(thoughtMs),
    streamedText: () => liveFull.length > 0,
    shownText: () => liveFull.slice(0, liveCut),   // exactly what the person has seen so far
    uiShown: () => liveUiShown,
    remove() { stopLiveLoop(); remove(); },
  };
}

/* ── Files the person can take away ───────────────────────────────────
 * The workspace lives in this browser, so a file the assistant wrote there is
 * invisible until it is offered. The Worker sends `deliverables` (files the
 * assistant offered, plus files it made when the person asked for one) and
 * they are shown as buttons right under the answer, not hidden in a step. */
function cleanDeliverables(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 6)
    .filter((f) => f && typeof f.path === 'string' && f.path.startsWith('/workspace/'))
    .map((f) => ({
      path: f.path.slice(0, 300),
      title: typeof f.title === 'string' ? f.title.slice(0, 120) : '',
      size: Number.isFinite(f.size) ? f.size : null,
    }));
}

function renderDeliverablesHtml(meta, msgIndex) {
  const files = Array.isArray(meta.deliverables) ? meta.deliverables : [];
  if (!files.length) return '';
  const chips = files.map((f) => {
    const name = f.path.split('/').pop();
    const saved = savedRecordFor(msgIndex, f.path);
    if (saved) return '<span class="deliv-item">' + savedChipHtml(saved) + '</span>';
    return '<span class="deliv-item">' +
      '<button type="button" class="deliv-file" data-sbx-path="' + escapeHtml(f.path) + '" data-sbx-name="' + escapeHtml(name) + '">' +
        '<i class="ph ph-file-arrow-down" aria-hidden="true"></i>' +
        '<span class="deliv-file-name">' + escapeHtml(f.title || name) + '</span>' +
        (f.size != null ? '<span class="deliv-file-size">' + escapeHtml(formatBytes(f.size)) + '</span>' : '') +
      '</button>' +
      '<button type="button" class="deliv-save" data-msg-index="' + msgIndex + '" data-sbx-path="' + escapeHtml(f.path) + '" data-sbx-name="' + escapeHtml(name) + '">' +
        '<i class="ph ph-cloud-arrow-up" aria-hidden="true"></i> Save to Cognita' +
      '</button>' +
    '</span>';
  }).join('');
  return '<div class="deliv" role="group" aria-label="Files">' + chips + '</div>';
}

/* ── Keeping a file in Cognita ─────────────────────────────────────────
 * A file offered for download lives only in this browser. "Save to Cognita"
 * uploads it to the person's own storage for this chat. Once saved, the
 * button becomes the normal re-download chip, which works on any device. The
 * record is kept on the step that offered the file. */
function savedRecordFor(msgIndex, path) {
  const meta = Number.isInteger(msgIndex) ? conversationMeta[msgIndex] : null;
  if (!meta) return null;
  for (const s of (Array.isArray(meta.steps) ? meta.steps : [])) {
    const list = s && s.sandbox && s.sandbox.saved;
    const hit = Array.isArray(list) ? list.find((r) => r && r.path === path) : null;
    if (hit) return hit;
  }
  return (meta.savedFiles || []).find((r) => r && r.path === path) || null;
}

function savedChipHtml(rec) {
  return '<button type="button" class="document-download-chip" ' +
    'data-conversation-id="' + escapeHtml(rec.conversationId || '') + '" ' +
    'data-file-id="' + escapeHtml(rec.fileId || '') + '" ' +
    'data-filename="' + escapeHtml(rec.filename || '') + '" ' +
    'data-mime="' + escapeHtml(rec.mimeType || '') + '">' +
    '<i class="ph ph-file-arrow-down"></i>' +
    '<span class="document-download-chip-name">' + escapeHtml(rec.filename || 'file') + '</span>' +
    '<span class="document-download-chip-state"></span>' +
  '</button>';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

async function saveFileToCognita(btn) {
  const msgIndex = parseInt(btn.dataset.msgIndex, 10);
  const path = btn.dataset.sbxPath;
  const name = btn.dataset.sbxName || path.split('/').pop();
  const meta = conversationMeta[msgIndex];
  if (!meta || btn.disabled) return;

  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="ph ph-circle-notch trace-spin" aria-hidden="true"></i> Saving…';
  const restore = () => { btn.disabled = false; btn.innerHTML = label; };

  try {
    const conversationId = ensureConversationId();
    const blob = await getSandbox().exportFile(conversationId, path);
    if (!blob) { showToast('That file is no longer on this device. Ask Cognita to make it again.'); restore(); return; }
    const maxMB = currentSandboxLimits && currentSandboxLimits.artifactMaxMB;
    if (maxMB && blob.size > maxMB * 1024 * 1024) {
      showToast('That file is larger than the ' + maxMB + ' MB your plan can save.');
      restore();
      return;
    }
    const content = await blobToBase64(blob);
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/files/' + encodeURIComponent(conversationId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: name, content }),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok || !data || !data.fileId) {
      showToast((data && data.error) || 'Could not save that file. Please try again.');
      restore();
      return;
    }

    const rec = { path, fileId: data.fileId, filename: data.filename, mimeType: data.mimeType, conversationId: data.conversationId || conversationId };
    const steps = Array.isArray(meta.steps) ? meta.steps : [];
    const sbSteps = steps.filter((s) => s && s.type === 'sandbox' && s.sandbox);
    const holder =
      [...sbSteps].reverse().find((s) => (s.sandbox.offered || []).some((f) => f.path === path)) ||
      [...sbSteps].reverse().find((s) => (s.sandbox.files || []).some((f) => f.path === path)) ||
      null;
    if (holder) holder.sandbox.saved = (holder.sandbox.saved || []).filter((r) => r.path !== path).concat(rec);
    else meta.savedFiles = (meta.savedFiles || []).filter((r) => r.path !== path).concat(rec);
    persistCurrentConversation();
    renderConversation();
    showToast('Saved to Cognita.');
  } catch (e) {
    console.error('[app] Could not save file:', e.message);
    showToast('Could not reach Cognita. Please try again.');
    restore();
  }
}

/* ── Charts and other pictures made by code ──────────────────────────────
 * Any picture a run creates or changes (png, jpg, webp, gif, svg), up to 4 per
 * step and 2 MB each, is shown inside that step and again under the answer.
 * Pictures are only ever shown through <img src="blob:...">. Their contents are
 * never inserted into the page as markup, so an SVG cannot run script here.
 * Only the path and size are saved with the chat. On reload each picture is
 * read back from this browser's workspace the first time it scrolls into view. */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg)$/i;
const MAX_FIGURES_PER_STEP = 4;
const MAX_FIGURE_BYTES = 2 * 1024 * 1024;

function imageFilesOf(files) {
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.path === 'string' && f.change !== 'deleted' && IMAGE_EXT_RE.test(f.path) && !(f.size > MAX_FIGURE_BYTES))
    .slice(0, MAX_FIGURES_PER_STEP)
    .map((f) => ({ path: f.path, size: f.size || 0 }));
}

function figureHtml(f) {
  const name = f.path.split('/').pop();
  return '<figure class="fig" data-fig-path="' + escapeHtml(f.path) + '">' +
    '<button type="button" class="fig-open" aria-label="Open ' + escapeHtml(name) + ' larger">' +
      '<span class="fig-frame"><img class="fig-img" alt="" decoding="async" hidden><span class="fig-ph">Loading picture…</span></span>' +
    '</button>' +
    '<figcaption class="fig-cap">' + escapeHtml(name) + '</figcaption>' +
  '</figure>';
}

/* Under the answer: every picture the turn's steps made and left in place. */
function renderFigureGridHtml(meta) {
  const steps = Array.isArray(meta.steps) ? meta.steps : [];
  const byPath = new Map();
  steps.forEach((s) => {
    if (!s || s.type !== 'sandbox' || !s.sandbox) return;
    (s.sandbox.files || []).forEach((f) => { if (f && f.change === 'deleted') byPath.delete(f.path); });
    (s.sandbox.images || imageFilesOf(s.sandbox.files)).forEach((f) => byPath.set(f.path, f));
  });
  const list = Array.from(byPath.values()).slice(-6);
  return list.length ? '<div class="fig-grid">' + list.map(figureHtml).join('') + '</div>' : '';
}


/* ── Pictures and designs the assistant made ───────────────────────────
 * The Worker creates them (media-tools.js) and sends each one as a `media`
 * event. They are kept on the reply's meta (meta.media) so they survive
 * reloads and syncing, and are shown right under the answer with download
 * buttons. A picture is a base64 image; a design is an SVG the browser can
 * save as PNG, PDF or SVG. */
const MEDIA_MIME_RE = /^image\/(png|jpeg|webp)$/;

function cleanMedia(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.slice(0, 6).forEach((m) => {
    if (!m || typeof m !== 'object') return;
    if (m.kind === 'image' && typeof m.content === 'string' && /^[A-Za-z0-9+/=]+$/.test(m.content) && MEDIA_MIME_RE.test(m.mime || 'image/jpeg')) {
      out.push({ kind: 'image', mime: m.mime || 'image/jpeg', content: m.content, alt: String(m.alt || 'Generated image').slice(0, 200) });
    } else if (m.kind === 'design' && typeof m.svg === 'string' && m.svg.startsWith('<svg') && !/<script/i.test(m.svg) && m.width > 0 && m.height > 0) {
      out.push({ kind: 'design', svg: m.svg, width: Math.round(m.width), height: Math.round(m.height), title: String(m.title || 'Design').slice(0, 120), alt: String(m.alt || m.title || 'Generated design').slice(0, 200) });
    }
  });
  return out;
}

function _svgDataUrl(svg) {
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

function renderMediaHtml(meta, msgIndex) {
  const list = Array.isArray(meta && meta.media) ? meta.media : [];
  if (!list.length) return '';
  return '<div class="gen-media-list">' + list.map((m, i) => {
    const attrs = 'data-msg-index="' + msgIndex + '" data-media-index="' + i + '"';
    if (m.kind === 'design') {
      return '<figure class="gen-media gen-media--design">' +
        '<img src="' + _svgDataUrl(m.svg) + '" alt="' + escapeHtml(m.alt || 'Generated design') + '" width="' + m.width + '" height="' + m.height + '" loading="lazy">' +
        '<figcaption class="gen-media-actions">' +
          '<button type="button" class="gen-media-btn" ' + attrs + ' data-fmt="png"><i class="ph ph-download-simple" aria-hidden="true"></i> PNG</button>' +
          '<button type="button" class="gen-media-btn" ' + attrs + ' data-fmt="pdf"><i class="ph ph-file-pdf" aria-hidden="true"></i> PDF</button>' +
          '<button type="button" class="gen-media-btn" ' + attrs + ' data-fmt="svg"><i class="ph ph-file-svg" aria-hidden="true"></i> SVG</button>' +
        '</figcaption></figure>';
    }
    return '<figure class="gen-media">' +
      '<img src="data:' + escapeHtml(m.mime) + ';base64,' + escapeHtml(m.content) + '" alt="' + escapeHtml(m.alt || 'Generated image') + '" loading="lazy">' +
      '<figcaption class="gen-media-actions">' +
        '<button type="button" class="gen-media-btn" ' + attrs + ' data-fmt="image"><i class="ph ph-download-simple" aria-hidden="true"></i> Download</button>' +
      '</figcaption></figure>';
  }).join('') + '</div>';
}

function _saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function _base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function _mediaFileStem(m) {
  const base = String(m.title || m.alt || 'cognita').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return 'cognita-' + (base || 'design');
}

// Draws the SVG onto a canvas and returns it. The design embeds its own
// picture as a data: address, so the canvas is never blocked as cross-origin.
function _renderDesignToCanvas(m, scale) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(m.width * scale);
      canvas.height = Math.round(m.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error('Could not draw the design.'));
    img.src = _svgDataUrl(m.svg);
  });
}

function _canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not save the image.'))), type, quality);
  });
}

// One-page PDF holding the design as a picture, sized like an A4 page for
// flyers and posters. Hand-written so no library is needed.
async function _designToPdfBlob(m) {
  const canvas = await _renderDesignToCanvas(m, 1);
  const jpeg = new Uint8Array(await (await _canvasToBlob(canvas, 'image/jpeg', 0.93)).arrayBuffer());
  const pw = 595;
  const ph = Math.round(pw * m.height / m.width);
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (chunk) => { const b = typeof chunk === 'string' ? enc.encode(chunk) : chunk; parts.push(b); length += b.length; };
  const obj = (n, body) => { offsets[n] = length; push(n + ' 0 obj\n'); push(body); push('\nendobj\n'); };
  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>');
  const content = 'q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im0 Do Q';
  obj(4, '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
  offsets[5] = length;
  push('5 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + canvas.width + ' /Height ' + canvas.height +
    ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n');
  push(jpeg);
  push('\nendstream\nendobj\n');
  const xref = length;
  let table = 'xref\n0 6\n0000000000 65535 f \n';
  for (let n = 1; n <= 5; n++) table += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  push(table + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  return new Blob(parts, { type: 'application/pdf' });
}

async function downloadGeneratedMedia(btn) {
  const meta = conversationMeta[parseInt(btn.dataset.msgIndex, 10)];
  const m = meta && Array.isArray(meta.media) ? meta.media[parseInt(btn.dataset.mediaIndex, 10)] : null;
  if (!m || btn.disabled) return;
  const fmt = btn.dataset.fmt;
  const label = btn.innerHTML;
  btn.disabled = true;
  try {
    if (m.kind === 'image') {
      const ext = m.mime === 'image/png' ? 'png' : (m.mime === 'image/webp' ? 'webp' : 'jpg');
      _saveBlob(new Blob([_base64ToBytes(m.content)], { type: m.mime }), _mediaFileStem(m) + '.' + ext);
    } else if (fmt === 'svg') {
      _saveBlob(new Blob([m.svg], { type: 'image/svg+xml' }), _mediaFileStem(m) + '.svg');
    } else if (fmt === 'pdf') {
      _saveBlob(await _designToPdfBlob(m), _mediaFileStem(m) + '.pdf');
    } else {
      const canvas = await _renderDesignToCanvas(m, 1);
      _saveBlob(await _canvasToBlob(canvas, 'image/png'), _mediaFileStem(m) + '.png');
    }
  } catch (e) {
    console.error('[app] media download failed:', e && e.message);
    showToast('Could not save that. Please try again, or download the SVG instead.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

let figureUrls = [];          // blob: addresses made for the current screen
let figureObserver = null;
let figureQueue = Promise.resolve();   // loads run one at a time so they never fight over the workspace

function revokeFigureUrls() {
  figureUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) { /* already gone */ } });
  figureUrls = [];
}

function hydrateFigures(root) {
  if (!root || !root.querySelectorAll) return;
  const figs = root.querySelectorAll('.fig[data-fig-path]:not([data-fig-state])');
  if (!figs.length) return;
  if (!('IntersectionObserver' in window)) { figs.forEach(loadFigure); return; }
  if (!figureObserver) {
    figureObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { figureObserver.unobserve(e.target); loadFigure(e.target); } });
    }, { rootMargin: '200px' });
  }
  figs.forEach((f) => { f.dataset.figState = 'wait'; figureObserver.observe(f); });
}

function loadFigure(fig) {
  fig.dataset.figState = 'loading';
  figureQueue = figureQueue.then(async () => {
    if (!fig.isConnected) return;
    let url = null;
    try { url = await getSandbox().getObjectUrl(ensureConversationId(), fig.dataset.figPath); } catch (_) { url = null; }
    if (!fig.isConnected) { if (url) URL.revokeObjectURL(url); return; }
    const img = fig.querySelector('.fig-img');
    const ph = fig.querySelector('.fig-ph');
    const gone = () => {
      fig.dataset.figState = 'gone';
      fig.classList.add('is-gone');
      img.hidden = true; ph.hidden = false;
      ph.textContent = 'This picture is no longer on this device. Ask Cognita to make it again.';
    };
    if (!url) { gone(); return; }
    figureUrls.push(url);
    img.alt = fig.querySelector('.fig-cap').textContent;
    img.onload = () => { fig.dataset.figState = 'ready'; img.hidden = false; ph.hidden = true; };
    img.onerror = gone;
    img.src = url;
  });
}

/* The enlarged view. Escape or a tap outside closes it, Tab stays inside it,
 * and tapping the picture toggles between fitting the screen and full size
 * (scrollable, and the browser's own pinch zoom still works). */
let lightbox = null;

function closeLightbox() {
  if (!lightbox) return;
  document.removeEventListener('keydown', lightbox.onKey, true);
  lightbox.el.remove();
  if (lightbox.url) URL.revokeObjectURL(lightbox.url);
  document.documentElement.style.overflow = lightbox.prevOverflow;
  const opener = lightbox.opener;
  lightbox = null;
  if (opener && opener.isConnected) opener.focus();
}

async function openLightbox(path, opener) {
  closeLightbox();
  const name = path.split('/').pop();
  const el = document.createElement('div');
  el.className = 'lb';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', name);
  el.innerHTML =
    '<div class="lb-bar">' +
      '<span class="lb-name"></span>' +
      '<button type="button" class="lb-btn" data-lb="download"><i class="ph ph-download-simple" aria-hidden="true"></i> Download</button>' +
      '<button type="button" class="lb-btn" data-lb="close" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button>' +
    '</div>' +
    '<div class="lb-stage"><img class="lb-img" alt="" hidden></div>';
  el.querySelector('.lb-name').textContent = name;
  const img = el.querySelector('.lb-img');
  const buttons = Array.from(el.querySelectorAll('.lb-btn'));
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeLightbox(); return; }
    if (ev.key !== 'Tab') return;
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    else if (!el.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
  };
  lightbox = { el, url: null, opener, onKey, prevOverflow: document.documentElement.style.overflow };
  document.addEventListener('keydown', onKey, true);
  document.documentElement.style.overflow = 'hidden';
  document.body.appendChild(el);
  buttons[1].focus();

  el.addEventListener('click', async (ev) => {
    const act = ev.target.closest && ev.target.closest('[data-lb]');
    if (act && act.dataset.lb === 'close') { closeLightbox(); return; }
    if (act && act.dataset.lb === 'download') {
      const ok = await getSandbox().downloadFile(ensureConversationId(), path, name);
      if (!ok) showToast('That file is no longer on this device. Ask Cognita to make it again.');
      return;
    }
    if (ev.target === img) { img.classList.toggle('is-zoomed'); return; }
    if (ev.target === el || ev.target.classList.contains('lb-stage')) closeLightbox();
  });

  let url = null;
  try { url = await getSandbox().getObjectUrl(ensureConversationId(), path); } catch (_) { url = null; }
  if (!lightbox || lightbox.el !== el) { if (url) URL.revokeObjectURL(url); return; }
  if (!url) { closeLightbox(); showToast('That picture is no longer on this device. Ask Cognita to make it again.'); return; }
  lightbox.url = url;
  img.alt = name;
  img.src = url;
  img.hidden = false;
}

document.addEventListener('click', (ev) => {
  const open = ev.target.closest && ev.target.closest('.fig-open');
  if (!open) return;
  const fig = open.closest('.fig');
  if (fig && fig.dataset.figState === 'ready') openLightbox(fig.dataset.figPath, open);
});

/* ── Sandbox step cards ───────────────────────────────────────────────
 * One compact, expandable card per code run: what ran, whether it worked,
 * how long it took, the output, the files it changed, and any file the
 * assistant offered for download. Text is always escaped; output is never
 * treated as HTML. Used for the live run, for runs the Worker made on a
 * remote sandbox, and for settled history. */
function htmlToElement(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}


/* ── Activity timeline pieces ─────────────────────────────────────────
 * One <li> per thing that happened: a small status node on a thin rail, a
 * title, who it was done in (the sub line), how long it took, and an optional
 * detail that opens underneath. The same markup is used while a turn is live
 * and when a saved chat is reopened. Every string is escaped. */
const PROVIDER_GLYPHS = {
  github: 'ph-github-logo', drive: 'ph-google-drive-logo', gmail: 'ph-envelope-simple',
  calendar: 'ph-calendar-blank', facebook: 'ph-facebook-logo', instagram: 'ph-instagram-logo',
  figma: 'ph-figma-logo', canva: 'ph-paint-brush', google: 'ph-google-logo',
};

// One small picture per step, so the rail says at a glance where each thing happened.
const LABEL_GLYPHS = {
  'GitHub': 'ph-github-logo', 'Google Drive': 'ph-google-drive-logo', 'Gmail': 'ph-envelope-simple',
  'Google Calendar': 'ph-calendar-blank', 'Facebook': 'ph-facebook-logo', 'Instagram': 'ph-instagram-logo',
  'Figma': 'ph-figma-logo', 'Canva': 'ph-paint-brush', 'Code': 'ph-terminal-window', 'Browser': 'ph-globe',
  'Image': 'ph-image', 'Design': 'ph-paint-brush',
};
function stepIconFor(step) {
  const label = step && step.providerLabel;
  if (label && LABEL_GLYPHS[label]) return LABEL_GLYPHS[label];
  const kind = step && step.kind;
  return kind === 'write' ? 'ph-pencil-simple' : kind === 'read' ? 'ph-magnifying-glass' : kind === 'run' ? 'ph-terminal-window' : 'ph-sparkle';
}

// Whole seconds under a minute ("56s"), then minutes and seconds ("2m 56s").
function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (total < 60) return total + 's';
  return Math.floor(total / 60) + 'm ' + String(total % 60).padStart(2, '0') + 's';
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 100) return '';
  if (ms < 10000) return (Math.round(ms / 100) / 10).toFixed(1) + 's';   // "0.9s", "4.2s": short steps are not all "0s"
  return formatClock(ms);
}

function actItemHtml(o) {
  const state = o.state || 'done';
  const words = { done: 'Done', fail: 'Failed', wait: 'Waiting', running: 'Running', stopped: 'Stopped' };
  const icons = { fail: 'ph-x', wait: 'ph-hand-palm', stopped: 'ph-minus' };
  const node = '<span class="act-node" aria-hidden="true"><i class="ph ' + (icons[state] || o.icon || 'ph-check') + '"></i></span>';
  const text =
    '<span class="act-text">' +
      '<span class="act-sr">' + words[state] + ': </span>' +
      '<span class="act-title">' + escapeHtml(o.title || '') + '</span>' +
      '<span class="act-sub">' + escapeHtml(o.sub || '') + '</span>' +
      (o.reason ? '<span class="act-note">' + escapeHtml(o.reason) + '</span>' : '') +
    '</span>' +
    '<span class="act-ms">' + escapeHtml(o.ms || '') + '</span>';
  const open = !!(o.detailHtml && o.openDetail);
  const toggle = o.detailHtml
    ? '<button type="button" class="act-toggle" aria-expanded="' + open + '">' + text +
        '<i class="ph ph-caret-down act-chev" aria-hidden="true"></i></button>'
    : '<div class="act-toggle act-toggle--static">' + text + '</div>';
  return (
    '<li class="act-item' + (o.extraClass ? ' ' + o.extraClass : '') + '" data-state="' + state + '">' +
      node +
      '<div class="act-main">' +
        '<div class="act-row">' + toggle +
          (o.live ? '<button type="button" class="sbx-stop">Stop</button>' : '') +
        '</div>' +
        (o.detailHtml ? '<div class="act-detail"' + (open ? '' : ' hidden') + '>' + o.detailHtml + '</div>' : '') +
      '</div>' +
    '</li>'
  );
}

function renderStepItemHtml(step, msgIndex) {
  if (step && step.type === 'sandbox') return renderSandboxStepHtml(step, msgIndex);
  const blocked = step.type === 'blocked';
  const ok = step.ok !== false;
  return actItemHtml({
    state: blocked ? 'stopped' : (ok ? 'done' : 'fail'),
    title: step.summary || step.name || 'Action performed',
    sub: step.providerLabel || '',
    ms: formatDuration(step.ms),
    icon: stepIconFor(step),
    reason: !ok && !blocked && typeof step.reason === 'string' ? step.reason.slice(0, 200) : '',
  });
}

/* Screenshot and live preview of a page the browser test (or an offered .html file) ran.
 * The screenshot is a small picture. "Live preview" swaps it for the real page, running
 * inside /preview-frame: an isolated frame with no network (see vercel.json). */
const sandboxPreviewStore = new Map();
let sandboxPreviewSeq = 0;
function sandboxPreviewHtml(sb) {
  const shot = sb && sb.screenshot && typeof sb.screenshot.dataUrl === 'string' &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(sb.screenshot.dataUrl) ? sb.screenshot : null;
  const html = sb && typeof sb.previewHtml === 'string' && sb.previewHtml ? sb.previewHtml : '';
  if (!shot && !html) return '';
  let id = '';
  if (html) {
    id = 'pv' + (++sandboxPreviewSeq);
    sandboxPreviewStore.set(id, { html, height: sb.previewSize && sb.previewSize.height });
    if (sandboxPreviewStore.size > 40) sandboxPreviewStore.delete(sandboxPreviewStore.keys().next().value);
  }
  return '<div class="sbx-preview"' + (id ? ' data-preview-id="' + id + '"' : '') + '>' +
    '<div class="sbx-preview-stage">' +
      (shot ? '<img class="sbx-shot" alt="Screenshot of the page" src="' + shot.dataUrl + '">' : '<div class="sbx-muted">No screenshot is available for this page.</div>') +
    '</div>' +
    (html ? '<div class="sbx-actions"><button type="button" class="sbx-preview-toggle" aria-expanded="false"><i class="ph ph-play" aria-hidden="true"></i> Live preview</button></div>' : '') +
  '</div>';
}

function toggleSandboxPreview(btn) {
  const wrap = btn.closest('.sbx-preview');
  const entry = wrap && sandboxPreviewStore.get(wrap.dataset.previewId);
  if (!wrap || !entry) return;
  const stage = wrap.querySelector('.sbx-preview-stage');
  const open = btn.getAttribute('aria-expanded') === 'true';
  if (open) {
    const old = stage.querySelector('iframe');
    if (old) old.remove();
    stage.classList.remove('is-live');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<i class="ph ph-play" aria-hidden="true"></i> Live preview';
    return;
  }
  const fr = document.createElement('iframe');
  fr.className = 'sbx-live';
  fr.setAttribute('sandbox', 'allow-scripts');
  fr.setAttribute('title', 'Live preview of the page');
  fr.setAttribute('referrerpolicy', 'no-referrer');
  fr.style.height = Math.min(Math.max(parseInt(entry.height, 10) || 480, 240), 600) + 'px';
  const onMsg = (ev) => {
    if (ev.source !== fr.contentWindow || !ev.data || ev.data.t !== 'preview-ready') return;
    window.removeEventListener('message', onMsg);
    try { fr.contentWindow.postMessage({ t: 'html', html: entry.html }, '*'); } catch (_) {}
  };
  window.addEventListener('message', onMsg);
  fr.src = '/preview-frame';
  stage.appendChild(fr);
  stage.classList.add('is-live');
  btn.setAttribute('aria-expanded', 'true');
  btn.innerHTML = '<i class="ph ph-stop" aria-hidden="true"></i> Show screenshot';
}
document.addEventListener('click', (e) => {
  const b = e.target && e.target.closest && e.target.closest('.sbx-preview-toggle');
  if (b) toggleSandboxPreview(b);
});

function renderSandboxStepHtml(step, msgIndex) {
  const sb = step.sandbox || {};
  const ok = step.ok !== false && !step.cancelled;

  let out = '';
  if (sb.stdout) out += '<span>' + escapeHtml(sb.stdout) + '</span>';
  if (sb.stderr) out += '<span class="sbx-err">' + escapeHtml(sb.stderr) + '</span>';
  if (!out) out = '<span class="sbx-muted">(no output)</span>';

  const status = step.cancelled ? 'Stopped' : (ok ? 'Succeeded' : 'Failed (exit code ' + (sb.exitCode != null ? sb.exitCode : 1) + ')');
  const files = (sb.files || []).map((f) => {
    const fi = f.change === 'deleted' ? 'ph-file-minus' : (f.change === 'created' ? 'ph-file-plus' : 'ph-file-text');
    return '<li><i class="ph ' + fi + '" aria-hidden="true"></i><span class="sbx-file-path">' + escapeHtml(f.path) + '</span>' +
      (f.change === 'deleted' ? '' : '<span class="sbx-muted">' + escapeHtml(formatBytes(f.size)) + '</span>') + '</li>';
  }).join('');
  const offered = (sb.offered || []).map((f) => {
    const name = f.title || f.path.split('/').pop();
    const saved = savedRecordFor(msgIndex, f.path);
    if (saved) return savedChipHtml(saved);
    return '<button type="button" class="sbx-download" data-sbx-path="' + escapeHtml(f.path) + '" data-sbx-name="' + escapeHtml(f.path.split('/').pop()) + '">' +
        '<i class="ph ph-download-simple" aria-hidden="true"></i> ' + escapeHtml(name) +
      '</button>' +
      (Number.isInteger(msgIndex)
        ? '<button type="button" class="sbx-save" data-msg-index="' + msgIndex + '" data-sbx-path="' + escapeHtml(f.path) + '" data-sbx-name="' + escapeHtml(f.path.split('/').pop()) + '">' +
            '<i class="ph ph-cloud-arrow-up" aria-hidden="true"></i> Save to Cognita</button>'
        : '');
  }).join('');

  // Pictures are shown under the answer (renderFigureGridHtml), not repeated here.
  const detail =
    '<div class="sbx-body">' +
    sandboxPreviewHtml(sb) +
      (sb.command ? '<div class="sbx-cmd"><span class="sbx-prompt">$</span> ' + escapeHtml(sb.command) + '</div>' : '') +
      '<pre class="sbx-out">' + out + '</pre>' +
      (sb.truncated ? '<div class="sbx-note">Output was cut to keep things fast.</div>' : '') +
      '<div class="sbx-meta">' + escapeHtml(status) + '</div>' +
      (files ? '<ul class="sbx-files">' + files + '</ul>' : '') +
      (offered ? '<div class="sbx-actions">' + offered + '</div>' : '') +
      (!ok && !step.cancelled ? '<div class="sbx-actions"><button type="button" class="sbx-retry"><i class="ph ph-arrow-clockwise" aria-hidden="true"></i> Try again</button></div>' : '') +
    '</div>';

  return actItemHtml({
    state: step.cancelled ? 'stopped' : (ok ? 'done' : 'fail'),
    title: step.summary || step.name || 'Ran code',
    sub: step.providerLabel || 'Code',
    icon: stepIconFor({ providerLabel: step.providerLabel || 'Code' }),
    ms: formatDuration(sb.durationMs),
    detailHtml: detail,
    openDetail: !ok && !step.cancelled,
  });
}

/* ── Approval card ───────────────────────────────────────────────────
 * Shown when the assistant wants to change something in a connected app. It
 * says where, what and what will happen, and has two plain buttons. Nothing
 * on it takes focus by itself; screen readers are told through a quiet live
 * region (announceApprovals). Chats saved before this redesign only have a
 * one-line summary, and fall back to showing that. */
function renderApprovalHtml(ptc, index) {
  const glyph = PROVIDER_GLYPHS[ptc.providerKey] || 'ph-plug';
  const verb = ptc.verb || '';
  const primary = verb === 'delete' ? 'Delete' : verb === 'send' ? 'Send' : verb === 'post' ? 'Post' : 'Approve';
  const titleId = 'appr-t-' + index;
  const details = Array.isArray(ptc.details) ? ptc.details : [];
  const short = details.filter((d) => d && !d.long);
  const long = details.filter((d) => d && d.long);
  const dl = short.length
    ? '<dl class="appr-details">' + short.map((d) =>
        '<div class="appr-row"><dt>' + escapeHtml(d.label) + '</dt><dd>' + escapeHtml(d.value) + '</dd></div>').join('') + '</dl>'
    : '';
  const longHtml = long.map((d, i) => {
    const id = 'appr-l-' + index + '-' + i;
    return '<div class="appr-long"><div class="appr-long-label">' + escapeHtml(d.label) + '</div>' +
      '<div class="appr-long-text is-clamped" id="' + id + '">' + escapeHtml(d.value) + '</div>' +
      (String(d.value).length > 160
        ? '<button type="button" class="appr-more" aria-expanded="false" aria-controls="' + id + '">Show more</button>'
        : '') +
      '</div>';
  }).join('');
  return (
    '<div class="appr' + (verb === 'delete' ? ' appr--danger' : '') + '" role="group" aria-labelledby="' + titleId + '" data-state="pending" data-index="' + index + '">' +
      '<div class="appr-top">' +
        '<span class="appr-tile" aria-hidden="true"><i class="ph ' + glyph + '"></i></span>' +
        '<span class="appr-who"><span class="appr-over">Needs your approval</span>' +
          (ptc.providerLabel ? '<span class="appr-prov">' + escapeHtml(ptc.providerLabel) + '</span>' : '') + '</span>' +
      '</div>' +
      '<div class="appr-title" id="' + titleId + '" role="heading" aria-level="3">' + escapeHtml(ptc.title || ptc.summary || 'Make this change?') + '</div>' +
      dl + longHtml +
      (ptc.consequence ? '<p class="appr-conseq">' + escapeHtml(ptc.consequence) + '</p>' : '') +
      '<div class="appr-actions">' +
        '<button type="button" class="appr-btn appr-btn--primary" data-tool-action="confirm" data-index="' + index + '">' + primary + '</button>' +
        '<button type="button" class="appr-btn appr-btn--ghost" data-tool-action="cancel" data-index="' + index + '">Not now</button>' +
      '</div>' +
      (ptc.remembers ? '<p class="appr-note">Cognita won’t ask again for this same kind of action in this chat.</p>' : '') +
    '</div>'
  );
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

/* The finished Activity for one assistant message. Closed by default so the
 * answer stays the main thing; open when something failed or an approval is
 * waiting. A message that has just arrived opens, then folds itself shut after
 * a moment (see collapseFreshActivity). */
function renderActivityHtml(meta, index, isUser) {
  if (isUser || !meta) return '';
  const steps = (Array.isArray(meta.steps) ? meta.steps : []).filter((s) => s && s.type !== 'awaiting_confirmation');
  const ptc = meta.pendingToolCall || null;
  if (!steps.length && !ptc) {
    // A plain answer: just the quiet "Thought for Xs" line (time the backend was really thinking).
    const th = formatDuration(meta.thoughtMs);
    return th && meta.thoughtMs >= 500 ? '<section class="act act--thought" data-index="' + index + '"><div class="act-head"><span class="act-label">Thought for ' + escapeHtml(th) + '</span></div></section>' : '';
  }

  const items = [];

  // Runs of plain reads in the same app become one row: "Read 4 items in GitHub".
  const isRead = (st) => st.type !== 'sandbox' && st.type !== 'blocked' && st.ok !== false && st.kind === 'read' && st.providerLabel;
  for (let i = 0; i < steps.length; ) {
    let j = i;
    if (isRead(steps[i])) { while (j + 1 < steps.length && isRead(steps[j + 1]) && steps[j + 1].providerLabel === steps[i].providerLabel) j++; }
    const n = j - i + 1;
    if (n >= 2) {
      const group = steps.slice(i, j + 1);
      items.push(actItemHtml({
        state: 'done', title: 'Read ' + n + ' items', sub: steps[i].providerLabel, icon: stepIconFor(steps[i]),
        ms: formatDuration(group.reduce((t, g) => t + (Number.isFinite(g.ms) ? g.ms : 0), 0)),
        detailHtml: '<ul class="act-list">' + group.map((g) => '<li>' + escapeHtml(g.summary || g.name || '') + '</li>').join('') + '</ul>',
      }));
      i = j + 1;
    } else {
      items.push(renderStepItemHtml(steps[i], index));
      i++;
    }
  }

  let pendingApproval = false;
  if (ptc) {
    if (ptc.status === 'pending') {
      pendingApproval = true;
      items.push('<li class="act-item act-item--appr" data-state="wait"><span class="act-node" aria-hidden="true"><i class="ph ph-hand-palm"></i></span><div class="act-main">' + renderApprovalHtml(ptc, index) + '</div></li>');
    } else if (ptc.status === 'cancelled') {
      items.push(actItemHtml({ state: 'stopped', title: 'Declined. Nothing was changed.', extraClass: 'act-item--quiet' }));
    } else if (approvingIndex === index) {
      items.push(actItemHtml({ state: 'running', title: 'Approved, running', sub: ptc.providerLabel || '' }));
    } else {
      items.push(actItemHtml({ state: 'done', title: 'Approved', sub: ptc.providerLabel || '' }));
    }
  }

  const failed = steps.filter((st) => st.ok === false && st.type !== 'blocked').length;
  // "Worked for" counts from the first step; "Thought for" counts the whole
  // wait. Older saved chats have no workMs and fall back to the total.
  const t = formatDuration(meta.elapsedMs);
  const tWork = formatDuration(meta.workMs != null ? meta.workMs : meta.elapsedMs);
  let label;
  if (pendingApproval) label = 'Waiting for your approval';
  else if (steps.length) label = (tWork ? 'Worked for ' + tWork + ', ' : '') + plural(steps.length, 'step', 'steps') + (failed ? ', ' + failed + ' failed' : '');
  else if (ptc && ptc.status === 'cancelled') label = 'Declined';
  else if (ptc) label = approvingIndex === index ? 'Running approved action' : 'Approved';
  else label = t ? 'Thought for ' + t : 'Working';

  const wantOpen = failed > 0 || pendingApproval || (!!ptc && !steps.length);
  const fresh = index === freshAssistantIndex && !(streamResume && streamResume.index === index) && !wantOpen && steps.length > 0;
  const open = wantOpen || fresh;
  return (
    '<section class="act' + (open ? ' is-open' : '') + (failed ? ' has-fail' : '') + '"' + (fresh ? ' data-autocollapse="1"' : '') + ' data-index="' + index + '">' +
      '<button type="button" class="act-head" aria-expanded="' + open + '">' +
        '<span class="act-label">' + escapeHtml(label) + '</span>' +
        '<i class="ph ph-caret-down act-caret" aria-hidden="true"></i>' +
      '</button>' +
      '<div class="act-body"><ol class="act-rail" role="list">' + items.join('') + '</ol></div>' +
    '</section>'
  );
}

// Redraws only one message's Activity (used when an approval is answered, so
// the rest of the chat does not flicker).
function refreshActivity(index) {
  const list = document.getElementById('messageList');
  const msgEl = list && list.children[index];
  const meta = conversationMeta[index];
  if (!msgEl || !meta) return;
  const old = msgEl.querySelector('.act');
  const html = renderActivityHtml(meta, index, false);
  if (!html) { if (old) old.remove(); return; }
  const fresh = htmlToElement(html);
  if (old) old.replaceWith(fresh);
  else msgEl.querySelector('.message-body').prepend(fresh);
  hydrateFigures(fresh);
}

function setActOpen(act, open) {
  act.classList.toggle('is-open', open);
  const head = act.querySelector('.act-head');
  if (head) head.setAttribute('aria-expanded', String(open));
}

// A just-arrived message shows its steps, then folds them away so the answer
// is what the eye lands on. Skipped if the person already touched it.
function collapseFreshActivity(root) {
  root.querySelectorAll('.act[data-autocollapse="1"]').forEach((act) => {
    setTimeout(() => {
      if (act.isConnected && act.dataset.autocollapse === '1') {
        act.removeAttribute('data-autocollapse');
        setActOpen(act, false);
      }
    }, 600);
  });
}

let _announcedApprovals = new Set();
function announceApprovals() {
  const cards = document.querySelectorAll('.appr[data-state="pending"]');
  if (!cards.length) return;
  let region = document.getElementById('apprAnnounce');
  if (!region) {
    region = document.createElement('div');
    region.id = 'apprAnnounce';
    region.className = 'act-sr';
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  cards.forEach((card) => {
    const key = currentConversationId + ':' + card.dataset.index;
    if (_announcedApprovals.has(key)) return;
    _announcedApprovals.add(key);
    const t = card.querySelector('.appr-title');
    region.textContent = 'Cognita needs your approval: ' + (t ? t.textContent : 'a change');
  });
}

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (!t || !t.closest) return;
  const head = t.closest('.act-head');
  if (head) {
    const act = head.closest('.act');
    act.removeAttribute('data-autocollapse');
    setActOpen(act, !act.classList.contains('is-open'));
    return;
  }
  const tog = t.closest('.act-toggle[aria-expanded]');
  if (tog) {
    const item = tog.closest('.act-item');
    const detail = item && item.querySelector('.act-detail');
    if (!detail) return;
    const open = tog.getAttribute('aria-expanded') !== 'true';
    tog.setAttribute('aria-expanded', String(open));
    detail.hidden = !open;
    return;
  }
  const more = t.closest('.appr-more');
  if (more) {
    const box = document.getElementById(more.getAttribute('aria-controls'));
    const open = more.getAttribute('aria-expanded') !== 'true';
    more.setAttribute('aria-expanded', String(open));
    more.textContent = open ? 'Show less' : 'Show more';
    if (box) box.classList.toggle('is-clamped', !open);
    return;
  }
  const act = t.closest('[data-tool-action]');
  if (act) resolvePendingToolCall(parseInt(act.dataset.index, 10), act.dataset.toolAction === 'confirm');
});

/* ════════════════════════════════════════════════════════
   CONVERSATION RENDERING
════════════════════════════════════════════════════════ */

// Shown while a synced chat's messages are downloading, instead of the
// empty "What are you working on?" screen (which looked like the chat
// had been wiped).
function renderConversationLoading() {
  const emptyState = document.getElementById('emptyState');
  const list = document.getElementById('messageList');
  emptyState.hidden = true;
  list.hidden = false;
  list.innerHTML =
    '<div class="conversation-loading" role="status" aria-live="polite">' +
      '<i class="ph ph-spinner ph-spin" aria-hidden="true"></i>' +
      '<span>Loading chat…</span>' +
    '</div>';
}

function renderConversation() {
  // A reply that is still being revealed belongs to the DOM we are about
  // to replace, so stop it first. The re-render below shows the finished
  // text, which is the right outcome for "person sent another message".
  cancelActiveStream();

  const emptyState = document.getElementById('emptyState');
  const list = document.getElementById('messageList');

  if (conversation.length === 0) {
    emptyState.hidden = false;
    list.hidden = true;
    list.innerHTML = '';
    _renderedConvId = currentConversationId;
    _renderedCount = 0;
    return;
  }

  const conv = document.getElementById('conversation');
  const conversationChanged = currentConversationId !== _renderedConvId;
  const prevTop = conv.scrollTop;

  // Only brand-new messages get the entrance animation. Without this,
  // every message in the chat fades in again on every render, which
  // shows up as a flash each time a reply lands.
  _animateFromIndex = conversationChanged ? 0 : _renderedCount;

  emptyState.hidden = true;
  list.hidden = false;
  revokeFigureUrls();
  list.innerHTML = conversation.map(renderMessage).join('');
  _renderedConvId = currentConversationId;
  _renderedCount = conversation.length;

  if (conversationChanged) scrollToBottom(true);
  else if (streamScroll.follow) scrollToBottom();
  else conv.scrollTop = prevTop; // the person scrolled up: leave them exactly where they were

  wireMessageActionButtons();
  wireDocumentDownloadButtons(list);
  wireCodeCopyButtons(list);
  wireUi(list, {
    send: (t) => sendMessage(t), busy: () => isSending, notify: showToast,
    getBlocks: getUiBlocks,
    onChange: () => persistCurrentConversation(),
  });
  hydrateFigures(list);
  collapseFreshActivity(list);
  announceApprovals();
  renderMathInElement(list);

  // Reveal only the reply that was just received, once, then clear the
  // flag so later re-renders do not replay it on old messages.
  if (freshAssistantIndex !== -1 && conversation[freshAssistantIndex] && conversation[freshAssistantIndex].role === 'assistant') {
    const idx = freshAssistantIndex;
    const resume = streamResume && streamResume.index === idx ? streamResume : null;
    freshAssistantIndex = -1;
    streamResume = null;
    const targetEl = list.querySelector('.message.is-streaming');
    const contentEl = targetEl ? targetEl.querySelector('.message-content') : null;
    if (targetEl && contentEl) {
      startAssistantStream({
        messageEl: targetEl,
        contentEl,
        fullText: conversation[idx].content || '',
        sources: (conversationMeta[idx] || {}).sources || null,
        index: idx,
        shown: resume ? resume.shown : '',
      });
    }
  } else {
    freshAssistantIndex = -1;
    streamResume = null;
  }
}

/* ── Streaming reply renderer ──────────────────────────────────────
   How a new reply appears on screen.

   The reply text arrives from the server as one finished block, so this
   reveals it at a calm, steady pace. The design is the same one a true
   token stream would need, so it can be fed by real streaming later:

   1. The message container is created ONCE and never replaced. Each
      update renders the visible part of the reply to a scratch element
      and patches only what changed into the live one (a small "morph").
      Finished paragraphs, lists, tables and code blocks are never torn
      down, so there is no flicker, and nothing already on screen moves.
   2. Half-written markdown is repaired before rendering (an unclosed
      code fence, **bold, table, link or formula), so the person never
      sees stray symbols that then jump into formatting.
   3. Text is revealed a whole word at a time on a time-based clock
      (requestAnimationFrame), not a fixed tick, so the flow is even
      whatever the frame rate or the reply length.
   4. Auto-scroll follows only while the person is at the bottom.
   5. The final frame is rendered from the complete text through the very
      same path, so finishing is invisible: no swap, no jump. */

function cancelActiveStream() {
  if (activeStream) {
    activeStream.cancel();
    activeStream = null;
  }
}

function streamClamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Moves forward from i to the end of the current word, so words appear
// whole instead of being cut mid-word.
function streamWordEnd(text, i) {
  const n = text.length;
  while (i < n && !/\s/.test(text[i])) i++;
  return i;
}

// A table is shown row by row, and only once its header, separator and
// first row are all there. Before that it would show as raw "| a | b |"
// text and then suddenly turn into a table.
function streamHoldTable(t) {
  const hasNewline = t.endsWith('\n');
  const body = hasNewline ? t.slice(0, -1) : t;
  const lines = body.split('\n');

  let k = lines.length - 1;
  while (k >= 0 && lines[k].includes('|')) k--;
  const first = k + 1;
  if (first >= lines.length) return t;                 // last line has no pipe: not in a table
  if (!lines[first].trim().startsWith('|')) return t;  // a pipe inside normal prose

  const block = lines.slice(first);
  const complete = hasNewline ? block : block.slice(0, -1); // drop the row still being typed
  const before = lines.slice(0, first);

  if (complete.length >= 2 && !/^[\s|:-]+$/.test(complete[1])) return t; // not a real table
  if (complete.length < 3) return before.join('\n');                     // hold the whole table back
  return before.concat(complete).join('\n');
}

// Repairs the end of a half-written reply so it renders cleanly.
function streamSafePrefix(text) {
  let t = text;

  // Unclosed code fence: close it so the block shows as code from its very
  // first line and simply grows, instead of showing raw backticks first.
  const fences = t.match(/```/g);
  if (fences && fences.length % 2 === 1) {
    const at = t.lastIndexOf('```');
    if (!t.slice(at + 3).includes('\n')) return t.slice(0, at); // the language line is still arriving
    t = t.replace(/`{1,2}$/, '');                               // a closing fence being typed
    return t.endsWith('\n') ? t + '```' : t + '\n```';
  }
  t = t.replace(/(^|\n)`{1,2}$/, '$1'); // an opening fence being typed

  // Formulas: hold an unfinished one back until its closing marker arrives.
  if (((t.match(/\$\$/g) || []).length) % 2 === 1) t = t.slice(0, t.lastIndexOf('$$'));
  const dispOpen = t.lastIndexOf('\\[');
  if (dispOpen > t.lastIndexOf('\\]')) t = t.slice(0, dispOpen);
  const inlOpen = t.lastIndexOf('\\(');
  if (inlOpen > t.lastIndexOf('\\)')) t = t.slice(0, inlOpen);

  t = streamHoldTable(t);

  // A half-typed HTML tag, link or citation marker.
  t = t.replace(/<\/?[a-zA-Z]*$/, '');
  t = t.replace(/\[[^\[\]\n]*(?:\]\([^)\s]*)?$/, '');

  // A line that so far holds only a marker ("#", "-", "1.", ">", "**"):
  // wait for the words that give it meaning.
  const lastNl = t.lastIndexOf('\n');
  const lastLine = t.slice(lastNl + 1);
  if (/^[ \t]*(?:#{1,6}|[-*•_]{1,2}|\d+\.?|>)[ \t]*$/.test(lastLine)) t = t.slice(0, lastNl + 1);

  // Close unfinished inline formatting in the last paragraph.
  const blankAt = t.lastIndexOf('\n\n');
  const startAt = blankAt === -1 ? 0 : blankAt + 2;
  let para = t.slice(startAt);
  para = para.replace(/(^|[\s(])\*{1,3}$/, '$1'); // an opening "**" with no word after it yet

  const lastLineOfPara = para.slice(para.lastIndexOf('\n') + 1);
  if (((lastLineOfPara.match(/`/g) || []).length) % 2 === 1) {
    para = /^[^`]*`$/.test(lastLineOfPara)
      ? para.slice(0, -1)   // just the opening backtick so far
      : para + '`';
  }
  if (((para.match(/\*\*/g) || []).length) % 2 === 1) {
    if (/[^*]\*$/.test(para)) para = para.slice(0, -1); // half of a closing "**"
    para += '**';
  }
  const noBold = para.replace(/\*\*/g, '').split('\n').map((l) => l.replace(/^[ \t]*\*[ \t]/, '')).join('\n');
  const stars = (noBold.match(/\*/g) || []).length;
  if (stars % 2 === 1 && /\S/.test(noBold[noBold.lastIndexOf('*') + 1] || '')) para += '*';

  return t.slice(0, startAt) + para;
}

// Copies attributes from the freshly rendered element onto the live one,
// leaving the streaming bookkeeping attributes alone.
function streamSyncAttrs(live, fresh) {
  Array.from(fresh.attributes).forEach((a) => {
    if (live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value);
  });
  Array.from(live.attributes).forEach((a) => {
    if (a.name.indexOf('data-sf') === 0) return;
    if (!fresh.hasAttribute(a.name)) live.removeAttribute(a.name);
  });
}

// Brings a node from the scratch tree into the live one. New elements get
// a very short fade (opacity only, so it can never move the layout).
function streamAdopt(node) {
  if (node.nodeType === 1) node.setAttribute('data-sf-new', '');
  return node;
}

// Patches `live` so its children match `fresh`, touching only what
// actually differs. Existing nodes are updated in place, never rebuilt.
function streamMorphChildren(live, fresh) {
  const kids = Array.from(fresh.childNodes);
  for (let i = 0; i < kids.length; i++) {
    const f = kids[i];
    const l = live.childNodes[i];
    if (!l) { live.appendChild(streamAdopt(f)); continue; }
    if (l.nodeType !== f.nodeType || l.nodeName !== f.nodeName) {
      live.replaceChild(streamAdopt(f), l);
      continue;
    }
    if (f.nodeType === 3) { if (l.data !== f.data) l.data = f.data; continue; }
    if (f.nodeType !== 1) continue;

    // The code block's Copy button keeps its own "Copied" state.
    if (f.classList.contains('code-copy-btn')) continue;
    // A code block whose content is unchanged is never touched: no diffing,
    // no re-highlighting, no flicker, however long it is.
    if (f.classList.contains('code-block-wrap') && l.classList.contains('code-block-wrap') &&
        l.getAttribute('data-code-key') === f.getAttribute('data-code-key')) continue;
    // A formula that is already typeset is left alone (re-typesetting it
    // every frame would flicker).
    if (f.classList.contains('katex-target')) {
      if (l.getAttribute('data-sf-math') === f.textContent) continue;
      live.replaceChild(streamAdopt(f), l);
      continue;
    }
    streamSyncAttrs(l, f);
    streamMorphChildren(l, f);
  }
  while (live.childNodes.length > kids.length) live.removeChild(live.lastChild);
}

function streamTypesetMath(root) {
  if (!window.katex) return;
  root.querySelectorAll('.katex-target:not([data-sf-math])').forEach((el) => {
    const expr = el.textContent;
    try {
      window.katex.render(expr, el, { throwOnError: false, displayMode: el.dataset.display === 'true' });
      el.setAttribute('data-sf-math', expr);
    } catch (e) {
      console.error('[app] KaTeX render failed:', e.message);
    }
  });
}

function streamPatch(contentEl, text, sources, idPrefix) {
  const scratch = document.createElement('div');
  scratch.innerHTML = renderMarkdownLite(text, sources, idPrefix);
  streamMorphChildren(contentEl, scratch);
  streamTypesetMath(contentEl);
  wireCodeCopyButtons(contentEl);
}

function startAssistantStream({ messageEl, contentEl, fullText, sources, index, shown }) {
  const idPrefix = 's' + index + '-';
  const total = fullText.length;
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Short replies flow at the base pace. Long ones speed up just enough to
  // finish within STREAM_MAX_SECONDS, so nobody waits half a minute.
  // When the reply was already streaming live, `shown` is what the person has seen: carry on
  // from the longest part of it that the final text still starts with.
  let resumeAt = 0;
  if (shown) {
    const lim = Math.min(shown.length, total);
    while (resumeAt < lim && shown.charCodeAt(resumeAt) === fullText.charCodeAt(resumeAt)) resumeAt++;
  }
  const cps = streamClamp(Math.max(STREAM_BASE_CPS, (total - resumeAt) / STREAM_MAX_SECONDS), STREAM_BASE_CPS, STREAM_MAX_CPS);

  let pos = resumeAt;
  let cut = resumeAt;
  let lastT = 0;
  let startT = 0;
  let rafId = 0;
  let done = false;

  const handle = {
    cancel() {
      done = true;
      if (rafId) cancelAnimationFrame(rafId);
    },
  };

  function finish() {
    if (done) return;
    done = true;
    if (rafId) cancelAnimationFrame(rafId);

    // The last frame comes from the complete text through the same path
    // as every other frame, so nothing is swapped or rebuilt.
    streamPatch(contentEl, fullText, sources, idPrefix);
    contentEl.querySelectorAll('[data-sf-new]').forEach((el) => el.removeAttribute('data-sf-new'));
    contentEl.classList.remove('is-typing');
    messageEl.classList.remove('is-streaming');
    messageEl.classList.add('stream-done');
    scrollToBottom();
    if (activeStream === handle) activeStream = null;
  }

  function frame(t) {
    if (done) return;
    if (!lastT) { lastT = t; startT = t; }
    const dt = Math.min(t - lastT, 100); // a background tab must not make the text lurch forward
    lastT = t;

    const ramp = Math.min(1, 0.5 + 0.5 * ((t - startT) / STREAM_RAMP_MS));
    pos += cps * ramp * (dt / 1000);
    if (pos >= total) { finish(); return; }

    const nextCut = streamWordEnd(fullText, Math.floor(pos));
    if (nextCut !== cut) {
      cut = nextCut;
      streamPatch(contentEl, streamSafePrefix(fullText.slice(0, cut)), sources, idPrefix);
      scrollToBottom(); // follows only if the person is still at the bottom
    }
    rafId = requestAnimationFrame(frame);
  }

  activeStream = handle;
  contentEl.classList.add('is-typing');
  if (reduceMotion || total === 0 || resumeAt >= total) {
    finish();
    return;
  }
  // Draw what was already on screen right now, before the first paint, so there is no blank flash.
  if (resumeAt > 0) streamPatch(contentEl, streamSafePrefix(fullText.slice(0, resumeAt)), sources, idPrefix);
  rafId = requestAnimationFrame(frame);
}

function renderMessage(msg, index) {
  const isUser = msg.role === 'user';
  const meta = conversationMeta[index] || {};

  // Attachments render as thumbnails/chips only — never as raw base64
  // strings or a full file text dump in the visible bubble.
  let attachmentsHtml = '';
  if (isUser && msg.attachments && msg.attachments.length) {
    const imageAtts = msg.attachments.filter((a) => a.kind === 'image');
    const otherAtts = msg.attachments.filter((a) => a.kind !== 'image');

    let imagesHtml = '';
    if (imageAtts.length) {
      imagesHtml = '<div class="message-image-grid">' +
        imageAtts.map((a) => '<img src="' + a.dataUrl + '" alt="' + escapeHtml(a.name) + '" class="message-image">').join('') +
      '</div>';
    }

    let chipsHtml = '';
    if (otherAtts.length) {
      chipsHtml = '<div class="message-attachments">' +
        otherAtts.map((a) => {
          const icon = a.kind === 'unsupported' ? 'warning' : 'file-text';
          return '<span class="attachment-chip attachment-chip-static">' +
            '<i class="ph ph-' + icon + '"></i>' +
            '<span class="attachment-chip-name">' + escapeHtml(a.name) + '</span>' +
          '</span>';
        }).join('') +
      '</div>';
    }

    attachmentsHtml = imagesHtml + chipsHtml;
  }

  // One Activity component per assistant message: reasoning summary, the steps
  // that ran, and any approval the turn is waiting on (renderActivityHtml).
  const activityHtml = renderActivityHtml(meta, index, isUser);

  let sourcesHtml = '';
  if (!isUser && meta.sources && meta.sources.length) {
    sourcesHtml =
      '<div class="message-sources">' +
        '<div class="message-sources-label">Sources</div>' +
        '<ol class="message-sources-list">' +
          meta.sources.map((s) =>
            '<li><a href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener noreferrer">' +
              escapeHtml(s.title || s.url) + '</a></li>'
          ).join('') +
        '</ol>' +
      '</div>';
  }

  // Generated visual (diagram SVG or illustration image) stored on the message.
  let visualHtml = '';
  if (!isUser && msg.visual && msg.visual.content) {
    visualHtml = msg.visual.type === 'svg'
      ? '<div class="message-content message-visual">' + _sanitizeSvg(msg.visual.content) + '</div>'
      : '<div class="message-content message-visual"><img src="data:image/jpeg;base64,' + escapeHtml(msg.visual.content) + '" alt="' + escapeHtml(msg.visualAlt || 'Generated illustration') + '"></div>';
  }

  // Generated document (docx/pdf/pptx) attached to this assistant message.
  // Rendered as a chip that re-fetches the actual bytes on click, via
  // wireDocumentDownloadButtons — this is what makes the file
  // re-downloadable after a reload, unlike a one-time blob URL.
  let documentFileHtml = '';
  const transient = !isUser ? _transientDownloads.get(msg) : null;
  if (transient) {
    documentFileHtml =
      '<a class="document-download-chip" href="' + escapeHtml(transient.url) + '" download="' + escapeHtml(transient.filename) + '">' +
        '<i class="ph ph-file-arrow-down"></i>' +
        '<span class="document-download-chip-name">' + escapeHtml(transient.filename) + '</span>' +
      '</a>';
  } else if (!isUser && msg.documentFile) {
    const df = msg.documentFile;
    documentFileHtml =
      '<button type="button" class="document-download-chip" ' +
        'data-conversation-id="' + escapeHtml(df.conversationId || '') + '" ' +
        'data-file-id="' + escapeHtml(df.fileId || '') + '" ' +
        'data-filename="' + escapeHtml(df.filename || '') + '" ' +
        'data-mime="' + escapeHtml(df.mimeType || '') + '">' +
        '<i class="ph ph-file-arrow-down"></i>' +
        '<span class="document-download-chip-name">' + escapeHtml(df.filename || 'document') + '</span>' +
        '<span class="document-download-chip-state"></span>' +
      '</button>';
  }


  return (
    '<div class="message ' + (isUser ? 'is-user' : 'is-assistant') +
      (index < _animateFromIndex ? ' no-enter' : '') +
      (!isUser && index === freshAssistantIndex && msg.content && !visualHtml ? ' is-streaming' : '') + '">' +
      '<div class="message-body">' +
        activityHtml +
        attachmentsHtml +
        // The freshly-received reply starts as an empty content div —
        // typewriterReveal (called from renderConversation right after
        // this HTML is inserted, and after any step-reveal animation
        // above has finished) fills it in. This avoids a flash of the
        // full text before the typing animation takes over.
        visualHtml +
        (msg.content && !visualHtml ? '<div class="message-content">' + (!isUser && index === freshAssistantIndex ? '' : renderMarkdownLite(msg.content, isUser ? null : meta.sources)) + '</div>' : '') +
        (!isUser && meta.ui && meta.ui.length ? renderUiHtml(meta.ui, index, index === freshAssistantIndex && !(streamResume && streamResume.index === index && streamResume.hadUi)) : '') +
        (!isUser ? renderDesignRequestHtml(meta, index) : '') +
        (!isUser ? renderFigureGridHtml(meta) : '') +
        (!isUser ? renderMediaHtml(meta, index) : '') +
        documentFileHtml +
        (!isUser ? renderDeliverablesHtml(meta, index) : '') +
        sourcesHtml +
        (isUser ? '' :
          '<div class="message-actions">' +
            '<button class="message-action-btn" data-action="copy" data-index="' + index + '" title="Copy" aria-label="Copy reply"><i class="ph ph-copy" aria-hidden="true"></i></button>' +
            '<button class="message-action-btn" data-action="regenerate" data-index="' + index + '" title="Regenerate" aria-label="Regenerate reply"><i class="ph ph-arrow-clockwise" aria-hidden="true"></i></button>' +
          '</div>'
        ) +
      '</div>' +
    '</div>'
  );
}

function wireMessageActionButtons() {
  document.querySelectorAll('[data-action="copy"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const messageEl = btn.closest('.message');
      const contentEl = messageEl ? messageEl.querySelector('.message-content') : null;
      const meta = conversationMeta[idx] || {};
      const ok = await copyMessageContent(
        contentEl,
        conversation[idx] ? conversation[idx].content : '',
        meta.sources || null
      );
      if (ok) {
        flashCopyButton(btn);
      } else {
        showToast('Could not copy. Please select the text and copy it manually.');
      }
    });
  });

  document.querySelectorAll('[data-action="regenerate"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      // A reply is still being written (or the chat is still loading).
      // Cutting the conversation now would delete the messages and then
      // fail to resend, so stop here instead.
      if (isSending || (loadingConversationId && loadingConversationId === currentConversationId)) {
        showToast('Please wait for the current reply to finish.');
        return;
      }

      const idx = parseInt(btn.dataset.index, 10);
      let priorUserIdx = -1;
      for (let i = idx - 1; i >= 0; i--) {
        if (conversation[i].role === 'user') { priorUserIdx = i; break; }
      }
      if (priorUserIdx < 0) return;
      const priorUserMsg = conversation[priorUserIdx];

      // Put the original message's attachments back, so a retried message
      // that had a photo or file does not lose it.
      const restoredAttachments = (priorUserMsg.attachments || []).map((a) => {
        if (a.kind === 'image') {
          return {
            kind: 'image',
            name: a.name,
            dataUrl: a.dataUrl,
            mimeType: a.mimeType,
            base64: (a.dataUrl || '').split(',')[1] || '',
          };
        }
        if (a.kind === 'file') return { kind: 'text', name: a.name, text: a.text };
        if (a.kind === 'workspace') return { kind: 'workspace', name: a.name, path: a.path, size: a.size, stub: a.stub };
        return { kind: 'unsupported', name: a.name };
      });

      // Keep whatever the person is currently typing or attaching in the
      // composer, because sendMessage() clears both.
      const composerInput = document.getElementById('composerInput');
      const draftText = composerInput ? composerInput.value : '';
      const draftAttachments = pendingAttachments;

      // Cut back to BEFORE the user message being retried — sendMessage
      // adds it again, so cutting at the reply left a duplicate.
      conversation = conversation.slice(0, priorUserIdx);
      conversationMeta = conversationMeta.slice(0, priorUserIdx);
      renderConversation();

      pendingAttachments = restoredAttachments;
      const sending = sendMessage(priorUserMsg.content);

      // sendMessage() has already read and cleared the composer by now.
      // Give the person their draft back.
      pendingAttachments = draftAttachments;
      renderComposerAttachments();
      if (composerInput && draftText) {
        composerInput.value = draftText;
        composerInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      await sending;
    });
  });

  // Files the assistant offered from the sandbox workspace.
  document.querySelectorAll('.sbx-download, .deliv-file').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await getSandbox().downloadFile(ensureConversationId(), btn.dataset.sbxPath, btn.dataset.sbxName);
      if (!ok) showToast('That file is no longer on this device. Ask Cognita to make it again.');
    });
  });
  document.querySelectorAll('.gen-media-btn').forEach((btn) => {
    btn.addEventListener('click', () => downloadGeneratedMedia(btn));
  });
  document.querySelectorAll('.sbx-save, .deliv-save').forEach((btn) => {
    btn.addEventListener('click', () => saveFileToCognita(btn));
  });
  document.querySelectorAll('.sbx-retry').forEach((btn) => {
    btn.addEventListener('click', () => { if (!isSending) sendMessage('That did not work. Please fix the problem and try again.'); });
  });
}

// Runs (or cancels) a write action the model proposed earlier in the
// conversation — see the tool-confirm card in renderMessage() and the
// confirmToolCall handling in chat-endpoint.js. Cancelling never calls
// the backend at all: the user simply declined, nothing to undo.
async function resolvePendingToolCall(index, approved) {
  const meta = conversationMeta[index];
  if (!meta || !meta.pendingToolCall || meta.pendingToolCall.status !== 'pending') return;
  if (isSending && approved) return;
  const ptc = meta.pendingToolCall;
  const card = document.querySelector('.appr[data-index="' + index + '"]');
  if (card) card.querySelectorAll('button').forEach((b) => { b.disabled = true; });

  if (!approved) {
    // Fade the card out, then leave one quiet line behind.
    if (card) card.classList.add('is-leaving');
    await new Promise((r) => setTimeout(r, 160));
    meta.pendingToolCall = { ...ptc, status: 'cancelled' };
    refreshActivity(index);
    persistCurrentConversation();
    return;
  }

  meta.pendingToolCall = { ...ptc, status: 'confirmed' };
  approvingIndex = index;
  if (card) card.classList.add('is-leaving');
  await new Promise((r) => setTimeout(r, 160));
  refreshActivity(index);

  await runStreamedTurn({
    messages: conversation.slice(0, index + 1).map((m, i) => ({ role: m.role, content: historyContent(m, i) })),
    quality: currentQuality,
    confirmToolCall: { name: ptc.name, args: ptc.args },
    approvals: conversationApprovals,
    sandboxHint: conversationHasSandbox(),
    mediaHint: conversationHasMedia(),
    ...designPayload(''),
  });
}

/* ── Design requirements card ────────────────────────────────────────
 * When create_design needs something only the person has (a business or event
 * name, a date, a venue, contact details, their own logo or photo), the Worker
 * pauses and sends `pendingDesignRequest`. This card asks for just those
 * things. Submitting (or skipping) resumes the SAME design request with the
 * answers merged in, so nothing has to be typed again. Images are shrunk in
 * the browser first and only used for this design. Approval cards for
 * connected apps (renderApprovalHtml) are a separate path and are untouched. */
const DREQ_DRAFTS = {};   // message index -> { logo|photo|artwork: prepared image }
const DESIGN_WORD_RE = /\b(flyers?|posters?|invitations?|invites?|banners?|designs?|graphics?|logo|social|story|post|thumbnail|certificate)\b/i;
const DREQ_IMG_ACCEPT = 'image/png,image/jpeg,image/webp';

function resetDesignState(fromMeta) {
  conversationDesignAssets = {};
  conversationDesignFacts = {};
  conversationDesignSkipped = [];
  Object.keys(DREQ_DRAFTS).forEach((k) => { delete DREQ_DRAFTS[k]; });
  if (!fromMeta) return;
  conversationMeta.forEach((m) => {
    const d = m && m.designRequest;
    if (!d || d.status === 'pending') return;
    Object.assign(conversationDesignFacts, d.answers || {});
    (d.skipped || []).forEach((id) => { if (!conversationDesignSkipped.includes(id)) conversationDesignSkipped.push(id); });
  });
}

// What goes along with a chat request. The images are only sent when the
// message looks like design work, so ordinary chats stay light.
function designPayload(text) {
  const out = {};
  if (Object.keys(conversationDesignAssets).length && (text === '' || DESIGN_WORD_RE.test(text || '') || conversationHasMedia())) {
    out.designAssets = conversationDesignAssets;
  }
  if (Object.keys(conversationDesignFacts).length) out.designFacts = conversationDesignFacts;
  if (conversationDesignSkipped.length) out.designSkipped = conversationDesignSkipped;
  return out;
}

function renderDesignRequestHtml(meta, index) {
  const d = meta && meta.designRequest;
  if (!d || !d.request || !Array.isArray(d.request.fields)) return '';
  const r = d.request;
  const labelOf = (id) => { const f = r.fields.find((x) => x.id === id); return f ? (f.label || id) : id; };

  if (d.status !== 'pending') {
    const done = Array.isArray(d.answeredIds) ? d.answeredIds : [];
    const text = done.length
      ? 'Added to your design: ' + done.map(labelOf).join(', ')
      : 'Designing without the extra details';
    return '<div class="dreq dreq--done" data-index="' + index + '"><i class="ph ' + (done.length ? 'ph-check-circle' : 'ph-minus-circle') + '" aria-hidden="true"></i><span>' + escapeHtml(text) + '</span></div>';
  }

  const titleId = 'dreq-t-' + index;
  const fieldsHtml = r.fields.map((f) => {
    const id = escapeHtml(f.id);
    const opt = f.optional ? '<span class="dreq-opt">Optional</span>' : '';
    if (f.type === 'image') {
      return '<div class="dreq-field dreq-field--image" data-dreq-field="' + id + '">' +
        '<div class="dreq-label-row"><span class="dreq-label">' + escapeHtml(f.label) + '</span>' + opt + '</div>' +
        (f.hint ? '<p class="dreq-hint">' + escapeHtml(f.hint) + '</p>' : '') +
        '<div class="dreq-upload" data-state="empty">' +
          '<input type="file" class="dreq-file" hidden accept="' + DREQ_IMG_ACCEPT + '" data-dreq-file="' + id + '">' +
          '<button type="button" class="dreq-pick" data-dreq-pick="' + id + '"><i class="ph ph-upload-simple" aria-hidden="true"></i><span class="dreq-pick-text"><strong>Upload image</strong><small>PNG, JPG or WebP</small></span></button>' +
          '<div class="dreq-chosen" hidden><img class="dreq-thumb" alt=""><span class="dreq-fname"></span><button type="button" class="dreq-remove" data-dreq-remove="' + id + '">Remove</button></div>' +
        '</div></div>';
    }
    const inId = 'dreq-in-' + index + '-' + id;
    return '<div class="dreq-field">' +
      '<label class="dreq-label-row" for="' + inId + '"><span class="dreq-label">' + escapeHtml(f.label) + '</span>' + opt + '</label>' +
      '<input id="' + inId + '" class="dreq-input" type="text" maxlength="120" autocomplete="off" data-dreq-input="' + id + '" placeholder="' + escapeHtml(f.placeholder || '') + '">' +
    '</div>';
  }).join('');

  return (
    '<section class="dreq" role="group" aria-labelledby="' + titleId + '" data-state="pending" data-index="' + index + '">' +
      '<div class="dreq-top">' +
        '<span class="dreq-tile" aria-hidden="true"><i class="ph ph-paint-brush-broad"></i></span>' +
        '<span class="dreq-who"><span class="dreq-over">Design brief</span><span class="dreq-kind">' + escapeHtml(r.kindLabel || 'Design') + '</span></span>' +
      '</div>' +
      '<div class="dreq-title" id="' + titleId + '" role="heading" aria-level="3">' + escapeHtml(r.title || 'A few details to finish your design') + '</div>' +
      (r.intro ? '<p class="dreq-intro">' + escapeHtml(r.intro) + '</p>' : '') +
      '<div class="dreq-fields">' + fieldsHtml + '</div>' +
      '<div class="dreq-actions">' +
        '<button type="button" class="appr-btn appr-btn--primary dreq-submit" data-dreq-action="submit" data-index="' + index + '" disabled>Create my design</button>' +
        '<button type="button" class="appr-btn appr-btn--ghost" data-dreq-action="skip" data-index="' + index + '">Skip, design without</button>' +
      '</div>' +
      '<p class="dreq-note">Anything you add is used only for this design.</p>' +
    '</section>'
  );
}

function refreshDesignRequest(index) {
  const list = document.getElementById('messageList');
  const msgEl = list && list.children[index];
  const meta = conversationMeta[index];
  if (!msgEl || !meta) return;
  const old = msgEl.querySelector('.dreq');
  const html = renderDesignRequestHtml(meta, index);
  if (!html) { if (old) old.remove(); return; }
  if (old) old.replaceWith(htmlToElement(html));
}

// Shrinks a picked image in the browser. Logos stay PNG (keeps transparency),
// photos become JPEG. Keeps the upload small and the design sharp.
function prepareDesignImage(file, kind) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const longEdge = Math.max(img.naturalWidth, img.naturalHeight) || 1;
        const encode = (max) => {
          const k = Math.min(1, max / longEdge);
          const w = Math.max(1, Math.round(img.naturalWidth * k));
          const h = Math.max(1, Math.round(img.naturalHeight * k));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const cx = cv.getContext('2d');
          if (kind !== 'logo') { cx.fillStyle = '#FFFFFF'; cx.fillRect(0, 0, w, h); }
          cx.drawImage(img, 0, 0, w, h);
          let mime = kind === 'logo' ? 'image/png' : 'image/jpeg';
          let dataUrl = cv.toDataURL(mime, 0.88);
          if (kind === 'logo' && dataUrl.length > 900000) {
            const webp = cv.toDataURL('image/webp', 0.9);
            if (webp.startsWith('data:image/webp')) { mime = 'image/webp'; dataUrl = webp; }
          }
          return { mime, dataUrl, w, h };
        };
        let out = encode(kind === 'logo' ? 900 : 1600);
        if (out.dataUrl.length > 1600000) out = encode(kind === 'logo' ? 600 : 1100);
        URL.revokeObjectURL(url);
        if (out.dataUrl.length > 1700000) { reject(new Error('too large')); return; }
        resolve({ mime: out.mime, base64: out.dataUrl.split(',')[1], w: out.w, h: out.h, name: file.name, dataUrl: out.dataUrl });
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

function dreqHasInput(card) {
  const index = parseInt(card.dataset.index, 10);
  const texts = Array.from(card.querySelectorAll('.dreq-input')).some((el) => el.value.trim());
  const imgs = DREQ_DRAFTS[index] && Object.keys(DREQ_DRAFTS[index]).length > 0;
  return texts || !!imgs;
}

function dreqSyncSubmit(card) {
  const btn = card.querySelector('.dreq-submit');
  if (btn) btn.disabled = !dreqHasInput(card);
}

async function dreqHandleFile(card, slot, file) {
  if (!file) return;
  const index = parseInt(card.dataset.index, 10);
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) { showToast('Please choose a PNG, JPG or WebP image.'); return; }
  if (file.size > 15 * 1024 * 1024) { showToast('That image is over 15 MB. Please pick a smaller one.'); return; }
  const box = card.querySelector('[data-dreq-field="' + slot + '"] .dreq-upload');
  if (!box) return;
  box.dataset.state = 'busy';
  try {
    const asset = await prepareDesignImage(file, slot === 'logo' ? 'logo' : 'photo');
    DREQ_DRAFTS[index] = DREQ_DRAFTS[index] || {};
    DREQ_DRAFTS[index][slot] = asset;
    box.querySelector('.dreq-thumb').src = asset.dataUrl;
    box.querySelector('.dreq-fname').textContent = file.name;
    box.querySelector('.dreq-chosen').hidden = false;
    box.querySelector('.dreq-pick').hidden = true;
    box.dataset.state = 'filled';
  } catch (e) {
    box.dataset.state = 'empty';
    showToast('Could not use that image. Try a different one.');
  }
  dreqSyncSubmit(card);
}

async function submitDesignRequest(index, skip) {
  const meta = conversationMeta[index];
  const d = meta && meta.designRequest;
  if (!d || d.status !== 'pending' || isSending) return;
  const card = document.querySelector('.dreq[data-index="' + index + '"]');
  const answers = {};
  const assets = {};
  const skipped = [];
  d.request.fields.forEach((f) => {
    if (skip) { skipped.push(f.id); return; }
    if (f.type === 'image') {
      const a = DREQ_DRAFTS[index] && DREQ_DRAFTS[index][f.id];
      if (a) assets[f.id] = a; else skipped.push(f.id);
    } else {
      const el = card && card.querySelector('[data-dreq-input="' + f.id + '"]');
      const v = el ? el.value.trim().slice(0, 120) : '';
      if (v) answers[f.id] = v; else skipped.push(f.id);
    }
  });

  Object.assign(conversationDesignFacts, answers);
  Object.keys(assets).forEach((k) => {
    const a = assets[k];
    conversationDesignAssets[k] = { mime: a.mime, base64: a.base64, w: a.w, h: a.h };
  });
  skipped.forEach((id) => { if (!conversationDesignSkipped.includes(id)) conversationDesignSkipped.push(id); });

  const answeredIds = Object.keys(answers).concat(Object.keys(assets));
  meta.designRequest = { name: d.name, args: d.args, request: d.request, status: answeredIds.length ? 'submitted' : 'skipped', answers, answeredIds, skipped };
  delete DREQ_DRAFTS[index];
  refreshDesignRequest(index);
  persistCurrentConversation();

  isSending = true;
  try {
    await runStreamedTurn({
      messages: conversation.slice(0, index + 1).map((m, i) => ({ role: m.role, content: historyContent(m, i) })),
      quality: currentQuality,
      designResume: { args: d.args, answers },
      designAssets: Object.keys(conversationDesignAssets).length ? conversationDesignAssets : undefined,
      designFacts: conversationDesignFacts,
      designSkipped: conversationDesignSkipped,
      approvals: conversationApprovals,
      sandboxHint: conversationHasSandbox(),
      mediaHint: true,
    });
  } finally {
    isSending = false;
  }
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const pick = t.closest('[data-dreq-pick]');
  if (pick) {
    const input = pick.closest('.dreq-upload').querySelector('.dreq-file');
    if (input) input.click();
    return;
  }
  const rm = t.closest('[data-dreq-remove]');
  if (rm) {
    const card = rm.closest('.dreq');
    const slot = rm.dataset.dreqRemove;
    const index = parseInt(card.dataset.index, 10);
    if (DREQ_DRAFTS[index]) delete DREQ_DRAFTS[index][slot];
    const box = rm.closest('.dreq-upload');
    box.querySelector('.dreq-file').value = '';
    box.querySelector('.dreq-chosen').hidden = true;
    box.querySelector('.dreq-pick').hidden = false;
    box.dataset.state = 'empty';
    dreqSyncSubmit(card);
    return;
  }
  const act = t.closest('[data-dreq-action]');
  if (act && !act.disabled) submitDesignRequest(parseInt(act.dataset.index, 10), act.dataset.dreqAction === 'skip');
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.classList.contains('dreq-file')) {
    const card = t.closest('.dreq');
    if (card) dreqHandleFile(card, t.dataset.dreqFile, t.files && t.files[0]);
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.classList.contains('dreq-input')) {
    const card = t.closest('.dreq');
    if (card) dreqSyncSubmit(card);
  }
});

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (e.key === 'Enter' && t instanceof HTMLInputElement && t.classList.contains('dreq-input')) {
    const card = t.closest('.dreq');
    const btn = card && card.querySelector('.dreq-submit');
    if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
  }
});

['dragover', 'drop'].forEach((evt) => {
  document.addEventListener(evt, (e) => {
    const zone = e.target instanceof Element ? e.target.closest('.dreq-pick') : null;
    if (!zone) return;
    e.preventDefault();
    if (evt === 'drop') {
      const card = zone.closest('.dreq');
      const slot = zone.dataset.dreqPick;
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (card && file) dreqHandleFile(card, slot, file);
    }
  });
});

// Briefly turns the copy icon into a tick so the person can see the copy
// worked, then puts the normal icon back.
function flashCopyButton(btn) {
  const icon = btn.querySelector('i');
  if (!icon) return;
  clearTimeout(btn._copyResetTimer);
  btn.classList.add('is-copied');
  icon.className = 'ph ph-check';
  btn.setAttribute('title', 'Copied');
  btn.setAttribute('aria-label', 'Copied');
  btn._copyResetTimer = setTimeout(() => {
    btn.classList.remove('is-copied');
    icon.className = 'ph ph-copy';
    btn.setAttribute('title', 'Copy');
    btn.setAttribute('aria-label', 'Copy reply');
  }, 1800);
}

// Old-fashioned copy method, used only when the modern clipboard API is
// blocked (some in-app browsers, non-HTTPS pages, older Safari).
function legacyCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

// Copies what the person actually SEES (rendered bold, lists, tables,
// etc.) rather than the raw markdown source. Writes both a rich text/html
// version (so pasting into Word, Gmail, Docs, Notion, etc. keeps the
// formatting) and a plain-text fallback derived from the rendered content
// (so pasting into a plain text field shows clean text, not **asterisks**
// and other markdown syntax).
//
// Returns true if something was copied and false if every method failed,
// so the caller can show the tick (or an error) at the right moment.
async function copyMessageContent(contentEl, fallbackRawText, sources) {
  let plainText = fallbackRawText || '';
  let html = '';

  if (contentEl) {
    // Work on an off-screen copy so that (a) the "Copy" labels of code
    // blocks never end up in what is pasted, and (b) a reply that is still
    // being typed out is copied in full, not half-finished.
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:-9999px;width:600px;opacity:0;pointer-events:none;';
    host.innerHTML = contentEl.classList.contains('is-typing')
      ? renderMarkdownLite(fallbackRawText || '', sources || null)
      : contentEl.innerHTML;
    // Code blocks become plain <pre><code> with the exact source: no
    // header labels, buttons or line-number markup in what is pasted.
    host.querySelectorAll('.code-block-wrap').forEach((w) => {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeTextOf(w.querySelector('code'));
      pre.appendChild(code);
      w.replaceWith(pre);
    });
    document.body.appendChild(host);
    plainText = (host.innerText || host.textContent || '').trim() || plainText;
    html = host.innerHTML;
    host.remove();
  }

  if (!plainText) return false;

  if (html && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    try {
      const htmlBlob = new Blob([html], { type: 'text/html' });
      const textBlob = new Blob([plainText], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob }),
      ]);
      return true;
    } catch (e) {
      console.error('[app] Rich copy failed, falling back to plain text:', e.message);
    }
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(plainText);
      return true;
    } catch (e) {
      console.error('[app] Clipboard write failed, trying legacy copy:', e.message);
    }
  }

  return legacyCopyText(plainText);
}

// Wires the re-download chip for AI-generated documents. Each click
// fetches the file's base64 content fresh from /api/files (authenticated,
// scoped to the owning conversation) and triggers a real browser download
// — this works after a reload, on another device, or days later, right
// up until the conversation is deleted (see chat-storage.js's
// deleteGeneratedFilesForConversation).
function wireDocumentDownloadButtons(container) {
  container.querySelectorAll('.document-download-chip').forEach((btn) => {
    btn.addEventListener('click', () => downloadGeneratedFile(btn));
  });
}

async function downloadGeneratedFile(btn) {
  const conversationId = btn.dataset.conversationId;
  const fileId = btn.dataset.fileId;
  const filename = btn.dataset.filename;
  const mimeType = btn.dataset.mime || 'application/octet-stream';
  const stateEl = btn.querySelector('.document-download-chip-state');

  if (!conversationId || !fileId || !filename) {
    showToast('This file is no longer available for download.');
    return;
  }

  if (btn.disabled) return;
  btn.disabled = true;
  if (stateEl) stateEl.innerHTML = '<i class="ph ph-spinner ph-spin"></i>';

  try {
    const url = WORKER_URL + '/api/files/' + encodeURIComponent(conversationId) +
      '/' + encodeURIComponent(fileId) + '?filename=' + encodeURIComponent(filename);
    const res = await window.Auth.authedFetch(url);
    let data = null;
    try { data = await res.json(); } catch (parseErr) { data = null; }

    if (!res.ok || !data || !data.content) {
      showToast((data && data.error) || (res.status === 404
        ? 'This file is no longer available.'
        : 'Could not download that file. Please try again.'));
      return;
    }

    const byteChars = atob(data.content);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  } catch (e) {
    console.error('[app] Could not download generated file:', e.message);
    showToast('Could not reach Cognita. Please try again.');
  } finally {
    btn.disabled = false;
    if (stateEl) stateEl.innerHTML = '';
  }
}

function wireCodeCopyButtons(container) {
  // One delegated listener per container. Stream frames replace nodes and
  // never need re-wiring, and a button's "Copied" state is never reset by
  // a re-render. Safe to call repeatedly.
  if (container.dataset.codeWired === '1') return;
  container.dataset.codeWired = '1';

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('.code-copy-btn, .code-dl-btn');
    if (!btn || !container.contains(btn)) return;
    // The streaming content element sits inside the message list, and both
    // are wired: handle each click once.
    if (e._codeHandled) return;
    e._codeHandled = true;
    const target = document.getElementById(btn.dataset.copyTarget);
    if (!target) return;
    const text = codeTextOf(target);

    if (btn.classList.contains('code-dl-btn')) {
      const wrap = btn.closest('.code-block-wrap');
      const ext = (wrap && wrap.dataset.ext) || 'txt';
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'snippet.' + ext;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return;
    }

    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (err) {
      ok = legacyCopyText(text);
    }
    if (!ok) {
      showToast('Could not copy. Please select the code and copy it manually.');
      return;
    }
    clearTimeout(btn._copyResetTimer);
    btn.classList.add('is-copied');
    btn.innerHTML = '<i class="ph ph-check"></i><span>Copied</span>';
    btn._copyResetTimer = setTimeout(() => {
      btn.classList.remove('is-copied');
      btn.innerHTML = '<i class="ph ph-copy"></i><span>Copy</span>';
    }, 1800);
  });
}

function renderMathInElement(container) {
  if (!window.katex) return; // KaTeX script hasn't loaded yet
  container.querySelectorAll('.katex-target').forEach((el) => {
    const expr = el.textContent;
    const display = el.dataset.display === 'true';
    try {
      window.katex.render(expr, el, { throwOnError: false, displayMode: display });
    } catch (e) {
      console.error('[app] KaTeX render failed:', e.message);
    }
  });
}

function appendThinkingIndicator() {
  const list = document.getElementById('messageList');
  const id = 'thinking-' + Date.now();
  const el = document.createElement('div');
  el.className = 'message is-assistant';
  el.id = id;
  el.innerHTML =
    '<div class="message-body">' +
      '<div class="thinking-indicator">' +
        '<span class="thinking-dot"></span>' +
        '<span class="thinking-word" id="' + id + '-word">' + THINKING_WORDS[0] + '</span>' +
        '<span class="thinking-timer" id="' + id + '-timer">0.0s</span>' +
      '</div>' +
    '</div>';
  document.getElementById('emptyState').hidden = true;
  list.hidden = false;
  list.appendChild(el);
  scrollToBottom();

  const wordEl = document.getElementById(id + '-word');
  const timerEl = document.getElementById(id + '-timer');
  let wordIdx = 0;
  let counted = 0;
  let lastTick = performance.now();

  const wordInterval = setInterval(() => {
    if (!navigator.onLine) return;
    if (wordIdx < THINKING_WORDS.length - 1) wordIdx++;   // in order, then hold the last one
    if (wordEl) wordEl.textContent = THINKING_WORDS[wordIdx];
  }, 2200);

  const timerInterval = setInterval(() => {
    const now = performance.now();
    const online = navigator.onLine;
    if (online) counted += now - lastTick;               // offline time is not thinking time
    lastTick = now;
    if (wordEl) wordEl.textContent = online ? THINKING_WORDS[wordIdx] : 'You are offline';
    if (timerEl) timerEl.textContent = formatClock(counted);
  }, 100);

  activeThinkingTimers[id] = { wordInterval, timerInterval };
  return id;
}

function removeThinkingIndicator(id) {
  const timers = activeThinkingTimers[id];
  if (timers) {
    clearInterval(timers.wordInterval);
    clearInterval(timers.timerInterval);
    delete activeThinkingTimers[id];
  }
  const el = document.getElementById(id);
  if (el) el.remove();
}

function appendSystemNotice(text, kind) {
  const list = document.getElementById('messageList');
  const el = document.createElement('div');
  el.className = 'message is-assistant';
  el.innerHTML =
    '<div class="message-body"><div class="message-content" style="color:var(--text-3);">' +
      escapeHtml(text) +
    '</div></div>';
  list.appendChild(el);
  scrollToBottom();
}

// Keeps the newest text in view, but only while the person is reading at
// the bottom. Once they scroll up, new text never pulls them back down.
// Pass `true` to force it (opening a chat, sending a message).
function wireScrollFollow() {
  if (streamScroll.wired) return;
  const conv = document.getElementById('conversation');
  if (!conv) return;
  streamScroll.wired = true;

  conv.addEventListener('scroll', () => {
    // Ignore the scroll events caused by our own scrolling.
    if (Math.abs(conv.scrollTop - streamScroll.lastAutoTop) < 2) return;
    const distance = conv.scrollHeight - conv.scrollTop - conv.clientHeight;
    streamScroll.follow = distance <= NEAR_BOTTOM_PX;
  }, { passive: true });

  // Scrolling up with a mouse wheel or trackpad stops following at once.
  conv.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) streamScroll.follow = false;
  }, { passive: true });
}

function scrollToBottom(force) {
  const conv = document.getElementById('conversation');
  if (!conv) return;
  wireScrollFollow();
  if (!force && !streamScroll.follow) return;
  conv.scrollTop = conv.scrollHeight;
  streamScroll.lastAutoTop = conv.scrollTop;
  if (force) streamScroll.follow = true;
}

/* ── Markdown-lite + LaTeX renderer ── */

// A short, fixed whitelist of harmless inline formatting tags the AI
// sometimes emits directly (mainly <br> inside table cells, since
// markdown tables can't contain real line breaks any other way).
// escapeHtml() turns every "<" into "&lt;" for safety — this step
// re-allows ONLY these exact escaped tags back into real tags. Nothing
// else the AI outputs can ever pass through this, so this cannot be used
// to smuggle in a script tag or any other unsafe markup.
const _ALLOWED_RAW_TAG_RE =
  /&lt;(br|\/?b|\/?i|\/?u|\/?em|\/?strong|\/?sup|\/?sub|hr)\s*\/?&gt;/gi;

function _unescapeAllowedTags(html) {
  return html.replace(_ALLOWED_RAW_TAG_RE, (match, tagName) => {
    const lower = tagName.toLowerCase();
    if (lower === 'br' || lower === 'hr') return '<' + lower + '>';
    return '<' + lower + '>';
  });
}

// ── Lists ────────────────────────────────────────────────────────────
// Turns "- item", "* item", "• item" and "1. item" lines into real HTML
// lists. Two things this has to get right, because models write both all
// the time:
//   1. A numbered item followed by indented bullets, then the next
//      numbered item:
//         1. Setup
//            - Install Python
//         2. Core syntax
//      This is ONE numbered list with bullets nested inside its items. (It
//      used to be split into separate one-item lists, so every heading
//      restarted at "1." and the bullets lost their nesting.)
//   2. A list that really does start at a later number (e.g. it was
//      interrupted by a paragraph) keeps that number via <ol start="N">.
const _LIST_ITEM_RE = /^([ \t]*)([-*•]|\d+\.)[ \t]+(.*\S.*)$/;

function _listIndent(whitespace) {
  return whitespace.replace(/\t/g, '    ').length;
}

// items: [{ indent, ordered, number, text }] in order. Returns one HTML string.
function _buildListHtml(items) {
  let html = '';
  const stack = []; // lists currently open: { tag, indent }
  const open = (it) => {
    const tag = it.ordered ? 'ol' : 'ul';
    html += (tag === 'ol' && it.number !== 1) ? '<ol start="' + it.number + '">' : '<' + tag + '>';
    html += '<li>' + it.text;
    stack.push({ tag, indent: it.indent });
  };
  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';
    if (stack.length === 0) { open(it); continue; }
    // Back out of any deeper lists this item is no longer inside.
    while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) {
      html += '</li></' + stack.pop().tag + '>';
    }
    const top = stack[stack.length - 1];
    if (it.indent > top.indent) {
      open(it); // indented further: a nested list inside the current item
    } else if (top.tag === tag) {
      html += '</li><li>' + it.text; // next item of the same list
    } else {
      html += '</li></' + stack.pop().tag + '>'; // same level, other kind of list
      open(it);
    }
  }
  while (stack.length) html += '</li></' + stack.pop().tag + '>';
  return html;
}

function _renderMarkdownLists(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!_LIST_ITEM_RE.test(lines[i])) { out.push(lines[i]); i++; continue; }
    const items = [];
    while (i < lines.length) {
      const m = _LIST_ITEM_RE.exec(lines[i]);
      if (m) {
        items.push({ indent: _listIndent(m[1]), ordered: /\d/.test(m[2]), number: parseInt(m[2], 10), text: m[3].trim() });
        i++;
        continue;
      }
      if (lines[i].trim() === '') {
        // Blank lines between items do not end the list, as long as another
        // list item comes next.
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && _LIST_ITEM_RE.test(lines[j])) { i = j; continue; }
        break;
      }
      if (/^[ \t]+\S/.test(lines[i])) {
        // Indented text that is not a new item: the previous item continues.
        items[items.length - 1].text += '<br>' + lines[i].trim();
        i++;
        continue;
      }
      break;
    }
    out.push('', _buildListHtml(items), '');
  }
  return out.join('\n');
}

// `idPrefix` (optional) makes the generated code/math element ids stable between
// renders of a growing reply; without it ids are random, as before.
function renderMarkdownLite(text, sources, idPrefix) {
  let raw = escapeHtml(text);
  raw = _unescapeAllowedTags(raw);

  // Code goes first, before LaTeX and every other pass, so nothing inside it
  // is ever reinterpreted: a "$" in shell or PHP, a "${x}" template, a
  // "\\(x)" Swift interpolation or an "a[i]" index must reach the screen
  // exactly as written.
  const codeBlocks = [];
  raw = raw.replace(/([ \t]*)```([\w+#.-]*)[^\n`]*\n([\s\S]*?)```/g, (_, indent, lang, code) => {
    let body = code.replace(/\n[ \t]*$/, '').replace(/\n$/, '');
    if (indent) {
      // A fence nested in a list item: remove the list's indentation.
      const n = indent.replace(/\t/g, '    ').length;
      body = body.split('\n').map((ln) => ln.replace(new RegExp('^[ \\t]{0,' + n + '}'), '')).join('\n');
    }
    codeBlocks.push({ lang: lang || '', code: body });
    const ph = '\x00CODEBLOCK' + (codeBlocks.length - 1) + '\x00';
    // Nested in a list item: stay on the item's indented line so the block
    // remains inside it. Top level: make sure it is its own block.
    return indent ? indent + ph : '\n\n' + ph + '\n\n';
  });
  // Inline code is protected the same way (its text is already escaped).
  const inlineCode = [];
  raw = raw.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCode.push('<code>' + code + '</code>');
    return '\x00ICODE' + (inlineCode.length - 1) + '\x00';
  });

  // Protect LaTeX before anything else touches the string.
  const mathBlocks = [];
  raw = raw.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    mathBlocks.push({ expr, display: true });
    return '\x00MATH' + (mathBlocks.length - 1) + '\x00';
  });
  raw = raw.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => {
    mathBlocks.push({ expr, display: true });
    return '\x00MATH' + (mathBlocks.length - 1) + '\x00';
  });
  // A closing $ followed by a digit, or padding spaces inside the $..$, means money ("$1,000-$1,300",
  // "$5 and $10"), not math, so it is left as plain text.
  raw = raw.replace(/(^|[^$])\$([^$\n]+?)\$(?![$\d])/g, (m, pre, expr) => {
    if (/^\s|\s$/.test(expr)) return m;
    mathBlocks.push({ expr, display: false });
    return pre + '\x00MATH' + (mathBlocks.length - 1) + '\x00';
  });
  raw = raw.replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => {
    mathBlocks.push({ expr, display: false });
    return '\x00MATH' + (mathBlocks.length - 1) + '\x00';
  });

  // Links: [label](url) markdown syntax becomes a real clickable anchor.
  // Must run before bold/italic (a label may itself contain other
  // markdown-looking characters) and before the bare-URL autolink pass
  // below, so a properly-formed [label](url) is never re-wrapped.
  // escapeHtml already turned "&" into "&amp;" etc. inside url/label, so
  // unescape the url portion just enough to produce a valid href while
  // still escaping it correctly for the attribute.
  // At this point `raw` is already escapeHtml()'d, so both the label and
  // the url below are already entity-safe for direct use in an href
  // attribute (e.g. a literal "&" is already "&amp;") — no further
  // escaping or unescaping needed.
  const linkPlaceholders = [];
  raw = raw.replace(/\[([^\[\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g, (_, label, url) => {
    const html = '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    linkPlaceholders.push(html);
    return '\x00LINK' + (linkPlaceholders.length - 1) + '\x00';
  });

  // Bare URLs (not already part of a markdown link) become clickable too,
  // so a model that forgets the [label](url) form still doesn't leave a
  // dead-looking raw link sitting in the reply.
  raw = raw.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+[^\s<>()".,!?:;'])/g, (whole, pre, url) => {
    const html = '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    linkPlaceholders.push(html);
    return pre + '\x00LINK' + (linkPlaceholders.length - 1) + '\x00';
  });

  // Headings — must run before bold/italic so "#" lines aren't eaten.
  raw = raw.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  raw = raw.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  raw = raw.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  raw = raw.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  raw = raw.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  raw = raw.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes: consecutive "> " lines become one <blockquote>. Must run
  // before paragraph-wrapping so the block survives as a unit.
  raw = raw.replace(/^[ \t]*&gt;[ \t]?(.*)$/gm, '\x00BQ\x00$1');
  raw = raw.replace(/(?:\x00BQ\x00.*(?:\n|$))+/g, (block) => {
    const lines = block.split('\x00BQ\x00').filter((s) => s.length > 0 || s === '');
    const inner = lines.map((l) => l.trim()).join('<br>');
    return '<blockquote>' + inner + '</blockquote>';
  });

  // Horizontal rules: a line that's only ---, ***, or ___ (3+ chars).
  raw = raw.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '<hr>');

  // Emphasis, resolved inside-out so mixed **bold*italic*** combinations
  // don't leave stray asterisks behind.
  raw = raw.replace(/\*\*\*([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  raw = raw.replace(/___([^_]+?)___/g, '<strong><em>$1</em></strong>');
  raw = raw.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  raw = raw.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
  raw = raw.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, (_, pre, content) => pre + '<em>' + content + '</em>');
  raw = raw.replace(/\b_([^_\n]+?)_\b/g, '<em>$1</em>');

  if (sources && sources.length) {
    raw = raw.replace(/\[(\d+)\]/g, (whole, n) => {
      const i = parseInt(n, 10) - 1;
      if (i < 0 || i >= sources.length) return whole;
      const src = sources[i];
      return '<a class="citation-marker" href="' + escapeHtml(src.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(src.title || src.url) + '">[' + n + ']</a>';
    });
  }

  // Any remaining [bracketed text] at this point is not a markdown link
  // (those were already pulled out into \x00LINK tokens above) and not a
  // resolved citation marker — it's almost always a fill-in-the-blank
  // template placeholder (e.g. "[target market]") that a reply is using
  // on purpose. Left as bare text it reads like a broken/failed link, so
  // it gets a distinct placeholder style instead of plain paragraph text.
  raw = raw.replace(/\[([^\[\]\n]{1,80})\]/g, '<span class="md-placeholder">[$1]</span>');

  // Tables: any block of 2+ consecutive lines that each contain at least
  // one "|", where the second line looks like a separator row, is
  // treated as a table. Cell content may now legitimately contain real
  // <br> (and the other whitelisted tags) thanks to _unescapeAllowedTags
  // above, so a cell's line breaks render correctly instead of showing
  // literal "<br>" text.
  raw = raw.replace(/((?:^.*\|.*$\n?){2,})/gm, (block) => {
    const lines = block.replace(/\n$/, '').split('\n');
    if (lines.length < 2) return block;
    if (!/^[\s|:-]+$/.test(lines[1])) return block;

    const parseCells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const headerCells = parseCells(lines[0]);
    const bodyLines = lines.slice(2).filter((l) => l.trim() !== '');
    if (bodyLines.length === 0) return block;

    const thead = '<thead><tr>' + headerCells.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead>';
    const tbody = '<tbody>' + bodyLines.map((line) =>
      '<tr>' + parseCells(line).map((c) => '<td>' + c + '</td>').join('') + '</tr>'
    ).join('') + '</tbody>';

    return '<div class="md-table-wrap"><table class="md-table">' + thead + tbody + '</table></div>';
  });

  // Bullet and numbered lines, including bullets nested under a numbered
  // item, become real nested <ul>/<ol> lists (see _renderMarkdownLists).
  raw = _renderMarkdownLists(raw);

  const blocks = raw.split(/\n\s*\n/);
  raw = blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (/^<(ul|ol|table|div|pre|h[1-6]|blockquote|hr)/.test(trimmed)) return trimmed;
    if (/^\x00CODEBLOCK\d+\x00$/.test(trimmed)) return trimmed;
    if (/^\x00MATH\d+\x00$/.test(trimmed)) return trimmed;
    return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
  }).join('');

  raw = raw.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => {
    const block = codeBlocks[parseInt(i, 10)];
    const id = 'code-' + (idPrefix ? idPrefix + i : Math.random().toString(36).slice(2, 9));
    return buildCodeBlockHtml({ lang: block.lang, code: block.code, id });
  });

  raw = raw.replace(/\x00ICODE(\d+)\x00/g, (_, i) => inlineCode[parseInt(i, 10)]);

  raw = raw.replace(/\x00MATH(\d+)\x00/g, (_, i) => {
    const m = mathBlocks[parseInt(i, 10)];
    const id = 'math-' + (idPrefix ? idPrefix + i : Math.random().toString(36).slice(2, 9));
    const tag = m.display ? 'div' : 'span';
    return '<' + tag + ' class="katex-target" id="' + id + '" data-display="' + m.display + '">' +
      escapeHtml(m.expr) + '</' + tag + '>';
  });

  raw = raw.replace(/\x00LINK(\d+)\x00/g, (_, i) => linkPlaceholders[parseInt(i, 10)]);

  return raw;
}

/* ════════════════════════════════════════════════════════
   VISUAL GENERATION MODAL (diagram / illustration)
════════════════════════════════════════════════════════ */

function openVisualModal(presetKind) {
  const modal = document.getElementById('visualModal');
  const promptInput = document.getElementById('visualPromptInput');
  const typeOptions = document.querySelectorAll('#visualModal .visual-type-option');

  visualKind = presetKind || 'diagram';
  typeOptions.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.kind === visualKind));

  openModal(modal);
  promptInput.value = '';
  promptInput.focus();
}

function wireVisualModal() {
  const modal = document.getElementById('visualModal');
  const closeBtn = document.getElementById('visualModalClose');
  const submitBtn = document.getElementById('visualSubmitBtn');
  const promptInput = document.getElementById('visualPromptInput');
  const typeOptions = document.querySelectorAll('#visualModal .visual-type-option');

  closeBtn.addEventListener('click', () => { closeModal(modal); });
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal); });

  typeOptions.forEach((btn) => {
    btn.addEventListener('click', () => {
      typeOptions.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      visualKind = btn.dataset.kind;
    });
  });

  submitBtn.addEventListener('click', async () => {
    const prompt = promptInput.value.trim();
    if (!prompt) return;

    setModalLoading(submitBtn, true);

    try {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, kind: visualKind }),
      });

      const data = await res.json();
      setModalLoading(submitBtn, false);

      if (!res.ok) {
        showToast(data.error || 'Could not generate the visual.');
        return;
      }

      closeModal(modal);
      insertVisualIntoConversation(data, prompt);
    } catch (e) {
      setModalLoading(submitBtn, false);
      showToast('Could not reach Cognita. Please try again.');
      console.error('[app] visual request failed:', e.message);
    }
  });
}

function setModalLoading(btn, isLoading) {
  btn.disabled = isLoading;
  btn.querySelector('.btn-label').hidden = isLoading;
  btn.querySelector('.btn-spinner').hidden = !isLoading;
}

// Strips anything executable from generated SVG before it is shown or stored.
function _sanitizeSvg(svg) {
  return String(svg || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
}

// The visual itself is stored on the message (msg.visual) so it survives
// re-renders, reloads and syncing to other devices. `content` stays a short
// text placeholder — that is all the model ever sees.
function insertVisualIntoConversation(data, promptText) {
  if (loadingConversationId && loadingConversationId === currentConversationId) {
    showToast('This chat is still loading. Please try again in a moment.');
    return;
  }
  const visual = data.type === 'svg'
    ? { type: 'svg', content: _sanitizeSvg(data.content) }
    : { type: 'image', content: data.content };

  conversation.push({ role: 'user', content: 'Generate a visual: ' + promptText });
  conversation.push({
    role: 'assistant',
    content: '[Generated a visual for: ' + promptText + ']',
    visual,
    visualAlt: promptText,
  });

  renderConversation();
  updateConversationTitle();
  persistCurrentConversation();
}

/* ════════════════════════════════════════���═══════════════
   DOCUMENT GENERATION MODAL (letter / report / essay / memo)
════════════════════════════════════════════════════════ */

function openDocumentModal() {
  const modal = document.getElementById('documentModal');
  const topicInput = document.getElementById('documentTopicInput');
  const typeOptions = document.querySelectorAll('#documentTypeToggle .visual-type-option');
  const formatOptions = document.querySelectorAll('#documentFormatToggle .visual-type-option');

  documentDocType = 'letter';
  documentFormat = 'docx';
  typeOptions.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.doctype === documentDocType));
  formatOptions.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.format === documentFormat));

  openModal(modal);
  topicInput.value = '';
  topicInput.focus();
}

function wireDocumentModal() {
  const modal = document.getElementById('documentModal');
  const closeBtn = document.getElementById('documentModalClose');
  const submitBtn = document.getElementById('documentSubmitBtn');
  const topicInput = document.getElementById('documentTopicInput');
  const typeOptions = document.querySelectorAll('#documentTypeToggle .visual-type-option');
  const formatOptions = document.querySelectorAll('#documentFormatToggle .visual-type-option');

  closeBtn.addEventListener('click', () => { closeModal(modal); });
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal); });

  typeOptions.forEach((btn) => {
    btn.addEventListener('click', () => {
      typeOptions.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      documentDocType = btn.dataset.doctype;
    });
  });

  formatOptions.forEach((btn) => {
    btn.addEventListener('click', () => {
      formatOptions.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      documentFormat = btn.dataset.format;
    });
  });

  submitBtn.addEventListener('click', async () => {
    const topic = topicInput.value.trim();
    if (!topic) return;

    setModalLoading(submitBtn, true);

    // A document generated in a brand-new chat still needs somewhere to
    // be scoped for later retrieval — make sure a conversationId exists
    // before asking the server to build (and persist) the file.
    const conversationId = ensureConversationId();

    try {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, docType: documentDocType, format: documentFormat, conversationId }),
      });

      const data = await res.json();
      setModalLoading(submitBtn, false);

      if (!res.ok) {
        showToast(data.error || 'Could not generate the document.');
        return;
      }

      closeModal(modal);
      insertDocumentIntoConversation(data, topic, documentDocType, conversationId);
    } catch (e) {
      setModalLoading(submitBtn, false);
      showToast('Could not reach Cognita. Please try again.');
      console.error('[app] document request failed:', e.message);
    }
  });
}

function insertDocumentIntoConversation(data, topicText, docType, conversationId) {
  if (loadingConversationId && loadingConversationId === currentConversationId) {
    showToast('This chat is still loading. Please try again in a moment.');
    return;
  }
  conversation.push({ role: 'user', content: 'Create a ' + docType + ' about: ' + topicText });

  const mimeType = EXPORT_MIME_TYPES[data.format];

  if (mimeType) {
    const assistantMessage = { role: 'assistant', content: '[Generated a ' + docType + ' document: ' + data.filename + ']' };

    // If the server confirmed it persisted the file (fileId present),
    // attach that metadata to the message so it travels with the
    // conversation to B2 and survives a reload — this is what the
    // re-download chip in renderMessage reads from. If persistence
    // failed server-side (fileId missing), the person still gets this
    // one-time download below, they just won't be able to re-fetch it
    // later — flagged so it's an honest degradation, not a silent one.
    if (data.fileId) {
      assistantMessage.documentFile = {
        fileId: data.fileId,
        conversationId: data.conversationId || conversationId,
        filename: data.filename,
        mimeType,
      };
    }

    if (!data.fileId) {
      // Fallback: no persisted copy exists, so give an immediate one-time
      // download via a blob URL built from this response's own bytes. The
      // link is remembered for this session so it survives re-renders.
      const byteChars = atob(data.content);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: mimeType });
      _transientDownloads.set(assistantMessage, { url: URL.createObjectURL(blob), filename: data.filename });
    }

    conversation.push(assistantMessage);
    renderConversation();
    updateConversationTitle();

    if (!data.fileId) {
      showToast('This file could not be saved for later — download it now before leaving this chat.');
    }
  } else {
    // Free plan: plain text only, shown directly as the reply.
    conversation.push({ role: 'assistant', content: data.content });
    renderConversation();
    updateConversationTitle();
  }

  persistCurrentConversation();
}

/* ════════════════════════════════════════════════════════
   CONNECTED APPS MODAL (connectors: view/connect/disconnect)
════════════════════════════════════════════════════════ */

// Display-only metadata — same list as account.html's Connections
// section. The actual scopes and OAuth handling are entirely
// server-side; this is purely what icon/description to render.
const CONNECTOR_META = {
  github: {
    label: 'GitHub', icon: 'ph-github-logo', desc: 'List repos, read files, open issues.',
    hint: 'You need to be signed in to GitHub in this browser to connect it.',
  },
  google: { label: 'Google', icon: 'ph-google-logo', desc: 'Calendar (full read/write), Drive (files Cognita creates), and Gmail (send + labels only).' },
  facebook: { label: 'Facebook & Instagram', icon: 'ph-facebook-logo', desc: 'Post to a Facebook Page and its linked Instagram account, and schedule posts.' },
  canva: { label: 'Canva', icon: 'ph-image-square', desc: 'List and create designs.' },
};
const CONNECTOR_ORDER = ['github', 'google', 'facebook', 'canva'];

// Google and Facebook require their brand mark to appear in its standard
// multi-color form — a monochrome icon-font glyph doesn't satisfy that, so
// those two get the real logo as inline SVG (mirrors account.html).
// GitHub's mark is officially single-color by design (github.com/logos:
// "do not modify... including changing the color") — there is no
// multi-color GitHub logo to use, so recoloring it would itself be a
// violation. This is the exact official Octocat path, rendered in
// currentColor so it still goes dark-on-light / light-on-dark like their
// own "Invertocat" usage.
// Canva DOES publish a downloadable logo pack (canva.dev/docs/apps/
// rest-apis/brand-guidelines: "you can download assets of the Canva logo" —
// asset zip at canva.dev/assets/connect/Canva-logos.zip). Their guide says
// to use the "icon logo" specifically for surfaces below 50px, which is
// this row, so it's referenced as a real asset file rather than redrawn —
// see /assets/canva-icon-logo.svg (drop the icon-logo SVG from that zip in
// at that path; don't recolor or reshape it per their "Don't" list).
const CONNECTOR_BRAND_SVG = {
  github: '<svg class="connector-row-icon" width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="currentColor" style="color: var(--text-2);">' +
    '<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>' +
    '</svg>',
  google: '<svg class="connector-row-icon" width="20" height="20" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.79 2.73v2.27h2.9c1.7-1.56 2.69-3.87 2.69-6.64z"/>' +
    '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.27c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.34C2.44 15.98 5.48 18 9 18z"/>' +
    '<path fill="#FBBC05" d="M3.95 10.69A5.4 5.4 0 0 1 3.68 9c0-.59.1-1.16.27-1.69V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.34z"/>' +
    '<path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.97l2.99 2.34C4.66 5.17 6.65 3.58 9 3.58z"/>' +
    '</svg>',
  facebook: '<svg class="connector-row-icon" width="20" height="20" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="#1877F2" d="M18 9a9 9 0 1 0-10.4 8.9v-6.3H5.3V9h2.3V6.9c0-2.3 1.4-3.6 3.5-3.6.7 0 1.5.1 2.2.2v2.4h-1.2c-1.2 0-1.5.7-1.5 1.5V9h2.6l-.4 2.6h-2.2v6.3A9 9 0 0 0 18 9Z"/>' +
    '</svg>',
  canva: '<img class="connector-row-icon" src="/assets/canva-icon-logo.svg" width="20" height="20" alt="" />',
};

// `locked` = this plan's connectorTools feature is off (see
// currentAccountHasConnectorTools). A locked, not-yet-connected row
// still gets a real "Connect" button rather than a disabled one — same
// reasoning as the quality picker's locked options — so a screen
// reader or a quick tap still gets the upgrade explanation instead of
// silent nothing. wireConnectorsModal is what actually stops the
// connect action when locked. A row that's already connected (e.g. the
// account was Plus and just downgraded) is never locked — disconnecting
// must always stay available.
function connectorRowHtml(provider, connected, locked) {
  const meta = CONNECTOR_META[provider];
  const isLockedRow = locked && !connected;
  const icon = CONNECTOR_BRAND_SVG[provider] || ('<i class="ph ' + meta.icon + '"></i>');
  return (
    '<div class="connector-row' + (isLockedRow ? ' is-locked' : '') + '" data-provider="' + provider + '">' +
      icon +
      '<div class="connector-row-text">' +
        '<span class="connector-row-name">' + meta.label + '</span>' +
        '<span class="connector-row-desc' + (connected ? ' is-connected' : '') + '">' +
          (connected ? 'Connected' : meta.desc) +
        '</span>' +
        (!connected && meta.hint ? '<span class="connector-row-hint">' + meta.hint + '</span>' : '') +
      '</div>' +
      (connected
        ? '<button class="connector-row-cta is-danger connector-modal-disconnect-btn" data-provider="' + provider + '">Disconnect</button>'
        : '<button class="connector-row-cta' + (isLockedRow ? ' is-locked' : '') + ' connector-modal-connect-btn" data-provider="' + provider + '">' +
            (isLockedRow ? '<i class="ph ph-lock-simple"></i> Upgrade' : 'Connect') +
          '</button>') +
    '</div>'
  );
}

async function loadConnectorsList() {
  const list = document.getElementById('connectorsList');
  const planNote = document.getElementById('connectorsPlanNote');
  if (planNote) {
    // Only Free-tier users need the explanation — Plus/Studio/Admin all
    // have connectorTools, so hide it for everyone else rather than
    // showing a permanently-true banner.
    planNote.hidden = currentAccountHasConnectorTools;
  }
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/connectors/status');
    const status = await res.json();
    if (!res.ok) throw new Error(status.error || 'Failed to load connected apps.');

    list.innerHTML = CONNECTOR_ORDER
      .map((p) => connectorRowHtml(p, !!status[p], !currentAccountHasConnectorTools))
      .join('');
  } catch (e) {
    list.innerHTML = '<p style="color:var(--text-3); padding: var(--space-3);">Could not load connected apps.</p>';
    console.error('[app] connectors status failed:', e.message);
  }
}

function openConnectorsModal() {
  const modal = document.getElementById('connectorsModal');
  openModal(modal);
  loadConnectorsList();
}

function wireConnectorsModal() {
  const modal = document.getElementById('connectorsModal');
  const closeBtn = document.getElementById('connectorsModalClose');
  const list = document.getElementById('connectorsList');

  closeBtn.addEventListener('click', () => { closeModal(modal); });
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal); });

  // Event delegation — rows are replaced wholesale on every
  // loadConnectorsList() call, so listeners live on the stable container.
  list.addEventListener('click', async (e) => {
    const connectBtn = e.target.closest('.connector-modal-connect-btn');
    const disconnectBtn = e.target.closest('.connector-modal-disconnect-btn');

    if (connectBtn) {
      const provider = connectBtn.dataset.provider;

      // Same pattern as the quality picker's locked options: the
      // button stays clickable so the person gets an explanation
      // instead of a dead click, but the actual OAuth flow never
      // starts. connectors-endpoint.js enforces this same check
      // server-side too, so this is purely about giving a clear
      // reason here rather than a generic failure after redirecting
      // away to the provider.
      if (!currentAccountHasConnectorTools) {
        showToast('Connected apps require Cognita Plus or higher. Upgrade to connect ' + CONNECTOR_META[provider].label + '.');
        return;
      }

      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting…';
      try {
        // returnTo=chat: this modal was opened from the chat page, so the
        // provider's callback should send the user back here (app.html),
        // not to account.html — see connectors-endpoint.js.
        const res = await window.Auth.authedFetch(WORKER_URL + '/api/connectors/' + provider + '/start?returnTo=chat');
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error || 'Could not start connection.');
        // Full-page navigation — the provider's consent screen redirects
        // back to this same chat page when done; the conversation is
        // saved and will still be here afterward.
        window.location.href = data.url;
      } catch (err) {
        showToast('Could not connect ' + CONNECTOR_META[provider].label + ': ' + err.message);
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
      }
      return;
    }

    if (disconnectBtn) {
      const provider = disconnectBtn.dataset.provider;
      const confirmed = confirm('Disconnect ' + CONNECTOR_META[provider].label + '? Cognita will no longer be able to use it in chat until you reconnect.');
      if (!confirmed) return;

      disconnectBtn.disabled = true;
      disconnectBtn.textContent = 'Disconnecting…';
      try {
        const res = await window.Auth.authedFetch(WORKER_URL + '/api/connectors/' + provider + '/disconnect', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not disconnect.');
        loadConnectorsList();
      } catch (err) {
        showToast('Could not disconnect ' + CONNECTOR_META[provider].label + ': ' + err.message);
        disconnectBtn.disabled = false;
        disconnectBtn.textContent = 'Disconnect';
      }
    }
  });
}

// Landed here from a provider's OAuth redirect (returnTo=chat)? Show a
// one-line result banner inside the Connected Apps modal and open the
// modal so it's actually visible, then strip the query params so a
// refresh doesn't re-show it. Mirrors account.html's banner for the
// three outcomes connectors-endpoint.js can redirect back with:
// connected, denied (user cancelled — not an error), and error.
function showConnectorRedirectBanner() {
  const params = new URLSearchParams(window.location.search);
  const provider = params.get('connector');
  const status = params.get('status');
  const reason = params.get('reason');
  if (!provider || !status) return;

  const label = CONNECTOR_META[provider] ? CONNECTOR_META[provider].label : provider;
  const messages = {
    connected: label + ' connected.',
    denied: label + ' connection was cancelled.',
    error: reason === 'session_expired'
      ? 'Your sign-in session with ' + label + ' expired before the connection finished. This happens if ' + label + ' asked for extra verification and it took a while to complete. Try connecting again, and stay in the same tab until it is done.'
      : 'Something went wrong connecting ' + label + '. Please try again.',
  };

  const banner = document.getElementById('connectorsBanner');
  if (banner && messages[status]) {
    banner.textContent = messages[status];
    banner.classList.toggle('is-error', status === 'error');
    banner.hidden = false;
  }

  openConnectorsModal();

  // Clean the URL so refreshing doesn't re-show the banner or re-open
  // the modal.
  window.history.replaceState({}, '', window.location.pathname);
}

// ── Recover from a stuck "Connecting…"/"Disconnecting…" button ──────
// Same bfcache issue as account.html: window.location.href leaves this
// page's state untouched until the browser actually navigates away, so
// a back-button return or interrupted navigation can restore this page
// from bfcache with a button still stuck disabled mid-label. `pageshow`
// with event.persisted fires exactly on that restore (never on a normal
// fresh load), so this can't clobber a click that's genuinely about to
// navigate away. Re-running loadConnectorsList() rebuilds every row from
// real, freshly-fetched status, which never renders a "Connecting…" /
// "Disconnecting…" state — only "Connect" or "Disconnect" — so this
// covers both button kinds and any number of connector rows at once.
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !document.getElementById('connectorsModal').hidden) {
    loadConnectorsList();
  }
});
