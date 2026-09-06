// providers.js
// The ONLY module that knows how to talk to Groq, OpenRouter, or Workers AI.
// Callers pass in a resolved model-tier config (from entitlements.js) and
// get back plain text. They never see provider names, model strings, or keys.

async function _callGroq(messages, model, env) {
  const body = { model, max_tokens: 2048, temperature: 0.5, messages };

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

async function _callOpenRouter(messages, model, env) {
  const body = { model, max_tokens: 2048, temperature: 0.5, messages };

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
 * Calls a provider by name. Internal use only — always go through
 * callWithFallback() from outside this file.
 */
async function _dispatch(providerName, messages, model, env) {
  if (providerName === 'groq') return _callGroq(messages, model, env);
  if (providerName === 'openrouter') return _callOpenRouter(messages, model, env);
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
 */
export async function callWithFallback(tierConfig, messages, env) {
  try {
    const result = await _dispatch(tierConfig.provider, messages, tierConfig.model, env);
    if (result.finishReason === 'length') {
      return await _continueIfTruncated(tierConfig.provider, tierConfig.model, messages, result, env);
    }
    return result;
  } catch (primaryErr) {
    console.warn('[providers] primary failed:', primaryErr.message);
    if (!tierConfig.fallback) throw primaryErr;
    try {
      const result = await _dispatch(tierConfig.fallback.provider, messages, tierConfig.fallback.model, env);
      if (result.finishReason === 'length') {
        return await _continueIfTruncated(tierConfig.fallback.provider, tierConfig.fallback.model, messages, result, env);
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
async function _continueIfTruncated(providerName, model, messages, partial, env) {
  try {
    const continuation = messages.concat([
      { role: 'assistant', content: partial.text },
      { role: 'user', content: 'Continue directly from where you left off. Do not repeat anything already written.' },
    ]);
    const extra = await _dispatch(providerName, continuation, model, env);
    return {
      text: (partial.text + '\n\n' + extra.text).trim(),
      finishReason: 'stop',
      reasoning: partial.reasoning || extra.reasoning || null,
    };
  } catch (e) {
    // Continuation failing isn't fatal — return what we have.
    return partial;
  }
}
