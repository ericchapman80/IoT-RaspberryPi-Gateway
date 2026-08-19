/* eslint-disable no-console */
// Safe development preview server for the CHAP IoT gateway UI modernization.
//
// - No serialport, no NeDB writes, no attachment to production hardware.
// - Emits the same Socket.IO event contract as gateway.js so both the legacy
//   UI (/legacy) and the new modernized UI (/) work unmodified.
// - Node/metric/event definitions are loaded from the real metrics.js so the
//   dashboard exercises the actual data model, not a hardcoded mock.
//
// Ports: HTTP 17880, HTTPS 17443. Basic auth via dev/preview-auth (chap/chap).
// Start with:   node dev/preview-server.js
// Disable auth: PREVIEW_AUTH=off node dev/preview-server.js

var path = require('path');
var fs = require('fs');
var http = require('http');
var https = require('https');
var express = require('express');
var auth = require('http-auth');
var compression = require('compression');
var morgan = require('morgan');
var socketio = require('socket.io');

var ROOT = path.resolve(__dirname, '..');
var HTTP_PORT  = parseInt(process.env.PREVIEW_HTTP_PORT  || '17880', 10);
var HTTPS_PORT = parseInt(process.env.PREVIEW_HTTPS_PORT || '17443', 10);

// Load the real metrics/motes/events definitions.
var metricsDef;
try {
  metricsDef = require(path.join(ROOT, 'metrics.js'));
} catch (e) {
  console.warn('[preview] metrics.js not loadable (', e.message, ') — using minimal stub');
  metricsDef = { motes: {}, metrics: {}, events: {} };
}

// Basic auth. Default preview credentials: chap / chap
// Override with PREVIEW_AUTH_FILE=/path/to/htpasswd, or PREVIEW_AUTH=off to disable.
var authFile = process.env.PREVIEW_AUTH_FILE || path.join(ROOT, 'dev', 'preview-auth');
var app = express();
app.use(morgan('dev'));
app.use(compression());
if (process.env.PREVIEW_AUTH !== 'off') {
  var authBasic = auth.basic({ realm: 'CHAP Gateway Preview', file: authFile });
  app.use(auth.connect(authBasic));
}

// Modernized UI at /
app.use('/', express.static(path.join(ROOT, 'www', 'app'), { extensions: ['html'] }));
// Shared assets served at both roots.
app.use('/images', express.static(path.join(ROOT, 'www', 'images')));
app.use('/sounds', express.static(path.join(ROOT, 'www', 'sounds')));
app.use('/css',    express.static(path.join(ROOT, 'www', 'css')));
app.use('/js',     express.static(path.join(ROOT, 'www', 'js')));
// Legacy UI at /legacy — the untouched original single-page app.
app.use('/legacy', express.static(path.join(ROOT, 'www')));

var httpsOpts = {
  key:  fs.readFileSync(path.join(ROOT, 'test', 'dummytls.key')),
  cert: fs.readFileSync(path.join(ROOT, 'test', 'dummytls.crt'))
};

var httpSrv = http.createServer(function (req, res) {
  var host = (req.headers.host || '').split(':')[0];
  res.writeHead(302, { Location: 'https://' + host + ':' + HTTPS_PORT + req.url });
  res.end();
}).listen(HTTP_PORT, function () {
  console.log('[preview] HTTP redirect on ' + HTTP_PORT);
});

var httpsSrv = https.createServer(httpsOpts, app).listen(HTTPS_PORT, function () {
  console.log('[preview] HTTPS + Socket.IO on ' + HTTPS_PORT);
  console.log('[preview] open https://chapmanpi3.local:' + HTTPS_PORT + '/');
});

