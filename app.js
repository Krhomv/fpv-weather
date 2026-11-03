/* FPV Weather — rain now, wind at your spots, rain radar.
   Data: Open-Meteo (forecast + geocoding), RainViewer (radar), BigDataCloud (reverse geocoding).
   Everything is stored on the device (localStorage + IndexedDB for photos). */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const nowSec = () => Date.now() / 1000;

/* ---------------- storage ---------------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const DEFAULT_SETTINGS = { unit: 'kmh', wind: 25, gust: 35, rain: 0.2, prob: 60, daylight: true };
const state = {
  settings: { ...DEFAULT_SETTINGS, ...LS.get('fpvw:settings', {}) },
  spots: LS.get('fpvw:spots', []),
  place: LS.get('fpvw:place', { type: 'gps' }),
  gps: LS.get('fpvw:gps', null),
  range: LS.get('fpvw:range', 1),
  photos: new Map(),
};
const saveSpots = () => LS.set('fpvw:spots', state.spots);
const saveSettings = () => LS.set('fpvw:settings', state.settings);
const savePlace = () => LS.set('fpvw:place', state.place);

/* photos in IndexedDB (data URLs) */
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('fpvw', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('photos', mode);
      const req = fn(t.objectStore('photos'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)).catch(() => null),
    put: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)).catch(() => {}),
  };
})();
async function photoOf(spot) {
  if (!spot || !spot.hasPhoto) return null;
  if (state.photos.has(spot.id)) return state.photos.get(spot.id);
  const p = await idb.get(spot.id);
  state.photos.set(spot.id, p || null);
  return p || null;
}

/* ---------------- units & formatting ---------------- */
const UNIT = { kmh: ['km/h', 1], ms: ['m/s', 1 / 3.6], mph: ['mph', 1 / 1.609344], kn: ['kn', 1 / 1.852] };
const uLabel = () => UNIT[state.settings.unit][0];
const uConv = (kmh) => kmh * UNIT[state.settings.unit][1];
const fmtW = (kmh) => (kmh == null ? '–' : Math.round(uConv(kmh)));
const fmtMM = (mm) => (mm == null ? '–' : mm < 0.05 ? '0' : mm < 10 ? mm.toFixed(1) : Math.round(mm).toString());

const fmtCache = new Map();
function fmt(t, tz, opts) {
  const key = tz + JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) { f = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }); fmtCache.set(key, f); }
  return f.format(new Date(t * 1000));
}
const hhmm = (t, tz) => fmt(t, tz, { hour: '2-digit', minute: '2-digit' });
const hh = (t, tz) => fmt(t, tz, { hour: 'numeric' });
const dayKey = (t, tz) => fmt(t, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const dirName = (d) => (d == null ? '' : DIRS[Math.round(d / 22.5) % 16]);

function wxIcon(code, isDay = 1) {
  if (code == null) return '·';
  if (code === 0) return isDay ? '☀️' : '🌙';
  if (code === 1) return isDay ? '🌤️' : '🌙';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 57) return '🌦️';
  if (code >= 61 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '🌨️';
  if (code >= 80 && code <= 82) return '🌧️';
  if (code === 85 || code === 86) return '🌨️';
  if (code >= 95) return '⛈️';
  return '☁️';
}
function intensity(mmh) {
  if (mmh < 0.1) return 'no rain';
  if (mmh < 2.5) return 'light rain';
  if (mmh < 7.6) return 'moderate rain';
  return 'heavy rain';
}
function minsTxt(m) {
  if (m < 55) return `${Math.max(5, Math.round(m / 5) * 5)} min`;
  const h = Math.floor(m / 60), r = Math.round((m % 60) / 15) * 15;
  return r === 60 ? `${h + 1} h` : `${h} h${r ? ' ' + r + ' min' : ''}`;
}

/* ---------------- weather data ---------------- */
const API = 'https://api.open-meteo.com/v1/forecast';
const MAX_AGE = 10 * 60; // seconds
const mem = new Map();

function keyOf(lat, lon) { return `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`; }

async function getWeather(lat, lon, force = false) {
  const key = keyOf(lat, lon);
  const cached = mem.get(key) || LS.get('fpvw:wx:' + key, null);
  if (!force && cached && nowSec() - cached.fetched < MAX_AGE) return cached;
  const p = new URLSearchParams({
    latitude: (+lat).toFixed(4), longitude: (+lon).toFixed(4),
    timezone: 'auto', timeformat: 'unixtime', wind_speed_unit: 'kmh', precipitation_unit: 'mm',
    current: 'precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,is_day',
    minutely_15: 'precipitation',
    forecast_minutely_15: '104', past_minutely_15: '4',
    hourly: 'precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,is_day',
    daily: 'weather_code,precipitation_sum,precipitation_probability_max,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,temperature_2m_max,temperature_2m_min,sunrise,sunset',
    past_days: '7', forecast_days: '16',
  });
  try {
    const r = await fetch(`${API}?${p}`);
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
    const data = normalize(await r.json());
    mem.set(key, data);
    if (!LS.set('fpvw:wx:' + key, data)) pruneWxCache();
    return data;
  } catch (e) {
    if (cached) { cached.stale = true; return cached; }
    throw e;
  }
}
function pruneWxCache() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith('fpvw:wx:')).forEach((k) => localStorage.removeItem(k));
  } catch {}
}

function normalize(j) {
  const zip = (obj, map) => {
    if (!obj || !obj.time) return [];
    return obj.time.map((t, i) => {
      const o = { t };
      for (const [k, src] of Object.entries(map)) o[k] = obj[src] ? obj[src][i] : null;
      return o;
    });
  };
  const c = j.current || {};
  return {
    fetched: nowSec(),
    tz: j.timezone || 'UTC',
    current: {
      t: c.time, p: c.precipitation, code: c.weather_code, w: c.wind_speed_10m, g: c.wind_gusts_10m,
      d: c.wind_direction_10m, temp: c.temperature_2m, isDay: c.is_day,
    },
    m15: zip(j.minutely_15, { p: 'precipitation' }).map((o) => ({ ...o, p: o.p == null ? null : o.p * 4 })), // mm/h
    hourly: zip(j.hourly, {
      p: 'precipitation', prob: 'precipitation_probability', code: 'weather_code', w: 'wind_speed_10m',
      g: 'wind_gusts_10m', d: 'wind_direction_10m', temp: 'temperature_2m', isDay: 'is_day',
    }),
    daily: zip(j.daily, {
      code: 'weather_code', sum: 'precipitation_sum', prob: 'precipitation_probability_max', hours: 'precipitation_hours',
      wmax: 'wind_speed_10m_max', gmax: 'wind_gusts_10m_max', dir: 'wind_direction_10m_dominant',
      tmax: 'temperature_2m_max', tmin: 'temperature_2m_min', sunrise: 'sunrise', sunset: 'sunset',
    }),
  };
}

/* Open-Meteo values describe the period *ending* at t: hourly precipitation at 14:00 fell 13:00–14:00. */
function hourAt(data, t) {
  return data.hourly.find((h) => h.t > t && h.t - 3600 <= t) || null;
}

