// js/router.js
// Switches between the chat / resources / library views inside app.html
// without a full page navigation. Uses a `?view=` query param on the
// one real file (not a fake path) so refresh, back/forward and shared
// links all keep working with no server rewrite rules needed.

import { closeMobileSidebar } from './shell.js';

const VIEWS = {
  chat: {
    containerId: 'view-chat',
    load: () => import('./app.js'),
  },
  resources: {
    containerId: 'view-resources',
    load: () => import('./resources.js'),
  },
  library: {
    containerId: 'view-library',
    load: () => import('./library.js'),
  },
  reminders: {
    containerId: 'view-reminders',
    load: () => import('./reminders.js'),
  },
};

const mountedModules = {};

function viewFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('view');
  return VIEWS[requested] ? requested : 'chat';
}

function setActiveNav(view) {
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.classList.toggle('is-active', el.getAttribute('data-view') === view);
  });
}

function setActiveUsageWidget(view) {
  const chatWidget = document.getElementById('usageWidgetChat');
  const resourcesWidget = document.getElementById('usageWidgetResources');
  if (chatWidget) chatWidget.hidden = view !== 'chat';
  if (resourcesWidget) resourcesWidget.hidden = view !== 'resources';
}

let currentView = null;

export async function navigate(view, { replace = false } = {}) {
  if (!VIEWS[view]) view = 'chat';

  Object.keys(VIEWS).forEach((key) => {
    document.getElementById(VIEWS[key].containerId).hidden = key !== view;
  });
  setActiveNav(view);
  setActiveUsageWidget(view);

  const url = new URL(window.location.href);
  url.searchParams.set('view', view);
  if (replace) {
    window.history.replaceState({ view }, '', url);
  } else if (currentView !== view) {
    window.history.pushState({ view }, '', url);
  }
  currentView = view;

  if (!mountedModules[view]) {
    try {
      const mod = await VIEWS[view].load();
      mountedModules[view] = mod;
      if (typeof mod.mount === 'function') {
        await mod.mount();
      }
    } catch (e) {
      // Forget the half-loaded view so the next visit tries again, and
      // show a visible message instead of an empty/"loading" screen.
      delete mountedModules[view];
      console.error('[router] could not load view "' + view + '":', e);
      const container = document.getElementById(VIEWS[view].containerId);
      if (container && !container.querySelector('.view-load-error')) {
        const box = document.createElement('div');
        box.className = 'view-load-error';
        box.style.cssText = 'padding:24px;text-align:center;';
        box.textContent = 'Sorry, this page could not load. Please refresh and try again.';
        container.prepend(box);
      }
      return null;
    }
  }

  return mountedModules[view];
}

export function currentMountedView(view) {
  return mountedModules[view];
}

export function initRouter() {
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const view = el.getAttribute('data-view');
      if (!VIEWS[view]) return;
      e.preventDefault();
      // On mobile the sidebar is a temporary overlay — picking a
      // destination should tuck it away so the view underneath is
      // visible, the same way choosing a past chat already does.
      // This only touches the route links themselves, so it never
      // interferes with the account menu / Settings, which lives
      // outside the nav and isn't wired here.
      closeMobileSidebar();
      navigate(view);
    });
  });

  // New Chat always means "go to the chat view and start fresh" — it's
  // reachable from every view, so it's wired centrally here rather than
  // inside app.js, which may not have mounted yet.
  const newChatBtn = document.getElementById('newChatBtn');
  if (newChatBtn) {
    newChatBtn.addEventListener('click', async () => {
      closeMobileSidebar();
      await navigate('chat');
      window.dispatchEvent(new CustomEvent('cognita:new-chat'));
    });
  }

  window.addEventListener('popstate', () => {
    navigate(viewFromLocation(), { replace: true });
  });

  return navigate(viewFromLocation(), { replace: true });
}
