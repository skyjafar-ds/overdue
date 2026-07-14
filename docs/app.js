/* overdue — the atlas. Vanilla JS, no dependencies, no map library.
   The map engine snaps every vehicle onto its line's geometry and moves it
   by arc length with capped dead reckoning, so trains ride their rails
   fluidly at all times — never hopping, never floating beside the track.
   Live: MBTA v3 + BART legacy (both CORS-open). The Record/Ledger/Almanac
   read JSONs the observatory commits after every burst. */

"use strict";

const MBTA = "https://api-v3.mbta.com";
const BART = "https://api.bart.gov/api";
const BART_KEY = "MW9S-E7SL-26DU-VV8V";
const RAIL_ROUTES = ["Red", "Orange", "Blue", "Mattapan", "Green-B", "Green-C", "Green-D", "Green-E"];
const REFRESH_S = 20;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtClock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const state = {
  routes: {}, paths: [], stations: [], mbtaStops: {}, stopName: {},
  stationStats: {}, summary: null, days: [],
  pins: new Set(JSON.parse(localStorage.getItem("overdue-pins") || "[]")),
  boards: [], trains: new Map(), mode: "live",
  replay: null, replayTimer: null, mpp: 1, proj: null,
};

/* ---------------- masthead ---------------- */
(function masthead() {
  const saved = localStorage.getItem("overdue-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  const btn = $("#theme-toggle");
  const label = () =>
    (btn.textContent = document.documentElement.dataset.theme === "dark" ? "Day edition" : "Evening edition");
  label();
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "" : "dark";
    if (next) document.documentElement.dataset.theme = next;
    else delete document.documentElement.dataset.theme;
    localStorage.setItem("overdue-theme", next);
    label();
  });
  const d = new Date();
  const h = d.getHours();
  const edition = h < 5 ? "Night Edition" : h < 11 ? "Morning Edition" : h < 17 ? "Midday Edition" : "Evening Edition";
  $("#dateline").textContent =
    d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) +
    ` · ${edition}`;
  addEventListener("scroll", () => $("#masthead").classList.toggle("scrolled", scrollY > 8), { passive: true });
})();

/* ---------------- reveals ---------------- */
const io = new IntersectionObserver(
  (es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")),
  { threshold: 0.1 }
);
$$(".reveal").forEach((el) => io.observe(el));

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ================= GEOMETRY ================= */

class PolyPath {
  constructor(pts) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      this.cum.push(this.cum[i - 1] + Math.hypot(dx, dy));
    }
    this.len = this.cum[this.cum.length - 1];
  }
  pointAt(s) {
    s = Math.max(0, Math.min(this.len, s));
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid; else hi = mid;
    }
    const seg = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / seg;
    const a = this.pts[lo], b = this.pts[hi];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  project(x, y) {
    let best = { d2: Infinity, s: 0 };
    for (let i = 1; i < this.pts.length; i++) {
      const [ax, ay] = this.pts[i - 1], [bx, by] = this.pts[i];
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy || 1;
      let t = ((x - ax) * dx + (y - ay) * dy) / L2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t, py = ay + dy * t;
      const d2 = (x - px) ** 2 + (y - py) ** 2;
      if (d2 < best.d2) best = { d2, s: this.cum[i - 1] + Math.sqrt(L2) * t };
    }
    return best;
  }
}

function project(all) {
  const lats = all.map((p) => p.lat), lons = all.map((p) => p.lon);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  const kc = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
  const W = 1000, H = 760, PAD = 46;
  const s = Math.min((W - 2 * PAD) / ((lonMax - lonMin) * kc), (H - 2 * PAD) / (latMax - latMin));
  const ox = (W - (lonMax - lonMin) * kc * s) / 2, oy = (H - (latMax - latMin) * s) / 2;
  state.mpp = 111_320 / s; // meters per pixel (1° latitude ≈ 111.32 km)
  return (lat, lon) => [ox + (lon - lonMin) * kc * s, H - oy - (lat - latMin) * s];
}

/* ================= THE MAP ================= */

