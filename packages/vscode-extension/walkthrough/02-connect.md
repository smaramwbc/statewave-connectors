# Connect your server

The plugin talks to a Statewave server. `statewave.url` defaults to
`http://localhost:8100`, so a local instance needs zero plugin setup. From
that one setting the plugin wires the MCP server into every assistant you
use — no second config file.

## Don't have a server yet? One command starts it

```sh
npx @statewavedev/connectors-cli quickstart
```

That spins up the **server + admin + database** on the defaults the plugin
already expects. Done. Stop later with `... quickstart --down`.

## Or hand-roll Docker Compose yourself

Save this as `statewave.docker-compose.yml` — it brings up the **server**,
the **admin console**, and the **database**:

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: statewave
      POSTGRES_PASSWORD: statewave
      POSTGRES_DB: statewave
    volumes: [statewave-pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U statewave"]
      interval: 2s
      timeout: 5s
      retries: 10
  api:                                       # the Statewave server → :8100
    image: statewavedev/statewave:latest
    ports: ["8100:8100"]
    environment:
      STATEWAVE_DATABASE_URL: postgresql+asyncpg://statewave:statewave@db:5432/statewave
      STATEWAVE_DEBUG: "true"                # local dev only
    depends_on:
      db:
        condition: service_healthy
  admin:                                     # operator console → :8080
    image: statewavedev/statewave-admin:latest
    ports: ["8080:8080"]
    environment:
      STATEWAVE_API_URL: http://api:8100
      STATEWAVE_API_KEY: dev-local-placeholder
      ADMIN_AUTH_DISABLED: "true"            # local dev only
      NODE_ENV: production
    depends_on:
      api:
        condition: service_started
volumes:
  statewave-pgdata:
```

```sh
docker compose -f statewave.docker-compose.yml up -d
curl http://localhost:8100/healthz     # server is up
```

- Server: `http://localhost:8100` (already the plugin default).
- Admin console: `http://localhost:8080` — browse subjects, episodes, memories.
- `statewave.apiKey` can stay empty for local dev. Put a real key in your
  **User** settings (never committed) once you drop `STATEWAVE_DEBUG`.

Production hardening + port-conflict overrides: see the extension README
and `statewave/DOCKER.md`.
