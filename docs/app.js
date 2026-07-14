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
  boards: [], trains: new Map(), mpp: 1, proj: null, pinned: null,
};

/* The camera: a viewBox that eases toward its target every frame. */
const cam = { x: 0, y: 0, w: 1000, h: 760, tx: 0, ty: 0, tw: 1000, th: 760 };
function camReset() { Object.assign(cam, { tx: 0, ty: 0, tw: 1000, th: 760 }); }
function camZoom(fx, fy, factor) {
  const w = Math.max(150, Math.min(1000, cam.tw * factor));
  const k = w / cam.tw;
  cam.tx = fx - (fx - cam.tx) * k;
  cam.ty = fy - (fy - cam.ty) * k;
  cam.tw = w; cam.th = cam.th * k;
  cam.tx = Math.max(-80, Math.min(1080 - cam.tw, cam.tx));
  cam.ty = Math.max(-60, Math.min(820 - cam.th, cam.ty));
}

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

/* ---------------- reveals + ambient craft ---------------- */
const io = new IntersectionObserver(
  (es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")),
  { threshold: 0.1 }
);
$$(".reveal").forEach((el) => io.observe(el));

// reading progress hairline
addEventListener("scroll", () => {
  const max = document.documentElement.scrollHeight - innerHeight;
  $("#progress").style.width = (max > 0 ? (scrollY / max) * 100 : 0) + "%";
}, { passive: true });

// figures count up the first time they land
function setFigure(el, value, suffix = "") {
  if (reduced || value < 10) {
    el.innerHTML = value.toLocaleString() + suffix;
    return;
  }
  const t0 = performance.now(), dur = 900;
  (function tick(now) {
    const u = Math.min(1, (now - t0) / dur);
    const eased = 1 - (1 - u) ** 3;
    el.innerHTML = Math.round(value * eased).toLocaleString() + suffix;
    if (u < 1) requestAnimationFrame(tick);
  })(performance.now());
}

// the map plate's shadow leans away from the cursor, like a sheet under a lamp
(function plateShadow() {
  if (reduced) return;
  const plate = $(".plate");
  if (!plate) return;
  let raf = 0;
  plate.addEventListener("mousemove", (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = plate.getBoundingClientRect();
      const dx = ((e.clientX - r.left) / r.width - 0.5) * -10;
      const dy = ((e.clientY - r.top) / r.height - 0.5) * -8;
      plate.style.boxShadow =
        `${dx.toFixed(1)}px ${(dy + 6).toFixed(1)}px 30px rgba(60, 50, 30, .12), 0 1px 2px rgba(60, 50, 30, .08)`;
    });
  });
  plate.addEventListener("mouseleave", () => { plate.style.boxShadow = ""; });
})();

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
/* Ledger JSONs sit behind Pages' ~10-min cache; bust it in 2-min buckets so
   an open tab sees new observations shortly after they land. */
const dget = (path) => jget(`${path}?v=${Math.floor(Date.now() / 120_000)}`);

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
    casings += `<path class="rail-casing" data-route="${p.route}" d="${d}" stroke-width="7"/>`;
    rails += `<path class="rail" data-route="${p.route}" d="${d}" stroke="${state.routes[p.route].color}" stroke-width="3.4"><title>${state.routes[p.route].name} Line</title></path>`;
  }
  let stns = "", hits = "", lbls = "";
  for (const s of all) {
    const [x, y] = proj(s.lat, s.lon);
    const X = x.toFixed(1), Y = y.toFixed(1);
    stns += `<circle class="stn" data-name="${esc(s.name)}" cx="${X}" cy="${Y}" r="${s.routes.size > 1 ? 5 : 3.2}"/>`;
    hits += `<circle class="hit" data-kind="stn" data-name="${esc(s.name)}" cx="${X}" cy="${Y}" r="11"/>`;
    if (s.routes.size > 1) lbls += `<text class="lbl" data-name="${esc(s.name)}" x="${(x + 8).toFixed(1)}" y="${(y - 7).toFixed(1)}">${esc(s.name)}</text>`;
  }
  svg.innerHTML =
    `<g id="g-rails">${casings}${rails}</g><g id="g-stns">${stns}</g>` +
    `<g id="g-lbls">${lbls}</g><g id="g-hits">${hits}</g><g id="g-trains"></g>`;
  if (!reduced) {
    for (const rail of $$("#map .rail")) {
      const len = rail.getTotalLength();
      rail.style.strokeDasharray = len;
      rail.style.strokeDashoffset = len;
      rail.classList.add("draw");
    }
    setTimeout(() => {
      for (const rail of $$("#map .rail")) {
        rail.classList.remove("draw");
        rail.style.strokeDasharray = rail.style.strokeDashoffset = "";
      }
    }, 1600);
  }
  wireMapInput(svg);
  renderLegend();
  await refreshVehicles();
  setInterval(refreshVehicles, REFRESH_S * 1000);
  requestAnimationFrame(animate);
}

