// CHAP Gateway — modernized dashboard client
// Vanilla JS, ES modules-in-browser. No build step. Consumes the existing
// Socket.IO contract emitted by gateway.js / dev/preview-server.js.
//
// Contract (server → client):
//   MOTESDEF, METRICSDEF, EVENTSDEF, SETTINGSDEF, SERVERTIME,
//   UPDATENODES (initial array), UPDATENODE (single node deltas), LOG,
//   GATEWAYINFO (preview-only extension; safely ignored if missing)

const q  = (sel, root = document) => root.querySelector(sel);
const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const slot = (name, root = document) => root.querySelector(`[data-slot="${name}"]`);

const STATE = {
  motesDef: {},
  metricsDef: {},
  eventsDef: {},
  nodes: new Map(),        // id → node
  events: [],              // {ts, level, msg, nodeId?}
  gateway: { startedAt: null, hostname: '—', mode: 'live', productionSafe: null },
  serverTimeOffset: 0,
  lastRx: null,
  filters: { deviceText: '', deviceStatus: 'all', eventText: '', eventLevel: 'all' }
};

const MAX_EVENTS = 500;

/* ------------------------------------------------------------------ *
 * Utilities                                                           *
 * ------------------------------------------------------------------ */

function fmtRelative(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5)   return 'just now';
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
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
function fmtClock(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}
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
  const m = node.metrics && node.metrics[key];
  if (m && m.unit) return m.unit;
  const def = STATE.metricsDef[key];
  return (def && def.unit) || '';
}

/* ------------------------------------------------------------------ *
 * Router                                                              *
 * ------------------------------------------------------------------ */

const VIEW_META = {
  overview: { title: 'Overview',    sub: 'Real-time state of the CHAP gateway' },
  devices:  { title: 'Devices',     sub: 'Dynamically discovered IoT nodes' },
  network:  { title: 'Network',     sub: 'Internet and connectivity metrics' },
  events:   { title: 'Events',      sub: 'Gateway activity log' },
  settings: { title: 'Settings',    sub: 'Gateway configuration and definitions' }
};

function setView(name) {
  if (!VIEW_META[name]) name = 'overview';
  qa('.view').forEach(el => { el.hidden = el.dataset.view !== name; });
  qa('.nav-item').forEach(el => el.classList.toggle('is-active', el.dataset.view === name));
  slot('viewTitle').textContent = VIEW_META[name].title;
  slot('viewSub').textContent   = VIEW_META[name].sub;
  document.body.classList.remove('nav-open');
  renderAll(); // ensure the newly shown view is populated
}

window.addEventListener('hashchange', () => setView(location.hash.slice(1)));

/* ------------------------------------------------------------------ *
 * Rendering                                                           *
 * ------------------------------------------------------------------ */

function renderKPIs() {
  const nodes = Array.from(STATE.nodes.values());
  const online = nodes.filter(n => nodeStatus(n) === 'online').length;
  const metricCount = nodes.reduce((sum, n) => sum + Object.keys(n.metrics || {}).length, 0);

  slot('kpi-status').textContent = STATE.gateway.mode === 'preview' ? 'Preview' : 'Online';
  slot('kpi-mode').textContent   = STATE.gateway.mode === 'preview'
    ? 'safe preview · production untouched'
    : 'live gateway';
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
  const status = nodeStatus(node);
  const dot = slot('status', tpl);
  dot.title = status;
  slot('age', tpl).textContent = `updated ${fmtRelative(node.updated)}`;

  const metricsHost = slot('metrics', tpl);
  const pinned = Object.entries(node.metrics || {})
    .filter(([, m]) => m && (m.pin === 1 || m.pin === '1' || m.pin === true));
  const chosen = pinned.length ? pinned : Object.entries(node.metrics || {}).slice(0, 4);
  chosen.forEach(([k, m]) => metricsHost.appendChild(buildMetricTile(node._id, k, m)));
  return tpl;
}

function renderDevicesGrid() {
  const host = q('#devicesGrid');
  const text = STATE.filters.deviceText.toLowerCase();
  const status = STATE.filters.deviceStatus;
  host.innerHTML = '';
  Array.from(STATE.nodes.values())
    .sort((a, b) => a._id - b._id)
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
  Array.from(STATE.nodes.values())
    .sort((a, b) => a._id - b._id)
    .forEach(n => host.appendChild(buildDeviceCard(n)));
}

