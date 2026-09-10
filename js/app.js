// js/app.js
// Cognita main app behavior. Talks to the Worker exclusively through
// window.Auth.authedFetch — never calls Groq/OpenRouter/Paystack/etc
// directly, and never constructs a request containing a provider or
// model name. The Worker decides all of that.

const WORKER_URL = 'https://cognita.cognitai.workers.dev';
const HISTORY_KEY = 'cognita:conversations';

const QUALITY_META = {
  standard: { label: 'Standard' },
  advanced: { label: 'Advanced' },
  thorough: { label: 'Thorough' },
};

// Short phrases only — long sentences don't fit well as a placeholder.
const PLACEHOLDERS = [
  'Message Cognita',
  'Ask anything',
  'Draft, plan, explain',
  "What's on your mind?",
];

const TYPE_SPEED_MS = 45;     // per character while typing
const DELETE_SPEED_MS = 25;   // per character while deleting
const HOLD_AFTER_TYPE_MS = 1400; // pause once a phrase is fully typed
const RESUME_AFTER_IDLE_MS = 4000; // wait after user goes idle before resuming

// Image types we'll try to send to the vision model. Anything else (pdf,
// docx, etc.) is either extracted client-side (see below) or flagged to
// the user rather than silently dropped.
const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp|gif)$/i;
const TEXT_FILE_RE = /\.(txt|csv)$/i;
const TEXT_MIME_TYPES = ['text/plain', 'text/csv'];
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
let _lastReconcileAt = 0;

let currentQuality = 'standard';
let conversation = []; // { role: 'user'|'assistant', content: string, attachments?: [...], documentFile?: {...} }
let conversationMeta = [];
let currentConversationId = null;
let isSending = false;
let activeThinkingTimers = {};

let placeholderIndex = 0;
let placeholderTimeoutId = null;
let placeholderResumeTimeoutId = null;
let placeholderRunning = false;

// Attachments staged in the composer before the message is sent.
// { name, kind: 'image'|'text'|'unsupported', dataUrl?, base64?, mimeType?, text? }
let pendingAttachments = [];

let currentAccountPlanId = null;
let currentAccountHasVision = false;
let currentAccountHasDocExport = false;
let currentAccountChatTiers = ['fast'];
let visualKind = 'diagram';
let documentDocType = 'letter';
let documentFormat = 'docx';

const THINKING_WORDS = [
  'Thinking',
  'Reasoning',
  'Working through it',
  'Digging into it',
  'Considering the angles',
  'Piecing it together',
];

/* ════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════ */

(async function init() {
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
  wireSidebar();
  wireAccountMenu();
  wireVisualModal();
  wireDocumentModal();
  wireSuggestionCards();
  startPlaceholderTypewriter();

  reconcileIfDue();
  window.addEventListener('focus', reconcileIfDue);
})();

/* ════════════════════════════════════════════════════════
   ACCOUNT / USAGE DISPLAY
════════════════════════════════════════════════════════ */

function renderAccountInfo(user) {
  const displayName = (user.displayName || '').trim();
  const label = displayName || user.email || 'Signed in';
  document.getElementById('accountEmail').textContent = label;
  document.getElementById('accountAvatar').textContent = label.charAt(0).toUpperCase();
}

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

    const upgradeLink = document.getElementById('upgradeLink');
    if (data.planId !== 'studio') {
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
  } catch (e) {
    console.error('[app] Could not load account:', e.message);
  }
}

function updateImageAttachAvailability() {
  const illustrationItem = document.getElementById('attachIllustrationItem');
  if (illustrationItem) {
    illustrationItem.classList.toggle('is-locked', !currentAccountHasVision);
    illustrationItem.title = currentAccountHasVision
      ? 'Generate a realistic illustration'
      : 'Realistic illustrations are available on Cognita Plus and above';
  }
}

// Maps a quality-picker option's data-quality value to the internal tier
// key used by entitlements.js / the backend, so availability can be
// checked against the plan's actual allowed chat tiers.
function _tierKeyForQuality(quality) {
  if (quality === 'thorough') return 'reasoning';
  if (quality === 'advanced') return 'advanced';
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
}