/* ---------------- fly verdict ---------------- */
function flyHour(h) {
  const s = state.settings;
  if (!h) return 'na';
  if (s.daylight && h.isDay === 0) return 'na';
  const p = h.p ?? 0, w = h.w ?? 0, g = h.g ?? 0;
  if (w > s.wind || g > s.gust || p >= s.rain) return 'bad';
  if ((h.prob != null && h.prob >= s.prob) || w > s.wind * 0.8 || g > s.gust * 0.8 || p > 0) return 'meh';
  return 'good';
}
function flyDay(data, day) {
  const hrs = data.hourly.filter((h) => h.t > day.t && h.t <= day.t + 86400 + 1800);
  let good = 0, meh = 0, bad = 0, counted = 0;
  for (const h of hrs) {
    const v = flyHour(h);
    if (v === 'na') continue;
    counted++;
    if (v === 'good') good++; else if (v === 'meh') meh++; else bad++;
  }
  let v = 'bad';
  if (!counted) v = 'na';
  else if (good >= 3) v = 'good';
  else if (good + meh >= 2) v = 'meh';
  return { v, good, meh, bad, hrs };
}
const VERDICT = {
  good: ['v-good', '✓ Good to fly'],
  meh: ['v-meh', '~ Marginal'],
  bad: ['v-bad', '✕ No fly'],
  na: ['v-na', '☾ Night'],
};
function whyNot(h) {
  const s = state.settings, r = [];
  if (!h) return '';
  if ((h.g ?? 0) > s.gust) r.push(`gusts ${fmtW(h.g)} ${uLabel()}`);
  else if ((h.w ?? 0) > s.wind) r.push(`wind ${fmtW(h.w)} ${uLabel()}`);
  if ((h.p ?? 0) >= s.rain) r.push(intensity(h.p));
  else if (h.prob != null && h.prob >= s.prob) r.push(`${h.prob}% rain chance`);
  return r.join(', ');
}

/* ---------------- location ---------------- */
function getPosition() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Location not available'));
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => rej(e),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 },
    );
  });
}
async function reverseName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const j = await r.json();
    return j.locality || j.city || j.principalSubdivision || null;
  } catch { return null; }
}
async function geocode(q) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
  const j = await r.json();
  return (j.results || []).map((x) => ({
    name: x.name, lat: x.latitude, lon: x.longitude,
    sub: [x.admin1, x.country].filter(Boolean).join(', '),
  }));
}

async function resolvePlace() {
  if (state.place.type === 'spot') {
    const s = state.spots.find((x) => x.id === state.place.id);
    if (s) return { lat: s.lat, lon: s.lon, name: s.name, spot: s };
    state.place = { type: 'gps' }; savePlace();
  }
  try {
    const pos = await getPosition();
    let name = state.gps && keyOf(state.gps.lat, state.gps.lon) === keyOf(pos.lat, pos.lon) ? state.gps.name : null;
    state.gps = { ...pos, name: name || 'My location' };
    LS.set('fpvw:gps', state.gps);
    if (!name) reverseName(pos.lat, pos.lon).then((n) => {
      if (n && state.gps) { state.gps.name = n; LS.set('fpvw:gps', state.gps); if (state.place.type === 'gps') $('#placeName').textContent = n; }
    });
    return { ...state.gps };
  } catch (e) {
    if (state.gps) return { ...state.gps, approx: true };
    if (state.spots[0]) { const s = state.spots[0]; return { lat: s.lat, lon: s.lon, name: s.name, spot: s }; }
    throw new Error('NO_LOCATION');
  }
}

