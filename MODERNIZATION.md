# Dependency Modernization Plan

This gateway is running a Node stack from ~2016. Nothing here **blocks the new
UI** — the modern dashboard and preview server work fine on top of the current
dependencies — but everything below blocks `npm test` from passing and blocks
routine security patching.

This plan is deliberately staged so each PR can ship, run in the safe preview,
and be rolled back without cascading breakage.

## Guiding rules

- **Never break wire compatibility with the running production gateway.**
  Socket.IO major-version bumps change protocol; both server (`gateway.js`) and
  client (served HTML) must bump in the same PR, and the legacy `/legacy` UI
  will need its Socket.IO client updated in step.
- **Never force a native rebuild on a running Pi 3.** `serialport` needs
  precompiled prebuilds for `arm-linux-gnueabihf` node 20+. Verify prebuild
  availability before pushing to the Pi.
- **Each PR must ship with a working preview.** Cutover happens only when the
  preview has been running the new stack for at least 24h without regression.

## Version target

| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| node | 12.x / 17.x mix | 20 LTS | 20.x is the last release that still ships prebuilds broadly matching the Pi 3 armv7l target. |
| socket.io (server + client) | 1.4.x | 4.7.x | Protocol change; server and client MUST bump together. |
| express | ~4.13 | 4.19.x | Patch-only from stable 4.x; low-risk. |
| body-parser | ^1.15 | (bundled with express 4.19) | Drop the explicit dep; use `express.json()` / `express.urlencoded()`. |
| serialport | ~2.0 | 12.x | Complete API change. Wraps under a small internal adapter so `gateway.js` only calls `readLine()` / `write()`. |
| nedb | ~1.5 | @seald-io/nedb | Community fork; drop-in for `Datastore`. Alternative: migrate to `better-sqlite3`. |
| http-auth | ^2.2 | 4.2.x | Compatible; drop `apr1` support only if we stop using it. |
| compression | ^1.6 | 1.7.x | Patch. |
| morgan | ^1.7 | 1.10.x | Patch. |
| nodemailer | ~1.10 | 6.9.x | Major version jump; API changed but usage in `gateway.js` is minimal. |
| really-need | 1.9 | **drop** | Sole reason `npm test` fails on modern Node. |
| mocha | 2.x | 10.x | Also drops `really-need` dependency. |
| json5 | ~0.4 | 2.2.x | Patch. |
| nconf | ^0.8 | 0.12.x | Patch. |
| request | ^2.69 | **drop** — replace with global `fetch` | `request` is deprecated. Node 20 has `fetch` built in. |
| debug | ^2.2 | 4.3.x | Patch. |
| console-stamp | ~0.2 | 3.1.x | Patch. |
| jquery-mobile / jquery / flot | CDN'd | **drop** | Legacy UI only — retire when `/legacy` retires. Not in package.json. |

## PR sequencing

**PR 1 — non-runtime housekeeping (safe, low-risk)**
- Drop `really-need`, bump `mocha` to 10.
- Bump patch/minor for `express`, `compression`, `morgan`, `http-auth`,
  `json5`, `nconf`, `debug`, `console-stamp`.
- Delete `body-parser` (use built-in equivalents in `httpServer.js`).
- Success criterion: `npm test` passes on Node 20 on both Mac and Pi.
- Preview: unchanged behavior; new UI keeps working.
- Rollback: git revert; nothing wire-facing changed.

**PR 2 — drop `request`, wrap outbound HTTP in `fetch`**
- Replace `request(...)` calls in `metrics.js` and `gateway.js` with a thin
  `httpGet(url, opts)` helper backed by `globalThis.fetch`.
- Success criterion: local weather and speed-test polling still fire.
- Rollback: revert; `request` reappears from lockfile.

**PR 3 — Socket.IO v4 (breaking wire change)**
- Bump `socket.io` server dep to `^4.7`.
- Legacy UI: swap `<script src="/socket.io/socket.io.js"></script>` — v4 client
  is served automatically by the v4 server; API is compatible for the events
  we use (`emit` / `on` on both sides).
- New UI: no code changes required (already uses `io({ transports: ... })`).
- Preview server: same bump.
- Success criterion: connect/reconnect works, `UPDATENODES` / `UPDATENODE` /
  `LOG` events observed unchanged in both UIs.
- Rollback: revert; both sides go back to 1.4 in lockstep.

**PR 4 — Serialport 12 adapter**
- Create `serialAdapter.js` exposing `open(path, {baud})`, `writeLine(str)`,
  and event emitter for `data-line`.
- Rewrite `gateway.js` calls to use the adapter (both branches).
- Bump `serialport` to `^12`, add `@serialport/parser-readline`.
- Verify prebuilds available on `armv7l` Node 20:
  ```
  npm view @serialport/bindings-cpp@12 dist-tags
  npm view @serialport/bindings-cpp@12 gypfile
  ```
- Test on Pi with a spare Moteino (or the safe preview) before cutting over
  production.
- Rollback: revert; the adapter file goes away.

**PR 5 — NeDB fork or SQLite migration (optional, defer)**
- Option A (minimum change): swap `nedb` → `@seald-io/nedb`. One-line dep
  change. Data files remain readable.
- Option B (recommended long-term): move `gatewayLog.db` binary logs to
  `better-sqlite3`. Migration script reads the existing 9-byte records and
  inserts them into an indexed table. Enables real range queries and Grafana
  export.
- Both options are backend-only; no UI change beyond potentially richer
  `GETGRAPHDATA` responses.

## Native-build note for serialport

The reason `npm install` fails today on modern Node is `serialport@2.0.5`
trying to compile against V8 headers that no longer exist. `--ignore-scripts`
succeeds because we skip the native compile, but the module then can't open
the serial device. This is fine for **development / UI work** and **the
preview server** (neither touches serial), but the gateway itself requires the
native binding.

Serialport 12 ships `bindings-cpp` prebuilds for common architectures. On the
Pi 3 (`armv7l`) we specifically need the `linux-arm` prebuild. If a prebuild
isn't available for the pinned Node version, we fall back to compiling with
`node-gyp` — set aside 15–30 minutes and ensure `build-essential` + `python3`
are installed.

## Verification checklist (per PR)

1. `npm ci && npm test` passes on both Mac (Node 20) and Pi (Node 20).
2. `node dev/preview-server.js` starts and serves both `/` and `/legacy`.
3. Fresh browser session: socket connects, three preview nodes appear.
4. Metric flash animation still fires on `UPDATENODE`.
5. `GETGRAPHDATA` returns points for graphable metrics.
6. `CONTROLCLICK` acknowledged (log line in preview; hardware ack in prod).
7. Production `gateway.js` PID unchanged during the test run.

## Out of scope for this modernization

- Migrating off the Moteino radio.
- Replacing the built-in `dbLog` binary log format.
- Introducing a build system (bundler, TypeScript). The new UI is intentionally
  build-free to stay Pi-friendly and to keep the diff auditable.
