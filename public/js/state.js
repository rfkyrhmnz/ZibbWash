// Keadaan global aplikasi (pengguna yang login, konfigurasi bisnis) + pembersih antar-halaman.
export const state = { user: null, config: null, cleanups: [] };

export const onCleanup = (fn) => state.cleanups.push(fn);
export function runCleanups() {
  while (state.cleanups.length) {
    try { state.cleanups.pop()(); } catch { /* abaikan */ }
  }
}
export const go = (path) => { location.hash = `#${path}`; };
export const homeFor = (user) => (user && user.role === 'admin' ? '/admin' : '/app');

// Perbarui data pengguna (mis. jumlah stamp) dan beri tahu kerangka halaman agar ikut diperbarui.
export function updateUser(u) {
  state.user = u;
  window.dispatchEvent(new CustomEvent('zw:user'));
}
