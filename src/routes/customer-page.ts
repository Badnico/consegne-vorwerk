/**
 * Pagina cliente minima, senza dipendenze. Mostra la proposta (Sì/No), il messaggio "fuori area"
 * oppure gli slot liberi, aggiornati in tempo reale via Server-Sent Events.
 * I testi arrivano già compilati dal server (scheda Messaggi del pannello).
 */
export function customerPage(state: unknown): string {
  const json = JSON.stringify(state).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>La tua consegna</title>
<style>
:root{--bg:#f3f5f3;--card:#fff;--line:#d5ddd7;--fg:#18231d;--muted:#5d6b63;--accent:#0b7a4b;--accent-soft:#dcefe4;--warn:#a8650a;--err:#b3362b;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111613;--card:#18201b;--line:#2e3a33;--fg:#e4ece7;--muted:#9aaba1;--accent:#3fc283;--accent-soft:#1d3a2b;--warn:#e7a94a;--err:#ef7f73;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px 16px 120px}
main{max-width:560px;margin:0 auto;display:grid;gap:16px}h1{font-size:20px;margin:0}.muted{color:var(--muted)}p{margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;display:grid;gap:8px}
.when{font-size:18px;font-weight:700}.row{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;font-weight:600;border-radius:8px;padding:12px 16px;border:1px solid var(--accent);background:var(--card);color:var(--accent);cursor:pointer}
button.primary{background:var(--accent);color:var(--card)}button:disabled{opacity:.5;cursor:not-allowed}
.day h2{font-size:13px;text-transform:capitalize;color:var(--muted);margin:8px 0 6px;font-weight:600}
.slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.slot{text-align:left;color:var(--fg);border-color:var(--line);display:grid;gap:2px;padding:10px}
.slot small{font-weight:500;color:var(--accent)}.slot.few small{color:var(--warn)}
.slot[aria-pressed=true]{border-color:var(--accent);background:var(--accent-soft)}
.slot:disabled small{color:var(--muted)}.slot:disabled b{text-decoration:line-through;color:var(--muted)}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px}
.bar .in{max-width:560px;margin:0 auto;display:grid;gap:6px}.err{color:var(--err);margin:0}
</style></head><body><main id="app"></main><div class="bar" id="bar" hidden><div class="in"><p class="err" id="err" hidden></p><button class="primary" id="ok" disabled>Seleziona una fascia</button></div></div>
<script>
const base = location.pathname.replace(/\\/$/, '');
let state = ${json}, avail = null, pick = null, busy = false;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const txt = (s) => esc(s).replace(/\\n/g, '<br>');
const long = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const when = (s) => s ? long(s.date) + ', ' + s.start + '–' + s.end : '';

async function api(path, body) {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'Operazione non riuscita. Riprova.');
  return j;
}

