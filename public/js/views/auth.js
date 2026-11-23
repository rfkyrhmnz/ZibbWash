// Halaman masuk: pelanggan (masuk/daftar) dan admin (masuk) dipisahkan lewat pemilih peran.
import { post } from '../api.js';
import { html, raw, mount, $, $$, icon, toast, showFieldErrors } from '../util.js';
import { state, go, homeFor } from '../state.js';

export function authView({ container, query }) {
  let role = query.get('role') === 'admin' ? 'admin' : 'customer';
  let mode = query.get('mode') === 'daftar' ? 'register' : 'login';
  const next = query.get('next');

  function draw() {
    const isAdmin = role === 'admin';
    const reg = !isAdmin && mode === 'register';
    mount(container, html`
    <div class="auth">
      <aside class="auth-side">
        <a class="brand brand-light" href="#/"><img src="/img/logo-mark.png" alt="" width="40" height="44"><span>ZibbWash<small>Laundry</small></span></a>
        <div class="auth-side-copy">
          <h1>${isAdmin ? 'Kelola pesanan masuk dengan rapi.' : 'Laundry selesai, kamu tinggal menunggu kabar.'}</h1>
          <p>${isAdmin
            ? 'Catat berat aktual, perbarui status pengerjaan, dan konfirmasi pembayaran dari satu panel.'
            : 'Pesan, pantau tiap tahap pencucian, bayar di aplikasi, dan kumpulkan stamp untuk cuci gratis.'}</p>
        </div>
        <svg class="auth-wave" viewBox="0 0 600 220" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 120C90 60 170 190 300 140S520 40 600 100V220H0Z" fill="#0DADD2" fill-opacity=".18"/>
          <path d="M0 170C110 120 200 220 330 180S520 110 600 150V220H0Z" fill="#0DADD2" fill-opacity=".14"/>
        </svg>
      </aside>

      <main id="main" class="auth-main" tabindex="-1">
        <div class="auth-card">
          <a class="back" href="#/">${icon('back', 16)}Kembali ke beranda</a>
          <div class="role-switch" role="tablist" aria-label="Masuk sebagai">
            <button role="tab" aria-selected="${String(!isAdmin)}" data-role="customer">${icon('user', 18)}Pelanggan</button>
            <button role="tab" aria-selected="${String(isAdmin)}" data-role="admin">${icon('lock', 18)}Admin</button>
          </div>

          <h2>${isAdmin ? 'Masuk sebagai admin' : reg ? 'Buat akun pelanggan' : 'Masuk ke akunmu'}</h2>
          <p class="auth-sub">${isAdmin ? 'Khusus pengelola ZibbWash Laundry.' : reg ? 'Cukup nomor HP dan kata sandi. Stamp pertamamu menunggu.' : 'Pakai nomor HP yang kamu daftarkan.'}</p>

          <form class="form" novalidate>
            <p class="form-error" role="alert" hidden></p>
            ${reg ? html`<div class="field"><label for="f-name">Nama lengkap</label><input id="f-name" name="name" autocomplete="name" required maxlength="60"></div>` : ''}
            <div class="field">
              <label for="f-id">${isAdmin ? 'Username' : 'Nomor HP'}</label>
              <input id="f-id" name="${isAdmin ? 'identifier' : 'phone'}" ${raw(isAdmin ? 'autocomplete="username"' : 'type="tel" inputmode="tel" autocomplete="tel" placeholder="0812 3456 7890"')} required>
            </div>
            <div class="field">
              <label for="f-pw">Kata sandi</label>
              <div class="input-suffix">
                <input id="f-pw" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required ${reg ? raw('minlength="6"') : ''}>
                <button type="button" class="icon-btn" data-toggle-pw aria-label="Tampilkan kata sandi">${icon('eye', 20)}</button>
              </div>
              ${reg ? html`<p class="hint">Minimal 6 karakter.</p>` : ''}
            </div>
            <button class="btn btn-primary btn-block btn-lg">${isAdmin ? 'Masuk ke panel admin' : reg ? 'Buat akun' : 'Masuk'}</button>
          </form>

          ${isAdmin ? '' : html`
            <p class="auth-switch">${reg ? 'Sudah punya akun?' : 'Belum punya akun?'}
              <button class="link-btn" data-mode="${reg ? 'login' : 'register'}">${reg ? 'Masuk' : 'Daftar sekarang'}</button></p>`}
        </div>
      </main>
    </div>`);
    bind();
  }

  function bind() {
    const form = $('form', container);
    $$('[data-role]', container).forEach((b) => b.addEventListener('click', () => { role = b.dataset.role; mode = 'login'; draw(); }));
    $$('[data-mode]', container).forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; draw(); }));
    $$('[data-toggle-pw]', container).forEach((b) => b.addEventListener('click', () => {
      const input = $('#f-pw', container);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.setAttribute('aria-label', show ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
      b.innerHTML = String(icon(show ? 'eyeoff' : 'eye', 20));
    }));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form);
      err.hidden = true;
      showFieldErrors(form, {});
      const btn = $('.btn-primary', form);
      btn.disabled = true;
      try {
        const fd = Object.fromEntries(new FormData(form));
        const res = role === 'admin'
          ? await post('/api/auth/login', { role: 'admin', identifier: fd.identifier, password: fd.password })
          : mode === 'register'
            ? await post('/api/auth/register', { name: fd.name, phone: fd.phone, password: fd.password })
            : await post('/api/auth/login', { role: 'customer', identifier: fd.phone, password: fd.password });
        state.user = res.user;
        toast(mode === 'register' && role !== 'admin' ? `Selamat datang, ${res.user.name.split(' ')[0]}!` : 'Berhasil masuk.', 'ok');
        const dest = next && next.startsWith(res.user.role === 'admin' ? '/admin' : '/app') ? next : homeFor(res.user);
        go(dest);
      } catch (ex) {
        if (ex.fields) showFieldErrors(form, ex.fields);
        else { err.textContent = ex.message; err.hidden = false; }
      } finally { btn.disabled = false; }
    });
    const first = $('input', form);
    if (first) first.focus({ preventScroll: true });
  }

  draw();
}
