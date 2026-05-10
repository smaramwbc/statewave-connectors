# Railway recipe

Single-service Railway deploy of the connectors runner. Railway autodetects the Dockerfile, attaches a public domain, and provisions a managed Postgres / Redis if you want one.

## One-time setup

```bash
# 1. Install + log in to Railway.
brew install railway
railway login

# 2. Create the project + service. Railway provisions a public URL automatically.
railway init --name statewave-connectors-runner
```

## Wire up the image + config

Railway needs a Dockerfile in the repo root (or pointed at via `dockerfilePath`). Two-line override that bakes your TOML into the published runner image:

```dockerfile
# Dockerfile
FROM statewavedev/statewave-connectors-runner:latest
COPY statewave-connectors.toml /config/statewave-connectors.toml
```

Copy `railway.json.example` → `railway.json` (or use the Railway dashboard) and deploy:

```bash
cp railway.json.example railway.json
railway up
```

## Set secrets

Every `${VAR}` in your TOML must be defined as a Railway environment variable:

```bash
railway variables --set STATEWAVE_URL=https://api.example.com
railway variables --set STATEWAVE_API_KEY=…
railway variables --set STATEWAVE_METRICS_TOKEN=$(openssl rand -hex 32)
railway variables --set GITHUB_TOKEN=ghp_…
```

Or via the Railway dashboard → Variables tab (which also supports referencing variables from other services in the same project — useful for plugging in their managed Postgres / Redis URL).

## State considerations

Railway's default ephemeral filesystem means `[runner.state] kind = "file"` **loses cursor state on every redeploy**. Two production paths:

### a. Add a Railway Volume

In the dashboard → Settings → Volumes → New Volume → mount at `/state`. Then keep `kind = "file"` with `path = "/state/cursors.json"`.

### b. Attach a managed Postgres

```bash
railway add --plugin postgresql
```

Use the auto-provisioned `DATABASE_URL` variable in your TOML:

```toml
[runner.state]
kind = "postgres"
url  = "${DATABASE_URL}"
```

No volume needed; the runner will `CREATE TABLE IF NOT EXISTS` on first boot.

## Verify

```bash
railway logs --service statewave-connectors-runner
curl https://<your-railway-domain>/healthz
curl -H "Authorization: Bearer $STATEWAVE_METRICS_TOKEN" \
     https://<your-railway-domain>/metrics
```

## Push receivers

Railway gives every service a public URL like `https://<service>.up.railway.app`. Configure upstream system webhooks to `https://<service>.up.railway.app/<connector>/<name>/events`.
