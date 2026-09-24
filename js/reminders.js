// js/reminders.js
// Reminders view. Talks to /api/reminders/* only. Exports mount(), called
// once by js/router.js the first time this view is opened — same shape as
// library.js and resources.js.

import { escapeHtml, showToast, renderAccountInfo } from './shell.js';

const WORKER_URL = 'https://api.cognita.com.ng';

// Paste the public key shown by pwa/vapid-keygen.html here after you
// generate your VAPID key pair (step 4 of the upload order). This is the
// PUBLIC half only — never put the private key in a frontend file.
const VAPID_PUBLIC_KEY = 'BCa9kBjMGBoIfYt_YOsxarPBJHhVp_SvY_T5jYXAPdHaHbRqsaWZNzjT3qyBGDBs5T1zwGtEXGmXVC369-HfN4k';

const OFFSET_LABELS = {
  '1_week': '1 week before',
  '1_day': '1 day before',
  morning_of: 'On the day (morning)',
  '1_hour': '1 hour before',
  at_event: 'At the event time',
};
const TIME_ONLY_OFFSETS = new Set(['1_hour', 'at_event']);

let reminders = [];
let editingId = null; // null = creating a new reminder
let selectedChannels = { push: true, email: false };
let selectedOffsets = new Set(['1_day', 'morning_of']);

export async function mount() {
  const user = await window.Auth.requireAuthOrRedirect();
  if (!user) return;

  renderAccountInfo(user);
  wireModal();
  wireNotifications();

  await loadReminders();
  await updateNotificationUI();
}

/* ── Loading & rendering the list ── */

async function loadReminders() {
  const upcomingList = document.getElementById('remindersUpcomingList');
  const pastSection = document.getElementById('remindersPastSection');
  const pastList = document.getElementById('remindersPastList');

  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/reminders');
    if (!res.ok) {
      upcomingList.innerHTML = '<div class="my-resources-empty">Could not load reminders.</div>';
      return;
    }
    const data = await res.json();
    reminders = data.reminders || [];

    const now = Date.now();
    const upcoming = reminders.filter((r) => new Date(r.eventAt).getTime() >= now);
    const past = reminders.filter((r) => new Date(r.eventAt).getTime() < now);

    renderRows(upcomingList, upcoming, 'Nothing coming up. Tap "Add reminder" to create one.');

    if (past.length) {
      pastSection.hidden = false;
      renderRows(pastList, past.slice(0, 20), '');
    } else {
      pastSection.hidden = true;
    }
  } catch (e) {
    upcomingList.innerHTML = '<div class="my-resources-empty">Could not reach Cognita.</div>';
    console.error('[reminders] load failed:', e.message);
  }
}

function formatWhen(reminder) {
  const d = new Date(reminder.eventAt);
  const dateText = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  if (reminder.allDay) return dateText;
  const timeText = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return dateText + ' \u00b7 ' + timeText;
}

function renderRows(container, list, emptyText) {
  if (!list.length) {
    container.innerHTML = emptyText ? '<div class="my-resources-empty">' + escapeHtml(emptyText) + '</div>' : '';
    return;
  }

  container.innerHTML = list
    .map((r) => {
      const channelText = [
        r.channels && r.channels.push ? 'device' : null,
        r.channels && r.channels.email ? 'email' : null,
      ]
        .filter(Boolean)
        .join(' + ');
      return (
        '<div class="my-resource-row reminder-row" data-id="' + r.id + '">' +
        '<i class="ph ph-bell resource-icon"></i>' +
        '<div class="my-resource-info">' +
        '<div class="my-resource-title">' + escapeHtml(r.title) + '</div>' +
        '<div class="my-resource-meta">' + escapeHtml(formatWhen(r)) + (channelText ? ' \u00b7 ' + escapeHtml(channelText) : '') + '</div>' +
        '</div>' +
        '<button type="button" class="reminder-delete-btn" data-delete-id="' + r.id + '" aria-label="Delete reminder">' +
        '<i class="ph ph-trash"></i>' +
        '</button>' +
        '</div>'
      );
    })
    .join('');

  container.querySelectorAll('.reminder-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-id]')) return;
      openEditModal(row.dataset.id);
    });
  });
  container.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteReminder(btn.dataset.deleteId);
    });
  });
}

/* ── Add / edit modal ── */

