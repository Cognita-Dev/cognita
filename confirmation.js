// confirmation.js
// Builds the structured content of the approval card shown before a connected
// app changes anything: who, what, the key details, and what it will do.
// connector-tools.js exposes it as describeConfirmation().
//
// Rules this file keeps:
//   - Nothing secret or internal is ever shown: ids, tokens and keys are skipped.
//   - Every value is capped (140 characters, or 600 for long text).
//   - At most 6 detail rows.
//   - A tool with no hand-written entry still gets a clear card, built from its
//     arguments (see genericDetails).
// Everything returned is plain text. The browser renders it as text, never as HTML.

const MAX_VALUE = 140;
const MAX_LONG = 600;
const MAX_DETAILS = 6;

function clip(v, n) {
  const t = String(v == null ? '' : v).replace(/\s+$/g, '').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

// A detail row. Text longer than MAX_VALUE (or marked long) is shown in a
// recessed block with a "Show more" toggle.
function D(label, value, long) {
  if (value === undefined || value === null || value === '') return null;
  const text = Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
  if (!text.trim()) return null;
  const isLong = !!long || text.length > MAX_VALUE;
  return isLong ? { label, value: clip(text, MAX_LONG), long: true } : { label, value: clip(text, MAX_VALUE) };
}

const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_]?key|credential|bearer|signature/i;
const ID_KEY = /(^|_)id$|Id$|^sha$|^ref$/;

