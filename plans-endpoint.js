// plans-endpoint.js

import { PLANS } from './entitlements.js';

export function handlePlansRequest(env) {
  // Allow-list, not a deny-list: only plans explicitly marked `public: true`
  // in entitlements.js are ever returned here. This is what keeps
  // staff-only pseudo-plans (like `admin`) from leaking onto the public
  // marketing page just because someone added them to PLANS — a new
  // non-public plan is safe by default instead of needing to remember to
  // exclude it here.
  const publicPlans = Object.values(PLANS).filter(p => p.public).map(p => ({
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
      'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
