// Backcountry Nav — Globe (3D) and Polar (azimuthal equidistant) views.
// Libraries load only when a view is first opened, so the map starts fast.
(function () {
  "use strict";
  const B = window.BCN; if (!B) return;
  const $ = id => document.getElementById(id);
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const QUAKES = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson';
  const FIRES = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=poly_IncidentName,attr_IncidentSize,attr_PercentContained&geometryPrecision=4&f=geojson';
  const WARN = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';
  const NHC = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
  const warnColor = e => /Tsunami/i.test(e) ? '#30d5c8' : /Hurricane|Tropical|Storm Surge/i.test(e) ? '#bf5af2' : /Tornado/i.test(e) ? '#ff2d55' : /Flood/i.test(e) ? '#32d74b' : /Fire|Red Flag/i.test(e) ? '#ff9f0a' : /Winter|Blizzard|Ice|Freez|Frost/i.test(e) ? '#64d2ff' : /Thunderstorm/i.test(e) ? '#ffd60a' : '#c7c7cc';

  const loaded = {};
  function loadScript(src) { return loaded[src] || (loaded[src] = new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => { delete loaded[src]; bad(new Error(src)); }; document.head.appendChild(s); })); }
  function loadCss(href) { if (document.querySelector(`link[href="${href}"]`)) return; const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }
  // shared data cache (5 min)
  const cache = {};
  function getData(url) { const c = cache[url]; if (c && Date.now() - c.t < 300000) return c.p; const p = fetch(url).then(r => { if (!r.ok) throw r.status; return r.json(); }); cache[url] = { t: Date.now(), p }; p.catch(() => delete cache[url]); return p; }
  function centroids(fc) { return (fc.features || []).map(f => { try { const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0]; let x = 0, y = 0; ring.forEach(p => { x += p[0]; y += p[1]; }); return { type: 'Feature', properties: f.properties, geometry: { type: 'Point', coordinates: [x / ring.length, y / ring.length] } }; } catch (e) { return null; } }).filter(Boolean); }

  // ---------- view switching ----------
  let view = 'map';
  document.querySelectorAll('.views [data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  function setView(v) {
    view = v; document.body.dataset.view = v;
    document.querySelectorAll('.views [data-view]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    document.body.classList.toggle('alt', v !== 'map');
    document.querySelectorAll('.sheet').forEach(s => s.hidden = true);
    $('globePane').hidden = v !== 'globe';
    $('polarPane').hidden = v !== 'polar';
    if (v === 'globe') openGlobe(); else stopSpin();
    if (v === 'polar') openPolar();
    if (v === 'map') { B.map.invalidateSize(); if (globe) { const c = globe.getCenter(); if (globe.getZoom() > 3) B.map.setView([c.lat, c.lng], Math.round(globe.getZoom() + 1)); } }
  }
  document.addEventListener('bcn:layers', () => { if (globe) syncGlobe(); });
  // search results: follow along in Globe and Polar
  window.BCN_onGoto = (ll, z) => {
    if (view === 'globe' && globe) { stopSpin(); globe.flyTo({ center: [ll[1], ll[0]], zoom: Math.min(z, 12), duration: 3000 }); }
    if (view === 'polar' && pReady) { center = 'map'; pScale = 1; ox = oy = 0; document.querySelectorAll('#polarPane [data-c]').forEach(x => x.classList.toggle('on', x.dataset.c === 'map')); drawPolar(); }
  };

  // ================= GLOBE =================
  let globe = null, spinning = false, spinRaf = 0, meMarker = null;
  // Turn a Leaflet tile layer into a MapLibre raster source
  function rasterFrom(layer) {
    if (!layer) return null;
    let url = layer._url; if (!url) return null;
    const o = layer.options || {};
    if (B.isExport(layer)) url = url + '/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&dpi=96&format=png32&transparent=true' + (o.layers ? '&layers=' + o.layers : '') + '&f=image';
    else if (url.includes('{s}')) url = url.replace('{s}', (o.subdomains || 'a')[0]);
    return { src: { type: 'raster', tiles: [url], tileSize: 256, maxzoom: Math.min(o.maxNativeZoom || 19, 19), attribution: o.attribution || '' }, minzoom: B.isExport(layer) && o.minZoom ? o.minZoom - 1 : 0 };
  }
  async function openGlobe() {
    if (globe) { globe.resize(); syncGlobe(); placeMe(); return; }
    loadCss('https://unpkg.com/maplibre-gl@5.0.0/dist/maplibre-gl.css');
    try { await loadScript('https://unpkg.com/maplibre-gl@5.0.0/dist/maplibre-gl.js'); }
    catch (e) { B.toast('Globe view needs a connection to load', 4000); return; }
    const c = B.map.getCenter();
    globe = new maplibregl.Map({
      container: 'globe',
      style: { version: 8, sources: {}, layers: [{ id: 'space', type: 'background', paint: { 'background-color': '#04060a' } }] },
      center: [c.lng, c.lat], zoom: 1.6, attributionControl: { compact: true }, maxPitch: 70
    });
    globe.on('style.load', () => {
      try { globe.setProjection({ type: 'globe' }); } catch (e) {}
      syncGlobe(); placeMe();
      globe.easeTo({ zoom: Math.min(Math.max(B.map.getZoom() - 1, 1.6), 4), duration: 1800 });
    });
    globe.on('mousedown', stopSpin); globe.on('touchstart', stopSpin);
    const pop = (e, html) => new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(html).addTo(globe);
    globe.on('click', 'hz-quakes', e => { const p = e.features[0].properties; pop(e, `<div class="ldpop"><b>M${(+p.mag).toFixed(1)} earthquake</b><div class="c">${B.esc(p.place || '')}</div><div class="c">${new Date(+p.time).toLocaleString()}</div>${+p.tsunami ? '<div class="c"><b>Tsunami alert issued</b></div>' : ''}</div>`); });
    const firePop = e => { const p = e.features[0].properties; pop(e, `<div class="ldpop"><b>${B.esc(p.poly_IncidentName || 'Wildfire')}</b><div class="c">${p.attr_IncidentSize ? Math.round(p.attr_IncidentSize).toLocaleString() + ' acres' : ''}${p.attr_PercentContained != null && p.attr_PercentContained !== 'null' ? ' · ' + p.attr_PercentContained + '% contained' : ''}</div></div>`); };
    globe.on('click', 'hz-fires', firePop); globe.on('click', 'hz-fires-dot', firePop);
    globe.on('click', 'hz-warnings', e => { const p = e.features[0].properties; pop(e, `<div class="ldpop"><b>${B.esc(p.event)}</b><div class="c">${B.esc(p.headline || '')}</div></div>`); });
  }
  // Keep the globe in step with the Map's base + overlays + hazards
  function syncGlobe() {
    if (!globe || !globe.isStyleLoaded()) return;
    const want = [];   // ordered list of raster ids
    const ovs = B.ovLayers();
    const base = rasterFrom(B.getBase()) || rasterFrom({ _url: ESRI, options: { maxNativeZoom: 19, attribution: 'Esri' } });
    want.push(['r-base', base, 1]);
    for (const [k, l] of Object.entries(ovs)) {
      if (B.HZ[k] && k !== 'hurricanes') continue;
      const r = rasterFrom(l); if (!r) continue;
      const op = k === 'radar' ? 0.75 : (B.FULL.includes(k) || k === 'hurricanes') ? 1 : B.ovOpacity();
      want.push(['r-' + k, r, op]);
    }
    const keep = new Set(want.map(w => w[0]));
    globe.getStyle().layers.filter(l => l.id.startsWith('r-') && !keep.has(l.id)).forEach(l => { globe.removeLayer(l.id); globe.removeSource(l.id); });
    const firstVector = globe.getStyle().layers.find(l => l.id.startsWith('hz-'));
    want.forEach(([id, r, op]) => {
      const cur = globe.getSource(id);
      if (cur && cur.tiles && cur.tiles[0] !== r.src.tiles[0]) { globe.removeLayer(id); globe.removeSource(id); }
      if (!globe.getSource(id)) { globe.addSource(id, r.src); globe.addLayer({ id, type: 'raster', source: id, minzoom: r.minzoom, paint: { 'raster-opacity': op } }, firstVector && firstVector.id); }
      else globe.setPaintProperty(id, 'raster-opacity', op);
    });
    // keep raster order = want order (base at bottom)
    for (let i = want.length - 1; i > 0; i--) { try { globe.moveLayer(want[i - 1][0], want[i][0]); } catch (e) {} }
    // vector hazards
    vec('quakes', !!ovs.quakes, () => getData(QUAKES), d => [
      { id: 'hz-quakes', type: 'circle', paint: { 'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'mag'], 2.5], 2.5, 3, 5, 7, 7, 14],
        'circle-color': ['step', ['-', Date.now(), ['get', 'time']], '#ff2d55', 86400000, '#ff9f0a', 259200000, '#ffd60a'],
        'circle-opacity': 0.85, 'circle-stroke-color': ['case', ['==', ['get', 'tsunami'], 1], '#30d5c8', '#ffffff'], 'circle-stroke-width': ['case', ['==', ['get', 'tsunami'], 1], 3, 1] } }]);
    vec('fires', !!ovs.fires, () => getData(FIRES).then(j => ({ type: 'FeatureCollection', features: (j.features || []).concat(centroids(j)) })), d => [
      { id: 'hz-fires', type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ff3b1f', 'fill-opacity': 0.5, 'fill-outline-color': '#ffffff' } },
      { id: 'hz-fires-dot', type: 'circle', maxzoom: 6, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#ff3b1f', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } }]);
    vec('warnings', !!ovs.warnings, () => getData(WARN).then(j => { const f = (j.features || []).filter(x => x.geometry); f.forEach(x => x.properties._c = warnColor(x.properties.event)); return { type: 'FeatureCollection', features: f }; }), d => [
      { id: 'hz-warnings', type: 'fill', paint: { 'fill-color': ['get', '_c'], 'fill-opacity': 0.3, 'fill-outline-color': ['get', '_c'] } }]);
  }
  const vecState = {};
  function vec(key, on, load, layers) {
    const sid = 'hz-src-' + key, ids = layers().map(l => l.id);
    if (!on) { ids.forEach(id => globe.getLayer(id) && globe.removeLayer(id)); if (globe.getSource(sid)) globe.removeSource(sid); vecState[key] = false; return; }
    if (vecState[key]) return; vecState[key] = true;
    load().then(data => {
      if (!vecState[key] || !globe) return;
      if (!globe.getSource(sid)) globe.addSource(sid, { type: 'geojson', data });
      layers().forEach(l => { if (!globe.getLayer(l.id)) globe.addLayer(Object.assign({ source: sid }, l)); });
    }).catch(() => { vecState[key] = false; B.toast('Some hazard data is unavailable right now'); });
  }
  function placeMe() {
    const f = B.getFix(); if (!globe || !f) return;
    if (!meMarker) { const el = document.createElement('div'); el.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#7cc4e8;border:3px solid #fff;box-shadow:0 0 0 6px rgba(124,196,232,.3)'; meMarker = new maplibregl.Marker({ element: el }); }
    meMarker.setLngLat([f.ll[1], f.ll[0]]).addTo(globe);
  }
  $('gLayers').addEventListener('click', () => B.openSheet('sLayers'));
  $('gMe').addEventListener('click', () => { const f = B.getFix(); if (!f) { B.toast('No GPS fix yet'); return; } stopSpin(); placeMe(); globe && globe.flyTo({ center: [f.ll[1], f.ll[0]], zoom: 9, duration: 3500 }); });
  $('gSpin').addEventListener('click', () => spinning ? stopSpin() : startSpin());
  function startSpin() {
    if (!globe) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { B.toast('Spin is off while reduced motion is on'); return; }
    spinning = true; $('gSpin').classList.add('on');
    if (globe.getZoom() > 3) globe.easeTo({ zoom: 1.6, duration: 1200 });
    let last = performance.now();
    const step = t => { if (!spinning) return; const c = globe.getCenter(); c.lng -= (t - last) * 0.006; last = t; globe.setCenter(c); spinRaf = requestAnimationFrame(step); };
    spinRaf = requestAnimationFrame(step);
  }
  function stopSpin() { spinning = false; cancelAnimationFrame(spinRaf); const b = $('gSpin'); b && b.classList.remove('on'); }

  // ================= POLAR (azimuthal equidistant) =================
  const R_KM = 6371.0088;
  const PINFO = 'Polar view: the round Earth unrolled around one point, the way flat-earth maps are drawn. Distances and directions from the center are true; land stretches toward the edge. Tap anywhere to measure.';
  // Base imagery options (whole-world tiles, reprojected pixel by pixel)
  const PBASES = {
    sat: { name: 'Satellite', d: 'Esri world imagery', url: ESRI, z: 3 },
    nasa: { name: 'NASA satellite today', d: 'Yesterday\'s VIIRS pass: clouds, smoke, snow', url: () => 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/' + new Date(Date.now() - 864e5).toISOString().slice(0, 10) + '/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg', z: 3 },
    nightlights: { name: 'Night lights', d: 'NASA Black Marble city lights', url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png', z: 3 },
    relief: { name: 'Shaded relief', d: 'Esri world terrain shading', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}', z: 3 },
    topo: { name: 'Topographic', d: 'Esri world topographic map', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', z: 3 },
    plain: { name: 'Plain land & sea', d: 'Simple drawn map, works offline once loaded', url: null }
  };
  const POV = {
    borders: { name: 'Country borders', d: 'National boundaries' },
    grid: { name: 'Latitude/longitude grid', d: '10° grid with the equator in yellow' },
    rings: { name: 'Distance rings', d: 'True distance from the center' },
    quakes: { name: 'Earthquakes', d: 'USGS M2.5+, past week' },
    fires: { name: 'Wildfires', d: 'Active fires (NIFC)' },
    warnings: { name: 'Warnings', d: 'NWS warning areas incl. tsunami & hurricane' },
    me: { name: 'My location', d: 'Your GPS position' }
  };
  const store = { get(k, d) { try { const v = localStorage.getItem('bcn.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('bcn.' + k, JSON.stringify(v)); } catch (e) {} } };
  let pBase = store.get('pBase', 'sat'); if (!PBASES[pBase]) pBase = 'sat';
  let pOn = store.get('pOv', { borders: true, grid: true, rings: true, quakes: true, fires: false, warnings: false, me: true });
  let pReady = false, land = null, borders = null, center = 'pole', pScale = 1, ox = 0, oy = 0, pT = [0, 0], ctx, cv, proj, path, lastMark = null;
  const pdata = { quakes: null, fires: null, warnings: null };
  const mosaic = {};   // base key -> {canvas, data, size} | 'loading' | 'fail'

  function renderPolarSheet() {
    $('pBase').innerHTML = Object.entries(PBASES).map(([k, b]) => `<button class="opt${k === pBase ? ' on' : ''}" data-pb="${k}"><b>${b.name}</b><small>${b.d}</small></button>`).join('');
    const HZK = ['quakes', 'fires', 'warnings'], opt = k => `<button class="opt${pOn[k] ? ' on' : ''}" data-po="${k}"><b>${POV[k].name}</b><small>${POV[k].d}</small></button>`;
    $('pOv').innerHTML = Object.keys(POV).filter(k => !HZK.includes(k)).map(opt).join('');
    $('pHz').innerHTML = HZK.map(opt).join('');
    const sum = (id, arr) => { const el = $(id); el.textContent = arr.length ? arr.join(', ') : 'None on'; el.classList.toggle('off', !arr.length); };
    $('sumPBase').textContent = PBASES[pBase].name;
    sum('sumPHz', HZK.filter(k => pOn[k]).map(k => POV[k].name));
    sum('sumPOv', Object.keys(POV).filter(k => !HZK.includes(k) && pOn[k]).map(k => POV[k].name));
  }
  $('pBase').addEventListener('click', e => { const b = e.target.closest('[data-pb]'); if (!b) return; pBase = b.dataset.pb; store.set('pBase', pBase); renderPolarSheet(); updateChip(); drawPolar(lastMark); });
  $('pHz').addEventListener('click', e => polarToggle(e));
  $('pOv').addEventListener('click', e => polarToggle(e));
  function polarToggle(e) { const b = e.target.closest('[data-po]'); if (!b) return; const k = b.dataset.po; pOn[k] = !pOn[k]; store.set('pOv', pOn); renderPolarSheet(); updateChip(); loadPolarData(); drawPolar(lastMark); }
  $('pLayers').addEventListener('click', () => { renderPolarSheet(); B.openSheet('sPolar'); });
  function updateChip() { if (view !== 'polar') return; $('baseName').textContent = PBASES[pBase].name; const on = ['quakes', 'fires', 'warnings'].filter(k => pOn[k]).map(k => POV[k].name); $('ovNames').textContent = on.length ? '+ ' + on.join(', ') : ''; }
  document.addEventListener('bcn:layers', () => { if (view === 'polar') updateChip(); });

  // Build a Web-Mercator mosaic of the whole world (zoom z) for reprojection
  function loadMosaic(key) {
    const b = PBASES[key]; if (!b.url || mosaic[key]) return;
    const z = b.z, n = 1 << z, size = 256 * n, url = typeof b.url === 'function' ? b.url() : b.url;
    const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
    mosaic[key] = 'loading'; let left = n * n, failed = 0;
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => { g.drawImage(img, x * 256, y * 256); done(); };
      img.onerror = () => { failed++; done(); };
      img.src = url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    }
    function done() {
      if (--left) return;
      try { mosaic[key] = { data: g.getImageData(0, 0, size, size).data, size }; }
      catch (e) { mosaic[key] = 'fail'; B.toast('That imagery can\'t be redrawn in Polar view. Showing the plain map.', 4000); }
      if (failed === n * n) { mosaic[key] = 'fail'; B.toast('Imagery unavailable right now. Showing the plain map.', 4000); }
      if (view === 'polar') drawPolar(lastMark);
    }
  }
  function loadPolarData() {
    if (pOn.quakes && !pdata.quakes) getData(QUAKES).then(j => { pdata.quakes = j.features; drawPolar(lastMark); }).catch(() => {});
    if (pOn.fires && !pdata.fires) getData(FIRES).then(j => { pdata.fires = j; pdata.firePts = centroids(j); drawPolar(lastMark); }).catch(() => B.toast('Wildfire data unavailable right now'));
    if (pOn.warnings && !pdata.warnings) getData(WARN).then(j => { pdata.warnings = (j.features || []).filter(f => f.geometry); drawPolar(lastMark); }).catch(() => B.toast('Warning data unavailable right now'));
  }
  async function openPolar() {
    if (!pReady) {
      try {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js');
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js');
        const w = await (await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json')).json();
        land = topojson.feature(w, w.objects.land);
        borders = topojson.mesh(w, w.objects.countries, (a, b) => a !== b);
      } catch (e) { B.toast('Polar view needs a connection to load', 4000); return; }
      cv = $('polar'); ctx = cv.getContext('2d'); pReady = true;
      window.addEventListener('resize', () => view === 'polar' && drawPolar(lastMark));
      // pan with one finger, pinch with two, double-tap to zoom in, tap to measure
      const pts = new Map(); let moved = 0, start = null, pinch0 = 0, raf = 0, lastTap = 0;
      const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawPolar(lastMark); }); };
      cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); moved = 0; start = [e.clientX, e.clientY]; pinch0 = 0; });
      cv.addEventListener('pointermove', e => {
        if (!pts.has(e.pointerId)) return; const prev = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
        const rect = cv.getBoundingClientRect();
        if (pts.size === 1) { ox += e.clientX - prev[0]; oy += e.clientY - prev[1]; moved += Math.abs(e.clientX - prev[0]) + Math.abs(e.clientY - prev[1]); redraw(); }
        else if (pts.size === 2) { const [p, q] = [...pts.values()], d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (pinch0) zoomAt(d / pinch0, (p[0] + q[0]) / 2 - rect.left, (p[1] + q[1]) / 2 - rect.top); pinch0 = d; moved = 99; }
      });
      const up = e => {
        pts.delete(e.pointerId); pinch0 = 0;
        if (pts.size === 0 && moved < 8 && e.type === 'pointerup') {
          const now = Date.now(), rect = cv.getBoundingClientRect();
          if (now - lastTap < 300) { zoomAt(2, e.clientX - rect.left, e.clientY - rect.top); lastTap = 0; } else { lastTap = now; polarTap(e); }
        }
      };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      cv.addEventListener('wheel', e => { e.preventDefault(); const rect = cv.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - rect.left, e.clientY - rect.top); }, { passive: false });
    }
    updateChip(); loadPolarData(); drawPolar(lastMark);
  }
  // zoom by factor f keeping screen point (px,py) fixed
  function zoomAt(f, px, py) {
    const ns = Math.min(40, Math.max(1, pScale * f)); f = ns / pScale; if (f === 1) return;
    if (px == null) { px = pT[0]; py = pT[1]; }
    ox += (px - pT[0]) * (1 - f); oy += (py - pT[1]) * (1 - f); pScale = ns;
    if (pScale === 1) { ox = 0; oy = 0; }
    drawPolar(lastMark);
  }
  function centerLL() {
    if (center === 'me') { const f = B.getFix(); if (f) return [f.ll[1], f.ll[0]]; }
    if (center === 'map') { const c = B.map.getCenter(); return [c.lng, c.lat]; }
    return [0, 90];
  }
  // Reproject the mosaic into the azimuthal view (rendered at half resolution for speed)
  function paintRaster(W, H, top, bot) {
    const m = mosaic[pBase]; if (!m || typeof m === 'string') return false;
    const k = 2, w = Math.ceil(W / k), h = Math.ceil(H / k);
    const img = ctx.createImageData(w, h), out = img.data, src = m.data, S = m.size;
    const r = Math.PI / 180, MAXLAT = 85.0511;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const ll = proj.invert([i * k + k / 2, j * k + k / 2]); if (!ll) continue;
      const [lon, lat] = ll; if (isNaN(lon)) continue;
      // inside the disc?
      const p = proj(ll); if (!p || Math.abs(p[0] - (i * k + k / 2)) > 2 || Math.abs(p[1] - (j * k + k / 2)) > 2) continue;
      const o = (j * w + i) * 4;
      if (Math.abs(lat) > MAXLAT) { const v = lat > 0 ? 235 : 245; out[o] = v; out[o + 1] = v; out[o + 2] = v + 5; out[o + 3] = 255; continue; }
      const x = Math.floor((lon + 180) / 360 * S), y = Math.floor((1 - Math.log(Math.tan(lat * r) + 1 / Math.cos(lat * r)) / Math.PI) / 2 * S);
      const s = (Math.min(S - 1, Math.max(0, y)) * S + Math.min(S - 1, Math.max(0, x))) * 4;
      out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; out[o + 3] = 255;
    }
    const t = document.createElement('canvas'); t.width = w; t.height = h; t.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.drawImage(t, 0, 0, W, H);
    return true;
  }
  function drawPolar(mark) {
    if (!pReady) return; lastMark = mark || null;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [lon0, lat0] = centerLL();
    const top = 150, bot = 160, rad = Math.max(60, Math.min(W - 16, H - top - bot) / 2);
    proj = d3.geoAzimuthalEquidistant().rotate([-lon0, -lat0]).clipAngle(180 - 1e-3).precision(0.2)
      .scale(rad / Math.PI * pScale).translate(pT = [W / 2 + ox, top + (H - top - bot) / 2 + oy]);
    path = d3.geoPath(proj, ctx);
    ctx.fillStyle = '#04060a'; ctx.fillRect(0, 0, W, H);
    ctx.beginPath(); path({ type: 'Sphere' }); ctx.fillStyle = '#0d2233'; ctx.fill();
    let raster = false;
    if (PBASES[pBase].url) { loadMosaic(pBase); ctx.save(); ctx.beginPath(); path({ type: 'Sphere' }); ctx.clip(); raster = paintRaster(W, H); ctx.restore(); }
    if (!raster) { ctx.beginPath(); path(land); ctx.fillStyle = '#5b6b47'; ctx.fill(); if (PBASES[pBase].url && mosaic[pBase] === 'loading') { ctx.fillStyle = 'rgba(233,230,214,.7)'; ctx.font = '600 12px Barlow, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Loading imagery…', W / 2, top - 8); } }
    if (pOn.grid) {
      ctx.beginPath(); path(d3.geoGraticule10()); ctx.strokeStyle = raster ? 'rgba(255,255,255,.22)' : 'rgba(160,200,230,.18)'; ctx.lineWidth = 0.6; ctx.stroke();
      ctx.beginPath(); path({ type: 'LineString', coordinates: d3.range(-180, 181, 2).map(x => [x, 0]) }); ctx.strokeStyle = 'rgba(255,214,10,.6)'; ctx.lineWidth = 1; ctx.stroke();
    }
    if (pOn.borders) { ctx.beginPath(); path(borders); ctx.strokeStyle = raster ? 'rgba(255,255,255,.45)' : 'rgba(233,230,214,.35)'; ctx.lineWidth = 0.6; ctx.stroke(); }
    if (pOn.warnings && pdata.warnings) pdata.warnings.forEach(f => { ctx.beginPath(); path(f); const c = warnColor(f.properties.event); ctx.fillStyle = c + '55'; ctx.fill(); ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.stroke(); });
    if (pOn.rings) {
      const u = B.units(), imperial = u.du !== 'km', step = imperial ? 2000 / 0.621371 : 2500;
      ctx.font = '600 11px "IBM Plex Mono", monospace'; ctx.textAlign = 'left';
      for (let d = step, i = 1; d < Math.PI * R_KM; d += step, i++) {
        const ring = d3.geoCircle().center([lon0, lat0]).radius(d / R_KM * 180 / Math.PI)();
        ctx.beginPath(); path(ring); ctx.setLineDash([4, 5]); ctx.strokeStyle = 'rgba(255,106,19,.7)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
        const pt = proj(dest(lon0, lat0, 135, d));
        if (pt) { ctx.fillStyle = '#ff6a13'; ctx.fillText(imperial ? (i * 2000).toLocaleString() + ' mi' : (i * 2500).toLocaleString() + ' km', pt[0] + 3, pt[1]); }
      }
    }
    ctx.beginPath(); path({ type: 'Sphere' }); ctx.strokeStyle = '#e9e6d6'; ctx.lineWidth = 1.5; ctx.stroke();
    if (pOn.fires && pdata.fires) {
      ctx.beginPath(); path(pdata.fires); ctx.fillStyle = 'rgba(255,59,31,.6)'; ctx.fill();
      pdata.firePts.forEach(f => { const p = proj(f.geometry.coordinates); if (!p) return; ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, 7); ctx.fillStyle = '#ff3b1f'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.8; ctx.stroke(); });
    }
    if (pOn.quakes && pdata.quakes) pdata.quakes.forEach(f => { const p = proj(f.geometry.coordinates); if (!p) return; const m = f.properties.mag || 2.5; ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(1.5, m * 1.2), 0, 7); ctx.fillStyle = 'rgba(255,45,85,.8)'; ctx.fill(); if (f.properties.tsunami) { ctx.strokeStyle = '#30d5c8'; ctx.lineWidth = 2; ctx.stroke(); } });
    const fx = B.getFix();
    if (pOn.me && fx) { const p = proj([fx.ll[1], fx.ll[0]]); if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, 7); ctx.fillStyle = '#7cc4e8'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); } }
    const c = proj([lon0, lat0]); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(c[0] - 8, c[1]); ctx.lineTo(c[0] + 8, c[1]); ctx.moveTo(c[0], c[1] - 8); ctx.lineTo(c[0], c[1] + 8); ctx.stroke();
    if (lastMark) { const p = proj(lastMark); if (p) { ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(p[0], p[1]); ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2; ctx.stroke(); ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, 7); ctx.fillStyle = '#ffd60a'; ctx.fill(); } }
  }
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
    center = b.dataset.c; pScale = 1; ox = oy = 0;
    document.querySelectorAll('#polarPane [data-c]').forEach(x => x.classList.toggle('on', x === b));
    $('pInfo').textContent = PINFO; drawPolar();
  }));
  // shared + / − / reset buttons route to whichever view is showing
  window.BCN_zoom = dir => {
    if (view === 'globe' && globe) { dir === 0 ? globe.easeTo({ zoom: 1.6, center: globe.getCenter(), duration: 800 }) : dir > 0 ? globe.zoomIn() : globe.zoomOut(); return true; }
    if (view === 'polar' && pReady) { if (dir === 0) { pScale = 1; ox = oy = 0; drawPolar(lastMark); } else { const W = cv.clientWidth, H = cv.clientHeight; zoomAt(dir > 0 ? 1.6 : 1 / 1.6, W / 2, 150 + (H - 310) / 2); } return true; }
    return false;
  };
  // restore the Map's own chip text when leaving Polar
  document.querySelectorAll('.views [data-view]').forEach(b => b.addEventListener('click', () => { if (b.dataset.view !== 'polar') document.dispatchEvent(new Event('bcn:chip')); }));
})();
