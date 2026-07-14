/* overdue — the atlas. Vanilla JS, no dependencies, no map library:
   the diagram is drawn from the MBTA's own route geometry.
   Live sources (CORS-open): MBTA v3 JSON:API; BART legacy JSON (public key).
   The Record is read from JSONs the observatory commits after every burst. */

"use strict";

const MBTA = "https://api-v3.mbta.com";
const BART = "https://api.bart.gov/api";
const BART_KEY = "MW9S-E7SL-26DU-VV8V";
const RAIL_ROUTES = ["Red", "Orange", "Blue", "Mattapan", "Green-B", "Green-C", "Green-D", "Green-E"];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = {
  routes: {}, stations: [], stationStats: {}, mbtaStops: {},
  pins: new Set(JSON.parse(localStorage.getItem("overdue-pins") || "[]")),
  boards: [], vehicles: new Map(), mode: "live",
  replay: null, replayBin: 0, replayTimer: null,
  proj: null,
};

/* ---------------- masthead ---------------- */
(function masthead() {
  const saved = localStorage.getItem("overdue-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  const btn = $("#theme-toggle");
  const label = () =>
    (btn.textContent =
      document.documentElement.dataset.theme === "dark" ? "Day edition" : "Evening edition");
  label();
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "" : "dark";
    if (next) document.documentElement.dataset.theme = next;
    else delete document.documentElement.dataset.theme;
    localStorage.setItem("overdue-theme", next);
    label();
  });
  const d = new Date();
  $("#dateline").textContent =
    d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) +
    " · an MBTA atlas & the public record of transit promises";
})();

/* ---------------- reveals ---------------- */
const io = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add("in")),
  { threshold: 0.12 }
);
$$(".reveal").forEach((el) => io.observe(el));

/* ---------------- fetch ---------------- */
async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ================= THE MAP ================= */