function humanize(key) {
  const spaced = String(key).replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function genericDetails(args) {
  const rows = [];
  for (const [k, v] of Object.entries(args || {})) {
    if (SECRET_KEY.test(k) || ID_KEY.test(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object' && !Array.isArray(v)) continue;
    if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) continue;
    const row = D(humanize(k), v);
    if (row) rows.push(row);
    if (rows.length >= MAX_DETAILS) break;
  }
  return rows;
}

const repoOf = (a) => (a.owner && a.repo ? a.owner + '/' + a.repo : '');
const quote = (s) => '“' + clip(s, 60) + '”';

const SEE_REPO = 'Visible to anyone who can see this repository.';

// name -> { provider key, label, verb, title(args), details(args), consequence(args) }
const TOOLS = {
  github_create_issue: {
    p: 'github', l: 'GitHub', verb: 'create',
    title: (a) => 'Open an issue in ' + repoOf(a),
    details: (a) => [D('Repository', repoOf(a)), D('Title', a.title), D('Description', a.body, true)],
    consequence: () => SEE_REPO,
  },
  github_update_issue: {
    p: 'github', l: 'GitHub', verb: 'update',
    title: (a) => 'Edit issue #' + a.number + ' in ' + repoOf(a),
    details: (a) => [D('Repository', repoOf(a)), D('New title', a.title), D('State', a.state), D('Labels', a.labels), D('New description', a.body, true)],
    consequence: () => 'This changes the issue for everyone who can see this repository.',
  },
  github_add_issue_comment: {
    p: 'github', l: 'GitHub', verb: 'post',
    title: (a) => 'Comment on #' + a.number + ' in ' + repoOf(a),
    details: (a) => [D('Repository', repoOf(a)), D('Comment', a.body, true)],
    consequence: () => SEE_REPO,
  },
  github_create_branch: {
    p: 'github', l: 'GitHub', verb: 'create',
    title: (a) => 'Create branch ' + quote(a.branch),
    details: (a) => [D('Repository', repoOf(a)), D('Branch', a.branch), D('Based on', a.from || 'the default branch')],
    consequence: () => 'This adds a new branch to the repository.',
  },
  github_create_or_update_file: {
    p: 'github', l: 'GitHub', verb: 'update',
    title: (a) => 'Save ' + quote(a.path) + ' to ' + repoOf(a),
    details: (a) => [D('Repository', repoOf(a)), D('File', a.path), D('Branch', a.branch || 'the default branch'), D('Message', a.message), D('New contents', a.content, true)],
    consequence: () => 'This saves the change to the repository as a new commit.',
  },
  github_create_or_update_files: {
    p: 'github', l: 'GitHub', verb: 'update',
    title: (a) => 'Save ' + (Array.isArray(a.files) ? a.files.length : 'several') + ' files to ' + repoOf(a),
    details: (a) => [
      D('Repository', repoOf(a)),
      D('Files', Array.isArray(a.files) ? a.files.map((f) => f && f.path).filter(Boolean) : ''),
      D('Branch', a.branch || 'the default branch'), D('Message', a.message),
    ],
    consequence: () => 'This saves all of the changes together as one new commit.',
  },
  github_create_pull_request: {
    p: 'github', l: 'GitHub', verb: 'create',
    title: (a) => 'Open a pull request in ' + repoOf(a),
    details: (a) => [D('Repository', repoOf(a)), D('Title', a.title), D('From', a.head), D('Into', a.base || 'the default branch'), D('Description', a.body, true)],
    consequence: () => SEE_REPO,
  },
  github_create_pull_request_review: {
    p: 'github', l: 'GitHub', verb: 'post',
    title: (a) => 'Review pull request #' + a.number + ' in ' + repoOf(a),
    details: (a) => [D('Repository', repoOf(a)), D('Decision', a.event === 'APPROVE' ? 'Approve' : a.event === 'REQUEST_CHANGES' ? 'Request changes' : 'Comment'), D('Comment', a.body, true)],
    consequence: () => SEE_REPO,
  },

  google_create_calendar_event: {
    p: 'calendar', l: 'Google Calendar', verb: 'create',
    title: (a) => 'Add ' + quote(a.summary) + ' to your calendar',
    details: (a) => [D('Title', a.summary), D('Starts', a.startIso), D('Ends', a.endIso), D('Where', a.location), D('Guests', a.attendees), D('Notes', a.description, true)],
    consequence: (a) => 'This adds the event to your calendar. ' + (Array.isArray(a.attendees) && a.attendees.length ? (a.notifyAttendees ? 'Guests will get an email invite.' : 'Guests will not be emailed.') : ''),
  },
  google_update_calendar_event: {
    p: 'calendar', l: 'Google Calendar', verb: 'update',
    title: (a) => 'Change a calendar event' + (a.summary ? ' to ' + quote(a.summary) : ''),
    details: (a) => [D('Title', a.summary), D('Starts', a.startIso), D('Ends', a.endIso), D('Where', a.location), D('Guests', a.attendees), D('Notes', a.description, true)],
    consequence: (a) => 'This changes the event on your calendar. ' + (a.notifyAttendees ? 'Guests will be emailed about the change.' : 'Guests will not be emailed.'),
  },
  google_delete_calendar_event: {
    p: 'calendar', l: 'Google Calendar', verb: 'delete',
    title: () => 'Cancel a calendar event',
    details: (a) => [D('Guests told', a.notifyAttendees ? 'Yes, by email' : 'No')],
    consequence: () => 'This removes the event from your calendar and cannot be undone from here.',
  },
  google_create_drive_file: {
    p: 'drive', l: 'Google Drive', verb: 'create',
    title: (a) => 'Create ' + quote(a.name) + ' in Google Drive',
    details: (a) => [D('Name', a.name), D('Type', a.asGoogleDoc ? 'Google Doc' : (a.mimeType || 'Text file')), D('Folder', a.folderId ? 'The folder you chose' : 'My Drive'), D('Contents', a.content, true)],
    consequence: () => 'This creates a new file in your Drive.',
  },
  google_create_drive_folder: {
    p: 'drive', l: 'Google Drive', verb: 'create',
    title: (a) => 'Create the folder ' + quote(a.name),
    details: (a) => [D('Name', a.name), D('Inside', a.parentFolderId ? 'The folder you chose' : 'My Drive')],
    consequence: () => 'This creates a new folder in your Drive.',
  },
  google_update_drive_file_content: {
    p: 'drive', l: 'Google Drive', verb: 'update',
    title: () => 'Replace the contents of a Drive file',
    details: (a) => [D('New contents', a.content, true)],
    consequence: () => 'This replaces everything currently in the file.',
  },
  google_rename_or_move_drive_file: {
    p: 'drive', l: 'Google Drive', verb: 'update',
    title: (a) => a.newName ? 'Rename a Drive file to ' + quote(a.newName) : 'Move a Drive file',
    details: (a) => [D('New name', a.newName), D('Moves to', a.newParentFolderId ? 'The folder you chose' : '')],
    consequence: () => 'This changes the file’s name or where it sits in your Drive.',
  },
  google_share_drive_file: {
    p: 'drive', l: 'Google Drive', verb: 'update',
    title: (a) => 'Share a Drive file with ' + clip(a.email, 60),
    details: (a) => [D('With', a.email), D('Can', a.role === 'writer' ? 'Edit' : a.role === 'commenter' ? 'Comment' : 'View'), D('Email them', a.notify ? 'Yes' : 'No')],
    consequence: () => 'This gives that person access to the file.',
  },
  google_delete_drive_file: {
    p: 'drive', l: 'Google Drive', verb: 'delete',
    title: () => 'Move a Drive file to Trash',
    details: () => [],
    consequence: () => 'This moves the file to Trash. You can restore it from Drive for 30 days.',
  },
  google_send_gmail_message: {
    p: 'gmail', l: 'Gmail', verb: 'send',
    title: (a) => 'Send an email' + (Array.isArray(a.to) && a.to[0] ? ' to ' + clip(a.to[0], 50) + (a.to.length > 1 ? ' and ' + (a.to.length - 1) + ' more' : '') : ''),
    details: (a) => [D('To', a.to), D('Cc', a.cc), D('Bcc', a.bcc), D('Subject', a.subject), D('Message', a.body, true)],
    consequence: () => 'This sends the email from your Gmail account and cannot be undone.',
  },

  canva_create_design: {
    p: 'canva', l: 'Canva', verb: 'create',
    title: (a) => 'Create ' + quote(a.title) + ' in Canva',
    details: (a) => [D('Title', a.title), D('Type', a.designType)],
    consequence: () => 'This adds a new design to your Canva account.',
  },
  facebook_create_post: {
    p: 'facebook', l: 'Facebook', verb: 'post',
    title: () => 'Post to your Facebook Page',
    details: (a) => [D('Link', a.link), D('Post', a.message, true)],
    consequence: () => 'This publishes to your Facebook Page right away.',
  },
  instagram_create_post: {
    p: 'instagram', l: 'Instagram', verb: 'post',
    title: () => 'Post to Instagram',
    details: (a) => [D('Image', a.imageUrl), D('Caption', a.caption, true)],
    consequence: () => 'This publishes to your Instagram account right away.',
  },
};

// Used when a tool has no entry above.
const FALLBACK_PROVIDERS = { github: ['github', 'GitHub'], google: ['google', 'Google'], facebook: ['facebook', 'Facebook'], canva: ['canva', 'Canva'], figma: ['figma', 'Figma'] };

function verbFromName(name) {
  if (/_delete_|_remove_/.test(name)) return 'delete';
  if (/_send_/.test(name)) return 'send';
  if (/_post|_publish/.test(name)) return 'post';
  if (/_update_|_edit_|_rename|_move|_share/.test(name)) return 'update';
  return 'create';
}

/**
 * @param {string} name       tool name
 * @param {object} args       the model's arguments (never trusted for display beyond text)
 * @param {string} [provider] provider name from connector-tools.js, for the fallback
 * @returns {{providerKey:string, providerLabel:string, verb:string, title:string,
 *            details:Array<{label:string,value:string,long?:boolean}>, consequence:string}}
 */
export function describeConfirmation(name, args, provider) {
  const a = args && typeof args === 'object' ? args : {};
  const t = TOOLS[name];
  if (t) {
    let details = [];
    try { details = t.details(a).filter(Boolean).slice(0, MAX_DETAILS); } catch (_) { details = []; }
    if (details.length === 0) details = genericDetails(a);
    let title = '';
    try { title = clip(t.title(a), 160); } catch (_) { title = ''; }
    let consequence = '';
    try { consequence = clip(t.consequence(a), 200); } catch (_) { consequence = ''; }
    return { providerKey: t.p, providerLabel: t.l, verb: t.verb, title: title || 'Make this change', details, consequence };
  }
  const fb = FALLBACK_PROVIDERS[provider] || [provider || 'app', 'a connected app'];
  const verb = verbFromName(String(name || ''));
  return {
    providerKey: fb[0],
    providerLabel: fb[1],
    verb,
    title: clip(humanize(String(name || 'action').replace(/^[a-z]+_/, '')), 160),
    details: genericDetails(a).slice(0, MAX_DETAILS),
    consequence: verb === 'delete' ? 'This removes something in ' + fb[1] + '.' : 'This makes a change in ' + fb[1] + '.',
  };
}
