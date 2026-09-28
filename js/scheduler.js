// js/scheduler.js
// Social Scheduler view. Exports mount() (first open) and activate() (each
// later re-open). Moved out of scheduler.html with logic unchanged.

import { navigate } from './router.js';
import { ensureSidebarAccount } from './shell.js';

const WORKER_URL = 'https://api.cognita.com.ng';

let user = null;

const schedulerSkeleton = document.getElementById('schedulerSkeleton');
const blockedNotice = document.getElementById('schedulerBlockedNotice');
const blockedTitle = document.getElementById('schedulerBlockedTitle');
const blockedDesc = document.getElementById('schedulerBlockedDesc');
const composerWrap = document.getElementById('schedulerComposerWrap');
const listWrap = document.getElementById('schedulerListWrap');
const targetPageSelect = document.getElementById('targetPage');
const messageField = document.getElementById('messageField');
const mediaField = document.getElementById('mediaField');
const mediaOptionalTag = document.getElementById('mediaOptionalTag');
const linkField = document.getElementById('linkField');
const postMessage = document.getElementById('postMessage');
const postImageUrl = document.getElementById('postImageUrl');
const postLink = document.getElementById('postLink');
const postDate = document.getElementById('postDate');
const postTime = document.getElementById('postTime');
const composerError = document.getElementById('composerError');
const composerForm = document.getElementById('composerForm');
const composerSubmit = document.getElementById('composerSubmit');
const scheduledPostsGrid = document.getElementById('scheduledPostsGrid');
const blockedIcon = document.getElementById('schedulerBlockedIcon');
const blockedCta = document.getElementById('schedulerBlockedCta');
const messageCount = document.getElementById('messageCount');
const messageLabel = document.getElementById('messageLabel');
const messageHelp = document.getElementById('messageHelp');
const imageUrlFallback = document.getElementById('imageUrlFallback');
const mediaDropzoneText = document.getElementById('mediaDropzoneText');
const whenSummary = document.getElementById('whenSummary');

const POST_ROW_SKELETON = "<div class=\"settings-row\" aria-hidden=\"true\"><div class=\"settings-row-text\"><span class=\"skeleton\" style=\"display:block;width:55%;height:13px;border-radius:4px;\"></span><span class=\"skeleton\" style=\"display:block;width:80%;height:12px;border-radius:4px;margin-top:6px;\"></span></div></div>";

// Every string that came from Facebook or the server (Page names, error
// text) is escaped before going into innerHTML.
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// One place to show the blocked panel, so each cause gets the right
// icon and the right next step (upgrade vs. connect vs. retry).
function showBlocked({ title, desc, icon, ctaLabel, ctaHref, onCta }) {
  blockedTitle.textContent = title;
  blockedDesc.textContent = desc;
  blockedIcon.className = 'ph ' + icon;
  blockedCta.textContent = ctaLabel;
  blockedCta.setAttribute('href', ctaHref || '#');
  blockedCta.onclick = onCta ? (e) => { e.preventDefault(); onCta(); } : null;
  blockedNotice.hidden = false;
}


const mediaDropzone = document.getElementById('mediaDropzone');
const mediaDropzoneEmpty = document.getElementById('mediaDropzoneEmpty');
const mediaPreviewWrap = document.getElementById('mediaPreviewWrap');
const mediaPreviewImg = document.getElementById('mediaPreviewImg');
const mediaPreviewVideo = document.getElementById('mediaPreviewVideo');
const mediaPreviewName = document.getElementById('mediaPreviewName');
const mediaRemoveBtn = document.getElementById('mediaRemoveBtn');
const postMediaInput = document.getElementById('postMediaInput');
const mediaUploadProgress = document.getElementById('mediaUploadProgress');
const mediaUploadProgressBar = document.getElementById('mediaUploadProgressBar');
const mediaUploadStatus = document.getElementById('mediaUploadStatus');

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

// Populated once handleFileChosen()'s upload finishes; cleared on
// remove/replace. This — not the file input's own value — is what
// actually gets sent to /api/social/schedule.
let uploadedMedia = null; // { key, fileId, contentType, kind, size }
let uploadInFlight = false;

