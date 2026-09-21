// js/pwa-install.js
// Registers the service worker as early as possible so it's ready before
// the Reminders view tries to subscribe to push. Runs on every app.html
// load, regardless of which view is open.

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/pwa/sw.js', { scope: '/' }).catch((e) => {
      console.error('[pwa] service worker registration failed:', e.message);
    });
  });

  // A notification tap focuses/opens a window and posts this so the SPA
  // router can jump straight to the right view without a full reload.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'cognita:navigate' && event.data.url) {
      const url = new URL(event.data.url, window.location.origin);
      const view = url.searchParams.get('view');
      if (view) {
        import('./router.js').then((router) => router.navigate(view));
      }
    }
  });
}
