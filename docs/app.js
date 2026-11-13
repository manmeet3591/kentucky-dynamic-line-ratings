/* Kentucky Dynamic Line Ratings */
(() => {
  const BREAKS = [0.8, 0.9, 1.0, 1.2, 1.5, 2.0];
  const BIN_LABELS = ["< 0.8", "0.8–0.9", "0.9–1.0", "1.0–1.2", "1.2–1.5", "1.5–2.0", "≥ 2.0"];
  const KVS = [69, 138, 161, 345, 500, 765];
  const SRC = {
    era5: { label: "Hindcast (ERA5)", short: "ERA5", hint: "ERA5 reanalysis: the reference for what the weather actually was (0.25° grid)." },
    d1: { label: "Forecast 1 day ahead", short: "Fcst +1 d", hint: "NOAA HRRR/GFS run issued ~1 day before each hour (Open-Meteo Previous Runs, gfs_seamless)." },
    d2: { label: "Forecast 2 days ahead", short: "Fcst +2 d", hint: "NOAA HRRR/GFS run issued ~2 days before each hour." },
    d3: { label: "Forecast 3 days ahead", short: "Fcst +3 d", hint: "NOAA GFS run issued ~3 days before each hour." },
  };
  const KIND = {
    dlr: "Dynamic line rating: hourly air temperature, wind speed and direction relative to each segment, and sun.",
    aar: "Ambient-adjusted rating (FERC Order 881): hourly air temperature and sun height, but the static 0.61 m/s wind. Uses the ERA5 hindcast.",
  };

  const state = { period: null, src: "era5", kind: "dlr", hour: 0, kvs: new Set(KVS), sel: null, playing: null };
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const cls = v => { let i = 0; while (i < BREAKS.length && v >= BREAKS[i]) i++; return i; };
  const col = v => (v == null ? css("--nodata") : css(`--x${cls(v)}`));
  const fmt = (v, d = 0) => (v == null || !isFinite(v) ? "–" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const pct = (v, d = 0) => (v == null ? "–" : fmt(v * 100, d) + " %");
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const title = s => (!s || /^NOT AVAILABLE$/i.test(s) ? "Owner not listed" : String(s)).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\bLlc\b/g, "LLC").replace(/\bTva\b/g, "TVA").replace(/\bEkpc\b/g, "EKPC");
  const tfmt = (iso, o = {}) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", ...o });
  const $ = id => document.getElementById(id);

  let D = { meta: null, lines: null, year: null }, P = null, map, lineLayer, layers = [], hiLayer = null, renderer;

  // ---------- data ----------
  const getJSON = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); });
  const getBin = u => fetch(u).then(r => { if (!r.ok) throw new Error(u); return r.arrayBuffer(); }).then(b => new Uint8Array(b));

  async function loadPeriod(id) {
    const p = D.meta.periods.find(x => x.id === id);
    const [era5, d1, d2, d3, aar, wx] = await Promise.all([
      ...["era5", "d1", "d2", "d3", "aar"].map(s => getBin(`data/${id}/${s}.bin`)),
      getJSON(`data/${id}/weather.json`),
    ]);
    P = { ...p, H: p.n_hours, bins: { era5, d1, d2, d3, aar }, wx };
    // night shading from ERA5 statewide mean irradiance
    const n = wx.era5.ghi.length;
    P.night = Array.from({ length: P.H }, (_, h) => { let s = 0; for (let i = 0; i < n; i++) s += wx.era5.ghi[i][h]; return s / n < 5; });
  }

  const bin = () => (state.kind === "aar" ? P.bins.aar : P.bins[state.src]);
  const ratioOf = (arr, l, h) => { const v = arr[l * P.H + h]; return v ? v / D.meta.scale : null; };
  const lineOn = l => state.kvs.has(D.lines.features[l].properties.kv);
  const staticAmps = (p, h) => (D.meta.winter_months.includes(new Date(P.times[h]).getUTCMonth() + 1) ? p.winter_a : p.summer_a);

  // ---------- map ----------
  function initMap() {
    map = L.map("map", { preferCanvas: true, zoomSnap: 0.25 }).setView([37.8, -85.7], 7);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const esri = s => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${s}/MapServer/tile/{z}/{y}/{x}`;
    L.tileLayer(esri(dark ? "World_Dark_Gray_Base" : "World_Light_Gray_Base"), {
      attribution: "Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors · lines: HIFLD", maxZoom: 16,
    }).addTo(map);
    map.createPane("lines").style.zIndex = 420;
    map.createPane("labels").style.zIndex = 450;
    map.getPane("labels").style.pointerEvents = "none";
    L.tileLayer(esri(dark ? "World_Dark_Gray_Reference" : "World_Light_Gray_Reference"), { pane: "labels", maxZoom: 16 }).addTo(map);
    renderer = L.canvas({ pane: "lines", tolerance: 5 });
    // draw low voltage first so the big lines sit on top
    const order = D.lines.features.map((f, i) => i).sort((a, b) => D.lines.features[a].properties.kv - D.lines.features[b].properties.kv);
    lineLayer = L.layerGroup().addTo(map);
    layers = new Array(D.lines.features.length);
    for (const i of order) {
      const f = D.lines.features[i];
      const lyr = L.geoJSON(f, { renderer, style: () => ({ weight: wt(f.properties.kv), opacity: 0.95 }) });
      lyr.on("mouseover", e => { lyr.setStyle({ weight: wt(f.properties.kv) + 2.5 }); })
        .on("mouseout", () => lyr.setStyle({ weight: wt(f.properties.kv) }))
        .on("click", () => select(i));
      lyr.bindTooltip(() => tip(i), { sticky: true, className: "tt" });
      layers[i] = lyr;
      lineLayer.addLayer(lyr);
    }
    D.bounds = L.featureGroup(layers).getBounds();
    map.fitBounds(D.bounds, { padding: [8, 8] });
  }
  const wt = kv => (kv >= 345 ? 3.6 : kv >= 138 ? 2.4 : 1.5);

  function tip(i) {
    const p = D.lines.features[i].properties, r = ratioOf(bin(), i, state.hour);
    const st = staticAmps(p, state.hour);
    return `<b>${esc(title(p.owner))}</b><span class="m">${p.kv} kV · ${fmt(p.km, 1)} km · HIFLD ${esc(p.line_id)}</span><br>` +
      `${state.kind === "aar" ? "AAR" : "DLR"} / static: <b style="display:inline">${fmt(r, 2)}×</b>` +
      (r ? `<br><span class="m">≈ ${fmt(r * st)} A vs static ${fmt(st)} A</span>` : "");
  }

  function restyle() {
    const a = bin();
    for (let i = 0; i < layers.length; i++) {
      const on = lineOn(i);
      if (!on) { layers[i].setStyle({ opacity: 0 }); continue; }
      const r = ratioOf(a, i, state.hour);
      layers[i].setStyle({ color: col(r), opacity: 0.95, weight: wt(D.lines.features[i].properties.kv) });
    }
    // selected line: dark halo with the line's own colour on top
    if (hiLayer) { map.removeLayer(hiLayer); hiLayer = null; }
    if (state.sel != null) {
      const f = D.lines.features[state.sel], w = wt(f.properties.kv) + 2;
      hiLayer = L.layerGroup([
        L.geoJSON(f, { renderer, interactive: false, style: { color: css("--ink"), weight: w + 4, opacity: 1 } }),
        L.geoJSON(f, { renderer, interactive: false, style: { color: col(ratioOf(a, state.sel, state.hour)), weight: w, opacity: 1 } }),
      ]).addTo(map);
    }
  }

  function legend() {
    $("legend").innerHTML = `<div class="blk"><div class="t">${state.kind === "aar" ? "Ambient-adjusted" : "Dynamic"} rating ÷ static rating</div>
      <div class="bar">${BIN_LABELS.map((_, i) => `<i style="background:${css(`--x${i}`)}"></i>`).join("")}</div>
      <div class="ticks">${["", "0.8", "0.9", "1.0", "1.2", "1.5", "2.0"].map(t => `<span>${t}</span>`).join("")}</div>
      <div class="ends"><span>← below static</span><span>headroom →</span></div></div>`;
  }

  // ---------- controls ----------
  function controls() {
    $("periods").innerHTML = D.meta.periods.map(p =>
      `<button data-p="${p.id}"><b>${esc(p.name)}</b><small>${dateRange(p)}</small></button>`).join("");
    $("periods").onclick = e => { const b = e.target.closest("button"); if (b) setPeriod(b.dataset.p); };
    $("src").onclick = e => { const b = e.target.closest("button"); if (!b) return; state.src = b.dataset.src; update(); };
    $("kind").onclick = e => { const b = e.target.closest("button"); if (!b) return; state.kind = b.dataset.kind; update(); };
    $("kvs").innerHTML = KVS.map(kv => {
      const n = D.lines.features.filter(f => f.properties.kv === kv);
      const km = n.reduce((s, f) => s + f.properties.km, 0);
      return `<label class="chk"><input type="checkbox" data-kv="${kv}" checked> ${kv} kV <span class="n">${n.length} · ${fmt(km)} km</span></label>`;
    }).join("");
    $("kvs").onchange = e => { const kv = +e.target.dataset.kv; e.target.checked ? state.kvs.add(kv) : state.kvs.delete(kv); update(); };
    $("slider").oninput = e => { state.hour = +e.target.value; updateHour(); };
    $("play").onclick = togglePlay;
    document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => view(b.dataset.view));
  }
  const dateRange = p => {
    const o = { month: "short", day: "numeric", timeZone: "UTC" };
    const a = new Date(p.start + "T12:00:00Z"), b = new Date(p.end + "T12:00:00Z");
    return `${a.toLocaleDateString("en-US", o)} – ${b.toLocaleDateString("en-US", { ...o, year: "numeric" })}`;
  };

  function togglePlay() {
    if (state.playing) { clearInterval(state.playing); state.playing = null; $("play").textContent = "▶"; return; }
    $("play").textContent = "❚❚";
    state.playing = setInterval(() => { state.hour = (state.hour + 1) % P.H; $("slider").value = state.hour; updateHour(); }, 350);
  }

  function view(v) {
    document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.view === v));
    const mapV = v === "map";
    document.querySelectorAll(".controls, #view-map, .detail").forEach(e => e.classList.toggle("hidden", !mapV));
    $("view-year").classList.toggle("hidden", v !== "year");
    $("view-method").classList.toggle("hidden", v !== "method");
    if (mapV) map.invalidateSize();
    if (v === "year") renderYear();
  }

  async function setPeriod(id) {
    state.period = id;
    document.querySelectorAll("#periods button").forEach(b => b.classList.toggle("on", b.dataset.p === id));
    await loadPeriod(id);
    $("pblurb").textContent = P.blurb;
    $("slider").max = P.H - 1;
    // start at the hour with the lowest 5th-percentile hindcast ratio: the tightest moment
    const s = stats(P.bins.era5);
    state.hour = s.p05.indexOf(Math.min(...s.p05.filter(v => v != null)));
    $("slider").value = state.hour;
    update();
  }

  // per-hour statistics across visible lines
  function stats(arr) {
    const p05 = [], p50 = [], vis = [];
    for (let l = 0; l < D.lines.features.length; l++) if (lineOn(l)) vis.push(l);
    for (let h = 0; h < P.H; h++) {
      const v = [];
      for (const l of vis) { const r = arr[l * P.H + h]; if (r) v.push(r); }
      v.sort((a, b) => a - b);
      p05.push(v.length ? v[Math.floor(v.length * 0.05)] / D.meta.scale : null);
      p50.push(v.length ? v[Math.floor(v.length * 0.5)] / D.meta.scale : null);
    }
    return { p05, p50, vis };
  }

  function update() {
    document.querySelectorAll("#src button").forEach(b => { b.classList.toggle("on", b.dataset.src === state.src); b.disabled = state.kind === "aar"; b.style.opacity = state.kind === "aar" ? .45 : 1; });
    document.querySelectorAll("#kind button").forEach(b => b.classList.toggle("on", b.dataset.kind === state.kind));
    $("srcHint").textContent = state.kind === "aar" ? "AAR uses the ERA5 hindcast temperature." : SRC[state.src].hint;
    $("kindHint").textContent = KIND[state.kind];
    P.stat = stats(bin());
    legend();
    timeline();
    periodShare();
    skill();
    updateHour();
  }

  function updateHour() {
    $("tlabel").textContent = tfmt(P.times[state.hour], { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    restyle();
    kpis();
    rank();
    timelineNow();
    renderLine();
  }

  // ---------- timeline ----------
  const TW = 240, TH = 64;
  function timeline() {
    const { p05, p50 } = P.stat;
    const all = [...p05, ...p50].filter(v => v != null);
    const lo = Math.min(0.7, ...all), hi = Math.max(1.3, ...all);
    const x = h => (h / (P.H - 1)) * TW, y = v => TH - 4 - ((v - lo) / (hi - lo)) * (TH - 8);
    const path = a => a.map((v, h) => (v == null ? "" : `${h && a[h - 1] != null ? "L" : "M"}${x(h).toFixed(1)},${y(v).toFixed(1)}`)).join("");
    let night = "";
    P.night.forEach((n, h) => { if (n) night += `<rect class="night" x="${x(h - 0.5)}" y="0" width="${TW / (P.H - 1)}" height="${TH}"/>`; });
    $("tl").innerHTML = `<svg viewBox="0 0 ${TW} ${TH}" preserveAspectRatio="none" aria-label="Statewide ratio over the period">${night}
      <line class="one" x1="0" x2="${TW}" y1="${y(1)}" y2="${y(1)}" vector-effect="non-scaling-stroke"/>
      <path class="p50" d="${path(p50)}" vector-effect="non-scaling-stroke"/><path class="p05" d="${path(p05)}" vector-effect="non-scaling-stroke"/>
      <line class="now" id="tlnow" y1="0" y2="${TH}" vector-effect="non-scaling-stroke"/></svg>
      <div class="k"><span><i style="background:${css("--ink-2")}"></i>median</span><span><i style="background:${css("--x1")}"></i>tightest 5 %</span><span>- - 1.0</span><span>▮ night</span></div>`;
    const svg = $("tl").querySelector("svg");
    svg.onclick = e => { const r = svg.getBoundingClientRect(); state.hour = Math.round(((e.clientX - r.left) / r.width) * (P.H - 1)); $("slider").value = state.hour; updateHour(); };
  }
  function timelineNow() {
    const l = $("tlnow"); if (!l) return;
    const xx = (state.hour / (P.H - 1)) * TW; l.setAttribute("x1", xx); l.setAttribute("x2", xx);
  }

  // ---------- right panel ----------
  function kpis() {
    const a = bin(), v = [];
    for (const l of P.stat.vis) { const r = ratioOf(a, l, state.hour); if (r) v.push(r); }
    v.sort((x, y) => x - y);
    const share = f => (v.length ? v.filter(f).length / v.length : null);
    $("nowTitle").textContent = `This hour · ${state.kind === "aar" ? "AAR" : SRC[state.src].short}`;
    $("kpis").innerHTML = [
      [pct(share(r => r >= 1.2)), "lines with ≥ 20 % headroom"],
      [pct(share(r => r < 1)), "lines below static rating"],
      [fmt(v[Math.floor(v.length / 2)], 2) + "×", "median line"],
      [fmt(v[0], 2) + "×", "tightest line"],
    ].map(([b, s]) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`).join("");
  }

  function shareRow(arr) {
    const c = new Array(7).fill(0); let n = 0;
    for (const l of P.stat.vis) for (let h = 0; h < P.H; h++) { const v = arr[l * P.H + h]; if (v) { c[cls(v / D.meta.scale)]++; n++; } }
    return { f: c.map(x => x / (n || 1)), n };
  }
  function stackBar(f) {
    return `<div class="stack">${f.map((x, i) => `<i style="width:${x * 100}%;background:${css(`--x${i}`)}" title="${BIN_LABELS[i]}: ${pct(x, 1)}"></i>`).join("")}</div>`;
  }
  function periodShare() {
    const cur = shareRow(bin());
    const head = cur.f.slice(3).reduce((a, b) => a + b, 0), def = cur.f.slice(0, 3).reduce((a, b) => a + b, 0);
    const rows = [["era5", "ERA5"], ["d1", "+1 day"], ["d2", "+2 days"], ["d3", "+3 days"], ["aar", "AAR"]]
      .map(([k, lab]) => `<div class="srow"><span>${lab}</span>${stackBar(shareRow(P.bins[k]).f)}</div>`).join("");
    $("perTitle").textContent = `Line-hours, whole period`;
    $("pshare").innerHTML = `<div class="kpis"><div class="kpi"><b>${pct(head)}</b><span>with headroom (≥ 1.0×)</span></div>
      <div class="kpi"><b>${pct(def)}</b><span>with a deficit (&lt; 1.0×)</span></div></div>
      ${rows}<p class="hint">Share of the period's line-hours in each ratio class (colours as on the map), for each weather source. ${fmt(cur.n)} line-hours shown.</p>`;
  }

  function rank() {
    const a = bin(), v = [];
    for (const l of P.stat.vis) { const r = ratioOf(a, l, state.hour); if (r) v.push([l, r]); }
    v.sort((x, y) => x[1] - y[1]);
    $("rank").innerHTML = v.slice(0, 10).map(([l, r]) => {
      const p = D.lines.features[l].properties;
      return `<li data-l="${l}">${esc(title(p.owner))} <span style="color:var(--muted)">${p.kv} kV · ${fmt(p.km)} km</span><span class="s">${fmt(r, 2)}×</span></li>`;
    }).join("");
    $("rank").onclick = e => { const li = e.target.closest("li"); if (li) select(+li.dataset.l, true); };
  }

  function skill() {
    const s = D.meta.skill[P.id];
    $("skill").innerHTML = `<div class="tablewrap"><table class="skill"><tr><th>Lead</th><th title="mean absolute error of the DLR/static ratio vs ERA5">MAE</th><th title="mean forecast minus hindcast ratio">Bias</th><th title="forecast says ≥1.0 but hindcast says <1.0">False headroom</th></tr>
      ${["d1", "d2", "d3"].map(k => `<tr><td>${SRC[k].short}</td><td>${fmt(s[k].mae, 3)}</td><td>${s[k].bias > 0 ? "+" : ""}${fmt(s[k].bias, 3)}</td><td>${pct(s[k].false_headroom, 1)}</td></tr>`).join("")}
      </table></div><p class="hint">Scored against the ERA5 hindcast in ratio units over all line-hours. "False headroom" = the forecast said the line could carry more than its static rating, but the hindcast said less. That is the miss that matters for operations.</p>`;
  }

  // ---------- line detail ----------
  function select(i, fly) {
    state.sel = i;
    restyle();
    renderLine();
    if (fly) map.fitBounds(layers[i].getBounds(), { maxZoom: 10, padding: [40, 40] });
  }

  function renderLine() {
    const el = $("line");
    if (state.sel == null) { el.innerHTML = `<p class="empty">Click a line on the map to see its rating over the period.</p>`; return; }
    const i = state.sel, p = D.lines.features[i].properties;
    const st = D.meta.static[p.kv];
    const amps = k => Array.from({ length: P.H }, (_, h) => { const r = ratioOf(P.bins[k], i, h); return r ? r * staticAmps(p, h) : null; });
    const series = [
      { k: "static", lab: "Static", c: "--s-static", d: Array.from({ length: P.H }, (_, h) => staticAmps(p, h)), dash: true },
      { k: "aar", lab: "AAR", c: "--s-aar", d: amps("aar"), dash: true },
      { k: "d3", lab: "Fcst +3 d", c: "--s-d3", d: amps("d3") },
      { k: "d2", lab: "Fcst +2 d", c: "--s-d2", d: amps("d2") },
      { k: "d1", lab: "Fcst +1 d", c: "--s-d1", d: amps("d1") },
      { k: "era5", lab: "DLR (ERA5)", c: "--s-era5", d: amps("era5"), w: 2.2 },
    ];
    const node = P.wx.line_node[i];
    const wxs = k => ({ ta: P.wx[k].ta[node], ws: P.wx[k].ws[node] });
    const nn = P.wx.nodes[node];
    el.innerHTML = `<div class="cty"><h3><span>${esc(title(p.owner))}</span><button id="clr">close</button></h3>
      <div class="score">${p.kv} kV · ${fmt(p.km, 1)} km in Kentucky · ${p.nseg} segments · HIFLD ${esc(p.line_id)}</div>
      <div class="facts"><div><span>Assumed conductor</span><b>${st.n_sub > 1 ? st.n_sub + " × " : ""}${esc(st.conductor.replace(/ ACSR.*'(.*)'/, " $1"))}</b></div>
      <div><span>Static summer / winter</span><b>${fmt(p.summer_a)} / ${fmt(p.winter_a)} A</b></div></div>
      <h2>Rating, amps</h2>
      <div class="chart" id="cA"></div>
      <div class="ckey">${series.slice().reverse().map(s => `<span><i class="${s.dash ? "dash" : ""}" style="border-color:${css(s.c)}"></i>${s.lab}</span>`).join("")}</div>
      <h2 class="mt">Weather at the limiting node (${fmt(nn[0], 2)}° N, ${fmt(-nn[1], 2)}° W)</h2>
      <div class="chart" id="cT"></div><div class="chart" id="cW"></div>
      <div class="ckey"><span><i style="border-color:${css("--s-era5")}"></i>ERA5</span><span><i style="border-color:${css("--s-d1")}"></i>Fcst +1 d</span><span><i style="border-color:${css("--s-d3")}"></i>Fcst +3 d</span></div>
      </div>`;
    $("clr").onclick = () => { state.sel = null; restyle(); renderLine(); };
    chart($("cA"), series, { h: 150, unit: " A", d: 0 });
    chart($("cT"), [{ lab: "ERA5", c: "--s-era5", d: wxs("era5").ta, w: 1.8 }, { lab: "+1 d", c: "--s-d1", d: wxs("d1").ta }, { lab: "+3 d", c: "--s-d3", d: wxs("d3").ta }], { h: 70, unit: " °C", d: 1, title: "Air temperature" });
    chart($("cW"), [{ lab: "ERA5", c: "--s-era5", d: wxs("era5").ws, w: 1.8 }, { lab: "+1 d", c: "--s-d1", d: wxs("d1").ws }, { lab: "+3 d", c: "--s-d3", d: wxs("d3").ws }], { h: 70, unit: " m/s", d: 1, title: "Wind 10 m", zero: true });
  }

  function chart(el, series, o) {
    const W = 300, H = o.h, L = 38, R = 4, T = o.title ? 14 : 6, B = 16;
    const all = series.flatMap(s => s.d).filter(v => v != null);
    let lo = Math.min(...all), hi = Math.max(...all);
    if (o.zero) lo = 0;
    const pad = (hi - lo) * 0.08 || 1; lo -= o.zero ? 0 : pad; hi += pad;
    const x = h => L + (h / (P.H - 1)) * (W - L - R), y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const ticks = niceTicks(lo, hi, o.h > 100 ? 4 : 3);
    const days = [];
    P.times.forEach((t, h) => { if (new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }) === "0") days.push(h); });
    const path = a => a.map((v, h) => (v == null ? "" : `${h && a[h - 1] != null ? "L" : "M"}${x(h).toFixed(1)},${y(v).toFixed(1)}`)).join("");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
      ${o.title ? `<text class="ax" x="${L}" y="9">${o.title}</text>` : ""}
      ${ticks.map(t => `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${L - 4}" y="${y(t) + 3.5}" text-anchor="end">${fmt(t, Math.abs(t) < 10 && o.d ? 1 : 0)}</text>`).join("")}
      ${days.map(h => `<line class="gl" x1="${x(h)}" x2="${x(h)}" y1="${T}" y2="${H - B}"/><text class="ax" x="${x(h) + 2}" y="${H - 4}">${new Date(P.times[h]).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}</text>`).join("")}
      ${series.map(s => `<path class="ser" d="${path(s.d)}" style="stroke:${css(s.c)};stroke-width:${s.w || 1.3}" ${s.dash ? 'stroke-dasharray="4 3"' : ""}/>`).join("")}
      <line class="now" x1="${x(state.hour)}" x2="${x(state.hour)}" y1="${T}" y2="${H - B}"/>
      <line class="hov" id="hv" y1="${T}" y2="${H - B}" style="display:none"/>
      <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg>`;
    const svg = el.querySelector("svg"), hv = svg.querySelector("#hv");
    let tipEl = null;
    svg.onmousemove = e => {
      const r = svg.getBoundingClientRect();
      const h = Math.max(0, Math.min(P.H - 1, Math.round(((e.clientX - r.left) / r.width * W - L) / (W - L - R) * (P.H - 1))));
      hv.setAttribute("x1", x(h)); hv.setAttribute("x2", x(h)); hv.style.display = "";
      if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "ctip"; el.appendChild(tipEl); }
      tipEl.innerHTML = `<b>${tfmt(P.times[h])}</b>` + series.slice().reverse().map(s => `<div><span style="color:${css(s.c)}">${s.lab}</span><span>${fmt(s.d[h], o.d)}${o.unit}</span></div>`).join("");
      const px = (x(h) / W) * r.width;
      tipEl.style.left = (px > r.width / 2 ? px - tipEl.offsetWidth - 8 : px + 8) + "px";
    };
    svg.onmouseleave = () => { hv.style.display = "none"; if (tipEl) { tipEl.remove(); tipEl = null; } };
    svg.onclick = e => {
      const r = svg.getBoundingClientRect();
      state.hour = Math.max(0, Math.min(P.H - 1, Math.round(((e.clientX - r.left) / r.width * W - L) / (W - L - R) * (P.H - 1))));
      $("slider").value = state.hour; updateHour();
    };
  }
  function niceTicks(lo, hi, n) {
    const step0 = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0);
    const out = []; for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(+t.toFixed(6));
    return out;
  }

  // ---------- year tab ----------
  function renderYear() {
    const Y = D.year, el = $("year");
    if (!Y) { el.innerHTML = `<p class="empty">Year statistics not built yet.</p>`; return; }
    const head = Y.total.slice(3).reduce((a, b) => a + b, 0), def = Y.total.slice(0, 3).reduce((a, b) => a + b, 0);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const leg = `<div class="ckey">${BIN_LABELS.map((b, i) => `<span><i style="border-top:10px solid ${css(`--x${i}`)};width:12px"></i>${b}</span>`).join("")}</div>`;
    const n = D.lines.features.length;
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => Y.lines.deficit[b] - Y.lines.deficit[a]);
    const kmDef = idx.reduce((s, i) => s + (Y.lines.deficit[i] > 0.01 ? D.lines.features[i].properties.km : 0), 0);
    el.innerHTML = `<h2>Hourly DLR ÷ static rating over ${Y.year}, ERA5 hindcast, all ${fmt(n)} lines</h2>
      <div class="kpis k3" style="max-width:760px">
        <div class="kpi"><b>${pct(head)}</b><span>of line-hours: DLR ≥ static (headroom)</span></div>
        <div class="kpi"><b>${pct(Y.total.slice(4).reduce((a, b) => a + b, 0))}</b><span>≥ 1.2× static</span></div>
        <div class="kpi"><b>${pct(Y.total.slice(5).reduce((a, b) => a + b, 0))}</b><span>≥ 1.5× static</span></div>
        <div class="kpi"><b>${pct(def, 1)}</b><span>DLR &lt; static (deficit)</span></div>
        <div class="kpi"><b>${pct(Y.total[0] + Y.total[1], 2)}</b><span>DLR &lt; 0.9× static</span></div>
        <div class="kpi"><b>${fmt(kmDef)} km</b><span>on lines with &gt; 1 % deficit hours</span></div>
      </div>
      <p class="hint">${fmt(Y.line_hours)} line-hours. Each line's rating is its tightest ~1 km segment. Static = summer rating Mar–Nov, winter rating Dec–Feb (method tab).</p>
      ${leg}
      <div class="ygrid mt">
        <div class="card"><h3>By month</h3>${Y.labels && months.map((m, i) => `<div class="srow"><span>${m}</span>${stackBar(Y.monthly[i + 1])}</div>`).join("")}
          <p class="hint">Deficits cluster in calm, sunny hours that are warmer than the static assumption. Winter is worst: the 5 °C winter rating is exceeded on mild sunny days.</p></div>
        <div class="card"><h3>By hour of day (Eastern)</h3>${Y.hourly.map((f, h) => (h % 2 ? "" : `<div class="srow"><span>${h}:00</span>${stackBar(f)}</div>`)).join("")}
          <p class="hint">Every other hour shown. Afternoon sun plus light wind give the least headroom; nights and windy afternoons give the most.</p></div>
        <div class="card"><h3>By voltage class</h3>${Object.entries(Y.by_kv).map(([kv, f]) => `<div class="srow"><span>${kv} kV</span>${stackBar(f)}</div>`).join("")}
          <p class="hint">Bigger conductors and bundles respond differently to the same weather. Long lines also cross more grid cells, so their weakest segment is lower.</p></div>
        <div class="card"><h3>Lines with the most deficit hours</h3>
          <div class="tablewrap" style="max-height:340px"><table id="ytbl"><tr><th>Line</th><th>kV</th><th>km</th><th title="share of hours DLR < static">&lt;1.0</th><th title="share of hours DLR < 0.9 static">&lt;0.9</th><th title="share of hours AAR < static">AAR &lt;1</th><th title="5th percentile ratio">p05</th><th title="median ratio">median</th></tr>
          ${idx.slice(0, 25).map(i => { const p = D.lines.features[i].properties, s = Y.lines; return `<tr data-l="${i}"><td>${esc(title(p.owner))}</td><td>${p.kv}</td><td>${fmt(p.km, 0)}</td><td>${pct(s.deficit[i], 1)}</td><td>${pct(s.deficit10[i], 1)}</td><td>${pct(s.aar_deficit[i], 1)}</td><td>${fmt(s.p05[i], 2)}</td><td>${fmt(s.p50[i], 2)}</td></tr>`; }).join("")}
          </table></div><p class="hint">Click a line to open it on the map.</p></div>
      </div>`;
    $("ytbl").onclick = e => { const tr = e.target.closest("tr[data-l]"); if (!tr) return; view("map"); select(+tr.dataset.l, true); };
  }

  // ---------- method tab ----------
  function method() {
    const m = D.meta;
    document.querySelectorAll(".built").forEach(e => (e.textContent = m.built));
    const set = (c, v) => document.querySelectorAll(c).forEach(e => (e.textContent = v));
    set(".m-lines", fmt(m.n_lines)); set(".m-km", fmt(m.km)); set(".m-seg", fmt(m.n_segments)); set(".m-nodes", m.n_nodes);
    set(".m-tmax", m.t_max); set(".m-eps", m.emissivity); set(".m-abs", m.absorptivity);
    const sa = m.static_assumptions;
    set(".m-ss", `${sa.summer.ta} °C ambient, sun height ${sa.summer.sun_alt}°`);
    set(".m-sw", `${sa.winter.ta} °C ambient, sun height ${sa.winter.sun_alt}°`);
    $("condTbl").innerHTML = `<tr><th>Voltage</th><th>Assumed conductor</th><th>Per phase</th><th>Static summer</th><th>Static winter</th></tr>` +
      Object.entries(m.static).map(([kv, s]) => `<tr><td style="color:var(--ink);cursor:default">${kv} kV${kv === "230" ? " (none in KY)" : ""}</td><td>${esc(s.conductor)}</td><td>${s.n_sub}</td><td>${fmt(s.summer)} A</td><td>${fmt(s.winter)} A</td></tr>`).join("");
  }

  // ---------- boot ----------
  async function boot() {
    [D.meta, D.lines] = await Promise.all([getJSON("data/meta.json"), getJSON("data/lines.geojson")]);
    D.year = await getJSON("data/year.json").catch(() => null);
    method();
    initMap();
    controls();
    // deep link: #p=<period>&src=<era5|d1|d2|d3>&kind=<dlr|aar>&l=<HIFLD id>&v=<map|year|method>
    const q = new URLSearchParams(location.hash.slice(1));
    if (SRC[q.get("src")]) state.src = q.get("src");
    if (KIND[q.get("kind")]) state.kind = q.get("kind");
    const pid = D.meta.periods.some(p => p.id === q.get("p")) ? q.get("p") : D.meta.periods[1].id;
    await setPeriod(pid);
    map.invalidateSize();
    map.fitBounds(D.bounds, { padding: [8, 8] });
    const li = D.lines.features.findIndex(f => f.properties.line_id === q.get("l"));
    if (li >= 0) select(li, true);
    if (q.get("v")) view(q.get("v"));
  }
  boot();
})();