function renderNetwork() {
  // Find nodes whose metrics look like network telemetry (DOWN/UP/PING).
  const netNodes = Array.from(STATE.nodes.values()).filter(n => {
    const keys = Object.keys(n.metrics || {});
    return keys.some(k => /^(DOWN|UP|PING)$/i.test(k));
  });
  const hero = q('#netHero');
  const primary = netNodes[0];
  if (!primary) {
    hero.hidden = true;
    q('#netExtraGrid').innerHTML = '';
    return;
  }
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
  // For ping, lower is better; invert bar (0ms → 100%, 300ms → 0%).
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
  full.innerHTML = '';
  overview.innerHTML = '';
  const tpl = q('#tpl-event-row').content.firstElementChild;

  const list = STATE.events
    .filter(e => level === 'all' || (e.level || 'info') === level)
    .filter(e => !filter || (e.msg || '').toLowerCase().includes(filter));

  slot('eventCount').textContent = STATE.events.length;

  list.slice(0, 200).forEach(e => {
    const row = tpl.cloneNode(true);
    slot('time', row).textContent  = fmtClock(e.ts);
    const lvl = e.level || 'info';
    const lvlEl = slot('level', row);
    lvlEl.textContent = lvl;
    lvlEl.dataset.l = lvl;
    slot('msg', row).textContent   = e.msg || '';
    full.appendChild(row);
  });
  list.slice(0, 6).forEach(e => {
    const row = tpl.cloneNode(true);
    slot('time', row).textContent  = fmtClock(e.ts);
    const lvl = e.level || 'info';
    const lvlEl = slot('level', row);
    lvlEl.textContent = lvl;
    lvlEl.dataset.l = lvl;
    slot('msg', row).textContent   = e.msg || '';
    overview.appendChild(row);
  });
}

function renderSettings() {
  slot('set-mode').textContent = STATE.gateway.mode || 'live';
  slot('set-host').textContent = STATE.gateway.hostname || '—';
  slot('set-started').textContent = STATE.gateway.startedAt
    ? new Date(STATE.gateway.startedAt).toLocaleString()
    : '—';
  slot('set-uptime').textContent = STATE.gateway.startedAt
    ? fmtDuration(Date.now() - STATE.gateway.startedAt)
    : '—';
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
  renderKPIs();
  renderPinnedGrid();
  renderDevicesGrid();
  renderNetwork();
  renderEvents();
  renderSettings();
}

/* ------------------------------------------------------------------ *
 * Value flash animation on metric updates                             *
 * ------------------------------------------------------------------ */
