// CHAP Gateway — modernized dashboard client
// Vanilla JS, no build step. Consumes the existing Socket.IO contract emitted
// by gateway.js (or the safe dev/preview-server.js).
//
// Server → client: MOTESDEF, METRICSDEF, EVENTSDEF, SETTINGSDEF, SERVERTIME,
//   UPDATENODES, UPDATENODE, LOG, GRAPHDATAREADY, GATEWAYINFO (preview only)
// Client → server: GETGRAPHDATA, UPDATENODESETTINGS, UPDATEMETRICSETTINGS,
//   EDITNODEEVENT, DELETENODE, DELETENODEMETRIC, CONTROLCLICK, NODEMESSAGE

const q   = (sel, root = document) => root.querySelector(sel);
const qa  = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const slot = (name, root = document) => root.querySelector(`[data-slot="${name}"]`);

const STATE = {
  motesDef: {},
  metricsDef: {},
  eventsDef: {},
  nodes: new Map(),
  events: [],
  gateway: { startedAt: null, hostname: '—', mode: 'live', productionSafe: null },
  serverTimeOffset: 0,
  lastRx: null,
  filters: { deviceText: '', deviceStatus: 'all', eventText: '', eventLevel: 'all' },
  drawerNodeId: null,
  history: new Map(),        // `${nodeId}:${key}` → [{t,v}]
  pendingHistory: new Set()  // `${nodeId}:${key}` still in-flight
};
const MAX_EVENTS = 500;
const HISTORY_WINDOW_MS = 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Utilities                                                           *
 * ------------------------------------------------------------------ */
function fmtRelative(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5)  return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function fmtDuration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}
function fmtClock(ts) { return new Date(ts).toTimeString().slice(0, 8); }
function nodeStatus(node) {
  const age = Date.now() - (node.updated || 0);
  if (age < 30_000)   return 'online';
  if (age < 300_000)  return 'stale';
  return 'offline';
}
function iconForNode(node) {
  const def = STATE.motesDef[node.type];
  const file = (def && def.icon) || 'icon_default.png';
  return `/images/${file}`;
}
function moteLabel(type) {
  const def = STATE.motesDef[type];
  return (def && def.label) || type || 'Device';
}
function metricUnit(node, key) {
  const m = node && node.metrics && node.metrics[key];
  if (m && m.unit) return m.unit;
  const def = STATE.metricsDef[key];
  return (def && def.unit) || '';
}
function rssiBars(rssi) {
  if (rssi == null) return 0;
  if (rssi >= -55) return 4;
  if (rssi >= -70) return 3;
  if (rssi >= -85) return 2;
  return 1;
}
function batteryState(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return { ok: true };
  return { ok: n >= 3.1, low: n < 3.1, value: n };
}

/* ------------------------------------------------------------------ *
 * Sparkline (canvas)                                                  *
 * A modern gradient-fill area chart with hover crosshair + tooltip.   *
 * No dependencies. Handles device pixel ratio for crisp rendering.    *
 * ------------------------------------------------------------------ */
