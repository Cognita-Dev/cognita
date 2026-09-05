// plans-endpoint.js
// Public endpoint: GET /api/plans
// Safe for the frontend to call unauthenticated — returns only what's
// needed to render the pricing page. No secrets, no provider names,
// no internal model identifiers ever leave this function.

import { PLANS } from './entitlements.js';

export function handlePlansRequest() {
  const publicPlans = Object.values(PLANS).map(p => ({
    id: p.id,
    name: p.name,
    priceNGN: p.priceNGN,
    priceUSD: p.priceUSD,
    limits: {
      messagesPerDay: p.limits.messagesPerDay,
      imageGenPerDay: p.limits.imageGenPerDay,
      documentGenPerDay: p.limits.documentGenPerDay,
      fileUploadsPerDay: p.limits.fileUploadsPerDay,
      maxFileSizeMB: p.limits.maxFileSizeMB,
    },
    features: p.features,
    hasVision: p.models.vision,
  }));

  return new Response(JSON.stringify({ plans: publicPlans }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