function wireModal() {
  document.getElementById('remindersAddBtn').addEventListener('click', () => openCreateModal());
  document.getElementById('reminderModalClose').addEventListener('click', closeModal);
  document.getElementById('reminderModal').addEventListener('click', (e) => {
    if (e.target.id === 'reminderModal') closeModal();
  });

  document.querySelectorAll('[data-channel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const channel = btn.dataset.channel;
      selectedChannels[channel] = !selectedChannels[channel];
      if (!selectedChannels.push && !selectedChannels.email) selectedChannels[channel] = true; // must keep one
      syncChannelButtons();
    });
  });

  document.querySelectorAll('[data-offset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('is-disabled')) return;
      const offset = btn.dataset.offset;
      if (selectedOffsets.has(offset)) selectedOffsets.delete(offset);
      else selectedOffsets.add(offset);
      syncOffsetButtons();
    });
  });

  document.getElementById('reminderTimeInput').addEventListener('change', syncOffsetButtons);
  document.getElementById('reminderSaveBtn').addEventListener('click', saveReminder);
  document.getElementById('reminderDeleteBtn').addEventListener('click', () => {
    if (editingId) deleteReminder(editingId, true);
  });
}

function syncChannelButtons() {
  document.querySelectorAll('[data-channel]').forEach((btn) => {
    btn.classList.toggle('is-active', !!selectedChannels[btn.dataset.channel]);
  });
}

function syncOffsetButtons() {
  const allDay = !document.getElementById('reminderTimeInput').value;
  document.querySelectorAll('[data-offset]').forEach((btn) => {
    const offset = btn.dataset.offset;
    const disabled = allDay && TIME_ONLY_OFFSETS.has(offset);
    btn.classList.toggle('is-disabled', disabled);
    btn.classList.toggle('is-active', selectedOffsets.has(offset) && !disabled);
    if (disabled) selectedOffsets.delete(offset);
  });
}

function openCreateModal() {
  editingId = null;
  document.getElementById('reminderModalTitle').textContent = 'Add reminder';
  document.getElementById('reminderDeleteBtn').style.display = 'none';
  document.getElementById('reminderTitleInput').value = '';
  document.getElementById('reminderDateInput').value = '';
  document.getElementById('reminderTimeInput').value = '';
  document.getElementById('reminderNotesInput').value = '';
  selectedChannels = { push: true, email: false };
  selectedOffsets = new Set(['1_day', 'morning_of']);
  syncChannelButtons();
  syncOffsetButtons();
  document.getElementById('reminderModal').hidden = false;
  document.getElementById('reminderTitleInput').focus();
}

function openEditModal(id) {
  const reminder = reminders.find((r) => r.id === id);
  if (!reminder) return;
  editingId = id;

  document.getElementById('reminderModalTitle').textContent = 'Edit reminder';
  document.getElementById('reminderDeleteBtn').style.display = '';
  document.getElementById('reminderTitleInput').value = reminder.title;
  document.getElementById('reminderNotesInput').value = reminder.notes || '';

  const d = new Date(reminder.eventAt);
  const localDate = new Date(d.toLocaleString('en-US', { timeZone: reminder.timezone }));
  const pad = (n) => String(n).padStart(2, '0');
  document.getElementById('reminderDateInput').value =
    localDate.getFullYear() + '-' + pad(localDate.getMonth() + 1) + '-' + pad(localDate.getDate());
  document.getElementById('reminderTimeInput').value = reminder.allDay
    ? ''
    : pad(localDate.getHours()) + ':' + pad(localDate.getMinutes());

  selectedChannels = { ...reminder.channels };
  selectedOffsets = new Set(reminder.offsets || []);
  syncChannelButtons();
  syncOffsetButtons();

  document.getElementById('reminderModal').hidden = false;
}

function closeModal() {
  document.getElementById('reminderModal').hidden = true;
}

async function saveReminder() {
  const title = document.getElementById('reminderTitleInput').value.trim();
  const date = document.getElementById('reminderDateInput').value;
  const time = document.getElementById('reminderTimeInput').value;
  const notes = document.getElementById('reminderNotesInput').value.trim();

  if (!title) { showToast('Enter a title.'); return; }
  if (!date) { showToast('Pick a date.'); return; }

  const payload = {
    title,
    date,
    time: time || null,
    notes,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    channels: selectedChannels,
    offsets: [...selectedOffsets],
  };

  const saveBtn = document.getElementById('reminderSaveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving\u2026';

  try {
    const url = editingId ? WORKER_URL + '/api/reminders/' + editingId : WORKER_URL + '/api/reminders';
    const method = editingId ? 'PATCH' : 'POST';
    const res = await window.Auth.authedFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Could not save the reminder.');
      return;
    }

    if (data.skipped && data.skipped.length) {
      showToast('Saved. Already in the past, so not sent: ' + data.skipped.join(', '));
    } else {
      showToast('Reminder saved.');
    }

    closeModal();
    await loadReminders();
  } catch (e) {
    console.error('[reminders] save failed:', e.message);
    showToast('Could not reach Cognita.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save reminder';
  }
}

async function deleteReminder(id, fromModal = false) {
  if (!window.confirm('Delete this reminder?')) return;
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/reminders/' + id, { method: 'DELETE' });
    if (!res.ok) {
      showToast('Could not delete the reminder.');
      return;
    }
    if (fromModal) closeModal();
    showToast('Reminder deleted.');
    await loadReminders();
  } catch (e) {
    console.error('[reminders] delete failed:', e.message);
    showToast('Could not reach Cognita.');
  }
}

