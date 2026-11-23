#!/usr/bin/env bash
# Pasang atau perbarui ZibbWash di server Ubuntu/Debian. Dirancang untuk Oracle Cloud Always Free,
# tetapi jalan di VPS Ubuntu mana pun.
#
# Pemakaian (di server, sebagai root lewat sudo):
#   sudo bash deploy/oracle-setup.sh                 # tanpa domain: HTTP di port 80, hanya untuk uji coba
#   sudo bash deploy/oracle-setup.sh zibbwash.me     # dengan domain: HTTPS otomatis (Let's Encrypt via Caddy)
#
# Aman dijalankan berulang. Menjalankannya lagi = memperbarui ke versi terbaru di GitHub;
# data di /var/lib/zibbwash dan isi /etc/zibbwash.env tidak disentuh.
#
# Variabel opsional (diberikan lewat lingkungan): REPO_URL, BRANCH, NODE_MAJOR, APP_PORT, SKIP_TESTS=1

REPO_URL="${REPO_URL:-https://github.com/rfkyrhmnz/ZibbWash.git}"
BRANCH="${BRANCH:-main}"
NODE_MAJOR="${NODE_MAJOR:-22}"
APP_PORT="${APP_PORT:-3000}"
APP_DIR="${APP_DIR:-/opt/zibbwash}"
DATA_DIR="${DATA_DIR:-/var/lib/zibbwash}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/zibbwash}"
ENV_FILE="${ENV_FILE:-/etc/zibbwash.env}"
UNIT_FILE="${UNIT_FILE:-/etc/systemd/system/zibbwash.service}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
CRON_FILE="${CRON_FILE:-/etc/cron.daily/zibbwash-backup}"
SVC_USER="zibbwash"

say()  { printf '\n==> %s\n' "$*"; }
warn() { printf '[PERINGATAN] %s\n' "$*" >&2; }
die()  { printf '[GAGAL] %s\n' "$*" >&2; exit 1; }

# ---------- fungsi murni (mudah diuji) ----------

# Domain valid: label huruf/angka/tanda hubung dipisah titik, minimal dua label.
valid_domain() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]
}

# Isi Caddyfile. $1 = domain (kosong = HTTP saja di port 80), $2 = port aplikasi.
# Aliran /api/events (pembaruan langsung) tidak dikompres supaya event tidak tertahan di buffer.
render_caddyfile() {
  local site="${1:-:80}" port="$2"
  cat <<EOF
# Dibuat oleh deploy/oracle-setup.sh. Perubahan manual akan ditimpa saat skrip dijalankan lagi.
${site} {
	@kompres not path /api/events
	encode @kompres zstd gzip

	reverse_proxy 127.0.0.1:${port} {
		flush_interval -1
	}
}
EOF
}

# Isi unit systemd. Aplikasi hanya boleh menulis ke DATA_DIR.
render_unit() {
  cat <<EOF
[Unit]
Description=ZibbWash Laundry
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SVC_USER}
Group=${SVC_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/local/bin/node server.js
Restart=always
RestartSec=3
TimeoutStopSec=15
MemoryMax=350M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
}

# Tambahkan KEY=VALUE ke berkas lingkungan hanya bila KEY belum ada (nilai buatan pengguna tidak ditimpa).
ensure_env() {
  local file="$1" key="$2" value="$3"
  grep -qE "^${key}=" "$file" 2>/dev/null || printf '%s=%s\n' "$key" "$value" >> "$file"
}

# Ganti (atau tambahkan) KEY=VALUE di berkas lingkungan. Dipakai untuk nilai yang dikelola skrip ini (domain).
set_env() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

get_env() { grep -E "^$2=" "$1" 2>/dev/null | head -n1 | cut -d= -f2- || true; }

# Dari isi SHASUMS256.txt (stdin) ambil baris tarball Linux untuk arsitektur $1 (x64 atau arm64).
pick_node_tarball() {
  grep -E "  node-v[0-9]+\.[0-9]+\.[0-9]+-linux-$1\.tar\.xz$" | head -n1
}

# Buka port TCP di iptables (Ubuntu di Oracle memblokir semuanya kecuali SSH) dan ufw bila aktif.
allow_port() {
  local p="$1"
  if command -v iptables >/dev/null 2>&1; then
    iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null \
      || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "${p}/tcp" >/dev/null
  fi
}

render_backup_script() {
  cat <<EOF
#!/bin/sh
# Salinan harian db.json (penulisan database atomik, jadi salinannya selalu utuh). Simpan 14 hari.
# Ini melindungi dari data rusak, bukan dari server hilang: unduh cadangan dari menu admin secara berkala.
set -eu
src="${DATA_DIR}/db.json"
dst="${BACKUP_DIR}"
[ -f "\$src" ] || exit 0
install -d -m 700 "\$dst"
cp "\$src" "\$dst/db-\$(date +%F).json"
chmod 600 "\$dst/db-\$(date +%F).json"
find "\$dst" -name 'db-*.json' -mtime +14 -delete
EOF
}

