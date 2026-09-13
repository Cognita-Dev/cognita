// google-tools.js
// Tool schemas + executors for the Google connector. Scoped to exactly the
// two OAuth scopes actually granted (see connector-providers.js):
//   - drive.file      → the app can only see/create files IT created, never
//                        the user's whole Drive. So no "list all my Drive
//                        files" tool exists here — that scope can't do it.
//   - calendar.events  → read/create/update events, not the full calendar
//                        settings surface.
// Same TOOLS/REQUIRES_CONFIRMATION/describe/execute shape as github-tools.js
// — see that file's header comment for the contract.

import { getValidToken } from './connectors.js';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'google_list_calendar_events',
      description: "Lists the user's upcoming Google Calendar events within a given number of days from now. Use this to answer questions like 'what's on my calendar this week'.",
      parameters: {
        type: 'object',
        properties: {
          daysAhead: { type: 'integer', description: 'How many days ahead to look (default 7, max 30).' },
          maxResults: { type: 'integer', description: 'Max events to return (default 10, max 25).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_create_calendar_event',
      description: "Creates a new event on the user's primary Google Calendar. This changes their calendar, so it always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title.' },
          description: { type: 'string', description: 'Event description. Optional.' },
          startIso: { type: 'string', description: 'Start time, ISO 8601 with timezone offset, e.g. 2026-09-20T14:00:00+01:00.' },
          endIso: { type: 'string', description: 'End time, ISO 8601 with timezone offset.' },
        },
        required: ['summary', 'startIso', 'endIso'],
      },
    },
  },
];

export const REQUIRES_CONFIRMATION = ['google_create_calendar_event'];

export function describe(name, args) {
  if (name === 'google_list_calendar_events') return 'Check your upcoming Google Calendar events.';
  if (name === 'google_create_calendar_event') {
    return 'Create a calendar event "' + (args.summary || '') + '" from ' + (args.startIso || '?') + ' to ' + (args.endIso || '?') + '.';
  }
  return 'Perform a Google action.';
}

async function _googleFetch(token, path, options = {}) {
  const res = await fetch('https://www.googleapis.com' + path, {
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
    throw new Error('Google API error (' + res.status + '): ' + text.slice(0, 300));
  }
  return res.json();
}

async function _listEvents(uid, args, env) {
  const token = await getValidToken(uid, 'google', env);
  const daysAhead = Math.min(Math.max(parseInt(args.daysAhead, 10) || 7, 1), 30);
  const maxResults = Math.min(Math.max(parseInt(args.maxResults, 10) || 10, 1), 25);

  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    timeMin, timeMax,
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  const data = await _googleFetch(token, '/calendar/v3/calendars/primary/events?' + params.toString(), { method: 'GET' });
  return (data.items || []).map((ev) => ({
    summary: ev.summary || '(no title)',
    start: ev.start?.dateTime || ev.start?.date || null,
    end: ev.end?.dateTime || ev.end?.date || null,
    link: ev.htmlLink || null,
  }));
}

async function _createEvent(uid, args, env) {
  if (!args.summary || !args.startIso || !args.endIso) {
    throw new Error('summary, startIso, and endIso are all required to create an event.');
  }
  const token = await getValidToken(uid, 'google', env);
  const event = await _googleFetch(token, '/calendar/v3/calendars/primary/events', {
    method: 'POST',
    body: JSON.stringify({
      summary: args.summary,
      description: args.description || '',
      start: { dateTime: args.startIso },
      end: { dateTime: args.endIso },
    }),
  });
  return { id: event.id, link: event.htmlLink, summary: event.summary };
}

export async function execute(name, args, uid, env) {
  if (name === 'google_list_calendar_events') return _listEvents(uid, args, env);
  if (name === 'google_create_calendar_event') return _createEvent(uid, args, env);
  throw new Error('Unknown Google tool: ' + name);
}