async function refreshUsage() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/usage');
    if (!res.ok) return;
    const data = await res.json();

    const { used, limit } = data.usage.messages;
    const usageEl = document.getElementById('usageMessages');
    usageEl.textContent = used + ' / ' + limit;
    usageEl.classList.remove('skeleton');

    const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    const fill = document.getElementById('usageMessagesBar');
    fill.style.width = pct + '%';
    fill.classList.toggle('is-near-limit', pct >= 70 && pct < 100);
    fill.classList.toggle('is-at-limit', pct >= 100);
  } catch (e) {
    console.error('[app] Could not load usage:', e.message);
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

function saveAllConversations(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('[app] Could not persist chat history:', e.message);
  }
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
// it's the conversation currently open on screen, re-renders it too.
async function fetchAndMergeConversation(id, serverUpdatedAt) {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat/' + id);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.conversation) return;

    const all = loadAllConversations();
    const idx = all.findIndex((c) => c.id === id);
    const merged = { ...data.conversation, id, remoteSyncedAt: serverUpdatedAt, notLoaded: false };
    if (idx >= 0) all[idx] = merged; else all.push(merged);
    saveAllConversations(all);

    if (id === currentConversationId) {
      conversation = merged.messages || [];
      conversationMeta = merged.meta || [];
      if (merged.quality) setQuality(merged.quality);
      renderConversation();
      updateConversationTitle();
    }
    renderSidebarHistory();
  } catch (e) {
    console.error('[app] Could not fetch conversation from storage:', e.message);
  }
}

// Reconciles local chat history against what B2 actually has. Timestamp
// rule throughout: whichever of "edited" vs "deleted" happened later,
// wins. Never mutates local storage on a failed or malformed server
// response — a network hiccup must never be read as "everything's gone."
async function reconcileWithB2() {
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
        if (local.id === currentConversationId) {
          currentConversationId = null;
          conversation = [];
          conversationMeta = [];
          renderConversation();
          updateConversationTitle();
          showToast('This chat was deleted from another device.');
        }
      }
      continue;
    }

    // remote.status === 'live'
    const serverIsNewer = !local.remoteSyncedAt || remote.serverUpdatedAt > local.remoteSyncedAt;
    const localHasNoUnpushedEdit = local.remoteSyncedAt && local.updatedAt <= local.remoteSyncedAt;
    if (serverIsNewer && (localHasNoUnpushedEdit || !local.remoteSyncedAt)) {
      fetchAndMergeConversation(local.id, remote.serverUpdatedAt);
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
      title: 'Untitled chat',
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
}

function reconcileIfDue() {
  const now = Date.now();
  if (now - _lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  _lastReconcileAt = now;
  reconcileWithB2();
}

// Called after every completed exchange so the sidebar and title always
// reflect what's on screen. Creates a new saved entry on first message,
// updates the existing one afterward.
function persistCurrentConversation() {
  if (conversation.length === 0) return;

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

  nav.innerHTML = all.map((c) => (
    '<button class="sidebar-history-item' + (c.id === currentConversationId ? ' is-active' : '') + '" data-id="' + c.id + '">' +
      '<span>' + escapeHtml(c.title) + '</span>' +
      '<span class="history-delete-btn" data-delete-id="' + c.id + '" title="Delete chat"><i class="ph ph-x"></i></span>' +
    '</button>'
  )).join('');

  nav.querySelectorAll('.sidebar-history-item').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-id]')) return;
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
  const all = loadAllConversations();
  const entry = all.find((c) => c.id === id);
  if (!entry) return;

  currentConversationId = entry.id;

  if (entry.notLoaded) {
    conversation = [];
    conversationMeta = [];
    renderConversation();
    updateConversationTitle();
    renderSidebarHistory();
    closeMobileSidebar();
    fetchAndMergeConversation(id, entry.remoteSyncedAt);
    return;
  }

  conversation = entry.messages;
  conversationMeta = entry.meta || [];
  if (entry.quality) setQuality(entry.quality);
  renderConversation();
  updateConversationTitle();
  renderSidebarHistory();
  closeMobileSidebar();
}

function deleteConversation(id) {
  const all = loadAllConversations().filter((c) => c.id !== id);
  saveAllConversations(all);

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
    conversation = [];
    conversationMeta = [];
    renderConversation();
    updateConversationTitle();
  }

  renderSidebarHistory();
}