// Default the date/time picker to an hour from now, in the visitor's
// own local time zone — the browser's date/time inputs are always
// local, and scheduledFor is sent as a real ISO instant below.
function seedDefaultTime() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  postDate.value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  postTime.value = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const today = new Date();
  postDate.min = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
}
seedDefaultTime();

// Spells out the chosen moment in plain words, including the time zone,
// so nobody has to decode a native picker to know when the post goes out.
function updateWhenSummary() {
  const d = new Date(postDate.value + 'T' + postTime.value);
  if (isNaN(d.getTime())) { whenSummary.textContent = ''; return; }
  const day = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, ' '); } catch (_) {}
  whenSummary.textContent = 'Will publish ' + day + ' at ' + time + (zone ? ' (' + zone + ' time)' : '') + '.';
}
// ── Inline validation ────────────────────────────────────────────────
// Each problem is shown under the field it belongs to, the page scrolls to
// the first one and focuses it, and each message clears itself the moment
// the problem is fixed.
const fieldErrorEls = {};
['target', 'message', 'media', 'imageUrl', 'link', 'date', 'time'].forEach((k) => {
  fieldErrorEls[k] = document.getElementById('err-' + k);
});
const fieldControls = {
  target: targetPageSelect, message: postMessage, media: mediaDropzone,
  imageUrl: postImageUrl, link: postLink, date: postDate, time: postTime,
};
const visibleErrors = new Set();

