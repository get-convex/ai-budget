// Self-contained admin dashboard served by the component over HTTP (see
// AIBudget.registerRoutes). Plain HTML/CSS/JS — no build step, no framework —
// so it ships inside the published package as a string. `__API_BASE__` and
// `__TOKEN__` are substituted at serve time; the page talks only to the
// component's own JSON API under API_BASE.
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Budget</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --border: #262b36; --muted: #8b93a7;
    --fg: #e6e9ef; --accent: #6ea8fe; --accent2: #4ade80; --danger: #f87171;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  header { padding: 14px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; }
  header .sub { color: var(--muted); font-size: 12px; }
  nav { display: flex; gap: 8px; padding: 10px 20px; border-bottom: 1px solid var(--border); }
  nav button { background: transparent; color: var(--muted); border: 1px solid transparent; padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; }
  nav button.active { background: var(--panel); color: var(--fg); border-color: var(--border); }
  main { padding: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; }
  td.mono, .mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
  input, select { background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 5px; padding: 4px 6px; font: inherit; width: 90px; }
  button.act { background: var(--panel); color: var(--fg); border: 1px solid var(--border); border-radius: 5px; padding: 3px 8px; cursor: pointer; font-size: 12px; }
  button.act:hover { border-color: var(--accent); }
  .row { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  .pill { font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border); color: var(--muted); }
  .ok { color: var(--accent2); } .bad { color: var(--danger); }
  .bars { display: flex; align-items: flex-end; gap: 3px; height: 120px; padding-top: 10px; }
  .bar { background: var(--accent); border-radius: 2px 2px 0 0; min-width: 8px; flex: 1; position: relative; }
  .bar span { position: absolute; bottom: -18px; left: 0; right: 0; text-align: center; font-size: 9px; color: var(--muted); }
  .muted { color: var(--muted); } h2 { font-size: 14px; margin: 18px 0 8px; }
  .err { color: var(--danger); padding: 10px; }
</style>
</head>
<body>
<header>
  <h1>☂️ AI Budget</h1>
  <span class="sub">component admin dashboard</span>
  <span id="total" class="sub" style="margin-left:auto"></span>
</header>
<nav>
  <button data-tab="buckets" class="active">Buckets</button>
  <button data-tab="requests">Requests</button>
  <button data-tab="usage">Usage</button>
  <button data-tab="settings">Settings</button>
</nav>
<main id="main"></main>
<script>
// Injected as JSON literals by registerRoutes (no surrounding quotes here).
const API = __API_BASE__;
const TOKEN = __TOKEN__;
// If we were opened with ?token=… (needed for the initial navigation, which
// can't set headers), drop it from the address bar so it doesn't linger in
// history; API calls below use the Authorization header instead.
try {
  const u = new URL(location.href);
  if (u.searchParams.has("token")) { u.searchParams.delete("token"); history.replaceState(null, "", u.toString()); }
} catch (e) {}
const H = TOKEN ? { Authorization: "Bearer " + TOKEN } : {};
const NANOS = 1e9;
const usd = (n) => n == null ? "—" : "$" + (n / NANOS).toFixed(n && n < NANOS/100 ? 6 : 2);
const q = (o) => Object.entries(o).filter(([,v]) => v != null && v !== "").map(([k,v]) => k+"="+encodeURIComponent(v)).join("&");
async function get(path, params) { const r = await fetch(API + path + (params ? "?" + q(params) : ""), { headers: H, credentials: "same-origin" }); if (!r.ok) throw new Error(await r.text()); return r.json(); }
async function post(path, body) { const r = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json", ...H }, credentials: "same-origin", body: JSON.stringify(body) }); if (!r.ok) throw new Error(await r.text()); return r.json(); }
const el = (t, a = {}, kids = []) => { const e = document.createElement(t); for (const k in a) { if (k === "class") e.className = a[k]; else if (k.startsWith("on")) e.addEventListener(k.slice(2), a[k]); else if (k === "value") e.value = a[k] ?? ""; else e.setAttribute(k, a[k]); } for (const c of [].concat(kids)) e.append(c?.nodeType ? c : document.createTextNode(c ?? "")); return e; };
const main = document.getElementById("main");
let tab = "buckets";

document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => { tab = b.dataset.tab; document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b)); render(); }));

// number input that saves on Enter/blur
function numInput(value, onSave, { money = false, width = 90 } = {}) {
  const shown = value == null ? "" : money ? value / NANOS : value;
  const i = el("input", { value: shown, style: "width:" + width + "px" });
  const save = () => { const t = i.value.trim(); onSave(t === "" ? undefined : money ? Math.round(Number(t) * NANOS) : Number(t)); };
  i.addEventListener("keydown", (e) => { if (e.key === "Enter") i.blur(); });
  i.addEventListener("blur", save);
  return i;
}