async function buildMap() {
  const svg = $("#map");
  const routes = await jget(`${MBTA}/routes?filter[type]=0,1&fields[route]=color,long_name,direction_destinations`);
  for (const r of routes.data)
    state.routes[r.id] = {
      color: `#${r.attributes.color}`,
      name: r.id.startsWith("Green") ? r.id.replace("-", " ") : r.attributes.long_name.replace(" Line", ""),
      destinations: r.attributes.direction_destinations,
    };
  const pat = await jget(
    `${MBTA}/route_patterns?filter[route]=${RAIL_ROUTES.join(",")}&include=representative_trip.stops` +
    `&fields[stop]=latitude,longitude,name,wheelchair_boarding&fields[route_pattern]=typicality,direction_id`
  );
  const stops = {}, trips = {};
  for (const x of pat.included || []) {
    if (x.type === "stop") stops[x.id] = x;
    if (x.type === "trip") trips[x.id] = x;
  }
  const patterns = [];
  const stationByName = new Map();
  for (const p of pat.data) {
    if (p.attributes.typicality !== 1) continue;
    const route = p.relationships.route.data.id;
    const trip = trips[p.relationships.representative_trip.data?.id];
    const ids = (trip?.relationships.stops.data || []).map((s) => s.id).filter((id) => stops[id]);
    if (ids.length < 2) continue;
    const seq = ids.map((id) => ({
      id, lat: stops[id].attributes.latitude, lon: stops[id].attributes.longitude,
      name: stops[id].attributes.name, acc: stops[id].attributes.wheelchair_boarding,
    }));
    patterns.push({ route, dir: p.attributes.direction_id, seq });
    for (const pt of seq) {
      state.stopName[pt.id] = pt.name;
      const st = stationByName.get(pt.name) || { ...pt, routes: new Set(), ids: [] };
      st.routes.add(route);
      st.ids.push(pt.id);
      stationByName.set(pt.name, st);
    }
  }
  const all = [...stationByName.values()];
  state.mbtaStops = Object.fromEntries(all.map((s) => [s.name, s]));
  const proj = (state.proj = project(all));

  let rails = "", casings = "";
  for (const p of patterns) {
    const xy = p.seq.map((pt) => proj(pt.lat, pt.lon));
    const path = new PolyPath(xy);
    const stopsOnPath = p.seq.map((pt, i) => ({ name: pt.name, s: path.cum[i] }));
    state.paths.push({ route: p.route, dir: p.dir, path, stops: stopsOnPath });
    const d = xy.map((q, i) => `${i ? "L" : "M"}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");
    casings += `<path class="rail-casing" d="${d}" stroke-width="7"/>`;
    rails += `<path class="rail" data-route="${p.route}" d="${d}" stroke="${state.routes[p.route].color}" stroke-width="3.4"><title>${state.routes[p.route].name} Line</title></path>`;
  }
  const stns = all
    .map((s) => {
      const [x, y] = proj(s.lat, s.lon);
      return `<circle class="stn" data-name="${esc(s.name)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.routes.size > 1 ? 5 : 3.2}"/>`;
    })
    .join("");
  svg.innerHTML = `<g id="g-rails">${casings}${rails}</g><g id="g-trains"></g><g id="g-stns">${stns}</g>`;

  svg.addEventListener("mouseover", (e) => {
    const rail = e.target.closest(".rail");
    if (rail) dimExcept(rail.dataset.route);
    const stn = e.target.closest(".stn");
    if (stn) showStationPanel(stn);
    const train = e.target.closest(".train");
    if (train) dimExcept(train.dataset.route);
  });
  svg.addEventListener("mouseout", (e) => {
    if (e.target.closest(".rail") || e.target.closest(".train")) dimExcept(null);
  });
  svg.addEventListener("click", (e) => {
    const train = e.target.closest(".train");
    if (train) showTrainPanel(train.dataset.vid);
  });
  svg.addEventListener("mouseleave", hidePanel);

  await refreshVehicles();
  setInterval(() => state.mode === "live" && refreshVehicles(), REFRESH_S * 1000);
  requestAnimationFrame(animate);
}

function dimExcept(route) {
  for (const el of $$("#map .rail, #map .train"))
    el.style.opacity = !route || el.dataset.route === route ? "" : "0.14";
}

function snap(route, x, y) {
  let best = null;
  for (const p of state.paths) {
    if (p.route !== route) continue;
    const pr = p.path.project(x, y);
    if (!best || pr.d2 < best.d2) best = { ...pr, pattern: p };
  }
  return best;
}

function makeTrainEl(vid, route) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  el.setAttribute("class", "train");
  el.dataset.route = route;
  el.dataset.vid = vid;
  el.setAttribute("r", "4.6");
  el.setAttribute("fill", state.routes[route]?.color || "#555");
  el.setAttribute("stroke", "var(--paper2)");
  el.setAttribute("stroke-width", "1.4");
  $("#g-trains").append(el);
  return el;
}

async function refreshVehicles() {
  try {
    const j = await jget(
      `${MBTA}/vehicles?filter[route]=${RAIL_ROUTES.join(",")}` +
      `&fields[vehicle]=latitude,longitude,direction_id,current_status,updated_at&page[limit]=300`
    );
    $("#t-trains").textContent = j.data.length;
    const seen = new Set();
    const now = performance.now();
    for (const v of j.data) {
      const route = v.relationships.route.data?.id;
      const [x, y] = state.proj(v.attributes.latitude, v.attributes.longitude);
      const hit = snap(route, x, y);
      if (!hit) continue;
      seen.add(v.id);
      let t = state.trains.get(v.id);
      if (!t || t.pattern.route !== route || Math.abs(hit.s - t.s) > 260) {
        // new train, or a reassignment: place it, no artificial glide
        if (!t) t = { el: makeTrainEl(v.id, route) };
        Object.assign(t, { pattern: hit.pattern, s: hit.s, sFrom: hit.s, sTarget: hit.s, t0: now });
        state.trains.set(v.id, t);
      } else {
        t.sFrom = t.s;             // rebase from wherever the glide reached
        t.sTarget = hit.s;
        t.t0 = now;
        if (hit.pattern !== t.pattern) t.pattern = hit.pattern;
      }
      t.meta = {
        route, dir: v.attributes.direction_id, status: v.attributes.current_status,
        updated: v.attributes.updated_at,
        speed: Math.abs(t.sTarget - t.sFrom) * state.mpp / REFRESH_S,
      };
    }
    for (const [vid, t] of state.trains)
      if (!seen.has(vid)) { t.el.remove(); state.trains.delete(vid); }
    $("#live-mark").textContent = "live";
  } catch {
    $("#live-mark").textContent = "feed unreachable — retrying";
  }
}

/* One clock moves everything: linear glide to the last-known target with
   25% dead-reckoning past it, so trains never freeze and never jump. */
function animate(now) {
  for (const t of state.trains.values()) {
    const dur = (t.dur || REFRESH_S) * 1000;
    const u = Math.min(1.25, (now - t.t0) / dur);
    t.s = t.sFrom + (t.sTarget - t.sFrom) * (reduced ? Math.min(1, u) : u);
    const [x, y] = t.pattern.path.pointAt(t.s);
    t.el.setAttribute("cx", x.toFixed(1));
    t.el.setAttribute("cy", y.toFixed(1));
  }
  requestAnimationFrame(animate);
}

/* ---------------- panels ---------------- */
let panelToken = 0;
function placePanel(clientX, clientY) {
  const panel = $("#map-panel");
  const plate = panel.closest(".plate").getBoundingClientRect();
  panel.style.left = Math.min(plate.width - 330, Math.max(8, clientX - plate.left + 14)) + "px";
  panel.style.top = Math.max(8, clientY - plate.top - 10) + "px";
  panel.classList.add("show");
  return panel;
}
function hidePanel() { $("#map-panel").classList.remove("show"); }

async function showStationPanel(circle) {
  const name = circle.dataset.name;
  const st = state.mbtaStops[name];
  if (!st) return;
  const token = ++panelToken;
  const c = circle.getBoundingClientRect();
  const panel = placePanel(c.left, c.top);
  const marks = [...st.routes]
    .map((r) => `<span class="line-mark" style="--lc:${state.routes[r].color}">${r.startsWith("Green") ? r.slice(-1) : r[0]}</span>`)
    .join(" ");
  const rec = st.ids.map((id) => state.stationStats[`mbta:${id}`]).find(Boolean);
  const hist = rec
    ? `keeps ${Math.round(rec.within_1min * 100)}% of promises · median miss ${rec.median_err} min · n=${rec.n}`
    : "record accruing for this station";
  panel.innerHTML = `<h4>${esc(name)}</h4>
    <div class="hist">${marks}${st.acc === 1 ? " · step-free" : ""}</div>
    <div class="hist">${hist}</div><div class="rows"><em>listening…</em></div>`;
  try {
    const j = await jget(`${MBTA}/predictions?filter[stop]=${st.ids.join(",")}&sort=arrival_time&page[limit]=4&include=route`);
    if (token !== panelToken) return;
    const rows = j.data
      .map((p) => {
        const t = p.attributes.arrival_time || p.attributes.departure_time;
        if (!t) return "";
        const mins = Math.max(0, (Date.parse(t) - Date.now()) / 60000);
        const route = p.relationships.route.data?.id;
        return `<div class="row"><span class="line-mark" style="--lc:${state.routes[route]?.color || "#555"}">${route?.startsWith("Green") ? route.slice(-1) : route?.[0] || "?"}</span><span class="due">${mins < 0.75 ? "due" : mins.toFixed(0) + " min"}</span></div>`;
      })
      .filter(Boolean).join("");
    $(".rows", panel).innerHTML = rows || "<em>no arrivals posted</em>";
  } catch { if (token === panelToken) $(".rows", panel).innerHTML = "<em>board unavailable</em>"; }
}

