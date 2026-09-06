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
// docx, etc.) is flagged to the user rather than silently dropped.
const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp|gif)$/i;
const TEXT_FILE_RE = /\.(txt|csv)$/i;
const TEXT_MIME_TYPES = ['text/plain', 'text/csv'];

let currentQuality = 'standard';
let conversation = []; // { role: 'user'|'assistant', content: string, images?: string[] }
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
  wireQualityPicker();
  wireSidebar();
  wireAccountMenu();
  wireVisualModal();
  wireSuggestionCards();
  startPlaceholderTypewriter();
})();

/* ════════════════════════════════════════════════════════
   ACCOUNT / USAGE DISPLAY
════════════════════════════════════════════════════════ */

let currentAccountPlanId = null;
let currentAccountFeatures = null;

function renderAccountInfo(user) {
  const email = user.email || 'Signed in';
  document.getElementById('accountEmail').textContent = email;
  document.getElementById('accountAvatar').textContent = email.charAt(0).toUpperCase();
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
    currentAccountFeatures = data.features || null;

    const upgradeLink = document.getElementById('upgradeLink');
    if (data.planId !== 'studio') {
      upgradeLink.hidden = false;
    }

    // Vision (image attachment) is premium-gated. Reflect that on the
    // attach button so free users get a clear affordance instead of a
    // dead click.
    updateImageAttachAvailability();
  } catch (e) {
    console.error('[app] Could not load account:', e.message);
  }
}

function updateImageAttachAvailability() {
  const imageAttachBtn = document.getElementById('imageAttachBtn');
  if (!imageAttachBtn) return;
  const enabled = !!(currentAccountFeatures && currentAccountFeatures.visionEnabled);
  imageAttachBtn.classList.toggle('is-locked', !enabled);
  imageAttachBtn.title = enabled
    ? 'Attach an image'
    : 'Image understanding is available on premium plans';
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
  const text = (firstUser.content || (firstUser.images && firstUser.images.length ? 'Image' : '')).trim().replace(/\s+/g, ' ');
  return text.length > 60 ? text.slice(0, 60) + '…' : (text || 'New chat');
}

function updateConversationTitle() {
  const titleEl = document.getElementById('conversationTitle');
  titleEl.textContent = deriveTitle(conversation);
}

/* ════════════════════════════════════════════════════════
   CHAT HISTORY (persisted client-side in localStorage)
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
  const entry = {
    id: currentConversationId,
    title: deriveTitle(conversation),
    messages: conversation,
    meta: conversationMeta,
    quality: currentQuality,
    updatedAt: Date.now(),
  };

  if (existingIndex >= 0) {
    all[existingIndex] = entry;
  } else {
    all.unshift(entry);
  }

  saveAllConversations(all);
  renderSidebarHistory();
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
   COMPOSER + ATTACHMENTS + SENDING MESSAGES
════════════════════════════════════════════════════════ */

function wireComposer() {
  const input = document.getElementById('composerInput');
  const sendBtn = document.getElementById('sendBtn');
  const attachBtn = document.getElementById('attachBtn');       // text/csv files
  const imageAttachBtn = document.getElementById('imageAttachBtn'); // images (premium)
  const fileInput = document.getElementById('fileInput');
  const imageInput = document.getElementById('imageInput');

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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage(input.value.trim());
    }
  });

  sendBtn.addEventListener('click', () => {
    sendMessage(input.value.trim());
  });

  // Document/text attach button.
  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const isTextLike = TEXT_MIME_TYPES.includes(file.type) || TEXT_FILE_RE.test(file.name);

    if (isTextLike) {
      try {
        const text = await file.text();
        pendingAttachments.push({ name: file.name, kind: 'text', text });
      } catch (err) {
        console.error('[app] Could not read file:', err.message);
        showToast('Could not read that file.');
        return;
      }
    } else if (IMAGE_MIME_RE.test(file.type)) {
      // Images picked from the generic paperclip are routed the same way
      // as the dedicated image button, so gating still applies.
      await handleImageFile(file);
      refreshSendEnabled();
      renderComposerAttachments();
      return;
    } else {
      pendingAttachments.push({ name: file.name, kind: 'unsupported' });
    }

    renderComposerAttachments();
    refreshSendEnabled();
    input.focus();
  });

  // Dedicated image attach button — premium-gated.
  imageAttachBtn.addEventListener('click', () => {
    if (!currentAccountFeatures || !currentAccountFeatures.visionEnabled) {
      showToast('Image understanding is available on premium plans. Upgrade to attach images.');
      return;
    }
    imageInput.click();
  });

  imageInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    await handleImageFile(file);
    renderComposerAttachments();
    refreshSendEnabled();
    input.focus();
  });
}