/* ---------------- SVG helpers ---------------- */
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
function svgRoot(w, h) { return el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` }); }

/* monotone cubic path (Fritsch–Carlson) — no overshoot, so rain never dips below 0 */
function monotonePath(pts) {
  const n = pts.length;
  if (n < 2) return n ? `M${pts[0][0]},${pts[0][1]}` : '';
  const dx = [], dy = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; dy[i] = pts[i + 1][1] - pts[i][1]; m[i] = dy[i] / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${pts[i][0] + h},${pts[i][1] + t[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - t[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* rain scale: sqrt so drizzle is visible but heavy rain still fits */
function rainScale(maxV, top, bottom) {
  const vmax = Math.max(4, maxV * 1.1);
  return { f: (v) => bottom - Math.sqrt(Math.max(0, v) / vmax) * (bottom - top), vmax };
}

/* ---------------- NOW view ---------------- */
let nowData = null, nowPlace = null;

async function loadNow(force = false) {
  $('#heroTitle').textContent = nowData ? $('#heroTitle').textContent : 'Loading…';
  let place;
  try { place = await resolvePlace(); } catch (e) {
    $('#heroIcon').textContent = '📍';
    $('#heroTitle').textContent = 'Where are you?';
    $('#heroSub').innerHTML = 'Allow location access, or <a href="#spots">add a spot</a> to see the rain forecast.';
    $('#placeName').textContent = 'No location';
    return;
  }
  nowPlace = place;
  $('#placeName').textContent = place.name + (place.approx ? ' (last known)' : '');
  try {
    nowData = await getWeather(place.lat, place.lon, force);
  } catch (e) {
    $('#heroIcon').textContent = '⚠️';
    $('#heroTitle').textContent = 'Could not load the forecast';
    $('#heroSub').textContent = navigator.onLine ? e.message : 'You seem to be offline.';
    return;
  }
  renderNow();
}

function rainSeries(data) {
  // future 15-min rates (mm/h), each slot [t-900, t]; fallback to hourly
  const t0 = nowSec();
  if (data.m15.length && data.m15.some((x) => x.p != null)) {
    return { step: 900, items: data.m15.filter((x) => x.t > t0 - 900 && x.p != null) };
  }
  return { step: 3600, items: data.hourly.filter((x) => x.t > t0 - 3600 && x.p != null) };
}

function renderNow() {
  const d = nowData, tz = d.tz, t0 = nowSec();
  const ser = rainSeries(d);
  const horizon = t0 + 4 * 3600;
  const next4 = ser.items.filter((x) => x.t - ser.step < horizon);
  const curRate = Math.max(d.current.p != null ? d.current.p * 4 : 0, next4[0] ? next4[0].p : 0);
  const raining = curRate >= 0.1;
  let title, sub, icon;
  if (raining) {
    const stop = next4.find((x) => x.t - ser.step > t0 && x.p < 0.1);
    const maxR = Math.max(...next4.map((x) => x.p));
    icon = '🌧️';
    title = stop ? `Rain stopping in ~${minsTxt((stop.t - ser.step - t0) / 60)}` : 'Rain for the next 4 hours';
    sub = `${intensity(curRate)[0].toUpperCase() + intensity(curRate).slice(1)} now${maxR > curRate * 1.5 ? `, up to ${intensity(maxR)}` : ''}`;
  } else {
    const start = next4.find((x) => x.p >= 0.1);
    if (start) {
      const at = Math.max(t0, start.t - ser.step);
      const maxR = Math.max(...next4.filter((x) => x.t >= start.t).map((x) => x.p));
      icon = '🌦️';
      title = `Rain starting in ~${minsTxt((at - t0) / 60)}`;
      sub = `Around ${hhmm(at, tz)}, ${intensity(maxR)}`;
    } else {
      const h24 = d.hourly.filter((h) => h.t > t0 && h.t <= t0 + 86400);
      const first = h24.find((h) => (h.p ?? 0) >= 0.1);
      const hNow = hourAt(d, t0);
      icon = wxIcon(d.current.code ?? hNow?.code, d.current.isDay ?? 1);
      if (first) {
        const at = first.t - 3600;
        title = `Dry for ~${Math.max(4, Math.round((at - t0) / 3600))} hours`;
        sub = `Rain expected around ${hh(at, tz)}${first.prob != null ? ` (${first.prob}% chance)` : ''}`;
      } else {
        title = 'No rain in the next 24 hours';
        const maxProb = Math.max(0, ...h24.map((h) => h.prob ?? 0));
        sub = maxProb ? `Highest chance of rain ${maxProb}%` : 'Clear skies for flying';
      }
    }
  }
  $('#heroIcon').textContent = icon;
  $('#heroTitle').textContent = title;
  $('#heroSub').textContent = sub + (d.stale ? ' · offline data' : '');
  $('#updated').textContent = `Updated ${hhmm(d.fetched, Intl.DateTimeFormat().resolvedOptions().timeZone)}`;

  drawNowChart();
  renderNowWind();
  renderHourStrip();
}

function drawNowChart() {
  const box = $('#nowChart'), d = nowData, tz = d.tz;
  const W = box.clientWidth || 340, H = 170, L = 6, R = state.range === 24 ? 30 : 6, T = 14, B = 22;
  const t0 = nowSec(), t1 = t0 + state.range * 3600;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const svg = svgRoot(W, H);
  const bottom = H - B;
  $('.legend', box.parentElement).classList.toggle('show24', state.range === 24);

  let items, step;
  if (state.range === 24) { step = 3600; items = d.hourly.filter((h) => h.t > t0 && h.t - 3600 < t1); }
  else { const s = rainSeries(d); step = s.step; items = s.items.filter((h) => h.t - step < t1 + step); }
  const maxV = Math.max(0, ...items.map((i) => i.p ?? 0));
  const y = rainScale(maxV, T, bottom);

  // intensity guides
  [[2.5, 'moderate'], [7.6, 'heavy']].forEach(([v, name]) => {
    if (v > y.vmax) return;
    svg.append(el('line', { x1: L, x2: W - R, y1: y.f(v), y2: y.f(v), stroke: css('--line'), 'stroke-dasharray': '3 4' }));
    svg.append(el('text', { x: L + 2, y: y.f(v) - 3 }, name));
  });
  svg.append(el('text', { x: L + 2, y: bottom - 4 }, 'light'));

  if (state.range === 24) {
    const bw = (W - L - R) / 24;
    items.forEach((h) => {
      const xs = clamp(x(h.t - 3600), L, W - R), xe = clamp(x(h.t), L, W - R);
      if (xe - xs < 1) return;
      const v = h.p ?? 0;
      if (v > 0) svg.append(el('rect', { x: xs + 1, width: Math.max(1, xe - xs - 2), y: y.f(v), height: bottom - y.f(v), rx: 2, fill: css('--rain') }));
    });
    // probability line on right axis
    const py = (p) => bottom - (p / 100) * (bottom - T);
    const pts = items.filter((h) => h.prob != null).map((h) => [clamp(x(h.t - 1800), L, W - R), py(h.prob)]);
    if (pts.length > 1) svg.append(el('path', { d: monotonePath(pts), fill: 'none', stroke: css('--prob'), 'stroke-width': 1.5, opacity: 0.85 }));
    [0, 50, 100].forEach((p) => svg.append(el('text', { x: W - 2, y: py(p) + (p === 100 ? 8 : p === 0 ? -2 : 3), 'text-anchor': 'end' }, p + '%')));
    svg.append(el('text', { x: L + 12, y: H - 6, 'text-anchor': 'middle', class: 'lbl-strong' }, 'now'));
    for (let t = Math.ceil((t0 + 5400) / 10800) * 10800; t < t1 - 3600; t += 10800) {
      svg.append(el('text', { x: x(t), y: H - 6, 'text-anchor': 'middle' }, hh(t, tz)));
    }
  } else {
    // smooth area through slot mid-points, starting at "now"
    const pts = [];
    items.forEach((h) => pts.push([x(h.t - step / 2), y.f(h.p ?? 0)]));
    let p2 = pts.filter((p) => p[0] >= L - 40 && p[0] <= W - R + 40);
    if (p2.length >= 2) {
      const path = monotonePath(p2);
      const clipId = 'clipnow';
      const defs = el('defs');
      const cp = el('clipPath', { id: clipId });
      cp.append(el('rect', { x: L, y: 0, width: W - L - R, height: H }));
      const grad = el('linearGradient', { id: 'gnow', x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(el('stop', { offset: '0%', 'stop-color': css('--rain'), 'stop-opacity': 0.9 }));
      grad.append(el('stop', { offset: '100%', 'stop-color': css('--rain'), 'stop-opacity': 0.25 }));
      defs.append(cp, grad); svg.append(defs);
      const g = el('g', { 'clip-path': `url(#${clipId})` });
      g.append(el('path', { d: `${path}L${p2[p2.length - 1][0]},${bottom}L${p2[0][0]},${bottom}Z`, fill: 'url(#gnow)' }));
      g.append(el('path', { d: path, fill: 'none', stroke: css('--rain'), 'stroke-width': 2 }));
      svg.append(g);
    }
    const stepT = state.range === 1 ? 900 : 3600;
    svg.append(el('text', { x: L + 12, y: H - 6, 'text-anchor': 'middle', class: 'lbl-strong' }, 'now'));
    for (let t = Math.ceil((t0 + stepT * 0.4) / stepT) * stepT; t <= t1 + 1; t += stepT) {
      if (x(t) > W - R - 16) break;
      svg.append(el('text', { x: x(t), y: H - 6, 'text-anchor': 'middle' }, hhmm(t, tz)));
    }
  }
  svg.append(el('line', { x1: L, x2: W - R, y1: bottom, y2: bottom, stroke: css('--line') }));
  if (maxV < 0.1) svg.append(el('text', { x: W / 2, y: (T + bottom) / 2, 'text-anchor': 'middle', class: 'lbl-strong', 'font-size': 13 }, `No rain in the next ${state.range === 1 ? 'hour' : state.range + ' hours'}`));
  box.replaceChildren(svg);
}

function arrowSvg(dirFrom, color = css('--wind')) {
  // wind "from" direction → arrow points where it blows to
  const rot = ((dirFrom ?? 0) + 180) % 360;
  return `<svg class="arrow" viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" fill="none" stroke="${css('--line')}"/>
    <g transform="rotate(${rot} 22 22)"><path d="M22 7 L29 25 L22 21 L15 25 Z" fill="${color}"/><rect x="21" y="20" width="2" height="16" rx="1" fill="${color}"/></g></svg>`;
}

