// Area pelanggan: beranda, form pesan (peta + hitung otomatis), daftar pesanan, tracking + pembayaran, kartu stamp.
import { get, post } from '../api.js';
import {
  html, raw, mount, $, $$, on, icon, rupiah, kg, num, fmtDate, fmtDateTime, debounce, toast, openModal, showFieldErrors,
  statusChip, payChip, serviceIcon, waLink, HANDOVER, RETURN,
} from '../util.js';
import { state, onCleanup, go, updateUser } from '../state.js';
import { onOrdersChanged } from '../realtime.js';
import { createMapPicker } from '../maps.js';
import { billHtml, detailsHtml, activityHtml, pipBar, emptyState, skeleton } from './shared.js';

const PAY_ICON = { qris: 'qr', va: 'bank', ewallet: 'wallet', cash: 'cash' };
const isActive = (o) => o.status !== 'done' && o.status !== 'cancelled';
const totalText = (o) => (o.billing.isFinal ? rupiah(o.billing.total) : o.billing.weight > 0 || o.billing.legs > 0 ? `Perkiraan ${rupiah(o.billing.total)}` : 'Menunggu timbangan');

export function stampCard({ stamps, need, vouchers = 0 }) {
  const left = need - stamps;
  return html`
    <div class="stampcard">
      <div class="stampcard-head"><strong>Kartu stamp ZibbWash</strong><span>${stamps}/${need}</span></div>
      <div class="stamps">
        ${Array.from({ length: need }, (_, i) => html`<span class="stamp ${i < stamps ? 'on' : ''} ${i === need - 1 ? 'gift' : ''}">${i < stamps ? icon('drop', 22) : i === need - 1 ? icon('gift', 22) : ''}</span>`)}
      </div>
      <p class="stampcard-foot">${vouchers > 0 ? html`<b>${vouchers} voucher gratis</b> siap dipakai. ` : ''}${left} stamp lagi untuk cuci gratis.</p>
    </div>`;
}

function orderRow(o, { progress = false } = {}) {
  const cur = o.flow[o.currentIndex];
  return html`
    <a class="orow" href="#/app/pesanan/${o.id}">
      <div class="orow-main">
        <div class="orow-top"><b>${o.serviceName}</b>${statusChip(o)}</div>
        <p class="orow-sub">${o.id} · ${fmtDate(o.createdAt)} · ${totalText(o)}</p>
        ${progress && isActive(o) ? html`${pipBar(o)}<p class="orow-now">${cur ? cur.desc : ''}</p>` : ''}
      </div>
      ${icon('chev', 20)}
    </a>`;
}

// ───────────────────────── beranda ─────────────────────────
export async function dashboard({ container }) {
  mount(container, html`<div class="page">${skeleton()}</div>`);
  let alive = true;

  async function load() {
    const [{ orders }, loy] = await Promise.all([get('/api/orders'), get('/api/loyalty')]);
    if (!alive) return;
    updateUser(loy.user);
    const need = state.config.loyalty.stampsForReward;
    const active = orders.filter(isActive);
    const past = orders.filter((o) => !isActive(o)).slice(0, 4);
    const unpaid = active.filter((o) => o.billing.isFinal && o.payment.status === 'unpaid');
    const first = loy.user.name.split(' ')[0];

    mount(container, html`
      <div class="page">
        <header class="page-head">
          <div><h1>Halo, ${first}</h1><p>${active.length ? `${active.length} pesanan sedang berjalan.` : 'Belum ada pesanan yang berjalan.'}</p></div>
          <a class="btn btn-primary" href="#/app/pesan">${icon('plus', 18)}Pesan laundry</a>
        </header>
        ${unpaid.length ? html`
          <a class="notice notice-wait" href="#/app/pesanan/${unpaid[0].id}">
            ${icon('card', 20)}<span><b>${unpaid.length === 1 ? 'Satu tagihan menunggu pembayaran.' : `${unpaid.length} tagihan menunggu pembayaran.`}</b> ${unpaid[0].id}: ${rupiah(unpaid[0].billing.total)}</span>${icon('chev', 18)}
          </a>` : ''}
        <div class="dash-grid">
          <section>
            <h2 class="h-sec">Pesanan aktif</h2>
            ${active.length
              ? html`<div class="olist">${active.map((o) => orderRow(o, { progress: true }))}</div>`
              : emptyState('Belum ada cucian berjalan', 'Pesan sekarang, lalu pantau setiap tahapnya dari sini.', html`<a class="btn btn-primary" href="#/app/pesan">Pesan laundry</a>`)}
          </section>
          <aside class="dash-side">
            ${stampCard({ stamps: loy.user.stamps, need, vouchers: loy.user.vouchers })}
            <a class="link-row" href="#/app/stamp">Lihat aturan dan riwayat stamp${icon('chev', 18)}</a>
          </aside>
        </div>
        ${past.length ? html`
          <section class="page-sec">
            <div class="sec-head"><h2 class="h-sec">Riwayat terakhir</h2><a class="link" href="#/app/pesanan">Lihat semua</a></div>
            <div class="olist">${past.map((o) => orderRow(o))}</div>
          </section>` : ''}
      </div>`);
  }

  await load();
  // Status dari admin langsung terlihat tanpa memuat ulang halaman.
  const stopLive = onOrdersChanged(() => { if (!document.querySelector('dialog[open]')) load().catch(() => {}); });
  onCleanup(() => { alive = false; stopLive(); });
}

