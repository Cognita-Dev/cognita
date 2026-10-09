// providers.js
// The ONLY module that knows how to talk to Groq, OpenRouter, or Workers AI.
// Callers pass in a resolved model-tier config (from entitlements.js) and
// get back plain text. They never see provider names, model strings, or keys.

import { fingerprint } from './prompts.js';

const DEFAULT_MAX_TOKENS = 2048;

// ── Prompt-cache support ───────────────────────────────────────────────
// Every request to a model re-sends the whole prompt, because model APIs
// have no memory between calls. What providers CAN do is notice that the
// beginning of a prompt is identical to one they processed moments ago and
// reuse that work: faster, about half price on Groq, and (on Groq) cached
// tokens do not count toward the rate limit. That happens automatically
// when the beginning of the prompt is byte-for-byte identical, which is why
// prompts.js keeps everything that varies at the END of the prompt.
//
// This file adds two small things on top of that:
//   1. SESSION HINTS. OpenRouter, the Vercel AI Gateway and Workers AI each
//      accept an optional header that sends related requests to the same
//      machine, which raises the chance of a cache hit. Groq needs none.
//   2. VISIBILITY. Each successful call logs one "[cache]" line with how
//      many prompt tokens were served from cache, so you can SEE whether
//      caching works instead of guessing. Set LOG_CACHE_STATS=off in the
//      Worker's variables to silence these lines.

/**
 * Reads the token counts out of a provider response, whatever shape it has
 * (OpenAI-style, DeepSeek-style, or Responses-style). Returns null if the
 * provider reported nothing usable.
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
  const cachedTokens = Number(
    (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) ??
    (usage.input_tokens_details && usage.input_tokens_details.cached_tokens) ??
    usage.prompt_cache_hit_tokens ??
    usage.cached_tokens
  ) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
  if (!promptTokens && !completionTokens) return null;
  return { promptTokens, cachedTokens, completionTokens };
}

function _usageFrom(data) {
  return normalizeUsage(data && data.usage);
}

function _logCacheUsage(env, ctx, messages, step, usage) {
  if (!usage || !usage.promptTokens) return;
  if (env && env.LOG_CACHE_STATS === 'off') return;
  const system = messages && messages[0] && messages[0].role === 'system' ? String(messages[0].content) : '';
  // Callers that pass { feature } get a readable name; the rest are shown
  // by a short fingerprint of their system prompt so they can still be told apart.
  const feature = (ctx && ctx.feature) || ('unlabeled#' + (system ? fingerprint(system) : 'none'));
  const pct = Math.round((100 * usage.cachedTokens) / usage.promptTokens);
  console.log(
    '[cache] feature=' + feature + ' ' + step.provider + '/' + step.model +
    ' prompt=' + usage.promptTokens + ' cached=' + usage.cachedTokens + ' hit=' + pct + '%'
  );
}

/**
 * A stable, anonymous label for "related requests" (same feature, same
 * user). Sent as a routing hint only. It is a one-way hash, so it carries no
 * personal data.
 */
export async function makeSessionId(feature, uid) {
  try {
    const bytes = new TextEncoder().encode('cognita:' + feature + ':' + uid);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
    return 'cog-' + feature + '-' + hex;
  } catch (e) {
    return undefined; // a missing hint only means a slightly lower hit rate
  }
}

async function _callGroq(messages, model, env, maxTokens) {
  const body = { model, max_tokens: maxTokens || DEFAULT_MAX_TOKENS, temperature: 0.5, messages };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.GROQ_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('groq_' + res.status + ':' + text.slice(0, 200));
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  const text = message.content;
  if (!text || !text.trim()) throw new Error('groq_empty');
  return {
    text: text.trim(),
    finishReason: data.choices?.[0]?.finish_reason,
    // Reasoning models on Groq (e.g. deepseek-r1-distill variants) may
    // return their chain of thought in one of these fields depending on
    // the model's reasoning_format setting.
    reasoning: message.reasoning || message.reasoning_content || null,
    usage: _usageFrom(data),
  };
}