function renderNowWind() {
  const d = nowData, c = d.current, t0 = nowSec();
  const h = hourAt(d, t0) || {};
  const cur = { ...h, w: c.w ?? h.w, g: c.g ?? h.g, d: c.d ?? h.d, p: Math.max(c.p != null ? c.p * 4 : 0, h.p ?? 0), isDay: c.isDay ?? h.isDay };
  const dark = cur.isDay === 0;
  const v = flyHour({ ...cur, isDay: 1 });
  const [cls, label0] = VERDICT[v];
  const label = label0 + (dark ? ' · dark' : '');
  // next flyable window if not good now
  let extra = '';
  if (v !== 'good') {
    const nxt = d.hourly.find((x) => x.t > t0 + 3600 && x.t < t0 + 48 * 3600 && flyHour(x) === 'good');
    extra = nxt ? `Next good window from ${fmt(nxt.t - 3600, d.tz, { weekday: 'short', hour: 'numeric' })}` : 'No good window in the next 48 h';
  }
  const why = v === 'bad' || v === 'meh' ? whyNot(cur) : '';
  $('#nowWind').innerHTML = `
    <div class="card-h">Wind now <span class="verdict ${cls}">${label}</span></div>
    <div class="wind-row">
      ${arrowSvg(cur.d)}
      <div><div class="big">${fmtW(cur.w)} <span class="small muted">${uLabel()}</span></div><div class="muted small">from ${dirName(cur.d)}</div></div>
      <div><div class="big" style="color:var(--gust)">${fmtW(cur.g)} <span class="small muted">${uLabel()}</span></div><div class="muted small">gusts</div></div>
      ${c.temp != null ? `<div style="margin-left:auto;text-align:right"><div class="big">${Math.round(c.temp)}°</div><div class="muted small">temp</div></div>` : ''}
    </div>
    ${why || extra ? `<div class="muted small" style="margin-top:8px">${esc([why, extra].filter(Boolean).join(' · '))}</div>` : ''}`;
}

function renderHourStrip() {
  const d = nowData, t0 = nowSec();
  const hrs = d.hourly.filter((h) => h.t > t0 && h.t <= t0 + 24 * 3600);
  const colors = { good: css('--good'), meh: css('--meh'), bad: css('--bad'), na: 'transparent' };
  $('#hourStrip').innerHTML = hrs.map((h) => `
    <div class="hcell" style="border-top-color:${colors[flyHour(h)]}">
      <div class="t">${hh(h.t - 3600, d.tz)}</div>
      <div class="i">${wxIcon(h.code, h.isDay)}</div>
      <div class="r">${(h.p ?? 0) >= 0.1 ? fmtMM(h.p) + 'mm' : h.prob != null ? h.prob + '%' : '–'}</div>
      <div class="w">${fmtW(h.w)}<span class="muted">/${fmtW(h.g)}</span></div>
    </div>`).join('');
}

/* ---------------- SPOTS ---------------- */
async function renderSpots() {
  const list = $('#spotList');
  if (!state.spots.length) {
    list.innerHTML = `<div class="empty"><div class="e-icon">🛸</div><b>No spots yet</b><br>Add your favourite FPV spots to see rain and wind there for the past week and the next two weeks.<br><br><button class="btn primary" onclick="openSpotEditor()">＋ Add your first spot</button></div>`;
    return;
  }
  list.innerHTML = state.spots.map((s) => `
    <div class="spot" data-id="${s.id}">
      <div class="spot-img" data-photo="${s.id}">⌖</div>
      <div class="spot-main">
        <div class="spot-name">${esc(s.name)}</div>
        <div class="spot-stats" data-stats="${s.id}"><span class="muted">Loading…</span></div>
        <div class="spot-days" data-days="${s.id}"></div>
      </div>
    </div>`).join('');
  $$('.spot', list).forEach((e) => (e.onclick = () => (location.hash = '#spot/' + e.dataset.id)));
  for (const s of state.spots) {
    photoOf(s).then((p) => { const im = $(`[data-photo="${s.id}"]`); if (im && p) { im.style.backgroundImage = `url(${p})`; im.textContent = ''; } });
    getWeather(s.lat, s.lon).then((d) => {
      const t0 = nowSec();
      const next24 = d.hourly.filter((h) => h.t > t0 && h.t <= t0 + 86400);
      const rain = next24.reduce((a, h) => a + (h.p ?? 0), 0);
      const gmax = Math.max(0, ...next24.map((h) => h.g ?? 0));
      const v = flyHour(hourAt(d, t0));
      const [cls, label] = VERDICT[v];
      const st = $(`[data-stats="${s.id}"]`);
      if (st) st.innerHTML = `<span class="verdict ${cls}" style="padding:1px 8px;font-size:11px">${label}</span>
        <span>24h rain <b>${fmtMM(rain)} mm</b></span><span>gusts <b>${fmtW(gmax)}</b> ${uLabel()}</span>`;
      const today = dayKey(t0, d.tz);
      const days = d.daily.filter((x) => x.t >= d.daily.find((y) => dayKey(y.t, d.tz) === today)?.t).slice(0, 7);
      const dd = $(`[data-days="${s.id}"]`);
      if (dd) dd.innerHTML = days.map((x) => `<i title="${fmt(x.t, d.tz, { weekday: 'short' })}" style="background:var(--${{ good: 'good', meh: 'meh', bad: 'bad', na: 'line' }[flyDay(d, x).v]})"></i>`).join('');
    }).catch(() => { const st = $(`[data-stats="${s.id}"]`); if (st) st.innerHTML = '<span class="muted">Offline</span>'; });
  }
}

/* ---------------- SPOT DETAIL ---------------- */
let detailSpot = null;
async function renderDetail(id) {
  const s = state.spots.find((x) => x.id === id);
  if (!s) { location.hash = '#spots'; return; }
  detailSpot = s;
  $('#dName').textContent = s.name;
  $('#dCoords').textContent = `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`;
  const ph = $('#dPhoto');
  ph.style.backgroundImage = '';
  photoOf(s).then((p) => { if (p && detailSpot === s) ph.style.backgroundImage = `url(${p})`; });
  $('#dToday').innerHTML = '<span class="muted">Loading forecast…</span>';
  ['#d48', '#dDays', '#dayList'].forEach((q) => ($(q).innerHTML = ''));
  let d;
  try { d = await getWeather(s.lat, s.lon); } catch (e) { $('#dToday').innerHTML = `<span class="muted">Could not load the forecast (${esc(e.message)}).</span>`; return; }
  if (detailSpot !== s) return;
  const t0 = nowSec();
  const today = d.daily.find((x) => dayKey(x.t, d.tz) === dayKey(t0, d.tz)) || d.daily[7];
  const fd = flyDay(d, today);
  const curH = hourAt(d, t0);
  const v = flyHour(curH);
  const rest = d.hourly.filter((h) => h.t > t0 && h.t <= today.t + 86400);
  const goodLeft = rest.filter((h) => flyHour(h) === 'good').length;
  $('#dToday').innerHTML = `
    <div class="card-h">Right now <span class="verdict ${VERDICT[v][0]}">${VERDICT[v][1]}</span></div>
    <div class="muted small">${esc(whyNot(curH) || (goodLeft ? `${goodLeft} good flying hour${goodLeft > 1 ? 's' : ''} left today` : fd.v === 'na' ? '' : 'No good hours left today'))}${d.stale ? ' · offline data' : ''}</div>
    <div class="today-grid">
      <div><span class="muted small">Wind</span><b>${fmtW(curH?.w)}</b><span class="muted small">${uLabel()} ${dirName(curH?.d)}</span></div>
      <div><span class="muted small">Gusts</span><b style="color:var(--gust)">${fmtW(curH?.g)}</b><span class="muted small">today max ${fmtW(today.gmax)}</span></div>
      <div><span class="muted small">Rain today</span><b style="color:var(--rain)">${fmtMM(today.sum)}</b><span class="muted small">mm · ${today.prob ?? '–'}%</span></div>
    </div>
    ${s.notes ? `<div class="notes">${esc(s.notes)}</div>` : ''}`;

  const h48 = d.hourly.filter((h) => h.t > t0 - 3600 && h.t <= t0 + 48 * 3600);
  drawHourly($('#d48'), h48, d.tz, 16);
  drawDaily($('#dDays'), d);
  renderDayList(d);
}

