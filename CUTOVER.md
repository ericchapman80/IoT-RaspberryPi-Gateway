# Production Cutover Plan

Moving the modernized UI from the safe preview into the live production
gateway on `chapmanpi3.local`, without disturbing radio operation.

## Current state

- **Production**: `/home/pi/gateway/gateway.js` (PID 533 at time of writing),
  managed by a shell wrapper that appends stdout to
  `/home/pi/gateway/logs/gateway.sys.log`. Serves the legacy UI from
  `/home/pi/gateway/www/`. Owns the serial device.
- **Preview**: `/home/pi/projects/IoT-RaspberryPi-Gateway-ExpressJS-dev/`,
  running `dev/preview-server.js` on 17880/17443. No serial. Different port,
  different auth file. Isolated.

## Goal

The production gateway (`gateway.js`) serves the **new UI at `/`** and keeps
the **legacy UI at `/legacy`** for one release cycle before removal. No
Socket.IO contract changes are required at cutover time — every event the new
UI uses is already emitted by the real `gateway.js`.

## Design

1. Keep the modern UI checked into the same repo, at `www/app/`.
2. Have `httpServer.js` mount `www/app` at `/` and `www` at `/legacy`.
3. Wrap the live process in a systemd unit so restart / status / logs go
   through standard tooling instead of a `sh -c … >> log 2>&1` wrapper.

## Prerequisites

- [ ] MODERNIZATION.md PR 1 has landed (mocha 10, `really-need` gone, base
      deps patched). Not strictly required for cutover, but reduces risk.
- [ ] Preview has run for ≥24 h with no `[preview] shutting down` in the log
      other than manual restarts.
- [ ] `gatewayLog.db` on production has been backed up (`data/gatewayLog.db*`)
      because a restart re-loads the same NeDB files.

## Changes to `httpServer.js`

Two-line patch inside `createExpressApp`, immediately before the existing
`express.static(path.join(__dirname, 'www'))` line:

```diff
+ // Modernized UI at /, legacy retained at /legacy for one release cycle.
+ app.use('/', express.static(path.join(__dirname, 'www', 'app'), { extensions: ['html'] }));
+ app.use('/legacy', express.static(path.join(__dirname, 'www')));
- app.use(express.static(path.join(__dirname, 'www')));
+ // Shared assets (images/js/css/sounds) still resolve because they live under
+ // /www and are referenced by absolute paths (/images/... /css/... /js/...).
+ app.use('/images', express.static(path.join(__dirname, 'www', 'images')));
+ app.use('/sounds', express.static(path.join(__dirname, 'www', 'sounds')));
+ app.use('/css',    express.static(path.join(__dirname, 'www', 'css')));
+ app.use('/js',     express.static(path.join(__dirname, 'www', 'js')));
```

That's the entire application-code change required for cutover.

## Systemd unit

Create `/etc/systemd/system/chap-gateway.service` on the Pi:

```ini
[Unit]
Description=CHAP IoT Gateway
After=network-online.target
Wants=network-online.target

[Service]
User=pi
Group=pi
WorkingDirectory=/home/pi/gateway
ExecStart=/usr/bin/node /home/pi/gateway/gateway.js
Restart=on-failure
RestartSec=5s
StandardOutput=append:/home/pi/gateway/logs/gateway.sys.log
StandardError=append:/home/pi/gateway/logs/gateway.sys.log

[Install]
WantedBy=multi-user.target
```

Register once:

```bash
sudo systemctl daemon-reload
sudo systemctl enable chap-gateway.service
```

The existing shell-wrapper start script should be removed from
`/etc/rc.local` / crontab / wherever it currently lives — do **not** run both.

## Cutover procedure

Run these on `chapmanpi3` in order. **Read each step before running it.**
Every step is reversible until step 6.

```bash
# 0. Precondition: preview must be healthy.
curl -sk -u chap:chap https://localhost:17443/ | head -1  # <!doctype html>

# 1. Snapshot production data (belt and suspenders).
sudo cp -a /home/pi/gateway/data /home/pi/gateway/data.bak-$(date +%F)

# 2. Pull the modernization branch into production.
cd /home/pi/gateway
sudo -u pi git fetch --all
sudo -u pi git stash -u              # save any local drift
sudo -u pi git checkout ExpressJS-dev
sudo -u pi git pull --ff-only

# 3. Install deps without touching serialport native scripts.
sudo -u pi npm install --ignore-scripts --no-audit --no-fund

# 4. Sanity check on a spare port BEFORE cutting over.
sudo -u pi PREVIEW_HTTPS_PORT=18443 PREVIEW_HTTP_PORT=18880 \
  node dev/preview-server.js &
curl -sk -u chap:chap https://localhost:18443/ | head -1
kill %1

# 5. Register the new systemd unit (see previous section).
#    Do NOT start it yet. The old wrapper is still running.

# 6. Cut over. Stop the wrapper, start systemd.
OLDPID=$(pgrep -f '/home/pi/gateway/gateway.js' | head -1)
sudo kill -TERM "$OLDPID"                   # graceful
sleep 3
pgrep -f '/home/pi/gateway/gateway.js' && sudo kill -9 "$OLDPID"
sudo systemctl start chap-gateway.service
sudo systemctl status chap-gateway.service  # active (running)

# 7. Verify.
curl -sk -u admin:XXXX https://localhost:8443/ | grep -c 'CHAP'   # >=1
curl -sk -u admin:XXXX https://localhost:8443/legacy/ | grep -c 'Moteino'  # >=1
tail -f /home/pi/gateway/logs/gateway.sys.log     # watch for radio traffic
```

## Rollback (any time within the first 30 minutes)

```bash
sudo systemctl stop chap-gateway.service
sudo systemctl disable chap-gateway.service
cd /home/pi/gateway
sudo -u pi git checkout main                  # or the tagged previous release
sudo -u pi bash /home/pi/gateway/start.sh     # whatever the wrapper was
```

If the data snapshot from step 1 is needed:

```bash
sudo systemctl stop chap-gateway.service
sudo rm -rf /home/pi/gateway/data
sudo cp -a /home/pi/gateway/data.bak-YYYY-MM-DD /home/pi/gateway/data
sudo systemctl start chap-gateway.service
```

## Post-cutover verification (first 24 h)

- [ ] `systemctl status chap-gateway` shows `active (running)`, no restarts.
- [ ] Weather sensor node 20 has appeared in the new UI and metric values
      match the last known good values from the legacy UI.
- [ ] `gatewayLog.db` file size is still growing (radio still landing).
- [ ] `journalctl -u chap-gateway -n 200` clean — no `SerialPort` errors.
- [ ] All existing devices (garage, switches, motion, mailbox, sprinklers,
      water meter, sonar) render with correct icons and metrics.
- [ ] Control buttons on garage / switch cards drive the real hardware.
- [ ] Speed-test still runs on its interval and populates node 99.

## Legacy retirement (T + 1 release)

After the new UI has been the default for one full release cycle with no
regressions, `/legacy` and the entirety of `www/index.html`, `www/js/*`,
`www/css/*` can be deleted in a separate PR. Nothing else in the tree
references them.