function drawSparkline(canvas, points, opts = {}) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || canvas.parentElement.clientWidth || 300;
  const cssH = parseInt(canvas.getAttribute('height'), 10) || 80;
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!points || !points.length) {
    ctx.fillStyle = 'rgba(155, 167, 180, 0.35)';
    ctx.font = '11px -apple-system, "Inter", sans-serif';
    ctx.fillText('no history', 8, cssH / 2 + 4);
    return;
  }
  if (points.length === 1) {
    ctx.fillStyle = 'rgba(94, 234, 212, 0.9)';
    ctx.beginPath(); ctx.arc(cssW / 2, cssH / 2, 3, 0, Math.PI * 2); ctx.fill();
    return;
  }

  const pad = { l: 4, r: 4, t: 6, b: 12 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;

  const values = points.map(p => p.v);
  let vMin = Math.min(...values);
  let vMax = Math.max(...values);
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  const tSpan = Math.max(1, tMax - tMin);

  const x = t => pad.l + ((t - tMin) / tSpan) * w;
  const y = v => pad.t + h - ((v - vMin) / (vMax - vMin)) * h;

  // Gradient area
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + h);
  grad.addColorStop(0, 'rgba(94, 234, 212, 0.35)');
  grad.addColorStop(1, 'rgba(94, 234, 212, 0.02)');
  ctx.beginPath();
  ctx.moveTo(x(points[0].t), pad.t + h);
  points.forEach(p => ctx.lineTo(x(p.t), y(p.v)));
  ctx.lineTo(x(points[points.length - 1].t), pad.t + h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(p.t), py = y(p.v);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  const lineGrad = ctx.createLinearGradient(0, 0, cssW, 0);
  lineGrad.addColorStop(0, '#5eead4');
  lineGrad.addColorStop(1, '#60a5fa');
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.stroke();

  // Endpoint dot
  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(x(last.t), y(last.v), 2.4, 0, Math.PI * 2);
  ctx.fillStyle = '#5eead4';
  ctx.fill();

  // Axis labels (min / max / span)
  ctx.fillStyle = 'rgba(155, 167, 180, 0.7)';
  ctx.font = '10px var(--mono), monospace';
  const unit = opts.unit || '';
  ctx.textAlign = 'left';
  ctx.fillText(`${vMax.toFixed(vMax >= 100 ? 0 : 1)}${unit}`, pad.l + 2, pad.t + 2 + 8);
  ctx.fillText(`${vMin.toFixed(vMin >= 100 ? 0 : 1)}${unit}`, pad.l + 2, pad.t + h - 2);
  ctx.textAlign = 'right';
  const spanMin = Math.round((tMax - tMin) / 60000);
  ctx.fillText(`${spanMin}m`, cssW - pad.r - 2, cssH - 2);

  // Hover: crosshair + tooltip.  Bind once per canvas.
  if (!canvas._chapHoverBound) {
    canvas._chapHoverBound = true;
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const pts = canvas._pts || [];
      if (!pts.length) return;
      // find nearest
      let nearest = pts[0], best = Infinity;
      pts.forEach(p => {
        const px = canvas._x(p.t);
        const d = Math.abs(px - mx);
        if (d < best) { best = d; nearest = p; }
      });
      const px = canvas._x(nearest.t), py = canvas._y(nearest.v);
      // Redraw base + crosshair (partial re-render on hover).
      canvas._render();
      const c2 = canvas.getContext('2d');
      const dpr2 = window.devicePixelRatio || 1;
      c2.setTransform(dpr2, 0, 0, dpr2, 0, 0);
      c2.strokeStyle = 'rgba(230, 237, 243, 0.35)';
      c2.setLineDash([2, 3]);
      c2.beginPath(); c2.moveTo(px, 0); c2.lineTo(px, canvas.getBoundingClientRect().height); c2.stroke();
      c2.setLineDash([]);
      c2.beginPath(); c2.arc(px, py, 3.5, 0, Math.PI * 2); c2.fillStyle = '#e6edf3'; c2.fill();
      // Tooltip
      const label = `${nearest.v.toFixed(2)}${opts.unit || ''}  ·  ${new Date(nearest.t).toLocaleTimeString()}`;
      c2.font = '11px -apple-system, "Inter", sans-serif';
      const tw = c2.measureText(label).width + 12;
      const tx = Math.max(4, Math.min(canvas.getBoundingClientRect().width - tw - 4, px - tw / 2));
      c2.fillStyle = 'rgba(11, 15, 20, 0.9)';
      c2.strokeStyle = 'rgba(31, 42, 55, 1)';
      c2.beginPath();
      const ty = 2;
      c2.roundRect ? c2.roundRect(tx, ty, tw, 18, 4) : c2.rect(tx, ty, tw, 18);
      c2.fill(); c2.stroke();
      c2.fillStyle = '#e6edf3';
      c2.fillText(label, tx + 6, ty + 12);
    });
    canvas.addEventListener('mouseleave', () => canvas._render && canvas._render());
  }
  // Store re-render hooks so hover can restore the base chart.
  canvas._pts = points; canvas._x = x; canvas._y = y;
  canvas._render = () => drawSparkline(canvas, points, opts);
}

/* ------------------------------------------------------------------ *
 * Router                                                              *
 * ------------------------------------------------------------------ */
const VIEW_META = {
  overview: { title: 'Overview', sub: 'Real-time state of the CHAP gateway' },
  devices:  { title: 'Devices',  sub: 'Dynamically discovered IoT nodes' },
  network:  { title: 'Network',  sub: 'Internet and connectivity metrics' },
  events:   { title: 'Events',   sub: 'Gateway activity log' },
  settings: { title: 'Settings', sub: 'Gateway configuration and definitions' }
};
function setView(name) {
  if (!VIEW_META[name]) name = 'overview';
  qa('.view').forEach(el => { el.hidden = el.dataset.view !== name; });
  qa('.nav-item').forEach(el => el.classList.toggle('is-active', el.dataset.view === name));
  slot('viewTitle').textContent = VIEW_META[name].title;
  slot('viewSub').textContent   = VIEW_META[name].sub;
  document.body.classList.remove('nav-open');
  renderAll();
}
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));

