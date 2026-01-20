const DATA_PATHS = Object.freeze({
  stats: './data/stats.json',
  qc: './data/qc_summary.json',
  samples: './data/samples.geojson',
  targets: './data/targets.geojson'
});

const MAP_SETTINGS = Object.freeze({
  startZoom: 5,
  minZoomAllSamples: 6,
  clusterRadiusPx: 45,
  clusterMaxZoom: 9,
  allSamplesOpacity: 0.18,
  clustersOpacity: 0.18,
  anomaliesOpacity: 0.9,
  allSamplesRadius: 1.8,
  anomaliesRadiusMin: 5,
  anomaliesRadiusMax: 11,
  targetsRingRadius: 8,
  targetsRingStrokeWidth: 3
});

const COLORS = Object.freeze({
  allSamples: '#9ca3af',
  clusterText: '#111827',
  clusterHalo: '#ffffff',
  anomaly: '#111827',
  targetRing: '#f97316',
  targetText: '#9a3412',
  targetHalo: '#fff7ed'
});

const SOURCE_IDS = Object.freeze({
  osm: 'osm',
  samplesClustered: 'samples_clustered',
  anomalies: 'anomalies',
  targets: 'targets'
});

const LAYER_IDS = Object.freeze({
  clusters: 'clusters',
  clusterCount: 'cluster-count',
  pointsAll: 'points-all',
  pointsAnom: 'points-anom',
  targetsRing: 'targets-ring',
  targetsLabel: 'targets-label'
});

async function fetchJSON(path){
  const res = await fetch(path, { cache: 'no-cache' });
  if(!res.ok){
    const detail = `${res.status} ${res.statusText}`.trim();
    throw new Error(`Failed to load ${path} (${detail})`);
  }
  return res.json();
}

function fmt(n){
  if(n === null || n === undefined || Number.isNaN(n)) return '-';
  const x = Number(n);
  if(Math.abs(x) >= 1000) return x.toFixed(0);
  if(Math.abs(x) >= 10) return x.toFixed(2);
  return x.toFixed(3);
}

function getUI(){
  return {
    banner: document.getElementById('banner'),
    elementSelect: document.getElementById('element'),
    pctSelect: document.getElementById('pct'),
    toggleAll: document.getElementById('toggle-all'),
    qcDiv: document.getElementById('qc'),
    statsDiv: document.getElementById('stats'),
    targetsDiv: document.getElementById('targets')
  };
}

function showBanner(ui, html){
  ui.banner.innerHTML = html;
  ui.banner.classList.remove('hidden');
}

function clearBanner(ui){
  ui.banner.innerHTML = '';
  ui.banner.classList.add('hidden');
}

function setControlsEnabled(ui, enabled){
  ui.elementSelect.disabled = !enabled;
  ui.pctSelect.disabled = !enabled;
  ui.toggleAll.disabled = !enabled;
}

function setLoadingPlaceholders(ui){
  ui.elementSelect.innerHTML = '<option value="">Loading...</option>';
  ui.pctSelect.value = 'p95';
  ui.qcDiv.innerHTML = '<div class="small">Loading...</div>';
  ui.statsDiv.innerHTML = '<div class="small">Loading...</div>';
  ui.targetsDiv.innerHTML = '<div class="small">Loading...</div>';
}

async function loadData(){
  const [stats, qc, samples, targets] = await Promise.all([
    fetchJSON(DATA_PATHS.stats),
    fetchJSON(DATA_PATHS.qc),
    fetchJSON(DATA_PATHS.samples),
    fetchJSON(DATA_PATHS.targets)
  ]);
  return { stats, qc, samples, targets };
}

function renderQc(ui, qc){
  ui.qcDiv.innerHTML = Object.entries(qc).map(([k,v]) => (
    `<div class="kv"><span>${k}</span><span>${v}</span></div>`
  )).join('');
}

