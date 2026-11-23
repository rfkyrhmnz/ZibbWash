// Titik masuk: router berbasis hash (#/...), kerangka halaman per role, dan sesi login.
import { get, post, ApiError } from './api.js';
import { html, mount, $, $$, on, icon, toast, openModal, showFieldErrors, initials } from './util.js';
import { state, runCleanups, go, homeFor } from './state.js';
import { startRealtime, stopRealtime } from './realtime.js';
import { landingView } from './views/landing.js';
import { authView } from './views/auth.js';
import * as customer from './views/customer.js';
import * as admin from './views/admin.js';

const app = document.getElementById('app');

const routes = [
  { re: /^\/$/, shell: 'public', view: landingView },
  { re: /^\/masuk$/, shell: 'bare', view: authView },
  { re: /^\/app$/, shell: 'customer', role: 'customer', view: customer.dashboard },
  { re: /^\/app\/pesan$/, shell: 'customer', role: 'customer', view: customer.orderForm },
  { re: /^\/app\/pesanan$/, shell: 'customer', role: 'customer', view: customer.orders },
  { re: /^\/app\/pesanan\/([^/]+)$/, shell: 'customer', role: 'customer', view: customer.tracking },
  { re: /^\/app\/stamp$/, shell: 'customer', role: 'customer', view: customer.stamps },
  { re: /^\/admin$/, shell: 'admin', role: 'admin', view: admin.orders },
  { re: /^\/admin\/pesanan\/([^/]+)$/, shell: 'admin', role: 'admin', view: admin.orders },
  { re: /^\/admin\/pelanggan$/, shell: 'admin', role: 'admin', view: admin.customers },
  { re: /^\/admin\/pengaturan$/, shell: 'admin', role: 'admin', view: admin.settings },
];

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(qs || '') };
}

let currentShell = null;
let lastPath = null;

// ───────── kerangka halaman ─────────
function customerShell() {
  const u = state.user;
  const need = state.config.loyalty.stampsForReward;
  return html`
    <div class="shell shell-customer">
      <header class="topbar">
        <a class="brand" href="#/app"><img src="/img/logo-mark.png" alt="" width="34" height="38"><span>ZibbWash</span></a>
        <nav class="topnav" aria-label="Menu utama">
          <a href="#/app" data-nav="/app">Beranda</a>
          <a href="#/app/pesan" data-nav="/app/pesan">Pesan</a>
          <a href="#/app/pesanan" data-nav="/app/pesanan">Pesanan saya</a>
          <a href="#/app/stamp" data-nav="/app/stamp">Kartu stamp</a>
        </nav>
        <div class="topbar-right">
          <a class="stamp-pill" href="#/app/stamp" title="Stamp terkumpul">${icon('drop', 16)}<span data-user-stamps>${u.stamps}/${need}</span></a>
          <details class="usermenu">
            <summary aria-label="Menu akun"><span class="avatar">${initials(u.name)}</span></summary>
            <div class="usermenu-pop">
              <p><b>${u.name}</b><small>${u.phone}</small></p>
              <button data-act="password">${icon('lock', 18)}Ganti kata sandi</button>
              <button data-act="logout">${icon('out', 18)}Keluar</button>
            </div>
          </details>
        </div>
      </header>
      <main id="main" class="app-main" tabindex="-1"></main>
      <nav class="tabbar" aria-label="Menu utama">
        <a href="#/app" data-nav="/app">${icon('home', 22)}<span>Beranda</span></a>
        <a href="#/app/pesan" data-nav="/app/pesan">${icon('plus', 22)}<span>Pesan</span></a>
        <a href="#/app/pesanan" data-nav="/app/pesanan">${icon('box', 22)}<span>Pesanan</span></a>
        <a href="#/app/stamp" data-nav="/app/stamp">${icon('gift', 22)}<span>Stamp</span></a>
      </nav>
    </div>`;
}

function adminShell() {
  const u = state.user;
  return html`
    <div class="shell shell-admin">
      <aside class="side">
        <a class="brand brand-light" href="#/admin"><img src="/img/logo-mark.png" alt="" width="34" height="38"><span>ZibbWash<small>Panel admin</small></span></a>
        <nav class="sidenav" aria-label="Menu admin">
          <a href="#/admin" data-nav="/admin">${icon('list', 20)}<span>Pesanan</span></a>
          <a href="#/admin/pelanggan" data-nav="/admin/pelanggan">${icon('users', 20)}<span>Pelanggan</span></a>
          <a href="#/admin/pengaturan" data-nav="/admin/pengaturan">${icon('sliders', 20)}<span>Tarif & pengaturan</span></a>
        </nav>
        <div class="side-foot">
          <p><b>${u.name}</b><small>Masuk sebagai admin</small></p>
          <button data-act="password">${icon('lock', 18)}<span>Ganti kata sandi</span></button>
          <button data-act="logout">${icon('out', 18)}<span>Keluar</span></button>
        </div>
      </aside>
      <main id="main" class="admin-main" tabindex="-1"></main>
    </div>`;
}