// ───────────────────────── daftar pesanan ─────────────────────────
export async function orders({ container }) {
  mount(container, html`<div class="page">${skeleton()}</div>`);
  let alive = true;

  async function load() {
    const { orders: list } = await get('/api/orders');
    if (!alive) return;
    const active = list.filter(isActive);
    const past = list.filter((o) => !isActive(o));
    mount(container, html`
      <div class="page">
        <header class="page-head"><div><h1>Pesanan saya</h1><p>${list.length} pesanan sejak bergabung.</p></div><a class="btn btn-primary" href="#/app/pesan">${icon('plus', 18)}Pesan laundry</a></header>
        ${list.length === 0 ? emptyState('Belum ada pesanan', 'Pesanan pertamamu akan muncul di sini lengkap dengan status pengerjaannya.', html`<a class="btn btn-primary" href="#/app/pesan">Buat pesanan pertama</a>`) : ''}
        ${active.length ? html`<section class="page-sec"><h2 class="h-sec">Berjalan</h2><div class="olist">${active.map((o) => orderRow(o, { progress: true }))}</div></section>` : ''}
        ${past.length ? html`<section class="page-sec"><h2 class="h-sec">Selesai dan dibatalkan</h2><div class="olist">${past.map((o) => orderRow(o))}</div></section>` : ''}
      </div>`);
  }

  await load();
  const stopLive = onOrdersChanged(() => { load().catch(() => {}); });
  onCleanup(() => { alive = false; stopLive(); });
}