function showTrainPanel(vid) {
  const t = state.trains.get(vid);
  if (!t?.meta) return;
  panelToken++;
  const rect = t.el.getBoundingClientRect();
  const panel = placePanel(rect.left, rect.top);
  const m = t.meta;
  const heading = state.routes[m.route]?.destinations?.[m.dir] || "—";
  const dirSign = t.pattern.dir === m.dir ? 1 : -1;
  const ahead = t.pattern.stops.filter((s) => (dirSign > 0 ? s.s > t.s + 4 : s.s < t.s - 4));
  const behind = t.pattern.stops.filter((s) => (dirSign > 0 ? s.s <= t.s + 4 : s.s >= t.s - 4));
  const next = dirSign > 0 ? ahead[0] : ahead[ahead.length - 1];
  const prev = dirSign > 0 ? behind[behind.length - 1] : behind[0];
  const status = { STOPPED_AT: "stopped at", INCOMING_AT: "arriving at", IN_TRANSIT_TO: "in transit to" }[m.status] || "riding";
  const lineRec = state.summary?.agencies?.mbta?.routes?.[m.route];
  const punct = lineRec ? `${Math.round(lineRec.within_1min * 100)}% of promises kept (median miss ${lineRec.median_abs_err} min)` : "record accruing";
  const kmh = m.speed > 0.4 ? (m.speed * 3.6).toFixed(0) : "0";
  panel.innerHTML = `<h4><span class="line-mark" style="--lc:${state.routes[m.route]?.color}">${m.route.startsWith("Green") ? m.route.slice(-1) : m.route[0]}</span>
      &nbsp;${esc(state.routes[m.route]?.name || m.route)} Line · to ${esc(heading)}</h4>
    <div class="kv"><span>now</span><b>${status} ${esc(next?.name || "terminus")}</b></div>
    <div class="kv"><span>previous</span><b>${esc(prev?.name || "—")}</b></div>
    <div class="kv"><span>observed speed</span><b>≈ ${kmh} km/h</b></div>
    <div class="kv"><span>line's record</span><b>${punct}</b></div>
    <div class="kv"><span>feed updated</span><b>${m.updated ? Math.max(0, Math.round((Date.now() - Date.parse(m.updated)) / 1000)) + " s ago" : "—"}</b></div>`;
}

