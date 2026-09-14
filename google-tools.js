// google-tools.js
// Tool schemas + executors for the Google connector: Calendar, Drive, and
// Gmail. Scoped to the OAuth scopes granted in connector-providers.js —
// narrowed (2026-09) to only scopes Google does NOT classify as
// "restricted" (see https://support.google.com/cloud/answer/13464325),
// so this app never has to go through Google's CASA security assessment:
//   - calendar.events + calendar.readonly → full read/write on events
//     across any calendar the user can see, plus listing the calendars
//     themselves. Sensitive scope (needs OAuth verification) but NOT
//     restricted — no CASA. Unchanged from before.
//   - drive.file          → read/write ONLY on files this app itself
//     created (there is no Picker flow here for the user to hand it
//     pre-existing files). This is a real capability cut from the old
//     bare 'drive' scope: Cognita can no longer list, search, read, or
//     write a user's pre-existing Drive files — only ones Cognita made.
//     Non-sensitive, no verification and no CASA at all.
//   - gmail.send + gmail.labels → send mail, and manage label
//     *definitions* (create/list/rename/delete a label itself). This is
//     a real capability cut: reading mail, searching mail, creating
//     drafts, applying/removing a label on a message, and trashing a
//     message all require gmail.modify/gmail.compose/gmail.readonly,
//     which are restricted scopes — those tools have been removed
//     entirely (see REMOVED note below). gmail.send is sensitive
//     (verification only); gmail.labels is non-sensitive (no
//     verification at all).
//
// REMOVED (2026-09, restricted-scope cleanup) — do not re-add without
// also re-widening the scope list above and accepting the CASA
// requirement: google_search_gmail_messages, google_get_gmail_message,
// google_get_gmail_thread, google_create_gmail_draft,
// google_modify_gmail_message_labels, google_trash_gmail_message.
//
// Actions exposed:
//   Read-only (safe to run immediately, no confirmation):
//     Calendar : google_list_calendars, google_list_calendar_events,
//                google_search_calendar_events, google_get_calendar_event
//     Drive    : google_list_drive_files, google_search_drive_files,
//                google_get_drive_file, google_read_drive_file_content
//                (all four now implicitly limited to Cognita-created files
//                by the drive.file scope itself, not by any code here)
//     Gmail    : google_list_gmail_labels
//   Write (always require explicit user confirmation before execute() is
//   called; see REQUIRES_CONFIRMATION and the confirmToolCall flow in
//   chat-endpoint.js):
//     Calendar : google_create_calendar_event, google_update_calendar_event,
//                google_delete_calendar_event
//     Drive    : google_create_drive_file, google_create_drive_folder,
//                google_update_drive_file_content, google_rename_or_move_drive_file,
//                google_share_drive_file, google_delete_drive_file
//     Gmail    : google_send_gmail_message
//
// Deliberate safety choices:
//   - google_delete_drive_file trashes (recoverable in Drive's Trash for
//     30 days), it never calls the permanent-delete endpoint.
//   - Calendar/Gmail writes default to NOT notifying other people
//     (sendUpdates='none' / no auto-CC) unless the model is explicitly
//     told to notify — a silent write is safer than an accidental email
//     blast, and the model can always opt in via the relevant arg.
//
// Same TOOLS/REQUIRES_CONFIRMATION/describe/execute/approvalScope shape
// as github-tools.js — see that file's header comment for the contract.

import { getValidToken } from './connectors.js';

const MAX_CONTENT_CHARS = 300_000;   // soft cap on Drive file content read/write, mirrors github-tools.js
const MAX_EMAIL_BODY_CHARS = 100_000; // generous cap for a composed email body
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ─────────────────────────── TOOL SCHEMAS ───────────────────────────

