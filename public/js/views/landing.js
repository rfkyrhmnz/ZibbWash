// Halaman depan publik: hero dengan tiket tracking, papan tarif, penggaris ongkir, kartu stamp, kontak.
import { html, mount, $, $$, icon, rupiah, num, phonePretty, waLink, serviceIcon, courierInfo, courierHours } from '../util.js';
import { state, onCleanup } from '../state.js';

export function landingView({ container }) {
  const cfg = state.config;
  const u = state.user;
  const { freeKm, perKm } = cfg.delivery;
  const { minTransaction, stampsForReward, rewardMaxKg } = cfg.loyalty;
  const wf = cfg.services.find((s) => s.id === 'wash-fold') || cfg.services[0];
  const sample = 3.4;
  const wa = waLink(cfg.business.whatsapp, 'Halo ZibbWash, saya mau tanya soal laundry.');
  const demoStamps = Math.min(7, stampsForReward - 1);
  const { instagram, email } = cfg.business;
  const socials = (cls) => (instagram || email ? html`
    <ul class="socials ${cls}">
      ${instagram ? html`<li><a href="https://www.instagram.com/${instagram}/" target="_blank" rel="noopener" aria-label="Instagram ${instagram}">${icon('at', 18)}<span>Instagram: ${instagram}</span></a></li>` : ''}
      ${email ? html`<li><a href="mailto:${email}">${icon('mail', 18)}<span>${email}</span></a></li>` : ''}
    </ul>` : '');

  mount(container, html`
  <div class="public">
    <header class="pubnav">
      <a class="brand" href="#/" aria-label="ZibbWash Laundry, beranda"><img src="/img/logo-mark.png" alt="" width="38" height="42"><span>ZibbWash<small>Laundry</small></span></a>
      <nav class="pubnav-links" aria-label="Bagian halaman">
        <a href="#/" data-scroll="layanan">Tarif</a>
        <a href="#/" data-scroll="antar-jemput">Antar-jemput</a>
        <a href="#/" data-scroll="stamp">Kartu stamp</a>
        <a href="#/" data-scroll="kontak">Kontak</a>
      </nav>
      ${u
        ? html`<a class="btn btn-primary btn-sm" href="#${u.role === 'admin' ? '/admin' : '/app'}">Buka ${u.role === 'admin' ? 'panel admin' : 'akunku'}</a>`
        : html`<a class="btn btn-primary btn-sm" href="#/masuk">Masuk</a>`}
    </header>

    <main id="main" tabindex="-1">
      <section class="hero">
        <svg class="hero-bg" viewBox="0 0 1440 700" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="hg1" x1="0" x2="1"><stop offset="0" stop-color="#0DADD2" stop-opacity="0"/><stop offset=".55" stop-color="#0DADD2" stop-opacity=".28"/><stop offset="1" stop-color="#0B9CBF" stop-opacity=".12"/></linearGradient>
            <linearGradient id="hg2" x1="0" x2="1"><stop offset="0" stop-color="#087999" stop-opacity=".05"/><stop offset=".6" stop-color="#0B9CBF" stop-opacity=".22"/><stop offset="1" stop-color="#0DADD2" stop-opacity=".26"/></linearGradient>
          </defs>
          <path d="M0 430C220 330 430 540 720 480S1190 300 1440 390V700H0Z" fill="url(#hg1)"/>
          <path d="M0 520C290 440 520 610 830 556S1230 440 1440 500V700H0Z" fill="url(#hg2)"/>
          <path d="M0 628C250 584 560 664 880 628S1260 590 1440 624V700H0Z" fill="#F4FBFE"/>
        </svg>

        <div class="hero-copy">
          <h1>Cucian bersih, prosesnya bisa kamu pantau.</h1>
          <p class="lead">Pesan dari rumah. Kurir kami menjemput gratis sampai ${freeKm} km, dan tiap tahap, dari dicuci sampai dilipat, muncul di ponselmu.</p>
          <div class="cta-row">
            <a class="btn btn-primary btn-lg" href="#/app/pesan">Pesan laundry</a>
            <a class="btn btn-ghost btn-lg" href="#/" data-scroll="layanan">Lihat tarif</a>
          </div>
          <ul class="hero-facts">
            <li>${icon('truck', 18)}Antar-jemput gratis sampai ${freeKm} km</li>
            <li>${icon('clock', 18)}Jam operasional ${courierHours(cfg.delivery)}</li>
            <li>${icon('scale', 18)}Tagihan dari berat timbangan sebenarnya</li>
            <li>${icon('gift', 18)}${stampsForReward} stamp, cuci Wash & Fold gratis</li>
          </ul>
        </div>

        <div class="hero-art">
          <img class="hero-logo" src="/img/logo.png" alt="Logo ZibbWash Laundry" width="380" height="394">
          <article class="ticket" aria-label="Contoh tampilan tracking pesanan">
            <header class="ticket-head">
              <span class="ticket-id">ZW-261123-014</span>
              <span class="chip chip-work"><i></i>Sedang dikeringkan</span>
            </header>
            <p class="ticket-sub">${wf.name} · ${num(sample)} kg · antar-jemput</p>
            <ol class="ticket-steps">
              <li class="ts done" style="--i:0"><span class="ts-dot">${icon('check', 14)}</span><b>Dijemput kurir</b><time>08.12</time></li>
              <li class="ts done" style="--i:1"><span class="ts-dot">${icon('check', 14)}</span><b>Ditimbang, ${num(sample)} kg</b><time>08.55</time></li>
              <li class="ts done" style="--i:2"><span class="ts-dot">${icon('check', 14)}</span><b>Dicuci</b><time>09.30</time></li>
              <li class="ts now" style="--i:3"><span class="ts-dot">${icon('drop', 14)}</span><b>Dikeringkan</b><time>sekarang</time></li>
              <li class="ts todo"><span class="ts-dot"></span><b>Dilipat</b><time></time></li>
              <li class="ts todo"><span class="ts-dot"></span><b>Diantar kurir</b><time></time></li>
            </ol>
            <footer class="ticket-foot"><span>Tagihan final</span><b>${rupiah(sample * wf.pricePerKg)}</b></footer>
            <small class="ticket-note">Contoh tampilan tracking</small>
          </article>
        </div>
      </section>

      <section class="section" id="layanan">
        <div class="section-head">
          <h2>Tarif per kilo yang jelas dari awal</h2>
          <p>Berat dihitung dari timbangan di outlet. Kamu melihat rinciannya sebelum membayar.</p>
        </div>
        <ul class="board">
          ${cfg.services.map((s) => html`
            <li>
              <a class="board-row" href="#/app/pesan?layanan=${s.id}">
                <span class="board-ic">${serviceIcon(s.id)}</span>
                <span class="board-name"><b>${s.name}</b><small>${s.desc}</small></span>
                <span class="board-eta">${icon('clock', 16)}${s.eta}</span>
                <span class="board-dots" aria-hidden="true"></span>
                <span class="board-price"><b>${rupiah(s.pricePerKg)}</b><small>/kg</small></span>
              </a>
            </li>`)}
          <li>
            <a class="board-row board-delivery" href="#/" data-scroll="antar-jemput">
              <span class="board-ic">${icon('truck', 22)}</span>
              <span class="board-name"><b>Pick-Up & Delivery</b><small>Pakaian dijemput dan diantar kurir ke lokasimu.</small></span>
              <span class="board-eta">${icon('pin', 16)}radius ${freeKm} km</span>
              <span class="board-dots" aria-hidden="true"></span>
              <span class="board-price"><b>Gratis</b><small>≤ ${freeKm} km</small></span>
            </a>
          </li>
        </ul>
      </section>

      <section class="section section-tint" id="antar-jemput">
        <div class="split-2">
          <div class="section-head left">
            <h2>Antar-jemput gratis sampai ${freeKm}&nbsp;km</h2>
            <p>Tandai lokasimu di peta saat memesan. Jarak dari outlet dihitung otomatis, lalu ongkirnya muncul di rincian tagihan. Lebih dari ${freeKm} km, tambahan ${rupiah(perKm)} untuk setiap kilometer.</p>
            <div data-courier>${courierInfo(cfg.delivery)}</div>
          </div>
          <div class="ruler" data-free="${freeKm}" data-perkm="${perKm}">
            <p class="ruler-read" aria-live="polite"></p>
            <div class="ruler-track" style="--free:${freeKm}">
              <div class="ruler-free"><span>Gratis</span></div>
              <div class="ruler-paid"><span>${rupiah(perKm)}/km</span></div>
              <div class="ruler-ticks" aria-hidden="true">${Array.from({ length: 13 }, (_, i) => html`<i style="--i:${i}"><b>${i}</b></i>`)}</div>
              <input type="range" min="0" max="12" step="0.1" value="5.5" aria-label="Jarak rumahmu dari outlet, dalam kilometer">
            </div>
            <p class="hint">Geser untuk mencoba jarak. ${cfg.delivery.chargePerLeg ? 'Ongkir dihitung per arah (jemput dan antar), dan' : 'Kelebihan jarak'} ${cfg.delivery.chargePerLeg ? 'kelebihan jarak' : ''} dibulatkan ke atas per km.</p>
          </div>
        </div>
      </section>

      <section class="section stamp-sec" id="stamp">
        <div class="split-2">
          <div class="stampcard stampcard-demo" aria-label="Contoh kartu stamp">
            <div class="stampcard-head"><strong>Kartu stamp ZibbWash</strong><span>${demoStamps}/${stampsForReward}</span></div>
            <div class="stamps">
              ${Array.from({ length: stampsForReward }, (_, i) => html`<span class="stamp ${i < demoStamps ? 'on' : ''} ${i === stampsForReward - 1 ? 'gift' : ''}">${i < demoStamps ? icon('drop', 22) : i === stampsForReward - 1 ? icon('gift', 22) : ''}</span>`)}
            </div>
            <p class="stampcard-foot">${stampsForReward - demoStamps} stamp lagi untuk cuci gratis</p>
          </div>
          <div class="section-head left on-dark">
            <h2>Kumpulkan ${stampsForReward} stamp, cuci Wash & Fold gratis</h2>
            <p>Setiap transaksi minimal ${rupiah(minTransaction)} mendapat 1 stamp. Stamp ke-${stampsForReward} otomatis menjadi voucher gratis Wash & Fold sampai ${rewardMaxKg} kg.</p>
            <ul class="checks">
              <li>${icon('check', 18)}<span>Stamp masuk setelah pesanan selesai dan lunas</span></li>
              <li>${icon('check', 18)}<span>Kartu digital, tidak perlu dibawa ke mana-mana</span></li>
              <li>${icon('check', 18)}<span>Voucher tinggal dicentang saat memesan</span></li>
            </ul>
            <a class="btn btn-light btn-lg" href="#${u ? '/app/pesan' : '/masuk'}">${u ? 'Pesan dan dapat stamp' : 'Daftar dan mulai mengumpulkan'}</a>
          </div>
        </div>
      </section>

      <section class="section contact" id="kontak">
        <div class="contact-card">
          <div>
            <h2>Ada yang mau ditanyakan dulu?</h2>
            <p>Hubungi ${cfg.business.name} di <b>${phonePretty(cfg.business.phone)}</b>. Kami balas lewat WhatsApp.</p>
            ${socials('socials-contact')}
          </div>
          <div class="cta-row">
            <a class="btn btn-wa btn-lg" href="${wa}" target="_blank" rel="noopener">${icon('whatsapp', 20)}Chat WhatsApp</a>
            <a class="btn btn-ghost btn-lg" href="tel:${cfg.business.phone}">${icon('phone', 20)}Telepon</a>
          </div>
        </div>
      </section>
    </main>

    <footer class="pubfoot">
      <div class="brand brand-sm"><img src="/img/logo-mark.png" alt="" width="26" height="29"><span>${cfg.business.name}</span></div>
      <p>${cfg.business.address}<br>Jam operasional ${courierHours(cfg.delivery)}</p>
      ${socials('socials-foot')}
      <a href="#/masuk?role=admin">Masuk sebagai admin</a>
    </footer>
  </div>`);

  // Scroll halus untuk tautan bagian halaman (hash dipakai router, jadi tidak memakai #id).
  $$('[data-scroll]', container).forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const target = document.getElementById(a.dataset.scroll);
    if (target) target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }));

  // Lencana buka/tutup diperbarui tanpa muat ulang halaman.
  const courierTimer = setInterval(() => mount($('[data-courier]', container), courierInfo(cfg.delivery)), 30000);
  onCleanup(() => clearInterval(courierTimer));

  // Penggaris ongkir interaktif.
  const ruler = $('.ruler', container);
  const range = $('input[type=range]', ruler);
  const read = $('.ruler-read', ruler);
  const max = Number(range.max);
  const track = $('.ruler-track', ruler);
  function update() {
    const km = Number(range.value);
    const extra = Math.max(0, Math.ceil(km - freeKm - 1e-9));
    const one = extra * perKm;
    track.style.setProperty('--pos', String(km / max));
    read.innerHTML = String(html`
      <span class="ruler-km">${num(km)} km</span>
      ${extra === 0
        ? html`<span><b>Gratis ongkir</b> untuk jemput maupun antar</span>`
        : cfg.delivery.chargePerLeg
          ? html`<span>Ongkir <b>${rupiah(one)}</b> per arah, <b>${rupiah(one * 2)}</b> bila jemput dan antar</span>`
          : html`<span>Ongkir <b>${rupiah(one)}</b> untuk antar-jemput</span>`}`);
  }
  range.addEventListener('input', update);
  update();
}