/* ── Notifications: support detection, permission, subscribe ── */

function isIos() {
  // iPadOS 13+ reports itself as a Mac, so also check for a touch screen.
  const iDevice = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const iPadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return (iDevice || iPadOs) && !window.MSStream;
}
function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}
function pushSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

function urlBase64ToUint8Array(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function wireNotifications() {
  const btn = document.getElementById('remindersNotifBtn');
  const popover = document.getElementById('remindersNotifPopover');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setPopoverOpen(popover.hidden); // toggle
  });
  document.getElementById('remindersEnableNotifBtn').addEventListener('click', enableNotifications);
  document.getElementById('remindersIosHintDismiss').addEventListener('click', () => setPopoverOpen(false));

  // Tap anywhere outside the popover, or press Escape, to close it.
  document.addEventListener('click', (e) => {
    if (!popover.hidden && !e.target.closest('#remindersNotifWrap')) setPopoverOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) {
      setPopoverOpen(false);
      btn.focus();
    }
  });
}

function setPopoverOpen(open) {
  document.getElementById('remindersNotifPopover').hidden = !open;
  document.getElementById('remindersNotifBtn').setAttribute('aria-expanded', String(open));
}

// One place that decides what the popover shows. Anything not passed in is
// hidden, so a state can never show leftovers from a previous one.
//   wrapVisible: whether the bell is shown at all
//   dot:         small "something to do" dot on the bell
function renderNotice({ wrapVisible, icon, dot = false, title = 'Notifications', text = '', steps = false, enable = false, gotIt = false }) {
  document.getElementById('remindersNotifWrap').hidden = !wrapVisible;
  document.getElementById('remindersNotifIcon').className = 'ph ' + icon;
  document.getElementById('remindersNotifDot').hidden = !dot;
  document.getElementById('remindersNotifTitle').textContent = title;
  document.getElementById('remindersNotifText').textContent = text;
  document.getElementById('remindersIosSteps').hidden = !steps;
  document.getElementById('remindersEnableNotifBtn').hidden = !enable;
  document.getElementById('remindersIosHintDismiss').hidden = !gotIt;
  if (!wrapVisible) setPopoverOpen(false);
}

async function updateNotificationUI() {
  // iPhone/iPad in Safari: push only works once the app is on the Home Screen.
  if (isIos() && !isStandalone()) {
    renderNotice({
      wrapVisible: true,
      icon: 'ph-bell-simple-ringing',
      dot: true,
      title: 'Get reminder notifications',
      text: 'On iPhone, add Cognita to your Home Screen first:',
      steps: true,
      gotIt: true,
    });
    return;
  }

  // Browser can't do push at all (non-iOS): nothing useful to show.
  // Reminders can still be sent by email, chosen when adding a reminder.
  if (!pushSupported()) {
    renderNotice({ wrapVisible: false, icon: 'ph-bell-slash' });
    return;
  }

  const permission = Notification.permission;

  if (permission === 'denied') {
    renderNotice({
      wrapVisible: true,
      icon: 'ph-bell-slash',
      title: 'Notifications are blocked',
      text: 'Allow notifications for Cognita in your browser\u2019s site settings, then reload this page.',
    });
    return;
  }

  let hasSubscription = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    hasSubscription = !!sub;
  } catch (_) {
    hasSubscription = false;
  }

  if (permission === 'granted' && hasSubscription) {
    renderNotice({ wrapVisible: false, icon: 'ph-bell-simple-ringing' }); // already set up — nothing to ask
    return;
  }

  const btn = document.getElementById('remindersEnableNotifBtn');
  btn.disabled = false;
  btn.textContent = 'Turn on notifications';
  renderNotice({
    wrapVisible: true,
    icon: 'ph-bell-simple-ringing',
    dot: true,
    text: 'Get notified about reminders on this device.',
    enable: true,
  });
}

async function enableNotifications() {
  const btn = document.getElementById('remindersEnableNotifBtn');
  btn.disabled = true;
  btn.textContent = 'Turning on\u2026';

  try {
    const reg = await navigator.serviceWorker.ready;
    const permission = await Notification.requestPermission(); // must be called from this click handler — iOS requires the direct user gesture
    if (permission !== 'granted') {
      await updateNotificationUI();
      return;
    }

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      if (VAPID_PUBLIC_KEY.startsWith('REPLACE_')) {
        showToast('Notifications are not configured yet.');
        return;
      }
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const subJson = sub.toJSON();
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/reminders/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys, userAgent: navigator.userAgent }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Could not turn on notifications.');
      return;
    }
    showToast('Notifications turned on.');
  } catch (e) {
    console.error('[reminders] enable notifications failed:', e.message);
    showToast('Could not turn on notifications.');
  } finally {
    await updateNotificationUI();
  }
}