/* ---------------- line isolation ---------------- */
const LINE_GROUPS = [
  { key: "Red", label: "Red", match: (r) => r === "Red" },
  { key: "Orange", label: "Orange", match: (r) => r === "Orange" },
  { key: "Blue", label: "Blue", match: (r) => r === "Blue" },
  { key: "Green", label: "Green", match: (r) => r.startsWith("Green") },
  { key: "Mattapan", label: "Mattapan", match: (r) => r === "Mattapan" },
];
const visibleGroups = new Set(LINE_GROUPS.map((g) => g.key));
const groupOf = (route) => LINE_GROUPS.find((g) => g.match(route))?.key;
const routeVisible = (route) => visibleGroups.has(groupOf(route));

function renderLegend() {
  $("#legend").innerHTML = LINE_GROUPS.map((g) => {
    const color = state.routes[g.key === "Green" ? "Green-B" : g.key]?.color || "#888";
    return `<button data-group="${g.key}" class="${visibleGroups.has(g.key) ? "" : "off"}"
      style="--lc:${color}" aria-pressed="${visibleGroups.has(g.key)}"><i></i>${g.label}</button>`;
  }).join("");
}
$("#legend").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-group]");
  if (!btn) return;
  const key = btn.dataset.group;
  if (visibleGroups.has(key) && visibleGroups.size === 1) {
    for (const g of LINE_GROUPS) visibleGroups.add(g.key); // solo -> restore all
  } else if (visibleGroups.size === LINE_GROUPS.length) {
    visibleGroups.clear(); visibleGroups.add(key); // first click isolates
  } else if (visibleGroups.has(key)) {
    visibleGroups.delete(key);
    if (!visibleGroups.size) for (const g of LINE_GROUPS) visibleGroups.add(g.key);
  } else visibleGroups.add(key);
  renderLegend();
  applyLineFilter();
});

function applyLineFilter() {
  for (const el of $$("#map .rail, #map .rail-casing")) {
    const route = el.dataset.route;
    el.style.display = !route || routeVisible(route) ? "" : "none";
  }
  for (const t of state.trains.values())
    t.el.style.display = routeVisible(t.el.dataset.route) ? "" : "none";
  const stationVisible = (name) => {
    const st = state.mbtaStops[name];
    return st && [...st.routes].some(routeVisible);
  };
  for (const el of $$("#map .stn, #map .lbl, #map .hit[data-kind='stn']"))
    el.style.display = stationVisible(el.dataset.name) ? "" : "none";
  closePanel();
}

/* ---------------- input: camera + hover + selection ---------------- */
function svgPoint(svg, cx, cy) {
  const r = svg.getBoundingClientRect();
  return [cam.x + ((cx - r.left) / r.width) * cam.w, cam.y + ((cy - r.top) / r.height) * cam.h];
}

