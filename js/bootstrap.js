// js/bootstrap.js
// One-time first-admin bootstrap page, meant to be opened directly on a
// phone browser — no console or curl needed. Signs in via the same
// window.Auth used everywhere else, then makes the single bootstrap call
// with a tap.

const WORKER_URL = 'https://cognita.cognitai.workers.dev';

(async function init() {
  const statusLine = document.getElementById('statusLine');
  const user = await window.Auth.ready();

  if (!user) {
    statusLine.textContent = 'You need to be signed in first.';
    document.getElementById('signInWrap').hidden = false;
    document.getElementById('goToLoginBtn').addEventListener('click', () => {
      window.location.href = '/login.html?next=/bootstrap.html';
    });
    return;
  }

  statusLine.textContent = 'Signed in.';
  document.getElementById('bootstrapWrap').hidden = false;
  document.getElementById('signedInAs').textContent =
    'Signed in as: ' + (user.email || user.uid);

  document.getElementById('submitBtn').addEventListener('click', async () => {
    const secret = document.getElementById('secretInput').value.trim();
    const resultLine = document.getElementById('resultLine');
    const btn = document.getElementById('submitBtn');

    if (!secret) {
      resultLine.textContent = 'Enter the bootstrap secret first.';
      resultLine.style.color = '#7A2E3A';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Working...';

    try {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });

      const data = await res.json();

      if (!res.ok) {
        resultLine.textContent = data.error || 'Bootstrap failed.';
        resultLine.style.color = '#7A2E3A';
        btn.disabled = false;
        btn.textContent = 'Make this account the first admin';
        return;
      }

      resultLine.textContent = 'Success! You are now an admin. You can now visit /admin.html.';
      resultLine.style.color = '#3F6B5B';
      btn.textContent = 'Done';
    } catch (e) {
      resultLine.textContent = 'Could not reach the server. Check your connection and try again.';
      resultLine.style.color = '#7A2E3A';
      btn.disabled = false;
      btn.textContent = 'Make this account the first admin';
      console.error('[bootstrap] failed:', e.message);
    }
  });
})();