// ---------------------------------------------------------------------------
// Emulated node snapshot — modeled on real production values, schema matches
// what gateway.js actually emits so the UI is not hardcoded around it.
// ---------------------------------------------------------------------------
var now = Date.now();
var nodes = {
  20: {
    _id: 20,
    label: 'Weather Sensor',
    type: 'WeatherMote',
    descr: 'Backyard weather station',
    rssi: -68,
    updated: now,
    metrics: {
      F: { name: 'F', value: '69.37', unit: '°F', pin: 1, graph: 1, updated: now },
      H: { name: 'H', value: '55.78', unit: '%',  pin: 1, graph: 1, updated: now },
      P: { name: 'P', value: '27.86', unit: '"',  pin: 1, graph: 1, updated: now },
      V: { name: 'V', value: '3.24',  unit: 'v',  pin: 0, graph: 1, updated: now }
    }
  },
  98: {
    _id: 98,
    label: 'Local Weather',
    type: 'WeatherMote',
    descr: 'Local forecast (weather.gov)',
    rssi: null, // pulled from HTTP, not radio
    updated: now,
    metrics: {
      F: { name: 'F', value: '74.8',  unit: '°F', pin: 1, updated: now, graph: 1 },
      H: { name: 'H', value: '76',    unit: '%',  pin: 1, updated: now, graph: 1 },
      P: { name: 'P', value: '30.03', unit: '"',  pin: 1, updated: now, graph: 1 }
    }
  },
  99: {
    _id: 99,
    label: 'Speed Test',
    type: 'SpeedTest',
    descr: 'Internet uplink health',
    rssi: null,
    updated: now,
    metrics: {
      PING: { name: 'PING', value: '69',   unit: 'ms',   pin: 1, graph: 1, updated: now },
      DOWN: { name: 'DOWN', value: '68.2', unit: 'Mbps', pin: 1, graph: 1, updated: now },
      UP:   { name: 'UP',   value: '25.5', unit: 'Mbps', pin: 1, graph: 1, updated: now }
    }
  }
};

// Register a virtual SpeedTest mote type so the UI can find an icon/label.
if (!metricsDef.motes.SpeedTest) {
  metricsDef.motes.SpeedTest = { label: 'Internet Speed Test', icon: 'icon_default.png' };
}
// Register network metrics so METRICSDEF is not silent about them.
['PING', 'DOWN', 'UP'].forEach(function (k) {
  if (!metricsDef.metrics[k]) {
    metricsDef.metrics[k] = { name: k, pin: 1, graph: 1 };
  }
});

// ---------------------------------------------------------------------------
// Synthetic history — 60 minutes of 30s-spaced points per graphable metric,
// backfilled at startup so the drawer sparklines are populated on first paint.
// A real gateway keeps this in NeDB/binary logs; this ring buffer is only for
// the preview.
// ---------------------------------------------------------------------------
var HISTORY_WINDOW_MS = 60 * 60 * 1000;
var HISTORY_STEP_MS   = 30 * 1000;
var history = {}; // key `${nodeId}:${metricKey}` → [{t, v}]

function histKey(nodeId, key) { return nodeId + ':' + key; }
function pushHistory(nodeId, key, t, v) {
  var k = histKey(nodeId, key);
  var arr = history[k] || (history[k] = []);
  var num = parseFloat(v);
  if (!isFinite(num)) return;
  arr.push({ t: t, v: num });
  var cutoff = t - HISTORY_WINDOW_MS;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}
function backfillHistory() {
  var end = Date.now();
  var start = end - HISTORY_WINDOW_MS;
  Object.keys(nodes).forEach(function (id) {
    var n = nodes[id];
    Object.keys(n.metrics).forEach(function (k) {
      var m = n.metrics[k];
      if (!(m.graph === 1 || m.graph === '1')) return;
      var base = parseFloat(m.value);
      if (!isFinite(base)) return;
      var spread = k === 'DOWN' ? 8 : k === 'UP' ? 3 : k === 'PING' ? 12 :
                   k === 'F' ? 3.5 : k === 'H' ? 6 : k === 'P' ? 0.15 :
                   k === 'V' ? 0.05 : Math.abs(base) * 0.05 + 0.5;
      var v = base;
      for (var t = start; t <= end; t += HISTORY_STEP_MS) {
        // random walk around the base value so it looks like real telemetry
        v = v + (Math.random() - 0.5) * (spread / 6);
        v = v * 0.85 + base * 0.15; // pull gently back toward base
        pushHistory(parseInt(id, 10), k, t, v);
      }
    });
  });
}
backfillHistory();

