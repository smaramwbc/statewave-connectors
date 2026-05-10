# Statewave connectors runner — Helm chart

Deploys the [connectors runner](https://github.com/smaramwbc/statewave-connectors/tree/main/packages/runner) as a Kubernetes Deployment + Service, with optional Ingress and Prometheus-Operator ServiceMonitor.

## Quick install

```bash
helm install my-runner \
  oci://ghcr.io/smaramwbc/charts/connectors-runner \
  --namespace statewave \
  --create-namespace \
  -f my-values.yaml
```

(Or clone the repo and run `helm install my-runner ./helm/connectors-runner -f my-values.yaml`.)

## Minimal `my-values.yaml`

```yaml
config:
  toml: |
    [statewave]
    url     = "${STATEWAVE_URL}"
    api_key = "${STATEWAVE_API_KEY}"

    [runner]
    log_format = "json"

    [runner.state]
    kind = "file"
    path = "/state/cursors.json"

    [runner.metrics.auth]
    kind  = "bearer"
    token = "${STATEWAVE_METRICS_TOKEN}"

    [[pull.github]]
    name     = "main"
    schedule = "every 1h"
    repo     = "smaramwbc/statewave"
    token    = "${GITHUB_TOKEN}"

secrets:
  STATEWAVE_URL: "https://api.example.com"
  STATEWAVE_API_KEY: "..."
  STATEWAVE_METRICS_TOKEN: "..."
  GITHUB_TOKEN: "..."
```

## What's in the chart

- **Deployment** — runs the runner image. Liveness → `/healthz`, readiness → `/readyz`. Read-only rootfs, non-root user, dropped capabilities.
- **ConfigMap** — your TOML config, mounted at `/config/statewave-connectors.toml`. The Deployment includes a `checksum/config` annotation so a config edit forces a rolling restart.
- **Secret** — env vars referenced by `${VAR}` in the TOML. Use `existingSecret` to point at an externally-managed Secret (External Secrets Operator, Sealed Secrets, SOPS).
- **PersistentVolumeClaim** — only when `persistence.enabled = true` (default), needed for `[runner.state] kind = "file"`.
- **Service** — ClusterIP on port 3000 by default.
- **Ingress** — opt-in via `ingress.enabled = true`.
- **ServiceMonitor** — opt-in via `serviceMonitor.enabled = true`. Bearer-token auth supported via `serviceMonitor.bearerTokenSecret`.

## Multi-replica deployments

`[runner.state] kind = "file"` is **single-process only** — the PVC is RWO. For `replicaCount > 1`, switch to:

```yaml
config:
  toml: |
    …
    [runner.state]
    kind = "postgres"
    url  = "${POSTGRES_URL}"

persistence:
  enabled: false   # no PVC needed for postgres / redis state
```

The chart's `NOTES.txt` warns when these settings are out of sync.

## Externally-managed secrets

For production, prefer External Secrets Operator / Sealed Secrets / SOPS over inline `secrets:` values:

```yaml
existingSecret: my-runner-secrets   # already-applied Secret in the same namespace
secrets: {}
```

Every key in the referenced Secret becomes an env var on the pod. Reference them via `${VAR}` in the TOML.

## Source

Chart lives at <https://github.com/smaramwbc/statewave-connectors/tree/main/helm/connectors-runner>. License: Apache-2.0.
