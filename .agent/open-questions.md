# Open Questions — agent/md-sync-2026-09-22

## KF3 (control-plane host bind/publish) — needs Ryan's decision

`BEACON_RELAY_KIMI_FIXES.md` item 3 says:
- bind `app.listen` to `127.0.0.1` explicitly
- drop the `9100:9100` port publish from `docker-compose.yml`

Problem: the current dev/test workflow depends on reaching the control plane from **outside** the compose network:
- Host-side tests default to `https://localhost:9100` (`scripts/test_ehr_e2e.js`, `scripts/test_alerting_rbac_audit_support.js`)
- `vm-harness/acceptance.sh` reaches `https://control-plane:9100` from inside the harness container
- `device-sim` reaches `https://control-plane:9100`

If `app.listen` binds `127.0.0.1` inside the control-plane container, neither `device-sim` nor the vm-harness can reach it. If the host port publish is removed, host-side tests cannot reach it either.

Options:
1. Apply the spec literally and accept that host-side tests / vm-harness need a new way to reach the control plane (e.g., run tests inside the compose network, add an explicit proxy service).
2. Apply only the port-publish removal and keep `0.0.0.0` binding, so compose-internal traffic still works but the host network cannot reach the enrollment endpoint directly.
3. Skip KF3 until a real reverse-proxy/VPN topology is defined.

Blocked on Ryan's pick. Not implemented pending decision.

## step-ca Docker health status — RESOLVED

Container `beacon-relay-step-ca` was `unhealthy` at session start. After `docker compose up -d control-plane` (which recreated control-plane and re-evaluated the step-ca dependency), step-ca now reports **healthy**.

## Host port 9100 unavailable on Windows — blocks host-side E2E/acceptance

Attempting to start `control-plane` with `ports: - "9100:9100"` fails:

```
Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:9100 -> 127.0.0.1:0: listen tcp 0.0.0.0:9100: bind: An attempt was made to access a socket in a way forbidden by its access permissions.
```

`netstat` shows nothing listening on 9100, but Windows has an excluded port range `9035-9134` that includes 9100:

```
Start Port    End Port
----------    --------
      9035        9134
```

This is a Windows/Hyper-V administered port exclusion, not a process conflict. Host-side tests (`test_ehr_e2e.js`, `test_alerting_rbac_audit_support.js`) and any host-published `docker-compose.yml` mapping on 9100 cannot work in this environment until the port range changes or the tests are moved inside the compose network.

Blocked on environment fix or workflow change.