/* ════════════════════════════════════════════════════════
   SIDEBAR
════════════════════════════════════════════════════════ */

function wireSidebar() {
  const sidebar = document.getElementById('appSidebar');
  const scrim = document.getElementById('sidebarScrim');

  document.getElementById('sidebarCollapseBtn').addEventListener('click', () => {
    sidebar.classList.toggle('is-collapsed');
  });

  document.getElementById('sidebarCloseBtn').addEventListener('click', () => {
    closeMobileSidebar();
  });

  document.getElementById('mobileSidebarBtn').addEventListener('click', () => {
    sidebar.classList.add('is-open');
    scrim.classList.add('is-visible');
  });

  scrim.addEventListener('click', closeMobileSidebar);

  document.getElementById('newChatBtn').addEventListener('click', () => {
    currentConversationId = null;
    conversation = [];
    conversationMeta = [];
    renderConversation();
    updateConversationTitle();
    renderSidebarHistory();
    closeMobileSidebar();
  });
}

function closeMobileSidebar() {
  document.getElementById('appSidebar').classList.remove('is-open');
  document.getElementById('sidebarScrim').classList.remove('is-visible');
}

function wireAccountMenu() {
  const btn = document.getElementById('accountBtn');
  const menu = document.getElementById('accountMenu');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });

  document.addEventListener('click', () => { menu.hidden = true; });

  document.getElementById('logOutBtn').addEventListener('click', async () => {
    await window.Auth.logOut();
    window.location.href = '/login.html';
  });
}

/* ════════════════════════════════════════════════════════
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
    const isOpen = !menu.hidden;
    menu.hidden = isOpen;
    trigger.setAttribute('aria-expanded', String(!isOpen));
  });

  document.addEventListener('click', () => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  });

  options.forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const tierKey = _tierKeyForQuality(opt.dataset.quality);
      if (!currentAccountChatTiers.includes(tierKey)) {
        showToast('This quality level requires a higher Cognita plan. Upgrade to unlock it.');
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        return;
      }
      setQuality(opt.dataset.quality);
      menu.hidden = true;
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
  const fileInput = document.getElementById('fileInput');

  function closeMenu() {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !menu.hidden;
    menu.hidden = isOpen;
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

function wireSuggestionCards() {
  document.querySelectorAll('.suggestion-row').forEach((row) => {
    row.addEventListener('click', () => {
      sendMessage(row.dataset.prompt);
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

    if (fileAtts.length) {
      text += fileAtts.map((a) =>
        '\n\n--- Content of attached file "' + a.name + '" ---\n' + a.text
      ).join('');
    }
    if (unsupportedAtts.length) {
      text += unsupportedAtts.map((a) =>
        '\n\n[The user attached "' + a.name + '" but this file type cannot be read yet — let them know.]'
      ).join('');
    }
  }
  return text.trim();
}

async function sendMessage(text) {
  if (isSending || (!text && pendingAttachments.length === 0)) return;
  isSending = true;

  const input = document.getElementById('composerInput');
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('sendBtn').disabled = true;
  notifyComposerActivity();

  // Attachments kept for display (thumbnails/chips) — never the raw
  // base64 string or full file text is put into the visible message.
  const attachmentsForMessage = pendingAttachments.map((a) => {
    if (a.kind === 'image') return { kind: 'image', name: a.name, dataUrl: a.dataUrl, mimeType: a.mimeType };
    if (a.kind === 'text') return { kind: 'file', name: a.name, text: a.text };
    return { kind: 'unsupported', name: a.name };
  });

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

  const thinkingId = appendThinkingIndicator();
  const startedAt = performance.now();

  try {
    const payload = {
      messages: conversation.map((m) => ({ role: m.role, content: buildEffectiveContent(m) })),
      quality: currentQuality,
    };
    if (outgoingImages.length > 0) payload.images = outgoingImages;

    const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    removeThinkingIndicator(thinkingId);

    if (!res.ok) {
      appendSystemNotice(data.error || 'Something went wrong. Please try again.', res.status === 429 ? 'limit' : 'error');
      isSending = false;
      return;
    }

    const elapsedMs = performance.now() - startedAt;

    conversation.push({ role: 'assistant', content: data.reply });
    conversationMeta[conversation.length - 1] = {
      thinking: data.thinking || null,
      sources: data.sources || null,
      elapsedMs,
    };
    renderConversation();
    refreshUsage();
    persistCurrentConversation();
  } catch (e) {
    removeThinkingIndicator(thinkingId);
    appendSystemNotice('Could not reach Cognita. Please check your connection.', 'error');
    console.error('[app] chat request failed:', e.message);
  }

  isSending = false;
}

/* ════════════════════════════════════════════════════════
   CONVERSATION RENDERING
════════════════════════════════════════════════════════ */

