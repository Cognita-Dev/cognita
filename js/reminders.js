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
let editingTimezone = null; // the timezone an edited reminder was saved in
let pushReady = false; // this device is fully set up to receive push
let subscriptionSynced = false;
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
    // An all-day event stays "upcoming" for the whole day (its stored time is 00:00).
    const isOver = (r) => new Date(r.eventAt).getTime() + (r.allDay ? 24 * 60 * 60 * 1000 : 0) < now;
    const byDate = (a, b) => new Date(a.eventAt) - new Date(b.eventAt);
    const upcoming = reminders.filter((r) => !isOver(r)).sort(byDate); // soonest first
    const past = reminders.filter(isOver).sort((a, b) => byDate(b, a)); // most recent first

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

// Show the date/time in the timezone the reminder was saved in, so it reads
// the same on every device (and matches what the notification will say).
function formatWhen(reminder) {
  const d = new Date(reminder.eventAt);
  const dateOpts = { day: 'numeric', month: 'short', year: 'numeric' };
  const timeOpts = { hour: '2-digit', minute: '2-digit' };
  let dateText;
  let timeText;
  try {
    dateText = d.toLocaleDateString(undefined, { ...dateOpts, timeZone: reminder.timezone });
    timeText = d.toLocaleTimeString(undefined, { ...timeOpts, timeZone: reminder.timezone });
  } catch (_) {
    // Unknown timezone name on this device: fall back to the device's own.
    dateText = d.toLocaleDateString(undefined, dateOpts);
    timeText = d.toLocaleTimeString(undefined, timeOpts);
  }
  if (reminder.allDay) return dateText;
  return dateText + ' \u00b7 ' + timeText;
}

// Reads the wall-clock date ("YYYY-MM-DD") and time ("HH:MM") of an instant
// in a given timezone, using Intl parts rather than parsing a locale string
// (which browsers format differently).
function zonedDateTimeParts(date, timeZone) {
  const make = (tz) =>
    new Intl.DateTimeFormat('en-US', {
      ...(tz ? { timeZone: tz } : {}),
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
  let parts;
  try {
    parts = make(timeZone);
  } catch (_) {
    parts = make(null);
  }
  const p = {};
  parts.forEach((x) => { p[x.type] = x.value; });
  const hour = p.hour === '24' ? '00' : p.hour; // some engines render midnight as 24
  return { date: p.year + '-' + p.month + '-' + p.day, time: hour + ':' + p.minute };
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
  editingTimezone = null;
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
  editingTimezone = reminder.timezone || null;

  document.getElementById('reminderModalTitle').textContent = 'Edit reminder';
  document.getElementById('reminderDeleteBtn').style.display = '';
  document.getElementById('reminderTitleInput').value = reminder.title;
  document.getElementById('reminderNotesInput').value = reminder.notes || '';

  const when = zonedDateTimeParts(new Date(reminder.eventAt), reminder.timezone);
  document.getElementById('reminderDateInput').value = when.date;
  document.getElementById('reminderTimeInput').value = reminder.allDay ? '' : when.time;

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
    // The form shows the reminder's own wall-clock time, so an edit must keep
    // its timezone — otherwise editing from a device in another timezone
    // would silently move the event.
    timezone: (editingId && editingTimezone) || Intl.DateTimeFormat().resolvedOptions().timeZone,
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

    let message = data.skipped && data.skipped.length
      ? 'Saved. Already in the past, so not sent: ' + data.skipped.join(', ') + '.'
      : 'Reminder saved.';
    const hint = pushHint();
    if (hint) message += ' ' + hint;
    showToast(message);

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

// If a reminder relies on device notifications but this device isn't set up
// for them, say so instead of letting it fail silently later.
function pushHint() {
  if (!selectedChannels.push || selectedChannels.email || pushReady) return '';
  if (isIos() && !isStandalone()) return 'Tap the bell at the top to set up notifications on iPhone, or add Email.';
  if (!pushSupported()) return 'This browser can\u2019t show notifications, so add Email to receive it.';
  if (Notification.permission === 'denied') return 'Notifications are blocked here. Tap the bell for help, or add Email.';
  return 'Tap the bell at the top to turn on notifications so it reaches you.';
}

// Tells the server this device (still) belongs to the signed-in person. Needed
// because a browser keeps its push subscription across sign-outs: without
// this, someone signing in on a shared device would never get their reminders
// there, and the previous person's would keep arriving. Safe to repeat.
async function syncSubscription(sub) {
  if (subscriptionSynced) return;
  subscriptionSynced = true;
  try {
    const subJson = sub.toJSON();
    await window.Auth.authedFetch(WORKER_URL + '/api/reminders/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys, userAgent: navigator.userAgent }),
    });
  } catch (e) {
    subscriptionSynced = false; // try again next time
    console.error('[reminders] subscription sync failed:', e.message);
  }
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
  pushReady = false;
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
  let currentSub = null;
  try {
    const reg = await navigator.serviceWorker.ready;
    currentSub = await reg.pushManager.getSubscription();
    hasSubscription = !!currentSub;
  } catch (_) {
    hasSubscription = false;
  }

  if (permission === 'granted' && hasSubscription) {
    pushReady = true;
    syncSubscription(currentSub); // no await: never block the page on this
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
    subscriptionSynced = true; // just registered with the server
    showToast('Notifications turned on.');
  } catch (e) {
    console.error('[reminders] enable notifications failed:', e.message);
    showToast('Could not turn on notifications.');
  } finally {
    await updateNotificationUI();
  }
}