function wireMapInput(svg) {
  const pointers = new Map();
  let moved = 0, pinchD = 0;

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [fx, fy] = svgPoint(svg, e.clientX, e.clientY);
    camZoom(fx, fy, e.deltaY > 0 ? 1.16 : 1 / 1.16);
  }, { passive: false });

  svg.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchD = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    moved += Math.abs(dx) + Math.abs(dy);
    if (pointers.size === 1 && moved > 4) {
      svg.classList.add("panning");
      const r = svg.getBoundingClientRect();
      cam.tx -= (dx / r.width) * cam.w;
      cam.ty -= (dy / r.height) * cam.h;
    } else if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)?.[1];
      if (other) {
        const d = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (pinchD > 0 && d > 0) {
          const [fx, fy] = svgPoint(svg, (e.clientX + other.x) / 2, (e.clientY + other.y) / 2);
          camZoom(fx, fy, pinchD / d);
        }
        pinchD = d;
      }
    }
    p.x = e.clientX; p.y = e.clientY;
  });
  addEventListener("pointerup", (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size) svg.classList.remove("panning");
  });
  addEventListener("pointercancel", (e) => pointers.delete(e.pointerId));

  svg.addEventListener("dblclick", (e) => {
    const [fx, fy] = svgPoint(svg, e.clientX, e.clientY);
    camZoom(fx, fy, 1 / 1.7);
  });
  $("#zoom-in").addEventListener("click", () => camZoom(cam.tx + cam.tw / 2, cam.ty + cam.th / 2, 1 / 1.4));
  $("#zoom-out").addEventListener("click", () => camZoom(cam.tx + cam.tw / 2, cam.ty + cam.th / 2, 1.4));
  $("#zoom-reset").addEventListener("click", camReset);

  // hover: a tooltip that can never block; selection: click to pin a panel
  svg.addEventListener("mouseover", (e) => {
    const hit = e.target.closest(".hit");
    const rail = !hit && e.target.closest(".rail");
    if (rail) return dimExcept(rail.dataset.route);
    if (!hit) return;
    if (hit.dataset.kind === "train") {
      const t = state.trains.get(hit.dataset.vid);
      if (t?.meta) {
        dimExcept(t.meta.route);
        showTip(e.clientX, e.clientY,
          `${state.routes[t.meta.route]?.name || t.meta.route} Line · to ${state.routes[t.meta.route]?.destinations?.[t.meta.dir] || "—"}`);
      }
    } else {
      const st = state.mbtaStops[hit.dataset.name];
      const rec = st?.ids.map((id) => state.stationStats[`mbta:${id}`]).find(Boolean);
      showTip(e.clientX, e.clientY,
        hit.dataset.name + (rec ? ` · keeps ${Math.round(rec.within_1min * 100)}%` : ""));
      $$(`#map .stn[data-name="${CSS.escape(hit.dataset.name)}"]`).forEach((el) => el.classList.add("hot"));
    }
  });
  svg.addEventListener("mouseout", (e) => {
    if (e.target.closest(".rail") || e.target.closest(".hit")) {
      if (!state.pinned) dimExcept(null);
      hideTip();
      $$("#map .stn.hot").forEach((el) => el.classList.remove("hot"));
    }
  });
  svg.addEventListener("click", (e) => {
    if (moved > 6) return; // it was a drag, not a click
    const hit = e.target.closest(".hit");
    if (!hit) return closePanel();
    if (hit.dataset.kind === "train") showTrainPanel(hit.dataset.vid, e.clientX, e.clientY);
    else showStationPanel(hit.dataset.name, e.clientX, e.clientY);
  });
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
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("class", "train");
  g.dataset.route = route;
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("class", "train-dot");
  dot.setAttribute("r", "4.6");
  dot.setAttribute("fill", state.routes[route]?.color || "#555");
  dot.setAttribute("stroke", "var(--paper2)");
  dot.setAttribute("stroke-width", "1.4");
  const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  hit.setAttribute("class", "hit");
  hit.setAttribute("r", "12");
  hit.dataset.kind = "train";
  hit.dataset.vid = vid;
  g.append(dot, hit);
  $("#g-trains").append(g);
  return g;
}

async function refreshVehicles() {
  try {
    const j = await jget(
      `${MBTA}/vehicles?filter[route]=${RAIL_ROUTES.join(",")}` +
      `&fields[vehicle]=latitude,longitude,direction_id,current_status,updated_at&page[limit]=300`
    );
    if (!state.trains.size) setFigure($("#t-trains"), j.data.length);
    else $("#t-trains").textContent = j.data.length;
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
      t.el.style.display = routeVisible(route) ? "" : "none";
    }
    for (const [vid, t] of state.trains)
      if (!seen.has(vid)) { t.el.remove(); state.trains.delete(vid); }
    $("#live-mark").textContent = "live";
  } catch {
    $("#live-mark").textContent = "feed unreachable — retrying";
  }
}

/* One clock moves everything: trains glide linearly to their last-known
   target with 25% dead-reckoning past it, and the camera eases toward its
   own target — never a hop, never a jolt. */