function drawHourly(box, hrs, tz, colW = 16) {
  if (!hrs.length) { box.innerHTML = '<div class="muted small">No data</div>'; return; }
  const s = state.settings;
  const L = 4, R = 30, T = 10, B = 34, H = 190;
  const W = Math.max(box.clientWidth || 320, L + R + hrs.length * colW);
  const cw = (W - L - R) / hrs.length;
  const bottom = H - B;
  const svg = svgRoot(W, H);
  const maxP = Math.max(0, ...hrs.map((h) => h.p ?? 0));
  const ry = rainScale(maxP, T + 40, bottom);
  const wmax = Math.max(s.gust * 1.15, ...hrs.map((h) => h.g ?? 0)) * 1.05;
  const wy = (v) => bottom - (v / wmax) * (bottom - T);
  const x0 = (i) => L + i * cw;

  // night shading + day separators
  hrs.forEach((h, i) => {
    if (h.isDay === 0) svg.append(el('rect', { x: x0(i), y: T, width: cw + 0.5, height: bottom - T, fill: '#000', opacity: 0.22 }));
    const start = h.t - 3600;
    if (+fmt(start, tz, { hour: 'numeric', hourCycle: 'h23' }) === 0) {
      svg.append(el('line', { x1: x0(i), x2: x0(i), y1: T - 6, y2: H - 4, stroke: css('--line') }));
      svg.append(el('text', { x: x0(i) + 3, y: T - 1, class: 'lbl-strong' }, fmt(start, tz, { weekday: 'short', day: 'numeric' })));
    }
  });
  // thresholds
  [[s.wind, css('--wind')], [s.gust, css('--gust')]].forEach(([v, c]) => {
    svg.append(el('line', { x1: L, x2: W - R, y1: wy(v), y2: wy(v), stroke: c, 'stroke-dasharray': '2 5', opacity: 0.55 }));
  });
  // rain bars
  hrs.forEach((h, i) => {
    const v = h.p ?? 0;
    if (v > 0.01) svg.append(el('rect', { x: x0(i) + 1, y: ry.f(v), width: Math.max(1, cw - 2), height: bottom - ry.f(v), rx: 2, fill: css('--rain'), opacity: 0.9 }));
  });
  // wind lines
  const line = (key, color, wdt) => {
    const pts = hrs.filter((h) => h[key] != null).map((h) => [x0(hrs.indexOf(h)) + cw / 2, wy(h[key])]);
    if (pts.length > 1) svg.append(el('path', { d: monotonePath(pts), fill: 'none', stroke: color, 'stroke-width': wdt, 'stroke-linejoin': 'round' }));
  };
  line('g', css('--gust'), 1.5);
  line('w', css('--wind'), 2);
  // right axis
  const stepU = wmax > 60 ? 20 : wmax > 30 ? 10 : 5;
  for (let u = 0; uConv(wmax) > u; u += stepU) {
    const kmh = u / UNIT[s.unit][1];
    svg.append(el('text', { x: W - 3, y: wy(kmh) + 3, 'text-anchor': 'end' }, u));
  }
  svg.append(el('text', { x: W - 3, y: T + 8, 'text-anchor': 'end' }, uLabel()));
  // now marker
  const t0 = nowSec();
  const ni = hrs.findIndex((h) => h.t > t0);
  if (ni >= 0) {
    const nx = x0(ni) + ((t0 - (hrs[ni].t - 3600)) / 3600) * cw;
    svg.append(el('line', { x1: nx, x2: nx, y1: T, y2: bottom, stroke: css('--accent'), 'stroke-width': 1.5 }));
  }
  svg.append(el('line', { x1: L, x2: W - R, y1: bottom, y2: bottom, stroke: css('--line') }));
  // fly strip + hour labels
  const colors = { good: css('--good'), meh: css('--meh'), bad: css('--bad'), na: css('--card2') };
  hrs.forEach((h, i) => {
    svg.append(el('rect', { x: x0(i) + 0.5, y: bottom + 4, width: cw - 1, height: 7, rx: 1.5, fill: colors[flyHour(h)] }));
    const start = h.t - 3600;
    const hr = +fmt(start, tz, { hour: 'numeric', hourCycle: 'h23' });
    if (hr % 3 === 0) svg.append(el('text', { x: x0(i) + cw / 2, y: H - 8, 'text-anchor': 'middle' }, hh(start, tz)));
  });
  box.replaceChildren(svg);
  if (ni > 2) box.scrollLeft = Math.max(0, x0(ni) - 40);
}