# ---------- langkah pemasangan ----------

preflight() {
  [ "$(id -u)" -eq 0 ] || die "Jalankan sebagai root: sudo bash deploy/oracle-setup.sh [domain]"
  command -v apt-get >/dev/null 2>&1 || die "Skrip ini untuk Ubuntu/Debian (butuh apt-get)."
  case "$(uname -m)" in
    x86_64)  NODE_ARCH=x64 ;;
    aarch64) NODE_ARCH=arm64 ;;
    *) die "Arsitektur $(uname -m) belum didukung skrip ini." ;;
  esac
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
}

ensure_swap() {
  local mem_kb
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  if [ "$mem_kb" -lt 1500000 ] && [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
    say "RAM kecil terdeteksi, menambah swap 1 GB sebagai pengaman"
    if fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
      grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    else
      warn "Gagal membuat swap. Lanjut tanpa swap."
      rm -f /swapfile
    fi
  fi
}

install_packages() {
  say "Memasang paket dasar"
  apt-get update -y
  apt-get install -y git curl ca-certificates xz-utils gnupg
  if ! command -v netfilter-persistent >/dev/null 2>&1; then
    apt-get install -y iptables-persistent
  fi
}

install_node() {
  local have=""
  if [ -x /usr/local/bin/node ]; then have="$(/usr/local/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"; fi
  if [ "$have" = "$NODE_MAJOR" ]; then
    say "Node.js $NODE_MAJOR sudah terpasang ($(/usr/local/bin/node -v))"
    return
  fi
  say "Memasang Node.js $NODE_MAJOR (arsitektur $NODE_ARCH) dari nodejs.org"
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" tmp line sum file
  tmp="$(mktemp -d)"
  line="$(curl -fsSL "$base/SHASUMS256.txt" | pick_node_tarball "$NODE_ARCH")" || true
  [ -n "$line" ] || die "Tidak menemukan berkas Node.js $NODE_MAJOR untuk $NODE_ARCH di $base"
  sum="${line%% *}"; file="${line##* }"
  curl -fSL --retry 3 -o "$tmp/$file" "$base/$file"
  (cd "$tmp" && printf '%s  %s\n' "$sum" "$file" | sha256sum -c -) || die "Checksum Node.js tidak cocok. Batalkan."
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'
  rm -rf "$tmp"
  say "Node.js terpasang: $(/usr/local/bin/node -v)"
}

setup_user_dirs() {
  id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
  install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
}

fetch_code() {
  if [ -d "$APP_DIR/.git" ]; then
    say "Memperbarui kode dari GitHub ($BRANCH)"
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$APP_DIR" reset --hard FETCH_HEAD
  else
    say "Mengambil kode dari GitHub ($REPO_URL)"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  say "Versi kode: $(git -C "$APP_DIR" log -1 --format='%h %s')"
}

run_tests() {
  if [ "${SKIP_TESTS:-0}" = "1" ]; then warn "SKIP_TESTS=1, uji dilewati."; return; fi
  say "Menjalankan uji otomatis di server ini (sebelum layanan dimulai ulang)"
  (cd "$APP_DIR" && PATH="/usr/local/bin:$PATH" timeout 180 npm test --silent) \
    || die "Uji otomatis gagal. Layanan lama (bila ada) tidak diubah. Periksa pesan di atas."
}

write_config() {
  say "Menulis konfigurasi"
  ( umask 077; touch "$ENV_FILE" )
  chmod 600 "$ENV_FILE"
  ensure_env "$ENV_FILE" NODE_ENV production
  ensure_env "$ENV_FILE" HOST 127.0.0.1        # hanya Caddy yang boleh menjangkau aplikasi
  ensure_env "$ENV_FILE" PORT "$APP_PORT"
  ensure_env "$ENV_FILE" DATA_DIR "$DATA_DIR"
  ensure_env "$ENV_FILE" TRUST_PROXY 1          # satu proxy (Caddy): IP pengunjung dibaca dari X-Forwarded-For
  [ -z "$DOMAIN" ] || set_env "$ENV_FILE" ZW_DOMAIN "$DOMAIN"   # diingat untuk pembaruan berikutnya
  render_unit > "$UNIT_FILE"
  chmod 644 "$UNIT_FILE"
  render_backup_script > "$CRON_FILE"
  chmod 755 "$CRON_FILE"
  systemctl daemon-reload
}

open_firewall() {
  say "Membuka port 80 dan 443 di firewall server"
  allow_port 80
  allow_port 443
  command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null
  return 0
}

install_caddy() {
  if ! command -v caddy >/dev/null 2>&1; then
    say "Memasang Caddy (HTTPS otomatis)"
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi
  [ -f "$CADDYFILE.bak-asli" ] || { [ -f "$CADDYFILE" ] && cp "$CADDYFILE" "$CADDYFILE.bak-asli"; } || true
  render_caddyfile "$DOMAIN" "$APP_PORT" > "$CADDYFILE.baru"
  caddy validate --config "$CADDYFILE.baru" --adapter caddyfile >/dev/null 2>&1 \
    || { caddy validate --config "$CADDYFILE.baru" --adapter caddyfile; die "Caddyfile tidak valid (lihat pesan di atas). Konfigurasi lama tidak diubah."; }
  mv "$CADDYFILE.baru" "$CADDYFILE"
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl reload-or-restart caddy
}

check_dns() {
  local mine theirs
  mine="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
  PUBLIC_IP="$mine"
  [ -n "$DOMAIN" ] || return 0
  theirs="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
  if [ -z "$theirs" ]; then
    warn "Domain $DOMAIN belum mengarah ke IP mana pun. Tambahkan A record ke ${mine:-IP publik server ini}. Sertifikat HTTPS baru terbit setelah itu (Caddy mencoba sendiri)."
  elif [ -n "$mine" ] && [ "$theirs" != "$mine" ]; then
    warn "Domain $DOMAIN mengarah ke $theirs, sedangkan IP publik server ini $mine. Perbaiki A record-nya."
  fi
}

start_app() {
  say "Memulai layanan zibbwash"
  START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
  systemctl enable zibbwash >/dev/null 2>&1
  systemctl restart zibbwash
  local i
  for i in $(seq 1 20); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  journalctl -u zibbwash -n 40 --no-pager >&2 || true
  die "Aplikasi tidak menjawab di /healthz. Log di atas."
}

show_result() {
  local url
  if [ -n "$DOMAIN" ]; then url="https://$DOMAIN"; else url="http://${PUBLIC_IP:-IP-PUBLIK-SERVER}"; fi

  local banner
  banner="$(journalctl -u zibbwash --since "$START_TS" --no-pager -o cat 2>/dev/null | grep -B1 -A4 'AKUN ADMIN DIBUAT' || true)"
  printf '\n================================================================\n'
  printf ' ZibbWash berjalan.\n\n'
  printf ' Alamat : %s\n' "$url"
  printf ' Layanan: systemctl status zibbwash   |   log: journalctl -u zibbwash -f\n'
  printf ' Data   : %s/db.json (salinan harian di %s)\n' "$DATA_DIR" "$BACKUP_DIR"
  if [ -n "$banner" ]; then
    printf '\n%s\n' "$banner"
  else
    printf '\n Akun admin sudah ada dari pemasangan sebelumnya (kata sandi tidak ditampilkan lagi).\n'
  fi
  if [ -z "$DOMAIN" ]; then
    printf '\n Mode uji coba: HTTP tanpa enkripsi. JANGAN dipakai untuk login sungguhan.\n'
    printf ' Setelah punya domain: sudo bash deploy/oracle-setup.sh namadomain.com\n'
  fi
  printf '\n Bila alamat tidak terbuka dari luar: buka port 80 dan 443 di Security List\n'
  printf ' subnet Oracle (Networking > VCN > Subnet > Security List > Ingress Rules).\n'
  printf '================================================================\n'
}

main() {
  set -euo pipefail
  trap 'printf "[GAGAL] skrip berhenti di baris %s\n" "$LINENO" >&2' ERR

  DOMAIN="${1:-}"
  # Tanpa argumen, pakai domain yang tersimpan dari pemasangan sebelumnya (supaya pembaruan tidak menghapus HTTPS).
  [ -n "$DOMAIN" ] || DOMAIN="$(get_env "$ENV_FILE" ZW_DOMAIN)"
  DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')"
  PUBLIC_IP=""
  if [ -n "$DOMAIN" ] && ! valid_domain "$DOMAIN"; then
    die "Domain \"$DOMAIN\" tidak valid. Contoh benar: zibbwash.me (tanpa http:// dan tanpa garis miring)."
  fi

  preflight
  ensure_swap
  install_packages
  install_node
  setup_user_dirs
  fetch_code
  run_tests
  write_config
  open_firewall
  install_caddy
  check_dns
  start_app
  show_result
}

# Hanya jalankan main bila skrip dieksekusi langsung (bukan di-source untuk pengujian).
# "exit" ada di blok yang sama agar bash tidak membaca sisa berkas yang mungkin sudah diganti git saat pembaruan.
if [ -z "${BASH_SOURCE[0]:-}" ] || [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit 0; fi