function animate(now) {
  for (const t of state.trains.values()) {
    const dur = (t.dur || REFRESH_S) * 1000;
    const u = Math.min(1.25, (now - t.t0) / dur);
    t.s = t.sFrom + (t.sTarget - t.sFrom) * (reduced ? Math.min(1, u) : u);
    const [x, y] = t.pattern.path.pointAt(t.s);
    t.el.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
  }
  const ease = reduced ? 1 : 0.16;
  if (Math.abs(cam.x - cam.tx) + Math.abs(cam.y - cam.ty) + Math.abs(cam.w - cam.tw) > 0.05) {
    cam.x += (cam.tx - cam.x) * ease;
    cam.y += (cam.ty - cam.y) * ease;
    cam.w += (cam.tw - cam.w) * ease;
    cam.h += (cam.th - cam.h) * ease;
    const svg = $("#map");
    svg.setAttribute("viewBox", `${cam.x.toFixed(1)} ${cam.y.toFixed(1)} ${cam.w.toFixed(1)} ${cam.h.toFixed(1)}`);
    svg.classList.toggle("zoomed", cam.w < 620);
  }
  requestAnimationFrame(animate);
}

/* ---------------- tooltip + pinned panels ---------------- */
let panelToken = 0;

function showTip(clientX, clientY, text) {
  const tip = $("#map-tip");
  const plate = tip.closest(".plate").getBoundingClientRect();
  tip.textContent = text;
  tip.style.left = clientX - plate.left + "px";
  tip.style.top = clientY - plate.top - 30 + "px";
  tip.classList.add("show");
}
function hideTip() { $("#map-tip").classList.remove("show"); }

function placePanel(clientX, clientY) {
  const panel = $("#map-panel");
  const plate = panel.closest(".plate").getBoundingClientRect();
  panel.style.left = Math.min(plate.width - 330, Math.max(8, clientX - plate.left + 14)) + "px";
  panel.style.top = Math.max(8, clientY - plate.top - 10) + "px";
  panel.classList.add("show");
  return panel;
}
function closePanel() {
  state.pinned = null;
  $("#map-panel").classList.remove("show");
  dimExcept(null);
}
document.addEventListener("click", (e) => {
  if (e.target.closest(".map-panel .close")) closePanel();
});
addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });
const CLOSE_BTN = `<button class="close" aria-label="Close">✕</button>`;

