/* overdue — live board + report card. Vanilla JS, no dependencies.
   Data sources (both CORS-open):
   - MBTA v3 JSON:API  https://api-v3.mbta.com   (no key, 20 req/min budget)
   - BART legacy JSON  https://api.bart.gov      (public documented key)
   Report card JSONs are produced by the observatory pipeline (site/data/). */

"use strict";

const MBTA = "https://api-v3.mbta.com";
const BART = "https://api.bart.gov/api";
const BART_KEY = "MW9S-E7SL-26DU-VV8V"; // BART's published public key
const REFRESH_MS = 35_000;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/* ---------------- state ---------------- */
const state = {
  stations: [],          // {key, agency, id, name, lines:[{name,color}]}
  cards: [],             // station keys currently on the board
  favs: new Set(JSON.parse(localStorage.getItem("overdue-favs") || "[]")),
  mbtaRoutes: {},        // route id -> {color, name, destinations}
  toastSeen: new Set(),
  feedsOk: { mbta: false, bart: false },
};

const DEFAULT_STATIONS = [
  ["mbta", "Park Street"], ["mbta", "Harvard"], ["mbta", "South Station"],
  ["bart", "Embarcadero"], ["bart", "Powell St."],
];

/* ---------------- theme ---------------- */
const themeBtn = $("#theme-toggle");
const savedTheme = localStorage.getItem("overdue-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
else if (matchMedia("(prefers-color-scheme: light)").matches)
  document.documentElement.dataset.theme = "light";
themeBtn.addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = cur;
  localStorage.setItem("overdue-theme", cur);
});

/* ---------------- nav scroll ---------------- */
addEventListener("scroll", () => $("#nav").classList.toggle("scrolled", scrollY > 12), { passive: true });

/* ---------------- animated background ---------------- */
(function background() {
  const canvas = $("#bg");
  const ctx = canvas.getContext("2d");
  let w, h, particles = [];
  const isLight = () => document.documentElement.dataset.theme === "light";
  function resize() {
    w = canvas.width = innerWidth * devicePixelRatio;
    h = canvas.height = innerHeight * devicePixelRatio;
  }
  resize();
  addEventListener("resize", resize);
  const N = Math.min(70, Math.floor(innerWidth / 22));
  for (let i = 0; i < N; i++)
    particles.push({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00012, vy: (Math.random() - 0.5) * 0.00009,
      r: 0.7 + Math.random() * 1.7, tw: Math.random() * Math.PI * 2,
    });
  let t = 0;
  function frame() {
    t += 0.0018;
    ctx.clearRect(0, 0, w, h);
    // slow gradient wash
    const g = ctx.createLinearGradient(0, 0, w, h);
    if (isLight()) {
      g.addColorStop(0, "#f2f5f9"); g.addColorStop(1, "#e7edf6");
    } else {
      const p = (Math.sin(t) + 1) / 2;
      g.addColorStop(0, "#081c2d");
      g.addColorStop(1, `rgb(${14 + p * 6}, ${28 + p * 6}, ${48 + p * 8})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // faint contour arcs, subway-map ghosts
    ctx.strokeStyle = isLight() ? "rgba(40,80,130,.05)" : "rgba(120,170,220,.045)";
    ctx.lineWidth = 1.2 * devicePixelRatio;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      const y0 = h * (0.2 + i * 0.22) + Math.sin(t * 0.7 + i) * h * 0.012;
      ctx.moveTo(-40, y0);
      ctx.bezierCurveTo(w * 0.3, y0 - h * 0.09, w * 0.6, y0 + h * 0.11, w + 40, y0 - h * 0.05);
      ctx.stroke();
    }
    // drifting light beam
    const bx = ((t * 0.13) % 1.4 - 0.2) * w;
    const beam = ctx.createLinearGradient(bx - w * 0.14, 0, bx + w * 0.14, 0);
    const beamCol = isLight() ? "rgba(74,158,222,.05)" : "rgba(74,158,222,.06)";
    beam.addColorStop(0, "transparent"); beam.addColorStop(0.5, beamCol); beam.addColorStop(1, "transparent");
    ctx.fillStyle = beam;
    ctx.fillRect(0, 0, w, h);
    // particles
    for (const p of particles) {
      p.x = (p.x + p.vx + 1) % 1; p.y = (p.y + p.vy + 1) % 1; p.tw += 0.012;
      const a = (isLight() ? 0.14 : 0.3) * (0.5 + Math.sin(p.tw) * 0.5);
      ctx.fillStyle = `rgba(140,190,240,${a})`;
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, p.r * devicePixelRatio, 0, 7);
      ctx.fill();
    }
    if (!reduced) requestAnimationFrame(frame);
  }
  frame(); // draws once even under reduced motion
})();

/* ---------------- fetch helpers ---------------- */
async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ---------------- station registry ---------------- */
async function loadStations() {
  const jobs = [];
  jobs.push(
    (async () => {
      const routes = await jget(`${MBTA}/routes?filter[type]=0,1&fields[route]=color,long_name,direction_destinations`);
      for (const r of routes.data)
        state.mbtaRoutes[r.id] = {
          color: `#${r.attributes.color}`,
          name: r.id.startsWith("Green") ? r.id.replace("-", " ") : r.attributes.long_name.replace(" Line", ""),
          destinations: r.attributes.direction_destinations,
        };
      const stops = await jget(`${MBTA}/stops?filter[route_type]=0,1&fields[stop]=name&page[limit]=300`);
      const seen = new Set();
      for (const s of stops.data) {
        if (seen.has(s.attributes.name)) continue;
        seen.add(s.attributes.name);
        state.stations.push({
          key: `mbta:${s.id}`, agency: "mbta", id: s.id, name: s.attributes.name, lines: [],
        });
      }
      state.feedsOk.mbta = true;
    })()
  );
  jobs.push(
    (async () => {
      const j = await jget(`${BART}/stn.aspx?cmd=stns&key=${BART_KEY}&json=y`);
      for (const s of j.root.stations.station)
        state.stations.push({
          key: `bart:${s.abbr}`, agency: "bart", id: s.abbr, name: s.name, lines: [],
        });
      state.feedsOk.bart = true;
    })()
  );
  await Promise.allSettled(jobs);
  updateHeroStatus();
}