function renderElementOptions(ui, stats){
  const elements = Object.keys(stats).sort();
  ui.elementSelect.innerHTML = '';
  for(const el of elements){
    const opt = document.createElement('option');
    opt.value = el;
    opt.textContent = el;
    ui.elementSelect.appendChild(opt);
  }
  const defaultEl = elements.includes('As_AAS') ? 'As_AAS' : elements[0];
  ui.elementSelect.value = defaultEl;
}

function getCenterFromSamples(samples){
  const feats = samples.features ?? [];
  const coords = feats
    .map(f => f?.geometry?.coordinates)
    .filter(c => Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  if(!coords.length) return [0, 0];
  const lon = coords.reduce((sum, c) => sum + c[0], 0) / coords.length;
  const lat = coords.reduce((sum, c) => sum + c[1], 0) / coords.length;
  return [lon, lat];
}

function initMap({ samples, targets }){
  const style = {
    version: 8,
    sources: {
      [SOURCE_IDS.osm]: {
        type: 'raster',
        tiles: [
          'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors'
      },
      [SOURCE_IDS.samplesClustered]: {
        type: 'geojson',
        data: samples,
        cluster: true,
        clusterRadius: MAP_SETTINGS.clusterRadiusPx,
        clusterMaxZoom: MAP_SETTINGS.clusterMaxZoom
      },
      [SOURCE_IDS.anomalies]: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      },
      [SOURCE_IDS.targets]: {
        type: 'geojson',
        data: targets
      }
    },
    layers: [
      { id: 'osm', type: 'raster', source: SOURCE_IDS.osm }
    ]
  };

  const map = new maplibregl.Map({
    container: 'map',
    style,
    center: getCenterFromSamples(samples),
    zoom: MAP_SETTINGS.startZoom
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  return map;
}

function addMapLayers(map){
  map.addLayer({
    id: LAYER_IDS.clusters,
    type: 'circle',
    source: SOURCE_IDS.samplesClustered,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': COLORS.allSamples,
      'circle-radius': [
        'step', ['get', 'point_count'],
        14, 50, 18, 150, 22, 400, 26
      ],
      'circle-opacity': MAP_SETTINGS.clustersOpacity
    }
  });

  map.addLayer({
    id: LAYER_IDS.clusterCount,
    type: 'symbol',
    source: SOURCE_IDS.samplesClustered,
    filter: ['has', 'point_count'],
    layout: {
      'text-field': '{point_count_abbreviated}',
      'text-size': 12
    },
    paint: {
      'text-color': COLORS.clusterText,
      'text-halo-color': COLORS.clusterHalo,
      'text-halo-width': 1
    }
  });

  map.addLayer({
    id: LAYER_IDS.pointsAll,
    type: 'circle',
    source: SOURCE_IDS.samplesClustered,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': COLORS.allSamples,
      'circle-radius': MAP_SETTINGS.allSamplesRadius,
      'circle-opacity': MAP_SETTINGS.allSamplesOpacity
    }
  });

  map.addLayer({
    id: LAYER_IDS.pointsAnom,
    type: 'circle',
    source: SOURCE_IDS.anomalies,
    paint: {
      'circle-color': COLORS.anomaly,
      'circle-opacity': MAP_SETTINGS.anomaliesOpacity,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1,
      'circle-stroke-opacity': 0.35,
      'circle-radius': MAP_SETTINGS.anomaliesRadiusMin
    }
  });

  map.addLayer({
    id: LAYER_IDS.targetsRing,
    type: 'circle',
    source: SOURCE_IDS.targets,
    paint: {
      'circle-color': COLORS.targetRing,
      'circle-opacity': 0.05,
      'circle-radius': MAP_SETTINGS.targetsRingRadius,
      'circle-stroke-color': COLORS.targetRing,
      'circle-stroke-width': MAP_SETTINGS.targetsRingStrokeWidth,
      'circle-stroke-opacity': 0.95
    }
  });

  map.addLayer({
    id: LAYER_IDS.targetsLabel,
    type: 'symbol',
    source: SOURCE_IDS.targets,
    layout: {
      'text-field': ['concat', 'T', ['to-string', ['get', 'cluster_id']]],
      'text-size': 11,
      'text-offset': [0, 1.2]
    },
    paint: {
      'text-color': COLORS.targetText,
      'text-halo-color': COLORS.targetHalo,
      'text-halo-width': 2
    }
  });
}

function setPointerCursor(map, layerId){
  map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
}

function updateAllSamplesVisibility(map, showAll){
  const shouldShow = Boolean(showAll) && map.getZoom() >= MAP_SETTINGS.minZoomAllSamples;
  const visibility = shouldShow ? 'visible' : 'none';
  for(const id of [LAYER_IDS.clusters, LAYER_IDS.clusterCount, LAYER_IDS.pointsAll]){
    if(map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
  }
}

function buildAnomalies(samples, element, threshold){
  const feats = (samples.features ?? []).filter(f => {
    const coords = f?.geometry?.coordinates;
    if(!Array.isArray(coords) || coords.length !== 2) return false;
    const val = Number(f?.properties?.[element]);
    return Number.isFinite(val) && val >= threshold;
  });
  return { type: 'FeatureCollection', features: feats };
}

function updateAnomaliesLayer(map, { stats, samples, element, pctKey }){
  const s = stats[element];
  if(!s) return;
  const threshold = Number(s[pctKey]);
  const maxVal = Number(s.max);
  if(!Number.isFinite(threshold) || !Number.isFinite(maxVal)){
    map.getSource(SOURCE_IDS.anomalies).setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  map.getSource(SOURCE_IDS.anomalies).setData(buildAnomalies(samples, element, threshold));
  map.setPaintProperty(LAYER_IDS.pointsAnom, 'circle-radius', [
    'interpolate', ['linear'], ['get', element],
    threshold, MAP_SETTINGS.anomaliesRadiusMin,
    maxVal, MAP_SETTINGS.anomaliesRadiusMax
  ]);
}

function renderStats(ui, { stats, element, pctKey }){
  const s = stats[element];
  if(!s){
    ui.statsDiv.innerHTML = '<div class="small">No stats for selected element.</div>';
    return;
  }
  const thresh = s[pctKey];
  ui.statsDiv.innerHTML = [
    ['n', s.n],
    ['bdl %', fmt(s.bdl_pct)],
    ['p50', fmt(s.p50)],
    ['p95', fmt(s.p95)],
    ['p99', fmt(s.p99)],
    ['max', fmt(s.max)],
    ['threshold', `${pctKey} = ${fmt(thresh)}`]
  ].map(([k,v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('');
}

function renderTargets(ui, { targets, element }){
  const tFeats = (targets.features ?? [])
    .filter(f => f?.properties?.element === element)
    .sort((a,b) => (b?.properties?.max_value ?? 0) - (a?.properties?.max_value ?? 0))
    .slice(0, 20);

  ui.targetsDiv.innerHTML = tFeats.length ? tFeats.map(f => {
    const p = f.properties;
    return `<div class="target" data-lon="${f.geometry.coordinates[0]}" data-lat="${f.geometry.coordinates[1]}">
      <b>T${p.cluster_id} • ${p.element}</b>
      <div>n=${p.n_points} • max=${fmt(p.max_value)} • mean=${fmt(p.mean_value)}</div>
    </div>`;
  }).join('') : '<div class="small">No clusters at current settings.</div>';
}

function updateTargetFilters(map, element){
  for(const id of [LAYER_IDS.targetsRing, LAYER_IDS.targetsLabel]){
    map.setFilter(id, ['==', ['get', 'element'], element]);
  }
}

function bindUI(map, ui, data){
  function rerender(){
    const element = ui.elementSelect.value;
    const pctKey = ui.pctSelect.value;
    renderStats(ui, { stats: data.stats, element, pctKey });
    renderTargets(ui, { targets: data.targets, element });
    updateAnomaliesLayer(map, { stats: data.stats, samples: data.samples, element, pctKey });
    updateTargetFilters(map, element);
  }

  ui.elementSelect.addEventListener('change', rerender);
  ui.pctSelect.addEventListener('change', rerender);

  ui.toggleAll.addEventListener('change', () => {
    updateAllSamplesVisibility(map, ui.toggleAll.checked);
  });
  map.on('zoomend', () => updateAllSamplesVisibility(map, ui.toggleAll.checked));

  ui.targetsDiv.addEventListener('click', (e) => {
    const el = e.target.closest('.target');
    if(!el) return;
    const lon = Number(el.dataset.lon);
    const lat = Number(el.dataset.lat);
    map.easeTo({ center: [lon, lat], zoom: 9 });
  });

  rerender();
  updateAllSamplesVisibility(map, ui.toggleAll.checked);
}

function bindMapInteractions(map, ui){
  setPointerCursor(map, LAYER_IDS.clusters);
  setPointerCursor(map, LAYER_IDS.pointsAnom);
  setPointerCursor(map, LAYER_IDS.targetsRing);

  map.on('click', LAYER_IDS.clusters, (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: [LAYER_IDS.clusters] });
    if(!features.length) return;
    const clusterId = features[0].properties.cluster_id;
    map.getSource(SOURCE_IDS.samplesClustered).getClusterExpansionZoom(clusterId, (err, zoom) => {
      if(err) return;
      map.easeTo({ center: features[0].geometry.coordinates, zoom });
    });
  });

  map.on('click', LAYER_IDS.pointsAnom, (e) => {
    const f = e.features?.[0];
    if(!f) return;
    const el = ui.elementSelect.value;
    const val = f.properties?.[el];
    const sampleId = f.properties?.Lab_Sample_Identifier ?? '-';
    new maplibregl.Popup()
      .setLngLat(f.geometry.coordinates)
      .setHTML(`<b>${el}</b>: ${fmt(val)}<br><span style="color:#6b7280">ID</span>: ${sampleId}`)
      .addTo(map);
  });

  map.on('click', LAYER_IDS.targetsRing, (e) => {
    const f = e.features?.[0];
    if(!f) return;
    const props = f.properties ?? {};
    new maplibregl.Popup()
      .setLngLat(f.geometry.coordinates)
      .setHTML(`<b>Target</b><br>ID: T${props.cluster_id}<br>Element: ${props.element}<br>n: ${props.n_points}<br>max: ${fmt(props.max_value)}`)
      .addTo(map);
  });
}

async function main(){
  const ui = getUI();
  setLoadingPlaceholders(ui);
  setControlsEnabled(ui, false);
  clearBanner(ui);

  let data;
  try{
    data = await loadData();
  }catch(err){
    const fileHint = location.protocol === 'file:' ? '<div style="margin-top:6px;"><b>Tip</b>: You opened this via <code>file://</code> which blocks fetch in many browsers.</div>' : '';
    showBanner(ui, `
      <div style="font-weight:700; margin-bottom:6px;">Couldn't load dashboard data.</div>
      <div>${String(err.message || err)}</div>
      ${fileHint}
      <pre><b>Fix 1: generate data</b>
python pipeline/run_pipeline.py --input data/raw/bdl210620_pkg_0412a.xlsx --out web/data

<b>Fix 2: serve over http(s)</b>
python3 -m http.server 8000 --directory web
# then open http://localhost:8000</pre>
    `);
    setLoadingPlaceholders(ui);
    return;
  }

  renderQc(ui, data.qc);
  renderElementOptions(ui, data.stats);

  const map = initMap({ samples: data.samples, targets: data.targets });
  map.on('load', () => {
    addMapLayers(map);
    bindMapInteractions(map, ui);
    bindUI(map, ui, data);
    setControlsEnabled(ui, true);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  main();
});