// ───────────────────────── form pesan ─────────────────────────
export async function orderForm({ container, query }) {
  const cfg = state.config;
  try { const me = await get('/api/auth/me'); if (me.user) updateUser(me.user); } catch { /* pakai data lama */ }
  const user = state.user;
  const wanted = query.get('layanan');
  const st = {
    serviceId: cfg.services.some((s) => s.id === wanted) ? wanted : cfg.services[0].id,
    garments: new Map([[cfg.garmentTypes[0], 5]]),
    estimatedWeight: '', handover: 'dropoff', returnMethod: 'self',
    address: { text: '', lat: null, lng: null, distanceKm: null, method: null },
    notes: '', useVoucher: false,
  };
  let picker = null;
  let addressTouched = false;
  let seq = 0;
  const { freeKm, perKm } = cfg.delivery;

  mount(container, html`
    <div class="page">
      <header class="page-head"><div><h1>Pesan laundry</h1><p>Isi sekali, sisanya kami yang urus. Tagihan final dihitung dari berat timbangan.</p></div></header>
      <form class="order-form" novalidate>
        <div class="form-grid">
          <div class="form-main">
            <section class="panel field" data-field="serviceId">
              <h2>Pilih layanan</h2>
              <div class="svc-grid">
                ${cfg.services.map((s) => html`
                  <label class="opt svc">
                    <input type="radio" name="serviceId" value="${s.id}" ${s.id === st.serviceId ? 'checked' : ''}>
                    <span class="svc-ic">${serviceIcon(s.id)}</span>
                    <span class="opt-body"><b>${s.name}</b><small>${s.desc}</small></span>
                    <span class="svc-price"><b>${rupiah(s.pricePerKg)}</b><i>/kg</i><em>${s.eta}</em></span>
                  </label>`)}
              </div>
            </section>

            <section class="panel">
              <div class="field" data-field="garments">
                <h2>Jenis pakaian</h2>
                <p class="hint">Pilih yang ikut dicuci dan atur jumlah potongnya, supaya tidak ada yang terlewat.</p>
                <div class="garments" id="garments"></div>
              </div>
              <div class="field">
                <label for="est">Perkiraan berat <span class="opt-tag">boleh dikosongkan</span></label>
                <div class="input-suffix w-narrow"><input id="est" name="estimatedWeight" type="number" inputmode="decimal" min="0.1" max="100" step="0.1" placeholder="mis. 3,5"><span>kg</span></div>
                <p class="hint">Hanya untuk perkiraan harga. Yang dipakai untuk tagihan adalah berat aktual saat ditimbang di outlet.</p>
              </div>
            </section>

            <section class="panel">
              <h2>Serah terima</h2>
              <fieldset class="field" data-field="handover">
                <legend>Pakaianmu sampai ke kami lewat</legend>
                <div class="opt-row">
                  <label class="opt"><input type="radio" name="handover" value="dropoff" checked><span class="opt-ic">${icon('box', 22)}</span><span class="opt-body"><b>Antar sendiri</b><small>Bawa ke outlet</small></span></label>
                  <label class="opt"><input type="radio" name="handover" value="pickup"><span class="opt-ic">${icon('truck', 22)}</span><span class="opt-body"><b>Dijemput kurir</b><small>Kurir datang ke lokasimu</small></span></label>
                </div>
              </fieldset>
              <fieldset class="field" data-field="returnMethod">
                <legend>Cucian kembali ke kamu lewat</legend>
                <div class="opt-row">
                  <label class="opt"><input type="radio" name="returnMethod" value="self" checked><span class="opt-ic">${icon('box', 22)}</span><span class="opt-body"><b>Ambil sendiri</b><small>Ambil di outlet</small></span></label>
                  <label class="opt"><input type="radio" name="returnMethod" value="delivery"><span class="opt-ic">${icon('truck', 22)}</span><span class="opt-body"><b>Diantar kurir</b><small>Kurir antar ke lokasimu</small></span></label>
                </div>
              </fieldset>
              <p class="hint">Penjemputan atau pengantaran gratis sampai ${freeKm} km dari outlet, selanjutnya ${rupiah(perKm)} per km.</p>
            </section>

            <section class="panel field" id="loc-panel" data-field="address" hidden>
              <h2>Lokasi jemput dan antar</h2>
              <p class="hint">Cari alamat, pakai lokasimu saat ini, atau ketuk langsung di peta. Pin bisa digeser. Lingkaran biru menandai area gratis ongkir.</p>
              <div class="map-tools">
                <div class="input-suffix"><input id="map-q" type="search" placeholder="Cari alamat atau nama tempat" aria-label="Cari alamat"><button type="button" class="icon-btn" id="map-go" aria-label="Cari">${icon('search', 20)}</button></div>
                <button type="button" class="btn btn-ghost" id="map-me">${icon('locate', 18)}Lokasi saya</button>
              </div>
              <div class="map" id="map" role="application" aria-label="Peta untuk menandai lokasi"><div class="map-loading">Memuat peta…</div></div>
              <p class="map-note" id="map-note" hidden></p>
              <p class="map-read" id="map-read" aria-live="polite">Belum ada lokasi dipilih.</p>
              <div class="field">
                <label for="addr">Alamat lengkap</label>
                <textarea id="addr" name="addressText" rows="2" maxlength="300" placeholder="Nama jalan, nomor rumah, patokan"></textarea>
              </div>
            </section>

            <section class="panel" id="voucher-panel" hidden>
              <label class="check"><input type="checkbox" name="useVoucher"><span><b>Pakai voucher gratis Wash & Fold</b><small>Kamu punya ${user.vouchers} voucher. Gratis sampai ${kg(cfg.loyalty.rewardMaxKg)}, kelebihannya dibayar normal.</small></span></label>
              <p class="field-holder" data-field="useVoucher"></p>
            </section>

            <section class="panel">
              <div class="field"><label for="notes">Catatan untuk kami <span class="opt-tag">opsional</span></label>
                <textarea id="notes" name="notes" rows="2" maxlength="300" placeholder="mis. kemeja putih dipisah, jangan pakai pewangi"></textarea></div>
            </section>
          </div>

          <aside class="form-side"><div class="summary" id="summary" aria-live="polite"></div></aside>
        </div>
      </form>
    </div>`);

  const root = container.firstElementChild;
  const form = $('form', root);
  const legs = () => (st.handover === 'pickup' ? 1 : 0) + (st.returnMethod === 'delivery' ? 1 : 0);

  function drawGarments() {
    $('#garments', root).innerHTML = String(html`${cfg.garmentTypes.map((t) => {
      const q = st.garments.get(t);
      const sel = q != null;
      return html`
        <div class="gchip ${sel ? 'on' : ''}">
          <button type="button" class="gchip-btn" data-garment="${t}" aria-pressed="${String(sel)}">${icon(sel ? 'check' : 'plus', 16)}${t}</button>
          ${sel ? html`<span class="qty"><button type="button" data-qty="${t}" data-d="-1" aria-label="Kurangi ${t}">${icon('minus', 14)}</button><output>${q}</output><button type="button" data-qty="${t}" data-d="1" aria-label="Tambah ${t}">${icon('plus', 14)}</button></span>` : ''}
        </div>`;
    })}`);
  }

  function syncVisibility() {
    const needLoc = legs() > 0;
    $('#loc-panel', root).hidden = !needLoc;
    if (needLoc) ensureMap();
    const canVoucher = user.vouchers > 0 && st.serviceId === cfg.loyalty.rewardServiceId;
    $('#voucher-panel', root).hidden = !canVoucher;
    if (!canVoucher && st.useVoucher) { st.useVoucher = false; form.useVoucher.checked = false; }
  }

  let mapPromise = null;
  function ensureMap() {
    if (!mapPromise) mapPromise = initMap();
    return mapPromise;
  }

  async function initMap() {
    const el = $('#map', root);
    const p = await createMapPicker(el, cfg, {
      onPick: ({ lat, lng, distanceKm, method }) => {
        st.address = { ...st.address, lat, lng, distanceKm, method };
        $('#map-read', root).innerHTML = String(html`${icon('pin', 16)}<span>Jarak dari outlet <b>${num(distanceKm)} km</b> ${method === 'route' ? '(rute jalan)' : '(perkiraan garis lurus)'}.${distanceKm <= freeKm ? ' Gratis ongkir.' : ''}</span>`);
        $('#map-read', root).classList.add('ok');
        requote();
      },
      onAddress: (text) => { if (!addressTouched) { st.address.text = text.slice(0, 300); form.addressText.value = st.address.text; } },
      onNotice: (msg) => { const n = $('#map-note', root); n.textContent = msg; n.hidden = false; },
    });
    picker = p;
    if (p.provider === 'osm') {
      const n = $('#map-note', root);
      if (n.hidden) { n.textContent = 'Peta memakai OpenStreetMap. Isi Google Maps API Key di Admin > Tarif & pengaturan untuk beralih ke Google Maps.'; n.hidden = false; }
    }
    onCleanup(() => { if (picker && picker.destroy) picker.destroy(); });
    return p;
  }

  const requote = debounce(async () => {
    const mine = ++seq;
    const body = {
      serviceId: st.serviceId, estimatedWeight: st.estimatedWeight, handover: st.handover, returnMethod: st.returnMethod,
      address: { lat: st.address.lat, lng: st.address.lng, distanceKm: st.address.distanceKm }, useVoucher: st.useVoucher,
    };
    try {
      const q = await post('/api/quote', body);
      if (mine === seq) drawSummary(q);
    } catch (e) { if (mine === seq) drawSummary(null, e.message); }
  }, 180);

  function drawSummary(q, err) {
    const svc = cfg.services.find((s) => s.id === st.serviceId);
    const el = $('#summary', root);
    if (err || !q || !q.bill) {
      mount(el, html`<h2>Ringkasan</h2><p class="hint">${err || 'Pilih layanan untuk melihat perkiraan harga.'}</p>`);
      return;
    }
    const b = q.bill;
    const lines = [];
    lines.push(html`<div class="bill-row"><span>${svc.name}<small>${b.weight > 0 ? `${kg(b.weight)} × ${rupiah(b.pricePerKg)}` : `${rupiah(b.pricePerKg)} per kg, dihitung setelah ditimbang`}</small></span><b>${b.weight > 0 ? rupiah(b.serviceTotal) : '–'}</b></div>`);
    if (b.legs > 0) {
      let detail;
      let val = '–';
      if (q.needsLocation) detail = 'Tandai lokasi di peta';
      else if (q.locationError) detail = q.locationError;
      else if (b.shippingFee === 0) { detail = `Jarak ${num(b.distanceKm)} km, masih dalam batas gratis ${b.freeKm} km`; val = 'Gratis'; }
      else { detail = `${b.extraKm} km × ${rupiah(b.perKm)}${b.chargePerLeg && b.legs > 1 ? ` × ${b.legs} arah` : ''}`; val = rupiah(b.shippingFee); }
      lines.push(html`<div class="bill-row ${q.locationError ? 'bill-err' : ''}"><span>Ongkir antar-jemput<small>${detail}</small></span><b>${val}</b></div>`);
    }
    if (b.discount > 0) lines.push(html`<div class="bill-row bill-disc"><span>Voucher gratis<small>Maksimal ${kg(cfg.loyalty.rewardMaxKg)}</small></span><b>−${rupiah(b.discount)}</b></div>`);
    mount(el, html`
      <h2>Ringkasan</h2>
      <div class="bill">${lines}
        <div class="bill-total"><span>Perkiraan total</span><b>${b.weight > 0 || (b.legs > 0 && !q.needsLocation && !q.locationError) ? rupiah(b.total) : '–'}</b></div>
      </div>
      <p class="hint">Total final mengikuti berat aktual di timbangan outlet. Kamu bisa membayar setelah tagihan final keluar.</p>
      ${b.earnsStamp && b.total > 0 ? html`<p class="note-ok">${icon('drop', 16)}Transaksi ini layak mendapat 1 stamp.</p>` : html`<p class="hint">Stamp diberikan untuk transaksi minimal ${rupiah(b.minStamp)}.</p>`}
      <button class="btn btn-primary btn-block btn-lg" type="submit">Kirim pesanan</button>`);
  }

  // ── interaksi ──
  on(root, 'click', '[data-garment]', (e, b) => {
    const t = b.dataset.garment;
    if (st.garments.has(t)) st.garments.delete(t); else st.garments.set(t, 1);
    drawGarments();
  });
  on(root, 'click', '[data-qty]', (e, b) => {
    const t = b.dataset.qty;
    const next = Math.min(999, Math.max(1, (st.garments.get(t) || 1) + Number(b.dataset.d)));
    st.garments.set(t, next);
    drawGarments();
    const again = $(`[data-qty="${CSS.escape(t)}"][data-d="${b.dataset.d}"]`, root);
    if (again) again.focus();
  });
  form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'serviceId') st.serviceId = t.value;
    if (t.name === 'handover') st.handover = t.value;
    if (t.name === 'returnMethod') st.returnMethod = t.value;
    if (t.name === 'useVoucher') st.useVoucher = t.checked;
    syncVisibility();
    requote();
  });
  form.addEventListener('input', (e) => {
    const t = e.target;
    if (t.name === 'estimatedWeight') { st.estimatedWeight = t.value; requote(); }
    if (t.name === 'addressText') { st.address.text = t.value; addressTouched = true; }
    if (t.name === 'notes') st.notes = t.value;
  });

  const doSearch = async () => {
    const q = $('#map-q', root).value.trim();
    if (!q) return;
    const p = await ensureMap();
    const ok = p && p.search ? await p.search(q) : false;
    if (!ok) toast('Alamat tidak ditemukan. Coba kata kunci lain, atau ketuk langsung di peta.', 'error');
  };
  $('#map-go', root).addEventListener('click', doSearch);
  $('#map-q', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  $('#map-me', root).addEventListener('click', async () => {
    const p = await ensureMap();
    const ok = p && p.locate ? await p.locate() : false;
    if (!ok) toast('Lokasi tidak bisa diambil. Izinkan akses lokasi di browser, atau ketuk langsung di peta.', 'error');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showFieldErrors(form, {});
    const btn = $('[type=submit]', form);
    if (btn) btn.disabled = true;
    try {
      const body = {
        serviceId: st.serviceId,
        garments: [...st.garments].map(([type, qty]) => ({ type, qty })),
        estimatedWeight: st.estimatedWeight, handover: st.handover, returnMethod: st.returnMethod,
        address: legs() > 0 ? { text: st.address.text, lat: st.address.lat, lng: st.address.lng, distanceKm: st.address.distanceKm } : null,
        notes: st.notes, useVoucher: st.useVoucher,
      };
      const res = await post('/api/orders', body);
      const me = await get('/api/auth/me'); if (me.user) updateUser(me.user);
      toast(`Pesanan ${res.order.id} diterima.`, 'ok');
      go(`/app/pesanan/${res.order.id}`);
    } catch (ex) {
      if (ex.fields) { showFieldErrors(form, ex.fields); toast(ex.message, 'error'); }
      else toast(ex.message, 'error');
      if (btn) btn.disabled = false;
    }
  });

  drawGarments();
  syncVisibility();
  requote();
}