/* ------------------------------------------------------------------ *
 * Controls (from motesDef[type].controls)                             *
 * ------------------------------------------------------------------ */
function resolveControls(node) {
  const def = STATE.motesDef[node.type];
  if (!def || !def.controls) return [];
  const out = [];
  Object.entries(def.controls).forEach(([key, ctrl]) => {
    // showCondition — stringified function, evaluate safely; on error, show.
    let show = true;
    if (ctrl.showCondition) show = tryEval(ctrl.showCondition, node, true);
    if (!show) return;
    // Pick the first state whose condition() matches; if none has a condition, show all.
    const withCond = (ctrl.states || []).filter(s => s.condition);
    let active = null;
    if (withCond.length) {
      active = withCond.find(s => tryEval(s.condition, node, false));
    }
    const states = active ? [active] : (ctrl.states || []).filter(s => !s.condition);
    states.forEach((s) => {
      out.push({
        key, action: s.action || '', label: s.label || key,
        tone: toneFromCss(s.css || ''), icon: s.icon || ''
      });
    });
  });
  return out;
}
function tryEval(fnStr, node, fallback) {
  // The stringified functions from metrics.js reference `node.metrics[…]` and
  // occasionally jQuery ($). We provide a minimal $.inArray shim so the
  // definitions Just Work without dragging in real jQuery.
  try {
    const $ = { inArray: (v, arr) => (arr || []).indexOf(v) };
    // eslint-disable-next-line no-new-func
    const fn = new Function('$', 'return (' + fnStr + ')')($);
    return !!fn(node);
  } catch (e) {
    return fallback;
  }
}
function toneFromCss(css) {
  if (/#FF9B9B/i.test(css)) return 'danger';
  if (/#9BFFBE/i.test(css)) return 'success';
  if (/#FFF000/i.test(css)) return 'warn';
  return '';
}

/* ------------------------------------------------------------------ *
 * Rendering                                                           *
 * ------------------------------------------------------------------ */
function renderKPIs() {
  const nodes = Array.from(STATE.nodes.values());
  const online = nodes.filter(n => nodeStatus(n) === 'online').length;
  const metricCount = nodes.reduce((s, n) => s + Object.keys(n.metrics || {}).length, 0);
  slot('kpi-status').textContent = STATE.gateway.mode === 'preview' ? 'Preview' : 'Online';
  slot('kpi-mode').textContent   = STATE.gateway.mode === 'preview'
    ? 'safe preview · production untouched' : 'live gateway';
  slot('kpi-devices').textContent = nodes.length;
  slot('kpi-devices-sub').textContent = `${online} online · ${nodes.length - online} stale/offline`;
  slot('kpi-metrics').textContent = metricCount;
  slot('kpi-lastRx').textContent  = fmtRelative(STATE.lastRx);
  slot('lastRx').textContent      = STATE.lastRx ? fmtRelative(STATE.lastRx) : '—';
  slot('deviceCount').textContent = nodes.length;
  const upMs = STATE.gateway.startedAt ? Date.now() - STATE.gateway.startedAt : null;
  slot('uptime').textContent = upMs ? `up ${fmtDuration(upMs)}` : 'uptime —';
}

function buildMetricTile(nodeId, key, metric) {
  const tpl = q('#tpl-metric-tile').content.firstElementChild.cloneNode(true);
  tpl.dataset.metricKey = `${nodeId}:${key}`;
  slot('name', tpl).textContent  = metric.name || key;
  slot('value', tpl).textContent = metric.value != null ? metric.value : '—';
  slot('unit', tpl).textContent  = metricUnit({ metrics: { [key]: metric } }, key) || '';
  return tpl;
}

function buildDeviceCard(node) {
  const tpl = q('#tpl-device-card').content.firstElementChild.cloneNode(true);
  tpl.dataset.nodeId = node._id;
  slot('icon', tpl).src   = iconForNode(node);
  slot('icon', tpl).alt   = moteLabel(node.type);
  slot('label', tpl).textContent = node.label || moteLabel(node.type);
  slot('type', tpl).textContent  = moteLabel(node.type);
  slot('id', tpl).textContent    = `#${node._id}`;
  slot('status', tpl).title = nodeStatus(node);
  slot('age', tpl).textContent = `updated ${fmtRelative(node.updated)}`;

  // RSSI
  const rssiEl = slot('rssi', tpl);
  const bars = rssiBars(node.rssi);
  if (bars) {
    rssiEl.hidden = false;
    rssiEl.dataset.bars = String(bars);
    rssiEl.title = `RSSI ${node.rssi} dBm`;
    rssiEl.innerHTML = '<i></i><i></i><i></i><i></i>';
  }
  // Battery
  const battEl = slot('batt', tpl);
  const vMetric = node.metrics && node.metrics.V;
  if (vMetric) {
    const b = batteryState(vMetric.value);
    battEl.hidden = false;
    battEl.textContent = `${vMetric.value}v`;
    battEl.dataset.low = b.low ? '1' : '0';
    battEl.title = b.low ? 'Battery low' : 'Battery';
  }

  // Metrics
  const host = slot('metrics', tpl);
  const pinned = Object.entries(node.metrics || {})
    .filter(([k, m]) => m && (m.pin === 1 || m.pin === '1' || m.pin === true) && k !== 'V');
  const chosen = pinned.length ? pinned : Object.entries(node.metrics || {}).slice(0, 4);
  chosen.forEach(([k, m]) => host.appendChild(buildMetricTile(node._id, k, m)));

  // Quick controls (subset — first state per control key)
  const qc = slot('quick-controls', tpl);
  resolveControls(node).slice(0, 3).forEach(c => {
    const btn = q('#tpl-control-btn').content.firstElementChild.cloneNode(true);
    btn.dataset.action = c.action;
    btn.dataset.key = c.key;
    if (c.tone) btn.dataset.tone = c.tone;
    slot('label', btn).textContent = c.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      emitControlClick(node._id, c);
    });
    qc.appendChild(btn);
  });

  tpl.addEventListener('click', () => openDrawer(node._id));
  tpl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(node._id); }
  });
  return tpl;
}

