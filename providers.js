// providers.js
// The ONLY module that knows how to talk to Groq, OpenRouter, or Workers AI.
// Callers pass in a resolved model-tier config (from entitlements.js) and
// get back plain text. They never see provider names, model strings, or keys.

const DEFAULT_MAX_TOKENS = 2048;

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
  };
}

async function _callOpenRouter(messages, model, env, maxTokens) {
  const body = { model, max_tokens: maxTokens || DEFAULT_MAX_TOKENS, temperature: 0.5, messages };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.OPENROUTER_API_KEY,
      'HTTP-Referer': env.APP_ORIGIN || 'https://cognita.app',
      'X-Title': 'Cognita',
      'Content-Type': 'application/json',
    },
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
  };
}

async function _callWorkersAI(messages, model, env) {
  // The messages it receives are always plain role/content pairs (see
  // chat-endpoint.js), so this filter is just a safety net, not load-bearing.
  if (!env.AI) throw new Error('workersai_not_bound');
  const cleaned = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map((m) => ({
      role: m.role === 'model' ? 'assistant' : m.role,
      content: m.content,
    }));
  const res = await env.AI.run(model, { messages: cleaned });
  const text = typeof res?.response === 'string' ? res.response.trim() : '';
  if (!text) throw new Error('workersai_empty');
  return { text, finishReason: 'stop', reasoning: null };
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

  const res = await env.AI.run(model, {
    prompt,
    image: Array.from(bytes),
    max_tokens: 1024,
  });

  const text = typeof res?.description === 'string'
    ? res.description.trim()
    : (typeof res?.response === 'string' ? res.response.trim() : '');

  if (!text) throw new Error('workersai_vision_empty');

  return { text, finishReason: 'stop', reasoning: null };
}

/**
 * Calls a provider by name. Internal use only — always go through
 * callWithFallback() from outside this file.
 */
async function _dispatch(providerName, messages, model, env, maxTokens) {
  if (providerName === 'groq') return _callGroq(messages, model, env, maxTokens);
  if (providerName === 'openrouter') return _callOpenRouter(messages, model, env, maxTokens);
  if (providerName === 'workersai') return _callWorkersAI(messages, model, env);
  throw new Error('Unknown provider: ' + providerName);
}

// ── Tool-calling (connector tools: GitHub/Google/Figma/Canva) ──
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
  };
}

async function _callOpenRouterWithTools(messages, model, tools, env, maxTokens) {
  const body = {
    model,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature: 0.5,
    messages,
    tools,
    tool_choice: 'auto',
  };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.OPENROUTER_API_KEY,
      'HTTP-Referer': env.APP_ORIGIN || 'https://cognita.app',
      'X-Title': 'Cognita',
      'Content-Type': 'application/json',
    },
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
  };
}

async function _dispatchWithTools(providerName, messages, model, tools, env, maxTokens) {
  if (providerName === 'groq') return _callGroqWithTools(messages, model, tools, env, maxTokens);
  if (providerName === 'openrouter') return _callOpenRouterWithTools(messages, model, tools, env, maxTokens);
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
function _orderStepsByHealth(steps) {
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
  const steps = _orderStepsByHealth(_stepsFromTierConfig(tierConfig));

  let lastErr = null;
  let allToolsUnsupported = true;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      return await _dispatchWithTools(step.provider, messages, step.model, tools, env, maxTokens);
    } catch (err) {
      lastErr = err;
      if (_isRateLimitError(err)) _markRateLimited(step);
      if (!String(err.message).startsWith('tools_unsupported')) allToolsUnsupported = false;
      const label = i === 0 ? 'primary' : 'fallback #' + i;
      console.warn('[providers] tool-call ' + label + ' (' + step.provider + '/' + step.model + ') failed:', err.message);
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
 *
 * Walks the tier's full fallback chain (however many levels deep it is
 * defined in entitlements.js) rather than stopping after a single
 * fallback, so one down/rate-limited provider can't take the whole
 * request with it as long as a later step in the chain still works.
 */
export async function callWithFallback(tierConfig, messages, env, options = {}) {
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const steps = _orderStepsByHealth(_stepsFromTierConfig(tierConfig));

  let lastErr = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      const result = await _dispatch(step.provider, messages, step.model, env, maxTokens);
      if (result.finishReason === 'length') {
        return await _continueIfTruncated(step.provider, step.model, messages, result, env, maxTokens, options);
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (_isRateLimitError(err)) _markRateLimited(step);
      const label = i === 0 ? 'primary' : 'fallback #' + i;
      console.warn('[providers] ' + label + ' (' + step.provider + '/' + step.model + ') failed:', err.message);
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
async function _continueIfTruncated(providerName, model, messages, partial, env, maxTokens, options) {
  try {
    const jsonMode = !!options.jsonMode;
    const continuation = messages.concat([
      { role: 'assistant', content: partial.text },
      {
        role: 'user',
        content: jsonMode
          ? 'Your last response was cut off mid-JSON. Continue the JSON from the exact character after where you stopped. Output only the raw continuation — no repeated text, no markdown fences, no commentary.'
          : 'Continue directly from where you left off. Do not repeat anything already written.',
      },
    ]);
    const extra = await _dispatch(providerName, continuation, model, env, maxTokens);
    return {
      text: jsonMode ? (partial.text + extra.text).trim() : (partial.text + '\n\n' + extra.text).trim(),
      finishReason: 'stop',
      reasoning: partial.reasoning || extra.reasoning || null,
    };
  } catch (e) {
    // Continuation failing isn't fatal — return what we have.
    return partial;
  }
}