async function _callOpenRouter(messages, model, env, maxTokens, ctx) {
  const body = { model, max_tokens: maxTokens || DEFAULT_MAX_TOKENS, temperature: 0.5, messages };

  const headers = {
    Authorization: 'Bearer ' + env.OPENROUTER_API_KEY,
    'HTTP-Referer': env.APP_ORIGIN || 'https://cognita.app',
    'X-Title': 'Cognita',
    'Content-Type': 'application/json',
  };
  // Routing hint: keeps related requests on the provider that already holds
  // the cached prompt (OpenRouter "sticky routing").
  if (ctx && ctx.sessionId) headers['x-session-id'] = ctx.sessionId;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('openrouter_' + res.status + ':' + text.slice(0, 200));
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  const text = message.content;
  if (!text || !text.trim()) throw new Error('openrouter_empty');
  return {
    text: text.trim(),
    finishReason: data.choices?.[0]?.finish_reason,
    reasoning: message.reasoning || message.reasoning_content || null,
    usage: _usageFrom(data),
  };
}

// "v0 (Admin)" provider — admin-only tier (see entitlements.js
// MODEL_TIERS.v0 / PLANS.admin). Despite the name, this calls Vercel AI
// Gateway generically, not the real v0-1.0-md/v0-1.5-md models — those
// are excluded from Gateway's free $5/month tier and this project
// doesn't have Gateway billing enabled. The actual model called here is
// whatever entitlements.js sets as MODEL_TIERS.v0.model (currently a
// free-tier-eligible model); see the comment there for how to switch
// this to genuine v0 once billing is turned on. Function/endpoint
// names kept as "V0" since that's still the tier's public label and
// this is the only provider that talks to the Gateway.
// env.V0_API_KEY must be an AI Gateway API key (created in the Vercel
// dashboard's AI Gateway → API Keys section, prefixed "vck_") — a
// v0.dev-issued key will not authenticate here.
async function _callV0(messages, model, env, maxTokens, ctx) {
  if (!env.V0_API_KEY) throw new Error('v0_not_configured');
  const body = { model, max_tokens: maxTokens || DEFAULT_MAX_TOKENS, temperature: 0.5, messages };

  const headers = {
    Authorization: 'Bearer ' + env.V0_API_KEY,
    'Content-Type': 'application/json',
  };
  // Routing hint for the Vercel AI Gateway (keeps related requests together
  // so the provider's prompt cache can be reused).
  if (ctx && ctx.sessionId) headers['x-session-affinity'] = ctx.sessionId;

  const res = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('v0_' + res.status + ':' + text.slice(0, 200));
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  const text = message.content;
  if (!text || !text.trim()) throw new Error('v0_empty');
  return {
    text: text.trim(),
    finishReason: data.choices?.[0]?.finish_reason,
    reasoning: message.reasoning || message.reasoning_content || null,
    usage: _usageFrom(data),
  };
}

async function _callWorkersAI(messages, model, env, ctx) {
  // The messages it receives are always plain role/content pairs (see
  // chat-endpoint.js), so this filter is just a safety net, not load-bearing.
  if (!env.AI) throw new Error('workersai_not_bound');
  const cleaned = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map((m) => ({
      role: m.role === 'model' ? 'assistant' : m.role,
      content: m.content,
    }));
  // Routing hint for Workers AI prompt caching (see providers.js header).
  const runOptions = ctx && ctx.sessionId
    ? { extraHeaders: { 'x-session-affinity': ctx.sessionId } }
    : undefined;
  const res = await env.AI.run(model, { messages: cleaned }, runOptions);
  const text = typeof res?.response === 'string' ? res.response.trim() : '';
  if (!text) throw new Error('workersai_empty');
  return { text, finishReason: 'stop', reasoning: null, usage: _usageFrom(res) };
}

/**
 * Calls Cloudflare Workers AI's vision-capable model with one or more
 * images attached to the final user turn. This is the only model in the
 * stack that accepts images, and it's free (Workers AI free tier neurons),
 * which is why the image-understanding feature can be premium-gated on
 * usage without adding a paid API cost per request.
 *
 * @param {string} model - the Workers AI vision model id, e.g.
 *   '@cf/meta/llama-3.2-11b-vision-instruct' (see entitlements.js)
 * @param {array} messages - plain role/content chat history, system prompt
 *   included, exactly as built in chat-endpoint.js
 * @param {array} images - [{ base64, mimeType }], already validated by the
 *   caller (size, count, mime type)
 * @param {object} env - Worker env bindings
 */
