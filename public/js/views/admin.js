// Panel admin: daftar + detail pesanan (berat aktual, status, pembayaran), pelanggan, tarif & pengaturan.
import { get, post, put } from '../api.js';
import {
  html, raw, mount, $, $$, on, icon, rupiah, kg, num, fmtDate, timeAgo, phonePretty, waLink, toast, openModal, showFieldErrors,
  statusChip, payChip, courierStatus, courierHours,
} from '../util.js';
import { state, onCleanup, go } from '../state.js';
import { onOrdersChanged } from '../realtime.js';
import { billHtml, detailsHtml, activityHtml, emptyState, skeleton } from './shared.js';

// Filter dan pencarian diingat selama sesi agar tidak hilang saat berpindah pesanan.
const S = { filter: 'all', q: '' };
const FILTERS = [['all', 'Semua'], ['new', 'Baru'], ['processing', 'Diproses'], ['ready', 'Siap / antar'], ['done', 'Selesai'], ['cancelled', 'Dibatalkan']];
const amountText = (o) => (o.billing.isFinal ? rupiah(o.billing.total) : o.billing.weight > 0 ? `±${rupiah(o.billing.total)}` : 'Belum ditimbang');

// ───────────────────────── pesanan (daftar + detail) ─────────────────────────
export async function orders({ container, params }) {
  let selectedId = params[0] || null;
  mount(container, html`<div class="admin-page">${skeleton()}</div>`);
  let [{ orders: list }, { stats }] = await Promise.all([get('/api/admin/orders'), get('/api/admin/stats')]);

  mount(container, html`
    <div class="admin-page">
      <header class="admin-head">
        <h1>Pesanan</h1>
        <dl class="stat-strip" id="stats"></dl>
      </header>
      <div class="split ${selectedId ? 'has-detail' : ''}" id="split">
        <section class="list-pane" aria-label="Daftar pesanan">
          <div class="list-tools">
            <div class="input-suffix"><input id="aq" type="search" placeholder="Cari nama, nomor HP, atau ID pesanan" aria-label="Cari pesanan" value="${S.q}"><span>${icon('search', 18)}</span></div>
            <div class="filters" id="filters" role="group" aria-label="Filter status"></div>
          </div>
          <div class="alist" id="alist"></div>
        </section>
        <section class="detail-pane" id="detail" aria-live="polite"></section>
      </div>
    </div>`);
  const root = container.firstElementChild;

  function drawStats() {
    mount($('#stats', root), html`
      <div class="stat stat-wait"><dt>Baru masuk</dt><dd>${stats.new}</dd></div>
      <div class="stat stat-work"><dt>Diproses</dt><dd>${stats.processing}</dd></div>
      <div class="stat stat-ready"><dt>Siap / antar</dt><dd>${stats.ready}</dd></div>
      <div class="stat stat-pay"><dt>Menunggu bayar</dt><dd>${stats.awaitingPayment}<small>${rupiah(stats.awaitingAmount)}</small></dd></div>
      <div class="stat stat-ok"><dt>Pendapatan lunas</dt><dd class="money">${rupiah(stats.revenue)}</dd></div>`);
  }

  function drawFilters() {
    const count = (f) => (f === 'all' ? list.length : list.filter((o) => o.group === f).length);
    mount($('#filters', root), html`${FILTERS.map(([k, label]) => html`<button type="button" class="fchip" data-filter="${k}" aria-pressed="${String(S.filter === k)}">${label}<b>${count(k)}</b></button>`)}`);
  }

  function visible() {
    const q = S.q.trim().toLowerCase();
    return list.filter((o) => (S.filter === 'all' || o.group === S.filter)
      && (!q || o.id.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q) || o.customerPhone.includes(q)));
  }

  function drawList() {
    const items = visible();
    mount($('#alist', root), items.length === 0
      ? emptyState(list.length ? 'Tidak ada yang cocok' : 'Belum ada pesanan masuk', list.length ? 'Ubah filter atau kata kunci pencarian.' : 'Pesanan dari pelanggan akan muncul di sini.')
      : html`${items.map((o) => html`
        <a class="arow ${o.id === selectedId ? 'sel' : ''} g-${o.group}" href="#/admin/pesanan/${o.id}" data-id="${o.id}">
          <div class="arow-top"><b>${o.customerName}</b><time>${timeAgo(o.createdAt)}</time></div>
          <p class="arow-mid">${o.id} · ${o.serviceName}</p>
          <div class="arow-bot">${statusChip(o)}${payChip(o)}<span class="amount">${amountText(o)}</span></div>
        </a>`)}`);
  }

  async function refreshAll() {
    [{ orders: list }, { stats }] = await Promise.all([get('/api/admin/orders'), get('/api/admin/stats')]);
    drawStats(); drawFilters(); drawList();
  }

  on(root, 'click', '[data-filter]', (e, b) => { S.filter = b.dataset.filter; drawFilters(); drawList(); });
  $('#aq', root).addEventListener('input', (e) => { S.q = e.target.value; drawList(); });

  // ── detail ──
  async function showDetail(id, { quiet = false } = {}) {
    const box = $('#detail', root);
    if (!id) {
      mount(box, html`<div class="detail-empty">${emptyState('Pilih pesanan di sebelah kiri', 'Detail, input berat aktual, dan pembaruan status muncul di sini.')}</div>`);
      return;
    }
    if (!quiet) mount(box, skeleton());
    let res;
    try { res = await get(`/api/admin/orders/${encodeURIComponent(id)}`); } catch (e) {
      mount(box, emptyState('Pesanan tidak ditemukan', e.message, html`<a class="btn btn-primary" href="#/admin">Kembali ke daftar</a>`));
      return;
    }
    drawDetail(res.order, res.customer);
  }

  function drawDetail(o, c) {
    const box = $('#detail', root);
    const closed = o.status === 'done' || o.status === 'cancelled';
    const b = o.billing;
    const locked = closed || o.payment.status === 'paid';
    const nextStep = closed ? null : o.flow[o.currentIndex + 1] || null;
    const wa = waLink(`62${o.customerPhone.slice(1)}`, `Halo ${o.customerName}, ini ZibbWash Laundry soal pesanan ${o.id}.`);
    const payMethods = state.config.paymentMethods;
    // Peringatan saja (tidak memblokir): admin bisa saja baru mencatat penjemputan yang terjadi sebelum jam tutup.
    const offHours = nextStep && ['pickup', 'delivering'].includes(nextStep.key) && !courierStatus(state.config.delivery).open;

    mount(box, html`
      <div class="detail">
        <a class="back detail-back" href="#/admin">${icon('back', 16)}Daftar pesanan</a>
        <header class="detail-head">
          <div>
            <p class="idline">${o.id}</p>
            <h2>${o.customerName}</h2>
            <p class="sub">${phonePretty(o.customerPhone)} · <a class="link" href="${wa}" target="_blank" rel="noopener">Hubungi lewat WhatsApp</a>${c ? html` · Stamp ${c.stamps}/${state.config.loyalty.stampsForReward}${c.vouchers ? `, ${c.vouchers} voucher` : ''}` : ''}</p>
          </div>
          <div class="chips">${statusChip(o)}${payChip(o)}</div>
        </header>

        ${o.status === 'cancelled' ? html`<div class="notice notice-off">${icon('info', 20)}<span>Pesanan ini dibatalkan.</span></div>` : ''}
        ${o.status === 'done' ? html`<div class="notice notice-ok">${icon('check', 20)}<span><b>Pesanan selesai.</b> ${o.stamp.awarded ? 'Stamp +1 sudah masuk ke pelanggan.' : (o.stamp.note || (o.payment.status !== 'paid' ? 'Stamp diberikan setelah tagihan lunas.' : ''))}</span></div>` : ''}

        <section class="panel">
          <h3>Status pengerjaan</h3>
          <ol class="stepper">
            ${o.flow.map((s) => html`<li class="${s.state}"><span>${s.state === 'done' ? icon('check', 12) : ''}</span>${s.label}</li>`)}
          </ol>
          ${offHours ? html`<div class="notice notice-wait slim">${icon('clock', 18)}<span><b>Di luar jam operasional (${courierHours(state.config.delivery)}).</b> Tahap berikutnya butuh kurir.</span></div>` : ''}
          ${closed ? html`<p class="hint">Pesanan yang sudah ${o.status === 'done' ? 'selesai' : 'dibatalkan'} tidak bisa diubah lagi.</p>` : html`
            <form id="status-form" class="form" novalidate>
              <div class="field"><label for="st">Ubah status ke</label>
                <select id="st" name="status">
                  ${o.flow.filter((_, i) => i !== o.currentIndex).map((s) => html`<option value="${s.key}" ${nextStep && s.key === nextStep.key ? 'selected' : ''}>${s.label}</option>`)}
                </select></div>
              <div class="field"><label for="stn">Catatan untuk pelanggan <span class="opt-tag">opsional</span></label>
                <input id="stn" name="note" maxlength="300" placeholder="mis. Cucian sedang di mesin pengering"></div>
              <div class="btn-row">
                <button class="btn btn-primary">Perbarui status</button>
                ${nextStep ? html`<button type="button" class="btn btn-ghost" data-act="next" data-key="${nextStep.key}">Lanjut: ${nextStep.label}${icon('arrow', 16)}</button>` : ''}
              </div>
            </form>`}
        </section>

        <section class="panel">
          <h3>Berat aktual dan tagihan</h3>
          <form id="weight-form" class="weight-form" novalidate>
            <div class="field"><label for="wt">Berat aktual</label>
              <div class="input-suffix w-narrow"><input id="wt" name="weight" type="number" inputmode="decimal" step="0.1" min="0.1" max="100" value="${o.actualWeight != null ? o.actualWeight : ''}" placeholder="0,0" ${locked ? 'disabled' : ''}><span>kg</span></div></div>
            <button class="btn btn-primary" ${locked ? 'disabled' : ''}>${o.actualWeight != null ? 'Perbarui berat' : 'Simpan berat'}</button>
          </form>
          <p class="hint">${o.estimatedWeight ? `Perkiraan pelanggan ${kg(o.estimatedWeight)}. ` : ''}${locked && !closed ? 'Berat dikunci karena tagihan sudah dibayar.' : 'Setelah berat disimpan, tagihan final tampil di akun pelanggan dan bisa dibayar.'}</p>
          ${billHtml(o)}
          ${b.isFinal && o.status !== 'cancelled' ? (o.payment.status === 'paid' ? html`
            <div class="paid"><span class="paid-ic">${icon('check', 20)}</span><div><b>Lunas</b><p>${payMethods.find((m) => m.id === o.payment.method)?.name || o.payment.method} · ${fmtDate(o.payment.paidAt)}</p></div></div>`
            : html`
            <form id="pay-form" class="pay-admin">
              <div class="field"><label for="pm">Pembayaran diterima lewat</label>
                <select id="pm" name="method">${payMethods.map((m) => html`<option value="${m.id}" ${m.id === (o.payment.method || 'cash') ? 'selected' : ''}>${m.name}</option>`)}</select></div>
              <button class="btn btn-success">Tandai lunas</button>
            </form>${o.payment.method === 'cash' ? html`<p class="hint">Pelanggan memilih bayar tunai.</p>` : ''}`) : ''}
        </section>

        <section class="panel"><h3>Detail pesanan</h3>${detailsHtml(o)}</section>
        <section class="panel"><h3>Riwayat aktivitas</h3>${activityHtml(o)}</section>
        ${closed ? '' : html`<div class="danger-zone"><button class="btn btn-danger-ghost" data-act="cancel">Batalkan pesanan</button></div>`}
      </div>`);

    const d = $('.detail', box);
    const act = async (fn, okMsg) => {
      try {
        const r = await fn();
        if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok');
        await Promise.all([refreshAll(), showDetail(o.id, { quiet: true })]);
      } catch (e) {
        if (e.fields) showFieldErrors(d, e.fields);
        toast(e.message, 'error');
      }
    };
    const statusForm = $('#status-form', d);
    if (statusForm) statusForm.addEventListener('submit', (e) => {
      e.preventDefault();
      act(() => post(`/api/admin/orders/${encodeURIComponent(o.id)}/status`, { status: statusForm.status.value, note: statusForm.note.value }),
        (r) => (r.award && r.award.reward ? 'Status diperbarui. Pelanggan mendapat stamp dan voucher gratis!' : r.award && r.award.awarded ? 'Status diperbarui. Stamp +1 untuk pelanggan.' : 'Status diperbarui. Pelanggan melihat perubahannya.'));
    });
    on(d, 'click', '[data-act=next]', (e, btn) => {
      act(() => post(`/api/admin/orders/${encodeURIComponent(o.id)}/status`, { status: btn.dataset.key, note: $('#stn', d) ? $('#stn', d).value : '' }), 'Status diperbarui.');
    });
    $('#weight-form', d).addEventListener('submit', (e) => {
      e.preventDefault();
      act(() => post(`/api/admin/orders/${encodeURIComponent(o.id)}/weight`, { weight: $('#wt', d).value }), 'Berat disimpan. Tagihan final dibuat.');
    });
    const payForm = $('#pay-form', d);
    if (payForm) payForm.addEventListener('submit', (e) => {
      e.preventDefault();
      act(() => post(`/api/admin/orders/${encodeURIComponent(o.id)}/payment`, { method: payForm.method.value }),
        (r) => (r.award && r.award.awarded ? 'Ditandai lunas. Stamp +1 untuk pelanggan.' : 'Ditandai lunas.'));
    });
    on(d, 'click', '[data-act=cancel]', () => {
      const m = openModal({
        title: 'Batalkan pesanan ini?',
        body: html`<form class="form"><p>${o.id} atas nama <b>${o.customerName}</b> akan dibatalkan.${o.voucherUsed ? ' Voucher pelanggan dikembalikan.' : ''}${o.payment.status === 'paid' ? ' Pembayaran ditandai dikembalikan.' : ''}</p>
          <div class="field"><label for="cn">Alasan (terlihat oleh pelanggan)</label><input id="cn" name="note" maxlength="300" placeholder="mis. Pakaian tidak diantar sesuai jadwal"></div>
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Tidak jadi</button><button class="btn btn-danger">Ya, batalkan</button></div></form>`,
      });
      $('form', m.el).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        try {
          await post(`/api/admin/orders/${encodeURIComponent(o.id)}/cancel`, { note: ev.target.note.value });
          m.close(); toast('Pesanan dibatalkan.', 'ok');
          await Promise.all([refreshAll(), showDetail(o.id, { quiet: true })]);
        } catch (ex) { toast(ex.message, 'error'); }
      });
    });
  }

  drawStats(); drawFilters(); drawList();
  await showDetail(selectedId);

  // Isian di panel detail yang sudah diubah tetapi belum disimpan tidak boleh tertimpa pembaruan otomatis.
  const detailDirty = () => [...$('#detail', root).querySelectorAll('input, textarea, select')].some((el) => {
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
    if (el.tagName === 'SELECT') return [...el.options].some((o) => o.selected !== o.defaultSelected);
    return el.value !== el.defaultValue;
  });

  // Pembaruan langsung dari server: daftar dan statistik selalu disegarkan; panel detail hanya bila pesanan itu
  // yang berubah dan tidak ada isian yang sedang diketik.
  const stopLive = onOrdersChanged(async ({ ids, resync }) => {
    if (document.querySelector('dialog[open]')) return;
    try {
      const before = list.length;
      await refreshAll();
      if (list.length > before) toast(`${list.length - before} pesanan baru masuk.`, 'info');
      if (selectedId && (resync || ids.has(selectedId))) {
        if (detailDirty()) toast('Pesanan ini baru saja berubah. Simpan atau kosongkan isianmu, lalu buka ulang pesanannya.', 'info');
        else await showDetail(selectedId, { quiet: true });
      }
    } catch { /* abaikan, putaran berikutnya akan mencoba lagi */ }
  });

  // Cadangan bila sambungan langsung tidak tersedia: segarkan daftar tiap 60 detik.
  const timer = setInterval(async () => {
    if (document.hidden || document.querySelector('dialog[open]')) return;
    try {
      const before = list.length;
      await refreshAll();
      if (list.length > before) toast(`${list.length - before} pesanan baru masuk.`, 'info');
    } catch { /* abaikan */ }
  }, 60000);
  onCleanup(() => { clearInterval(timer); stopLive(); });
}