function renderConversation() {
  const emptyState = document.getElementById('emptyState');
  const list = document.getElementById('messageList');

  if (conversation.length === 0) {
    emptyState.hidden = false;
    list.hidden = true;
    list.innerHTML = '';
    return;
  }

  emptyState.hidden = true;
  list.hidden = false;
  list.innerHTML = conversation.map(renderMessage).join('');
  scrollToBottom();
  wireMessageActionButtons();
  wireDocumentDownloadButtons(list);
  wireCodeCopyButtons(list);
  renderMathInElement(list);
}

function renderMessage(msg, index) {
  const isUser = msg.role === 'user';
  const avatarContent = isUser ? 'Y' : '<img src="/assets/cognita.png" alt="" style="width:16px;height:16px;">';
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

  let thoughtHtml = '';
  if (!isUser && meta.thinking) {
    const secs = meta.elapsedMs ? (meta.elapsedMs / 1000).toFixed(1) : null;
    thoughtHtml =
      '<details class="thought-block">' +
        '<summary>' + (secs ? 'Thought for ' + secs + 's' : 'Thought process') + '</summary>' +
        '<div class="thought-content">' + renderMarkdownLite(meta.thinking) + '</div>' +
      '</details>';
  }

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

  // Generated document (docx/pdf/pptx) attached to this assistant message.
  // Rendered as a chip that re-fetches the actual bytes on click, via
  // wireDocumentDownloadButtons — this is what makes the file
  // re-downloadable after a reload, unlike a one-time blob URL.
  let documentFileHtml = '';
  if (!isUser && msg.documentFile) {
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
    '<div class="message ' + (isUser ? 'is-user' : 'is-assistant') + '">' +
      '<div class="message-avatar">' + avatarContent + '</div>' +
      '<div class="message-body">' +
        thoughtHtml +
        attachmentsHtml +
        (msg.content ? '<div class="message-content">' + renderMarkdownLite(msg.content, isUser ? null : meta.sources) + '</div>' : '') +
        documentFileHtml +
        sourcesHtml +
        (isUser ? '' :
          '<div class="message-actions">' +
            '<button class="message-action-btn" data-action="copy" data-index="' + index + '" title="Copy"><i class="ph ph-copy"></i></button>' +
            '<button class="message-action-btn" data-action="regenerate" data-index="' + index + '" title="Regenerate"><i class="ph ph-arrow-clockwise"></i></button>' +
          '</div>'
        ) +
      '</div>' +
    '</div>'
  );
}

function wireMessageActionButtons() {
  document.querySelectorAll('[data-action="copy"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      const messageEl = btn.closest('.message');
      const contentEl = messageEl ? messageEl.querySelector('.message-content') : null;
      copyMessageContent(contentEl, conversation[idx] ? conversation[idx].content : '');
      showToast('Copied to clipboard.');
    });
  });

  document.querySelectorAll('[data-action="regenerate"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const priorUserMsg = [...conversation.slice(0, idx)].reverse().find((m) => m.role === 'user');
      if (!priorUserMsg) return;
      conversation = conversation.slice(0, idx);
      conversationMeta = conversationMeta.slice(0, idx);
      renderConversation();
      await sendMessage(priorUserMsg.content);
    });
  });
}

