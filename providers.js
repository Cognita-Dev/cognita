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
 */
export async function callWithFallback(tierConfig, messages, env, options = {}) {
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;

  try {
    const result = await _dispatch(tierConfig.provider, messages, tierConfig.model, env, maxTokens);
    if (result.finishReason === 'length') {
      return await _continueIfTruncated(tierConfig.provider, tierConfig.model, messages, result, env, maxTokens, options);
    }
    return result;
  } catch (primaryErr) {
    console.warn('[providers] primary failed:', primaryErr.message);
    if (!tierConfig.fallback) throw primaryErr;
    try {
      const result = await _dispatch(tierConfig.fallback.provider, messages, tierConfig.fallback.model, env, maxTokens);
      if (result.finishReason === 'length') {
        return await _continueIfTruncated(tierConfig.fallback.provider, tierConfig.fallback.model, messages, result, env, maxTokens, options);
      }
      return result;
    } catch (fallbackErr) {
      console.error('[providers] fallback also failed:', fallbackErr.message);
      throw new Error('All providers unavailable.');
    }
  }
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