async function handleImageFile(file) {
  if (!IMAGE_MIME_RE.test(file.type)) {
    pendingAttachments.push({ name: file.name, kind: 'unsupported' });
    return;
  }
  if (!currentAccountFeatures || !currentAccountFeatures.visionEnabled) {
    showToast('Image understanding is available on premium plans.');
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
      escapeHtml(att.name) + suffix +
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

async function sendMessage(text) {
  if (isSending || (!text && pendingAttachments.length === 0)) return;
  isSending = true;

  const input = document.getElementById('composerInput');
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('sendBtn').disabled = true;
  notifyComposerActivity();

  const imageAttachments = pendingAttachments.filter((a) => a.kind === 'image');
  const textAttachments = pendingAttachments.filter((a) => a.kind === 'text');
  const unsupportedAttachments = pendingAttachments.filter((a) => a.kind === 'unsupported');

  let fullText = text || '';
  if (textAttachments.length > 0) {
    fullText += textAttachments.map((a) =>
      '\n\n--- Content of attached file "' + a.name + '" ---\n' + a.text
    ).join('');
  }
  if (unsupportedAttachments.length > 0) {
    fullText += unsupportedAttachments.map((a) =>
      '\n\n[The user attached "' + a.name + '" but this file type cannot be read yet — let them know.]'
    ).join('');
  }
  fullText = fullText.trim();

  const outgoingImages = imageAttachments.map((a) => ({ base64: a.base64, mimeType: a.mimeType }));
  const displayImages = imageAttachments.map((a) => a.dataUrl);

  pendingAttachments = [];
  renderComposerAttachments();

  const userMessage = { role: 'user', content: fullText };
  if (displayImages.length > 0) userMessage.images = displayImages;
  conversation.push(userMessage);
  renderConversation();
  updateConversationTitle();

  const thinkingId = appendThinkingIndicator();
  const startedAt = performance.now();

  try {
    const payload = {
      messages: conversation.map((m) => ({ role: m.role, content: m.content })),
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
  wireCodeCopyButtons(list);
  renderMathInElement(list);
}

function renderMessage(msg, index) {
  const isUser = msg.role === 'user';
  const avatarContent = isUser ? 'Y' : '<img src="/assets/cognita.png" alt="" style="width:16px;height:16px;">';
  const meta = conversationMeta[index] || {};

  let imagesHtml = '';
  if (isUser && msg.images && msg.images.length) {
    imagesHtml = '<div class="message-image-grid">' +
      msg.images.map((src) => '<img src="' + src + '" alt="" class="message-image">').join('') +
    '</div>';
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

  return (
    '<div class="message ' + (isUser ? 'is-user' : 'is-assistant') + '">' +
      '<div class="message-avatar">' + avatarContent + '</div>' +
      '<div class="message-body">' +
        thoughtHtml +
        imagesHtml +
        (msg.content ? '<div class="message-content">' + renderMarkdownLite(msg.content, isUser ? null : meta.sources) + '</div>' : '') +
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
      navigator.clipboard.writeText(conversation[idx].content);
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
function renderMarkdownLite(text, sources) {
  let raw = escapeHtml(text);

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
  raw = raw.replace(/(?<!\$)\$([^\$\n]+?)\$(?!\$)/g, (_, expr) => {
    mathBlocks.push({ expr, display: false });
    return '\x00MATH' + (mathBlocks.length - 1) + '\x00';
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

  raw = raw.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  raw = raw.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');

  if (sources && sources.length) {
    raw = raw.replace(/\[(\d+)\]/g, (whole, n) => {
      const i = parseInt(n, 10) - 1;
      if (i < 0 || i >= sources.length) return whole;
      const src = sources[i];
      return '<a class="citation-marker" href="' + escapeHtml(src.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(src.title || src.url) + '">[' + n + ']</a>';
    });
  }

  raw = raw.replace(/((?:^\|.+\|\s*$\n?)+)/gm, (block) => {
    const lines = block.trim().split('\n').filter(Boolean);
    if (lines.length < 2) return block;

    const parseCells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const isSeparator = /^[\|\s\-:]+$/.test(lines[1]);
    const headerCells = parseCells(lines[0]);
    const bodyLines = isSeparator ? lines.slice(2) : lines.slice(1);
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
    if (/^<(ul|ol|table|div|pre|h[1-6])/.test(trimmed)) return trimmed;
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
   VISUAL GENERATION MODAL
════════════════════════════════════════════════════════ */

let visualKind = 'diagram';

function wireVisualModal() {
  const modal = document.getElementById('visualModal');
  const openBtn = document.getElementById('visualBtn');
  const closeBtn = document.getElementById('visualModalClose');
  const submitBtn = document.getElementById('visualSubmitBtn');
  const promptInput = document.getElementById('visualPromptInput');
  const typeOptions = document.querySelectorAll('.visual-type-option');

  openBtn.addEventListener('click', () => {
    modal.hidden = false;
    promptInput.value = '';
    promptInput.focus();
  });

  closeBtn.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

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

    setModalLoading(true);

    try {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, kind: visualKind }),
      });

      const data = await res.json();
      setModalLoading(false);

      if (!res.ok) {
        showToast(data.error || 'Could not generate the visual.');
        return;
      }

      modal.hidden = true;
      insertVisualIntoConversation(data, prompt);
    } catch (e) {
      setModalLoading(false);
      showToast('Could not reach Cognita. Please try again.');
      console.error('[app] visual request failed:', e.message);
    }
  });
}

function setModalLoading(isLoading) {
  const btn = document.getElementById('visualSubmitBtn');
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
