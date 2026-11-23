# ZibbWash Laundry

Website laundry kiloan dengan dua peran (admin dan pelanggan): pemesanan dengan peta, hitung tagihan otomatis, tracking status, pembayaran simulasi, dan kartu stamp. Data tersimpan di satu berkas JSON. Tidak ada dependensi eksternal, jadi tidak perlu `npm install`.

## Menjalankan

Syarat: [Node.js](https://nodejs.org) versi 18 atau lebih baru.

```bash
cd zibbwash-laundry
npm start                  # buka http://localhost:3000
```

Pertama kali dijalankan, server membuat `data/db.json` berisi pengaturan bawaan dan satu akun admin.

Ingin langsung melihat tampilan berisi data? Jalankan sekali sebelum `npm start`:

```bash
npm run seed               # membuat data contoh (batal bila db.json sudah berisi data)
npm run seed -- --force    # menimpa db.json yang ada
```

| Peran | Login | Kata sandi |
|---|---|---|
| Admin | username `admin` | `admin123` (ganti lewat menu **Ganti kata sandi**) |
| Pelanggan contoh (setelah `seed`) | `081234567890` (Rina, 7 stamp) | `demo123` |
| Pelanggan contoh (setelah `seed`) | `081298765432` (Budi) | `demo123` |

Kata sandi awal admin bisa ditentukan saat database pertama dibuat: `ADMIN_PASSWORD=rahasiaku npm start`.
Port bisa diubah dengan `PORT=8080 npm start`.

## Alur pemakaian

1. **Pelanggan** daftar atau masuk di tab *Pelanggan*, lalu memilih layanan, jenis pakaian, cara serah terima, dan lokasi di peta. Ongkir dan perkiraan total muncul langsung.
2. **Admin** masuk di tab *Admin*, membuka pesanan yang masuk, memasukkan **berat aktual** (tagihan final dibuat), lalu memperbarui status: dicuci, dikeringkan, dilipat atau disetrika, siap, dan seterusnya.
3. **Pelanggan** memantau status (halaman diperbarui otomatis tiap 15 detik), membayar lewat tombol simulasi, dan mengumpulkan stamp.

Alur status mengikuti pilihan pelanggan:

- Antar sendiri: Diterima, Ditimbang, Dicuci, Dikeringkan, Dilipat/Disetrika, Siap diambil, Selesai.
- Dijemput kurir: menambah tahap **Dijemput kurir** setelah Diterima.
- Diantar kurir: menambah tahap **Dalam pengantaran** setelah Siap diantar.

## Aturan bisnis

| Aturan | Nilai awal | Ubah di |
|---|---|---|
| Tagihan | berat aktual × tarif layanan + ongkir − diskon voucher | |
| Tarif Regular / Express / Wash & Fold / Wash & Iron | Rp6.000 / 10.000 / 7.000 / 9.000 per kg | Admin > Tarif dan pengaturan |
| Antar-jemput gratis | sampai 3 km dari outlet | Admin > Tarif dan pengaturan |
| Ongkir di atas batas gratis | Rp3.000 per km, kelebihan jarak dibulatkan ke atas | idem |
| Ongkir per arah | aktif: jemput dan antar dihitung masing-masing | idem |
| Jangkauan maksimal antar-jemput | 20 km | idem |
| Stamp | 1 stamp untuk transaksi minimal Rp30.000 (setelah diskon) | idem |
| Hadiah | 10 stamp = voucher gratis Wash & Fold maksimal 3 kg | idem |

Catatan penting:

- **Tarif per kg di atas adalah angka contoh.** Sesuaikan dengan tarif sebenarnya sebelum dipakai.
- Pesanan lama tetap memakai tarif saat dipesan. Perubahan tarif hanya berlaku untuk pesanan baru.
- Stamp masuk **sekali per pesanan**, ketika pesanan berstatus *Selesai* dan *Lunas*.
- Voucher dipakai saat memesan layanan Wash & Fold. Bila pesanan dibatalkan, voucher otomatis kembali.
- Pelanggan hanya bisa membatalkan pesanan yang masih berstatus *Pesanan diterima*. Setelah itu, admin yang membatalkan.
- Jarak dari peta dicek ulang di server: tidak boleh lebih pendek dari garis lurus ke outlet, jadi ongkir tidak bisa diakali dari browser.

## Google Maps

Tanpa konfigurasi apa pun, peta memakai **OpenStreetMap** (Leaflet, rute dari OSRM, pencarian dari Nominatim) sehingga langsung berfungsi. Untuk memakai **Google Maps**:

1. Di Google Cloud Console, aktifkan *Maps JavaScript API*, *Directions API*, dan *Geocoding API*, lalu buat API key.
2. Batasi key ke domain websitemu (HTTP referrer).
3. Tempel key di **Admin > Tarif dan pengaturan > Google Maps API Key**, atau jalankan dengan `GOOGLE_MAPS_API_KEY=... npm start`.

Atur juga **latitude dan longitude outlet** di halaman yang sama. Titik itu menjadi dasar perhitungan jarak. Nilai awalnya sudah diisi titik outlet ZibbWash (-7,277005; 112,789758). Alamat tertulis outlet masih perlu diisi di halaman yang sama.

Bila Google Maps gagal dimuat (key salah atau API belum aktif), aplikasi otomatis kembali ke OpenStreetMap.

## Palet warna

Empat warna utama (dari papan merek yang diberikan pemilik):

| Warna | Hex | Dipakai untuk |
|---|---|---|
| Cyan | `#0DADD2` | aksen merek, stamp, penanda aktif |
| Navy | `#033954` | judul, panel admin, bagian gelap |
| Abu terang | `#E9EBEC` | garis, latar chip netral |
| Es | `#E7F7FC` | latar bagian, chip, hover |

Cyan murni hanya berkontras 2,6:1 dengan teks putih, jadi tombol, tautan, dan banner status memakai turunan yang lebih gelap, yaitu campuran cyan dan navy: `#087999` (kontras 5,0:1) dan `#065C7A` (7,5:1). Semua token ada di blok `:root` di `public/css/style.css`. Beberapa warna tertulis langsung di kode karena berada di dalam SVG: gelombang hero (`public/js/views/landing.js`), penanda peta (`public/js/maps.js`), dan pseudo-QR (`public/js/views/customer.js`). Warna hijau, kuning, dan merah pada lencana status pesanan sengaja dibiarkan sebagai warna fungsional.

## Struktur proyek

```
server.js            server HTTP + semua endpoint API
lib/
  logic.js           aturan bisnis: validasi, tagihan, alur status, pembayaran, stamp
  auth.js            hash kata sandi (scrypt), sesi cookie, pembatas login
  store.js           database JSON (baca/tulis atomik) + pengaturan bawaan
scripts/seed-demo.js data contoh
test/api.test.js     uji alur lengkap lewat HTTP
data/db.json         "database" (dibuat otomatis, jangan di-commit)
public/
  index.html         kerangka halaman
  css/style.css      gaya visual (palet dari logo)
  js/                router, API client, peta, dan tampilan
  js/views/          landing, login, area pelanggan, area admin
  img/               logo
```

Isi `data/db.json`: `settings`, `users`, `sessions`, `orders`. Kata sandi disimpan sebagai hash scrypt, dan token sesi disimpan sebagai hash SHA-256.

## API ringkas

Publik: `GET /api/config`, `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`

Pelanggan: `POST /api/quote`, `GET|POST /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/cancel`, `POST /api/orders/:id/pay`, `GET /api/loyalty`

Admin: `GET /api/admin/stats`, `GET /api/admin/orders`, `GET /api/admin/orders/:id`, `POST /api/admin/orders/:id/{weight|status|payment|cancel}`, `GET /api/admin/customers`, `GET|PUT /api/admin/settings`

Semua endpoint selain publik menolak tamu (401), dan endpoint admin menolak pelanggan (403).

## Pengujian

```bash
npm test
```

12 skenario black box lewat HTTP, memakai database sementara (data asli tidak tersentuh): kontrol akses per peran, validasi form, hitung ongkir, alur pesan sampai stamp, voucher, pembatalan, pengaturan tarif, dan keamanan dasar (JSON rusak, path traversal, pembatas login).

## Catatan sebelum dipakai sungguhan

- **Pembayaran hanya simulasi.** Tombol bayar mengubah status menjadi lunas tanpa memindahkan uang. Untuk pembayaran nyata, perlu integrasi payment gateway.
- Database JSON cocok untuk demo dan beban kecil. Bila pesanan sudah banyak, pindahkan ke SQLite atau PostgreSQL. Seluruh akses data lewat `lib/store.js` dan `lib/logic.js`.
- Ganti kata sandi admin bawaan, dan pasang di belakang HTTPS (cookie sesi otomatis diberi `Secure` bila memakai HTTPS lewat proxy yang mengirim `X-Forwarded-Proto`).
- Font (Google Fonts) dan peta (CDN) dimuat dari internet. Tanpa koneksi, tampilan memakai font cadangan dan peta tidak muncul.