function drawDaily(box, d) {
  const days = d.daily, tz = d.tz, s = state.settings;
  const colW = 38, L = 4, R = 30, T = 14, B = 46, H = 200;
  const W = Math.max(box.clientWidth || 320, L + R + days.length * colW);
  const cw = (W - L - R) / days.length;
  const bottom = H - B;
  const svg = svgRoot(W, H);
  const maxS = Math.max(8, ...days.map((x) => x.sum ?? 0));
  const ry = (v) => bottom - (v / (maxS * 1.1)) * (bottom - T - 24);
  const wmax = Math.max(s.gust * 1.2, ...days.map((x) => x.gmax ?? 0)) * 1.05;
  const wy = (v) => bottom - (v / wmax) * (bottom - T);
  const todayK = dayKey(nowSec(), tz);
  let todayI = -1;
  days.forEach((x, i) => {
    const X = L + i * cw;
    const isToday = dayKey(x.t, tz) === todayK;
    const past = !isToday && x.t < nowSec();
    if (isToday) { todayI = i; svg.append(el('rect', { x: X, y: 0, width: cw, height: H, fill: css('--accent'), opacity: 0.1, rx: 6 })); }
    const v = x.sum ?? 0;
    if (v > 0.05) {
      svg.append(el('rect', { x: X + 5, y: ry(v), width: cw - 10, height: bottom - ry(v), rx: 3, fill: css('--rain'), opacity: past ? 0.45 : 0.9 }));
      svg.append(el('text', { x: X + cw / 2, y: ry(v) - 3, 'text-anchor': 'middle' }, fmtMM(v)));
    }
    svg.append(el('text', { x: X + cw / 2, y: bottom + 14, 'text-anchor': 'middle', class: isToday ? 'lbl-strong' : '' }, isToday ? 'Today' : fmt(x.t, tz, { weekday: 'short' })));
    svg.append(el('text', { x: X + cw / 2, y: bottom + 26, 'text-anchor': 'middle' }, fmt(x.t, tz, { day: 'numeric', month: 'numeric' })));
    const fv = flyDay(d, x).v;
    svg.append(el('circle', { cx: X + cw / 2, cy: bottom + 37, r: 4, fill: { good: css('--good'), meh: css('--meh'), bad: css('--bad'), na: css('--line') }[fv] }));
  });
  const pts = (key) => days.map((x, i) => (x[key] == null ? null : [L + i * cw + cw / 2, wy(x[key])])).filter(Boolean);
  svg.append(el('line', { x1: L, x2: W - R, y1: wy(s.gust), y2: wy(s.gust), stroke: css('--gust'), 'stroke-dasharray': '2 5', opacity: 0.5 }));
  [['gmax', css('--gust'), 1.5], ['wmax', css('--wind'), 2]].forEach(([k, c, w]) => {
    const p = pts(k);
    if (p.length > 1) svg.append(el('path', { d: monotonePath(p), fill: 'none', stroke: c, 'stroke-width': w }));
    p.forEach(([cx, cy]) => svg.append(el('circle', { cx, cy, r: 2, fill: c })));
  });
  const stepU = wmax > 60 ? 20 : wmax > 30 ? 10 : 5;
  for (let u = 0; uConv(wmax) > u; u += stepU) svg.append(el('text', { x: W - 3, y: wy(u / UNIT[s.unit][1]) + 3, 'text-anchor': 'end' }, u));
  svg.append(el('text', { x: W - 3, y: T - 2, 'text-anchor': 'end' }, uLabel()));
  svg.append(el('line', { x1: L, x2: W - R, y1: bottom, y2: bottom, stroke: css('--line') }));
  box.replaceChildren(svg);
  if (todayI > 0) box.scrollLeft = Math.max(0, L + todayI * cw - 2 * cw);
}

function renderDayList(d) {
  const tz = d.tz, todayK = dayKey(nowSec(), tz);
  const list = $('#dayList');
  list.innerHTML = d.daily.map((x, i) => {
    const isToday = dayKey(x.t, tz) === todayK, past = !isToday && x.t < nowSec();
    const fd = flyDay(d, x);
    const flyTxt = fd.v === 'na' ? '' : `${fd.good} h good`;
    return `<div class="day ${past ? 'past' : ''} ${isToday ? 'today' : ''}" data-i="${i}">
      <div class="day-row">
        <div class="day-name">${isToday ? 'Today' : fmt(x.t, tz, { weekday: 'short' })}<span>${fmt(x.t, tz, { day: 'numeric', month: 'short' })}</span></div>
        <div class="day-ic">${wxIcon(x.code)}</div>
        <div class="day-bars">
          <span class="r">☂ ${fmtMM(x.sum)} mm${x.prob != null && !past ? ` · ${x.prob}%` : ''}${x.hours ? ` · ${Math.round(x.hours)} h` : ''}</span>
          <span class="w">≋ ${fmtW(x.wmax)} / ${fmtW(x.gmax)} ${uLabel()} ${dirName(x.dir)}</span>
        </div>
        <div style="text-align:right"><span class="dot ${fd.v}"></span><div class="muted small">${flyTxt}</div></div>
      </div>
    </div>`;
  }).join('');
  $$('.day', list).forEach((row) => {
    $('.day-row', row).onclick = () => {
      const open = $('.day-more', row);
      if (open) { open.remove(); return; }
      const x = d.daily[+row.dataset.i];
      const more = document.createElement('div');
      more.className = 'day-more';
      more.innerHTML = `<div class="chart scroll"></div><div class="muted small" style="margin-top:4px">${x.sunrise ? `Sunrise ${hhmm(x.sunrise, tz)} · Sunset ${hhmm(x.sunset, tz)} · ` : ''}${x.tmin != null ? `${Math.round(x.tmin)}° / ${Math.round(x.tmax)}°` : ''}</div>`;
      row.append(more);
      drawHourly($('.chart', more), d.hourly.filter((h) => h.t > x.t && h.t <= x.t + 86400), tz, 14);
    };
  });
  const t = $('.day.today', list);
  if (t && t.previousElementSibling) {
    // collapse the past by default: hide all but the previous day, with a toggle
    const past = $$('.day.past', list);
    past.forEach((p) => (p.hidden = true));
    const tog = document.createElement('button');
    tog.className = 'btn wide';
    tog.style.margin = '0';
    tog.style.borderRadius = '0';
    tog.textContent = `Show past ${past.length} days`;
    tog.onclick = () => { past.forEach((p) => (p.hidden = false)); tog.remove(); };
    list.prepend(tog);
  }
}

/* ---------------- RADAR ---------------- */
const radar = { map: null, frames: [], layers: [], idx: 0, timer: null, host: '', markers: null, loadedAt: 0, me: null };
const TILE_DARK = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

function initRadar() {
  if (radar.map) { radar.map.invalidateSize(); refreshRadarFrames(); updateRadarMarkers(); return; }
  const c = nowPlace || state.gps || state.spots[0] || { lat: 46.5, lon: 6.6 };
  const map = L.map('radarMap', { zoomControl: true, attributionControl: true }).setView([c.lat, c.lon], 8);
  L.tileLayer(TILE_DARK, { attribution: TILE_ATTR + ' · Radar <a href="https://www.rainviewer.com/">RainViewer</a>', subdomains: 'abcd', maxZoom: 18 }).addTo(map);
  radar.map = map;
  radar.markers = L.layerGroup().addTo(map);
  const lg = L.control({ position: 'topright' });
  lg.onAdd = () => { const d = L.DomUtil.create('div', 'radar-legend'); d.innerHTML = 'light<i></i>heavy'; return d; };
  lg.addTo(map);
  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    const div = document.createElement('div');
    div.innerHTML = `<div style="margin-bottom:6px" class="small muted">${lat.toFixed(4)}, ${lng.toFixed(4)}</div><button class="btn primary">＋ Add spot here</button>`;
    $('button', div).onclick = () => { map.closePopup(); openSpotEditor(null, { lat, lon: lng }); };
    L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
    $('#radarHint').hidden = true;
  });
  updateRadarMarkers();
  refreshRadarFrames();
  $('#radarPlay').onclick = () => (radar.timer ? stopRadar() : playRadar());
  $('#radarSlider').oninput = (e) => { stopRadar(); showFrame(+e.target.value); };
}

