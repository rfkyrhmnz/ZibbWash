// Pemilih lokasi di peta + hitung jarak dari outlet.
// - Bila "Google Maps API Key" diisi (Admin > Tarif & pengaturan atau env GOOGLE_MAPS_API_KEY): pakai Google Maps
//   (Maps JavaScript API + Directions + Geocoding).
// - Bila kosong atau gagal dimuat: otomatis pakai OpenStreetMap (Leaflet + OSRM + Nominatim) agar tetap berfungsi.
// Jarak yang dikirim ke server adalah jarak rute jalan bila tersedia, kalau tidak, garis lurus × 1,3.

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Gagal memuat ${src}`));
    document.head.appendChild(s);
  });
}
function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}

let googlePromise = null;
function loadGoogle(key) {
  if (window.google && window.google.maps) return Promise.resolve();
  if (googlePromise) return googlePromise;
  googlePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Google Maps terlalu lama dimuat')), 12000);
    window.__zwGmapsReady = () => { clearTimeout(timer); resolve(); };
    window.gm_authFailure = () => { clearTimeout(timer); reject(new Error('Kunci Google Maps ditolak')); };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__zwGmapsReady&language=id&region=ID`;
    s.async = true;
    s.onerror = () => { clearTimeout(timer); reject(new Error('Gagal memuat Google Maps')); };
    document.head.appendChild(s);
  }).catch((e) => { googlePromise = null; throw e; });
  return googlePromise;
}

