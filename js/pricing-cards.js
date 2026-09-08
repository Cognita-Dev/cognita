// js/pricing-cards.js
// Renders pricing cards on the public homepage from the public /api/plans
// endpoint, and wires up the "choose plan" flow WITHOUT ever trusting the
// client for anything billing-related.
//
// Flow on CTA click:
//   1. Check local Firebase auth state (free — no Worker call).
//   2. Logged in  -> go straight to /payment.html?plan=X, which re-verifies
//      the user server-side and re-derives price/plan from entitlements.js.
//   3. Logged out -> go to /signup.html?plan=X first. After they create an
//      account (or sign in instead), that page redirects them on to
//      /payment.html?plan=X for us.
//
// The plan id we pass around here is only ever used to pick which button
// the user meant to click / where to send them next — the Worker never
// trusts it as a source of truth for price or entitlement.

const WORKER_URL = 'https://cognita.cognitai.workers.dev';
const CACHE_KEY = 'cognita:plans-cache:v1';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches the endpoint's own Cache-Control

// Marketing copy that doesn't need to live in the Worker. Numbers (limits,
// price) always come from the live /api/plans response so they can never
// drift out of sync with entitlements.js.
const PLAN_COPY = {
  free: {
    tagline: 'Try Cognita with no commitment.',
    icon: 'ph-sparkle',
    highlight: false,
  },
  plus: {
    tagline: 'For regular use — documents, research, everyday work.',
    icon: 'ph-lightning',
    highlight: true,
    badge: 'Most popular',
  },
  studio: {
    tagline: 'For heavy, daily use and priority support.',
    icon: 'ph-crown-simple',
    highlight: false,
  },
};

function formatNaira(amount) {
  if (!amount) return 'Free';
  return '₦' + amount.toLocaleString('en-NG');
}

function buildFeatureList(plan) {
  const items = [];
  items.push(plan.limits.messagesPerDay.toLocaleString() + ' messages / day');
  if (plan.hasVision) items.push('Image understanding (' + plan.limits.visionPerDay + '/day)');
  items.push(plan.limits.documentGenPerDay + ' document exports / day');
  items.push(plan.limits.imageGenPerDay + ' image generations / day');
  items.push('Up to ' + plan.limits.maxFileSizeMB + 'MB per file upload');
  if (plan.features.longContext) items.push('Extended conversation memory');
  if (plan.features.prioritySupport) items.push('Priority support');
  return items;
}

function cardHtml(plan) {
  const copy = PLAN_COPY[plan.id] || {};
  const isFree = plan.id === 'free';
  const ctaLabel = isFree ? 'Get started free' : 'Choose ' + plan.name;
  const priceHtml = isFree
    ? '<span class="pricing-card-price">Free</span>'
    : '<span class="pricing-card-price">' + formatNaira(plan.priceNGN) +
      '<span class="price-period">/month</span></span>';

  return (
    '<div class="pricing-card' + (copy.highlight ? ' is-highlighted' : '') + '">' +
      (copy.badge ? '<span class="pricing-badge">' + copy.badge + '</span>' : '') +
      '<div class="pricing-card-icon"><i class="ph ' + (copy.icon || 'ph-star') + '"></i></div>' +
      '<div class="pricing-card-name">' + plan.name + '</div>' +
      '<p class="pricing-card-tagline">' + (copy.tagline || '') + '</p>' +
      priceHtml +
      '<button type="button" class="pricing-cta' + (copy.highlight ? ' pricing-cta--primary' : '') +
        '" data-plan-id="' + plan.id + '">' + ctaLabel + '</button>' +
      '<ul class="pricing-feature-list">' +
        buildFeatureList(plan).map((f) => '<li><i class="ph ph-check"></i><span>' + f + '</span></li>').join('') +
      '</ul>' +
    '</div>'
  );
}

async function getPlans() {
  try {
    const cachedRaw = sessionStorage.getItem(CACHE_KEY);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw);
      if (Date.now() - cached.ts < CACHE_TTL_MS && Array.isArray(cached.plans)) {
        return cached.plans;
      }
    }
  } catch (e) {
    // Corrupt cache entry — ignore and refetch.
  }

  const res = await fetch(WORKER_URL + '/api/plans');
  if (!res.ok) throw new Error('Could not load plans.');
  const data = await res.json();

  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), plans: data.plans }));
  } catch (e) {
    // sessionStorage full/unavailable — non-fatal, just means no caching this session.
  }

  return data.plans;
}

async function handlePlanClick(planId) {
  const params = new URLSearchParams(window.location.search);

  if (planId === 'free') {
    // Free requires no payment step at all.
    try {
      const { Auth } = await import('/js/auth.js');
      await Auth.ready();
      window.location.href = Auth.getCurrentUser() ? '/app.html' : '/signup.html';
    } catch (e) {
      window.location.href = '/signup.html';
    }
    return;
  }

  try {
    const { Auth } = await import('/js/auth.js');
    await Auth.ready();
    if (Auth.getCurrentUser()) {
      window.location.href = '/payment.html?plan=' + encodeURIComponent(planId);
    } else {
      window.location.href = '/signup.html?plan=' + encodeURIComponent(planId);
    }
  } catch (e) {
    // If auth failed to even load, safest fallback is to route through
    // signup — the payment page itself will redirect to login if needed.
    window.location.href = '/signup.html?plan=' + encodeURIComponent(planId);
  }
}

(async function initPricingCards() {
  const grid = document.getElementById('pricingGrid');
  if (!grid) return;

  try {
    const plans = await getPlans();
    // Keep a stable, deliberate order regardless of what the Worker returns.
    const order = ['free', 'plus', 'studio'];
    const sorted = [...plans].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    grid.innerHTML = sorted.map(cardHtml).join('');

    grid.querySelectorAll('.pricing-cta').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.disabled = true;
        handlePlanClick(btn.dataset.planId);
      });
    });
  } catch (e) {
    console.error('[pricing-cards] failed to load plans:', e.message);
    grid.innerHTML =
      '<p class="pricing-note">Couldn\'t load pricing right now. Please refresh the page.</p>';
  }
})();