function project(stopsXY) {
  const lats = stopsXY.map((p) => p.lat), lons = stopsXY.map((p) => p.lon);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  const k = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
  const W = 1000, H = 760, PAD = 46;
  const sx = (W - 2 * PAD) / ((lonMax - lonMin) * k);
  const sy = (H - 2 * PAD) / (latMax - latMin);
  const s = Math.min(sx, sy);
  const ox = (W - (lonMax - lonMin) * k * s) / 2;
  const oy = (H - (latMax - latMin) * s) / 2;
  return (lat, lon) => [
    ox + (lon - lonMin) * k * s,
    H - oy - (lat - latMin) * s,
  ];
}

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
    `&fields[stop]=latitude,longitude,name,wheelchair_boarding&fields[route_pattern]=typicality`
  );
  const stops = {}, trips = {};
  for (const x of pat.included || []) {
    if (x.type === "stop") stops[x.id] = x;
    if (x.type === "trip") trips[x.id] = x;
  }
  const lines = [];
  const stationByName = new Map();
  for (const p of pat.data) {
    if (p.attributes.typicality !== 1) continue;
    const route = p.relationships.route.data.id;
    const trip = trips[p.relationships.representative_trip.data?.id];
    const ids = (trip?.relationships.stops.data || []).map((s) => s.id).filter((id) => stops[id]);
    if (ids.length < 2) continue;
    const pts = ids.map((id) => ({
      id, lat: stops[id].attributes.latitude, lon: stops[id].attributes.longitude,
      name: stops[id].attributes.name, acc: stops[id].attributes.wheelchair_boarding,
    }));
    lines.push({ route, pts });
    for (const pt of pts) {
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
  for (const ln of lines) {
    const d = ln.pts.map((p, i) => `${i ? "L" : "M"}${proj(p.lat, p.lon).map((v) => v.toFixed(1)).join(",")}`).join(" ");
    casings += `<path class="rail-casing" d="${d}" stroke-width="7"/>`;
    rails += `<path class="rail" data-route="${ln.route}" d="${d}" stroke="${state.routes[ln.route].color}" stroke-width="3.4"><title>${state.routes[ln.route].name} Line</title></path>`;
  }
  const stns = all
    .map((s) => {
      const [x, y] = proj(s.lat, s.lon);
      const major = s.routes.size > 1;
      return `<circle class="stn" data-name="${esc(s.name)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${major ? 5 : 3.2}"/>`;
    })
    .join("");
  svg.innerHTML = `<g id="g-rails">${casings}${rails}</g><g id="g-trains"></g><g id="g-stns">${stns}</g>`;

  // resting on a line follows its trains; leaving restores the whole network
  svg.addEventListener("mouseover", (e) => {
    const rail = e.target.closest(".rail");
    if (rail) dimExcept(rail.dataset.route);
  });
  svg.addEventListener("mouseout", (e) => {
    if (e.target.closest(".rail")) dimExcept(null);
  });
  svg.addEventListener("mouseover", (e) => {
    const stn = e.target.closest(".stn");
    if (stn) showStationPanel(stn);
  });
  svg.addEventListener("mouseleave", () => hidePanel());
  refreshVehicles();
  setInterval(() => state.mode === "live" && refreshVehicles(), 25_000);
  if (!reduced) requestAnimationFrame(glide);
}

function dimExcept(route) {
  for (const el of $$("#map .rail, #map .train"))
    el.style.opacity = !route || el.dataset.route === route ? "" : "0.15";
}

async function refreshVehicles() {
  try {
    const j = await jget(`${MBTA}/vehicles?filter[route]=${RAIL_ROUTES.join(",")}&fields[vehicle]=latitude,longitude&page[limit]=300`);
    $("#t-trains").textContent = j.data.length;
    const seen = new Set();
    const layer = $("#g-trains");
    if (!layer) return;
    for (const v of j.data) {
      const route = v.relationships.route.data?.id;
      const [x, y] = state.proj(v.attributes.latitude, v.attributes.longitude);
      seen.add(v.id);
      let t = state.vehicles.get(v.id);
      if (!t) {
        const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        el.setAttribute("class", "train");
        el.dataset.route = route;
        el.setAttribute("r", "4.6");
        el.setAttribute("fill", state.routes[route]?.color || "#555");
        el.setAttribute("stroke", "var(--paper2)");
        el.setAttribute("stroke-width", "1.4");
        el.setAttribute("cx", x); el.setAttribute("cy", y);
        const tip = document.createElementNS("http://www.w3.org/2000/svg", "title");
        tip.textContent = `${state.routes[route]?.name || route} Line train`;
        el.append(tip);
        layer.append(el);
        t = { el, x, y, tx: x, ty: y };
        state.vehicles.set(v.id, t);
      }
      t.tx = x; t.ty = y;
      if (reduced) { t.x = x; t.y = y; t.el.setAttribute("cx", x); t.el.setAttribute("cy", y); }
    }
    for (const [id, t] of state.vehicles)
      if (!seen.has(id)) { t.el.remove(); state.vehicles.delete(id); }
    $("#live-mark").textContent = "live";
  } catch {
    $("#live-mark").textContent = "feed unreachable — retrying";
  }
}

function glide() {
  for (const t of state.vehicles.values()) {
    t.x += (t.tx - t.x) * 0.02;
    t.y += (t.ty - t.y) * 0.02;
    t.el.setAttribute("cx", t.x.toFixed(1));
    t.el.setAttribute("cy", t.y.toFixed(1));
  }
  requestAnimationFrame(glide);
}

/* station hover panel: name, lines, record, a tiny arrival board */
let panelToken = 0;
async function showStationPanel(circle) {
  const panel = $("#map-panel");
  const name = circle.dataset.name;
  const st = state.mbtaStops[name];
  if (!st) return;
  const token = ++panelToken;
  const plate = circle.closest(".plate").getBoundingClientRect();
  const c = circle.getBoundingClientRect();
  panel.style.left = Math.min(plate.width - 310, Math.max(8, c.left - plate.left + 14)) + "px";
  panel.style.top = Math.max(8, c.top - plate.top - 10) + "px";
  const marks = [...st.routes]
    .map((r) => `<span class="line-mark" style="--lc:${state.routes[r].color}">${r.startsWith("Green") ? r.slice(-1) : r[0]}</span>`)
    .join(" ");
  const rec = st.ids.map((id) => state.stationStats[`mbta:${id}`]).find(Boolean);
  const hist = rec
    ? `record: median error ${rec.median_err} min · ${Math.round(rec.within_1min * 100)}% within a minute (n=${rec.n})`
    : "record accruing for this station";
  const acc = st.acc === 1 ? " · step-free" : "";
  panel.innerHTML = `<h4>${esc(name)}</h4><div class="hist">${marks}${acc}</div><div class="hist">${hist}</div><div class="rows"><em>listening…</em></div>`;
  panel.classList.add("show");
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
      .filter(Boolean)
      .join("");
    $(".rows", panel).innerHTML = rows || "<em>no arrivals posted</em>";
  } catch {
    if (token === panelToken) $(".rows", panel).innerHTML = "<em>board unavailable</em>";
  }
}
function hidePanel() { $("#map-panel").classList.remove("show"); }

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
        `replaying ${new Date(state.replay.start * 1000).toLocaleString()} onward · observed in bursts, gaps interpolated`;
    } catch {
      $("#map-caption").textContent = "replay archive not yet published — the observatory records from July 13, 2026";
      return;
    }
  }
  if (mode === "replay") renderReplayBin(+$("#replay-slider").value);
  else { clearInterval(state.replayTimer); state.replayTimer = null; $("#replay-play").textContent = "▶"; refreshVehicles(); }
}
function renderReplayBin(bin) {
  const rp = state.replay;
  if (!rp) return;
  state.replayBin = bin;
  const clock = new Date((rp.start + bin * rp.bin_s) * 1000);
  $("#replay-clock").textContent = clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const layer = $("#g-trains");
  const seen = new Set();
  for (const [vid, v] of Object.entries(rp.vehicles)) {
    // nearest recorded point at or before this bin, within 5 bins
    let best = null;
    for (const [b, lat, lon] of v.pts) {
      if (b <= bin && (!best || b > best[0])) best = [b, lat, lon];
      if (b > bin) break;
    }
    if (!best || bin - best[0] > 5) continue;
    seen.add(vid);
    const [x, y] = state.proj(best[1], best[2]);
    let t = state.vehicles.get("r:" + vid);
    if (!t) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      el.setAttribute("class", "train");
      el.dataset.route = v.route;
      el.setAttribute("r", "4.6");
      el.setAttribute("fill", state.routes[v.route]?.color || "#555");
      el.setAttribute("stroke", "var(--paper2)");
      el.setAttribute("stroke-width", "1.4");
      layer.append(el);
      t = { el, x, y, tx: x, ty: y };
      state.vehicles.set("r:" + vid, t);
    }
    t.tx = x; t.ty = y;
    if (reduced) { t.el.setAttribute("cx", x); t.el.setAttribute("cy", y); t.x = x; t.y = y; }
  }
  for (const [id, t] of state.vehicles)
    if (String(id).startsWith("r:") ? !seen.has(id.slice(2)) : true) {
      if (String(id).startsWith("r:") && seen.has(id.slice(2))) continue;
      t.el.remove(); state.vehicles.delete(id);
    }
}
$("#mode-live").addEventListener("click", () => setMode("live"));
$("#mode-replay").addEventListener("click", () => setMode("replay"));
$("#replay-slider").addEventListener("input", (e) => renderReplayBin(+e.target.value));
$("#replay-play").addEventListener("click", () => {
  if (state.replayTimer) {
    clearInterval(state.replayTimer); state.replayTimer = null;
    $("#replay-play").textContent = "▶";
    return;
  }
  $("#replay-play").textContent = "❚❚";
  state.replayTimer = setInterval(() => {
    const s = $("#replay-slider");
    const next = (+s.value + 1) % (+s.max + 1);
    s.value = next;
    renderReplayBin(next);
  }, 140);
});