// ───────────────────────── pseudo-QR (hanya tampilan) ─────────────────────────
function pseudoQr(seed) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const rnd = () => { h += 0x6D2B79F5; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = 25;
  let d = '';
  const finder = (x0, y0) => {
    for (let y = 0; y < 7; y += 1) for (let x = 0; x < 7; x += 1) {
      const edge = x === 0 || y === 0 || x === 6 || y === 6;
      const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      if (edge || core) d += `M${x0 + x} ${y0 + y}h1v1h-1z`;
    }
  };
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) {
    const inFinder = (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
    const inLogo = x >= 9 && x <= 15 && y >= 9 && y <= 15;
    if (!inFinder && !inLogo && rnd() > 0.52) d += `M${x} ${y}h1v1h-1z`;
  }
  finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
  return raw(`<svg viewBox="-1 -1 27 27" shape-rendering="crispEdges" role="img" aria-label="Contoh kode QR (simulasi)"><rect x="-1" y="-1" width="27" height="27" fill="#fff"/><path d="${d}" fill="#033954"/></svg>`);
}

// ───────────────────────── tracking + pembayaran ─────────────────────────
export async function tracking({ container, params }) {
  const id = params[0];
  mount(container, html`<div class="page">${skeleton()}</div>`);
  let order = (await get(`/api/orders/${encodeURIComponent(id)}`)).order;
  let method = order.payment.method && order.payment.method !== 'cash' ? order.payment.method : 'qris';
  let alive = true;
  onCleanup(() => { alive = false; });

  function draw() {
    const o = order;
    const cfg = state.config;
    const b = o.billing;
    const wa = waLink(cfg.business.whatsapp, `Halo ZibbWash, saya mau tanya soal pesanan ${o.id}.`);
    const canPay = b.isFinal && o.payment.status === 'unpaid' && o.status !== 'cancelled';
    const cur = o.flow[o.currentIndex];

    mount(container, html`
      <div class="page">
        <a class="back" href="#/app/pesanan">${icon('back', 16)}Semua pesanan</a>
        <header class="track-head">
          <div>
            <p class="idline">${o.id}</p>
            <h1>${o.serviceName}</h1>
            <div class="chips">${statusChip(o)}${payChip(o)}</div>
          </div>
          <div class="head-actions">
            <a class="btn btn-ghost" href="${wa}" target="_blank" rel="noopener">${icon('whatsapp', 18)}Tanya admin</a>
            ${o.canCancel ? html`<button class="btn btn-danger-ghost" data-act="cancel">Batalkan pesanan</button>` : ''}
          </div>
        </header>

        ${o.status === 'cancelled' ? html`<div class="notice notice-off">${icon('info', 20)}<span><b>Pesanan ini dibatalkan.</b> ${o.voucherUsed ? 'Voucher kamu sudah dikembalikan.' : ''}</span></div>` : ''}
        ${o.status !== 'cancelled' && o.status !== 'done' && cur ? html`<div class="now-card"><span class="now-ic">${icon('drop', 22)}</span><div><b>${cur.label}</b><p>${cur.desc}</p></div></div>` : ''}
        ${o.status === 'done' ? html`<div class="notice notice-ok">${icon('check', 20)}<span><b>Pesanan selesai.</b> ${o.stamp.awarded ? 'Stamp +1 sudah masuk ke kartumu.' : (o.stamp.note || '')}</span></div>` : ''}

        <div class="track-grid">
          <section class="panel">
            <h2>Status pengerjaan</h2>
            <ol class="timeline">
              ${o.flow.map((s) => html`
                <li class="tl ${s.state}">
                  <span class="tl-dot">${s.state === 'done' ? icon('check', 14) : s.state === 'current' ? icon('drop', 14) : ''}</span>
                  <div class="tl-body"><b>${s.label}</b>${s.state === 'current' ? html`<p>${s.desc}</p>` : ''}</div>
                  <time>${s.at ? fmtDateTime(s.at) : ''}</time>
                </li>`)}
            </ol>
          </section>

          <div class="stack">
            <section class="panel">
              <h2>Rincian tagihan</h2>
              ${billHtml(o)}
            </section>

            <section class="panel pay">
              <h2>Pembayaran</h2>
              ${o.payment.status === 'paid' ? html`
                <div class="paid">
                  <span class="paid-ic">${icon('check', 22)}</span>
                  <div><b>Lunas</b><p>${cfg.paymentMethods.find((m) => m.id === o.payment.method)?.name || o.payment.method} · ${fmtDateTime(o.payment.paidAt)}${o.payment.ref ? html` · <code>${o.payment.ref}</code>` : ''}</p></div>
                </div>`
                : o.payment.status === 'refunded' ? html`<p class="hint">Dana pesanan ini dikembalikan (simulasi).</p>`
                : !b.isFinal ? html`<p class="hint">Tagihan final muncul setelah pakaianmu ditimbang di outlet. Kamu akan melihat tombol bayar di sini.</p>`
                : o.status === 'cancelled' ? '' : html`
                  ${o.payment.method === 'cash' ? html`<div class="notice notice-wait slim">${icon('cash', 18)}<span>Kamu memilih bayar tunai. Bayar di outlet atau ke kurir, lalu admin menandai lunas.</span></div>` : ''}
                  <div class="pay-methods" role="radiogroup" aria-label="Metode pembayaran">
                    ${cfg.paymentMethods.map((m) => html`
                      <label class="opt pay-opt">
                        <input type="radio" name="method" value="${m.id}" ${m.id === method ? 'checked' : ''}>
                        <span class="opt-ic">${icon(PAY_ICON[m.id] || 'card', 22)}</span>
                        <span class="opt-body"><b>${m.name}</b></span>
                      </label>`)}
                  </div>
                  <button class="btn btn-primary btn-block btn-lg" data-act="pay">Bayar ${rupiah(b.total)}</button>
                  <p class="hint">Pembayaran di sini simulasi: tidak ada uang yang berpindah.</p>`}
            </section>

            <section class="panel"><h2>Detail pesanan</h2>${detailsHtml(o)}</section>
            <section class="panel"><h2>Riwayat aktivitas</h2>${activityHtml(o)}</section>
          </div>
        </div>
      </div>`);

    const root = container.firstElementChild;
    on(root, 'change', 'input[name=method]', (e, i) => { method = i.value; });
    on(root, 'click', '[data-act=pay]', () => openPay());
    on(root, 'click', '[data-act=cancel]', () => {
      const m = openModal({
        title: 'Batalkan pesanan?',
        body: html`<p>Pesanan ${o.id} akan dibatalkan.${o.voucherUsed ? ' Voucher gratis yang kamu pakai akan dikembalikan.' : ''} Pesanan yang sudah dijemput atau diproses tidak bisa dibatalkan sendiri.</p>
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Tidak jadi</button><button class="btn btn-danger" id="do-cancel">Ya, batalkan</button></div>`,
      });
      $('#do-cancel', m.el).addEventListener('click', async (ev) => {
        ev.target.disabled = true;
        try {
          order = (await post(`/api/orders/${encodeURIComponent(o.id)}/cancel`)).order;
          const me = await get('/api/auth/me'); if (me.user) updateUser(me.user);
          m.close(); toast('Pesanan dibatalkan.', 'ok'); draw();
        } catch (ex) { toast(ex.message, 'error'); ev.target.disabled = false; }
      });
    });
  }

  function openPay() {
    const o = order;
    const total = o.billing.total;
    const mDef = state.config.paymentMethods.find((m) => m.id === method);
    const va = `8808 ${String(state.user.phone).slice(-10).replace(/(\d{4})(\d{4})(\d*)/, '$1 $2 $3').trim()}`;
    let inner;
    if (method === 'qris') {
      inner = html`<div class="qr-box"><div class="qr">${pseudoQr(o.id)}<img src="/img/logo-mark.png" alt="" width="34" height="38"></div><p>Pindai dengan aplikasi apa pun yang mendukung QRIS.</p></div>`;
    } else if (method === 'va') {
      inner = html`<div class="va-box"><p>Nomor Virtual Account</p><div class="va"><b>${va}</b><button type="button" class="icon-btn" data-copy="${va.replace(/\s/g, '')}" aria-label="Salin nomor">${icon('copy', 18)}</button></div><p class="hint">Transfer dari bank mana pun sesuai nominal.</p></div>`;
    } else if (method === 'ewallet') {
      inner = html`<div class="va-box"><p>Kamu akan diarahkan ke aplikasi e-wallet pilihanmu.</p><div class="wallets"><span>GoPay</span><span>OVO</span><span>DANA</span></div></div>`;
    } else {
      inner = html`<div class="va-box"><p>Bayar tunai di outlet atau ke kurir saat cucian tiba. Setelah uang diterima, admin menandai tagihan ini lunas.</p></div>`;
    }
    const m = openModal({
      title: mDef ? mDef.name : 'Pembayaran',
      body: html`
        <div class="pay-modal">
          <p class="pay-amount"><small>Total tagihan ${o.id}</small><b>${rupiah(total)}</b></p>
          ${inner}
          <p class="sim-tag">${icon('info', 16)}Tampilan simulasi. Tidak ada transaksi uang sungguhan.</p>
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Batal</button><button class="btn btn-primary" id="do-pay">${method === 'cash' ? 'Pilih bayar tunai' : 'Simulasikan pembayaran berhasil'}</button></div>
        </div>`,
    });
    $$('[data-copy]', m.el).forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast('Nomor disalin.', 'ok'); } catch { toast('Salin manual nomor di layar.', 'info'); }
    }));
    $('#do-pay', m.el).addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        const res = await post(`/api/orders/${encodeURIComponent(o.id)}/pay`, { method });
        order = res.order;
        if (res.user) updateUser(res.user);
        m.close();
        toast(method === 'cash' ? 'Bayar tunai dipilih. Admin akan mengonfirmasi.' : 'Pembayaran berhasil. Terima kasih!', 'ok');
        draw();
      } catch (ex) { toast(ex.message, 'error'); ev.target.disabled = false; }
    });
  }

  draw();

  // Ambil status terbaru; dipanggil saat server memberi kabar (langsung) dan oleh polling cadangan tiap 60 detik.
  async function refresh() {
    if (!alive || document.querySelector('dialog[open]')) return;
    try {
      const fresh = (await get(`/api/orders/${encodeURIComponent(id)}`)).order;
      if (alive && fresh.updatedAt !== order.updatedAt) {
        order = fresh; draw();
        toast(`Status diperbarui: ${fresh.statusLabel}.`, 'info');
        const me = await get('/api/auth/me'); if (me.user) updateUser(me.user);
      }
    } catch { /* coba lagi pada pemberitahuan atau putaran berikutnya */ }
  }
  const stopLive = onOrdersChanged(({ ids, resync }) => { if (resync || ids.has(id)) refresh(); });
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  onCleanup(() => { clearInterval(timer); stopLive(); });
}