function renderDevicesGrid() {
  const host = q('#devicesGrid');
  const text = STATE.filters.deviceText.toLowerCase();
  const status = STATE.filters.deviceStatus;
  host.innerHTML = '';
  Array.from(STATE.nodes.values()).sort((a, b) => a._id - b._id)
    .filter(n => {
      if (status !== 'all' && nodeStatus(n) !== status) return false;
      if (!text) return true;
      return (`${n._id} ${n.label || ''} ${n.type || ''}`).toLowerCase().includes(text);
    })
    .forEach(n => host.appendChild(buildDeviceCard(n)));
}
function renderPinnedGrid() {
  const host = q('#pinnedGrid');
  host.innerHTML = '';
  Array.from(STATE.nodes.values()).sort((a, b) => a._id - b._id)
    .forEach(n => host.appendChild(buildDeviceCard(n)));
}
function renderNetwork() {
  const netNodes = Array.from(STATE.nodes.values()).filter(n => {
    const keys = Object.keys(n.metrics || {});
    return keys.some(k => /^(DOWN|UP|PING)$/i.test(k));
  });
  const hero = q('#netHero');
  const primary = netNodes[0];
  if (!primary) { hero.hidden = true; q('#netExtraGrid').innerHTML = ''; return; }
  hero.hidden = false;
  const m = primary.metrics;
  const down = parseFloat((m.DOWN && m.DOWN.value) || 0);
  const up   = parseFloat((m.UP   && m.UP.value)   || 0);
  const ping = parseFloat((m.PING && m.PING.value) || 0);
  slot('net-down').textContent = isFinite(down) ? down.toFixed(1) : '—';
  slot('net-up').textContent   = isFinite(up)   ? up.toFixed(1)   : '—';
  slot('net-ping').textContent = isFinite(ping) ? Math.round(ping) : '—';
  slot('net-down-bar').style.width = `${Math.min(100, (down / 200) * 100)}%`;
  slot('net-up-bar').style.width   = `${Math.min(100, (up / 100) * 100)}%`;
  slot('net-ping-bar').style.width = `${Math.max(0, Math.min(100, 100 - (ping / 300) * 100))}%`;

  const extras = q('#netExtraGrid');
  extras.innerHTML = '';
  netNodes.slice(1).forEach(n => extras.appendChild(buildDeviceCard(n)));
}
function renderEvents() {
  const filter = STATE.filters.eventText.toLowerCase();
  const level  = STATE.filters.eventLevel;
  const full = q('#eventsList');
  const overview = q('#overviewEvents');
  full.innerHTML = ''; overview.innerHTML = '';
  const tpl = q('#tpl-event-row').content.firstElementChild;
  const list = STATE.events
    .filter(e => level === 'all' || (e.level || 'info') === level)
    .filter(e => !filter || (e.msg || '').toLowerCase().includes(filter));
  slot('eventCount').textContent = STATE.events.length;
  list.slice(0, 200).forEach(e => full.appendChild(buildEventRow(tpl, e)));
  list.slice(0, 6).forEach(e => overview.appendChild(buildEventRow(tpl, e)));
}
function buildEventRow(tpl, e) {
  const row = tpl.cloneNode(true);
  slot('time', row).textContent = fmtClock(e.ts);
  const lvl = e.level || 'info';
  const lvlEl = slot('level', row);
  lvlEl.textContent = lvl; lvlEl.dataset.l = lvl;
  slot('msg', row).textContent = e.msg || '';
  return row;
}
function renderSettings() {
  slot('set-mode').textContent = STATE.gateway.mode || 'live';
  slot('set-host').textContent = STATE.gateway.hostname || '—';
  slot('set-started').textContent = STATE.gateway.startedAt ? new Date(STATE.gateway.startedAt).toLocaleString() : '—';
  slot('set-uptime').textContent = STATE.gateway.startedAt ? fmtDuration(Date.now() - STATE.gateway.startedAt) : '—';
  slot('set-safe').textContent = STATE.gateway.productionSafe === true
    ? 'yes — preview isolated from production'
    : STATE.gateway.productionSafe === false ? 'no' : '—';
  const motes = q('#moteTypeList');
  motes.innerHTML = '';
  Object.entries(STATE.motesDef).sort(([a],[b]) => a.localeCompare(b)).forEach(([k, def]) => {
    const div = document.createElement('div');
    div.textContent = `${def.label || k}  ·  ${k}`;
    motes.appendChild(div);
  });
  const mdefs = q('#metricDefList');
  mdefs.innerHTML = '';
  const keys = Object.keys(STATE.metricsDef).sort();
  keys.slice(0, 60).forEach(k => {
    const d = document.createElement('div');
    const def = STATE.metricsDef[k] || {};
    d.textContent = `${def.name || k}${def.unit ? ' ' + def.unit : ''}`;
    mdefs.appendChild(d);
  });
  if (keys.length > 60) {
    const more = document.createElement('div');
    more.textContent = `… and ${keys.length - 60} more`;
    mdefs.appendChild(more);
  }
}
function renderAll() {
  renderKPIs(); renderPinnedGrid(); renderDevicesGrid();
  renderNetwork(); renderEvents(); renderSettings();
}

