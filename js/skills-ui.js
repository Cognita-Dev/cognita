// js/skills-ui.js
// Settings > Skills: list, add, edit, turn on/off and delete the person's own skills (GET/PUT/DELETE /api/skills).
// All text is written with textContent (never innerHTML), so a skill can never inject markup into the page.

const WORKER_URL = 'https://api.cognita.com.ng';
const $ = (id) => document.getElementById(id);

export function mountSkills({ fetcher, baseUrl = WORKER_URL } = {}) {
  const list = $('skillsList'), form = $('skillForm'), addBtn = $('skillAdd');
  if (!list || !form || !addBtn) return null;
  const f = fetcher || ((u, o) => window.Auth.authedFetch(u, o));
  const msg = $('skillMsg'), saveBtn = $('skillSave');
  let skills = [], editing = null, busy = false;

  const say = (t, bad) => { msg.textContent = t || ''; msg.style.color = bad ? '#c0392b' : ''; };
  const call = async (method, query, body) => {
    const res = await f(baseUrl + '/api/skills' + (query || ''), body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method });
    let data = {}; try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  };

  function row(k) {
    const r = document.createElement('div'); r.className = 'settings-row'; r.dataset.skill = k.name;
    const t = document.createElement('div'); t.className = 'settings-row-usage-text';
    const a = document.createElement('span'); a.className = 'settings-row-label'; a.textContent = k.name + (k.enabled ? '' : ' (off)');
    const b = document.createElement('span'); b.className = 'settings-row-value'; b.textContent = k.description;
    t.append(a, b);
    const mk = (label, fn) => { const x = document.createElement('button'); x.type = 'button'; x.className = 'settings-row--button'; x.textContent = label; x.addEventListener('click', fn); return x; };
    r.append(t,
      mk(k.enabled ? 'Turn off' : 'Turn on', () => act(() => call('PUT', '', { ...k, originalName: k.name, enabled: !k.enabled }))),
      mk('Edit', () => open(k)),
      mk('Delete', () => { if (window.confirm('Delete the skill "' + k.name + '"?')) act(() => call('DELETE', '?name=' + encodeURIComponent(k.name))); }));
    return r;
  }
  function render() {
    list.replaceChildren();
    if (!skills.length) { const e = document.createElement('div'); e.className = 'settings-row'; e.textContent = 'No skills yet.'; list.append(e); }
    else skills.forEach((k) => list.append(row(k)));
    addBtn.hidden = skills.length >= 10 && !editing;
  }
  async function act(fn) {
    if (busy) return; busy = true;
    try { const d = await fn(); skills = d.skills || skills; say(''); render(); close(); }
    catch (e) { say(e.message, true); if (form.hidden) alert(e.message); }
    finally { busy = false; }
  }
  function open(k) {
    editing = k || null;
    $('skillName').value = k ? k.name : ''; $('skillDesc').value = k ? k.description : '';
    $('skillInstr').value = k ? k.instructions : ''; $('skillTriggers').value = k ? (k.triggers || []).join(', ') : '';
    form.hidden = false; form.style.display = 'flex'; say(''); $('skillName').focus();
  }
  function close() { editing = null; form.hidden = true; form.style.display = 'none'; form.reset(); say(''); }

  addBtn.addEventListener('click', () => open(null));
  $('skillCancel').addEventListener('click', close);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const body = { name: $('skillName').value, description: $('skillDesc').value, instructions: $('skillInstr').value, triggers: $('skillTriggers').value, enabled: editing ? editing.enabled : true };
    if (editing) body.originalName = editing.name;
    saveBtn.disabled = true; say('Saving…');
    try { await act(() => call('PUT', '', body)); } finally { saveBtn.disabled = false; }
  });

  return {
    async load() {
      try { const d = await call('GET'); skills = d.skills || []; render(); }
      catch (e) { list.replaceChildren(); const x = document.createElement('div'); x.className = 'settings-row'; x.textContent = 'Could not load your skills.'; list.append(x); }
    },
    get skills() { return skills; },
  };
}