/* ================= BOARDS ================= */

async function loadBartStations() {
  try {
    const j = await jget(`${BART}/stn.aspx?cmd=stns&key=${BART_KEY}&json=y`);
    for (const s of j.root.stations.station)
      state.stations.push({ key: `bart:${s.abbr}`, agency: "bart", id: s.abbr, name: s.name });
  } catch { /* finder simply lacks BART */ }
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
      out.push({
        ts: Date.now() / 1000 + mins * 60,
        mark: est.color[0], color: est.hexcolor, dest: e.destination,
        delayed: parseInt(est.delay, 10) > 60,
      });
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
  await Promise.all(
    keys.map(async (key) => {
      const entry = state.stations.find((s) => s.key === key);
      if (!entry) return;
      const el = document.createElement("article");
      el.className = "board reveal in";
      let rows;
      try {
        const arr = await boardArrivals(entry);
        rows = arr.length
          ? `<table class="tt"><tbody>` +
            arr
              .map(
                (a) => `<tr data-ts="${a.ts}" class="${a.delayed ? "delayed" : ""}">
              <td><span class="line-mark" style="--lc:${a.color}">${esc(a.mark)}</span></td>
              <td class="dest">${esc(a.dest)}</td>
              <td class="due"><span class="due-n">—</span></td></tr>`
              )
              .join("") +
            `</tbody></table>`
          : `<div class="board-empty">No arrivals posted — a quiet platform.</div>`;
      } catch {
        rows = `<div class="board-empty">Board unavailable; the feed will return.</div>`;
      }
      const pinned = state.pins.has(key);
      el.innerHTML = `<header><h3>${esc(entry.name)}</h3><span class="agency">${entry.agency}</span>
        <button class="pin-btn ${pinned ? "pinned" : ""}" data-key="${key}">${pinned ? "pinned ●" : "pin ○"}</button></header>
        ${rows}<div class="foot"><span>refreshes every 35 s</span><span class="mono">${entry.agency === "mbta" ? "MBTA v3" : "BART etd"}</span></div>`;
      frag.append(el);
    })
  );
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
    .map((s) => ({ s, sc: score(q, s.name) }))
    .filter((x) => x.sc >= 0)
    .sort((a, b) => a.sc - b.sc || a.s.name.length - b.s.name.length)
    .slice(0, 8);
  sel = hits.length ? 0 : -1;
  results.innerHTML = hits
    .map(
      (x, i) =>
        `<button role="option" aria-selected="${i === sel}" data-key="${x.s.key}">${esc(x.s.name)}<span class="agency">${x.s.agency.toUpperCase()}</span></button>`
    )
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

/* ================= THE RECORD ================= */

function calibrationFig(horizons) {
  const W = 480, H = 240, L = 44, B = 206, T = 14, R = 462;
  const maxH = Math.max(...horizons.map((d) => d.h));
  const maxW = Math.max(...horizons.map((d) => d.mean_wait), maxH) * 1.06;
  const x = (v) => L + ((R - L) * v) / maxH;
  const y = (v) => B - ((B - T) * v) / maxW;
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
    const cards = [];
    for (const [id, b] of Object.entries(summary.agencies || {})) {
      if (!b.n_promises) continue;
      const grade = (v, g, w) => (v <= g ? "good" : v <= w ? "" : "warn");
      cards.push(`<div class="story reveal in">
        <h3>${names[id] || id}</h3>
        <p class="lede">${b.n_arrivals.toLocaleString()} arrivals inferred · ${b.n_promises.toLocaleString()} promises graded ·
          coverage ${(b.coverage * 100).toFixed(0)}%</p>
        <div class="figures">
          <div class="figure"><div class="n ${grade(b.median_abs_err, 0.75, 1.5)}">${b.median_abs_err.toFixed(2)}<small>m</small></div><div class="k">median error</div></div>
          <div class="figure"><div class="n ${grade(Math.abs(b.bias), 0.5, 1.25)}">${b.bias > 0 ? "+" : ""}${b.bias.toFixed(2)}<small>m</small></div><div class="k">bias · + means you wait</div></div>
          <div class="figure"><div class="n">${(b.within_1min * 100).toFixed(0)}%</div><div class="k">within one minute</div></div>
        </div>
        ${b.horizons?.length >= 3 ? calibrationFig(b.horizons) : `<p class="lede">The calibration curve is drawing itself — longer-horizon promises take longer to grade.</p>`}
      </div>`);
    }
    body.innerHTML = cards.join("") || `<div class="story"><p class="lede">The record opens with the observatory’s first committed run.</p></div>`;
    const when = new Date((fresh.last_burst || fresh.built) * 1000);
    $("#record-foot").textContent =
      `Method: arrivals inferred from promise-stream convergence and disappearance; only arrivals with ≤120 s ` +
      `uncertainty are graded. Last observation ${when.toLocaleString()} · the ledger is append-only and public.`;
    $("#t-graded").textContent = (fresh.n_resolutions_window || 0).toLocaleString();
    const mbta = summary.agencies?.mbta;
    if (mbta?.median_abs_err != null) $("#t-err").innerHTML = `${mbta.median_abs_err.toFixed(2)}<small> min</small>`;
    const burst = Object.values(fresh.burst_stats || {}).reduce((s, a) => s + (a.promises || 0), 0);
    if (burst) $("#t-promises").innerHTML = `${burst.toLocaleString()}<small> /burst</small>`;
  } catch {
    body.innerHTML = `<div class="story"><p class="lede">The record hasn’t been published yet.</p></div>`;
  }
}

