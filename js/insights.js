// js/insights.js
// AI Insights Digest view. Exports mount(), called once by js/router.js the
// first time this view is opened. Moved out of insights.html unchanged apart
// from the mount wrapper.

import { ensureSidebarAccount } from './shell.js';

const WORKER_URL = 'https://api.cognita.com.ng';

let user = null;

const skeleton = document.getElementById('insightsSkeleton');
const blockedNotice = document.getElementById('insightsBlockedNotice');
const blockedTitle = document.getElementById('insightsBlockedTitle');
const blockedDesc = document.getElementById('insightsBlockedDesc');
const contentWrap = document.getElementById('insightsContentWrap');
const pageChecks = document.getElementById('pageChecks');
const scheduleForm = document.getElementById('scheduleForm');
const frequencySelect = document.getElementById('frequencySelect');
const deliverEmailCheck = document.getElementById('deliverEmailCheck');
const emailAddressInput = document.getElementById('emailAddressInput');
const enabledCheck = document.getElementById('enabledCheck');
const generateNowBtn = document.getElementById('generateNowBtn');
const generateStatus = document.getElementById('generateStatus');
const digestHistory = document.getElementById('digestHistory');
const historyEmpty = document.getElementById('historyEmpty');

let isBlocked = false;

function showBlocked(title, desc) {
  isBlocked = true;
  skeleton.hidden = true;
  contentWrap.hidden = true;
  blockedNotice.hidden = false;
  blockedTitle.textContent = title;
  blockedDesc.textContent = desc;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadPages() {
  const res = await window.Auth.authedFetch(WORKER_URL + '/api/social/pages');
  if (res.status === 409 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    showBlocked(res.status === 403 ? 'Upgrade required' : "Facebook isn't connected", body.error || 'Connect Facebook in Account Settings first.');
    return [];
  }
  if (!res.ok) return [];
  const data = await res.json();
  return data.pages || [];
}

async function loadSchedule(pages) {
  const res = await window.Auth.authedFetch(WORKER_URL + '/api/insights/schedule');
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    showBlocked('Upgrade required', body.error || 'The AI Insights Digest requires Cognita Plus or higher.');
    return;
  }
  if (!res.ok) return;
  const { schedule } = await res.json();

  pageChecks.innerHTML = pages.map((p) => `
    <label class="insights-toggle-row">
      <span>${escapeHtml(p.name)}${p.instagram ? ' (+ Instagram)' : ''}</span>
      <input type="checkbox" class="page-check" value="${escapeHtml(p.id)}" ${schedule.pageIds.includes(p.id) ? 'checked' : ''}>
    </label>
  `).join('') || '<span class="insights-field-hint">No connected Pages yet.</span>';

  frequencySelect.value = schedule.frequency || 'weekly';
  deliverEmailCheck.checked = !!schedule.deliverEmail;
  emailAddressInput.value = schedule.emailAddress || user.email || '';
  enabledCheck.checked = !!schedule.enabled;

  skeleton.hidden = true;
  blockedNotice.hidden = true;
  contentWrap.hidden = false;
}

scheduleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const saveBtn = document.getElementById('saveScheduleBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  const pageIds = Array.from(document.querySelectorAll('.page-check:checked')).map((c) => c.value);

  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/insights/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frequency: frequencySelect.value,
        pageIds,
        deliverEmail: deliverEmailCheck.checked,
        emailAddress: emailAddressInput.value || null,
        enabled: enabledCheck.checked,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || 'Could not save your preferences.');
    }
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save preferences';
  }
});

function renderDigest(d) {
  const div = document.createElement('div');
  div.className = 'insights-digest-card';
  const period = d.periodStart && d.periodEnd
    ? new Date(d.periodStart).toLocaleDateString() + ' – ' + new Date(d.periodEnd).toLocaleDateString()
    : 'Digest';
  const highlight = d.summary && d.summary.highlights && d.summary.highlights[0] ? d.summary.highlights[0] : '';

  const statusMap = {
    ready:      { cls: 'ready',      icon: 'ph-check-circle',  label: 'Ready' },
    generating: { cls: 'generating', icon: 'ph-circle-notch',  label: 'Generating' },
  };
  const status = statusMap[d.status] || { cls: 'failed', icon: 'ph-x-circle', label: 'Failed' };

  div.innerHTML = `
    <div class="insights-digest-head">
      <span class="insights-digest-period">${escapeHtml(period)}</span>
      <span class="insights-status insights-status--${status.cls}"><i class="ph ${status.icon}"></i> ${status.label}</span>
    </div>
    ${highlight ? `<div class="insights-digest-highlight">${escapeHtml(highlight)}</div>` : ''}
    ${d.deliveredTo && d.deliveredTo.email ? `<div class="insights-digest-delivered"><i class="ph ph-envelope-simple"></i> Emailed to ${escapeHtml(d.deliveredTo.email)}</div>` : ''}
    ${d.status === 'ready' ? `
      <div class="insights-digest-actions">
        <a class="insights-link-btn" href="${d.pdfUrl}" target="_blank" rel="noopener"><i class="ph ph-file-pdf"></i> Download PDF</a>
        <a class="insights-link-btn insights-link-btn--whatsapp" href="${d.whatsappShareUrl}" target="_blank" rel="noopener"><i class="ph ph-whatsapp-logo"></i> Share to WhatsApp</a>
      </div>
    ` : ''}
  `;
  return div;
}

async function loadHistory() {
  const res = await window.Auth.authedFetch(WORKER_URL + '/api/insights/history');
  if (!res.ok) return;
  const { digests } = await res.json();
  digestHistory.innerHTML = '';
  if (!digests.length) {
    historyEmpty.hidden = false;
  } else {
    historyEmpty.hidden = true;
    for (const d of digests) digestHistory.appendChild(renderDigest(d));
  }
}

const generateLabel = generateNowBtn.querySelector('.btn-label');

function setGenerateStatus(text, tone) {
  generateStatus.textContent = text;
  if (tone) generateStatus.dataset.tone = tone;
  else delete generateStatus.dataset.tone;
}

generateNowBtn.addEventListener('click', async () => {
  const pageIds = Array.from(document.querySelectorAll('.page-check:checked')).map((c) => c.value);
  if (!pageIds.length) {
    setGenerateStatus('Select at least one Page above first.', 'error');
    return;
  }
  generateNowBtn.disabled = true;
  if (generateLabel) generateLabel.textContent = 'Generating…';
  setGenerateStatus('This can take up to a minute…');
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/insights/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageIds, deliverEmail: deliverEmailCheck.checked, emailAddress: emailAddressInput.value || null }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setGenerateStatus(body.error || 'Could not generate your digest.', 'error');
    } else {
      setGenerateStatus('Digest ready — see it below.', 'success');
      await loadHistory();
    }
  } finally {
    generateNowBtn.disabled = false;
    if (generateLabel) generateLabel.textContent = 'Generate a digest';
  }
});

export async function mount() {
  user = await window.Auth.requireAuthOrRedirect();
  if (!user) return;
  ensureSidebarAccount();
  await loadAll();
}

async function loadAll() {
  isBlocked = false;
  const pages = await loadPages();
  if (!isBlocked) {
    await loadSchedule(pages);
    await loadHistory();
  }
}