export async function callVisionModel(model, messages, images, env) {
  if (!env.AI) throw new Error('workersai_not_bound');

  // Workers AI's Llama 3.2 Vision binding takes a single "image" input
  // (raw bytes as a number array) alongside a text prompt — it does not
  // take a full multi-turn messages array the way the text models do.
  // So: fold the conversation history into one prompt string, and pass
  // through only the first image (the model is single-image per call).
  // If more than one image was attached, note the rest so the reply can
  // acknowledge them rather than silently ignoring them.
  const systemMsg = messages.find((m) => m.role === 'system');
  const conversational = messages.filter((m) => m.role !== 'system');

  const historyText = conversational
    .slice(0, -1)
    .map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content)
    .join('\n');

  const lastUserMsg = conversational[conversational.length - 1];
  let prompt = (systemMsg ? systemMsg.content + '\n\n' : '') +
    (historyText ? historyText + '\n' : '') +
    'User: ' + (lastUserMsg ? lastUserMsg.content : '');

  if (images.length > 1) {
    prompt += '\n\n[Note: the user attached ' + images.length + ' images. ' +
      'Only the first could be processed — mention that the rest were not reviewed if it matters to your answer.]';
  }

  const primaryImage = images[0];
  const binaryString = atob(primaryImage.base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const input = {
    prompt,
    image: Array.from(bytes),
    max_tokens: 1024,
  };
  let res;
  try {
    res = await env.AI.run(model, input);
  } catch (e) {
    // Meta's models need their licence accepted once per Cloudflare account
    // (error 5016). Accept it here by sending the prompt "agree", then retry.
    if (!/5016|prompt 'agree'/i.test(String((e && e.message) || e))) throw e;
    await env.AI.run(model, { prompt: 'agree' });
    res = await env.AI.run(model, input);
  }

  const text = typeof res?.description === 'string'
    ? res.description.trim()
    : (typeof res?.response === 'string' ? res.response.trim() : '');

  if (!text) throw new Error('workersai_vision_empty');

  return { text, finishReason: 'stop', reasoning: null };
}

// ── Real streaming (provider → Worker) ─────────────────────────────────
// When a caller passes options.onText, the provider call is made with
// stream:true and every text delta is handed to onText the moment it
// arrives. The return value keeps the exact same shape as the non-streaming
// path ({ text, finishReason, reasoning, toolCalls, usage }), so the rest of
// the agent loop is unchanged. Errors before the first delta are ordinary
// errors (the fallback chain moves on to the next provider). An error after
// text was already emitted is flagged err.partial = true: the chain must NOT
// retry another provider then, because the user has already seen output.

// Yields the `data:` payload of each SSE event. Handles chunk boundaries that
// split a line or a multi-byte UTF-8 character.
async function* _sseData(stream, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      if (signal && signal.aborted) throw new Error('stream_aborted');
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
    }
    buf += decoder.decode();
    const tail = buf.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (tail) yield tail;
  } finally {
    try { await reader.cancel(); } catch (_) {}
  }
}

function _safeEmit(ctx, delta) {
  if (!delta) return;
  try { ctx.onText(delta); } catch (_) { /* a broken listener must not break the model call */ }
}