/* ---------------- heartbeat ---------------- */
async function renderHeartbeat() {
  try {
    const j = await jget(`${MBTA}/alerts?filter[route_type]=0,1&filter[datetime]=NOW&fields[alert]=severity,informed_entity,effect`);
    const strain = {};
    for (const a of j.data)
      for (const ie of a.attributes.informed_entity || [])
        if (ie.route) strain[ie.route.startsWith("Green") ? "Green" : ie.route] =
          Math.max(strain[ie.route.startsWith("Green") ? "Green" : ie.route] || 0, a.attributes.severity);
    const lines = [["Red", "Red"], ["Orange", "Orange"], ["Blue", "Blue"], ["Green", "Green-B"]];
    $("#heartbeat").innerHTML = lines
      .map(([label, key]) => {
        const sev = strain[label] || 0;
        const cls = sev >= 5 ? "strained" : "calm";
        return `<span class="hb ${cls}" title="${label} Line ${sev ? `· alert severity ${sev}` : "· running quietly"}"><i style="--hc:${state.routes[key]?.color || "#888"}"></i>${label[0]}</span>`;
      })
      .join("");
    $("#t-alerts").textContent = j.data.length;
    $("#t-alerts-note").textContent = j.data.length ? "see the heartbeat by the map" : "no notes — a clean sheet";
  } catch { /* chips absent */ }
}

