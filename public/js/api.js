// Klien API tipis: selalu JSON, cookie sesi ikut otomatis (same-origin).
export class ApiError extends Error {
  constructor(message, status, fields) { super(message); this.status = status; this.fields = fields || null; }
}

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Tidak bisa terhubung ke server. Pastikan server masih berjalan, lalu coba lagi.', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* respons kosong */ }
  if (!res.ok) throw new ApiError((data && data.error) || `Permintaan gagal (${res.status}).`, res.status, data && data.fields);
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body = {}) => api('PUT', url, body);