function validate() {
  const errs = [];
  const { target, pageId } = currentTarget();
  const text = postMessage.value.trim();
  const url = postImageUrl.value.trim();
  const link = postLink.value.trim();

  if (!target || !pageId) errs.push({ key: 'target', msg: 'Choose which Page or Instagram account to post to.' });

  if (target === 'instagram') {
    if (uploadInFlight) errs.push({ key: 'media', msg: 'Your file is still uploading. Wait for it to finish, then schedule.' });
    else if (!uploadedMedia && !url) errs.push({ key: 'media', msg: 'Instagram posts need a photo or video. Upload one, or paste an image link.' });
    else if (!uploadedMedia && !/^https:\/\//i.test(url)) errs.push({ key: 'imageUrl', msg: 'The image link must start with https:// and point straight to an image.' });
  } else {
    if (uploadInFlight) errs.push({ key: 'media', msg: 'Your file is still uploading. Wait for it to finish, then schedule.' });
    let linkOk = true;
    if (link) {
      try { const u = new URL(link); linkOk = u.protocol === 'https:' || u.protocol === 'http:'; } catch (_) { linkOk = false; }
      if (!linkOk) errs.push({ key: 'link', msg: 'That isn\u2019t a valid web address. Start it with https://, for example https://yoursite.com.' });
    }
    if (!text && !uploadedMedia && !link) errs.push({ key: 'message', msg: 'Your post is empty. Write some text, or add a photo, video or link.' });
  }

  if (!postDate.value) errs.push({ key: 'date', msg: 'Choose the date to publish on.' });
  if (!postTime.value) errs.push({ key: 'time', msg: 'Choose the time to publish at.' });
  if (postDate.value && postTime.value) {
    const when = new Date(postDate.value + 'T' + postTime.value);
    if (isNaN(when.getTime())) {
      errs.push({ key: 'date', msg: 'That date and time isn\u2019t valid. Pick them again.' });
    } else if (when.getTime() < Date.now() + 60 * 1000) {
      if (postDate.value < postDate.min) errs.push({ key: 'date', msg: 'That date has already passed. Pick today or a later date.' });
      else errs.push({ key: 'time', msg: 'That time has already passed today. Pick a time at least a minute from now.' });
    }
  }
  const order = Object.keys(fieldControls);
  return errs.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

function clearFieldError(key) {
  const el = fieldErrorEls[key];
  if (el) el.hidden = true;
  const ctl = fieldControls[key];
  if (ctl) ctl.removeAttribute('aria-invalid');
  visibleErrors.delete(key);
}

function showFieldErrors(errs) {
  Object.keys(fieldErrorEls).forEach(clearFieldError);
  errs.forEach(({ key, msg }) => {
    fieldErrorEls[key].querySelector('span').textContent = msg;
    fieldErrorEls[key].hidden = false;
    fieldControls[key].setAttribute('aria-invalid', 'true');
    visibleErrors.add(key);
  });
  if (!errs.length) return;
  const first = errs[0].key;
  if (first === 'imageUrl') imageUrlFallback.open = true;
  const ctl = fieldControls[first];
  const wrapper = (ctl.closest('.scheduler-field') || ctl);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  wrapper.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  // Focus without a second, competing scroll. A hidden control (the
  // dropzone while a file is uploading) simply skips focus.
  if (!ctl.hidden) ctl.focus({ preventScroll: true });
}

// After any edit, drop the messages whose problem is now fixed. New
// problems are never shown mid-typing, only on the next submit.
function refreshErrors() {
  if (!composerError.hidden) composerError.hidden = true;
  if (!visibleErrors.size) return;
  const stillBroken = new Set(validate().map((e) => e.key));
  [...visibleErrors].forEach((k) => { if (!stillBroken.has(k)) clearFieldError(k); });
}
composerForm.addEventListener('input', refreshErrors);
composerForm.addEventListener('change', refreshErrors);

postDate.addEventListener('input', updateWhenSummary);
postTime.addEventListener('input', updateWhenSummary);
updateWhenSummary();

// Touch devices tap rather than click.
if (window.matchMedia && window.matchMedia('(hover: none)').matches) {
  mediaDropzoneText.textContent = 'Tap to choose a photo or video';
}

postMessage.addEventListener('input', () => {
  messageCount.textContent = postMessage.value.length.toLocaleString() + ' / 2,200';
});

let pages = []; // [{ id, name, instagram: { id, username } | null }]

function optionsForPages() {
  const opts = [];
  for (const p of pages) {
    opts.push({ value: 'facebook:' + p.id, label: p.name + ' — Facebook Page' });
    if (p.instagram) {
      opts.push({ value: 'instagram:' + p.id, label: p.name + ' — Instagram (@' + (p.instagram.username || p.instagram.id) + ')' });
    }
  }
  return opts;
}

function renderPagePicker() {
  const opts = optionsForPages();
  targetPageSelect.innerHTML = opts.map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('');
  updateFieldsForTarget();
}

function currentTarget() {
  const [target, pageId] = (targetPageSelect.value || '').split(':');
  return { target, pageId };
}

function updateFieldsForTarget() {
  const { target } = currentTarget();
  const isInstagram = target === 'instagram';
  linkField.hidden = isInstagram; // Facebook-only field
  // The image-URL option is only honoured for Instagram posts.
  imageUrlFallback.hidden = !isInstagram;
  messageLabel.textContent = isInstagram ? 'Caption' : 'Post text';
  messageHelp.textContent = isInstagram
    ? 'The text shown under your photo or video on Instagram. Hashtags work here.'
    : 'The words of your post. Shown above any photo, video or link.';
  postMessage.placeholder = isInstagram ? 'Write a caption…' : 'What do you want to say?';
  mediaOptionalTag.textContent = isInstagram ? '(required)' : '(optional)';
}
targetPageSelect.addEventListener('change', updateFieldsForTarget);

// ── Media upload ──────────────────────────────────────────────────────

let previewObjectUrl = null;

function resetMediaPicker() {
  if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }
  mediaDropzone.hidden = false;
  uploadedMedia = null;
  postMediaInput.value = '';
  mediaPreviewWrap.hidden = true;
  mediaDropzoneEmpty.hidden = false;
  mediaPreviewImg.hidden = true;
  mediaPreviewVideo.hidden = true;
  mediaPreviewVideo.removeAttribute('src');
  mediaUploadProgress.hidden = true;
  mediaUploadProgressBar.style.width = '0%';
  mediaUploadProgress.setAttribute('aria-valuenow', '0');
  mediaUploadStatus.textContent = '';
  if (typeof refreshErrors === 'function') refreshErrors();
}

function showLocalPreview(file, kind) {
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  const url = URL.createObjectURL(file);
  previewObjectUrl = url;
  mediaDropzone.hidden = true;
  if (kind === 'video') {
    mediaPreviewVideo.src = url;
    mediaPreviewVideo.hidden = false;
    mediaPreviewImg.hidden = true;
  } else {
    mediaPreviewImg.src = url;
    mediaPreviewImg.hidden = false;
    mediaPreviewVideo.hidden = true;
  }
  mediaPreviewName.textContent = file.name + ' (' + (file.size / (1024 * 1024)).toFixed(1) + ' MB)';
  mediaDropzoneEmpty.hidden = true;
  mediaPreviewWrap.hidden = false;
}

// Uploads with progress via XHR (fetch has no upload-progress event),
// so a multi-minute mobile-upload of a video doesn't just sit there
// looking frozen.
function uploadFile(file, kind) {
  return new Promise(async (resolve, reject) => {
    const idToken = await window.Auth.getIdToken();
    if (!idToken) { reject(new Error('Not signed in.')); return; }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', WORKER_URL + '/api/social/media?filename=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.setRequestHeader('Authorization', 'Bearer ' + idToken);

    xhr.upload.addEventListener('progress', (ev) => {
      if (!ev.lengthComputable) return;
      const pct = Math.round((ev.loaded / ev.total) * 100);
      mediaUploadProgressBar.style.width = pct + '%';
      mediaUploadProgress.setAttribute('aria-valuenow', String(pct));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (e) { reject(new Error('Upload succeeded but the response was invalid.')); }
      } else {
        let msg = 'Could not upload that file.';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
        reject(new Error(msg));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed. Check your connection and try again.')));
    xhr.send(file);
  });
}

async function handleFileChosen(file) {
  if (!file) return;
  const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : null;
  if (!kind) {
    mediaUploadStatus.textContent = 'Unsupported file type. Use JPEG, PNG, WEBP, MP4 or MOV.';
    return;
  }
  const maxBytes = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > maxBytes) {
    mediaUploadStatus.textContent = 'That file is too large (max ' + Math.round(maxBytes / (1024 * 1024)) + ' MB for ' + kind + ').';
    return;
  }

  showLocalPreview(file, kind);
  mediaUploadProgress.hidden = false;
  mediaUploadProgressBar.style.width = '0%';
  mediaUploadStatus.textContent = 'Uploading…';
  uploadInFlight = true;
  composerSubmit.disabled = true;

  try {
    const result = await uploadFile(file, kind);
    uploadedMedia = { key: result.key, fileId: result.fileId, contentType: result.contentType, kind: result.kind, size: result.size };
    mediaUploadStatus.textContent = 'Uploaded';
    mediaUploadProgress.hidden = true;
  } catch (e) {
    mediaUploadStatus.textContent = e.message || 'Upload failed.';
    resetMediaPicker();
  } finally {
    uploadInFlight = false;
    composerSubmit.disabled = false;
    refreshErrors();
  }
}

mediaDropzone.addEventListener('click', () => postMediaInput.click());
mediaDropzone.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); postMediaInput.click(); }
});
mediaDropzone.addEventListener('dragover', (ev) => { ev.preventDefault(); mediaDropzone.classList.add('scheduler-dropzone--over'); });
mediaDropzone.addEventListener('dragleave', () => mediaDropzone.classList.remove('scheduler-dropzone--over'));
mediaDropzone.addEventListener('drop', (ev) => {
  ev.preventDefault();
  mediaDropzone.classList.remove('scheduler-dropzone--over');
  const file = ev.dataTransfer.files && ev.dataTransfer.files[0];
  if (file) handleFileChosen(file);
});
postMediaInput.addEventListener('change', () => handleFileChosen(postMediaInput.files[0]));
mediaRemoveBtn.addEventListener('click', (ev) => { ev.stopPropagation(); resetMediaPicker(); });