/* ---------------- replay ---------------- */
async function setMode(mode) {
  state.mode = mode;
  $("#mode-live").setAttribute("aria-selected", String(mode === "live"));
  $("#mode-replay").setAttribute("aria-selected", String(mode === "replay"));
  $("#replay-tools").hidden = mode !== "replay";
  if (mode === "replay" && !state.replay) {
    try {
      state.replay = await jget("data/replay.json");
      $("#replay-slider").max = state.replay.bins - 1;
      $("#map-caption").textContent =
        `replaying from ${new Date(state.replay.start * 1000).toLocaleString()} · observed in bursts, gaps interpolated`;
    } catch {
      $("#map-caption").textContent = "the replay archive publishes with the observatory's next runs";
      return;
    }
  }
  for (const [vid, t] of state.trains) { t.el.remove(); state.trains.delete(vid); }
  if (mode === "replay") renderReplayBin(+$("#replay-slider").value, true);
  else { stopReplay(); refreshVehicles(); }
}
function stopReplay() {
  clearInterval(state.replayTimer);
  state.replayTimer = null;
  $("#replay-play").textContent = "▶";
}
function renderReplayBin(bin, jump = false) {
  const rp = state.replay;
  if (!rp) return;
  $("#replay-clock").textContent = fmtClock(rp.start + bin * rp.bin_s);
  const now = performance.now();
  const seen = new Set();
  for (const [vid, v] of Object.entries(rp.vehicles)) {
    let best = null;
    for (const [b, lat, lon] of v.pts) {
      if (b <= bin) best = [b, lat, lon];
      else break;
    }
    if (!best || bin - best[0] > 5) continue;
    const [x, y] = state.proj(best[1], best[2]);
    const hit = snap(v.route, x, y);
    if (!hit) continue;
    seen.add("r" + vid);
    let t = state.trains.get("r" + vid);
    if (!t || jump || hit.pattern !== t.pattern) {
      if (!t) t = { el: makeTrainEl("r" + vid, v.route) };
      Object.assign(t, { pattern: hit.pattern, s: hit.s, sFrom: hit.s, sTarget: hit.s, t0: now, dur: 0.14 });
      state.trains.set("r" + vid, t);
    } else {
      t.sFrom = t.s; t.sTarget = hit.s; t.t0 = now; t.dur = 0.15;
    }
  }
  for (const [vid, t] of state.trains)
    if (!seen.has(vid)) { t.el.remove(); state.trains.delete(vid); }
}
$("#mode-live").addEventListener("click", () => setMode("live"));
$("#mode-replay").addEventListener("click", () => setMode("replay"));
$("#replay-slider").addEventListener("input", (e) => renderReplayBin(+e.target.value, true));
$("#replay-play").addEventListener("click", () => {
  if (state.replayTimer) return stopReplay();
  $("#replay-play").textContent = "❚❚";
  state.replayTimer = setInterval(() => {
    const s = $("#replay-slider");
    s.value = (+s.value + 1) % (+s.max + 1);
    renderReplayBin(+s.value);
  }, 150);
});

/* ================= BOARDS (unchanged grammar) ================= */

async function loadBartStations() {
  try {
    const j = await jget(`${BART}/stn.aspx?cmd=stns&key=${BART_KEY}&json=y`);
    for (const s of j.root.stations.station)
      state.stations.push({ key: `bart:${s.abbr}`, agency: "bart", id: s.abbr, name: s.name });
  } catch { /* finder lacks BART */ }
}
function mbtaFinderStations() {
  for (const [name, st] of Object.entries(state.mbtaStops))
    state.stations.push({ key: `mbta:${name}`, agency: "mbta", id: st.ids.join(","), name });
}

async function boardArrivals(entry) {
  if (entry.agency === "mbta") {
    const j = await jget(`${MBTA}/predictions?filter[stop]=${entry.id}&sort=arrival_time&page[limit]=12&include=route,trip`);
    const inc = {};
    for (const x of j.included || []) inc[`${x.type}:${x.id}`] = x;
    const out = [];
    for (const p of j.data) {
      const t = p.attributes.arrival_time || p.attributes.departure_time;
      if (!t) continue;
      const route = p.relationships.route.data?.id;
      const trip = inc[`trip:${p.relationships.trip.data?.id}`];
      out.push({
        ts: Date.parse(t) / 1000,
        mark: route?.startsWith("Green") ? route.slice(-1) : route?.[0] || "?",
        color: state.routes[route]?.color || "#555",
        dest: trip?.attributes.headsign || state.routes[route]?.destinations?.[p.attributes.direction_id] || "",
        delayed: p.attributes.status === "Delayed",
      });
      if (out.length >= 5) break;
    }
    return out;
  }
  const j = await jget(`${BART}/etd.aspx?cmd=etd&orig=${entry.id}&key=${BART_KEY}&json=y`);
  const out = [];
  for (const e of j.root.station?.[0]?.etd || [])
    for (const est of e.estimate) {
      const mins = est.minutes === "Leaving" ? 0 : parseInt(est.minutes, 10);
      if (Number.isNaN(mins)) continue;
      out.push({ ts: Date.now() / 1000 + mins * 60, mark: est.color[0], color: est.hexcolor,
                 dest: e.destination, delayed: parseInt(est.delay, 10) > 60 });
    }
  return out.sort((a, b) => a.ts - b.ts).slice(0, 5);
}

function boardKeys() {
  const pinned = [...state.pins];
  const rest = state.boards.filter((k) => !state.pins.has(k));
  return [...pinned, ...rest].slice(0, 6);
}