/* ================= ALMANAC ================= */

async function renderAlmanac() {
  try {
    const [days, summary] = await Promise.all([jget("data/days.json"), jget("data/summary.json")]);
    const byAgency = {};
    for (const d of days) (byAgency[d.agency] ||= []).push(d);
    const names = { mbta: "MBTA", bart: "BART", caltrain: "Caltrain" };
    $("#calendars").innerHTML = Object.entries(byAgency)
      .map(([agency, rows]) => {
        const cells = rows
          .map((d) => {
            const q = d.within_1min >= 0.75 ? "a" : d.within_1min >= 0.6 ? "b" : d.within_1min >= 0.45 ? "c" : "d";
            return `<div class="day-cell" data-q="${q}" data-tip="${d.day} · ${Math.round(d.within_1min * 100)}% kept · n=${d.n}"></div>`;
          })
          .join("");
        return `<h3 class="serif" style="margin:26px 0 4px">${names[agency] || agency}</h3><div class="calendar">${cells}</div>`;
      })
      .join("");
    // marginalia: small true sentences from the record
    const notes = [];
    const m = summary.agencies?.mbta, b = summary.agencies?.bart;
    if (m) {
      notes.push(`The observatory has graded <span class="num">${m.n_promises.toLocaleString()}</span> MBTA promises so far; the median one missed by <span class="num">${m.median_abs_err}</span> minutes.`);
      const worst = (m.horizons || []).slice().sort((x, y) => y.bias - x.bias)[0];
      if (worst) notes.push(`The least honest promise horizon on the MBTA so far: <span class="num">“${worst.h} minutes,”</span> which actually means ${worst.mean_wait}.`);
      const routes = Object.entries(m.routes || {}).filter(([, r]) => r.n_promises >= 30);
      if (routes.length >= 2) {
        routes.sort((x, y) => x[1].median_abs_err - y[1].median_abs_err);
        notes.push(`Most punctual line in the record: <span class="num">${routes[0][0]}</span> (median error ${routes[0][1].median_abs_err} min). Bringing up the rear: <span class="num">${routes.at(-1)[0]}</span>.`);
      }
    }
    if (m && b) notes.push(`Coast to coast: BART's median error is <span class="num">${b.median_abs_err}</span> min to the MBTA's <span class="num">${m.median_abs_err}</span>. Both err on the side of your patience.`);
    notes.push(`Every figure on this page can be recomputed from the public ledger — <span class="num">$0</span> of infrastructure, no server, no database, no analyst in the loop.`);
    $("#marginalia").innerHTML = notes.map((n) => `<p>${n}</p>`).join("");
  } catch {
    $("#calendars").innerHTML = `<p class="deck">The almanac begins with the record's first full day.</p>`;
  }
}