function flashChangedTiles(nodeId, prevMetrics, nextMetrics) {
  Object.keys(nextMetrics || {}).forEach(k => {
    const prev = prevMetrics && prevMetrics[k] && prevMetrics[k].value;
    const next = nextMetrics[k] && nextMetrics[k].value;
    if (prev !== next) {
      const el = q(`[data-metric-key="${nodeId}:${k}"]`);
      if (el) {
        el.classList.add('is-flash');
        setTimeout(() => el.classList.remove('is-flash'), 700);
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * Socket wiring                                                       *
 * ------------------------------------------------------------------ */

function setConn(state, label) {
  const pill = q('#connPill');
  pill.dataset.state = state;
  slot('connLabel').textContent = label;
}

function pushEvent(evt) {
  STATE.events.unshift(evt);
  if (STATE.events.length > MAX_EVENTS) STATE.events.length = MAX_EVENTS;
}

function connect() {
  if (typeof io !== 'function') {
    // Socket.IO client not loaded yet — retry after DOM/script settles.
    return setTimeout(connect, 100);
  }
  const socket = io({ transports: ['websocket', 'polling'] });
  window.__chapSocket = socket;

  setConn('connecting', 'Connecting…');

  socket.on('connect', () => {
    setConn('connected', 'Connected');
    pushEvent({ ts: Date.now(), level: 'info', msg: 'socket connected' });
    renderEvents();
  });
  socket.on('disconnect', (reason) => {
    setConn('disconnected', 'Disconnected');
    pushEvent({ ts: Date.now(), level: 'warn', msg: `socket disconnected (${reason})` });
    renderEvents();
  });
  socket.on('reconnect_attempt', () => setConn('connecting', 'Reconnecting…'));
  socket.on('connect_error', () => setConn('disconnected', 'Connection error'));

  socket.on('MOTESDEF',    d => { STATE.motesDef    = d || {}; renderAll(); });
  socket.on('METRICSDEF',  d => { STATE.metricsDef  = d || {}; renderAll(); });
  socket.on('EVENTSDEF',   d => { STATE.eventsDef   = d || {}; });
  socket.on('SETTINGSDEF', () => { /* placeholder for future settings editor */ });
  socket.on('SERVERTIME',  ts => { STATE.serverTimeOffset = Date.now() - ts; });
  socket.on('GATEWAYINFO', info => { STATE.gateway = Object.assign(STATE.gateway, info || {}); renderKPIs(); renderSettings(); });

  socket.on('UPDATENODES', (list) => {
    STATE.nodes.clear();
    (list || []).forEach(n => STATE.nodes.set(n._id, n));
    STATE.lastRx = Date.now();
    renderAll();
  });

  socket.on('UPDATENODE', (node) => {
    if (!node || node._id == null) return;
    const prev = STATE.nodes.get(node._id);
    STATE.nodes.set(node._id, node);
    STATE.lastRx = Date.now();
    // Cheap partial-render: KPIs + relevant grids.
    renderKPIs();
    renderPinnedGrid();
    if (!q('[data-view="devices"]').hidden) renderDevicesGrid();
    if (!q('[data-view="network"]').hidden) renderNetwork();
    if (prev) flashChangedTiles(node._id, prev.metrics, node.metrics);
  });

  socket.on('LOG', (entry) => {
    if (!entry) return;
    pushEvent({
      ts: entry.ts || Date.now(),
      level: entry.level || 'info',
      msg: entry.msg || String(entry)
    });
    renderEvents();
  });
}

/* ------------------------------------------------------------------ *
 * UI wiring                                                           *
 * ------------------------------------------------------------------ */

function wireUI() {
  qa('.nav-item').forEach(a => a.addEventListener('click', () => {
    // hashchange handles the actual view switch
  }));

  q('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('chap-theme', next); } catch { /* ignore */ }
    slot('themeLabel').textContent = next === 'dark' ? 'Light mode' : 'Dark mode';
  });
  try {
    const saved = localStorage.getItem('chap-theme');
    if (saved) {
      document.documentElement.dataset.theme = saved;
      slot('themeLabel').textContent = saved === 'dark' ? 'Light mode' : 'Dark mode';
    }
  } catch { /* ignore */ }

  q('#deviceFilter').addEventListener('input', (e) => {
    STATE.filters.deviceText = e.target.value;
    renderDevicesGrid();
  });
  qa('[data-status]').forEach(btn => btn.addEventListener('click', () => {
    qa('[data-status]').forEach(b => b.classList.toggle('is-active', b === btn));
    STATE.filters.deviceStatus = btn.dataset.status;
    renderDevicesGrid();
  }));
  q('#eventFilter').addEventListener('input', (e) => {
    STATE.filters.eventText = e.target.value;
    renderEvents();
  });
  qa('[data-level]').forEach(btn => btn.addEventListener('click', () => {
    qa('[data-level]').forEach(b => b.classList.toggle('is-active', b === btn));
    STATE.filters.eventLevel = btn.dataset.level;
    renderEvents();
  }));

  // Refresh "age" strings once a second so stale/offline transitions show up.
  setInterval(() => {
    renderKPIs();
    // Update age labels without a full re-render.
    qa('.device-card').forEach(card => {
      const id = parseInt(card.dataset.nodeId, 10);
      const n = STATE.nodes.get(id);
      if (!n) return;
      const dot = slot('status', card);
      const status = nodeStatus(n);
      dot.title = status;
      slot('age', card).textContent = `updated ${fmtRelative(n.updated)}`;
    });
  }, 1000);
}

/* ------------------------------------------------------------------ *
 * Boot                                                                *
 * ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  wireUI();
  setView(location.hash.slice(1) || 'overview');
  connect();
});