async function renderBoards() {
  const grid = $("#boards-grid");
  const keys = boardKeys();
  if (!keys.length) {
    grid.innerHTML = `<div class="board"><div class="board-empty">Find a station above to open its board.</div></div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  await Promise.all(keys.map(async (key) => {
    const entry = state.stations.find((s) => s.key === key);
    if (!entry) return;
    const el = document.createElement("article");
    el.className = "board reveal in";
    let rows;
    try {
      const arr = await boardArrivals(entry);
      rows = arr.length
        ? `<table class="tt"><tbody>` + arr.map((a) =>
            `<tr data-ts="${a.ts}" class="${a.delayed ? "delayed" : ""}">
              <td><span class="line-mark" style="--lc:${a.color}">${esc(a.mark)}</span></td>
              <td class="dest">${esc(a.dest)}</td>
              <td class="due"><span class="due-n">—</span></td></tr>`).join("") + `</tbody></table>`
        : `<div class="board-empty">No arrivals posted — a quiet platform.</div>`;
    } catch { rows = `<div class="board-empty">Board unavailable; the feed will return.</div>`; }
    const pinned = state.pins.has(key);
    el.innerHTML = `<header><h3>${esc(entry.name)}</h3><span class="agency">${entry.agency}</span>
      <button class="pin-btn ${pinned ? "pinned" : ""}" data-key="${key}">${pinned ? "pinned ●" : "pin ○"}</button></header>
      ${rows}<div class="foot"><span>refreshes every 35 s</span><span class="mono">${entry.agency === "mbta" ? "MBTA v3" : "BART etd"}</span></div>`;
    frag.append(el);
  }));
  grid.replaceChildren(frag);
  tickBoards();
}

function tickBoards() {
  const now = Date.now() / 1000;
  for (const tr of $$(".tt tr")) {
    const mins = Math.max(0, (parseFloat(tr.dataset.ts) - now) / 60);
    $(".due-n", tr).innerHTML =
      mins < 0.75 ? "due" : `${mins < 10 ? mins.toFixed(1) : Math.round(mins)}<span class="unit">min</span>`;
    tr.classList.toggle("imminent", mins <= 2 && !tr.classList.contains("delayed"));
  }
}
setInterval(tickBoards, 1000);

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".pin-btn");
  if (!btn) return;
  const key = btn.dataset.key;
  if (state.pins.has(key)) state.pins.delete(key);
  else state.pins.add(key);
  localStorage.setItem("overdue-pins", JSON.stringify([...state.pins]));
  renderBoards();
});

/* finder */
const finder = $("#finder"), results = $("#finder-results");
let sel = -1;
function score(q, name) {
  q = q.toLowerCase(); name = name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  let i = 0;
  for (const ch of name) if (ch === q[i]) i++;
  return i === q.length ? 2 : -1;
}
finder.addEventListener("input", () => {
  const q = finder.value.trim();
  if (!q) { results.hidden = true; return; }
  const hits = state.stations
    .map((s) => ({ s, sc: score(q, s.name) })).filter((x) => x.sc >= 0)
    .sort((a, b) => a.sc - b.sc || a.s.name.length - b.s.name.length).slice(0, 8);
  sel = hits.length ? 0 : -1;
  results.innerHTML = hits
    .map((x, i) => `<button role="option" aria-selected="${i === sel}" data-key="${x.s.key}">${esc(x.s.name)}<span class="agency">${x.s.agency.toUpperCase()}</span></button>`)
    .join("");
  results.hidden = !hits.length;
});
finder.addEventListener("keydown", (e) => {
  const opts = $$("button", results);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === sel)));
  } else if (e.key === "Enter" && opts[sel]) openBoard(opts[sel].dataset.key);
  else if (e.key === "Escape") results.hidden = true;
});
results.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) openBoard(b.dataset.key);
});
function openBoard(key) {
  if (!state.boards.includes(key)) state.boards.unshift(key);
  finder.value = ""; results.hidden = true;
  renderBoards();
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".finder")) results.hidden = true;
});
addEventListener("keydown", (e) => {
  if ((e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey))) && document.activeElement !== finder) {
    e.preventDefault();
    finder.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    finder.focus();
  }
});

/* ================= THE RECORD ================= */

function calibrationFig(horizons) {
  const W = 480, H = 240, L = 44, B = 206, T = 14, R = 462;
  const maxH = Math.max(...horizons.map((d) => d.h));
  const maxW = Math.max(...horizons.map((d) => d.mean_wait), maxH) * 1.06;
  const x = (v) => L + ((R - L) * v) / maxH, y = (v) => B - ((B - T) * v) / maxW;
  const pts = horizons.map((d) => `${x(d.h).toFixed(1)},${y(d.mean_wait).toFixed(1)}`).join(" ");
  return `<svg class="fig-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Promised versus actual wait">
    <line class="axis" x1="${L}" y1="${B}" x2="${R}" y2="${B}"/><line class="axis" x1="${L}" y1="${T}" x2="${L}" y2="${B}"/>
    <polyline class="ideal" points="${x(0)},${y(0)} ${x(maxH)},${y(maxH)}"/>
    <polyline class="curve" points="${pts}"/>
    ${horizons.map((d) => `<circle class="dot" r="3" cx="${x(d.h).toFixed(1)}" cy="${y(d.mean_wait).toFixed(1)}"><title>said ${d.h} min → waited ${d.mean_wait} min (n=${d.n})</title></circle>`).join("")}
    <text x="${L + 4}" y="${T + 2}">actual wait, min</text>
    <text x="${R}" y="${B + 20}" text-anchor="end">promised, min</text>
    <text x="${x(maxH) - 6}" y="${y(maxH) + 12}" text-anchor="end">the diagonal is honesty</text>
  </svg>`;
}

async function renderRecord() {
  const body = $("#record-body");
  const names = { mbta: "The MBTA", bart: "BART", caltrain: "Caltrain" };
  try {
    const [summary, fresh] = await Promise.all([jget("data/summary.json"), jget("data/freshness.json")]);
    state.summary = summary;
    const cards = [];
    for (const [id, b] of Object.entries(summary.agencies || {})) {
      if (!b.n_promises) continue;
      const grade = (v, g, w) => (v <= g ? "good" : v <= w ? "" : "warn");
      cards.push(`<div class="story reveal in">
        <h3>${names[id] || id}</h3>
        <p class="lede">${b.n_arrivals.toLocaleString()} arrivals inferred · ${b.n_promises.toLocaleString()} promises graded · coverage ${(b.coverage * 100).toFixed(0)}%</p>
        <div class="figures">
          <div class="figure"><div class="n ${grade(b.median_abs_err, 0.75, 1.5)}">${b.median_abs_err.toFixed(2)}<small>m</small></div><div class="k">median error</div></div>
          <div class="figure"><div class="n ${grade(Math.abs(b.bias), 0.5, 1.25)}">${b.bias > 0 ? "+" : ""}${b.bias.toFixed(2)}<small>m</small></div><div class="k">bias · + means you wait</div></div>
          <div class="figure"><div class="n">${(b.within_1min * 100).toFixed(0)}%</div><div class="k">within one minute</div></div>
        </div>
        ${b.horizons?.length >= 3 ? calibrationFig(b.horizons) : `<p class="lede">The calibration curve is drawing itself — longer promises take longer to grade.</p>`}
      </div>`);
    }
    body.innerHTML = cards.join("") || `<div class="story"><p class="lede">The record opens with the observatory's first committed run.</p></div>`;
    const when = new Date((fresh.last_burst || fresh.built) * 1000);
    $("#record-foot").textContent =
      `Method: arrivals inferred from promise-stream convergence and disappearance; only arrivals with ≤120 s uncertainty are graded. ` +
      `Last observation ${when.toLocaleString()} · the ledger is append-only and public.`;
    $("#t-graded").textContent = (fresh.n_resolutions_window || 0).toLocaleString();
    const mbta = summary.agencies?.mbta;
    if (mbta?.median_abs_err != null) $("#t-err").innerHTML = `${mbta.median_abs_err.toFixed(2)}<small> min</small>`;
    if (fresh.today?.n_promises) $("#t-promises").innerHTML = `${fresh.today.n_promises.toLocaleString()}<small> graded</small>`;
  } catch {
    body.innerHTML = `<div class="story"><p class="lede">The record hasn't been published yet.</p></div>`;
  }
}

