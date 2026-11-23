// Pembaruan langsung lewat Server-Sent Events. Server hanya memberi tahu "pesanan X berubah";
// tampilan lalu mengambil data terbarunya lewat API biasa. Bila koneksi putus, EventSource menyambung ulang sendiri.
import { state } from './state.js';

let source = null;
let visibilityBound = false;

function emit(detail) {
  window.dispatchEvent(new CustomEvent('zw:orders', { detail }));
}

export function startRealtime() {
  if (typeof EventSource === 'undefined' || !state.user) return;
  if (!visibilityBound) {
    visibilityBound = true;
    // HP sering menidurkan tab di latar belakang: saat dibuka lagi, segarkan tampilan.
    document.addEventListener('visibilitychange', () => { if (!document.hidden && source) emit({ id: null, resync: true }); });
  }
  if (source) return;
  let opened = false;
  source = new EventSource('/api/events');
  source.addEventListener('hello', () => {
    // Tersambung kembali setelah putus: mungkin ada perubahan yang terlewat.
    if (opened) emit({ id: null, resync: true });
    opened = true;
  });
  source.addEventListener('orders', (e) => {
    let d = {};
    try { d = JSON.parse(e.data); } catch { /* abaikan */ }
    emit(d);
  });
  source.onerror = () => {
    // readyState 2 (CLOSED): server menolak (mis. sesi habis), jangan mencoba menyambung terus-menerus.
    if (source && source.readyState === 2) stopRealtime();
  };
}

export function stopRealtime() {
  if (source) { source.close(); source = null; }
}

/**
 * Jalankan fn({ ids, resync }) saat ada kabar pesanan berubah. Kabar beruntun digabung jadi satu panggilan.
 * `ids` berisi ID pesanan yang berubah, `resync` true bila perlu menyegarkan semuanya.
 * Mengembalikan fungsi pembersih (daftarkan lewat onCleanup).
 */
export function onOrdersChanged(fn, delay = 250) {
  let timer = null;
  let ids = new Set();
  let resync = false;
  const handler = (e) => {
    const d = e.detail || {};
    if (d.id) ids.add(d.id);
    if (d.resync) resync = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = { ids, resync };
      ids = new Set(); resync = false;
      fn(batch);
    }, delay);
  };
  window.addEventListener('zw:orders', handler);
  return () => { clearTimeout(timer); window.removeEventListener('zw:orders', handler); };
}
