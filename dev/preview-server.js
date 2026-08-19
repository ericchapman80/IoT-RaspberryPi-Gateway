/* eslint-disable no-console */
// Safe development preview server for the CHAP IoT gateway UI modernization.
//
// - No serialport, no NeDB writes, no attachment to production hardware.
// - Emits the same Socket.IO event contract as gateway.js so both the legacy
//   UI (/legacy) and the new modernized UI (/) work unmodified.
// - Node/metric/event definitions are loaded from the real metrics.js so the
//   dashboard exercises the actual data model, not a hardcoded mock.
//
// Ports: HTTP 17880, HTTPS 17443. Basic auth via test/testauthfile.txt.
// Start with:   node dev/preview-server.js
//
// This file exists ONLY for the dev preview. Production gateway.js is
// untouched.

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
var HTTP_PORT = parseInt(process.env.PREVIEW_HTTP_PORT || '17880', 10);
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
// Override with PREVIEW_AUTH_FILE=/path/to/htpasswd, or disable entirely with
// PREVIEW_AUTH=off (useful for local development).
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
// Shared assets (images, icons, sounds) from legacy www — served at both roots.
app.use('/images', express.static(path.join(ROOT, 'www', 'images')));
app.use('/sounds', express.static(path.join(ROOT, 'www', 'sounds')));
app.use('/css', express.static(path.join(ROOT, 'www', 'css')));
app.use('/js', express.static(path.join(ROOT, 'www', 'js')));

// Legacy UI at /legacy — the untouched original single-page app.
app.use('/legacy', express.static(path.join(ROOT, 'www')));

// TLS certs — reuse the test dummy certs.
var httpsOpts = {
  key:  fs.readFileSync(path.join(ROOT, 'test', 'dummytls.key')),
  cert: fs.readFileSync(path.join(ROOT, 'test', 'dummytls.crt'))
};

var httpSrv = http.createServer(function (req, res) {
  // Redirect all HTTP to HTTPS on the preview HTTPS port.
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
// Emulated node snapshot — modeled on the production values, but the schema
// is the real one used by gateway.js so the UI is not hardcoded around it.
// ---------------------------------------------------------------------------
var now = Date.now();
var nodes = {
  20: {
    _id: 20,
    label: 'Weather Sensor',
    type: 'WeatherMote',
    updated: now,
    metrics: {
      F: { name: 'F', value: '69.37', unit: '°F', pin: 1, graph: 1, updated: now },
      H: { name: 'H', value: '55.78', unit: '%',  pin: 1, graph: 1, updated: now },
      P: { name: 'P', value: '27.86', unit: '"',  pin: 1, graph: 1, updated: now }
    }
  },
  98: {
    _id: 98,
    label: 'Local Weather',
    type: 'WeatherMote',
    updated: now,
    metrics: {
      F: { name: 'F', value: '74.8',  unit: '°F', pin: 1, updated: now },
      H: { name: 'H', value: '76',    unit: '%',  pin: 1, updated: now },
      P: { name: 'P', value: '30.03', unit: '"',  pin: 1, updated: now }
    }
  },
  99: {
    _id: 99,
    label: 'Speed Test',
    type: 'SpeedTest',
    updated: now,
    metrics: {
      PING: { name: 'PING', value: '69',   unit: 'ms',   pin: 1, updated: now },
      DOWN: { name: 'DOWN', value: '68.2', unit: 'Mbps', pin: 1, updated: now },
      UP:   { name: 'UP',   value: '25.5', unit: 'Mbps', pin: 1, updated: now }
    }
  }
};

// Register a virtual SpeedTest mote type so the UI can find an icon/label.
if (!metricsDef.motes.SpeedTest) {
  metricsDef.motes.SpeedTest = { label: 'Internet Speed Test', icon: 'icon_default.png' };
}
// Register Network metrics so METRICSDEF is not silent about them.
['PING', 'DOWN', 'UP'].forEach(function (k) {
  if (!metricsDef.metrics[k]) {
    metricsDef.metrics[k] = { name: k, pin: 1, graph: 1 };
  }
});

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
  nodes[98].metrics.F.value = jitter(nodes[98].metrics.F.value, 0.05, 1);
  nodes[98].metrics.H.value = jitter(nodes[98].metrics.H.value, 0.3,  0);
  nodes[99].metrics.PING.value = Math.max(5, Math.round(parseFloat(jitter(nodes[99].metrics.PING.value, 6, 0))));
  nodes[99].metrics.DOWN.value = jitter(nodes[99].metrics.DOWN.value, 3.0, 1);
  nodes[99].metrics.UP.value   = jitter(nodes[99].metrics.UP.value,   1.5, 1);
  Object.keys(nodes).forEach(function (id) {
    nodes[id].updated = t;
    Object.keys(nodes[id].metrics).forEach(function (k) { nodes[id].metrics[k].updated = t; });
  });
}

// ---------------------------------------------------------------------------
// Socket.IO — mirrors gateway.js contract.
// ---------------------------------------------------------------------------
var io = socketio(httpsSrv);
var startedAt = Date.now();

io.on('connection', function (socket) {
  console.log('[preview] socket connected', socket.id);
  socket.emit('MOTESDEF', metricsDef.motes);
  socket.emit('METRICSDEF', metricsDef.metrics);
  socket.emit('EVENTSDEF', metricsDef.events);
  socket.emit('SETTINGSDEF', { general: { language: { value: 'en' } } });
  socket.emit('SERVERTIME', Date.now());
  socket.emit('GATEWAYINFO', {
    startedAt: startedAt,
    hostname: 'chapmanpi3-preview',
    mode: 'preview',
    productionSafe: true
  });
  socket.emit('UPDATENODES', sortNodes(Object.keys(nodes).map(function (k) { return nodes[k]; })));

  socket.on('CONTROLCLICK', function (control) {
    // In preview mode we acknowledge but never touch hardware.
    console.log('[preview] CONTROLCLICK (ignored in preview):', JSON.stringify(control));
  });
  socket.on('NODEMESSAGE', function (msg) {
    console.log('[preview] NODEMESSAGE (ignored in preview):', JSON.stringify(msg));
  });
});

// Tick loop: broadcast fresh values every 3s (staggered per-node for UX).
setInterval(function () {
  tickNodes();
  io.emit('UPDATENODE', nodes[20]);
}, 3200);
setInterval(function () {
  io.emit('UPDATENODE', nodes[98]);
}, 5100);
setInterval(function () {
  io.emit('UPDATENODE', nodes[99]);
}, 7300);
setInterval(function () {
  io.emit('SERVERTIME', Date.now());
}, 15000);

// Occasional synthetic log events.
var LOG_LEVELS = ['info', 'info', 'info', 'warn', 'debug'];
var LOG_MSGS = [
  '20:F:69.37 H:55.78 P:27.86',
  '99:PING:69 DOWN:68.2 UP:25.5',
  '98:F:74.8 H:76 P:30.03',
  'Serial packet accepted [len=27]',
  'Housekeeping: NeDB compacted (preview)'
];
setInterval(function () {
  var level = LOG_LEVELS[Math.floor(Math.random() * LOG_LEVELS.length)];
  var msg = LOG_MSGS[Math.floor(Math.random() * LOG_MSGS.length)];
  io.emit('LOG', { ts: Date.now(), level: level, msg: msg });
}, 4500);

process.on('SIGINT', function () { console.log('[preview] shutting down'); process.exit(0); });
process.on('SIGTERM', function () { console.log('[preview] shutting down'); process.exit(0); });