function updateRadarMarkers() {
  if (!radar.markers) return;
  radar.markers.clearLayers();
  const icon = L.divIcon({ className: 'spot-marker', iconSize: [14, 14] });
  state.spots.forEach((s) => {
    L.marker([s.lat, s.lon], { icon }).addTo(radar.markers)
      .bindTooltip(esc(s.name), { permanent: true, direction: 'right', offset: [8, 0], className: 'spot-label' })
      .on('click', () => (location.hash = '#spot/' + s.id));
  });
  if (state.gps) L.circleMarker([state.gps.lat, state.gps.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#4aa8ff', fillOpacity: 1 }).addTo(radar.markers);
}

async function refreshRadarFrames() {
  if (nowSec() - radar.loadedAt < 300 && radar.frames.length) return;
  try {
    const r = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    const j = await r.json();
    radar.host = j.host;
    const past = (j.radar && j.radar.past) || [];
    const cast = ((j.radar && j.radar.nowcast) || []).map((f) => ({ ...f, forecast: true }));
    radar.layers.forEach((l) => radar.map.removeLayer(l));
    radar.frames = [...past, ...cast];
    radar.layers = radar.frames.map((f) => L.tileLayer(`${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      tileSize: 256, opacity: 0, zIndex: 10, maxNativeZoom: 7, maxZoom: 18, crossOrigin: true,
    }));
    radar.loadedAt = nowSec();
    const sl = $('#radarSlider');
    sl.max = Math.max(0, radar.frames.length - 1);
    showFrame(past.length - 1);
  } catch (e) {
    $('#radarTime').textContent = 'offline';
  }
}

function showFrame(i) {
  if (!radar.frames.length) return;
  i = (i + radar.frames.length) % radar.frames.length;
  const prev = radar.layers[radar.idx];
  const cur = radar.layers[i];
  if (!radar.map.hasLayer(cur)) cur.addTo(radar.map);
  cur.setOpacity(0.72);
  if (prev && prev !== cur) prev.setOpacity(0);
  // preload next frame
  const nxt = radar.layers[(i + 1) % radar.layers.length];
  if (nxt && !radar.map.hasLayer(nxt)) nxt.addTo(radar.map);
  radar.idx = i;
  $('#radarSlider').value = i;
  const f = radar.frames[i];
  const diff = Math.round((f.time - nowSec()) / 60);
  const rel = Math.abs(diff) < 5 ? 'now' : diff < 0 ? `${diff} min` : `+${diff} min forecast`;
  $('#radarTime').innerHTML = `${new Date(f.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<small>${rel}</small>`;
}
function playRadar() {
  $('#radarPlay').textContent = '❚❚';
  radar.timer = setInterval(() => showFrame(radar.idx + 1), 600);
}
function stopRadar() {
  clearInterval(radar.timer); radar.timer = null;
  $('#radarPlay').textContent = '▶';
}

/* ---------------- spot editor ---------------- */
const editor = { map: null, marker: null, spot: null, lat: null, lon: null, photo: undefined };

function openSpotEditor(spot = null, at = null) {
  editor.spot = spot;
  editor.photo = undefined; // undefined = unchanged, null = removed, string = new
  const c = spot || at || nowPlace || state.gps || { lat: 46.5, lon: 6.6 };
  editor.lat = c.lat; editor.lon = c.lon;
  $('#spotSheetTitle').textContent = spot ? 'Edit spot' : 'New spot';
  $('#spotName').value = spot ? spot.name : '';
  $('#spotNotes').value = spot ? spot.notes || '' : '';
  $('#spotSearch').value = '';
  $('#spotResults').innerHTML = '';
  $('#spotDelete').hidden = !spot;
  const prev = $('#spotPhotoPreview');
  prev.hidden = true; $('#spotPhotoRemove').hidden = true;
  if (spot) photoOf(spot).then((p) => { if (p) { prev.src = p; prev.hidden = false; $('#spotPhotoRemove').hidden = false; } });
  openSheet('#spotSheet');
  requestAnimationFrame(() => {
    if (!editor.map) {
      editor.map = L.map('spotMap', { zoomControl: false, attributionControl: false });
      L.tileLayer(TILE_DARK, { subdomains: 'abcd', maxZoom: 19 }).addTo(editor.map);
      editor.marker = L.marker([c.lat, c.lon], { draggable: true }).addTo(editor.map);
      editor.marker.on('dragend', () => { const p = editor.marker.getLatLng(); setEditorPos(p.lat, p.lng, false); });
      editor.map.on('click', (e) => setEditorPos(e.latlng.lat, e.latlng.lng, false));
    }
    editor.map.invalidateSize();
    setEditorPos(c.lat, c.lon, true, spot || at ? 14 : 11);
  });
}
function setEditorPos(lat, lon, pan = true, zoom) {
  editor.lat = lat; editor.lon = lon;
  editor.marker.setLatLng([lat, lon]);
  if (pan) editor.map.setView([lat, lon], zoom || Math.max(editor.map.getZoom() || 13, 13));
  $('#spotLatLon').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}
let searchT;
$('#spotSearch').addEventListener('input', (e) => {
  clearTimeout(searchT);
  const q = e.target.value.trim();
  if (q.length < 2) { $('#spotResults').innerHTML = ''; return; }
  searchT = setTimeout(async () => {
    try {
      const res = await geocode(q);
      $('#spotResults').innerHTML = res.length ? '' : '<div class="muted small">No matches</div>';
      res.forEach((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = `<b>${esc(r.name)}</b> <span class="muted small">${esc(r.sub)}</span>`;
        b.onclick = () => { setEditorPos(r.lat, r.lon, true, 13); $('#spotResults').innerHTML = ''; if (!$('#spotName').value) $('#spotName').placeholder = r.name; };
        $('#spotResults').append(b);
      });
    } catch { $('#spotResults').innerHTML = '<div class="muted small">Search unavailable offline</div>'; }
  }, 350);
});
$('#spotGps').onclick = async () => {
  try { const p = await getPosition(); setEditorPos(p.lat, p.lon, true, 15); } catch { toast('Could not get your location'); }
};
$('#spotPhoto').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    editor.photo = await resizeImage(f, 1000, 0.78);
    $('#spotPhotoPreview').src = editor.photo;
    $('#spotPhotoPreview').hidden = false;
    $('#spotPhotoRemove').hidden = false;
  } catch { toast('Could not read that image'); }
};
$('#spotPhotoRemove').onclick = () => { editor.photo = null; $('#spotPhotoPreview').hidden = true; $('#spotPhotoRemove').hidden = true; };

async function resizeImage(file, max, q) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  } finally { URL.revokeObjectURL(url); }
}

$('#spotSave').onclick = async () => {
  let name = $('#spotName').value.trim() || $('#spotName').placeholder.replace(/^e\.g\. .*/, '');
  if (!name) name = (await reverseName(editor.lat, editor.lon)) || `Spot ${state.spots.length + 1}`;
  let s = editor.spot;
  if (!s) { s = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: Date.now() }; state.spots.push(s); }
  Object.assign(s, { name, lat: +editor.lat.toFixed(5), lon: +editor.lon.toFixed(5), notes: $('#spotNotes').value.trim() });
  if (editor.photo !== undefined) {
    if (editor.photo) { await idb.put(s.id, editor.photo); s.hasPhoto = true; state.photos.set(s.id, editor.photo); }
    else { await idb.del(s.id); s.hasPhoto = false; state.photos.delete(s.id); }
  }
  saveSpots();
  closeSheets();
  toast(editor.spot ? 'Spot updated' : 'Spot added');
  updateRadarMarkers();
  if (location.hash.startsWith('#spot/')) renderDetail(s.id);
  else location.hash = '#spot/' + s.id;
};
$('#spotDelete').onclick = async () => {
  const s = editor.spot;
  if (!s || !confirm(`Delete "${s.name}"?`)) return;
  state.spots = state.spots.filter((x) => x !== s);
  saveSpots(); idb.del(s.id); state.photos.delete(s.id);
  if (state.place.type === 'spot' && state.place.id === s.id) { state.place = { type: 'gps' }; savePlace(); }
  closeSheets(); updateRadarMarkers();
  location.hash = '#spots';
};

/* ---------------- sheets, settings, place picker ---------------- */
function openSheet(q) { $(q).hidden = false; }
function closeSheets() { $$('.sheet').forEach((s) => (s.hidden = true)); }
$$('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s || e.target.matches('[data-close]')) closeSheets(); }));

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200);
}

$('#placeBtn').onclick = async () => {
  const opts = $('#placeOptions');
  const mk = (label, sub, on, thumb, fn) => {
    const b = document.createElement('button');
    b.className = 'opt' + (on ? ' on' : '');
    b.innerHTML = `<span class="thumb">${thumb}</span><span><b>${esc(label)}</b><br><span class="muted small">${esc(sub)}</span></span>`;
    b.onclick = fn;
    opts.append(b);
    return b;
  };
  opts.innerHTML = '';
  mk('My location', state.gps ? state.gps.name : 'Uses GPS', state.place.type === 'gps', '◉', () => choosePlace({ type: 'gps' }));
  for (const s of state.spots) {
    const b = mk(s.name, `${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}`, state.place.type === 'spot' && state.place.id === s.id, '⌖', () => choosePlace({ type: 'spot', id: s.id }));
    photoOf(s).then((p) => { if (p) { const th = $('.thumb', b); th.style.backgroundImage = `url(${p})`; th.textContent = ''; } });
  }
  mk('Add a spot…', 'Pin a new location', false, '＋', () => { closeSheets(); openSpotEditor(); });
  openSheet('#placeSheet');
};
function choosePlace(p) {
  state.place = p; savePlace(); closeSheets();
  location.hash = '#now';
  loadNow();
}

function fillSettings() {
  const s = state.settings;
  $('#setUnit').value = s.unit;
  $('#setWind').value = Math.round(uConv(s.wind));
  $('#setGust').value = Math.round(uConv(s.gust));
  $('#setRain').value = s.rain;
  $('#setProb').value = s.prob;
  $('#setDaylight').checked = s.daylight;
  $$('.unit-l').forEach((e) => (e.textContent = uLabel()));
}
$('#settingsBtn').onclick = () => { fillSettings(); openSheet('#settingsSheet'); };
$('#setUnit').onchange = () => {
  // keep thresholds, re-display in the new unit
  const k = UNIT[state.settings.unit][1];
  const wind = +$('#setWind').value / k, gust = +$('#setGust').value / k;
  state.settings.unit = $('#setUnit').value;
  state.settings.wind = wind; state.settings.gust = gust;
  fillSettings();
};
$('#settingsSave').onclick = () => {
  const k = UNIT[state.settings.unit][1], s = state.settings;
  s.wind = clamp(+$('#setWind').value || DEFAULT_SETTINGS.wind * k, 1, 300) / k;
  s.gust = clamp(+$('#setGust').value || DEFAULT_SETTINGS.gust * k, 1, 300) / k;
  s.rain = clamp(+$('#setRain').value, 0, 50);
  s.prob = clamp(+$('#setProb').value, 0, 100);
  s.daylight = $('#setDaylight').checked;
  saveSettings(); closeSheets(); route();
};
$('#exportBtn').onclick = async () => {
  const photos = {};
  for (const s of state.spots) { const p = await photoOf(s); if (p) photos[s.id] = p; }
  const blob = new Blob([JSON.stringify({ app: 'fpv-weather', v: 1, spots: state.spots, photos, settings: state.settings })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fpv-spots-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!Array.isArray(j.spots)) throw new Error();
    let n = 0;
    for (const s of j.spots) {
      if (typeof s.lat !== 'number' || typeof s.lon !== 'number' || !s.id) continue;
      const clean = { id: String(s.id), name: String(s.name || 'Spot').slice(0, 60), lat: s.lat, lon: s.lon, notes: String(s.notes || ''), created: s.created || Date.now(), hasPhoto: false };
      const p = j.photos && j.photos[s.id];
      if (typeof p === 'string' && p.startsWith('data:image/')) { await idb.put(clean.id, p); clean.hasPhoto = true; state.photos.set(clean.id, p); }
      const i = state.spots.findIndex((x) => x.id === clean.id);
      if (i >= 0) state.spots[i] = clean; else state.spots.push(clean);
      n++;
    }
    saveSpots(); updateRadarMarkers();
    toast(`Imported ${n} spot${n === 1 ? '' : 's'}`);
    closeSheets(); route();
  } catch { toast('That file is not a spots export'); }
};

/* ---------------- routing ---------------- */
$$('.tabs button').forEach((b) => (b.onclick = () => (location.hash = '#' + b.dataset.view)));
$$('#rangeSeg button').forEach((b) => (b.onclick = () => {
  state.range = +b.dataset.range; LS.set('fpvw:range', state.range);
  $$('#rangeSeg button').forEach((x) => x.classList.toggle('on', x === b));
  if (nowData) drawNowChart();
}));
$$('#rangeSeg button').forEach((x) => x.classList.toggle('on', +x.dataset.range === state.range));
$('#addSpotBtn').onclick = () => openSpotEditor();
$('#backBtn').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#spots'));
$('#editSpotBtn').onclick = () => detailSpot && openSpotEditor(detailSpot);
$('#useAsNowBtn').onclick = () => detailSpot && choosePlace({ type: 'spot', id: detailSpot.id });
$('#showOnRadarBtn').onclick = () => {
  if (!detailSpot) return;
  const s = detailSpot;
  location.hash = '#radar';
  setTimeout(() => radar.map && radar.map.setView([s.lat, s.lon], 9), 50);
};
$('#refreshBtn').onclick = async () => {
  const b = $('#refreshBtn'); b.style.transition = 'transform .6s'; b.style.transform = 'rotate(360deg)';
  setTimeout(() => { b.style.transition = ''; b.style.transform = ''; }, 650);
  mem.clear();
  Object.keys(localStorage).filter((k) => k.startsWith('fpvw:wx:')).forEach((k) => {
    const v = LS.get(k); if (v) { v.fetched = 0; LS.set(k, v); }
  });
  radar.loadedAt = 0;
  route(true);
};

function route(force = false) {
  const h = location.hash || '#now';
  let view = h.slice(1).split('/')[0] || 'now';
  if (!['now', 'spots', 'spot', 'radar'].includes(view)) view = 'now';
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === (view === 'spot' ? 'spots' : view)));
  $('.top').hidden = view === 'spot';
  if (view !== 'radar') stopRadar();
  if (view === 'now') { if (force || !nowData || nowSec() - nowData.fetched > MAX_AGE) loadNow(force); else renderNow(); }
  if (view === 'spots') renderSpots();
  if (view === 'spot') renderDetail(h.split('/')[1]);
  if (view === 'radar') initRadar();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => route());
document.addEventListener('visibilitychange', () => { if (!document.hidden) route(); });
let rzT;
window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { if (nowData && $('#view-now').classList.contains('active')) drawNowChart(); }, 200); });
window.openSpotEditor = openSpotEditor;

route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
