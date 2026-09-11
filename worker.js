// worker.js

import { handlePlansRequest } from './plans-endpoint.js';
import { handleChatRequest } from './chat-endpoint.js';
import { handleImageRequest } from './image-endpoint.js';
import { handleDocumentRequest } from './document-endpoint.js';

import {
  handleResourceGenerate,
  handleResourceDownload,
  handleResourceList,
} from './resources-endpoint.js';

import {
  handleResourceGet,
  handleResourceUpdate,
  handleResourceVersions,
} from './edit-resource-endpoint.js';

import {
  handleReadyMadeResourceList,
  handleReadyMadeResourceGet,
  handleReadyMadeResourceDownload,
} from './ready-made-resources-endpoint.js';

import {
  handleUseReadyMadeResource,
} from './use-resource-endpoint.js';

import {
  handleCollectionList,
  handleCollectionGet,
} from './collections-endpoint.js';

import {
  handleAdminCollectionList,
  handleAdminCollectionGet,
  handleAdminCollectionCreate,
  handleAdminCollectionUpdate,
  handleAdminCollectionPublish,
  handleAdminCollectionArchive,
} from './admin-collections-endpoint.js';

import {
  handleAdminResourceList,
  handleAdminResourceGet,
  handleAdminResourceGenerate,
  handleAdminResourceUpdate,
  handleAdminResourcePublish,
  handleAdminResourceArchive,
  handleAdminJobList,
  handleAdminJobProcess,
} from './admin-resources-endpoint.js';

import { handlePaymentInitialize } from './payment-endpoint.js';
import { handlePaystackWebhook } from './webhook-endpoint.js';

import {
  handleAccountRequest,
  handleUsageRequest,
} from './account-endpoint.js';

import { handleSubscriptionCancel } from './cancel-endpoint.js';

import {
  handleChatSave,
  handleChatDelete,
  handleChatList,
  handleChatGet,
} from './chat-sync-endpoint.js';

import {
  handleFilesList,
  handleFileGet,
} from './files-endpoint.js';

function _corsPreflight() {
  return new Response(null, {
    status: 204,

    headers: {
      'Access-Control-Allow-Origin': '*',

      'Access-Control-Allow-Methods':
        'GET, POST, PATCH, OPTIONS',

      'Access-Control-Allow-Headers':
        'Content-Type, Authorization',

      'Access-Control-Max-Age':
        '86400',
    },
  });
}