/* ------------------------------------------------------------------ *
 * Drawer                                                              *
 * ------------------------------------------------------------------ */
function openDrawer(nodeId) {
  const node = STATE.nodes.get(nodeId);
  if (!node) return;
  STATE.drawerNodeId = nodeId;
  const drawer = q('#drawer');
  drawer.setAttribute('aria-hidden', 'false');
  renderDrawer();
  // Fetch history for graphable metrics we don't already have.
  Object.entries(node.metrics || {}).forEach(([k, m]) => {
    if (!(m.graph === 1 || m.graph === '1')) return;
    const hk = `${nodeId}:${k}`;
    if (STATE.history.has(hk) || STATE.pendingHistory.has(hk)) return;
    fetchHistory(nodeId, k);
  });
}
function closeDrawer() {
  STATE.drawerNodeId = null;
  q('#drawer').setAttribute('aria-hidden', 'true');
}
function renderDrawer() {
  const nodeId = STATE.drawerNodeId;
  if (nodeId == null) return;
  const node = STATE.nodes.get(nodeId);
  if (!node) { closeDrawer(); return; }
  slot('dr-icon').src = iconForNode(node);
  slot('dr-icon').alt = moteLabel(node.type);
  slot('dr-label').value = node.label || moteLabel(node.type);
  slot('dr-type').textContent = moteLabel(node.type);
  slot('dr-id').textContent = `#${node._id}`;
  const status = nodeStatus(node);
  const chip = slot('dr-status');
  chip.textContent = status; chip.dataset.status = status;
  slot('dr-updated').textContent = `updated ${fmtRelative(node.updated)}`;

  const rssiChip = slot('dr-rssi');
  if (node.rssi != null) {
    rssiChip.hidden = false;
    rssiChip.textContent = `RSSI ${node.rssi} dBm · ${rssiBars(node.rssi)}/4`;
  } else rssiChip.hidden = true;

  const battChip = slot('dr-battery');
  const vMetric = node.metrics && node.metrics.V;
  if (vMetric) {
    const b = batteryState(vMetric.value);
    battChip.hidden = false;
    battChip.textContent = b.low ? `low battery (${vMetric.value}v)` : `battery ${vMetric.value}v`;
    battChip.classList.toggle('warn', b.low);
  } else battChip.hidden = true;

  // Controls
  const ctrls = resolveControls(node);
  const ctrlSection = slot('dr-controls-section');
  const ctrlHost = slot('dr-controls');
  ctrlHost.innerHTML = '';
  if (ctrls.length) {
    ctrlSection.hidden = false;
    ctrls.forEach(c => {
      const btn = q('#tpl-control-btn').content.firstElementChild.cloneNode(true);
      btn.dataset.action = c.action; btn.dataset.key = c.key;
      if (c.tone) btn.dataset.tone = c.tone;
      slot('label', btn).textContent = c.label;
      btn.addEventListener('click', () => emitControlClick(node._id, c));
      ctrlHost.appendChild(btn);
    });
  } else ctrlSection.hidden = true;

  // Metrics + sparklines
  const list = slot('dr-metrics');
  list.innerHTML = '';
  const entries = Object.entries(node.metrics || {}).sort(([a], [b]) => a.localeCompare(b));
  entries.forEach(([k, m]) => list.appendChild(buildMetricDetail(node, k, m)));
}