async function loadPages() {
  blockedNotice.hidden = true;
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/social/pages');
    if (res.status === 403) {
      showBlocked({
        title: 'Social Scheduler needs a higher plan',
        desc: 'Upgrade to Cognita Plus or higher to schedule Facebook & Instagram posts.',
        icon: 'ph-lock-simple', ctaLabel: 'View plans', ctaHref: '/pricing.html',
      });
      return false;
    }
    if (res.status === 409) {
      showBlocked({
        title: "Facebook isn't connected yet",
        desc: 'Connect Facebook in Account Settings to schedule posts to a Page and its linked Instagram account.',
        icon: 'ph-plugs', ctaLabel: 'Go to Account Settings', ctaHref: '/app.html?view=account', onCta: () => navigate('account'),
      });
      return false;
    }
    if (!res.ok) throw new Error('Could not load your Facebook Pages.');
    const data = await res.json();
    pages = data.pages || [];
    if (pages.length === 0) {
      showBlocked({
        title: 'No Facebook Pages found',
        desc: "Your Facebook connection doesn't have any Pages on it yet — create or get admin access to a Page, then reconnect.",
        icon: 'ph-flag', ctaLabel: 'Go to Account Settings', ctaHref: '/app.html?view=account', onCta: () => navigate('account'),
      });
      return false;
    }
    renderPagePicker();
    return true;
  } catch (e) {
    showBlocked({
      title: 'Could not load your Facebook Pages',
      desc: (e.message || 'Something went wrong.') + ' Your scheduled posts are safe.',
      icon: 'ph-warning-circle', ctaLabel: 'Try again',
      onCta: async () => {
        schedulerSkeleton.hidden = false;
        const ok = await loadPages();
        schedulerSkeleton.hidden = true;
        if (ok) { composerWrap.hidden = false; listWrap.hidden = false; loadScheduledPosts(); }
      },
    });
    return false;
  }
}