// OpenAI-compatible streaming (Groq, OpenRouter, Vercel Gateway).
async function _streamChatCompletions(name, url, headers, body, ctx, hasTools) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    signal: ctx.signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    if (hasTools && res.status === 400 && /tool/i.test(t)) {
      throw new Error('tools_unsupported:' + name + '_' + res.status + ':' + t.slice(0, 200));
    }
    throw new Error(name + '_' + res.status + ':' + t.slice(0, 200));
  }
  if (!res.body) throw new Error(name + '_empty');

  let text = '';
  let reasoning = '';
  let finishReason;
  let usage = null;
  const calls = []; // by delta index
  let emitted = false;
  try {
    for await (const data of _sseData(res.body, ctx.signal)) {
      if (data === '[DONE]') break;
      let j;
      try { j = JSON.parse(data); } catch (_) { continue; } // malformed event: skip it
      if (j.error) throw new Error(name + '_stream_error:' + String(j.error.message || JSON.stringify(j.error)).slice(0, 200));
      if (j.usage) usage = _usageFrom(j);
      const choice = j.choices && j.choices[0];
      if (!choice) continue;
      const d = choice.delta || {};
      if (typeof d.content === 'string' && d.content) {
        text += d.content;
        emitted = true;
        _safeEmit(ctx, d.content);
      }
      const r = d.reasoning || d.reasoning_content;
      if (typeof r === 'string') reasoning += r;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = Number.isInteger(tc.index) ? tc.index : 0;
          const c = calls[i] || (calls[i] = { id: null, name: '', args: '' });
          if (tc.id) c.id = tc.id;
          if (tc.function) {
            if (tc.function.name) c.name += tc.function.name;
            if (typeof tc.function.arguments === 'string') c.args += tc.function.arguments;
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  } catch (e) {
    if (emitted) e.partial = true;
    throw e;
  }
  const toolCalls = calls.filter((c) => c && c.name).map((c) => ({ id: c.id, name: c.name, args: _safeParseToolArgs(c.args) }));
  if (!toolCalls.length && !text.trim()) throw new Error(name + '_empty');
  return {
    text: text.trim(),
    finishReason,
    reasoning: reasoning || null,
    toolCalls: toolCalls.length ? toolCalls : null,
    usage,
  };
}

async function _streamWorkersAI(messages, model, env, ctx) {
  if (!env.AI) throw new Error('workersai_not_bound');
  const cleaned = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map((m) => ({ role: m.role === 'model' ? 'assistant' : m.role, content: m.content }));
  const runOptions = ctx && ctx.sessionId ? { extraHeaders: { 'x-session-affinity': ctx.sessionId } } : undefined;
  const res = await env.AI.run(model, { messages: cleaned, stream: true }, runOptions);
  if (!res || typeof res.getReader !== 'function') {
    // Binding answered without a stream: use it as a single chunk.
    const t = typeof res?.response === 'string' ? res.response.trim() : '';
    if (!t) throw new Error('workersai_empty');
    _safeEmit(ctx, t);
    return { text: t, finishReason: 'stop', reasoning: null, usage: _usageFrom(res) };
  }
  let text = '';
  let usage = null;
  let emitted = false;
  try {
    for await (const data of _sseData(res, ctx.signal)) {
      if (data === '[DONE]') break;
      let j;
      try { j = JSON.parse(data); } catch (_) { continue; }
      if (j.usage) usage = _usageFrom(j);
      const delta = typeof j.response === 'string' ? j.response : (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
      if (delta) { text += delta; emitted = true; _safeEmit(ctx, delta); }
    }
  } catch (e) {
    if (emitted) e.partial = true;
    throw e;
  }
  if (!text.trim()) throw new Error('workersai_empty');
  return { text: text.trim(), finishReason: 'stop', reasoning: null, usage };
}

const _OPENAI_ENDPOINTS = {
  groq: (env, ctx) => ({
    name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY, 'Content-Type': 'application/json' },
  }),
  openrouter: (env, ctx) => ({
    name: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: Object.assign({
      Authorization: 'Bearer ' + env.OPENROUTER_API_KEY,
      'HTTP-Referer': env.APP_ORIGIN || 'https://cognita.app',
      'X-Title': 'Cognita',
      'Content-Type': 'application/json',
    }, ctx && ctx.sessionId ? { 'x-session-id': ctx.sessionId } : {}),
  }),
  vercel_v0: (env, ctx) => {
    if (!env.V0_API_KEY) throw new Error('v0_not_configured');
    return {
      name: 'v0', url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      headers: Object.assign({ Authorization: 'Bearer ' + env.V0_API_KEY, 'Content-Type': 'application/json' },
        ctx && ctx.sessionId ? { 'x-session-affinity': ctx.sessionId } : {}),
    };
  },
};

// Shared streaming entry point used by _dispatch / _dispatchWithTools.
async function _streamDispatch(providerName, messages, model, tools, env, maxTokens, ctx) {
  if (providerName === 'workersai') return _streamWorkersAI(messages, model, env, ctx);
  const make = _OPENAI_ENDPOINTS[providerName];
  if (!make) throw new Error('Unknown provider: ' + providerName);
  const ep = make(env, ctx);
  const body = { model, max_tokens: maxTokens || DEFAULT_MAX_TOKENS, temperature: 0.5, messages };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  return _streamChatCompletions(ep.name, ep.url, ep.headers, body, ctx, !!tools);
}

/**
 * Calls a provider by name. Internal use only — always go through
 * callWithFallback() from outside this file.
 */
async function _dispatch(providerName, messages, model, env, maxTokens, ctx) {
  if (ctx && ctx.onText) {
    const mt = providerName === 'groq' ? _groqMaxTokens(messages, null, maxTokens, env) : maxTokens;
    return _streamDispatch(providerName, messages, model, null, env, mt, ctx);
  }
  if (providerName === 'groq') return _callGroq(messages, model, env, _groqMaxTokens(messages, null, maxTokens, env));
  if (providerName === 'openrouter') return _callOpenRouter(messages, model, env, maxTokens, ctx);
  if (providerName === 'vercel_v0') return _callV0(messages, model, env, maxTokens, ctx);
  if (providerName === 'workersai') return _callWorkersAI(messages, model, env, ctx);
  throw new Error('Unknown provider: ' + providerName);
}

// ── Tool-calling (connector tools: GitHub/Google/Facebook/Canva) ──
// Only Groq and OpenRouter speak the OpenAI-compatible `tools` param here.
// Workers AI is deliberately NOT wired for tools — its binding's tool-call
// support is inconsistent across models and this app only uses it as an
// emergency fallback, never as a primary chat provider. If a tier's whole
// provider chain can't do tools, callWithTools throws 'tools_unsupported'
// and the caller (chat-endpoint.js) falls back to a plain, tool-less reply
// rather than failing the request outright.

function _safeParseToolArgs(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function _extractToolCalls(message) {
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return null;
  return message.tool_calls
    .filter((tc) => tc && tc.function && tc.function.name)
    .map((tc) => ({
      id: tc.id || null,
      name: tc.function.name,
      args: _safeParseToolArgs(tc.function.arguments),
    }));
}

async function _callGroqWithTools(messages, model, tools, env, maxTokens) {
  const body = {
    model,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature: 0.5,
    messages,
    tools,
    tool_choice: 'auto',
  };
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.GROQ_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Some Groq models reject an unrecognized/unsupported `tools` param
    // with a 400 — treat that distinctly so the caller can fall back to a
    // tool-less call on the same provider instead of a hard failure.
    if (res.status === 400 && /tool/i.test(text)) {
      throw new Error('tools_unsupported:groq_' + res.status + ':' + text.slice(0, 200));
    }
    throw new Error('groq_' + res.status + ':' + text.slice(0, 200));
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  const toolCalls = _extractToolCalls(message);
  const text = typeof message.content === 'string' ? message.content : '';
  if (!toolCalls && !text.trim()) throw new Error('groq_empty');
  return {
    text: text.trim(),
    finishReason: data.choices?.[0]?.finish_reason,
    reasoning: message.reasoning || message.reasoning_content || null,
    toolCalls,
    usage: _usageFrom(data),
  };
}

async function _callOpenRouterWithTools(messages, model, tools, env, maxTokens, ctx) {
  const body = {
    model,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature: 0.5,
    messages,
    tools,
    tool_choice: 'auto',
  };
  const headers = {
    Authorization: 'Bearer ' + env.OPENROUTER_API_KEY,
    'HTTP-Referer': env.APP_ORIGIN || 'https://cognita.app',
    'X-Title': 'Cognita',
    'Content-Type': 'application/json',
  };
  if (ctx && ctx.sessionId) headers['x-session-id'] = ctx.sessionId;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 400 && /tool/i.test(text)) {
      throw new Error('tools_unsupported:openrouter_' + res.status + ':' + text.slice(0, 200));
    }
    throw new Error('openrouter_' + res.status + ':' + text.slice(0, 200));
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  const toolCalls = _extractToolCalls(message);
  const text = typeof message.content === 'string' ? message.content : '';
  if (!toolCalls && !text.trim()) throw new Error('openrouter_empty');
  return {
    text: text.trim(),
    finishReason: data.choices?.[0]?.finish_reason,
    reasoning: message.reasoning || message.reasoning_content || null,
    toolCalls,
    usage: _usageFrom(data),
  };
}

async function _callV0WithTools(messages, model, tools, env, maxTokens, ctx) {
  if (!env.V0_API_KEY) throw new Error('v0_not_configured');
  const body = {
    model,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature: 0.5,
    messages,
    tools,
    tool_choice: 'auto',
  };
  const headers = {
    Authorization: 'Bearer ' + env.V0_API_KEY,
    'Content-Type': 'application/json',
  };
  if (ctx && ctx.sessionId) headers['x-session-affinity'] = ctx.sessionId;
  const res = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 400 && /tool/i.test(text)) {
      throw new Error('tools_unsupported:v0_' + res.status + ':' + text.slice(0, 200));
    }
    throw new Error('v0_' + res.status + ':' + text.slice(0, 200));
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  const toolCalls = _extractToolCalls(message);
  const text = typeof message.content === 'string' ? message.content : '';
  if (!toolCalls && !text.trim()) throw new Error('v0_empty');
  return {
    text: text.trim(),
    finishReason: data.choices?.[0]?.finish_reason,
    reasoning: message.reasoning || message.reasoning_content || null,
    toolCalls,
    usage: _usageFrom(data),
  };
}


