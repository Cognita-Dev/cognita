// slack-tools.js
// Tool schemas + executors for the Slack connector, scoped to exactly
// `chat:write,channels:read` (see connector-providers.js) — the app can
// list public channels and post messages, nothing else (no reading DMs,
// no reading message history, no user lookups).
// Same TOOLS/REQUIRES_CONFIRMATION/describe/execute shape as
// github-tools.js — see that file's header comment for the contract.

import { getValidToken } from './connectors.js';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'slack_list_channels',
      description: "Lists public Slack channels in the user's workspace (name and ID). Use this to find a channel before posting a message to it.",
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max channels to return (default 20, max 100).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slack_post_message',
      description: "Posts a message to a Slack channel. This is visible to everyone in that channel, so it always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: "Channel name (e.g. 'general') or channel ID." },
          text: { type: 'string', description: 'Message text to post.' },
        },
        required: ['channel', 'text'],
      },
    },
  },
];

export const REQUIRES_CONFIRMATION = ['slack_post_message'];

export function describe(name, args) {
  if (name === 'slack_list_channels') return 'List Slack channels in your workspace.';
  if (name === 'slack_post_message') {
    return 'Post to #' + String(args.channel || '?').replace(/^#/, '') + ': "' + (args.text || '') + '"';
  }
  return 'Perform a Slack action.';
}

async function _slackFetch(token, path, options = {}) {
  const res = await fetch('https://slack.com/api' + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json; charset=utf-8',
      ...(options.headers || {}),
    },
  });
  // Slack always returns HTTP 200 and signals failure via body.ok — a
  // quirk worth handling explicitly rather than trusting res.ok.
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = data.error || ('http_' + res.status);
    if (err === 'invalid_auth' || err === 'token_revoked' || err === 'token_expired') {
      throw new Error('NEEDS_RECONNECT');
    }
    throw new Error('Slack API error: ' + err);
  }
  return data;
}

async function _resolveChannelId(token, channel) {
  // Accept either a raw channel ID (Slack IDs are uppercase alnum,
  // typically starting with C) or a human name, resolving the latter via
  // a channel list lookup.
  const cleaned = String(channel || '').trim().replace(/^#/, '');
  if (/^[A-Z0-9]{9,}$/.test(cleaned)) return cleaned;

  const list = await _slackFetch(token, '/conversations.list?limit=1000&types=public_channel', { method: 'GET' });
  const match = (list.channels || []).find((c) => c.name === cleaned);
  if (!match) throw new Error('Could not find a Slack channel named "' + cleaned + '".');
  return match.id;
}

async function _listChannels(uid, args, env) {
  const token = await getValidToken(uid, 'slack', env);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);
  const data = await _slackFetch(token, '/conversations.list?limit=' + limit + '&types=public_channel', { method: 'GET' });
  return (data.channels || []).map((c) => ({ id: c.id, name: c.name, memberCount: c.num_members ?? null }));
}

async function _postMessage(uid, args, env) {
  if (!args.channel || !args.text) {
    throw new Error('channel and text are both required to post a Slack message.');
  }
  const token = await getValidToken(uid, 'slack', env);
  const channelId = await _resolveChannelId(token, args.channel);
  const data = await _slackFetch(token, '/chat.postMessage', {
    method: 'POST',
    body: JSON.stringify({ channel: channelId, text: args.text }),
  });
  return { channel: data.channel, ts: data.ts, posted: true };
}

export async function execute(name, args, uid, env) {
  if (name === 'slack_list_channels') return _listChannels(uid, args, env);
  if (name === 'slack_post_message') return _postMessage(uid, args, env);
  throw new Error('Unknown Slack tool: ' + name);
}