function ensureShell(kind) {
  if (kind === 'customer' || kind === 'admin') {
    if (currentShell !== kind) {
      mount(app, kind === 'customer' ? customerShell() : adminShell());
      currentShell = kind;
    }
    return $('#main', app);
  }
  currentShell = kind;
  app.innerHTML = '';
  return app;
}

function markNav(path) {
  $$('[data-nav]', app).forEach((a) => {
    const target = a.getAttribute('data-nav');
    const home = target === '/app' || target === '/admin';
    const active = path === target
      || (!home && path.startsWith(`${target}/`))
      || (target === '/admin' && path.startsWith('/admin/pesanan/'))
      || (target === '/app/pesanan' && path.startsWith('/app/pesanan/'));
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

function refreshStampPill() {
  const el = $('[data-user-stamps]', app);
  if (el && state.user) el.textContent = `${state.user.stamps}/${state.config.loyalty.stampsForReward}`;
}

// ───────── router ─────────
async function renderRoute() {
  runCleanups();
  if (state.user) startRealtime(); else stopRealtime();
  const { path, query } = parseHash();
  const r = routes.find((x) => x.re.test(path));
  if (!r) { go('/'); return; }
  const m = r.re.exec(path);
  const params = m.slice(1).map(decodeURIComponent);

  if (r.role) {
    if (!state.user) { go(`/masuk?next=${encodeURIComponent(path)}`); return; }
    if (state.user.role !== r.role) { go(homeFor(state.user)); return; }
  }
  if (r.shell === 'bare' && state.user) { go(homeFor(state.user)); return; }

  const container = ensureShell(r.shell);
  markNav(path);
  if (path !== lastPath) window.scrollTo(0, 0);
  lastPath = path;
  document.title = path === '/' ? 'ZibbWash Laundry: laundry kiloan antar-jemput' : 'ZibbWash Laundry';
  try {
    await r.view({ container, params, query, path });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { state.user = null; currentShell = null; go('/masuk'); return; }
    console.error(e);
    mount(container, html`<div class="page"><div class="empty"><h3>Halaman tidak bisa dimuat</h3><p>${e.message || 'Terjadi kesalahan.'}</p><button class="btn btn-primary" onclick="location.reload()">Muat ulang</button></div></div>`);
  }
}

// ───────── aksi global (menu akun) ─────────
async function logout() {
  stopRealtime();
  try { await post('/api/auth/logout'); } catch { /* sesi mungkin sudah habis */ }
  state.user = null; currentShell = null;
  toast('Kamu sudah keluar.', 'ok');
  go('/');
}

function openPasswordModal() {
  const m = openModal({
    title: 'Ganti kata sandi',
    body: html`
      <form class="form" novalidate>
        <div class="field"><label for="pw-cur">Kata sandi saat ini</label><input id="pw-cur" name="current" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="pw-new">Kata sandi baru</label><input id="pw-new" name="next" type="password" autocomplete="new-password" minlength="6" required><p class="hint">Minimal 6 karakter.</p></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Batal</button><button class="btn btn-primary">Simpan kata sandi</button></div>
      </form>`,
  });
  const form = $('form', m.el);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('.btn-primary', form); btn.disabled = true;
    try {
      await post('/api/auth/password', { current: form.current.value, next: form.next.value });
      m.close(); toast('Kata sandi diperbarui.', 'ok');
    } catch (err) {
      if (err.fields) showFieldErrors(form, err.fields); else toast(err.message, 'error');
    } finally { btn.disabled = false; }
  });
}

on(document, 'click', '[data-act="logout"]', logout);
on(document, 'click', '[data-act="password"]', () => {
  $$('details.usermenu[open]').forEach((d) => d.removeAttribute('open'));
  openPasswordModal();
});
document.addEventListener('click', (e) => {
  $$('details.usermenu[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
});

// ───────── boot ─────────
async function boot() {
  try {
    const [cfg, me] = await Promise.all([get('/api/config'), get('/api/auth/me')]);
    state.config = cfg;
    state.user = me.user;
  } catch (e) {
    mount(app, html`<div class="page boot-error"><img src="/img/logo-mark.png" alt="" width="64" height="70"><h1>Server belum bisa dihubungi</h1><p>${e.message}</p><button class="btn btn-primary" onclick="location.reload()">Coba lagi</button></div>`);
    return;
  }
  window.addEventListener('hashchange', renderRoute);
  window.addEventListener('zw:user', refreshStampPill);
  await renderRoute();
}
boot();