// Copies what the person actually SEES (rendered bold, lists, tables,
// etc.) rather than the raw markdown source. Writes both a rich text/html
// version (so pasting into Word, Gmail, Docs, Notion, etc. keeps the
// formatting) and a plain-text fallback derived from the rendered content
// (so pasting into a plain text field shows clean text, not **asterisks**
// and other markdown syntax). Falls back to the old plain writeText
// behavior on browsers/contexts that don't support rich clipboard writes
// (e.g. non-HTTPS, older Safari, some in-app browsers).
async function copyMessageContent(contentEl, fallbackRawText) {
  const plainText = contentEl ? contentEl.innerText : (fallbackRawText || '');

  if (contentEl && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    try {
      const htmlBlob = new Blob([contentEl.innerHTML], { type: 'text/html' });
      const textBlob = new Blob([plainText], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob }),
      ]);
      return;
    } catch (e) {
      console.error('[app] Rich copy failed, falling back to plain text:', e.message);
    }
  }

  try {
    await navigator.clipboard.writeText(plainText);
  } catch (e) {
    console.error('[app] Copy failed:', e.message);
  }
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
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Could not download that file.');
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
  container.querySelectorAll('.code-copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target) return;
      navigator.clipboard.writeText(target.textContent).then(() => {
        btn.classList.add('is-copied');
        btn.innerHTML = '<i class="ph ph-check"></i> Copied';
        setTimeout(() => {
          btn.classList.remove('is-copied');
          btn.innerHTML = '<i class="ph ph-copy"></i> Copy';
        }, 1800);
      });
    });
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
    '<div class="message-avatar"><img src="/assets/cognita.png" alt="" style="width:16px;height:16px;"></div>' +
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

  const startedAt = performance.now();
  const wordEl = document.getElementById(id + '-word');
  const timerEl = document.getElementById(id + '-timer');
  let wordIdx = 0;

  const wordInterval = setInterval(() => {
    wordIdx = (wordIdx + 1) % THINKING_WORDS.length;
    if (wordEl) wordEl.textContent = THINKING_WORDS[wordIdx];
  }, 2200);

  const timerInterval = setInterval(() => {
    const elapsed = (performance.now() - startedAt) / 1000;
    if (timerEl) timerEl.textContent = elapsed.toFixed(1) + 's';
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
    '<div class="message-avatar"><i class="ph ph-warning" style="font-size:14px;"></i></div>' +
    '<div class="message-body"><div class="message-content" style="color:var(--text-3);">' +
      escapeHtml(text) +
    '</div></div>';
  list.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  const conv = document.getElementById('conversation');
  conv.scrollTop = conv.scrollHeight;
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

function renderMarkdownLite(text, sources) {
  let raw = escapeHtml(text);
  raw = _unescapeAllowedTags(raw);

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
  raw = raw.replace(/(^|[^$])\$([^$\n]+?)\$(?!\$)/g, (_, pre, expr) => {
    mathBlocks.push({ expr, display: false });
    return pre + '\x00MATH' + (mathBlocks.length - 1) + '\x00';
  });
  raw = raw.replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => {
    mathBlocks.push({ expr, display: false });
    return '\x00MATH' + (mathBlocks.length - 1) + '\x00';
  });

  const codeBlocks = [];
  raw = raw.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
    return '\x00CODEBLOCK' + (codeBlocks.length - 1) + '\x00';
  });

  raw = raw.replace(/`([^`\n]+)`/g, '<code>$1</code>');

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

  raw = raw.replace(/^[ \t]*[-*•][ \t]+(.+)$/gm, '\x00ULI\x00$1');
  raw = raw.replace(/(?:\x00ULI\x00.+(?:\n|$))+/g, (block) => {
    const items = block.split('\x00ULI\x00').filter((s) => s.trim());
    return '<ul>' + items.map((i) => '<li>' + i.trim() + '</li>').join('') + '</ul>';
  });

  raw = raw.replace(/^[ \t]*\d+\.[ \t]+(.+)$/gm, '\x00OLI\x00$1');
  raw = raw.replace(/(?:\x00OLI\x00.+(?:\n|$))+/g, (block) => {
    const items = block.split('\x00OLI\x00').filter((s) => s.trim());
    return '<ol>' + items.map((i) => '<li>' + i.trim() + '</li>').join('') + '</ol>';
  });

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
    const id = 'code-' + Math.random().toString(36).slice(2, 9);
    return '<div class="code-block-wrap">' +
      '<button class="code-copy-btn" data-copy-target="' + id + '"><i class="ph ph-copy"></i> Copy</button>' +
      '<pre><code id="' + id + '">' + block.code + '</code></pre>' +
    '</div>';
  });

  raw = raw.replace(/\x00MATH(\d+)\x00/g, (_, i) => {
    const m = mathBlocks[parseInt(i, 10)];
    const id = 'math-' + Math.random().toString(36).slice(2, 9);
    const tag = m.display ? 'div' : 'span';
    return '<' + tag + ' class="katex-target" id="' + id + '" data-display="' + m.display + '">' +
      escapeHtml(m.expr) + '</' + tag + '>';
  });

  return raw;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ════════════════════════════════════════════════════════
   VISUAL GENERATION MODAL (diagram / illustration)
════════════════════════════════════════════════════════ */

function openVisualModal(presetKind) {
  if (presetKind === 'illustration' && !currentAccountHasVision) {
    showToast('Realistic illustrations are available on Cognita Plus and above. Upgrade to generate one.');
    return;
  }

  const modal = document.getElementById('visualModal');
  const promptInput = document.getElementById('visualPromptInput');
  const typeOptions = document.querySelectorAll('#visualModal .visual-type-option');

  visualKind = presetKind || 'diagram';
  typeOptions.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.kind === visualKind));

  modal.hidden = false;
  promptInput.value = '';
  promptInput.focus();
}

function wireVisualModal() {
  const modal = document.getElementById('visualModal');
  const closeBtn = document.getElementById('visualModalClose');
  const submitBtn = document.getElementById('visualSubmitBtn');
  const promptInput = document.getElementById('visualPromptInput');
  const typeOptions = document.querySelectorAll('#visualModal .visual-type-option');

  closeBtn.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

  typeOptions.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.kind === 'illustration' && !currentAccountHasVision) {
        showToast('Realistic illustrations are available on Cognita Plus and above.');
        return;
      }
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

      modal.hidden = true;
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

function insertVisualIntoConversation(data, promptText) {
  let contentHtml;
  if (data.type === 'svg') {
    contentHtml = data.content;
  } else {
    contentHtml = '<img src="data:image/jpeg;base64,' + data.content + '" alt="' + escapeHtml(promptText) + '" style="border-radius:12px;max-width:100%;">';
  }

  conversation.push({ role: 'user', content: 'Generate a visual: ' + promptText });
  conversation.push({ role: 'assistant', content: '__VISUAL__' });

  renderConversation();
  updateConversationTitle();

  const list = document.getElementById('messageList');
  const lastMsg = list.lastElementChild;
  if (lastMsg) {
    const contentEl = lastMsg.querySelector('.message-content');
    if (contentEl) contentEl.innerHTML = contentHtml;
  }

  conversation = conversation.map((m) =>
    m.content === '__VISUAL__' ? { ...m, content: '[Generated a visual for: ' + promptText + ']' } : m
  );

  persistCurrentConversation();
}

/* ════════════════════════════════════════════════════════
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

  modal.hidden = false;
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

  closeBtn.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

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

      modal.hidden = true;
      insertDocumentIntoConversation(data, topic, documentDocType, conversationId);
    } catch (e) {
      setModalLoading(submitBtn, false);
      showToast('Could not reach Cognita. Please try again.');
      console.error('[app] document request failed:', e.message);
    }
  });
}

function insertDocumentIntoConversation(data, topicText, docType, conversationId) {
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

    conversation.push(assistantMessage);
    renderConversation();
    updateConversationTitle();

    if (!data.fileId) {
      // Fallback: no persisted copy exists, so give an immediate one-time
      // download via a blob URL built from this response's own bytes.
      const byteChars = atob(data.content);
      const byteNumbers = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
      const blob = new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
      const url = URL.createObjectURL(blob);

      const list = document.getElementById('messageList');
      const lastMsg = list.lastElementChild;
      if (lastMsg) {
        const contentEl = lastMsg.querySelector('.message-content');
        if (contentEl) {
          contentEl.innerHTML =
            '<a class="document-download-chip" href="' + url + '" download="' + escapeHtml(data.filename) + '">' +
              '<i class="ph ph-file-arrow-down"></i>' +
              '<span>' + escapeHtml(data.filename) + '</span>' +
            '</a>';
        }
      }
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
   TOAST
════════════════════════════════════════════════════════ */

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