async function showStationPanel(name, cx, cy) {
  const st = state.mbtaStops[name];
  if (!st) return;
  hideTip();
  state.pinned = { kind: "stn", name };
  const token = ++panelToken;
  const panel = placePanel(cx, cy);
  const marks = [...st.routes]
    .map((r) => `<span class="line-mark" style="--lc:${state.routes[r].color}">${r.startsWith("Green") ? r.slice(-1) : r[0]}</span>`)
    .join(" ");
  const rec = st.ids.map((id) => state.stationStats[`mbta:${id}`]).find(Boolean);
  const hist = rec
    ? `keeps ${Math.round(rec.within_1min * 100)}% of promises · median miss ${rec.median_err} min · n=${rec.n}`
    : "record accruing for this station";
  panel.innerHTML = `${CLOSE_BTN}<h4>${esc(name)}</h4>
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

function showTrainPanel(vid, cx, cy) {
  const t = state.trains.get(vid);
  if (!t?.meta) return;
  hideTip();
  panelToken++;
  state.pinned = { kind: "train", vid };
  dimExcept(t.meta.route);
  const panel = placePanel(cx, cy);
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
  panel.innerHTML = `${CLOSE_BTN}<h4><span class="line-mark" style="--lc:${state.routes[m.route]?.color}">${m.route.startsWith("Green") ? m.route.slice(-1) : m.route[0]}</span>
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

function calibrationFig(horizons, maxH, maxW) {
  // Shared axis domain across agencies so the figures compare honestly.
  const W = 480, H = 250, L = 40, B = 212, T = 16, R = 466;
  const x = (v) => L + ((R - L) * v) / maxH, y = (v) => B - ((B - T) * v) / maxW;
  const pts = horizons.map((d) => `${x(d.h).toFixed(1)},${y(d.mean_wait).toFixed(1)}`).join(" ");
  const step = maxH > 12 ? 10 : 5;
  let grid = "";
  for (let v = step; v <= maxH; v += step)
    grid += `<line class="axis" x1="${x(v)}" y1="${B}" x2="${x(v)}" y2="${B + 4}"/>
             <text x="${x(v)}" y="${B + 16}" text-anchor="middle">${v}</text>`;
  for (let v = step; v <= maxW; v += step)
    grid += `<line class="axis" x1="${L}" y1="${y(v)}" x2="${R}" y2="${y(v)}" opacity=".45"/>
             <text x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  return `<svg class="fig-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Promised versus actual wait">
    ${grid}
    <line class="axis" x1="${L}" y1="${B}" x2="${R}" y2="${B}"/><line class="axis" x1="${L}" y1="${T}" x2="${L}" y2="${B}"/>
    <polyline class="ideal" points="${x(0)},${y(0)} ${x(Math.min(maxH, maxW))},${y(Math.min(maxH, maxW))}"/>
    <polyline class="curve" points="${pts}"/>
    ${horizons.map((d) => `<circle class="dot" r="3" cx="${x(d.h).toFixed(1)}" cy="${y(d.mean_wait).toFixed(1)}"><title>said ${d.h} min → waited ${d.mean_wait} min (n=${d.n})</title></circle>`).join("")}
    <text x="${L + 6}" y="${T + 2}">actual wait, min</text>
    <text x="${R}" y="${B + 16}" text-anchor="end">promised, min</text>
    <text x="${x(Math.min(maxH, maxW)) - 8}" y="${y(Math.min(maxH, maxW)) + 14}" text-anchor="end">the diagonal is honesty</text>
  </svg>`;
}

async function renderRecord() {
  const body = $("#record-body");
  const names = { mbta: "The MBTA", bart: "BART", caltrain: "Caltrain" };
  try {
    const [summary, fresh] = await Promise.all([dget("data/summary.json"), dget("data/freshness.json")]);
    state.summary = summary;
    // One shared axis domain across every agency's figure.
    let maxH = 10, maxW = 10;
    for (const b of Object.values(summary.agencies || {}))
      for (const d of b.horizons || []) {
        maxH = Math.max(maxH, d.h);
        maxW = Math.max(maxW, d.mean_wait);
      }
    maxW = Math.max(maxW * 1.08, maxH);
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
        ${b.horizons?.length >= 3 ? calibrationFig(b.horizons, maxH, maxW) : `<p class="lede">The calibration curve is drawing itself — longer promises take longer to grade.</p>`}
      </div>`);
    }
    body.innerHTML = cards.join("") || `<div class="story"><p class="lede">The record opens with the observatory's first committed run.</p></div>`;
    const when = new Date((fresh.last_burst || fresh.built) * 1000);
    $("#record-foot").textContent =
      `Method: arrivals inferred from promise-stream convergence and disappearance; only arrivals with ≤120 s uncertainty are graded. ` +
      `Last observation ${when.toLocaleString()} · the ledger is append-only and public.`;
    setFigure($("#t-graded"), fresh.n_resolutions_window || 0);
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
    const cards = await dget("data/promises.json");
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
    const [days, summary] = await Promise.all([dget("data/days.json"), state.summary || dget("data/summary.json")]);
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
      const fresh = await dget("data/freshness.json");
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
  try { state.stationStats = await dget("data/stations.json"); } catch { /* accruing */ }
  for (const name of ["Park Street", "Harvard", "South Station"]) {
    const st = state.stations.find((s) => s.agency === "mbta" && s.name === name);
    if (st) state.boards.push(st.key);
  }
  const embr = state.stations.find((s) => s.agency === "bart" && s.name.startsWith("Embarcadero"));
  if (embr) state.boards.push(embr.key);
  renderBoards();
  setInterval(renderBoards, 35_000);

  // An open tab keeps up with the observatory: when a new observation
  // lands (freshness.json's build stamp changes), the record, ledger and
  // almanac quietly re-render themselves.
  let lastBuilt = 0;
  setInterval(async () => {
    try {
      const fresh = await dget("data/freshness.json");
      if (fresh.built && fresh.built !== lastBuilt) {
        if (lastBuilt) {
          renderRecord();
          renderLedger();
          renderAlmanac();
          try { state.stationStats = await dget("data/stations.json"); } catch { /* keep old */ }
        }
        lastBuilt = fresh.built;
      }
    } catch { /* next poll */ }
  }, 120_000);
})();
