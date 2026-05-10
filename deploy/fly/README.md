# Fly.io recipe

Single-VM Fly deploy of the connectors runner. ~5 minutes from zero to a healthy runner with file-backed state, TLS, and `fly secrets` for credentials.

## One-time setup

```bash
# 1. Install + log in to Fly.
brew install flyctl    # or curl -L https://fly.io/install.sh | sh
fly auth login

# 2. Create the app + a persistent volume for cursor state.
fly apps create statewave-connectors-runner
fly volumes create state --region iad --size 1

# 3. Push every secret your TOML references via ${VAR}.
fly secrets set \
  STATEWAVE_URL=https://api.example.com \
  STATEWAVE_API_KEY=… \
  STATEWAVE_METRICS_TOKEN=$(openssl rand -hex 32) \
  GITHUB_TOKEN=ghp_…

# 4. Put your TOML config in a custom image. Easiest: a 2-line Dockerfile:
cat > Dockerfile <<'EOF'
FROM statewavedev/statewave-connectors-runner:latest
COPY statewave-connectors.toml /config/statewave-connectors.toml
EOF

# 5. Copy fly.toml.example to fly.toml (edit `app` if needed) and deploy.
cp fly.toml.example fly.toml
fly deploy
```

## Verify

```bash
fly logs --app statewave-connectors-runner
fly status --app statewave-connectors-runner
curl https://statewave-connectors-runner.fly.dev/healthz
curl -H "Authorization: Bearer $STATEWAVE_METRICS_TOKEN" \
     https://statewave-connectors-runner.fly.dev/metrics
```

## Updating

```bash
# To pull a newer runner image:
fly deploy --image statewavedev/statewave-connectors-runner:0.16.0

# To update only the TOML config (rebuilds the custom image):
$EDITOR statewave-connectors.toml
fly deploy
```

## State considerations

The default `[runner.state] kind = "file"` writes cursors to the `/state` volume mounted on the VM. Single-VM deploys are fine — Fly's volumes are persistent across restarts and image swaps.

For multi-region or multi-machine deploys, switch to:

```toml
[runner.state]
kind = "postgres"
url  = "${STATEWAVE_DB_URL}"
```

Use a Fly Postgres cluster (`fly postgres create`) or any external Postgres. Set `STATEWAVE_DB_URL` via `fly secrets set` and remove the `[mounts]` block from `fly.toml`.

## Push receivers (Slack / Freshdesk / etc.)

The Fly app's public URL (`https://<app>.fly.dev`) reaches every push receiver path mounted by your config. Configure your upstream system's webhook URL as `https://<app>.fly.dev/<connector>/<name>/events`.

For OIDC-protected Gmail Pub/Sub specifically, set the audience to the Fly URL and configure it on the Pub/Sub subscription. The runner verifies the Google-signed token on every delivery.