async function render() {
  main.innerHTML = "";
  try { await ({ buckets: renderBuckets, requests: renderRequests, usage: renderUsage, settings: renderSettings }[tab])(); }
  catch (e) { main.append(el("div", { class: "err" }, "Error: " + e.message)); }
}

async function renderBuckets() {
  const dims = ["user", "action"];
  const state = { dimension: window.__dim ?? "" };
  const rows = await get("/buckets", state.dimension ? { dimension: state.dimension } : {});
  const grand = rows.reduce((s, b) => s + b.totalSpendNanos, 0);
  document.getElementById("total").textContent = rows.length + " buckets · " + usd(grand) + " total";
  const dimSet = [...new Set(rows.map((b) => b.dimension).concat(dims))];
  const sel = el("select", { value: state.dimension, style: "width:140px",
    onchange: (e) => { window.__dim = e.target.value; render(); } },
    [el("option", { value: "" }, "all dimensions")].concat(dimSet.map((d) => el("option", { value: d }, d))));
  main.append(el("div", { class: "row" }, ["Dimension:", sel]));

  const head = ["dimension", "value", "today", "month", "total", "daily $", "monthly $", "warn %", "max/min", "blocked", ""];
  const table = el("table", {}, el("thead", {}, el("tr", {}, head.map((h) => el("th", {}, h)))));
  const body = el("tbody");
  for (const b of rows) {
    const set = (patch) => post("/setLimits", { dimension: b.dimension, value: b.value, ...patch }).then(render);
    body.append(el("tr", {}, [
      el("td", { class: "mono muted" }, b.dimension),
      el("td", {}, el("b", {}, b.value)),
      el("td", { class: "mono" }, usd(b.spendTodayNanos)),
      el("td", { class: "mono" }, usd(b.spendThisMonthNanos)),
      el("td", { class: "mono" }, usd(b.totalSpendNanos)),
      el("td", {}, numInput(b.dailySpendLimitNanos, (v) => set({ dailySpendLimitNanos: v }), { money: true })),
      el("td", {}, numInput(b.monthlySpendLimitNanos, (v) => set({ monthlySpendLimitNanos: v }), { money: true })),
      el("td", {}, numInput(b.warnAtPct == null ? undefined : Math.round(b.warnAtPct * 100), (v) => set({ warnAtPct: v == null ? undefined : v / 100 }), { width: 55 })),
      el("td", {}, numInput(b.maxConcurrent, (v) => set({ maxConcurrent: v }), { width: 55 })),
      el("td", {}, el("input", { type: "checkbox", style: "width:auto", ...(b.blocked ? { checked: "" } : {}), onchange: (e) => set({ blocked: e.target.checked }) })),
      el("td", {}, [
        el("button", { class: "act", onclick: () => post("/adjust", { dimension: b.dimension, value: b.value, deltaNanos: -NANOS, reason: "dashboard credit" }).then(render) }, "−$1"),
        " ",
        el("button", { class: "act", onclick: () => post("/bump", { dimension: b.dimension, value: b.value, dailyNanos: NANOS }).then(render) }, "+$1 today"),
      ]),
    ]));
  }
  table.append(body);
  main.append(table);
}

async function renderRequests() {
  const filter = window.__reqFilter ?? {};
  const dimInput = el("input", { value: filter.dimension ?? "", placeholder: "dimension", style: "width:110px" });
  const valInput = el("input", { value: filter.value ?? "", placeholder: "value", style: "width:130px" });
  const go = () => { window.__reqFilter = { dimension: dimInput.value.trim() || undefined, value: valInput.value.trim() || undefined }; render(); };
  main.append(el("div", { class: "row" }, ["Filter by tag:", dimInput, valInput,
    el("button", { class: "act", onclick: go }, "Apply"),
    el("button", { class: "act", onclick: () => { window.__reqFilter = {}; render(); } }, "Clear")]));

  const rows = await get("/requests", filter);
  const head = ["time", "user", "action", "model", "status", "tokens", "cached", "cost"];
  const table = el("table", {}, el("thead", {}, el("tr", {}, head.map((h) => el("th", {}, h)))));
  const body = el("tbody");
  for (const r of rows) {
    body.append(el("tr", {}, [
      el("td", { class: "muted" }, new Date(r._creationTime).toLocaleTimeString()),
      el("td", { class: "mono" }, r.userId),
      el("td", { class: "mono muted" }, r.actionName ?? "—"),
      el("td", { class: "mono muted" }, r.model),
      el("td", { class: r.status === "success" ? "ok" : r.status === "blocked" || r.status === "error" ? "bad" : "" }, r.status),
      el("td", { class: "mono" }, ((r.promptTokens ?? 0) + (r.completionTokens ?? 0)) || "—"),
      el("td", { class: "mono muted" }, r.cachedTokens || "—"),
      el("td", { class: "mono" }, usd(r.costNanos)),
    ]));
  }
  table.append(body);
  main.append(rows.length ? table : el("div", { class: "muted" }, "No matching requests."));
}

