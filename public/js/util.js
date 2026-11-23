// Utilitas tampilan: templating aman (auto-escape), format, ikon, toast, modal.

// ───────── templating aman ─────────
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s));
export function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function render(v) {
  if (v == null || v === false || v === true) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}
/** html`<p>${userText}</p>`: semua interpolasi di-escape kecuali yang dibungkus raw()/html``. */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Safe(out);
}
export const mount = (el, safe) => { el.innerHTML = String(safe); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function on(root, type, selector, handler) {
  root.addEventListener(type, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) handler(e, t);
  });
}

export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ───────── format ─────────
export const rupiah = (n) => 'Rp' + Math.round(Number(n) || 0).toLocaleString('id-ID');
export const num = (n, d = 1) => Number(n).toLocaleString('id-ID', { maximumFractionDigits: d });
export const kg = (n) => `${num(n, 2)} kg`;
const tz = 'Asia/Jakarta';
export const fmtDate = (iso) => new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: tz }).replace(':', '.');
export const fmtDateTime = (iso) => `${new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: tz })}, ${fmtTime(iso)}`;
export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} hari lalu`;
  return fmtDate(iso);
}
export const initials = (name) => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
export const waLink = (wa, text) => `https://wa.me/${wa}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
export const mapsLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
export const phonePretty = (p) => String(p).replace(/^(\d{4})(\d{4})(\d+)$/, '$1-$2-$3');

export const HANDOVER = { dropoff: 'Antar sendiri ke outlet', pickup: 'Dijemput kurir' };
export const RETURN = { self: 'Ambil sendiri di outlet', delivery: 'Diantar kurir' };

const STATUS_TONE = { received: 'wait', pickup: 'work', weighed: 'work', washing: 'work', drying: 'work', finishing: 'work', ready: 'ready', delivering: 'ready', done: 'ok', cancelled: 'off' };
export const statusChip = (o) => html`<span class="chip chip-${STATUS_TONE[o.status] || 'work'}"><i></i>${o.statusLabel}</span>`;
export const payChip = (o) => {
  const p = o.payment.status;
  if (p === 'paid') return html`<span class="chip chip-ok">Lunas</span>`;
  if (p === 'refunded') return html`<span class="chip chip-off">Dikembalikan</span>`;
  if (!o.billing.isFinal) return html`<span class="chip chip-off">Tagihan belum final</span>`;
  return html`<span class="chip chip-wait">Belum dibayar</span>`;
};

// ───────── ikon (gaya garis, 24×24) ─────────
const P = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.7a1 1 0 0 0-.2-.6l-3.5-4.4A1 1 0 0 0 17.5 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  drop: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7Z"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  layers: '<path d="m12 2-10 5 10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  iron: '<path d="M2 18h19a1 1 0 0 0 1-1 8 8 0 0 0-8-8H9a7 7 0 0 0-7 7v2Z"/><path d="M7 13h6"/>',
  washer: '<rect x="3" y="2" width="18" height="20" rx="2"/><circle cx="12" cy="14" r="5"/><path d="M7 6h.01M11 6h2"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v1M14 20h1M18 18v3h3M20 17h1"/>',
  bank: '<path d="M3 21h18M5 21V10m4 11V10m6 11V10m4 11V10M2 10l10-7 10 7"/>',
  wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><path d="M16 13h2"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10Z"/><path d="M9 22V12h6v10"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  box: '<path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  locate: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/>',
  whatsapp: '<path d="M3 21l1.7-5A8.5 8.5 0 1 1 8 19.3L3 21Z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.3-1.3-2-1-1 .7a3.5 3.5 0 0 1-1.7-1.7l.7-1-1-2L9 9.5Z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M9.9 4.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.4M6.6 6.6A16.6 16.6 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  alert: '<path d="m10.3 3.9-8.4 14.5A2 2 0 0 0 3.6 21h16.8a2 2 0 0 0 1.7-2.6L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  scale: '<path d="M12 3v18M5 21h14M5 7l-3 8a4 4 0 0 0 6 0L5 7Zm14 0-3 8a4 4 0 0 0 6 0l-3-8ZM5 7h14"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8Z"/><path d="M7 7h.01"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
};
export function icon(name, size = 20, cls = '') {
  return raw(`<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`);
}
export const serviceIcon = (id) => icon({ regular: 'washer', express: 'zap', 'wash-fold': 'layers', 'wash-iron': 'iron' }[id] || 'washer', 22);

// ───────── toast ─────────
export function toast(message, type = 'info') {
  const root = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  t.innerHTML = String(html`${icon(type === 'error' ? 'alert' : type === 'ok' ? 'check' : 'info', 18)}<span>${message}</span>`);
  root.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, type === 'error' ? 6000 : 3800);
}

// ───────── modal (elemen <dialog> bawaan: fokus terkunci + ESC) ─────────
export function openModal({ title, body, wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const d = document.createElement('dialog');
  d.className = `modal${wide ? ' modal-wide' : ''}`;
  d.innerHTML = String(html`
    <div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Tutup">${icon('x', 20)}</button></div>
    <div class="modal-body">${body}</div>`);
  root.appendChild(d);
  const close = () => { if (d.open) d.close(); };
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) close(); });
  d.addEventListener('close', () => { d.remove(); onClose && onClose(); });
  d.showModal();
  return { el: d, close, body: d.querySelector('.modal-body') };
}

// Tampilkan pesan galat form di bawah input bernama (fields: { nama: 'pesan' }).
export function showFieldErrors(form, fields = {}) {
  $$('.field-err', form).forEach((n) => n.remove());
  $$('.invalid', form).forEach((n) => n.classList.remove('invalid'));
  let first = null;
  for (const [name, msg] of Object.entries(fields)) {
    const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
    const holder = input ? (input.closest('.field') || input.parentElement) : form.querySelector(`[data-field="${CSS.escape(name)}"]`);
    if (!holder) continue;
    if (input) input.classList.add('invalid');
    const p = document.createElement('p');
    p.className = 'field-err';
    p.textContent = msg;
    holder.appendChild(p);
    first = first || input || holder;
  }
  if (first && first.focus) first.focus({ preventScroll: false });
  else if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