function sortNodes(list) {
  return list.slice().sort(function (a, b) { return a._id - b._id; });
}
function jitter(base, spread, decimals) {
  var n = parseFloat(base) + (Math.random() - 0.5) * spread;
  return n.toFixed(decimals);
}
function tickNodes() {
  var t = Date.now();
  nodes[20].metrics.F.value = jitter(nodes[20].metrics.F.value, 0.15, 2);
  nodes[20].metrics.H.value = jitter(nodes[20].metrics.H.value, 0.4,  2);
  nodes[20].metrics.P.value = jitter(nodes[20].metrics.P.value, 0.02, 2);
  nodes[20].metrics.V.value = jitter(nodes[20].metrics.V.value, 0.005, 2);
  nodes[20].rssi = Math.round(-60 + (Math.random() - 0.5) * 10);
  nodes[98].metrics.F.value = jitter(nodes[98].metrics.F.value, 0.05, 1);
  nodes[98].metrics.H.value = jitter(nodes[98].metrics.H.value, 0.3,  0);
  nodes[99].metrics.PING.value = Math.max(5, Math.round(parseFloat(jitter(nodes[99].metrics.PING.value, 6, 0))));
  nodes[99].metrics.DOWN.value = jitter(nodes[99].metrics.DOWN.value, 3.0, 1);
  nodes[99].metrics.UP.value   = jitter(nodes[99].metrics.UP.value,   1.5, 1);
  Object.keys(nodes).forEach(function (id) {
    nodes[id].updated = t;
    Object.keys(nodes[id].metrics).forEach(function (k) {
      var m = nodes[id].metrics[k];
      m.updated = t;
      if (m.graph === 1) pushHistory(parseInt(id, 10), k, t, m.value);
    });
  });
}

// ---------------------------------------------------------------------------
// Socket.IO — mirrors gateway.js contract, extended with GATEWAYINFO.
// ---------------------------------------------------------------------------
var io = socketio(httpsSrv);
var startedAt = Date.now();
var recentLog = []; // last 200 log entries (for the preview only)
function logEmit(entry) {
  recentLog.unshift(entry);
  if (recentLog.length > 200) recentLog.length = 200;
  io.emit('LOG', entry);
}