// ── Groq per-minute token budget ───────────────────────────────────────
// Groq's free tier allows about 8,000 tokens per minute for each gpt-oss
// model, and it counts the room reserved for the answer (max_tokens) as
// well as the prompt. A long chat with tools attached can ask for more than
// that in one request, and Groq rejects it with a 413 that can never
// succeed. Instead of sending a doomed request (and logging an error), this
// estimates the size first, trims the reserved answer room to fit, and if
// even a decent answer cannot fit it skips Groq and lets the next provider in
// the chain take the request. Set GROQ_TPM_LIMIT in the Worker variables if
// your Groq plan has a different limit.
const GROQ_TPM_DEFAULT = 8000;
const GROQ_TPM_MARGIN = 300;       // slack for the estimate being a little off
const GROQ_MIN_ANSWER_ROOM = 1024; // below this, an answer would get cut off

function _estimateTokens(messages, tools) {
  let chars = 0;
  for (const m of messages || []) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
  }
  if (tools) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / 3) + 50; // 3 characters per token is deliberately cautious
}

function _groqMaxTokens(messages, tools, wanted, env) {
  const limit = Number(env && env.GROQ_TPM_LIMIT) || GROQ_TPM_DEFAULT;
  const room = limit - GROQ_TPM_MARGIN - _estimateTokens(messages, tools);
  if (room < GROQ_MIN_ANSWER_ROOM) {
    const err = new Error('groq_skipped_too_large: prompt is about ' + _estimateTokens(messages, tools) + ' tokens, over the ' + limit + ' per-minute cap');
    err.skip = true; // expected, not an outage: logged quietly and not remembered as a rate limit
    throw err;
  }
  return Math.min(wanted || DEFAULT_MAX_TOKENS, room);
}