function buildMetricDetail(node, key, metric) {
  const tpl = q('#tpl-metric-detail').content.firstElementChild.cloneNode(true);
  tpl.dataset.metricKey = `${node._id}:${key}`;
  slot('name', tpl).textContent = metric.label || metric.name || key;
  slot('value', tpl).textContent = metric.value != null ? metric.value : '—';
  slot('unit', tpl).textContent = metricUnit(node, key) || '';

  const pin = slot('pin', tpl);   pin.checked   = !!(metric.pin === 1 || metric.pin === '1' || metric.pin === true);
  const grp = slot('graph', tpl); grp.checked   = !!(metric.graph === 1 || metric.graph === '1' || metric.graph === true);
  pin.addEventListener('change', () => emitMetricSettings(node._id, key, { ...metric, pin: pin.checked ? 1 : 0 }));
  grp.addEventListener('change', () => emitMetricSettings(node._id, key, { ...metric, graph: grp.checked ? 1 : 0 }));

  slot('delete', tpl).addEventListener('click', () => {
    if (confirm(`Delete metric ${key} from node ${node._id}?`)) emitDeleteMetric(node._id, key);
  });

  const canvas = slot('spark', tpl);
  const hk = `${node._id}:${key}`;
  const points = STATE.history.get(hk) || [];
  if (points.length) {
    const range = pointRange(points);
    slot('range', tpl).textContent = range;
    requestAnimationFrame(() => drawSparkline(canvas, points, { unit: metricUnit(node, key) }));
  } else {
    slot('range', tpl).textContent = grp.checked ? 'loading…' : 'no history';
    requestAnimationFrame(() => drawSparkline(canvas, [], { unit: '' }));
  }
  return tpl;
}
function pointRange(pts) {
  const vs = pts.map(p => p.v);
  const mn = Math.min(...vs), mx = Math.max(...vs);
  const dec = mx >= 100 ? 0 : 1;
  return `min ${mn.toFixed(dec)} · max ${mx.toFixed(dec)} · ${pts.length} pts`;
}

/* ------------------------------------------------------------------ *
 * Server actions                                                      *
 * ------------------------------------------------------------------ */