function statusBadge(status) {
  const labels = {
    pending: 'Scheduled', publishing: 'Publishing…', published: 'Published',
    failed: 'Failed', canceled: 'Canceled', missed: 'Missed',
  };
  return '<span class="scheduler-badge scheduler-badge--' + status + '">' + (labels[status] || status) + '</span>';
}

function formatWhen(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch (e) {
    return iso;
  }
}

function mediaTag(post) {
  const kind = post.media && post.media.kind;
  if (!kind) return '';
  const icon = kind === 'video' ? 'ph-video-camera' : 'ph-image';
  return ' <i class="ph ' + icon + ' scheduler-media-icon" title="' + esc(kind) + ' attached" role="img" aria-label="' + esc(kind) + ' attached"></i>';
}

function postRowHtml(post) {
  const raw = (post.message || '');
  const preview = raw.slice(0, 80) || (post.media ? '(' + post.media.kind + ' post)' : (post.target === 'instagram' ? '(image post)' : ''));
  const truncated = raw.length > 80;
  return (
    '<div class="settings-row scheduler-post-row" data-id="' + esc(post.id) + '">' +
      '<div class="settings-row-text">' +
        '<span class="settings-row-label">' + esc(post.pageLabel) + mediaTag(post) + ' ' + statusBadge(post.status) + '</span>' +
        '<span class="scheduler-post-when">' + esc(formatWhen(post.scheduledFor)) + '</span>' +
        (preview ? '<span class="scheduler-post-preview">\u201c' + esc(preview) + (truncated ? '\u2026' : '') + '\u201d</span>' : '') +
        (post.status === 'failed' && post.lastError
          ? '<span class="scheduler-post-error"><i class="ph ph-warning-circle" aria-hidden="true"></i> ' + esc(post.lastError) + '</span>'
          : '') +
      '</div>' +
      (post.status === 'pending'
        ? '<button type="button" class="scheduler-cancel-btn" data-id="' + esc(post.id) + '" aria-label="Cancel scheduled post" title="Cancel this post"><i class="ph ph-x" aria-hidden="true"></i></button>'
        : '') +
    '</div>'
  );
}

async function loadScheduledPosts() {
  scheduledPostsGrid.setAttribute('aria-busy', 'true');
  scheduledPostsGrid.innerHTML = POST_ROW_SKELETON;
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/social/schedule');
    if (!res.ok) throw new Error('Could not load your scheduled posts.');
    const data = await res.json();
    const posts = data.posts || [];
    scheduledPostsGrid.innerHTML = posts.length
      ? posts.map(postRowHtml).join('')
      : '<div class="scheduler-list-empty"><i class="ph ph-calendar-blank" aria-hidden="true"></i><span class="scheduler-state-title">Nothing scheduled yet</span><span class="scheduler-state-desc">Posts you schedule above will appear here with their status.</span></div>';
  } catch (e) {
    scheduledPostsGrid.innerHTML = '<div class="scheduler-list-empty"><i class="ph ph-warning-circle" aria-hidden="true"></i><span class="scheduler-state-title">' + esc(e.message) + '</span><button type="button" class="scheduler-btn" id="retryPostsBtn">Try again</button></div>';
    document.getElementById('retryPostsBtn').addEventListener('click', loadScheduledPosts);
  } finally {
    scheduledPostsGrid.removeAttribute('aria-busy');
  }
}