io.on('connection', function (socket) {
  console.log('[preview] socket connected', socket.id);
  socket.emit('MOTESDEF',    metricsDef.motes);
  socket.emit('METRICSDEF',  metricsDef.metrics);
  socket.emit('EVENTSDEF',   metricsDef.events);
  socket.emit('SETTINGSDEF', { general: { language: { value: 'en' } } });
  socket.emit('SERVERTIME',  Date.now());
  socket.emit('GATEWAYINFO', {
    startedAt: startedAt,
    hostname: require('os').hostname(),
    mode: 'preview',
    productionSafe: true
  });
  socket.emit('UPDATENODES', sortNodes(Object.keys(nodes).map(function (k) { return nodes[k]; })));
  // Replay a few recent logs so the events pane has content on first paint.
  recentLog.slice(0, 20).forEach(function (e) { socket.emit('LOG', e); });

  // -------- Legacy gateway.js contract handlers (preview replay) ----------

  // History fetch — matches the existing GETGRAPHDATA contract used by the
  // legacy UI (and now the new node-detail drawer).
  socket.on('GETGRAPHDATA', function (nodeId, metricKey, start, end) {
    var k = histKey(nodeId, metricKey);
    var series = (history[k] || []).filter(function (p) { return p.t >= start && p.t <= end; });
    var def = metricsDef.metrics[metricKey] || {};
    socket.emit('GRAPHDATAREADY', {
      graphData: { data: series, queryTime: 0 },
      options: {
        metricName: metricKey,
        nodeId: nodeId,
        legendLbl: (def.graphOptions && def.graphOptions.legendLbl) || def.name || metricKey,
        unit: def.unit || (nodes[nodeId] && nodes[nodeId].metrics[metricKey] && nodes[nodeId].metrics[metricKey].unit) || ''
      }
    });
  });

  socket.on('UPDATENODESETTINGS', function (node) {
    if (!node || node._id == null || !nodes[node._id]) return;
    var n = nodes[node._id];
    if (typeof node.label === 'string') n.label = node.label;
    if (typeof node.descr === 'string') n.descr = node.descr;
    if (typeof node.type  === 'string' && metricsDef.motes[node.type]) n.type = node.type;
    io.emit('UPDATENODE', n);
    logEmit({ ts: Date.now(), level: 'info', msg: 'settings updated for node ' + node._id });
  });

  socket.on('UPDATEMETRICSETTINGS', function (nodeId, metricKey, metric) {
    var n = nodes[nodeId]; if (!n || !n.metrics[metricKey]) return;
    var m = n.metrics[metricKey];
    if (typeof metric.label === 'string') m.label = metric.label;
    if (metric.pin   !== undefined) m.pin   = metric.pin ? 1 : 0;
    if (metric.graph !== undefined) m.graph = metric.graph ? 1 : 0;
    io.emit('UPDATENODE', n);
    logEmit({ ts: Date.now(), level: 'info', msg: 'metric ' + nodeId + ':' + metricKey + ' updated' });
  });

  socket.on('EDITNODEEVENT', function (nodeId, eventKey, enabled, remove) {
    var n = nodes[nodeId]; if (!n) return;
    n.events = n.events || {};
    if (remove) delete n.events[eventKey];
    else n.events[eventKey] = { enabled: !!enabled };
    io.emit('UPDATENODE', n);
    logEmit({ ts: Date.now(), level: 'info', msg: 'event ' + eventKey + ' ' + (remove ? 'removed' : (enabled ? 'enabled' : 'disabled')) + ' on node ' + nodeId });
  });

  socket.on('DELETENODE', function (nodeId) {
    if (!nodes[nodeId]) return;
    delete nodes[nodeId];
    io.emit('UPDATENODES', sortNodes(Object.keys(nodes).map(function (k) { return nodes[k]; })));
    logEmit({ ts: Date.now(), level: 'warn', msg: 'node ' + nodeId + ' deleted (preview only)' });
  });

  socket.on('DELETENODEMETRIC', function (nodeId, metricKey) {
    var n = nodes[nodeId]; if (!n) return;
    delete n.metrics[metricKey];
    io.emit('UPDATENODE', n);
    logEmit({ ts: Date.now(), level: 'warn', msg: 'metric ' + metricKey + ' removed from node ' + nodeId + ' (preview only)' });
  });

  socket.on('CONTROLCLICK', function (control) {
    // In preview we acknowledge and echo state changes for switch-like
    // controls so the UI can show the resulting state, but nothing is sent
    // to hardware.
    console.log('[preview] CONTROLCLICK', JSON.stringify(control));
    logEmit({ ts: Date.now(), level: 'info', msg: 'CONTROLCLICK ' + (control && control.action || '?') + ' on node ' + (control && control.nodeId) });
    // Best-effort: if action matches BTNn:0/1 or STS/BELL, toggle a preview metric.
    try {
      var n = nodes[control.nodeId]; if (!n) return;
      var a = String(control.action || '');
      var m;
      if ((m = a.match(/^BTN(\d):([01])$/i)))  n.metrics['B' + m[1]] = Object.assign(n.metrics['B' + m[1]] || { name: 'B' + m[1] }, { value: m[2] === '1' ? 'ON' : 'OFF', updated: Date.now() });
      else if ((m = a.match(/^BELL:([01])$/i))) n.metrics['Status'] = Object.assign(n.metrics['Status'] || { name: 'Status' }, { value: m[1] === '1' ? 'ON' : 'OFF', updated: Date.now() });
      n.updated = Date.now();
      io.emit('UPDATENODE', n);
    } catch (e) { /* preview only */ }
  });

  socket.on('NODEMESSAGE', function (msg) {
    console.log('[preview] NODEMESSAGE (ignored):', JSON.stringify(msg));
    logEmit({ ts: Date.now(), level: 'info', msg: 'NODEMESSAGE queued for ' + (msg && msg.nodeId) + ' (preview: no radio)' });
  });
});

// Tick loop: broadcast fresh values, staggered per-node for UX.
setInterval(function () { tickNodes(); io.emit('UPDATENODE', nodes[20]); }, 3200);
setInterval(function () { io.emit('UPDATENODE', nodes[98]); }, 5100);
setInterval(function () { io.emit('UPDATENODE', nodes[99]); }, 7300);
setInterval(function () { io.emit('SERVERTIME', Date.now()); }, 15000);

// Occasional synthetic log entries.
var LOG_LEVELS = ['info', 'info', 'info', 'warn', 'debug'];
var LOG_MSGS = [
  '[20] F:69.37 H:55.78 P:27.86 V:3.24 [RSSI:-68]',
  '[99] PING:69 DOWN:68.2 UP:25.5',
  '[98] F:74.8 H:76 P:30.03',
  'Serial packet accepted (len=27)',
  'Housekeeping: gatewayLog.db compacted (preview)'
];
setInterval(function () {
  logEmit({
    ts: Date.now(),
    level: LOG_LEVELS[Math.floor(Math.random() * LOG_LEVELS.length)],
    msg: LOG_MSGS[Math.floor(Math.random() * LOG_MSGS.length)]
  });
}, 4500);

process.on('SIGINT',  function () { console.log('[preview] shutting down'); process.exit(0); });
process.on('SIGTERM', function () { console.log('[preview] shutting down'); process.exit(0); });
