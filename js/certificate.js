// js/certificate.js
// Public certificate page. It asks the Worker whether a certificate number is real and shows the name, course and date.
// It needs no sign-in, so an employer or school can check a certificate. It never shows anything private.
(function () {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const API = local ? '' : 'https://api.cognita.com.ng';
  const $ = (id) => document.getElementById(id);
  const status = $('certStatus'), sheet = $('certSheet');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const id = (new URLSearchParams(location.search).get('id') || '').trim().toUpperCase();

  function fail(msg, cls) { status.textContent = msg; status.className = 'cert-status ' + (cls || 'cert-status--bad'); }

  if (!/^CGN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(id)) { fail('Enter a certificate number in the address, like certificate.html?id=CGN-XXXX-XXXX-XXXX.'); return; }

  fetch(API + '/api/learna/certificates/verify?id=' + encodeURIComponent(id))
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      if (!ok) return fail(j.error || 'That certificate could not be checked.');
      if (!j.certificate) return fail('Certificate not found. Check the number and try again.');
      const c = j.certificate;
      const date = new Date(c.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      sheet.innerHTML = `<div class="cert-frame"><p class="cert-brand">Cognita Learna</p><h1 class="cert-title">${esc(c.certificateTitle)}</h1>
        <p class="cert-small">This certifies that</p><p class="cert-name">${esc(c.name)}</p>
        <p class="cert-small">has met every requirement of the course</p><p class="cert-course">${esc(c.courseTitle)}</p>
        <p class="cert-small">Issued on ${esc(date)}</p>
        <dl class="cert-meta"><div><dt>Certificate number</dt><dd>${esc(c.id)}</dd></div><div><dt>Course version</dt><dd>${esc(c.courseVersion)}</dd></div></dl>
        <p class="cert-verify">Check this certificate at ${esc(location.host)}/certificate.html?id=${esc(c.id)}</p></div>`;
      sheet.hidden = false; $('certNote').hidden = false; $('certPrint').hidden = false;
      if (c.revoked) { fail('This certificate is no longer valid. It was withdrawn on ' + new Date(c.revokedAt).toLocaleDateString('en-GB') + '.'); sheet.classList.add('cert-sheet--void'); }
      else { status.textContent = 'Valid. This certificate was issued by Cognita Learna.'; status.className = 'cert-status cert-status--ok'; }
      document.title = c.name + ' · ' + c.courseTitle + ' · Cognita';
    })
    .catch(() => fail('Could not reach Cognita to check this certificate. Check your connection and try again.'));

  $('certPrint').addEventListener('click', () => window.print());
})();