// ───────────────────────── pelanggan ─────────────────────────
export async function customers({ container }) {
  mount(container, html`<div class="admin-page">${skeleton()}</div>`);
  const { customers: list, loyalty } = await get('/api/admin/customers');
  let q = '';
  mount(container, html`
    <div class="admin-page">
      <header class="admin-head"><h1>Pelanggan</h1><p class="head-sub">${list.length} pelanggan terdaftar</p></header>
      <div class="panel flush">
        <div class="table-tools"><div class="input-suffix"><input id="cq" type="search" placeholder="Cari nama atau nomor HP" aria-label="Cari pelanggan"><span>${icon('search', 18)}</span></div></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Nama</th><th>Nomor HP</th><th>Bergabung</th><th class="r">Pesanan</th><th class="r">Total belanja</th><th>Stamp</th><th class="r">Voucher</th></tr></thead><tbody id="cbody"></tbody></table></div>
      </div>
    </div>`);
  const root = container.firstElementChild;
  function draw() {
    const items = list.filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q));
    mount($('#cbody', root), items.length === 0
      ? html`<tr><td colspan="7" class="empty-cell">Tidak ada pelanggan yang cocok.</td></tr>`
      : html`${items.map((c) => html`
        <tr>
          <td><b>${c.name}</b></td>
          <td><a class="link" href="${waLink(`62${c.phone.slice(1)}`)}" target="_blank" rel="noopener">${phonePretty(c.phone)}</a></td>
          <td>${fmtDate(c.createdAt)}</td>
          <td class="r">${c.orders}</td>
          <td class="r">${rupiah(c.spent)}</td>
          <td><span class="mini-stamps" title="${c.stamps} dari ${loyalty.stampsForReward}">${Array.from({ length: loyalty.stampsForReward }, (_, i) => html`<i class="${i < c.stamps ? 'on' : ''}"></i>`)}</span> <small>${c.stamps}/${loyalty.stampsForReward}</small></td>
          <td class="r">${c.vouchers ? html`<span class="chip chip-ok">${c.vouchers}</span>` : '–'}</td>
        </tr>`)}`);
  }
  $('#cq', root).addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
  draw();
}