// ── Models that no longer exist ────────────────────────────────────────
// Free models on OpenRouter come and go. A 404 for a model is not going to
// fix itself in the next minute, so it is remembered for an hour and the
// step is left out of the chain (unless it would leave nothing to try).
const GONE_MODEL_COOLDOWN_MS = 60 * 60 * 1000;
const _goneUntil = new Map();

function _isModelGone(err) {
  return /_(?:404|410)\b|model_not_found|model_decommissioned|no endpoints found|unavailable for free/i.test(String(err && err.message));
}
function _isGone(step) {
  const until = _goneUntil.get(_stepKey(step));
  return typeof until === 'number' && Date.now() < until;
}
function _markGone(step) {
  _goneUntil.set(_stepKey(step), Date.now() + GONE_MODEL_COOLDOWN_MS);
}

// One place that records a failed step, so both call paths log and remember
// failures the same way.
function _noteStepFailure(step, err, label, what) {
  if (err && err.skip) {
    console.log('[providers] ' + what + ' ' + label + ' (' + step.provider + '/' + step.model + ') skipped:', err.message);
    return;
  }
  if (_isRateLimitError(err)) _markRateLimited(step);
  if (_isModelGone(err)) {
    _markGone(step);
    console.warn('[providers] ' + what + ' ' + label + ' (' + step.provider + '/' + step.model + ') no longer exists, leaving it out for an hour:', err.message);
    return;
  }
  console.warn('[providers] ' + what + ' ' + label + ' (' + step.provider + '/' + step.model + ') failed:', err.message);
}

async function _dispatchWithTools(providerName, messages, model, tools, env, maxTokens, ctx) {
  if (ctx && ctx.onText && providerName !== 'workersai') {
    const mt = providerName === 'groq' ? _groqMaxTokens(messages, tools, maxTokens, env) : maxTokens;
    return _streamDispatch(providerName, messages, model, tools, env, mt, ctx);
  }
  if (providerName === 'groq') return _callGroqWithTools(messages, model, tools, env, _groqMaxTokens(messages, tools, maxTokens, env));
  if (providerName === 'openrouter') return _callOpenRouterWithTools(messages, model, tools, env, maxTokens, ctx);
  if (providerName === 'vercel_v0') return _callV0WithTools(messages, model, tools, env, maxTokens, ctx);
  // workersai (and anything else) — no tool support. Signal the caller
  // distinctly so it can retry tool-less rather than treat this as a
  // generic provider outage.
  throw new Error('tools_unsupported:' + providerName);
}

/**
 * Unrolls a tierConfig's { provider, model, fallback: {...} } chain (of any
 * length — fallback.fallback.fallback... is fine) into a flat, ordered
 * array of { provider, model } steps. This is the single place that knows
 * how to read a tier's chain, so callWithFallback and callWithTools always
 * see and exhaust the exact same list of providers, in the exact same
 * order, however many levels deep it goes.
 */
