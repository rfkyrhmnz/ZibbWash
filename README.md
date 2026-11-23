# ZibbWash Laundry

Website laundry kiloan dengan dua peran (admin dan pelanggan): pemesanan dengan peta, hitung tagihan otomatis, tracking status, pembayaran simulasi, dan kartu stamp. Data tersimpan di satu berkas JSON. Tidak ada dependensi eksternal, jadi tidak perlu `npm install`.

## Menjalankan

Syarat: [Node.js](https://nodejs.org) versi 18 atau lebih baru.

```bash
cd ZibbWash
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

## Memasang online (agar bisa dibuka dari HP dan komputer)

Selama server dijalankan di laptop, website hanya bisa dibuka saat laptop menyala dan terhubung. Supaya bisa diakses kapan saja dari perangkat apa pun, pasang di hosting. Syarat utamanya: hosting harus punya **disk permanen**, karena database-nya berupa berkas `db.json`. Hosting gratis menghapus berkas lokal setiap restart atau deploy ulang, sehingga semua pesanan ikut hilang.

| Pilihan | Biaya (per November 2026, cek halaman harga masing-masing) | Catatan |
|---|---|---|
| Railway | Paket Hobby $5/bulan (sudah termasuk pemakaian $5) + volume $0,15/GB/bulan | Langkah paling singkat, tanpa berkas konfigurasi |
| Render | Instance Starter $7/bulan + disk $0,25/GB/bulan | Ada `render.yaml`, pemasangan hampir otomatis |
| Oracle Cloud Always Free | $0, tanpa batas waktu (butuh kartu untuk verifikasi) | Server virtual 24 jam dengan disk permanen. Lebih teknis dan ada risiko instance idle ditarik, lihat bagian Oracle di bawah |
| Server virtual (VPS) | Sewa bulanan | Paling fleksibel, tetapi butuh langkah teknis sendiri (lihat catatan di bawah) |
| Paket gratis | $0 | **Tidak cocok.** Di Render gratis, layanan mati setelah 15 menit sepi (pelanggan menunggu ±1 menit) dan data hilang tiap restart |

Gunakan wilayah server **Singapura** agar cepat dari Indonesia.

### Railway

1. Daftar di railway.com dan hubungkan akun GitHub.
2. **New Project**, **Deploy from GitHub repo**, lalu pilih repo `ZibbWash`.
3. Buka service, **Settings**, lalu pilih wilayah **Southeast Asia (Singapore)**. Lakukan ini sebelum membuat volume, karena memindahkan wilayah setelah ada volume membuat volumenya harus dimigrasi.
4. Tambahkan **Volume** dengan mount path `/data`. Railway otomatis menyediakan variabel `RAILWAY_VOLUME_MOUNT_PATH` dan aplikasi memakainya, jadi lokasi data tidak perlu diatur lagi.
5. Di **Variables**, isi `NODE_ENV` = `production` dan `ADMIN_PASSWORD` = kata sandi admin yang kuat.
6. Di **Settings > Networking**, klik **Generate Domain**, lalu buka alamatnya.

### Render

1. Daftar di render.com dan hubungkan akun GitHub.
2. **New**, **Blueprint**, lalu pilih repo `ZibbWash`. Render membaca `render.yaml` (wilayah Singapura, disk 1 GB, health check).
3. Saat diminta `ADMIN_PASSWORD`, isi kata sandi admin yang kuat, lalu **Apply**.
4. Tunggu deploy selesai, lalu buka alamat `https://zibbwash-xxxx.onrender.com`.

### Oracle Cloud Always Free (gratis)

Server virtual yang menyala terus dengan disk permanen, tanpa biaya bulanan. Lebih banyak langkah daripada Railway atau Render, tetapi skrip `deploy/oracle-setup.sh` mengerjakan semua yang di dalam server: Node.js, layanan otomatis hidup lagi saat server restart, firewall, HTTPS lewat Caddy, uji otomatis, dan salinan harian database.

Siapkan dulu: nomor HP dan kartu kredit/debit untuk verifikasi (tidak ditagih kecuali kamu upgrade). Oracle menolak kartu virtual, sekali pakai, dan prepaid. **Home region** dipilih saat daftar dan tidak bisa diubah, jadi pilih yang terdekat dari Indonesia.

1. Daftar di oracle.com/cloud/free.
2. Buat kunci SSH di komputermu: jalankan `ssh-keygen -t ed25519` (tekan Enter terus), lalu tampilkan kunci publiknya. Windows PowerShell: `type $env:USERPROFILE\.ssh\id_ed25519.pub`. Mac/Linux: `cat ~/.ssh/id_ed25519.pub`.
3. Di konsol Oracle: **Compute > Instances > Create instance**. Image: *Canonical Ubuntu* 24.04 (atau 22.04). Shape: **VM.Standard.E2.1.Micro** (berlabel Always Free-eligible). Di bagian SSH keys pilih *Paste public keys* dan tempel kunci publik tadi. Pastikan alamat IPv4 publik ikut dibuat, lalu **Create**.
4. Buka port web: **Networking > Virtual cloud networks >** (VCN-mu) **> subnet > Security List > Add Ingress Rules**. Isi Source CIDR `0.0.0.0/0`, protokol TCP, port tujuan `80`. Ulangi untuk `443`.
5. Sambungkan: `ssh ubuntu@IP_PUBLIK_SERVER`.
6. Di dalam server:

```bash
git clone https://github.com/rfkyrhmnz/ZibbWash.git
cd ZibbWash
sudo bash deploy/oracle-setup.sh                 # uji coba lewat http://IP_PUBLIK (tanpa enkripsi)
sudo bash deploy/oracle-setup.sh zibbwash.me     # dengan domain: HTTPS otomatis
```

   Di akhir, skrip mencetak **kata sandi admin awal satu kali** (username `admin`). Catat, masuk, lalu ganti lewat menu **Ganti kata sandi**.
7. Arahkan domain: di pengelola DNS domainmu buat **A record** dengan nama `@` ke IP publik server (opsional `www` juga). Setelah itu jalankan perintah dengan domain di atas. Sertifikat HTTPS terbit otomatis begitu DNS sudah mengarah.

Memperbarui ke versi terbaru:

```bash
cd ~/ZibbWash && git pull && sudo bash deploy/oracle-setup.sh
```

Domain diingat dari pemasangan sebelumnya (tersimpan di `/etc/zibbwash.env`), jadi tidak perlu diketik lagi. Uji otomatis dijalankan dulu; bila gagal, layanan yang sedang jalan tidak disentuh.

Perintah berguna di server:

| Perlu | Perintah |
|---|---|
| Status layanan | `sudo systemctl status zibbwash` |
| Log langsung | `sudo journalctl -u zibbwash -f` |
| Mulai ulang | `sudo systemctl restart zibbwash` |
| Lupa kata sandi admin | Tambahkan `ADMIN_PASSWORD=sandibaru` dan `RESET_ADMIN_PASSWORD=1` ke `/etc/zibbwash.env`, restart, masuk, lalu **hapus kedua baris itu** dan restart lagi |
| Data dan salinan | `/var/lib/zibbwash/db.json`, salinan harian 14 hari di `/var/backups/zibbwash` |

Yang perlu diketahui:

- **Instance idle.** Dokumen Oracle menyebut instance Always Free yang selama 7 hari CPU (persentil ke-95) dan jaringannya di bawah 20% dianggap idle dan "may be reclaimed". Website laundry yang sepi hampir pasti memenuhi itu. Dokumen tidak merinci tindakannya (berhenti atau dihapus) dan tidak menyatakan bahwa upgrade ke Pay As You Go membebaskan dari aturan ini. Kamu bisa upgrade (Oracle hanya menagih pemakaian di atas batas Always Free), tetapi anggap itu belum terjamin. Pegangan yang pasti: pantau `https://domainmu/healthz` dengan layanan pemantau gratis (misalnya UptimeRobot) agar kamu tahu kalau mati, unduh cadangan dari menu admin secara berkala, dan bila instance berhenti, jalankan lagi dari konsol Oracle (data di disk tetap ada).
- **Satu server tanpa cadangan otomatis di luar server.** Salinan harian di server yang sama hanya melindungi dari data rusak. Unduhan dari menu admin yang melindungi dari server hilang.
- Aplikasi hanya mendengarkan `127.0.0.1`; satu-satunya pintu masuk dari internet adalah Caddy di port 80 dan 443.
- Kamu tidak perlu mengatur `TRUST_PROXY`. Skrip sudah mengisinya, sehingga batas percobaan login dihitung per pengunjung.

### Setelah online

1. Masuk di tab **Admin** dengan username `admin`. Bila `ADMIN_PASSWORD` tidak diisi, kata sandi acak dicetak **sekali** di log deploy: cari kotak "AKUN ADMIN DIBUAT".
2. Ganti kata sandi lewat menu **Ganti kata sandi**, isi alamat outlet di **Tarif & pengaturan**, dan cek tarifnya. Bila memakai Google Maps, batasi API key ke alamat website di Google Cloud.
3. Uji dari HP: pesan sebagai pelanggan, ubah statusnya dari admin di komputer, dan lihat perubahannya muncul seketika.
4. Unduh cadangan secara berkala di **Tarif & pengaturan > Cadangan data**.

### Variabel lingkungan

| Variabel | Fungsi |
|---|---|
| `NODE_ENV=production` | Mode produksi: kata sandi admin awal dibuat acak bila `ADMIN_PASSWORD` kosong, dan peringatan keamanan muncul di log |
| `ADMIN_PASSWORD` | Kata sandi admin awal (hanya dipakai saat akun admin pertama kali dibuat) |
| `RESET_ADMIN_PASSWORD=1` | Paksa kata sandi admin menjadi `ADMIN_PASSWORD` saat server start. Dipakai bila lupa kata sandi: set keduanya, deploy ulang, masuk, lalu **hapus** `RESET_ADMIN_PASSWORD` |
| `DATA_DIR` atau `DB_FILE` | Lokasi database. Arahkan ke disk permanen. Di Railway otomatis memakai volume |
| `TRUST_PROXY=1` | Hanya untuk VPS di belakang Nginx/Caddy: baca IP pengunjung dari `X-Forwarded-For` agar pembatas login dihitung per pengunjung |
| `GOOGLE_MAPS_API_KEY` | API key Google Maps (menimpa yang diisi di halaman admin) |
| `PORT` | Diatur otomatis oleh hosting |
| `HOST` | Alamat yang didengarkan. Bawaan `0.0.0.0`. Di belakang Caddy/Nginx pada satu server, isi `127.0.0.1` agar aplikasi tidak terbuka langsung |

### Catatan penting

- Jalankan **satu instance saja** (jangan menambah replika), karena seluruh data ada di satu berkas.
- Kalau `TRUST_PROXY` tidak diset (default di Railway dan Render), pembatas login dihitung per akun, bukan per pengunjung. Tebakan kata sandi tetap dibatasi, tetapi orang iseng bisa mengunci login admin beberapa menit dengan percobaan salah berulang. Kata sandi admin yang kuat adalah perlindungan utamanya.
- Memulihkan dari cadangan: letakkan berkas cadangan sebagai `db.json` di disk data, lalu mulai ulang server. Di VPS tinggal disalin. Di Railway atau Render lakukan lewat shell atau CLI penyedianya.
- Di VPS Ubuntu lain, `deploy/oracle-setup.sh` juga bisa dipakai apa adanya. Untuk pemasangan manual: jalankan `NODE_ENV=production HOST=127.0.0.1 DATA_DIR=/var/lib/zibbwash TRUST_PROXY=1 node server.js` di belakang Nginx atau Caddy (untuk HTTPS), dan jaga proses tetap hidup dengan systemd atau pm2. Aplikasi sudah mengirim header `X-Accel-Buffering: no` agar Nginx tidak menahan pembaruan langsung; bila masih terasa tertunda, tambahkan `proxy_buffering off;` pada jalur `/api/events`.

## Alur pemakaian

1. **Pelanggan** daftar atau masuk di tab *Pelanggan*, lalu memilih layanan, jenis pakaian, cara serah terima, dan lokasi di peta. Ongkir dan perkiraan total muncul langsung.
2. **Admin** masuk di tab *Admin*, membuka pesanan yang masuk, memasukkan **berat aktual** (tagihan final dibuat), lalu memperbarui status: dicuci, dikeringkan, dilipat atau disetrika, siap, dan seterusnya.
3. **Pelanggan** memantau status, membayar lewat tombol simulasi, dan mengumpulkan stamp. Setiap perubahan dari admin langsung muncul di layar pelanggan, dan pesanan baru langsung muncul di daftar admin, tanpa muat ulang halaman (pembaruan langsung lewat Server-Sent Events).

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
test/production.test.js  uji pemasangan online: kata sandi admin, SSE, cadangan, IP
render.yaml          Blueprint untuk Render
deploy/oracle-setup.sh  pasang/perbarui di server Ubuntu (Oracle Always Free): Node, systemd, Caddy, firewall
data/db.json         "database" (dibuat otomatis, jangan di-commit)
public/
  index.html         kerangka halaman
  css/style.css      gaya visual (palet dari logo)
  js/                router, API client, peta, pembaruan langsung (realtime.js), dan tampilan
  js/views/          landing, login, area pelanggan, area admin
  img/               logo
```

Isi `data/db.json`: `settings`, `users`, `sessions`, `orders`. Kata sandi disimpan sebagai hash scrypt, dan token sesi disimpan sebagai hash SHA-256.

## API ringkas

Publik: `GET /healthz`, `GET /api/config`, `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`

Pembaruan langsung (perlu login): `GET /api/events` (Server-Sent Events; server hanya mengirim ID pesanan yang berubah, admin menerima semua, pelanggan hanya pesanannya sendiri)

Pelanggan: `POST /api/quote`, `GET|POST /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/cancel`, `POST /api/orders/:id/pay`, `GET /api/loyalty`

Admin: `GET /api/admin/stats`, `GET /api/admin/orders`, `GET /api/admin/orders/:id`, `POST /api/admin/orders/:id/{weight|status|payment|cancel}`, `GET /api/admin/customers`, `GET|PUT /api/admin/settings`, `GET /api/admin/backup`

Semua endpoint selain publik menolak tamu (401), dan endpoint admin menolak pelanggan (403).

## Pengujian

```bash
npm test
```

24 skenario black box lewat HTTP, memakai database sementara (data asli tidak tersentuh): kontrol akses per peran, validasi form, hitung ongkir, alur pesan sampai stamp, voucher, pembatalan, pengaturan tarif, keamanan dasar (JSON rusak, path traversal, pembatas login), serta untuk pemasangan online: kata sandi admin acak, urutan lokasi database, pembaca IP di balik proxy (termasuk upaya memalsukan header), pembaruan langsung hanya ke yang berhak, dan cadangan data.

## Catatan sebelum dipakai sungguhan

- **Pembayaran hanya simulasi.** Tombol bayar mengubah status menjadi lunas tanpa memindahkan uang. Untuk pembayaran nyata, perlu integrasi payment gateway.
- Database JSON cocok untuk satu outlet dengan beban kecil. Seluruh data dimuat di memori dan ditulis ulang utuh tiap perubahan, jadi hanya satu server yang boleh berjalan. Bila pesanan sudah ribuan atau butuh beberapa server, pindahkan ke SQLite atau PostgreSQL. Seluruh akses data lewat `lib/store.js` dan `lib/logic.js`.
- Ganti kata sandi admin bawaan (`admin123` hanya untuk percobaan di laptop; di mode produksi kata sandi dibuat acak), dan pasang di belakang HTTPS. Cookie sesi otomatis diberi `Secure` bila proxy mengirim `X-Forwarded-Proto: https`, yang dilakukan Railway dan Render.
- Font (Google Fonts) dan peta (CDN) dimuat dari internet. Tanpa koneksi, tampilan memakai font cadangan dan peta tidak muncul.