// ───────────────────────── tarif & pengaturan ─────────────────────────
export async function settings({ container }) {
  mount(container, html`<div class="admin-page">${skeleton()}</div>`);
  const s = await get('/api/admin/settings');
  const f = (name, label, value, { type = 'text', suffix = '', hint = '', step, min, narrow = true, full = false } = {}) => html`
    <div class="field ${full ? 'full' : ''}"><label for="s-${name}">${label}</label>
      <div class="${suffix ? 'input-suffix' : ''} ${narrow && suffix ? 'w-narrow' : ''}"><input id="s-${name}" name="${name}" type="${type}" ${type === 'number' ? raw('inputmode="decimal"') : ''} ${step ? raw(`step="${step}"`) : ''} ${min != null ? raw(`min="${Number(min)}"`) : ''} value="${value}">${suffix ? html`<span>${suffix}</span>` : ''}</div>
      ${hint ? html`<p class="hint">${hint}</p>` : ''}</div>`;

  mount(container, html`
    <div class="admin-page">
      <header class="admin-head"><h1>Tarif dan pengaturan</h1><p class="head-sub">Perubahan tarif berlaku untuk pesanan baru. Pesanan lama tetap memakai tarif saat dipesan.</p></header>
      <form id="set-form" class="settings" novalidate>
        <section class="panel">
          <h2>Outlet dan kontak</h2>
          <div class="grid-2">
            ${f('business.name', 'Nama bisnis', s.business.name)}
            ${f('business.phone', 'Nomor HP / WhatsApp', s.business.phone, { type: 'tel' })}
            ${f('business.address', 'Alamat outlet', s.business.address, { full: true })}
            ${f('business.instagram', 'Username Instagram', s.business.instagram, { hint: 'Tanpa tanda @. Kosongkan untuk menyembunyikan.' })}
            ${f('business.email', 'Email', s.business.email, { type: 'email', hint: 'Kosongkan untuk menyembunyikan.' })}
            ${f('business.lat', 'Latitude outlet', s.business.lat, { type: 'number', step: 'any', hint: 'Titik ini jadi dasar hitung jarak antar-jemput.' })}
            ${f('business.lng', 'Longitude outlet', s.business.lng, { type: 'number', step: 'any', hint: 'Di Google Maps: klik kanan lokasi outlet, lalu klik angka koordinat untuk menyalin.' })}
            ${f('maps.apiKey', 'Google Maps API Key', s.maps.apiKey, { full: true, hint: 'Kosongkan untuk memakai OpenStreetMap. Aktifkan Maps JavaScript API, Directions API, dan Geocoding API, lalu batasi kunci ke domain websitemu.' })}
          </div>
        </section>

        <section class="panel">
          <h2>Tarif layanan</h2>
          <div class="svc-edit">
            ${s.services.map((v) => html`
              <div class="svc-edit-row"><b>${v.name}</b>
                ${f(`services.${v.id}.pricePerKg`, 'Tarif per kg', v.pricePerKg, { type: 'number', suffix: 'Rp/kg', min: 0 })}
                ${f(`services.${v.id}.eta`, 'Estimasi selesai', v.eta)}
              </div>`)}
          </div>
        </section>

        <section class="panel">
          <h2>Ongkir antar-jemput</h2>
          <div class="grid-2">
            ${f('delivery.openTime', 'Jam buka pengiriman (WIB)', s.delivery.openTime, { type: 'time' })}
            ${f('delivery.closeTime', 'Jam tutup pengiriman (WIB)', s.delivery.closeTime, { type: 'time' })}
          </div>
          <div class="grid-3">
            ${f('delivery.freeKm', 'Gratis sampai', s.delivery.freeKm, { type: 'number', suffix: 'km', step: 'any', min: 0 })}
            ${f('delivery.perKm', 'Tarif setelahnya', s.delivery.perKm, { type: 'number', suffix: 'Rp/km', min: 0 })}
            ${f('delivery.maxKm', 'Jangkauan maksimal', s.delivery.maxKm, { type: 'number', suffix: 'km', step: 'any', min: 1 })}
          </div>
          <label class="check"><input type="checkbox" name="delivery.chargePerLeg" ${s.delivery.chargePerLeg ? 'checked' : ''}><span><b>Hitung ongkir per arah</b><small>Aktif: jemput dan antar dikenai ongkir masing-masing. Nonaktif: ongkir dihitung sekali, berapa pun arah yang dipakai.</small></span></label>
        </section>

        <section class="panel">
          <h2>Kartu stamp</h2>
          <div class="grid-3">
            ${f('loyalty.minTransaction', 'Minimal transaksi per stamp', s.loyalty.minTransaction, { type: 'number', suffix: 'Rp', min: 0 })}
            ${f('loyalty.stampsForReward', 'Stamp untuk hadiah', s.loyalty.stampsForReward, { type: 'number', suffix: 'stamp', min: 1 })}
            ${f('loyalty.rewardMaxKg', 'Batas berat hadiah', s.loyalty.rewardMaxKg, { type: 'number', suffix: 'kg', step: 'any', min: 0.5, hint: 'Hadiah: gratis layanan Wash & Fold.' })}
          </div>
        </section>

        <div class="save-bar"><button class="btn btn-primary btn-lg">Simpan perubahan</button></div>
      </form>
      <div class="settings backup-wrap">
        <section class="panel">
          <h2>Cadangan data</h2>
          <p class="hint">Unduh seluruh data (pesanan, pelanggan, tarif) sebagai satu berkas. Isinya data pribadi pelanggan, jadi simpan di tempat yang aman. Disarankan mengunduh tiap minggu.</p>
          <a class="btn btn-ghost" href="/api/admin/backup" download>${icon('box', 18)}Unduh cadangan data</a>
        </section>
      </div>
    </div>`);

  const form = $('#set-form', container);
  const val = (n) => form.elements[n].value;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showFieldErrors(form, {});
    const btn = $('.btn-primary', form); btn.disabled = true;
    try {
      await put('/api/admin/settings', {
        business: { name: val('business.name'), phone: val('business.phone'), address: val('business.address'), lat: val('business.lat'), lng: val('business.lng'), instagram: val('business.instagram'), email: val('business.email') },
        maps: { apiKey: val('maps.apiKey') },
        services: s.services.map((v) => ({ id: v.id, pricePerKg: val(`services.${v.id}.pricePerKg`), eta: val(`services.${v.id}.eta`) })),
        delivery: { freeKm: val('delivery.freeKm'), perKm: val('delivery.perKm'), maxKm: val('delivery.maxKm'), chargePerLeg: form.elements['delivery.chargePerLeg'].checked, openTime: val('delivery.openTime'), closeTime: val('delivery.closeTime') },
        loyalty: { minTransaction: val('loyalty.minTransaction'), stampsForReward: val('loyalty.stampsForReward'), rewardMaxKg: val('loyalty.rewardMaxKg') },
      });
      state.config = await get('/api/config');
      toast('Pengaturan disimpan.', 'ok');
    } catch (ex) {
      if (ex.fields) showFieldErrors(form, ex.fields);
      toast(ex.message, 'error');
    } finally { btn.disabled = false; }
  });
}