function updateHeroStatus() {
  const ok = Object.values(state.feedsOk).filter(Boolean).length;
  const dot = $("#hero-dot"), txt = $("#hero-status");
  if (ok === 2) { dot.classList.add("ok"); txt.textContent = "live · MBTA + BART feeds connected"; }
  else if (ok === 1) { dot.classList.add("ok"); txt.textContent = "live · one feed connected, retrying the other"; }
  else txt.textContent = "feeds unreachable — retrying";
}

/* ---------------- arrivals ---------------- */
async function fetchArrivals(st) {
  if (st.agency === "mbta") {
    const j = await jget(
      `${MBTA}/predictions?filter[stop]=${st.id}&filter[route_type]=0,1&sort=arrival_time&page[limit]=14&include=route,trip`
    );
    const inc = {};
    for (const x of j.included || []) inc[`${x.type}:${x.id}`] = x;
    const out = [];
    for (const p of j.data) {
      const a = p.attributes;
      const t = a.arrival_time || a.departure_time;
      if (!t) continue;
      const ts = Date.parse(t) / 1000;
      if (ts * 1000 < Date.now() - 30_000) continue;
      const routeId = p.relationships.route.data?.id;
      const route = state.mbtaRoutes[routeId] || { color: "#5d7186", name: routeId, destinations: [] };
      const trip = inc[`trip:${p.relationships.trip.data?.id}`];
      const dest = trip?.attributes.headsign || route.destinations?.[a.direction_id] || "";
      out.push({ ts, line: route.name, color: route.color, dest, delayed: a.status === "Delayed", key: p.id });
      if (out.length >= 6) break;
    }
    return out;
  }
  // BART
  const j = await jget(`${BART}/etd.aspx?cmd=etd&orig=${st.id}&key=${BART_KEY}&json=y`);
  const etds = j.root.station?.[0]?.etd || [];
  const out = [];
  const now = Date.now() / 1000;
  for (const e of etds)
    for (const est of e.estimate) {
      const mins = est.minutes === "Leaving" ? 0 : parseInt(est.minutes, 10);
      if (Number.isNaN(mins)) continue;
      out.push({
        ts: now + mins * 60, line: est.color[0] + est.color.slice(1).toLowerCase(),
        color: est.hexcolor, dest: e.destination, delayed: parseInt(est.delay, 10) > 60,
        key: `${st.id}-${e.abbreviation}-${est.minutes}`,
      });
    }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(0, 6);
}

/* ---------------- board ---------------- */
function stationByKey(key) { return state.stations.find((s) => s.key === key); }

function boardKeys() {
  const favs = [...state.favs].filter(stationByKey);
  const rest = state.cards.filter((k) => !state.favs.has(k));
  return [...favs, ...rest];
}