async function renderUsage() {
  const s = window.__usage ?? (window.__usage = { dimension: "user", value: "", period: "day" });
  const buckets = await get("/buckets", { dimension: s.dimension });
  if (!s.value && buckets[0]) s.value = buckets[0].value;
  const dimInput = el("input", { value: s.dimension, style: "width:110px", onchange: (e) => { s.dimension = e.target.value.trim(); s.value = ""; render(); } });
  const valSel = el("select", { value: s.value, style: "width:150px", onchange: (e) => { s.value = e.target.value; render(); } },
    buckets.map((b) => el("option", { value: b.value }, b.value)));
  const perSel = el("select", { value: s.period, style: "width:90px", onchange: (e) => { s.period = e.target.value; render(); } },
    [el("option", { value: "day" }, "day"), el("option", { value: "month" }, "month")]);
  main.append(el("div", { class: "row" }, ["Dimension:", dimInput, "Value:", valSel, "Period:", perSel]));
  if (!s.value) { main.append(el("div", { class: "muted" }, "No buckets in this dimension yet.")); return; }

  const hist = (await get("/usage", { dimension: s.dimension, value: s.value, period: s.period })).slice().reverse();
  if (!hist.length) { main.append(el("div", { class: "muted" }, "No usage history yet.")); return; }
  const max = Math.max(...hist.map((h) => h.spendNanos), 1);
  main.append(el("h2", {}, "Spend per " + s.period + " — " + s.dimension + " \"" + s.value + "\""));
  main.append(el("div", { class: "bars" }, hist.map((h) =>
    el("div", { class: "bar", title: h.stamp + ": " + usd(h.spendNanos), style: "height:" + Math.max(2, (h.spendNanos / max) * 100) + "%" },
      el("span", {}, h.stamp.slice(5))))));
  const total = hist.reduce((a, h) => a + h.spendNanos, 0);
  main.append(el("div", { class: "muted", style: "margin-top:26px" }, hist.length + " " + s.period + "s · " + usd(total) + " total"));
}

async function renderSettings() {
  const g = await get("/global");
  main.append(el("h2", {}, "Global (deployment-wide) cap"));
  const setG = (patch) => post("/global/setLimits", patch).then(render);
  main.append(el("div", { class: "row" }, [
    "Daily $:", numInput(g.dailySpendLimitNanos, (v) => setG({ dailySpendLimitNanos: v }), { money: true }),
    "Lifetime $:", numInput(g.lifetimeSpendLimitNanos, (v) => setG({ lifetimeSpendLimitNanos: v }), { money: true }),
    el("span", { class: "pill" }, "today " + usd(g.spentTodayNanos) + " · total " + usd(g.spentTotalNanos)),
  ]));
  main.append(el("h2", {}, "Alerts & retention"));
  main.append(el("div", { class: "row" }, [
    "Alert at %:", numInput(g.defaultWarnAtPct == null ? undefined : Math.round(g.defaultWarnAtPct * 100),
      (v) => post("/global/setAlertDefaults", { warnAtPct: v == null ? undefined : v / 100 }).then(render), { width: 55 }),
    "Retention (ms):", numInput(g.retentionMs, (v) => post("/global/setRetention", { retentionMs: v ?? 0 }).then(render), { width: 130 }),
  ]));

  const prices = await get("/prices");
  main.append(el("h2", {}, "Model prices (nanodollars / Mtok)"));
  const table = el("table", {}, el("thead", {}, el("tr", {}, ["model", "input", "output", "cached", ""].map((h) => el("th", {}, h)))));
  const body = el("tbody");
  for (const [model, p] of Object.entries(prices)) {
    body.append(el("tr", {}, [
      el("td", { class: "mono" }, model),
      el("td", { class: "mono" }, p.input),
      el("td", { class: "mono" }, p.output),
      el("td", { class: "mono muted" }, p.cached ?? "default"),
      el("td", {}, p.overridden ? el("span", { class: "pill" }, "override") : ""),
    ]));
  }
  table.append(body);
  main.append(table);
}

render();
</script>
</body>
</html>`;