/* ================= THE LEDGER ================= */
async function renderLedger() {
  try {
    const cards = await jget("data/promises.json");
    $("#ledger").innerHTML = cards.slice(0, 12).map((c) => {
      const where = state.stopName[c.stop] || (c.agency === "bart" ? `BART · ${c.stop}` : `stop ${c.stop}`);
      const line = c.agency === "mbta" ? (state.routes[c.route]?.name || c.route) : "BART";
      return `<div class="promise reveal in">
        <div class="head"><span class="where">${esc(where)}</span>
          <span class="verdict ${c.kept ? "kept" : "broken"}">${c.kept ? "kept" : "broken"}</span></div>
        <div class="kv"><span>line</span><b>${esc(line)}</b></div>
        <div class="kv"><span>issued</span><b>${fmtClock(c.issued)}</b></div>
        <div class="kv"><span>swore</span><b>${c.promised_min} min → ${fmtClock(c.predicted)}</b></div>
        <div class="kv"><span>reality</span><b>${fmtClock(c.actual)}${c.err_min > 0 ? ` · ${c.err_min}m late` : c.err_min < 0 ? ` · ${Math.abs(c.err_min)}m early` : " · on the dot"}</b></div>
      </div>`;
    }).join("");
  } catch {
    $("#ledger").innerHTML = `<p class="deck">The ledger publishes with the observatory's next run.</p>`;
  }
}

