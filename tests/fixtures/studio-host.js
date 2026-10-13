// Test host: mounts the real Studio the way app.html does, with a stub for the account object (no network needed for these features).
window.Auth = { authedFetch: async () => ({ ok: false, status: 401, json: async () => ({}) }), getToken: async () => null, currentUser: null };
window.__studio = await import('/studio/studio.js');
await window.__studio.mount();
window.__ready = true;
