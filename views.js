// Backcountry Nav — Globe (3D) and Polar (azimuthal equidistant) views.
// Libraries load only when a view is first opened, so the map starts fast.
(function () {
  "use strict";
  const B = window.BCN; if (!B) return;
  const $ = id => document.getElementById(id);
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const QUAKES = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson';
  const FIRES = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=poly_IncidentName,attr_IncidentSize,attr_PercentContained&geometryPrecision=4&f=geojson';

  const loaded = {};
  function loadScript(src) { return loaded[src] || (loaded[src] = new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => { delete loaded[src]; bad(new Error(src)); }; document.head.appendChild(s); })); }
  function loadCss(href) { if (document.querySelector(`link[href="${href}"]`)) return; const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }

  // ---------- view switching ----------
  let view = 'map';
  document.querySelectorAll('.views [data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  function setView(v) {
    view = v;
    document.querySelectorAll('.views [data-view]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    document.body.classList.toggle('alt', v !== 'map');
    document.querySelectorAll('.sheet').forEach(s => s.hidden = true);
    $('globePane').hidden = v !== 'globe';
    $('polarPane').hidden = v !== 'polar';
    if (v === 'globe') openGlobe();
    else stopSpin();
    if (v === 'polar') openPolar();
    if (v === 'map') { B.map.invalidateSize(); if (globe) { const c = globe.getCenter(); if (globe.getZoom() > 3) B.map.setView([c.lat, c.lng], Math.round(globe.getZoom() + 1)); } }
  }

  // ---------- GLOBE ----------
  let globe = null, spinning = false, spinRaf = 0, meMarker = null;
  function rasterSource() {
    const bl = B.getBase(), def = B.getBaseDef();
    let url = bl && bl._url, max = (bl && bl.options.maxNativeZoom) || 16, attr = (bl && bl.options.attribution) || '';
    if (!url || /export\?/.test(url)) { url = ESRI; max = 19; attr = 'Esri, Maxar, Earthstar Geographics'; }
    if (url.includes('{s}')) url = url.replace('{s}', 'a');
    return { type: 'raster', tiles: [url], tileSize: 256, maxzoom: max, attribution: attr, _name: def && def.name };
  }
  async function openGlobe() {
    if (globe) { globe.resize(); syncBase(); placeMe(); return; }
    loadCss('https://unpkg.com/maplibre-gl@5.0.0/dist/maplibre-gl.css');
    try { await loadScript('https://unpkg.com/maplibre-gl@5.0.0/dist/maplibre-gl.js'); }
    catch (e) { B.toast('Globe view needs a connection to load', 4000); return; }
    const c = B.map.getCenter();
    globe = new maplibregl.Map({
      container: 'globe',
      style: { version: 8, sources: { base: rasterSource() }, layers: [
        { id: 'space', type: 'background', paint: { 'background-color': '#04060a' } },
        { id: 'base', type: 'raster', source: 'base' }] },
      center: [c.lng, c.lat], zoom: 1.6, attributionControl: { compact: true }, maxPitch: 70
    });
    globe.on('style.load', () => {
      try { globe.setProjection({ type: 'globe' }); } catch (e) {}
      addGlobeData();
      placeMe();
      globe.easeTo({ zoom: Math.min(Math.max(B.map.getZoom() - 1, 1.6), 4), duration: 1800 });
    });
    globe.on('mousedown', stopSpin); globe.on('touchstart', stopSpin);
    // popups for hazards
    const pop = (e, html) => new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(html).addTo(globe);
    globe.on('click', 'quakes', e => { const p = e.features[0].properties; pop(e, `<div class="ldpop"><b>M${(+p.mag).toFixed(1)} earthquake</b><div class="c">${B.esc(p.place || '')}</div><div class="c">${new Date(+p.time).toLocaleString()}</div>${+p.tsunami ? '<div class="c"><b>Tsunami alert issued</b></div>' : ''}</div>`); });
    globe.on('click', 'fires', e => { const p = e.features[0].properties; pop(e, `<div class="ldpop"><b>${B.esc(p.poly_IncidentName || 'Wildfire')}</b><div class="c">${p.attr_IncidentSize ? Math.round(p.attr_IncidentSize).toLocaleString() + ' acres' : ''}${p.attr_PercentContained != null && p.attr_PercentContained !== 'null' ? ' · ' + p.attr_PercentContained + '% contained' : ''}</div></div>`); });
  }
  function syncBase() {
    if (!globe || !globe.isStyleLoaded()) return;
    const src = rasterSource(), cur = globe.getSource('base');
    if (cur && cur.tiles && cur.tiles[0] === src.tiles[0]) return;
    globe.removeLayer('base'); globe.removeSource('base');
    const { _name, ...clean } = src; globe.addSource('base', clean);
    globe.addLayer({ id: 'base', type: 'raster', source: 'base' }, globe.getLayer('fires') ? 'fires' : (globe.getLayer('quakes') ? 'quakes' : undefined));
  }
  function addGlobeData() {
    globe.addSource('quakes', { type: 'geojson', data: QUAKES });
    globe.addLayer({ id: 'quakes', type: 'circle', source: 'quakes', paint: {
      'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'mag'], 2.5], 2.5, 3, 5, 7, 7, 14],
      'circle-color': ['step', ['-', Date.now(), ['get', 'time']], '#ff2d55', 86400000, '#ff9f0a', 259200000, '#ffd60a'],
      'circle-opacity': 0.85, 'circle-stroke-color': ['case', ['==', ['get', 'tsunami'], 1], '#30d5c8', '#ffffff'],
      'circle-stroke-width': ['case', ['==', ['get', 'tsunami'], 1], 3, 1] } });
    globe.addSource('fires', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    globe.addLayer({ id: 'fires', type: 'fill', source: 'fires', layout: { visibility: 'none' }, paint: { 'fill-color': '#ff3b1f', 'fill-opacity': 0.55, 'fill-outline-color': '#ffffff' } });
    globe.addLayer({ id: 'fires-dot', type: 'circle', source: 'fires', layout: { visibility: 'none' }, maxzoom: 6, paint: { 'circle-radius': 4, 'circle-color': '#ff3b1f', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
  }
  let firesLoaded = false;
  document.querySelectorAll('#globePane [data-g]').forEach(b => b.addEventListener('click', () => {
    if (!globe || !globe.isStyleLoaded()) return;
    const k = b.dataset.g, on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    const vis = on ? 'visible' : 'none';
    if (k === 'quakes') globe.setLayoutProperty('quakes', 'visibility', vis);
    if (k === 'fires') {
      globe.setLayoutProperty('fires', 'visibility', vis); globe.setLayoutProperty('fires-dot', 'visibility', vis);
      if (on && !firesLoaded) {
        fetch(FIRES).then(r => r.json()).then(j => {
          // add a centroid point per perimeter so small fires show from space
          const pts = (j.features || []).map(f => { try { const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0]; let x = 0, y = 0; ring.forEach(p => { x += p[0]; y += p[1]; }); return { type: 'Feature', properties: f.properties, geometry: { type: 'Point', coordinates: [x / ring.length, y / ring.length] } }; } catch (e) { return null; } }).filter(Boolean);
          globe.getSource('fires').setData({ type: 'FeatureCollection', features: (j.features || []).concat(pts) });
          firesLoaded = true; B.toast((j.features || []).length + ' active wildfires');
        }).catch(() => B.toast('Wildfire data unavailable right now'));
      }
    }
  }));
  function placeMe() {
    const f = B.getFix(); if (!globe || !f) return;
    if (!meMarker) { const el = document.createElement('div'); el.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#7cc4e8;border:3px solid #fff;box-shadow:0 0 0 6px rgba(124,196,232,.3)'; meMarker = new maplibregl.Marker({ element: el }); }
    meMarker.setLngLat([f.ll[1], f.ll[0]]).addTo(globe);
  }
  $('gMe').addEventListener('click', () => { const f = B.getFix(); if (!f) { B.toast('No GPS fix yet'); return; } stopSpin(); placeMe(); globe && globe.flyTo({ center: [f.ll[1], f.ll[0]], zoom: 9, duration: 3500 }); });
  $('gSpin').addEventListener('click', () => spinning ? stopSpin() : startSpin());
  function startSpin() {
    if (!globe) return; spinning = true; $('gSpin').classList.add('on');
    if (globe.getZoom() > 3) globe.easeTo({ zoom: 1.6, duration: 1200 });
    let last = performance.now();
    const step = t => { if (!spinning) return; const c = globe.getCenter(); c.lng -= (t - last) * 0.006; last = t; globe.setCenter(c); spinRaf = requestAnimationFrame(step); };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { B.toast('Spin is off while reduced motion is on'); spinning = false; $('gSpin').classList.remove('on'); return; }
    spinRaf = requestAnimationFrame(step);
  }
  function stopSpin() { spinning = false; cancelAnimationFrame(spinRaf); const b = $('gSpin'); b && b.classList.remove('on'); }

  // ---------- POLAR (azimuthal equidistant) ----------
  let pReady = false, land = null, borders = null, quakes = [], center = 'pole', pScale = 1, ctx, cv, proj, path;
  const R_KM = 6371.0088;
  const PINFO = 'Polar view: the round Earth unrolled around one point, the way flat-earth maps are drawn. Distances and directions from the center are true; land stretches toward the edge. Tap anywhere to measure.';
  async function openPolar() {
    if (!pReady) {
      try {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js');
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js');
        const w = await (await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json')).json();
        land = topojson.feature(w, w.objects.land);
        borders = topojson.mesh(w, w.objects.countries, (a, b) => a !== b);
      } catch (e) { B.toast('Polar view needs a connection to load', 4000); return; }
      fetch(QUAKES).then(r => r.json()).then(j => { quakes = j.features; drawPolar(); }).catch(() => {});
      cv = $('polar'); ctx = cv.getContext('2d'); pReady = true;
      window.addEventListener('resize', () => view === 'polar' && drawPolar());
      cv.addEventListener('click', polarTap);
      let pinch = 0; cv.addEventListener('touchmove', e => { if (e.touches.length === 2) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (pinch) { pScale = Math.min(8, Math.max(1, pScale * d / pinch)); drawPolar(); } pinch = d; } }, { passive: true });
      cv.addEventListener('touchend', () => pinch = 0);
      cv.addEventListener('wheel', e => { e.preventDefault(); pScale = Math.min(8, Math.max(1, pScale * (e.deltaY < 0 ? 1.15 : 0.87))); drawPolar(); }, { passive: false });
    }
    drawPolar();
  }
  function centerLL() {
    if (center === 'me') { const f = B.getFix(); if (f) return [f.ll[1], f.ll[0]]; }
    if (center === 'map') { const c = B.map.getCenter(); return [c.lng, c.lat]; }
    return [0, 90];
  }
  function drawPolar(mark) {
    if (!pReady) return;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [lon0, lat0] = centerLL();
    const top = 150, bot = 160, r = Math.max(60, Math.min(W - 16, H - top - bot) / 2);
    proj = d3.geoAzimuthalEquidistant().rotate([-lon0, -lat0]).clipAngle(180 - 1e-3).precision(0.2)
      .scale(r / Math.PI * pScale).translate([W / 2, top + (H - top - bot) / 2]);
    path = d3.geoPath(proj, ctx);
    ctx.fillStyle = '#04060a'; ctx.fillRect(0, 0, W, H);
    ctx.beginPath(); path({ type: 'Sphere' }); ctx.fillStyle = '#0d2233'; ctx.fill();
    ctx.beginPath(); path(d3.geoGraticule10()); ctx.strokeStyle = 'rgba(160,200,230,.18)'; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.beginPath(); path(land); ctx.fillStyle = '#5b6b47'; ctx.fill();
    ctx.beginPath(); path(borders); ctx.strokeStyle = 'rgba(233,230,214,.35)'; ctx.lineWidth = 0.5; ctx.stroke();
    // equator, true-distance rings from the center (km or mi per unit setting)
    ctx.beginPath(); path({ type: 'LineString', coordinates: d3.range(-180, 181, 2).map(x => [x, 0]) }); ctx.strokeStyle = 'rgba(255,214,10,.5)'; ctx.lineWidth = 1; ctx.stroke();
    const u = B.units(), imperial = u.du !== 'km', step = imperial ? 2000 / 0.621371 : 2500;
    ctx.font = '600 11px "IBM Plex Mono", monospace'; ctx.textAlign = 'left';
    for (let d = step, i = 1; d < Math.PI * R_KM; d += step, i++) {
      const ring = d3.geoCircle().center([lon0, lat0]).radius(d / R_KM * 180 / Math.PI)();
      ctx.beginPath(); path(ring); ctx.setLineDash([4, 5]); ctx.strokeStyle = 'rgba(255,106,19,.55)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      const pt = proj(dest(lon0, lat0, 135, d));
      if (pt) { ctx.fillStyle = '#ff6a13'; ctx.fillText((imperial ? (i * 2000).toLocaleString() + ' mi' : (i * 2500).toLocaleString() + ' km'), pt[0] + 3, pt[1]); }
    }
    ctx.beginPath(); path({ type: 'Sphere' }); ctx.strokeStyle = '#e9e6d6'; ctx.lineWidth = 1.5; ctx.stroke();
    // earthquakes
    quakes.forEach(f => { const p = proj(f.geometry.coordinates); if (!p) return; const m = f.properties.mag || 2.5; ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(1.5, m * 1.2), 0, 7); ctx.fillStyle = 'rgba(255,45,85,.75)'; ctx.fill(); });
    // you
    const f = B.getFix();
    if (f) { const p = proj([f.ll[1], f.ll[0]]); if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, 7); ctx.fillStyle = '#7cc4e8'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); } }
    // center mark
    const c = proj([lon0, lat0]); ctx.strokeStyle = '#e9e6d6'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(c[0] - 8, c[1]); ctx.lineTo(c[0] + 8, c[1]); ctx.moveTo(c[0], c[1] - 8); ctx.lineTo(c[0], c[1] + 8); ctx.stroke();
    if (mark) { const p = proj(mark); if (p) { ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(p[0], p[1]); ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2; ctx.stroke(); ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, 7); ctx.fillStyle = '#ffd60a'; ctx.fill(); } }
  }
  // point at a given distance (km) and bearing from lon/lat
  function dest(lon, lat, brg, km) {
    const r = Math.PI / 180, d = km / R_KM, f1 = lat * r, l1 = lon * r, b = brg * r;
    const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
    return [((l2 / r + 540) % 360) - 180, f2 / r];
  }
  function polarTap(e) {
    const rect = cv.getBoundingClientRect(), ll = proj.invert([e.clientX - rect.left, e.clientY - rect.top]);
    if (!ll || isNaN(ll[0])) return;
    const [lon0, lat0] = centerLL(), u = B.units();
    const m = B.hav([lat0, lon0], [ll[1], ll[0]]), brg = B.bearing([lat0, lon0], [ll[1], ll[0]]);
    const where = center === 'pole' ? 'the North Pole' : center === 'me' && B.getFix() ? 'you' : 'map center';
    $('pInfo').textContent = `${ll[1].toFixed(2)}°, ${ll[0].toFixed(2)}° · ${Math.round(m * u.dist).toLocaleString()} ${u.du} from ${where}` + (center === 'pole' ? '' : ` at ${String(Math.round(brg)).padStart(3, '0')}° ${B.card(brg)}`);
    drawPolar(ll);
  }
  document.querySelectorAll('#polarPane [data-c]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.c === 'me' && !B.getFix()) { B.toast('No GPS fix yet'); return; }
    center = b.dataset.c; pScale = 1;
    document.querySelectorAll('#polarPane [data-c]').forEach(x => x.classList.toggle('on', x === b));
    $('pInfo').textContent = PINFO; drawPolar();
  }));
  $('pZin').addEventListener('click', () => { pScale = Math.min(8, pScale * 1.4); drawPolar(); });
  $('pZout').addEventListener('click', () => { pScale = Math.max(1, pScale / 1.4); drawPolar(); });
})();
