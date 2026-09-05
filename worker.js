// worker.js
// Main Cloudflare Worker entry point. Routes requests to the appropriate
// handler. Every protected route authenticates independently inside its
// own handler — this router does no auth itself, just dispatch.

import { handlePlansRequest } from './plans-endpoint.js';
import { handleChatRequest } from './chat-endpoint.js';
import { handleImageRequest } from './image-endpoint.js';
import { handleDocumentRequest } from './document-endpoint.js';
import { handlePaymentInitialize } from './payment-endpoint.js';
import { handlePaystackWebhook } from './webhook-endpoint.js';
import { handleAccountRequest, handleUsageRequest } from './account-endpoint.js';
import { handleSubscriptionCancel } from './cancel-endpoint.js';

function _corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*', // tighten to your domain in production
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return _corsPreflight();

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Cognita Worker is running.', { status: 200 });
    }

    if (request.method === 'GET' && url.pathname === '/api/plans') {
      return handlePlansRequest();
    }

    if (request.method === 'GET' && url.pathname === '/api/account') {
      return handleAccountRequest(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/usage') {
      return handleUsageRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      return handleChatRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/image') {
      return handleImageRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/document') {
      return handleDocumentRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/payment/initialize') {
      return handlePaymentInitialize(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/payment/webhook') {
      return handlePaystackWebhook(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/subscription/cancel') {
      return handleSubscriptionCancel(request, env);
    }

    return new Response(JSON.stringify({ error: 'Not found.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