function withSocket(fn) {
  const s = window.__chapSocket;
  if (s && s.connected) fn(s); else console.warn('socket not connected');
}
function fetchHistory(nodeId, key) {
  const hk = `${nodeId}:${key}`;
  STATE.pendingHistory.add(hk);
  const end = Date.now();
  const start = end - HISTORY_WINDOW_MS;
  withSocket(s => s.emit('GETGRAPHDATA', nodeId, key, start, end));
}
function emitControlClick(nodeId, c) {
  withSocket(s => s.emit('CONTROLCLICK', { nodeId, controlKey: c.key, action: c.action, label: c.label }));
}
function emitMetricSettings(nodeId, key, metric) {
  withSocket(s => s.emit('UPDATEMETRICSETTINGS', nodeId, key, metric));
}
function emitDeleteMetric(nodeId, key) {
  withSocket(s => s.emit('DELETENODEMETRIC', nodeId, key));
  const hk = `${nodeId}:${key}`;
  STATE.history.delete(hk);
}
function emitNodeSettings(node, patch) {
  const merged = Object.assign({ _id: node._id, label: node.label, descr: node.descr, type: node.type }, patch);
  withSocket(s => s.emit('UPDATENODESETTINGS', merged));
}
function emitDeleteNode(nodeId) {
  withSocket(s => s.emit('DELETENODE', nodeId));
  closeDrawer();
}

/* ------------------------------------------------------------------ *
 * Sockets                                                             *
 * ------------------------------------------------------------------ */
function setConn(state, label) {
  const pill = q('#connPill'); pill.dataset.state = state;
  slot('connLabel').textContent = label;
}
function pushEvent(evt) {
  STATE.events.unshift(evt);
  if (STATE.events.length > MAX_EVENTS) STATE.events.length = MAX_EVENTS;
}
function connect() {
  if (typeof io !== 'function') return setTimeout(connect, 100);
  const socket = io({ transports: ['websocket', 'polling'] });
  window.__chapSocket = socket;
  setConn('connecting', 'Connecting…');

  socket.on('connect',    () => { setConn('connected', 'Connected'); pushEvent({ ts: Date.now(), level: 'info', msg: 'socket connected' }); renderEvents(); });
  socket.on('disconnect', (r) => { setConn('disconnected', 'Disconnected'); pushEvent({ ts: Date.now(), level: 'warn', msg: `socket disconnected (${r})` }); renderEvents(); });
  socket.on('reconnect_attempt', () => setConn('connecting', 'Reconnecting…'));
  socket.on('connect_error',     () => setConn('disconnected', 'Connection error'));

  socket.on('MOTESDEF',    d => { STATE.motesDef   = d || {}; renderAll(); });
  socket.on('METRICSDEF',  d => { STATE.metricsDef = d || {}; renderAll(); });
  socket.on('EVENTSDEF',   d => { STATE.eventsDef  = d || {}; });
  socket.on('SETTINGSDEF', () => {});
  socket.on('SERVERTIME',  ts => { STATE.serverTimeOffset = Date.now() - ts; });
  socket.on('GATEWAYINFO', info => { STATE.gateway = Object.assign(STATE.gateway, info || {}); renderKPIs(); renderSettings(); });

  socket.on('UPDATENODES', (list) => {
    STATE.nodes.clear();
    (list || []).forEach(n => STATE.nodes.set(n._id, n));
    STATE.lastRx = Date.now();
    renderAll();
    if (STATE.drawerNodeId != null && !STATE.nodes.has(STATE.drawerNodeId)) closeDrawer();
    else if (STATE.drawerNodeId != null) renderDrawer();
  });

  socket.on('UPDATENODE', (node) => {
    if (!node || node._id == null) return;
    const prev = STATE.nodes.get(node._id);
    STATE.nodes.set(node._id, node);
    STATE.lastRx = Date.now();
    // Append fresh points to any tracked history
    Object.entries(node.metrics || {}).forEach(([k, m]) => {
      if (!(m.graph === 1 || m.graph === '1')) return;
      const hk = `${node._id}:${k}`;
      const arr = STATE.history.get(hk);
      const v = parseFloat(m.value);
      if (arr && isFinite(v)) {
        arr.push({ t: node.updated || Date.now(), v });
        const cutoff = Date.now() - HISTORY_WINDOW_MS;
        while (arr.length && arr[0].t < cutoff) arr.shift();
      }
    });
    renderKPIs();
    renderPinnedGrid();
    if (!q('[data-view="devices"]').hidden) renderDevicesGrid();
    if (!q('[data-view="network"]').hidden) renderNetwork();
    if (STATE.drawerNodeId === node._id) renderDrawer();
    if (prev) flashChangedTiles(node._id, prev.metrics, node.metrics);
  });

  socket.on('LOG', (entry) => {
    if (!entry) return;
    pushEvent({ ts: entry.ts || Date.now(), level: entry.level || 'info', msg: entry.msg || String(entry) });
    renderEvents();
  });

  socket.on('GRAPHDATAREADY', (payload) => {
    if (!payload || !payload.graphData || !payload.options) return;
    const nodeId = payload.options.nodeId;
    const key = payload.options.metricName;
    const hk = `${nodeId}:${key}`;
    STATE.pendingHistory.delete(hk);
    const points = (payload.graphData.data || []).map(p => ({ t: p.t, v: parseFloat(p.v) })).filter(p => isFinite(p.v));
    STATE.history.set(hk, points);
    if (STATE.drawerNodeId === nodeId) renderDrawer();
  });
}