async function renderBoard() {
  const board = $("#board");
  const keys = boardKeys();
  if (!keys.length) {
    board.innerHTML = `<div class="card"><div class="empty">Search above to add any MBTA or BART station.</div></div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  await Promise.all(
    keys.map(async (key, i) => {
      const st = stationByKey(key);
      if (!st) return;
      const card = document.createElement("div");
      card.className = "card";
      card.style.animationDelay = `${i * 60}ms`;
      let rowsHtml = "";
      let glow = "var(--accent)";
      try {
        const arrivals = await fetchArrivals(st);
        if (arrivals.length) glow = arrivals[0].color;
        rowsHtml = arrivals.length
          ? arrivals
              .map(
                (a) => `
        <div class="arrival${a.delayed ? " delayed" : ""}" data-ts="${a.ts}" data-key="${st.key}|${a.key}" data-line="${a.line}" data-color="${a.color}" data-station="${st.name}">
          <span class="line-badge" style="--c:${a.color}">${a.line}</span>
          <span class="dest">${a.dest}</span>
          <span class="eta"><span class="eta-num">–</span><span class="eta-unit">min</span></span>
        </div>`
              )
              .join("")
          : `<div class="empty">No arrivals in the next 45 minutes — quiet out there.</div>`;
      } catch {
        rowsHtml = `<div class="empty">Feed unreachable for this station — retrying shortly.</div>`;
      }
      card.style.setProperty("--glow", glow);
      const faved = state.favs.has(st.key);
      card.innerHTML = `
        <div class="card-head">
          <h3>${st.name}</h3><span class="agency-tag">${st.agency}</span>
          <button class="fav-btn${faved ? " faved" : ""}" data-key="${st.key}"
                  aria-label="${faved ? "Unpin" : "Pin"} ${st.name}">${faved ? "★" : "☆"}</button>
        </div>
        ${rowsHtml}
        <div class="status-line"><span>live · refreshes every ${REFRESH_MS / 1000}s</span><span class="mono">${st.agency === "mbta" ? "MBTA v3" : "BART ETD"}</span></div>`;
      frag.append(card);
    })
  );
  board.replaceChildren(frag);
  tick();
}

/* countdowns tick every second — no refetch needed */
function tick() {
  const now = Date.now() / 1000;
  for (const el of $$(".arrival")) {
    const ts = parseFloat(el.dataset.ts);
    const mins = Math.max(0, (ts - now) / 60);
    const numEl = $(".eta-num", el);
    numEl.textContent = mins < 0.75 ? "now" : mins < 10 ? mins.toFixed(1) : String(Math.round(mins));
    $(".eta-unit", el).style.display = mins < 0.75 ? "none" : "";
    el.classList.toggle("imminent", mins <= 2 && !el.classList.contains("delayed"));
    // toast once when a pinned station's train crosses 2 minutes
    const [stKey] = el.dataset.key.split("|");
    if (mins <= 2 && mins > 0.2 && state.favs.has(stKey) && !state.toastSeen.has(el.dataset.key)) {
      state.toastSeen.add(el.dataset.key);
      toast(`${el.dataset.line} arriving at ${el.dataset.station} in ${mins.toFixed(0) || 1} min`, el.dataset.color);
    }
  }
}
setInterval(tick, 1000);

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".fav-btn");
  if (!btn) return;
  const key = btn.dataset.key;
  if (state.favs.has(key)) state.favs.delete(key);
  else state.favs.add(key);
  localStorage.setItem("overdue-favs", JSON.stringify([...state.favs]));
  renderBoard();
});

/* ---------------- pulse strip ---------------- */
async function renderPulse() {
  const el = $("#pulse");
  const chips = [];
  try {
    const j = await jget(`${MBTA}/vehicles?filter[route_type]=0,1&fields[vehicle]=label&page[limit]=400`);
    const counts = {};
    for (const v of j.data) {
      const r = v.relationships.route.data?.id;
      if (r) counts[r] = (counts[r] || 0) + 1;
    }
    const greens = Object.keys(counts).filter((r) => r.startsWith("Green"));
    const greenTotal = greens.reduce((s, r) => s + counts[r], 0);
    for (const rid of ["Red", "Orange", "Blue"])
      if (counts[rid])
        chips.push({ label: `${rid} Line`, n: counts[rid], color: state.mbtaRoutes[rid]?.color || "#888" });
    if (greenTotal) chips.push({ label: "Green Line", n: greenTotal, color: state.mbtaRoutes["Green-B"]?.color || "#00843D" });
  } catch { /* chip simply absent */ }
  try {
    const j = await jget(`${BART}/etd.aspx?cmd=etd&orig=ALL&key=${BART_KEY}&json=y`);
    let n = 0;
    for (const s of j.root.station || []) for (const e of s.etd || []) n += e.estimate.length;
    chips.push({ label: "BART departures board-wide", n, color: "#4a9ede" });
  } catch { /* absent */ }
  el.innerHTML = chips
    .map(
      (c, i) =>
        `<span class="pulse-chip" style="--c:${c.color}; animation-delay:${i * 70}ms"><span class="pulse-dot"></span>${c.label} · <b>${c.n}</b> live</span>`
    )
    .join("");
}

/* ---------------- search ---------------- */
const searchInput = $("#search");
const resultsEl = $("#search-results");
let selIdx = -1;

function fuzzy(q, name) {
  q = q.toLowerCase(); name = name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  let i = 0;
  for (const ch of name) if (ch === q[i]) i++;
  return i === q.length ? 2 : -1;
}

function renderResults(q) {
  if (!q) { resultsEl.hidden = true; searchInput.setAttribute("aria-expanded", "false"); return; }
  const scored = state.stations
    .map((s) => ({ s, score: fuzzy(q, s.name) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.s.name.length - b.s.name.length)
    .slice(0, 8);
  selIdx = scored.length ? 0 : -1;
  resultsEl.innerHTML = scored
    .map(
      (x, i) => `
    <button class="result" role="option" aria-selected="${i === selIdx}" data-key="${x.s.key}">
      <svg viewBox="0 0 24 24" class="ic"><path d="M5 15V7a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3Z"/><path d="M7 21l1.5-3M17 21l-1.5-3M5 11h14"/></svg>
      ${x.s.name}<span class="agency-tag">&nbsp;${x.s.agency.toUpperCase()}</span>
    </button>`
    )
    .join("");
  resultsEl.hidden = !scored.length;
  searchInput.setAttribute("aria-expanded", String(!scored.length));
}

function addStation(key) {
  if (!state.cards.includes(key) && !state.favs.has(key)) state.cards.unshift(key);
  state.cards = state.cards.slice(0, 8);
  resultsEl.hidden = true;
  searchInput.value = "";
  renderBoard();
  $("#live").scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
}

searchInput.addEventListener("input", () => renderResults(searchInput.value.trim()));
searchInput.addEventListener("keydown", (e) => {
  const opts = $$(".result", resultsEl);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    selIdx = (selIdx + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === selIdx)));
    opts[selIdx]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && opts[selIdx]) addStation(opts[selIdx].dataset.key);
  else if (e.key === "Escape") { resultsEl.hidden = true; searchInput.blur(); }
});
resultsEl.addEventListener("click", (e) => {
  const b = e.target.closest(".result");
  if (b) addStation(b.dataset.key);
});
addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  }
});
$("#search-open").addEventListener("click", () => searchInput.focus());
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) resultsEl.hidden = true;
});

/* ---------------- toasts ---------------- */
function toast(msg, color = "var(--accent)") {
  const host = $("#toasts");
  if (host.children.length >= 3) host.firstChild.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.style.setProperty("--c", color);
  t.textContent = msg;
  host.append(t);
  setTimeout(() => { t.classList.add("leaving"); setTimeout(() => t.remove(), 320); }, 6000);
}

/* ---------------- report card ---------------- */
function calibrationSVG(horizons) {
  const W = 460, H = 250, L = 44, B = 214, T = 16, R = 440;
  const maxH = Math.max(...horizons.map((d) => d.h), 10);
  const maxW = Math.max(...horizons.map((d) => d.mean_wait), maxH) * 1.08;
  const x = (v) => L + ((R - L) * v) / maxH;
  const y = (v) => B - ((B - T) * v) / maxW;
  const pts = horizons.map((d) => `${x(d.h).toFixed(1)},${y(d.mean_wait).toFixed(1)}`).join(" ");
  const dots = horizons
    .map((d) => `<circle class="dot" cx="${x(d.h).toFixed(1)}" cy="${y(d.mean_wait).toFixed(1)}" r="3.6"><title>promised ${d.h} min → mean wait ${d.mean_wait} min (n=${d.n})</title></circle>`)
    .join("");
  const len = 1200;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calibration: promised vs actual wait">
    <defs>
      <linearGradient id="curve-grad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#4a9ede"/><stop offset="1" stop-color="#8b7bf7"/>
      </linearGradient>
      <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4a9ede" stop-opacity=".25"/><stop offset="1" stop-color="#4a9ede" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line class="grid" x1="${L}" y1="${B}" x2="${R}" y2="${B}"/>
    <line class="grid" x1="${L}" y1="${T}" x2="${L}" y2="${B}"/>
    <line class="ideal" x1="${x(0)}" y1="${y(0)}" x2="${x(maxH)}" y2="${y(maxH)}"/>
    <polygon class="area" points="${x(horizons[0].h)},${B} ${pts} ${x(horizons.at(-1).h)},${B}"/>
    <polyline class="curve" points="${pts}" ${reduced ? "" : `stroke-dasharray="${len}" stroke-dashoffset="${len}"><animate attributeName="stroke-dashoffset" from="${len}" to="0" dur="1.1s" fill="freeze" calcMode="spline" keySplines=".3 0 .2 1"/`}></polyline>
    ${dots}
    <text x="${R}" y="${y(maxH) - 8}" text-anchor="end">perfect</text>
    <text x="${L + 6}" y="${T + 4}">actual wait (min)</text>
    <text x="${R}" y="${B + 22}" text-anchor="end">promised (min)</text>
    <text x="${L - 6}" y="${B + 4}" text-anchor="end">0</text>
  </svg>`;
}

function gradeCard(id, block, names) {
  const err = block.median_abs_err, bias = block.bias, w1 = block.within_1min;
  const cls = (v, good, warn) => (v <= good ? "good" : v <= warn ? "warn" : "bad");
  return `<div class="gcard" style="animation-delay:60ms">
    <h3>${names[id] || id}</h3>
    <p class="gsub">${block.n_arrivals.toLocaleString()} graded arrivals · ${block.n_promises.toLocaleString()} promises ·
      coverage ${(block.coverage * 100).toFixed(0)}%</p>
    <div class="big-stats">
      <div class="big-stat"><div class="v ${cls(err, 0.75, 1.5)}">${err.toFixed(1)}<small>m</small></div><div class="k">median error</div></div>
      <div class="big-stat"><div class="v ${cls(Math.abs(bias), 0.5, 1.25)}">${bias > 0 ? "+" : ""}${bias.toFixed(1)}<small>m</small></div><div class="k">bias (＋ = you wait)</div></div>
      <div class="big-stat"><div class="v ${cls(1 - w1, 0.25, 0.5)}">${(w1 * 100).toFixed(0)}%</div><div class="k">within 1 min</div></div>
    </div>
    ${block.horizons.length >= 3 ? calibrationSVG(block.horizons) : ""}
  </div>`;
}

async function renderGrades() {
  const body = $("#grades-body");
  const names = { mbta: "MBTA — Boston subway & light rail", bart: "BART — SF Bay Area", caltrain: "Caltrain" };
  try {
    const [summary, fresh] = await Promise.all([
      jget("data/summary.json"),
      jget("data/freshness.json"),
    ]);
    const entries = Object.entries(summary.agencies || {}).filter(([, b]) => (b.n_promises || 0) >= 150);
    if (entries.length) {
      body.classList.add("grades");
      body.innerHTML = entries.map(([id, b]) => gradeCard(id, b, names)).join("");
    } else {
      const total = Object.values(summary.agencies || {}).reduce((s, b) => s + (b.n_arrivals || 0), 0);
      body.innerHTML = `<div class="gcard accrue" style="grid-column:1/-1">
        <div class="n">${total.toLocaleString()}</div>
        <p>arrivals graded so far. The observatory is young — report cards unlock at 150
        graded promises per agency, typically within the first day of observation.
        Every poll gets it closer.</p></div>`;
    }
    const when = new Date((fresh.last_burst || fresh.built) * 1000);
    $("#freshness-line").textContent =
      `Observatory status: last poll ${when.toLocaleString()} · ` +
      `${(fresh.n_resolutions_window || 0).toLocaleString()} arrivals graded in the ${summary.window_days}-day window · ` +
      `pending pairs in flight: ${(fresh.pending_pairs ?? 0).toLocaleString()}`;
  } catch {
    body.innerHTML = `<div class="gcard accrue" style="grid-column:1/-1">
      <div class="n">…</div><p>Report-card data hasn’t been published yet — the first
      observatory run will create it.</p></div>`;
    $("#freshness-line").textContent = "Observatory status: awaiting first published run.";
  }
}

/* ---------------- boot ---------------- */
(async function boot() {
  renderGrades();
  await loadStations();
  for (const [agency, name] of DEFAULT_STATIONS) {
    const st = state.stations.find((s) => s.agency === agency && s.name.startsWith(name));
    if (st && !state.favs.has(st.key)) state.cards.push(st.key);
  }
  await renderBoard();
  renderPulse();
  setInterval(() => { renderBoard(); renderPulse(); }, REFRESH_MS);
})();