export const TOOLS = [
  // ── Calendar: read ──
  {
    type: 'function',
    function: {
      name: 'google_list_calendars',
      description: "Lists every calendar the user can see (not just their primary one) — id, name, whether it's their primary calendar, and their access role on it. Use this before reading/writing events on a non-primary calendar, since every other calendar tool takes a calendarId.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_list_calendar_events',
      description: "Lists the user's upcoming events within a given number of days from now, on a given calendar (default: primary). Use this to answer 'what's on my calendar this week'.",
      parameters: {
        type: 'object',
        properties: {
          calendarId: { type: 'string', description: "Calendar id from google_list_calendars, or 'primary' (default)." },
          daysAhead: { type: 'integer', description: 'How many days ahead to look (default 7, max 60).' },
          maxResults: { type: 'integer', description: 'Max events to return (default 10, max 50).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_search_calendar_events',
      description: 'Searches events by free-text query (matches title/description/location/attendees) within an optional time window. Use this for "when is my dentist appointment" style questions, instead of listing everything and scanning.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text search, e.g. "dentist" or "team standup".' },
          calendarId: { type: 'string', description: "Calendar id, or 'primary' (default)." },
          timeMinIso: { type: 'string', description: 'Optional lower bound, ISO 8601. Defaults to 90 days ago.' },
          timeMaxIso: { type: 'string', description: 'Optional upper bound, ISO 8601. Defaults to 180 days from now.' },
          maxResults: { type: 'integer', description: 'Max results (default 10, max 50).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_get_calendar_event',
      description: 'Gets full details of one event by id: title, description, location, start/end, attendees and their response status, recurrence, and the event link.',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'The event id (from a list/search/create result).' },
          calendarId: { type: 'string', description: "Calendar id, or 'primary' (default)." },
        },
        required: ['eventId'],
      },
    },
  },
  // ── Calendar: write ──
  {
    type: 'function',
    function: {
      name: 'google_create_calendar_event',
      description: "Creates a new event. This changes the user's calendar, so it always requires the user's explicit confirmation first. Does NOT email attendees unless notifyAttendees=true is explicitly set.",
      parameters: {
        type: 'object',
        properties: {
          calendarId: { type: 'string', description: "Calendar id, or 'primary' (default)." },
          summary: { type: 'string', description: 'Event title.' },
          description: { type: 'string', description: 'Event description. Optional.' },
          location: { type: 'string', description: 'Event location. Optional.' },
          startIso: { type: 'string', description: 'Start time, ISO 8601 with timezone offset, e.g. 2026-09-20T14:00:00+01:00. For all-day events, use YYYY-MM-DD instead.' },
          endIso: { type: 'string', description: 'End time, same format as startIso.' },
          timeZone: { type: 'string', description: "IANA timezone, e.g. 'Africa/Lagos'. Only needed if startIso/endIso have no offset." },
          attendees: {
            type: 'array', items: { type: 'string' },
            description: 'Attendee email addresses. Optional.',
          },
          recurrence: {
            type: 'array', items: { type: 'string' },
            description: "RFC5545 RRULE strings, e.g. ['RRULE:FREQ=WEEKLY;COUNT=10']. Optional.",
          },
          notifyAttendees: { type: 'boolean', description: 'Send an email invite to attendees. Default false (silent add).' },
        },
        required: ['summary', 'startIso', 'endIso'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_update_calendar_event',
      description: "Updates one or more fields of an existing event (partial update — only send the fields that are changing). Always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'The event id to update.' },
          calendarId: { type: 'string', description: "Calendar id, or 'primary' (default)." },
          summary: { type: 'string' },
          description: { type: 'string' },
          location: { type: 'string' },
          startIso: { type: 'string', description: 'New start time, ISO 8601. Omit to leave unchanged.' },
          endIso: { type: 'string', description: 'New end time, ISO 8601. Omit to leave unchanged.' },
          timeZone: { type: 'string' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'Replaces the full attendee list if provided.' },
          notifyAttendees: { type: 'boolean', description: 'Email attendees about the change. Default false.' },
        },
        required: ['eventId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_delete_calendar_event',
      description: "Deletes (cancels) an event. This cannot be undone by the app. Always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'The event id to delete.' },
          calendarId: { type: 'string', description: "Calendar id, or 'primary' (default)." },
          notifyAttendees: { type: 'boolean', description: 'Email attendees that the event was cancelled. Default false.' },
        },
        required: ['eventId'],
      },
    },
  },

  // ── Drive: read ──
  {
    type: 'function',
    function: {
      name: 'google_list_drive_files',
      description: "Lists Drive files this app has created, most recently modified first (the drive.file scope means pre-existing files the user never created via Cognita are not visible here). Optionally filter by folder or MIME type. Use google_search_drive_files instead when looking for files by name/content keyword.",
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: 'Only list files directly inside this folder id. Optional.' },
          mimeType: { type: 'string', description: "Exact MIME type filter, e.g. 'application/vnd.google-apps.spreadsheet' or 'application/pdf'. Optional." },
          maxResults: { type: 'integer', description: 'Max files to return (default 20, max 100).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_search_drive_files',
      description: "Searches this app's own Drive files by keyword, matching file name and (for Google Docs/Sheets/Slides and other indexed types) file content. Only finds files Cognita itself created — the drive.file scope does not allow searching a user's pre-existing Drive files. Use this for 'find the file I made with you about X' style requests.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Keyword(s) to search for. Alternatively, a raw Drive API 'q' query string for advanced use (e.g. \"mimeType='application/pdf' and modifiedTime > '2026-01-01T00:00:00'\") — pass it as-is and it will be used unmodified." },
          maxResults: { type: 'integer', description: 'Max results (default 20, max 100).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_get_drive_file',
      description: 'Gets metadata for one file: name, MIME type, size, owners, last modified time, parent folder(s), and a web link. Use this to confirm a file exists or check its type before reading/updating it.',
      parameters: {
        type: 'object',
        properties: { fileId: { type: 'string', description: 'The Drive file id.' } },
        required: ['fileId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_read_drive_file_content',
      description: "Reads a file's text content. Google Docs/Sheets/Slides are automatically exported as plain text/CSV. Plain-text file types (txt, md, csv, json, code files, etc.) are read directly. Binary files (images, zips, non-Google-Docs PDFs, etc.) cannot be read this way — the tool will say so and return the file's metadata/link instead.",
      parameters: {
        type: 'object',
        properties: { fileId: { type: 'string', description: 'The Drive file id.' } },
        required: ['fileId'],
      },
    },
  },
  // ── Drive: write ──
  {
    type: 'function',
    function: {
      name: 'google_create_drive_file',
      description: "Creates a new file with the given text content. Set asGoogleDoc=true to create it as a native Google Doc (converted from the text) instead of a plain text file — useful when the user wants something they can open and edit in Google Docs. Always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "File name, e.g. 'Notes.txt' or 'Meeting Notes' (extension not needed if asGoogleDoc=true)." },
          content: { type: 'string', description: 'The text content of the file.' },
          folderId: { type: 'string', description: 'Parent folder id to create the file inside. Optional — defaults to My Drive root.' },
          mimeType: { type: 'string', description: "MIME type of the content itself, e.g. 'text/plain' (default), 'text/markdown', 'text/csv'." },
          asGoogleDoc: { type: 'boolean', description: 'Convert the content into a native Google Doc on creation. Default false.' },
        },
        required: ['name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_create_drive_folder',
      description: "Creates a new Drive folder. Always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Folder name.' },
          parentFolderId: { type: 'string', description: 'Parent folder id. Optional — defaults to My Drive root.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_update_drive_file_content',
      description: "Overwrites an existing plain-text-type file's content entirely (not a merge/append). Does not work on native Google Docs/Sheets/Slides (their content isn't a flat text stream) — for those, tell the user to edit in the Google app directly. Always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'The Drive file id to overwrite.' },
          content: { type: 'string', description: 'The new full content, replacing everything currently in the file.' },
          mimeType: { type: 'string', description: "MIME type of the new content, e.g. 'text/plain' (default)." },
        },
        required: ['fileId', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_rename_or_move_drive_file',
      description: "Renames a file and/or moves it to a different folder. Provide newName and/or newParentFolderId — only the fields provided are changed. Always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'The Drive file id.' },
          newName: { type: 'string', description: 'New file name. Optional.' },
          newParentFolderId: { type: 'string', description: 'Move the file into this folder id. Optional.' },
        },
        required: ['fileId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_share_drive_file',
      description: "Shares a file with an email address at a given role. Always requires the user's explicit confirmation first, since it grants another person access.",
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'The Drive file id.' },
          email: { type: 'string', description: 'Email address to share with.' },
          role: { type: 'string', enum: ['reader', 'commenter', 'writer'], description: "Access level. Default 'reader'." },
          notify: { type: 'boolean', description: 'Send that person a notification email. Default false.' },
        },
        required: ['fileId', 'email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_delete_drive_file',
      description: "Moves a file to Trash (recoverable for 30 days — this never permanently deletes). Always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: { fileId: { type: 'string', description: 'The Drive file id to trash.' } },
        required: ['fileId'],
      },
    },
  },

  // ── Gmail: read ──
  {
    type: 'function',
    function: {
      name: 'google_list_gmail_labels',
      description: "Lists the user's Gmail labels (system ones like INBOX/UNREAD/STARRED/IMPORTANT/SPAM/TRASH, plus any custom labels), with each label's id and type.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // ── Gmail: write ──
  {
    type: 'function',
    function: {
      name: 'google_send_gmail_message',
      description: "Sends a new standalone email immediately from the user's Gmail account. Always requires the user's explicit confirmation first — show the user the recipient, subject, and body before calling this. This always starts a new conversation thread — there is no reply-in-existing-thread option, since that requires reading the original message's headers (a restricted Gmail scope this app does not request).",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient email address(es).' },
          cc: { type: 'array', items: { type: 'string' }, description: 'Cc address(es). Optional.' },
          bcc: { type: 'array', items: { type: 'string' }, description: 'Bcc address(es). Optional.' },
          subject: { type: 'string', description: 'Email subject.' },
          body: { type: 'string', description: 'Plain-text email body.' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
];

// Sub-groups the 19 Google tools by domain (calendar/drive/gmail), used
// only by connector-tools.js's tool router (see ROUTER_THRESHOLD there)
// to narrow "the user connected Google" down to "the user is asking
// about their calendar" once the total tool count gets large enough that
// narrowing is worth the risk of narrowing wrong. Not part of the
// OpenAI-compatible schema — purely internal routing metadata.
export const TOOL_DOMAINS = {
  calendar: [
    'google_list_calendars', 'google_list_calendar_events', 'google_search_calendar_events',
    'google_get_calendar_event', 'google_create_calendar_event', 'google_update_calendar_event',
    'google_delete_calendar_event',
  ],
  drive: [
    'google_list_drive_files', 'google_search_drive_files', 'google_get_drive_file',
    'google_read_drive_file_content', 'google_create_drive_file', 'google_create_drive_folder',
    'google_update_drive_file_content', 'google_rename_or_move_drive_file', 'google_share_drive_file',
    'google_delete_drive_file',
  ],
  gmail: [
    'google_list_gmail_labels', 'google_send_gmail_message',
  ],
};

export const REQUIRES_CONFIRMATION = [
  'google_create_calendar_event', 'google_update_calendar_event', 'google_delete_calendar_event',
  'google_create_drive_file', 'google_create_drive_folder', 'google_update_drive_file_content',
  'google_rename_or_move_drive_file', 'google_share_drive_file', 'google_delete_drive_file',
  'google_send_gmail_message',
];

export function describe(name, args) {
  switch (name) {
    case 'google_list_calendars': return 'Listing your Google calendars.';
    case 'google_list_calendar_events': return 'Checking your upcoming calendar events.';
    case 'google_search_calendar_events': return 'Searching your calendar for "' + (args.query || '') + '".';
    case 'google_get_calendar_event': return 'Looking up a calendar event.';
    case 'google_create_calendar_event': return 'Adding "' + (args.summary || 'an event') + '" to your calendar.';
    case 'google_update_calendar_event': return 'Updating a calendar event.';
    case 'google_delete_calendar_event': return 'Deleting a calendar event.';
    case 'google_list_drive_files': return 'Listing your Drive files.';
    case 'google_search_drive_files': return 'Searching Drive for "' + (args.query || '') + '".';
    case 'google_get_drive_file': return 'Looking up a Drive file.';
    case 'google_read_drive_file_content': return 'Reading a Drive file.';
    case 'google_create_drive_file': return 'Creating "' + (args.name || 'a file') + '" in Drive.';
    case 'google_create_drive_folder': return 'Creating the folder "' + (args.name || '') + '" in Drive.';
    case 'google_update_drive_file_content': return 'Overwriting a Drive file\'s content.';
    case 'google_rename_or_move_drive_file': return 'Renaming/moving a Drive file.';
    case 'google_share_drive_file': return 'Sharing a Drive file with ' + (args.email || 'someone') + '.';
    case 'google_delete_drive_file': return 'Moving a Drive file to Trash.';
    case 'google_list_gmail_labels': return 'Listing your Gmail labels.';
    case 'google_send_gmail_message': return 'Sending an email to ' + (Array.isArray(args.to) ? args.to.join(', ') : args.to || 'someone') + '.';
    default: return 'Working in your Google account.';
  }
}

// Per-domain (+ per-object where one exists) approval scoping, so
// approving "send an email" never silently approves "delete a Drive
// file" — mirrors github-tools.js's per-repo scoping, one level up.
export function approvalScope(name, args) {
  if (name.startsWith('google_') && name.includes('calendar')) return 'calendar:' + (args.calendarId || 'primary');
  if (name.includes('drive_file')) {
    if (name === 'google_create_drive_file' || name === 'google_create_drive_folder') return 'drive:create';
    return 'drive:' + (args.fileId || 'unscoped');
  }
  if (name === 'google_send_gmail_message') return 'gmail:compose';
  if (name.includes('gmail')) return 'gmail:unscoped';
  return 'google:unscoped';
}

// ─────────────────────────── HELPERS ───────────────────────────

async function _apiFetch(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('NEEDS_RECONNECT');
    if (res.status === 404) throw new Error('Not found (404): the id given does not exist or is not accessible to this account.');
    if (res.status === 403) throw new Error('Permission denied (403) — the connected Google account does not have access to this, or the grant needs to be widened by reconnecting. Details: ' + text.slice(0, 200));
    throw new Error('Google API error (' + res.status + '): ' + text.slice(0, 300));
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function _escapeDriveQueryValue(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function _base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// NOTE: _base64UrlDecodeToText, _extractGmailBody, _gmailHeader, and
// _summarizeGmailMessage were removed 2026-09 along with the Gmail
// read/draft/label/trash tools that used them (restricted-scope
// cleanup — see file header). _base64UrlEncode below is still needed
// for building the outgoing MIME message in _sendGmailMessage.

function _buildMimeMessage({ to, cc, bcc, subject, body, inReplyToRfc822Id }) {
  if (String(body || '').length > MAX_EMAIL_BODY_CHARS) {
    throw new Error('Email body is too long (' + body.length + ' chars, max ' + MAX_EMAIL_BODY_CHARS + ').');
  }
  const lines = [
    'To: ' + (Array.isArray(to) ? to.join(', ') : to),
    cc && cc.length ? 'Cc: ' + (Array.isArray(cc) ? cc.join(', ') : cc) : null,
    bcc && bcc.length ? 'Bcc: ' + (Array.isArray(bcc) ? bcc.join(', ') : bcc) : null,
    'Subject: ' + (subject || '(no subject)'),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    inReplyToRfc822Id ? 'In-Reply-To: ' + inReplyToRfc822Id : null,
    inReplyToRfc822Id ? 'References: ' + inReplyToRfc822Id : null,
    '',
    body || '',
  ].filter((l) => l !== null);
  return lines.join('\r\n');
}

// ─────────────────────────── CALENDAR ───────────────────────────

async function _listCalendars(uid, args, env) {
  const token = await getValidToken(uid, 'google', env);
  const data = await _apiFetch(token, CALENDAR_BASE + '/users/me/calendarList', { method: 'GET' });
  return (data.items || []).map((c) => ({
    id: c.id, summary: c.summary, primary: !!c.primary, accessRole: c.accessRole,
  }));
}

async function _listCalendarEvents(uid, args, env) {
  const token = await getValidToken(uid, 'google', env);
  const calendarId = encodeURIComponent(args.calendarId || 'primary');
  const daysAhead = Math.min(Math.max(parseInt(args.daysAhead, 10) || 7, 1), 60);
  const maxResults = Math.min(Math.max(parseInt(args.maxResults, 10) || 10, 1), 50);
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({ timeMin, timeMax, maxResults: String(maxResults), singleEvents: 'true', orderBy: 'startTime' });
  const data = await _apiFetch(token, CALENDAR_BASE + '/calendars/' + calendarId + '/events?' + params.toString(), { method: 'GET' });
  return (data.items || []).map(_formatEvent);
}

async function _searchCalendarEvents(uid, args, env) {
  if (!args.query) throw new Error('query is required.');
  const token = await getValidToken(uid, 'google', env);
  const calendarId = encodeURIComponent(args.calendarId || 'primary');
  const maxResults = Math.min(Math.max(parseInt(args.maxResults, 10) || 10, 1), 50);
  const timeMin = args.timeMinIso || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = args.timeMaxIso || new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({ q: args.query, timeMin, timeMax, maxResults: String(maxResults), singleEvents: 'true', orderBy: 'startTime' });
  const data = await _apiFetch(token, CALENDAR_BASE + '/calendars/' + calendarId + '/events?' + params.toString(), { method: 'GET' });
  return (data.items || []).map(_formatEvent);
}

async function _getCalendarEvent(uid, args, env) {
  if (!args.eventId) throw new Error('eventId is required.');
  const token = await getValidToken(uid, 'google', env);
  const calendarId = encodeURIComponent(args.calendarId || 'primary');
  const ev = await _apiFetch(token, CALENDAR_BASE + '/calendars/' + calendarId + '/events/' + encodeURIComponent(args.eventId), { method: 'GET' });
  return _formatEvent(ev, true);
}

function _formatEvent(ev, full = false) {
  const base = {
    id: ev.id,
    summary: ev.summary || '(no title)',
    start: ev.start?.dateTime || ev.start?.date || null,
    end: ev.end?.dateTime || ev.end?.date || null,
    location: ev.location || null,
    link: ev.htmlLink || null,
    status: ev.status || null,
  };
  if (!full) return base;
  return {
    ...base,
    description: ev.description || null,
    attendees: (ev.attendees || []).map((a) => ({ email: a.email, responseStatus: a.responseStatus })),
    recurrence: ev.recurrence || null,
    creator: ev.creator?.email || null,
  };
}

function _isAllDay(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''));
}
function _timeField(iso, timeZone) {
  if (_isAllDay(iso)) return { date: iso };
  return timeZone ? { dateTime: iso, timeZone } : { dateTime: iso };
}

async function _createCalendarEvent(uid, args, env) {
  if (!args.summary || !args.startIso || !args.endIso) {
    throw new Error('summary, startIso, and endIso are all required to create an event.');
  }
  const token = await getValidToken(uid, 'google', env);
  const calendarId = encodeURIComponent(args.calendarId || 'primary');
  const sendUpdates = args.notifyAttendees ? 'all' : 'none';
  const body = {
    summary: args.summary,
    description: args.description || '',
    location: args.location || undefined,
    start: _timeField(args.startIso, args.timeZone),
    end: _timeField(args.endIso, args.timeZone),
    attendees: Array.isArray(args.attendees) ? args.attendees.map((email) => ({ email })) : undefined,
    recurrence: Array.isArray(args.recurrence) ? args.recurrence : undefined,
  };
  const event = await _apiFetch(token, CALENDAR_BASE + '/calendars/' + calendarId + '/events?sendUpdates=' + sendUpdates, {
    method: 'POST', body: JSON.stringify(body),
  });
  return { id: event.id, link: event.htmlLink, summary: event.summary };
}

async function _updateCalendarEvent(uid, args, env) {
  if (!args.eventId) throw new Error('eventId is required.');
  const token = await getValidToken(uid, 'google', env);
  const calendarId = encodeURIComponent(args.calendarId || 'primary');
  const sendUpdates = args.notifyAttendees ? 'all' : 'none';
  const patch = {};
  if (args.summary !== undefined) patch.summary = args.summary;
  if (args.description !== undefined) patch.description = args.description;
  if (args.location !== undefined) patch.location = args.location;
  if (args.startIso !== undefined) patch.start = _timeField(args.startIso, args.timeZone);
  if (args.endIso !== undefined) patch.end = _timeField(args.endIso, args.timeZone);
  if (Array.isArray(args.attendees)) patch.attendees = args.attendees.map((email) => ({ email }));
  if (Object.keys(patch).length === 0) throw new Error('No fields provided to update.');
  const event = await _apiFetch(token, CALENDAR_BASE + '/calendars/' + calendarId + '/events/' + encodeURIComponent(args.eventId) + '?sendUpdates=' + sendUpdates, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  return { id: event.id, link: event.htmlLink, summary: event.summary };
}

async function _deleteCalendarEvent(uid, args, env) {
  if (!args.eventId) throw new Error('eventId is required.');
  const token = await getValidToken(uid, 'google', env);
  const calendarId = encodeURIComponent(args.calendarId || 'primary');
  const sendUpdates = args.notifyAttendees ? 'all' : 'none';
  await _apiFetch(token, CALENDAR_BASE + '/calendars/' + calendarId + '/events/' + encodeURIComponent(args.eventId) + '?sendUpdates=' + sendUpdates, { method: 'DELETE' });
  return { deleted: true, eventId: args.eventId };
}

// ─────────────────────────── DRIVE ───────────────────────────

const _DRIVE_FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,parents,owners(displayName,emailAddress)';

async function _listDriveFiles(uid, args, env) {
  const token = await getValidToken(uid, 'google', env);
  const maxResults = Math.min(Math.max(parseInt(args.maxResults, 10) || 20, 1), 100);
  const clauses = ['trashed = false'];
  if (args.folderId) clauses.push("'" + _escapeDriveQueryValue(args.folderId) + "' in parents");
  if (args.mimeType) clauses.push("mimeType = '" + _escapeDriveQueryValue(args.mimeType) + "'");
  const params = new URLSearchParams({
    q: clauses.join(' and '),
    orderBy: 'modifiedTime desc',
    pageSize: String(maxResults),
    fields: 'files(' + _DRIVE_FILE_FIELDS + ')',
  });
  const data = await _apiFetch(token, DRIVE_BASE + '/files?' + params.toString(), { method: 'GET' });
  return data.files || [];
}

async function _searchDriveFiles(uid, args, env) {
  if (!args.query) throw new Error('query is required.');
  const token = await getValidToken(uid, 'google', env);
  const maxResults = Math.min(Math.max(parseInt(args.maxResults, 10) || 20, 1), 100);
  // If it already looks like a Drive API query (has an operator like '=' or
  // 'contains'), trust it verbatim; otherwise treat it as a plain keyword.
  const looksLikeQuerySyntax = /(=|contains|in\s+parents|>|<)/.test(args.query);
  const q = looksLikeQuerySyntax
    ? args.query
    : "(name contains '" + _escapeDriveQueryValue(args.query) + "' or fullText contains '" + _escapeDriveQueryValue(args.query) + "') and trashed = false";
  const params = new URLSearchParams({
    q, orderBy: 'modifiedTime desc', pageSize: String(maxResults),
    fields: 'files(' + _DRIVE_FILE_FIELDS + ')',
  });
  const data = await _apiFetch(token, DRIVE_BASE + '/files?' + params.toString(), { method: 'GET' });
  return data.files || [];
}

async function _getDriveFile(uid, args, env) {
  if (!args.fileId) throw new Error('fileId is required.');
  const token = await getValidToken(uid, 'google', env);
  return _apiFetch(token, DRIVE_BASE + '/files/' + encodeURIComponent(args.fileId) + '?fields=' + encodeURIComponent(_DRIVE_FILE_FIELDS), { method: 'GET' });
}

const _GOOGLE_EXPORT_MIME = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

async function _readDriveFileContent(uid, args, env) {
  if (!args.fileId) throw new Error('fileId is required.');
  const token = await getValidToken(uid, 'google', env);
  const meta = await _apiFetch(token, DRIVE_BASE + '/files/' + encodeURIComponent(args.fileId) + '?fields=' + encodeURIComponent(_DRIVE_FILE_FIELDS), { method: 'GET' });

  const exportMime = _GOOGLE_EXPORT_MIME[meta.mimeType];
  const url = exportMime
    ? DRIVE_BASE + '/files/' + encodeURIComponent(args.fileId) + '/export?mimeType=' + encodeURIComponent(exportMime)
    : DRIVE_BASE + '/files/' + encodeURIComponent(args.fileId) + '?alt=media';

  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    if (res.status === 401) throw new Error('NEEDS_RECONNECT');
    const text = await res.text().catch(() => '');
    throw new Error('Could not read file content (' + res.status + '): ' + text.slice(0, 200));
  }
  const isTextLike = exportMime || /^text\//.test(meta.mimeType || '') || /json|xml|csv/.test(meta.mimeType || '');
  if (!isTextLike) {
    return {
      readable: false,
      reason: "This file's MIME type (" + meta.mimeType + ') is binary and cannot be shown as text.',
      name: meta.name, mimeType: meta.mimeType, webViewLink: meta.webViewLink,
    };
  }
  let content = await res.text();
  let truncated = false;
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS);
    truncated = true;
  }
  return { readable: true, name: meta.name, mimeType: meta.mimeType, content, truncated };
}

function _multipartBody(metadata, content, mimeType) {
  const boundary = 'cognita-boundary-' + Math.random().toString(36).slice(2);
  const body =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + (mimeType || 'text/plain') + '\r\n\r\n' +
    content + '\r\n' +
    '--' + boundary + '--';
  return { body, contentType: 'multipart/related; boundary=' + boundary };
}

async function _createDriveFile(uid, args, env) {
  if (!args.name || args.content === undefined) throw new Error('name and content are both required.');
  if (String(args.content).length > MAX_CONTENT_CHARS) {
    throw new Error('File content is too large (' + args.content.length + ' chars, max ' + MAX_CONTENT_CHARS + ').');
  }
  const token = await getValidToken(uid, 'google', env);
  const metadata = {
    name: args.name,
    parents: args.folderId ? [args.folderId] : undefined,
    mimeType: args.asGoogleDoc ? 'application/vnd.google-apps.document' : undefined,
  };
  const { body, contentType } = _multipartBody(metadata, args.content, args.mimeType || 'text/plain');
  const file = await _apiFetch(token, DRIVE_UPLOAD_BASE + '/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST', headers: { 'Content-Type': contentType }, body,
  });
  return { id: file.id, name: file.name, link: file.webViewLink };
}

async function _createDriveFolder(uid, args, env) {
  if (!args.name) throw new Error('name is required.');
  const token = await getValidToken(uid, 'google', env);
  const folder = await _apiFetch(token, DRIVE_BASE + '/files?fields=id,name,webViewLink', {
    method: 'POST',
    body: JSON.stringify({
      name: args.name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: args.parentFolderId ? [args.parentFolderId] : undefined,
    }),
  });
  return { id: folder.id, name: folder.name, link: folder.webViewLink };
}

async function _updateDriveFileContent(uid, args, env) {
  if (!args.fileId || args.content === undefined) throw new Error('fileId and content are both required.');
  if (String(args.content).length > MAX_CONTENT_CHARS) {
    throw new Error('File content is too large (' + args.content.length + ' chars, max ' + MAX_CONTENT_CHARS + ').');
  }
  const token = await getValidToken(uid, 'google', env);
  const meta = await _apiFetch(token, DRIVE_BASE + '/files/' + encodeURIComponent(args.fileId) + '?fields=mimeType,name', { method: 'GET' });
  if (String(meta.mimeType || '').startsWith('application/vnd.google-apps.')) {
    throw new Error('"' + meta.name + '" is a native Google Doc/Sheet/Slide (' + meta.mimeType + ') — its content cannot be overwritten via this tool. Ask the user to edit it directly in Google Docs/Sheets/Slides.');
  }
  const res = await fetch(DRIVE_UPLOAD_BASE + '/files/' + encodeURIComponent(args.fileId) + '?uploadType=media', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': args.mimeType || 'text/plain' },
    body: args.content,
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error('NEEDS_RECONNECT');
    const text = await res.text().catch(() => '');
    throw new Error('Could not update file content (' + res.status + '): ' + text.slice(0, 200));
  }
  const updated = await res.json();
  return { id: updated.id, name: meta.name, updated: true };
}

async function _renameOrMoveDriveFile(uid, args, env) {
  if (!args.fileId) throw new Error('fileId is required.');
  if (!args.newName && !args.newParentFolderId) throw new Error('Provide newName and/or newParentFolderId.');
  const token = await getValidToken(uid, 'google', env);
  let url = DRIVE_BASE + '/files/' + encodeURIComponent(args.fileId) + '?fields=id,name,parents,webViewLink';
  const body = {};
  if (args.newName) body.name = args.newName;
  if (args.newParentFolderId) {
    const current = await _apiFetch(token, DRIVE_BASE + '/files/' + encodeURIComponent(args.fileId) + '?fields=parents', { method: 'GET' });
    const removeParents = (current.parents || []).join(',');
    url += '&addParents=' + encodeURIComponent(args.newParentFolderId) + (removeParents ? '&removeParents=' + encodeURIComponent(removeParents) : '');
  }
  const file = await _apiFetch(token, url, { method: 'PATCH', body: JSON.stringify(body) });
  return { id: file.id, name: file.name, link: file.webViewLink };
}

async function _shareDriveFile(uid, args, env) {
  if (!args.fileId || !args.email) throw new Error('fileId and email are both required.');
  const token = await getValidToken(uid, 'google', env);
  const notify = !!args.notify;
  const perm = await _apiFetch(
    token,
    DRIVE_BASE + '/files/' + encodeURIComponent(args.fileId) + '/permissions?sendNotificationEmail=' + notify + '&fields=id,role,emailAddress',
    { method: 'POST', body: JSON.stringify({ type: 'user', role: args.role || 'reader', emailAddress: args.email }) }
  );
  return { permissionId: perm.id, role: perm.role, email: perm.emailAddress };
}

async function _deleteDriveFile(uid, args, env) {
  if (!args.fileId) throw new Error('fileId is required.');
  const token = await getValidToken(uid, 'google', env);
  await _apiFetch(token, DRIVE_BASE + '/files/' + encodeURIComponent(args.fileId), {
    method: 'PATCH', body: JSON.stringify({ trashed: true }),
  });
  return { trashed: true, fileId: args.fileId };
}

// ─────────────────────────── GMAIL ───────────────────────────

async function _listGmailLabels(uid, args, env) {
  const token = await getValidToken(uid, 'google', env);
  const data = await _apiFetch(token, GMAIL_BASE + '/labels', { method: 'GET' });
  return (data.labels || []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
}

// NOTE: reading/searching mail, drafts, label-on-message modification, and
// trash all required gmail.readonly/gmail.modify/gmail.compose (restricted
// scopes → CASA assessment) and were removed 2026-09 along with their
// executors. _resolveReplyHeaders (in-reply-to header lookup) was only
// used by the draft/reply path and was removed with it — a plain send
// (below) never needs to look up an existing message's headers.

async function _sendGmailMessage(uid, args, env) {
  if (!args.to || !args.subject || args.body === undefined) throw new Error('to, subject, and body are all required.');
  const token = await getValidToken(uid, 'google', env);
  const raw = _base64UrlEncode(_buildMimeMessage({ ...args, inReplyToRfc822Id: null }));
  const sent = await _apiFetch(token, GMAIL_BASE + '/messages/send', {
    method: 'POST', body: JSON.stringify({ raw }),
  });
  return { id: sent.id, threadId: sent.threadId, sent: true };
}

// ─────────────────────────── DISPATCH ───────────────────────────

const _EXECUTORS = {
  google_list_calendars: _listCalendars,
  google_list_calendar_events: _listCalendarEvents,
  google_search_calendar_events: _searchCalendarEvents,
  google_get_calendar_event: _getCalendarEvent,
  google_create_calendar_event: _createCalendarEvent,
  google_update_calendar_event: _updateCalendarEvent,
  google_delete_calendar_event: _deleteCalendarEvent,

  google_list_drive_files: _listDriveFiles,
  google_search_drive_files: _searchDriveFiles,
  google_get_drive_file: _getDriveFile,
  google_read_drive_file_content: _readDriveFileContent,
  google_create_drive_file: _createDriveFile,
  google_create_drive_folder: _createDriveFolder,
  google_update_drive_file_content: _updateDriveFileContent,
  google_rename_or_move_drive_file: _renameOrMoveDriveFile,
  google_share_drive_file: _shareDriveFile,
  google_delete_drive_file: _deleteDriveFile,

  google_list_gmail_labels: _listGmailLabels,
  google_send_gmail_message: _sendGmailMessage,
};

export async function execute(name, args, uid, env) {
  const fn = _EXECUTORS[name];
  if (!fn) throw new Error('Unknown Google tool: ' + name);
  return fn(uid, args || {}, env);
}
