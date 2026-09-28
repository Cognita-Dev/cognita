// js/inbox.js
// AI Inbox view. Exports mount() (first open) plus activate()/deactivate()
// so polling pauses while another view is showing.

import { ensureSidebarAccount } from './shell.js';

const WORKER_URL = 'https://api.cognita.com.ng';
const POLL_INTERVAL_MS = 25000;

let user = null;

const skeleton = document.getElementById('inboxSkeleton');
const blockedNotice = document.getElementById('inboxBlockedNotice');
const blockedTitle = document.getElementById('inboxBlockedTitle');
const blockedDesc = document.getElementById('inboxBlockedDesc');
const contentWrap = document.getElementById('inboxContentWrap');
const subscribePrompt = document.getElementById('subscribePrompt');
const subscribeBtn = document.getElementById('subscribeBtn');
const tabsWrap = document.getElementById('inboxTabs');
const listWrap = document.getElementById('inboxList');
const emptyWrap = document.getElementById('inboxEmpty');

let currentStatus = '';
let currentCategory = '';
let pollTimer = null;
let hasSubscribed = localStorage.getItem('cognita_inbox_subscribed') === '1';

function showBlocked(title, desc) {
  skeleton.hidden = true;
  contentWrap.hidden = true;
  blockedNotice.hidden = false;
  blockedTitle.textContent = title;
  blockedDesc.textContent = desc;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderItem(item) {
  const card = document.createElement('div');
  const category = item.category || 'other';
  card.className = 'inbox-card';
  card.dataset.category = category;

  const kindLabel = item.kind === 'dm' ? 'DM' : 'Comment';
  const platformLabel = item.platform === 'instagram' ? 'Instagram' : 'Facebook';
  const canReply = item.status !== 'replied' && item.status !== 'dismissed' && item.status !== 'spam';
  if (!canReply) card.dataset.resolved = 'true';

  card.innerHTML = `
    <div class="inbox-card-head">
      <span class="inbox-card-author">${escapeHtml(item.authorName || item.authorId || 'Someone')}</span>
      <span class="inbox-card-meta">${platformLabel} · ${kindLabel}</span>
      ${item.category ? `<span class="inbox-badge inbox-badge--${category}">${category}</span>` : ''}
      ${item.status === 'replied' ? '<span class="inbox-badge inbox-badge--positive"><i class="ph ph-check"></i>&nbsp;Replied</span>' : ''}
      ${item.status === 'spam' ? '<span class="inbox-badge inbox-badge--spam">Marked spam</span>' : ''}
    </div>
    <div class="inbox-card-text">${escapeHtml(item.text)}</div>
    ${canReply ? `
      <div class="inbox-reply">
        <span class="inbox-reply-label"><i class="ph ph-sparkle"></i> AI draft reply — edit before sending</span>
        <textarea class="inbox-card-draft" data-id="${item.id}" placeholder="Write a reply…">${escapeHtml(item.aiDraftReply || '')}</textarea>
      </div>
      <div class="inbox-card-actions">
        <button class="inbox-btn inbox-btn--primary" data-action="reply" data-id="${item.id}">
          <i class="ph ph-paper-plane-tilt"></i> <span class="btn-label">Send</span>
        </button>
        <button class="inbox-btn" data-action="regenerate" data-id="${item.id}">
          <i class="ph ph-arrow-clockwise"></i> <span class="btn-label">Regenerate</span>
        </button>
        <button class="inbox-btn" data-action="dismiss" data-id="${item.id}">Dismiss</button>
        <button class="inbox-btn inbox-btn--danger" data-action="spam" data-id="${item.id}">Mark as spam</button>
      </div>
    ` : ''}
  `;
  return card;
}

async function loadItems() {
  const params = new URLSearchParams();
  if (currentStatus) params.set('status', currentStatus);
  if (currentCategory) params.set('category', currentCategory);

  const res = await window.Auth.authedFetch(WORKER_URL + '/api/inbox?' + params.toString());
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    showBlocked('Reconnect Facebook for the Inbox', body.error || 'Reconnect Facebook in Account Settings to enable the Inbox.');
    return;
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    showBlocked('Upgrade required', body.error || 'The AI Inbox requires Cognita Plus or higher.');
    return;
  }
  if (!res.ok) return;

  const data = await res.json();
  skeleton.hidden = true;
  blockedNotice.hidden = true;
  contentWrap.hidden = false;
  subscribePrompt.hidden = hasSubscribed;

  listWrap.innerHTML = '';
  if (!data.items.length) {
    emptyWrap.hidden = false;
  } else {
    emptyWrap.hidden = true;
    for (const item of data.items) listWrap.appendChild(renderItem(item));
  }
}

subscribeBtn.addEventListener('click', async () => {
  subscribeBtn.disabled = true;
  subscribeBtn.textContent = 'Enabling…';
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/inbox/subscribe', { method: 'POST' });
    if (res.ok) {
      hasSubscribed = true;
      localStorage.setItem('cognita_inbox_subscribed', '1');
      subscribePrompt.hidden = true;
    }
  } finally {
    subscribeBtn.disabled = false;
    subscribeBtn.textContent = 'Enable';
  }
});

tabsWrap.addEventListener('click', (e) => {
  const btn = e.target.closest('.inbox-tab');
  if (!btn) return;
  tabsWrap.querySelectorAll('.inbox-tab').forEach((b) => {
    b.classList.remove('inbox-tab--active');
    b.setAttribute('aria-selected', 'false');
  });
  btn.classList.add('inbox-tab--active');
  btn.setAttribute('aria-selected', 'true');
  currentStatus = btn.dataset.status || '';
  currentCategory = btn.dataset.category || '';
  loadItems();
});

listWrap.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const card = btn.closest('.inbox-card');
  const action = btn.dataset.action;

  const label = btn.querySelector('.btn-label');
  const originalLabel = label ? label.textContent : null;
  btn.disabled = true;
  btn.classList.add('is-loading');
  if (label) label.textContent = action === 'reply' ? 'Sending…' : 'Regenerating…';

  try {
    if (action === 'reply') {
      const text = card.querySelector('.inbox-card-draft').value;
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/inbox/' + id + '/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Could not send that reply.');
      }
    } else if (action === 'regenerate') {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/inbox/' + id + '/regenerate', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Could not regenerate a draft.');
      }
    } else if (action === 'dismiss') {
      await window.Auth.authedFetch(WORKER_URL + '/api/inbox/' + id + '/dismiss', { method: 'POST' });
    } else if (action === 'spam') {
      await window.Auth.authedFetch(WORKER_URL + '/api/inbox/' + id + '/spam', { method: 'POST' });
    }
    await loadItems();
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    if (label && originalLabel) label.textContent = originalLabel;
  }
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    const viewEl = document.getElementById('view-inbox');
    if (document.visibilityState === 'visible' && viewEl && !viewEl.hidden) loadItems();
  }, POLL_INTERVAL_MS);
}

export async function mount() {
  user = await window.Auth.requireAuthOrRedirect();
  if (!user) return;
  ensureSidebarAccount();
  await loadItems();
  startPolling();
}

// The router calls these when the view is hidden / shown again, so the
// 25s poll never keeps running behind another view.
export function deactivate() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export function activate() {
  loadItems();
  startPolling();
}
