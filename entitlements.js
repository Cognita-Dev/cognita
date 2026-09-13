// entitlements.js
// SINGLE SOURCE OF TRUTH for plan names, pricing, limits, and model access.
// Nothing else in the codebase should hard-code a plan name, a limit number,
// or a price. Frontend pages fetch this via /api/plans; the Worker imports
// it directly for enforcement.

// Workers AI's free vision-capable model, used for image understanding.
// It's on the Workers AI free tier (10,000 neurons/day), so it never
// touches the paid Groq/OpenRouter usage the rest of this app relies on —
// it's gated by plan (models.vision) and metered separately
// (limits.visionPerDay) below.
export const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

export const PLANS = {
  free: {
    id: 'free',
    name: 'Cognita Starter',
    priceNGN: 0,
    priceUSD: 0,
    paystackPlanCode: null, // no recurring charge for free tier
    limits: {
      messagesPerDay: 25,
      advancedModelPerDay: 0,      // no access to higher-tier models
      imageGenPerDay: 2,
      documentGenPerDay: 3,
      resourceGenPerDay: 3,
      fileUploadsPerDay: 5,
      maxFileSizeMB: 5,
      maxContextMessages: 8,       // how much conversation history is sent
      visionPerDay: 0,             // no image-understanding on Starter
      toolCallsPerDay: 0,          // no connector tool-use on Starter
    },
    models: {
      chat: ['fast'],              // maps to internal model tier keys below
      vision: false,
    },
    features: {
      documentExport: true,        // docx/pdf export, basic
      prioritySupport: false,
      longContext: false,
      designTemplates: false,
      connectorTools: false,       // chat cannot call connected-app tools
    },
  },
  plus: {
    id: 'plus',
    name: 'Cognita Plus',
    priceNGN: 4500,
    priceUSD: 6,
    paystackPlanCode: 'PLN_yoh2zim6qlr20c0',
    limits: {
      messagesPerDay: 300,
      advancedModelPerDay: 60,
      imageGenPerDay: 25,
      documentGenPerDay: 30,
      resourceGenPerDay: 30,
      fileUploadsPerDay: 40,
      maxFileSizeMB: 20,
      maxContextMessages: 24,
      visionPerDay: 15,
      toolCallsPerDay: 30,
    },
    models: {
      chat: ['fast', 'advanced'],
      vision: true,
    },
    features: {
      documentExport: true,
      prioritySupport: false,
      longContext: true,
      designTemplates: true,
      connectorTools: true,
    },
  },
  studio: {
    id: 'studio',
    name: 'Cognita Studio',
    priceNGN: 12000,
    priceUSD: 16,
    paystackPlanCode: 'PLN_23azph4eskh5wwj',
    limits: {
      messagesPerDay: 1200,
      advancedModelPerDay: 400,
      imageGenPerDay: 100,
      documentGenPerDay: 150,
      resourceGenPerDay: 150,
      fileUploadsPerDay: 150,
      maxFileSizeMB: 50,
      maxContextMessages: 60,
      visionPerDay: 60,
      toolCallsPerDay: 150,
    },
    models: {
      chat: ['fast', 'advanced', 'reasoning'],
      vision: true,
    },
    features: {
      documentExport: true,
      prioritySupport: true,
      longContext: true,
      designTemplates: true,
      connectorTools: true,
    },
  },
};

// Can this plan use connected-app tools (GitHub/Google/Figma/Canva)
export function planHasConnectorTools(planId) {
  return !!getPlan(planId).features.connectorTools;
}

// Internal model tier -> actual provider/model mapping.
// Changing a provider or model string only ever happens here.
export const MODEL_TIERS = {
  fast: {
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    fallback: { provider: 'workersai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  },
  advanced: {
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    fallback: { provider: 'openrouter', model: 'openrouter/free' },
  },
  reasoning: {
    provider: 'openrouter',
    model: 'deepseek/deepseek-r1:free',
    fallback: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  },
};

export const PLAN_HIERARCHY = ['free', 'plus', 'studio'];

export function planRank(planId) {
  const i = PLAN_HIERARCHY.indexOf(planId);
  return i === -1 ? 0 : i;
}

export function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

// Is `requiredPlan` satisfied by `userPlan`? (studio satisfies plus, etc.)
export function planSatisfies(userPlan, requiredPlan) {
  return planRank(userPlan) >= planRank(requiredPlan);
}

// Which model tiers can this plan use for chat?
export function allowedChatTiers(planId) {
  return getPlan(planId).models.chat;
}

// Resolve a requested tier down to the highest tier the plan actually permits.
// Never lets a request "upgrade" a user — only ever downgrades to what they're entitled to.
export function resolveChatTier(planId, requestedTier) {
  const allowed = allowedChatTiers(planId);
  if (allowed.includes(requestedTier)) return requestedTier;
  // fall back to the richest tier the plan actually has
  return allowed[allowed.length - 1];
}

// Can this plan attach images to a chat message?
export function planHasVision(planId) {
  return !!getPlan(planId).models.vision;
}