scheduledPostsGrid.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.scheduler-cancel-btn');
  if (!btn) return;
  btn.disabled = true;
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/social/schedule/' + btn.dataset.id, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Could not cancel that post — it may have already gone out.');
    }
    showToast('Post canceled.');
    await loadScheduledPosts();
  } catch (e) {
    btn.disabled = false;
    showToast(e.message);
  }
});

composerForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  composerError.hidden = true;

  const problems = validate();
  if (problems.length) { showFieldErrors(problems); return; }
  showFieldErrors([]);

  composerSubmit.disabled = true;
  const submitLabel = composerSubmit.querySelector('.btn-label');
  submitLabel.textContent = 'Scheduling\u2026';

  try {
    const { target, pageId } = currentTarget();
    if (!target || !pageId) throw new Error('Choose where to post first.');

    const imageUrlValue = postImageUrl.value.trim();
    if (target === 'instagram' && !uploadedMedia && !imageUrlValue) {
      throw new Error('Add a photo or video, or an image URL, for an Instagram post.');
    }

    // The date/time inputs are local-time; combine and convert to a
    // real instant so the server never has to guess the visitor's zone.
    const localDate = new Date(postDate.value + 'T' + postTime.value);
    if (isNaN(localDate.getTime())) throw new Error('Pick a valid date and time.');
    if (localDate.getTime() < Date.now() + 60 * 1000) throw new Error('Pick a time in the future \u2014 that one has already passed.');
    if (target === 'facebook' && !postMessage.value.trim() && !uploadedMedia && !postLink.value.trim()) {
      throw new Error('Add some text, a photo or video, or a link to post.');
    }

    const body = {
      target, pageId,
      message: postMessage.value.trim(),
      scheduledFor: localDate.toISOString(),
    };
    if (uploadedMedia) {
      body.media = { key: uploadedMedia.key, fileId: uploadedMedia.fileId, contentType: uploadedMedia.contentType, size: uploadedMedia.size };
    } else if (target === 'instagram' && imageUrlValue) {
      body.imageUrl = imageUrlValue;
    }
    if (target === 'facebook' && postLink.value.trim()) body.link = postLink.value.trim();

    const res = await window.Auth.authedFetch(WORKER_URL + '/api/social/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not schedule that post.');

    postMessage.value = '';
    postImageUrl.value = '';
    postLink.value = '';
    messageCount.textContent = '0 / 2,200';
    resetMediaPicker();
    showToast('Post scheduled for ' + formatWhen(body.scheduledFor) + '.');
    await loadScheduledPosts();
  } catch (e) {
    composerError.textContent = e.message;
    composerError.hidden = false;
  } finally {
    composerSubmit.disabled = false;
    submitLabel.textContent = 'Schedule post';
  }
});

export async function mount() {
  user = await window.Auth.requireAuthOrRedirect();
  if (!user) return;
  ensureSidebarAccount();
  await loadAll();
}

async function loadAll() {
  const ok = await loadPages();
  schedulerSkeleton.hidden = true;
  if (ok) {
    composerWrap.hidden = false;
    listWrap.hidden = false;
    loadScheduledPosts();
  }
}

// Shown again after being away: refresh the list, and if the default
// date/time picked on first open is now in the past, re-seed it.
export function activate() {
  const pad = (n) => String(n).padStart(2, '0');
  const t = new Date();
  postDate.min = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  const picked = new Date(postDate.value + 'T' + postTime.value);
  if (isNaN(picked.getTime()) || picked.getTime() < Date.now() + 60 * 1000) {
    seedDefaultTime();
    updateWhenSummary();
  }
  if (!listWrap.hidden) loadScheduledPosts();
}