function _stepsFromTierConfig(tierConfig) {
  const steps = [{ provider: tierConfig.provider, model: tierConfig.model }];
  let next = tierConfig.fallback;
  while (next) {
    steps.push({ provider: next.provider, model: next.model });
    next = next.fallback;
  }
  return steps;
}

// ── Sticky rate-limit memory ──
// Without this, every single call in a multi-step task (e.g. a tool-use
// loop that hits the model 4-5 times in a row) restarts at the chain's
// primary step, even if the previous call *just* found out that step is
// rate-limited. That wastes a doomed request and adds latency on every
// step until the limit clears, even though the task itself never fails.
//
// This is a small in-memory (per Worker isolate) note of which
// provider/model combos were recently rate-limited. When building the
// order to try for a new call, anything still "cooling down" is moved to
// the back of the line — tried last, as a final resort — instead of
// first. It's never removed from the chain entirely, so the request still
// succeeds if every "healthy" option also happens to fail.
//
// This resets whenever the Worker isolate recycles, which is fine: it's a
// latency optimization, not something correctness depends on.
const RATE_LIMIT_COOLDOWN_MS = 20000; // comfortably longer than a typical burst TPM window
const _rateLimitedUntil = new Map(); // key: "provider::model" -> epoch ms when cooldown ends

function _stepKey(step) {
  return step.provider + '::' + step.model;
}

function _isCoolingDown(step) {
  const until = _rateLimitedUntil.get(_stepKey(step));
  return typeof until === 'number' && Date.now() < until;
}

function _markRateLimited(step) {
  _rateLimitedUntil.set(_stepKey(step), Date.now() + RATE_LIMIT_COOLDOWN_MS);
}

// A 429 (or a message that otherwise says "rate limit") is the only
// failure type worth remembering here — a one-off network blip or a
// content-related 400 tells us nothing about whether the NEXT call to
// that same provider/model will also fail, so those aren't cached.
function _isRateLimitError(err) {
  return /_429\b|rate.?limit/i.test(String(err && err.message));
}

// Same steps, reordered so anything currently cooling down from a recent
// rate limit sinks to the end instead of being tried first.
function _orderStepsByHealth(allSteps) {
  const present = allSteps.filter((st) => !_isGone(st));
  const steps = present.length ? present : allSteps;
  const ready = [];
  const cooling = [];
  for (const step of steps) {
    (_isCoolingDown(step) ? cooling : ready).push(step);
  }
  return ready.concat(cooling);
}

/**
 * Same shape as callWithFallback, but offers the model a set of callable
 * tools (OpenAI-compatible `tools` array — see connector-tools.js for how
 * these are built). Returns { text, finishReason, reasoning, toolCalls }
 * where toolCalls is either null (model just replied normally) or an
 * array of { id, name, args } the caller should act on.
 *
 * Walks the tier's full fallback chain (not just one hop) before giving
 * up, so a single rate-limited or down provider never takes the whole
 * request with it as long as any later step in the chain is healthy.
 *
 * Throws 'tools_unsupported' (as the error message prefix) only if EVERY
 * step in the chain failed specifically because that provider doesn't do
 * tool-calling — chat-endpoint.js catches that specifically and re-runs
 * the turn through plain callWithFallback() instead of failing the
 * request. Any other mix of failures throws a generic outage error.
 */
export async function callWithTools(tierConfig, messages, tools, env, options = {}) {
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const ctx = { feature: options.feature, sessionId: options.sessionId, onText: options.onText, signal: options.signal };
  const steps = _orderStepsByHealth(_stepsFromTierConfig(tierConfig));

  let lastErr = null;
  let allToolsUnsupported = true;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      const result = await _dispatchWithTools(step.provider, messages, step.model, tools, env, maxTokens, ctx);
      _logCacheUsage(env, ctx, messages, step, result.usage);
      return result;
    } catch (err) {
      lastErr = err;
      if (!String(err.message).startsWith('tools_unsupported')) allToolsUnsupported = false;
      _noteStepFailure(step, err, i === 0 ? 'primary' : 'fallback #' + i, 'tool-call');
      if (err && err.partial) throw err; // text already reached the user: never retry elsewhere
    }
  }

  if (allToolsUnsupported) {
    throw new Error('tools_unsupported: no provider in this tier supports tool-calling.');
  }
  console.error('[providers] tool-call chain exhausted, last error:', lastErr && lastErr.message);
  throw new Error('All providers unavailable.');
}

