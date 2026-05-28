# @statewavedev/connectors-zapier

Zapier integration helper for Statewave — turns "Webhooks by Zapier → POST" payloads into normalized Statewave episodes.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## Why this is a helper, not a sync connector

Zapier deliberately does **not** expose a public API for enumerating other zaps' run history. Zap History lives in the Zapier UI; there is no `GET /executions` like n8n has. So a pull-mode "sync connector" can't be built the same way.

The integration shape is push-mode instead: **users add a "Webhooks by Zapier → POST" step at the end of their zap**, and the POST goes either directly to Statewave's `/v1/episodes/batch` endpoint, or to a small server they run themselves that uses this helper to massage the payload first.

| Path | When to use it | Code from us |
|---|---|---|
| **Direct** — POST straight to `/v1/episodes/batch` | You're happy shaping the request body inside Zapier's "Custom Request" UI and sending one episode per zap run. | None. Just docs (below). |
| **Helper** — POST to your own server, then forward | You want server-side validation, auth, redaction, batching, or to massage the payload before forwarding. | `formatZapToEpisode()` from this package. |

## Path A — direct from Zapier (no code from us)

Add a final step to your zap:

1. **Action**: "Webhooks by Zapier" → "POST"
2. **URL**: `https://your-statewave-instance/v1/episodes/batch`
3. **Payload type**: JSON
4. **Headers**:
   ```
   Content-Type: application/json
   X-API-Key: <your Statewave API key>
   ```
5. **Data** (Zapier's payload editor — substitute Zap variables with `{{...}}`):
   ```json
   {
     "episodes": [
       {
         "subject": "workflow:zap:12345",
         "kind": "zapier.zap.executed",
         "text": "Daily Slack digest ran successfully",
         "occurred_at": "{{zap_meta__timestamp}}",
         "source": {
           "type": "zapier.zap_run",
           "id": "12345:{{zap_meta__id}}",
           "url": "https://zapier.com/app/zaps/12345"
         },
         "metadata": {
           "zap_id": "12345",
           "zap_name": "Daily Slack digest",
           "run_id": "{{zap_meta__id}}"
         },
         "idempotency_key": "zapier:12345:{{zap_meta__id}}:zap.executed"
       }
     ]
   }
   ```

That's the full integration. No code, no review cycle, works today.

## Path B — helper for your own server

If you'd rather receive the Zap webhook on your own server (Vercel / Cloudflare Workers / Express / etc.) and forward to Statewave with extra logic, install:

```bash
npm install @statewavedev/connectors-zapier @statewavedev/connectors-core
```

Configure the Zap to POST a flat payload like:

```json
{
  "subject": "workflow:zap:12345",
  "zap_id": "12345",
  "zap_name": "Daily Slack digest",
  "run_id": "{{zap_meta__id}}",
  "status": "success",
  "occurred_at": "{{zap_meta__timestamp}}",
  "data": { "record_id": "{{record_id}}", "customer_email": "{{customer_email}}" }
}
```

Then in your handler:

```ts
import { formatZapToEpisode } from "@statewavedev/connectors-zapier";

export async function handleZapWebhook(req: Request): Promise<Response> {
  const payload = await req.json();
  const episode = formatZapToEpisode(payload, {
    url: `https://zapier.com/app/zaps/${payload.zap_id}`,
  });

  await fetch(`${process.env.STATEWAVE_URL}/v1/episodes/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.STATEWAVE_API_KEY!,
    },
    body: JSON.stringify({ episodes: [episode] }),
  });

  return new Response(null, { status: 204 });
}
```

`formatZapToEpisode` is pure — it builds an idempotency key from `zap_id + run_id`, picks `zapier.zap.executed` vs `zapier.zap.failed` based on `status`, and lets you override the subject and source URL via the second argument.

## What it produces

| Input `status` | Episode `kind` |
|---|---|
| `"success"` | `zapier.zap.executed` |
| anything else | `zapier.zap.failed` (literal status preserved in `metadata.zap_status`) |

Default subject: whatever you pass under `subject`. There's no platform-derived default — the user knows whether the zap operates on a customer, workflow, or team.

## Example episode

```json
{
  "subject": "customer:acme",
  "kind": "zapier.zap.executed",
  "text": "Zap \"New Stripe charge → notify\" run succeeded",
  "occurred_at": "2026-05-20T09:12:00.000Z",
  "source": { "type": "zapier.zap_run", "id": "12345:run_67890" },
  "metadata": { "zap_status": "success" }
}
```

This is what `formatZapToEpisode()` produces (and what you POST to `/v1/episodes/batch`). `status: "success"` → `zapier.zap.executed`; any other status → `zapier.zap.failed`.

## Status

`v0.1.0` — helper + integration guide. The Zapier directory app (a "Send Episode to Statewave" custom action users add to their zaps) is a separate effort, planned for a follow-up release once there's signal that the directory listing is worth the review cycle.