// ───────────────────────── kartu stamp ─────────────────────────
export async function stamps({ container }) {
  mount(container, html`<div class="page">${skeleton()}</div>`);
  const loy = await get('/api/loyalty');
  updateUser(loy.user);
  const { stampsForReward: need, minTransaction, rewardMaxKg } = loy.loyalty;
  const LABEL = { stamp: 'Stamp +1', reward: 'Voucher gratis didapat', redeem: 'Voucher dipakai', refund: 'Voucher dikembalikan' };
  mount(container, html`
    <div class="page">
      <header class="page-head"><div><h1>Kartu stamp</h1><p>Setiap transaksi minimal ${rupiah(minTransaction)} mendapat 1 stamp.</p></div><a class="btn btn-primary" href="#/app/pesan">${icon('plus', 18)}Pesan laundry</a></header>
      <div class="stamp-page">
        <div>
          ${stampCard({ stamps: loy.user.stamps, need, vouchers: loy.user.vouchers })}
          ${loy.user.vouchers > 0 ? html`
            <div class="notice notice-ok vouch">${icon('gift', 22)}<span><b>${loy.user.vouchers} voucher gratis Wash & Fold</b> siap dipakai. Pilih layanan Wash & Fold saat memesan, lalu centang voucher. Gratis sampai ${kg(rewardMaxKg)}.</span></div>` : ''}
        </div>
        <div class="stack">
          <section class="panel">
            <h2>Cara kerja</h2>
            <ul class="checks dark">
              <li>${icon('check', 18)}<span>Transaksi minimal ${rupiah(minTransaction)} (setelah diskon) mendapat 1 stamp.</span></li>
              <li>${icon('check', 18)}<span>Stamp masuk setelah pesanan selesai <b>dan</b> lunas.</span></li>
              <li>${icon('check', 18)}<span>Terkumpul ${need} stamp menjadi 1 voucher gratis Wash & Fold, maksimal ${kg(rewardMaxKg)}.</span></li>
              <li>${icon('check', 18)}<span>Voucher tidak hangus saat pesanan dibatalkan, otomatis kembali.</span></li>
            </ul>
          </section>
          <section class="panel">
            <h2>Riwayat stamp</h2>
            ${loy.log.length === 0 ? html`<p class="hint">Belum ada aktivitas. Stamp pertamamu muncul setelah pesanan selesai dan lunas.</p>` : html`
              <ol class="activity">
                ${loy.log.slice(0, 20).map((e) => html`
                  <li class="act act-${e.type === 'stamp' || e.type === 'reward' ? 'payment' : 'info'}"><span class="act-dot"></span>
                    <div><p><b>${LABEL[e.type] || e.type}</b> <span class="act-note">${e.orderId}</span></p><small>${fmtDateTime(e.at)}</small></div></li>`)}
              </ol>`}
          </section>
        </div>
      </div>
    </div>`);
}