let leafletPromise = null;
function loadLeaflet() {
  if (window.L && window.L.map) return Promise.resolve();
  if (!leafletPromise) {
    loadCss(LEAFLET_CSS);
    leafletPromise = loadScript(LEAFLET_JS).catch((e) => { leafletPromise = null; throw e; });
  }
  return leafletPromise;
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/**
 * @param {HTMLElement} container elemen kosong tempat peta digambar
 * @param {{business:{lat:number,lng:number,name:string}, mapsKey:string, delivery:{freeKm:number}}} cfg
 * @param {{onPick:(p:{lat:number,lng:number,distanceKm:number,method:'route'|'straight'})=>void, onAddress?:(text:string)=>void, onNotice?:(msg:string)=>void, start?:{lat:number,lng:number}}} cb
 */
export async function createMapPicker(container, cfg, cb) {
  const outlet = { lat: cfg.business.lat, lng: cfg.business.lng };
  let provider = 'osm';
  let impl;

  if (cfg.mapsKey) {
    try { await loadGoogle(cfg.mapsKey); provider = 'google'; } catch (e) {
      cb.onNotice && cb.onNotice(`${e.message}. Memakai OpenStreetMap sebagai cadangan.`);
    }
  }
  if (provider === 'google') impl = googleImpl(container, cfg, outlet, cb);
  else {
    try { await loadLeaflet(); } catch {
      container.innerHTML = '<div class="map-fail">Peta tidak bisa dimuat. Periksa koneksi internet, lalu muat ulang halaman.</div>';
      return { provider: 'none', setPoint() {}, search: async () => false, locate: async () => false, destroy() {} };
    }
    impl = osmImpl(container, cfg, outlet, cb);
  }
  if (cb.start) impl.setPoint(cb.start.lat, cb.start.lng, { silentAddress: true });
  return { provider, ...impl };
}

// ───────────────────────── Google Maps ─────────────────────────
function googleImpl(container, cfg, outlet, cb) {
  const g = window.google.maps;
  const map = new g.Map(container, {
    center: outlet, zoom: 14, mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false,
  });
  new g.Marker({ position: outlet, map, title: cfg.business.name, label: { text: 'Z', color: '#fff', fontWeight: '700' } });
  new g.Circle({
    map, center: outlet, radius: cfg.delivery.freeKm * 1000,
    strokeColor: '#0B9CBF', strokeOpacity: 0.8, strokeWeight: 2, fillColor: '#0DADD2', fillOpacity: 0.12, clickable: false,
  });
  const geocoder = new g.Geocoder();
  const directions = new g.DirectionsService();
  let marker = null;

  async function measure(lat, lng) {
    const straight = haversineKm(outlet.lat, outlet.lng, lat, lng);
    return new Promise((resolve) => {
      directions.route({ origin: outlet, destination: { lat, lng }, travelMode: g.TravelMode.DRIVING }, (res, status) => {
        if (status === 'OK' && res.routes[0]) resolve({ km: res.routes[0].legs[0].distance.value / 1000, method: 'route' });
        else resolve({ km: straight * 1.3, method: 'straight' });
      });
    });
  }

  async function setPoint(lat, lng, opts = {}) {
    if (!marker) {
      marker = new g.Marker({ position: { lat, lng }, map, draggable: true, animation: g.Animation.DROP });
      marker.addListener('dragend', (e) => setPoint(e.latLng.lat(), e.latLng.lng()));
    } else marker.setPosition({ lat, lng });
    map.panTo({ lat, lng });
    const { km, method } = await measure(lat, lng);
    cb.onPick({ lat, lng, distanceKm: Math.round(km * 10) / 10, method });
    if (!opts.silentAddress && cb.onAddress) {
      geocoder.geocode({ location: { lat, lng } }, (r, s) => { if (s === 'OK' && r[0]) cb.onAddress(r[0].formatted_address); });
    }
  }

  map.addListener('click', (e) => setPoint(e.latLng.lat(), e.latLng.lng()));

  return {
    setPoint,
    search(q) {
      return new Promise((resolve) => {
        geocoder.geocode({ address: q, region: 'ID', bounds: new g.LatLngBounds({ lat: outlet.lat - 0.3, lng: outlet.lng - 0.3 }, { lat: outlet.lat + 0.3, lng: outlet.lng + 0.3 }) }, (r, s) => {
          if (s === 'OK' && r[0]) {
            const p = r[0].geometry.location;
            map.setZoom(16);
            setPoint(p.lat(), p.lng(), { silentAddress: true });
            cb.onAddress && cb.onAddress(r[0].formatted_address);
            resolve(true);
          } else resolve(false);
        });
      });
    },
    locate: () => geolocate(setPoint),
    destroy() { container.innerHTML = ''; },
  };
}

// ───────────────────────── OpenStreetMap (cadangan) ─────────────────────────
function osmImpl(container, cfg, outlet, cb) {
  const L = window.L;
  const map = L.map(container, { zoomControl: true, attributionControl: true }).setView([outlet.lat, outlet.lng], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const outletIcon = L.divIcon({ className: 'zw-pin zw-pin-outlet', html: '<span>Z</span>', iconSize: [34, 34], iconAnchor: [17, 17] });
  const custIcon = L.divIcon({ className: 'zw-pin zw-pin-cust', html: '<span></span>', iconSize: [30, 38], iconAnchor: [15, 36] });
  L.marker([outlet.lat, outlet.lng], { icon: outletIcon, title: cfg.business.name, keyboard: false }).addTo(map);
  L.circle([outlet.lat, outlet.lng], { radius: cfg.delivery.freeKm * 1000, color: '#0B9CBF', weight: 2, fillColor: '#0DADD2', fillOpacity: 0.12, interactive: false }).addTo(map);
  let marker = null;
  let seq = 0;

  async function measure(lat, lng) {
    const straight = haversineKm(outlet.lat, outlet.lng, lat, lng);
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${outlet.lng},${outlet.lat};${lng},${lat}?overview=false`, { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      if (j.code === 'Ok' && j.routes[0]) return { km: j.routes[0].distance / 1000, method: 'route' };
    } catch { /* jatuh ke garis lurus */ }
    return { km: straight * 1.3, method: 'straight' };
  }

  async function reverse(lat, lng) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=id`);
      const j = await r.json();
      return j.display_name || '';
    } catch { return ''; }
  }

  async function setPoint(lat, lng, opts = {}) {
    const my = ++seq;
    if (!marker) {
      marker = L.marker([lat, lng], { icon: custIcon, draggable: true }).addTo(map);
      marker.on('dragend', () => { const p = marker.getLatLng(); setPoint(p.lat, p.lng); });
    } else marker.setLatLng([lat, lng]);
    map.panTo([lat, lng]);
    const { km, method } = await measure(lat, lng);
    if (my !== seq) return;
    cb.onPick({ lat, lng, distanceKm: Math.round(km * 10) / 10, method });
    if (!opts.silentAddress && cb.onAddress) {
      const text = await reverse(lat, lng);
      if (my === seq && text) cb.onAddress(text);
    }
  }

  map.on('click', (e) => setPoint(e.latlng.lat, e.latlng.lng));
  setTimeout(() => map.invalidateSize(), 200);

  return {
    setPoint,
    async search(q) {
      try {
        const vb = `${outlet.lng - 0.3},${outlet.lat + 0.3},${outlet.lng + 0.3},${outlet.lat - 0.3}`;
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=id&viewbox=${vb}&q=${encodeURIComponent(q)}&accept-language=id`);
        const j = await r.json();
        if (!j[0]) return false;
        map.setZoom(16);
        await setPoint(Number(j[0].lat), Number(j[0].lon), { silentAddress: true });
        cb.onAddress && cb.onAddress(j[0].display_name);
        return true;
      } catch { return false; }
    },
    locate: () => geolocate(setPoint),
    destroy() { map.remove(); },
  };
}

function geolocate(setPoint) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setPoint(pos.coords.latitude, pos.coords.longitude); resolve(true); },
      () => resolve(false),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}