export default {
  async fetch(request, env) {
    if (
      request.method === 'OPTIONS'
    ) {
      return _corsPreflight();
    }

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    if (
      request.method === 'GET' &&
      path === '/'
    ) {
      return new Response(
        'Cognita Worker is running.',
        {
          status: 200,
        }
      );
    }

    if (
      request.method === 'GET' &&
      path === '/api/plans'
    ) {
      return handlePlansRequest();
    }

    if (
      request.method === 'GET' &&
      path === '/api/account'
    ) {
      return handleAccountRequest(
        request,
        env
      );
    }

    if (
      request.method === 'GET' &&
      path === '/api/usage'
    ) {
      return handleUsageRequest(
        request,
        env
      );
    }

    if (
      request.method === 'POST' &&
      path === '/api/chat'
    ) {
      return handleChatRequest(
        request,
        env
      );
    }

    if (
      request.method === 'POST' &&
      path === '/api/chat/save'
    ) {
      return handleChatSave(
        request,
        env
      );
    }

    if (
      request.method === 'POST' &&
      path === '/api/chat/delete'
    ) {
      return handleChatDelete(
        request,
        env
      );
    }

    if (
      request.method === 'GET' &&
      path === '/api/chat/list'
    ) {
      return handleChatList(
        request,
        env
      );
    }

    if (
      request.method === 'GET' &&
      /^\/api\/chat\/[^/]+$/.test(path)
    ) {
      const conversationId =
        path.split('/')[3];

      return handleChatGet(
        request,
        env,
        conversationId
      );
    }

    if (
      request.method === 'POST' &&
      path === '/api/image'
    ) {
      return handleImageRequest(
        request,
        env
      );
    }

    if (
      request.method === 'POST' &&
      path === '/api/document'
    ) {
      return handleDocumentRequest(
        request,
        env
      );
    }

    if (
      request.method === 'GET' &&
      /^\/api\/files\/[^/]+$/.test(path)
    ) {
      const conversationId =
        path.split('/')[3];

      return handleFilesList(
        request,
        env,
        conversationId
      );
    }

    if (
      request.method === 'GET' &&
      /^\/api\/files\/[^/]+\/[^/]+$/.test(
        path
      )
    ) {
      const parts =
        path.split('/');

      return handleFileGet(
        request,
        env,
        parts[3],
        parts[4]
      );
    }

    // ─────────────────────────────────────
    // User Resources
    // ─────────────────────────────────────

    if (
      request.method === 'POST' &&
      path === '/api/resources/generate'
    ) {
      return handleResourceGenerate(
        request,
        env
      );
    }

    if (
      request.method === 'GET' &&
      path === '/api/resources/list'
    ) {
      return handleResourceList(
        request,
        env
      );
    }

    // Resource editor — single resource.
    if (
      request.method === 'GET' &&
      /^\/api\/resources\/[^/]+$/.test(
        path
      )
    ) {
      return handleResourceGet(
        request,
        env,
        path.split('/')[3]
      );
    }

    if (
      request.method === 'PATCH' &&
      /^\/api\/resources\/[^/]+$/.test(
        path
      )
    ) {
      return handleResourceUpdate(
        request,
        env,
        path.split('/')[3]
      );
    }

    // Resource editor — version history.
    if (
      request.method === 'GET' &&
      /^\/api\/resources\/[^/]+\/versions$/.test(
        path
      )
    ) {
      return handleResourceVersions(
        request,
        env,
        path.split('/')[3]
      );
    }

    if (
      request.method === 'POST' &&
      /^\/api\/resources\/[^/]+\/download$/.test(
        path
      )
    ) {
      return handleResourceDownload(
        request,
        env,
        path.split('/')[3]
      );
    }

    // ─────────────────────────────────────
    // Public Ready-made Resources
    // ─────────────────────────────────────

    if (
      request.method === 'GET' &&
      path === '/api/ready-made-resources'
    ) {
      return handleReadyMadeResourceList(
        request,
        env
      );
    }

    if (
      request.method === 'GET' &&
      /^\/api\/ready-made-resources\/[^/]+$/.test(
        path
      )
    ) {
      return handleReadyMadeResourceGet(
        request,
        env,
        path.split('/')[3]
      );
    }

    if (
      request.method === 'POST' &&
      /^\/api\/ready-made-resources\/[^/]+\/download$/.test(
        path
      )
    ) {
      return handleReadyMadeResourceDownload(
        request,
        env,
        path.split('/')[3]
      );
    }

    // ─────────────────────────────────────
    // Use Ready-made Resource
    // ─────────────────────────────────────

    if (
      request.method === 'POST' &&
      /^\/api\/ready-made-resources\/[^/]+\/use$/.test(
        path
      )
    ) {
      return handleUseReadyMadeResource(
        request,
        env,
        path.split('/')[3]
      );
    }

    // ─────────────────────────────────────
    // Public Collections
    // ─────────────────────────────────────

    if (
      request.method === 'GET' &&
      path === '/api/collections'
    ) {
      return handleCollectionList(
        request,
        env
      );
    }

    if (
      request.method === 'GET' &&
      /^\/api\/collections\/[^/]+$/.test(
        path
      )
    ) {
      return handleCollectionGet(
        request,
        env,
        path.split('/')[3]
      );
    }

    // ─────────────────────────────────────
    // Admin Collections
    // ─────────────────────────────────────

    if (
      request.method === 'GET' &&
      path === '/api/admin/collections'
    ) {
      return handleAdminCollectionList(
        request,
        env
      );
    }

    if (
      request.method === 'POST' &&
      path === '/api/admin/collections'
    ) {
      return handleAdminCollectionCreate(
        request,
        env
      );
    }

    if (
      request.method === 'GET' &&
      /^\/api\/admin\/collections\/[^/]+$/.test(
        path
      )
    ) {
      return handleAdminCollectionGet(
        request,
        env,
        path.split('/')[4]
      );
    }

    if (
      request.method === 'PATCH' &&
      /^\/api\/admin\/collections\/[^/]+$/.test(
        path
      )
    ) {
      return handleAdminCollectionUpdate(
        request,
        env,
        path.split('/')[4]
      );
    }

    if (
      request.method === 'POST' &&
      /^\/api\/admin\/collections\/[^/]+\/publish$/.test(
        path
      )
    ) {
      return handleAdminCollectionPublish(
        request,
        env,
        path.split('/')[4]
      );
    }

    if (
      request.method === 'POST' &&
      /^\/api\/admin\/collections\/[^/]+\/archive$/.test(
        path
      )
    ) {
      return handleAdminCollectionArchive(
        request,
        env,
        path.split('/')[4]
      );
    }

    // ─────────────────────────────────────
    // Admin Resources
    // ─────────────────────────────────────

    if (
      request.method === 'GET' &&
      path === '/api/admin/resources'
    ) {
      return handleAdminResourceList(
        request,
        env
      );
    }

    if (
      request.method === 'POST' &&
      path === '/api/admin/resources/generate'
    ) {
      return handleAdminResourceGenerate(
        request,
        env
      );
    }

    if (
      request.method === 'GET' &&
      path === '/api/admin/generation-jobs'
    ) {
      return handleAdminJobList(
        request,
        env
      );
    }

    if (
      request.method === 'GET' &&
      /^\/api\/admin\/resources\/[^/]+$/.test(
        path
      )
    ) {
      return handleAdminResourceGet(
        request,
        env,
        path.split('/')[4]
      );
    }

    if (
      request.method === 'PATCH' &&
      /^\/api\/admin\/resources\/[^/]+$/.test(
        path
      )
    ) {
      return handleAdminResourceUpdate(
        request,
        env,
        path.split('/')[4]
      );
    }

    if (
      request.method === 'POST' &&
      /^\/api\/admin\/resources\/[^/]+\/publish$/.test(
        path
      )
    ) {
      return handleAdminResourcePublish(
        request,
        env,
        path.split('/')[4]
      );
    }

    if (
      request.method === 'POST' &&
      /^\/api\/admin\/resources\/[^/]+\/archive$/.test(
        path
      )
    ) {
      return handleAdminResourceArchive(
        request,
        env,
        path.split('/')[4]
      );
    }

    if (
      request.method === 'POST' &&
      /^\/api\/admin\/generation-jobs\/[^/]+\/process$/.test(
        path
      )
    ) {
      return handleAdminJobProcess(
        request,
        env,
        path.split('/')[4]
      );
    }

    // ─────────────────────────────────────
    // Payments
    // ─────────────────────────────────────

    if (
      request.method === 'POST' &&
      path === '/api/payment/initialize'
    ) {
      return handlePaymentInitialize(
        request,
        env
      );
    }

    if (
      request.method === 'POST' &&
      path === '/api/payment/webhook'
    ) {
      return handlePaystackWebhook(
        request,
        env
      );
    }

    if (
      request.method === 'POST' &&
      path === '/api/subscription/cancel'
    ) {
      return handleSubscriptionCancel(
        request,
        env
      );
    }

    return new Response(
      JSON.stringify({
        error: 'Not found.',
      }),
      {
        status: 404,

        headers: {
          'Content-Type':
            'application/json',
        },
      }
    );
  },
};
