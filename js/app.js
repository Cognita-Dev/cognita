// js/app.js
// Cognita main app behavior. Talks to the Worker exclusively through
// window.Auth.authedFetch — never calls Groq/OpenRouter/Paystack/etc
// directly, and never constructs a request containing a provider or
// model name. The Worker decides all of that.

const WORKER_URL = 'https://YOUR_WORKER_SUBDOMAIN.workers.dev';

let currentQuality = 'standard';
let conversation = []; // { role: 'user'|'assistant', content: string }
let isSending = false;

/* ════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════ */

(async function init() {
  const user = await window.Auth.requireAuthOrRedirect();
  if (!user) return; // already redirected to login

  renderAccountInfo(user);
  await refreshUsage();
  await refreshAccount();

  wireComposer();
  wireQualitySelector();
  wireSidebar();
  wireAccountMenu();
  wireVisualModal();
  wireSuggestionCards();
})();

/* ════════════════════════════════════════════════════════
   ACCOUNT / USAGE DISPLAY
════════════════════════════════════════════════════════ */

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

    const upgradeLink = document.getElementById('upgradeLink');
    if (data.planId !== 'studio') {
      upgradeLink.hidden = false;
    }
  } catch (e) {
    console.error('[app] Could not load account:', e.message);
  }
}

async function refreshUsage() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/usage');
    if (!res.ok) return;
    const data = await res.json();

    const { used, limit } = data.usage.messages;
    document.getElementById('usageMessages').textContent = used + ' / ' + limit;

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
   SIDEBAR
════════════════════════════════════════════════════════ */

function wireSidebar() {
  document.getElementById('sidebarCollapseBtn').addEventListener('click', () => {
    document.getElementById('appSidebar').classList.toggle('is-collapsed');
  });

  document.getElementById('mobileSidebarBtn').addEventListener('click', () => {
    document.getElementById('appSidebar').classList.toggle('is-open');
  });

  document.getElementById('newChatBtn').addEventListener('click', () => {
    conversation = [];
    renderConversation();
  });
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
   QUALITY SELECTOR
   Frontend vocabulary is ONLY 'standard' | 'advanced' | 'thorough'.
   It has no way to name a model or provider — the Worker maps this
   hint to an actual tier and clamps it to the user's plan.
════════════════════════════════════════════════════════ */

function wireQualitySelector() {
  const options = document.querySelectorAll('.quality-option');
  options.forEach((btn) => {
    btn.addEventListener('click', () => {
      options.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      currentQuality = btn.dataset.quality;
    });
  });
}

/* ════════════════════════════════════════════════════════
   COMPOSER + SENDING MESSAGES
════════════════════════════════════════════════════════ */

function wireComposer() {
  const input = document.getElementById('composerInput');
  const sendBtn = document.getElementById('sendBtn');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    sendBtn.disabled = !input.value.trim() || isSending;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage(input.value.trim());
    }
  });

  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (text) sendMessage(text);
  });
}

function wireSuggestionCards() {
  document.querySelectorAll('.suggestion-card').forEach((card) => {
    card.addEventListener('click', () => {
      sendMessage(card.dataset.prompt);
    });
  });
}

async function sendMessage(text) {
  if (isSending || !text) return;
  isSending = true;

  const input = document.getElementById('composerInput');
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('sendBtn').disabled = true;

  conversation.push({ role: 'user', content: text });
  renderConversation();

  const thinkingId = appendThinkingIndicator();

  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: conversation,
        quality: currentQuality,
      }),
    });

    const data = await res.json();
    removeThinkingIndicator(thinkingId);

    if (!res.ok) {
      appendSystemNotice(data.error || 'Something went wrong. Please try again.', res.status === 429 ? 'limit' : 'error');
      isSending = false;
      return;
    }

    conversation.push({ role: 'assistant', content: data.reply });
    renderConversation();
    refreshUsage();
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
}

function renderMessage(msg, index) {
  const isUser = msg.role === 'user';
  const avatarContent = isUser ? 'Y' : '<img src="/assets/cognita.png" alt="" style="width:16px;height:16px;">';

  return (
    '<div class="message ' + (isUser ? 'is-user' : 'is-assistant') + '">' +
      '<div class="message-avatar">' + avatarContent + '</div>' +
      '<div class="message-body">' +
        '<div class="message-content">' + renderMarkdownLite(msg.content) + '</div>' +
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
      // Regenerate: drop this assistant message and everything after it,
      // then resend the last user message that preceded it.
      const priorUserMsg = [...conversation.slice(0, idx)].reverse().find((m) => m.role === 'user');
      if (!priorUserMsg) return;
      conversation = conversation.slice(0, idx - 1);
      renderConversation();
      await sendMessage(priorUserMsg.content);
    });
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
    '<div class="message-body"><div class="thinking-indicator">' +
      '<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>' +
    '</div></div>';
  document.getElementById('emptyState').hidden = true;
  list.hidden = false;
  list.appendChild(el);
  scrollToBottom();
  return id;
}

function removeThinkingIndicator(id) {
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

/* ── Minimal, safe markdown-lite renderer (bold, line breaks, paragraphs) ──
   Deliberately conservative: escapes HTML first, then applies a small set
   of transforms. This is not a full markdown parser — Cognita's system
   prompt asks the model for plain prose, so this only needs to handle
   basic formatting gracefully, not arbitrary markdown. */
function renderMarkdownLite(text) {
  const escaped = escapeHtml(text);
  const withBold = escaped.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  const paragraphs = withBold.split(/\n\s*\n/).map((p) => '<p>' + p.replace(/\n/g, '<br>') + '</p>');
  return paragraphs.join('');
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
    contentHtml = data.content; // raw SVG, safe — generated server-side from a controlled prompt template
  } else {
    contentHtml = '<img src="data:image/jpeg;base64,' + data.content + '" alt="' + escapeHtml(promptText) + '" style="border-radius:12px;max-width:100%;">';
  }

  conversation.push({ role: 'user', content: 'Generate a visual: ' + promptText });
  conversation.push({ role: 'assistant', content: '__VISUAL__' }); // marker; rendered specially below

  renderConversation();

  // Replace the placeholder assistant message's content with the actual
  // visual markup — done as a DOM patch since visuals aren't plain text
  // that belongs in the conversation[] array sent back to the Worker.
  const list = document.getElementById('messageList');
  const lastMsg = list.lastElementChild;
  if (lastMsg) {
    const contentEl = lastMsg.querySelector('.message-content');
    if (contentEl) contentEl.innerHTML = contentHtml;
  }

  // Don't actually send "__VISUAL__" back to the Worker on next message —
  // strip placeholder markers from what gets sent as history.
  conversation = conversation.map((m) =>
    m.content === '__VISUAL__' ? { ...m, content: '[Generated a visual for: ' + promptText + ']' } : m
  );
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
