# Gateway migration runbook

This runbook migrates an existing Pi without allowing a second process to open
the radio device. The production gateway remains the only owner of
`/dev/ttyUSB0`. Run the canary and UI on a separate port or hostname first.

## Safety rules

- Run `scripts/gateway-preflight.sh` before changing anything.
- Run `scripts/gateway-backup.sh` before every cutover.
- Keep `settings.json5`, `data/`, TLS keys, and nginx credentials outside Git.
- Do not run two gateway processes against the same serial device.
- `scripts/gateway-cutover.sh` is a dry run unless `--apply` is supplied.

## Staged migration

```bash
cd /home/pi/gateway
./scripts/gateway-preflight.sh
./scripts/gateway-backup.sh
```

Run the modern UI canary separately and point its Socket.IO path at the
existing production gateway. Confirm live node data, history, controls,
authentication, and reconnect behavior before cutover.

When the reviewed release is ready, set `RELEASE_REF` and inspect the plan:

```bash
RELEASE_REF=origin/main ./scripts/gateway-cutover.sh
```

Apply only after reviewing the printed backup, commit, dependency, and service
actions:

```bash
RELEASE_REF=origin/main ./scripts/gateway-cutover.sh --apply
```

Verify `/healthz`, the modern UI, the `/legacy/` fallback, a fresh weather
packet, and the gateway logs. Keep the printed previous commit for rollback.

## Rollback

```bash
RELEASE_REF=<previous-commit> ./scripts/gateway-cutover.sh --apply
```

Restore the database/configuration backup only if verification shows data
corruption; a normal code rollback should reuse the existing data directory.

## Private speed-test providers

The community release keeps the generic `speedtest-net` example. Private
deployments may replace the provider behind an adapter, but private URLs,
tokens, and network-specific schemas must never be committed here.