if (state && state.company) document.title = 'La tua consegna · ' + state.company;
function render() {
  const app = $('#app'), bar = $('#bar'), T = state && state.texts;
  if (!state) { app.innerHTML = '<h1>Link non valido</h1><p class="muted">Il link è scaduto o non è corretto. Contatta chi ti ha mandato il messaggio.</p>'; bar.hidden = true; return; }
  const head = '<h1>Ciao ' + esc(state.first_name) + '</h1><p class="muted">Ordine ' + esc(state.order_ref) + ' · ' + esc(state.product || '') + ' · ' + esc(state.address_short) + '</p>';
  bar.hidden = true;
  if (state.status === 'proposed') {
    const pre = new URLSearchParams(location.search).get('scelta');
    app.innerHTML = head + '<div class="card"><p>' + txt(T.body) + '</p><span class="muted">Consegna proposta</span><span class="when">' + esc(when(state.proposed)) + '</span><p>' + txt(T.question) + '</p><div class="row"><button class="primary" id="yes">' + esc(T.yes) + '</button><button id="no">' + esc(T.no) + '</button></div></div>';
    $('#yes').onclick = () => act('/confirm'); $('#no').onclick = () => act('/decline');
    if (pre === 'si') $('#yes').focus(); if (pre === 'no') $('#no').focus();
    return;
  }
  if (state.status === 'confirmed') {
    app.innerHTML = head + '<div class="card"><p>' + txt(T.confirmed) + '</p><div class="row"><button id="chg">Cambia data</button></div></div>';
    $('#chg').onclick = () => act('/decline'); return;
  }
  if (state.status === 'out_of_area') { app.innerHTML = head + '<div class="card"><p>' + txt(T.out_of_area) + '</p></div>'; return; }
  if (state.status === 'delivered') { app.innerHTML = head + '<div class="card"><p class="when">Consegna effettuata ✓</p></div>'; return; }
  if (state.status === 'cancelled') { app.innerHTML = head + '<div class="card"><p>Questa consegna non è più modificabile.</p></div>'; return; }
  // to_reschedule, rescheduled, no_response: scelta dello slot
  const cur = state.slot && state.status === 'rescheduled' ? '<div class="card"><p>' + txt(T.rescheduled) + '</p></div>' : '';
  let list = '<p class="muted">Caricamento delle fasce disponibili…</p>';
  if (avail) {
    const days = {};
    for (const s of avail.slots) (days[s.date] ||= []).push(s);
    list = Object.keys(days).map((d) => '<div class="day"><h2>' + long(d) + '</h2><div class="slots">' + days[d].map((s) => {
      const on = pick === s.id, full = s.free <= 0 && !s.mine;
      const lab = s.mine ? 'La tua fascia' : full ? 'Completo' : s.free === 1 ? 'Ultimo posto' : s.free + ' posti';
      return '<button class="slot ' + (s.free > 0 && s.free <= 2 ? 'few' : '') + '" data-id="' + s.id + '" aria-pressed="' + on + '" ' + (full || s.mine ? 'disabled' : '') + '><b>' + s.start + '–' + s.end + '</b><small>' + lab + '</small></button>';
    }).join('') + '</div></div>').join('') || '<p class="muted">Nessuna fascia disponibile nei prossimi giorni. Contatta il servizio clienti.</p>';
  }
  app.innerHTML = head + cur + '<div class="card"><strong>' + txt(T.page_title) + '</strong><span class="muted">' + txt(T.page_note) + '</span></div>' + list;
  app.querySelectorAll('.slot').forEach((b) => b.onclick = () => { pick = b.dataset.id; render(); });
  bar.hidden = false;
  const sel = avail && avail.slots.find((s) => s.id === pick);
  if (pick && (!sel || sel.free <= 0)) { pick = null; showErr('La fascia scelta si è appena riempita. Scegline un\\'altra.'); }
  $('#ok').disabled = !pick || busy;
  $('#ok').textContent = sel && pick ? T.page_button.replace('{data}', long(sel.date)).replace('{fascia}', sel.start + '–' + sel.end) : 'Seleziona una fascia';
}

function showErr(m) { const e = $('#err'); e.textContent = m; e.hidden = !m; }
async function loadAvail() { try { avail = await api('/availability'); render(); } catch (e) { showErr(e.message); } }
async function act(path, body) {
  busy = true; showErr('');
  try {
    state = await api(path, body || {}); // sempre POST, anche senza dati (Sì / No)
    if (['to_reschedule', 'rescheduled', 'no_response'].includes(state.status)) { await loadAvail(); startStream(); }
  } catch (e) { const p = document.createElement('p'); p.className = 'err'; p.textContent = e.message; $('#app').append(p); }
  busy = false; pick = null; render();
}
$('#ok').onclick = () => pick && act('/book', { slot_id: pick });

let es = null;
function startStream() {
  if (es || !window.EventSource) return;
  es = new EventSource(base + '/availability/stream');
  let t = null;
  es.addEventListener('slots', () => { clearTimeout(t); t = setTimeout(loadAvail, 250); });
}
render();
if (state && ['to_reschedule', 'rescheduled', 'no_response'].includes(state.status)) { loadAvail(); startStream(); }
</script></body></html>`;
}