/* ================= TODAY / ALERTS ================= */
async function renderAlerts() {
  try {
    const j = await jget(`${MBTA}/alerts?filter[route_type]=0,1&filter[datetime]=NOW&fields[alert]=severity,effect`);
    const n = j.data.length;
    $("#t-alerts").textContent = n;
    if (n) {
      const worst = j.data.slice().sort((a, z) => z.attributes.severity - a.attributes.severity)[0];
      $("#t-alerts-note").textContent = String(worst.attributes.effect || "").replace(/_/g, " ").toLowerCase() || "service notes in effect";
    } else $("#t-alerts-note").textContent = "no notes — a clean sheet";
  } catch { $("#t-alerts").textContent = "—"; }
}

/* ================= boot ================= */
(async function boot() {
  renderRecord();
  renderAlmanac();
  renderAlerts();
  await buildMap();
  mbtaFinderStations();
  await loadBartStations();
  // opening boards: pins first, then a printed-guide default spread
  for (const name of ["Park Street", "Harvard", "South Station"]) {
    const st = state.stations.find((s) => s.agency === "mbta" && s.name === name);
    if (st) state.boards.push(st.key);
  }
  const embr = state.stations.find((s) => s.agency === "bart" && s.name.startsWith("Embarcadero"));
  if (embr) state.boards.push(embr.key);
  renderBoards();
  setInterval(renderBoards, 35_000);
  setInterval(renderAlerts, 120_000);
  $$("section .plate, .story, .board").forEach((el) => io.observe(el));
})();