/* ================= ALMANAC ================= */
async function renderAlmanac() {
  try {
    const [days, summary] = await Promise.all([jget("data/days.json"), state.summary || jget("data/summary.json")]);
    state.days = days;
    const byAgency = {};
    for (const d of days) (byAgency[d.agency] ||= []).push(d);
    const names = { mbta: "MBTA", bart: "BART", caltrain: "Caltrain" };
    $("#calendars").innerHTML = Object.entries(byAgency).map(([agency, rows]) => {
      const cells = rows.map((d) => {
        const q = d.within_1min >= 0.75 ? "a" : d.within_1min >= 0.6 ? "b" : d.within_1min >= 0.45 ? "c" : "d";
        return `<button class="day-cell" data-q="${q}" data-agency="${agency}" data-day="${d.day}"
          data-tip="${d.day} · ${Math.round(d.within_1min * 100)}% kept" aria-label="Open ${d.day}"></button>`;
      }).join("");
      return `<h3 class="serif" style="margin:26px 0 4px">${names[agency] || agency}</h3><div class="calendar">${cells}</div>`;
    }).join("");

    const notes = [];
    const m = summary.agencies?.mbta, b = summary.agencies?.bart;
    if (m) {
      notes.push(`The observatory has graded <span class="num">${m.n_promises.toLocaleString()}</span> MBTA promises; the median one missed by <span class="num">${m.median_abs_err}</span> minutes.`);
      const worst = (m.horizons || []).slice().sort((x, y) => y.bias - x.bias)[0];
      if (worst) notes.push(`The least honest promise so far: <span class="num">“${worst.h} minutes,”</span> which actually means ${worst.mean_wait}.`);
      const routes = Object.entries(m.routes || {}).filter(([, r]) => r.n_promises >= 30);
      if (routes.length >= 2) {
        routes.sort((x, y) => x[1].median_abs_err - y[1].median_abs_err);
        notes.push(`Most punctual line in the record: <span class="num">${routes[0][0]}</span>. Bringing up the rear: <span class="num">${routes.at(-1)[0]}</span>.`);
      }
    }
    try {
      const fresh = await jget("data/freshness.json");
      if (fresh.today?.worst_miss != null)
        notes.push(`Today's longest broken promise so far ran <span class="num">${fresh.today.worst_miss}</span> minutes past its word.`);
      if (fresh.today?.kept_share != null)
        notes.push(`Today the network has kept <span class="num">${Math.round(fresh.today.kept_share * 100)}%</span> of its graded promises.`);
    } catch { /* fine */ }
    if (m && b) notes.push(`Coast to coast: BART's median error is <span class="num">${b.median_abs_err}</span> min to the MBTA's <span class="num">${m.median_abs_err}</span>.`);
    notes.push(`Every figure on this page is recomputable from the public ledger — <span class="num">$0</span> of infrastructure, no analyst in the loop.`);
    $("#marginalia").innerHTML = notes.map((n) => `<p>${n}</p>`).join("");
  } catch {
    $("#calendars").innerHTML = `<p class="deck">The almanac begins with the record's first full day.</p>`;
  }
}

document.addEventListener("click", (e) => {
  const cell = e.target.closest(".day-cell");
  if (!cell) return;
  const d = state.days.find((x) => x.agency === cell.dataset.agency && x.day === cell.dataset.day);
  if (!d) return;
  const diary = $("#day-diary");
  const date = new Date(d.day + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  diary.innerHTML = `<h4>${date} — ${d.agency.toUpperCase()}</h4>
    <p><span class="num">${d.n.toLocaleString()}</span> arrivals graded · kept <span class="num">${Math.round(d.within_1min * 100)}%</span> of promises ·
    median miss <span class="num">${d.median_err}</span> min · worst miss <span class="num">${d.worst_miss}</span> min ·
    busiest line in the record: <span class="num">${esc(d.busiest_route)}</span>.</p>`;
  diary.classList.add("show");
});

/* ================= boot ================= */
(async function boot() {
  await renderRecord();       // populates state.summary for train dossiers
  renderAlmanac();
  renderLedger();
  await buildMap();
  renderHeartbeat();
  setInterval(renderHeartbeat, 90_000);
  mbtaFinderStations();
  await loadBartStations();
  try { state.stationStats = await jget("data/stations.json"); } catch { /* accruing */ }
  for (const name of ["Park Street", "Harvard", "South Station"]) {
    const st = state.stations.find((s) => s.agency === "mbta" && s.name === name);
    if (st) state.boards.push(st.key);
  }
  const embr = state.stations.find((s) => s.agency === "bart" && s.name.startsWith("Embarcadero"));
  if (embr) state.boards.push(embr.key);
  renderBoards();
  setInterval(renderBoards, 35_000);
})();