function flashChangedTiles(nodeId, prevMetrics, nextMetrics) {
  Object.keys(nextMetrics || {}).forEach(k => {
    const prev = prevMetrics && prevMetrics[k] && prevMetrics[k].value;
    const next = nextMetrics[k] && nextMetrics[k].value;
    if (prev !== next) {
      qa(`[data-metric-key="${nodeId}:${k}"]`).forEach(el => {
        el.classList.add('is-flash');
        setTimeout(() => el.classList.remove('is-flash'), 700);
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * UI wiring                                                           *
 * ------------------------------------------------------------------ */
function wireUI() {
  q('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('chap-theme', next); } catch { /* ignore */ }
    slot('themeLabel').textContent = next === 'dark' ? 'Light mode' : 'Dark mode';
    if (STATE.drawerNodeId != null) renderDrawer();
  });
  try {
    const saved = localStorage.getItem('chap-theme');
    if (saved) {
      document.documentElement.dataset.theme = saved;
      slot('themeLabel').textContent = saved === 'dark' ? 'Light mode' : 'Dark mode';
    }
  } catch { /* ignore */ }

  q('#deviceFilter').addEventListener('input', (e) => { STATE.filters.deviceText = e.target.value; renderDevicesGrid(); });
  qa('[data-status]').forEach(btn => btn.addEventListener('click', () => {
    qa('[data-status]').forEach(b => b.classList.toggle('is-active', b === btn));
    STATE.filters.deviceStatus = btn.dataset.status; renderDevicesGrid();
  }));
  q('#eventFilter').addEventListener('input', (e) => { STATE.filters.eventText = e.target.value; renderEvents(); });
  qa('[data-level]').forEach(btn => btn.addEventListener('click', () => {
    qa('[data-level]').forEach(b => b.classList.toggle('is-active', b === btn));
    STATE.filters.eventLevel = btn.dataset.level; renderEvents();
  }));

  // Drawer close (scrim, ×, ESC)
  qa('[data-close]').forEach(el => el.addEventListener('click', closeDrawer));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  // Rename node from drawer label input (commit on blur/enter)
  const dl = slot('dr-label');
  dl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dl.blur(); } });
  dl.addEventListener('blur', () => {
    const nodeId = STATE.drawerNodeId;
    if (nodeId == null) return;
    const node = STATE.nodes.get(nodeId); if (!node) return;
    const next = dl.value.trim();
    if (next && next !== node.label) emitNodeSettings(node, { label: next });
  });
  // Delete node
  q('#dr-delete-node').addEventListener('click', () => {
    const nodeId = STATE.drawerNodeId; if (nodeId == null) return;
    if (confirm(`Delete node ${nodeId} from the gateway database?`)) emitDeleteNode(nodeId);
  });

  // Live age labels tick every second
  setInterval(() => {
    renderKPIs();
    qa('.device-card').forEach(card => {
      const id = parseInt(card.dataset.nodeId, 10);
      const n = STATE.nodes.get(id); if (!n) return;
      slot('status', card).title = nodeStatus(n);
      slot('age', card).textContent = `updated ${fmtRelative(n.updated)}`;
    });
    if (STATE.drawerNodeId != null) {
      slot('dr-updated').textContent = `updated ${fmtRelative((STATE.nodes.get(STATE.drawerNodeId) || {}).updated)}`;
    }
  }, 1000);

  // Redraw sparklines on window resize
  let rzT = null;
  window.addEventListener('resize', () => {
    clearTimeout(rzT);
    rzT = setTimeout(() => { if (STATE.drawerNodeId != null) renderDrawer(); }, 120);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireUI();
  setView(location.hash.slice(1) || 'overview');
  connect();
});
