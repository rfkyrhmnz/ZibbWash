// Komponen yang dipakai bersama oleh area pelanggan dan admin.
import { html, raw, icon, rupiah, kg, num, fmtDateTime, mapsLink, HANDOVER, RETURN, statusChip, payChip } from '../util.js';

/** Rincian tagihan: berat × tarif + ongkir − diskon = total. */
export function billHtml(o) {
  const b = o.billing;
  const rows = [];
  rows.push(html`<div class="bill-row"><span>${o.serviceName}<small>${b.weight > 0 ? `${kg(b.weight)} × ${rupiah(b.pricePerKg)}` : 'Menunggu berat'}</small></span><b>${b.weight > 0 ? rupiah(b.serviceTotal) : '–'}</b></div>`);
  if (b.legs > 0) {
    const detail = b.shippingFee === 0
      ? `Jarak ${num(b.distanceKm)} km, gratis sampai ${b.freeKm} km`
      : `${b.extraKm} km × ${rupiah(b.perKm)}${b.chargePerLeg && b.legs > 1 ? ` × ${b.legs} arah` : ''} (jarak ${num(b.distanceKm)} km)`;
    rows.push(html`<div class="bill-row"><span>Ongkir antar-jemput<small>${detail}</small></span><b>${b.shippingFee === 0 ? 'Gratis' : rupiah(b.shippingFee)}</b></div>`);
  } else {
    rows.push(html`<div class="bill-row"><span>Ongkir<small>Antar dan ambil sendiri</small></span><b>Rp0</b></div>`);
  }
  if (o.voucherUsed) {
    rows.push(html`<div class="bill-row bill-disc"><span>Voucher gratis Wash & Fold<small>Maksimal ${kg(b.discountKg || 3)}</small></span><b>−${rupiah(b.discount)}</b></div>`);
  }
  return html`
    <div class="bill">
      ${rows}
      <div class="bill-total"><span>${b.isFinal ? 'Total tagihan' : 'Perkiraan total'}</span><b>${b.weight > 0 || b.legs > 0 ? rupiah(b.total) : '–'}</b></div>
      ${b.isFinal ? '' : html`<p class="hint">Total final dihitung dari berat aktual setelah pakaian ditimbang di outlet.</p>`}
    </div>`;
}

/** Daftar detail pesanan (read-only). */
export function detailsHtml(o) {
  const garments = o.garments.map((g) => `${g.type} ×${g.qty}`).join(', ');
  const row = (k, v) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`;
  return html`
    <dl class="kv">
      ${row('Layanan', o.serviceName)}
      ${row('Jenis pakaian', garments)}
      ${row('Perkiraan berat', o.estimatedWeight ? kg(o.estimatedWeight) : 'Tidak diisi')}
      ${row('Berat aktual', o.actualWeight != null ? kg(o.actualWeight) : 'Belum ditimbang')}
      ${row('Penyerahan', HANDOVER[o.handover])}
      ${row('Pengambilan', RETURN[o.returnMethod])}
      ${o.address ? row('Alamat', html`${o.address.text} <a class="link" target="_blank" rel="noopener" href="${mapsLink(o.address.lat, o.address.lng)}">Buka di peta</a>`) : ''}
      ${o.address ? row('Jarak dari outlet', `${num(o.distanceKm)} km`) : ''}
      ${o.notes ? row('Catatan', o.notes) : ''}
      ${row('Dibuat', fmtDateTime(o.createdAt))}
    </dl>`;
}

/** Log aktivitas (terbaru di atas). */
export function activityHtml(o) {
  const items = [...o.log].reverse();
  return html`
    <ol class="activity">
      ${items.map((e) => html`
        <li class="act act-${e.kind}">
          <span class="act-dot"></span>
          <div>
            <p><b>${e.label}</b>${e.note ? html` <span class="act-note">${e.note}</span>` : ''}</p>
            <small>${fmtDateTime(e.at)} · ${e.by}</small>
          </div>
        </li>`)}
    </ol>`;
}

export function pipBar(o) {
  const total = o.flow.length;
  return html`<div class="seg" role="img" aria-label="Tahap ${o.currentIndex + 1} dari ${total}">${o.flow.map((s) => html`<span class="${s.state}"></span>`)}</div>`;
}

export const emptyState = (title, body, action) => html`
  <div class="empty">
    <img src="/img/logo-mark.png" alt="" width="56" height="62">
    <h3>${title}</h3>
    <p>${body}</p>
    ${action || ''}
  </div>`;

export const skeleton = () => html`<div class="skel" aria-busy="true" aria-label="Memuat"><i></i><i></i><i></i></div>`;

export { statusChip, payChip, icon, raw };