/**
 * Calls the primary provider for a model tier, falling back to the tier's
 * configured fallback provider on failure. Never escalates to a richer
 * tier than what was resolved for the user's plan — fallback is same-tier,
 * different provider, so a Free user can never get a Studio-tier answer
 * just because the primary provider happened to fail.
 *
 * @param {object} tierConfig - one entry from MODEL_TIERS (entitlements.js)
 * @param {array} messages - chat messages array (always plain role/content
 *   pairs; see chat-endpoint.js)
 * @param {object} env - Worker env bindings
 * @param {object} [options] - { maxTokens: number } — raise this for
 *   long-form structured generation (documents, resources) where the
 *   default 2048 tokens truncates mid-JSON and corrupts the whole output.
 *   Optional prompt-cache helpers: { feature: 'chat' } names this call in
 *   the "[cache]" log line; { sessionId } (see makeSessionId) is a routing
 *   hint that raises the chance of a cache hit. Both may be left out.
 *
 * Walks the tier's full fallback chain (however many levels deep it is
 * defined in entitlements.js) rather than stopping after a single
 * fallback, so one down/rate-limited provider can't take the whole
 * request with it as long as a later step in the chain still works.
 */
export async function callWithFallback(tierConfig, messages, env, options = {}) {
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const ctx = { feature: options.feature, sessionId: options.sessionId, onText: options.onText, signal: options.signal };
  const steps = _orderStepsByHealth(_stepsFromTierConfig(tierConfig));

  let lastErr = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      const result = await _dispatch(step.provider, messages, step.model, env, maxTokens, ctx);
      _logCacheUsage(env, ctx, messages, step, result.usage);
      if (result.finishReason === 'length') {
        return await _continueIfTruncated(step.provider, step.model, messages, result, env, maxTokens, options, ctx);
      }
      return result;
    } catch (err) {
      lastErr = err;
      _noteStepFailure(step, err, i === 0 ? 'primary' : 'fallback #' + i, 'chat');
      if (err && err.partial) throw err; // text already reached the user: never retry elsewhere
    }
  }
  console.error('[providers] chain exhausted, last error:', lastErr && lastErr.message);
  throw new Error('All providers unavailable.');
}

// If a response got cut off by max_tokens, ask the same provider to continue
// rather than surfacing a truncated answer to the user.
//
// For plain prose this is a simple "continue from where you left off"
// concatenation. For structured-JSON callers (options.jsonMode: true —
// used by document-endpoint.js and resources-endpoint.js) a naive text
// concatenation is unsafe: the cut can land mid-string or mid-key, and
// gluing two fragments together with "\n\n" produces text that is no
// longer valid JSON at all, which previously caused the whole structured
// document to collapse into one raw unparsed blob. For jsonMode we ask
// the model to continue the JSON with no separator and no repeated
// preamble, and we do a plain concatenation (no inserted whitespace)
// so the two fragments have a chance of forming valid JSON when joined.
async function _continueIfTruncated(providerName, model, messages, partial, env, maxTokens, options, ctx) {
  try {
    const jsonMode = !!options.jsonMode;
    // Cut off inside a ```cognita-ui block: carry on the JSON itself, glued on with no separator,
    // so the finished answer is the same text the browser already watched stream in.
    const openAt = partial.text.lastIndexOf('```cognita-ui');
    const inUiFence = !jsonMode && openAt !== -1 && partial.text.indexOf('```', openAt + 13) === -1;
    const continuation = messages.concat([
      { role: 'assistant', content: partial.text },
      {
        role: 'user',
        content: inUiFence
          ? 'Your last response was cut off inside a cognita-ui block. Continue from the exact next character so the JSON stays valid. Output only the raw continuation: no repeated text, no new opening fence, no commentary. Keep the remaining components short, close the JSON, close the block with ``` and stop.'
          : jsonMode
          ? 'Your last response was cut off mid-JSON. Continue the JSON from the exact character after where you stopped. Output only the raw continuation — no repeated text, no markdown fences, no commentary.'
          : 'Continue directly from where you left off. Do not repeat anything already written.',
      },
    ]);
    // `continuation` starts with the exact same messages as the first call,
    // so the provider can reuse its cached work for all of it.
    const extra = await _dispatch(providerName, continuation, model, env, maxTokens, ctx);
    _logCacheUsage(env, ctx, continuation, { provider: providerName, model }, extra.usage);
    return {
      text: (jsonMode || inUiFence) ? (partial.text + extra.text).trim() : (partial.text + '\n\n' + extra.text).trim(),
      finishReason: 'stop',
      reasoning: partial.reasoning || extra.reasoning || null,
    };
  } catch (e) {
    // Continuation failing isn't fatal — return what we have.
    return partial;
  }
}
