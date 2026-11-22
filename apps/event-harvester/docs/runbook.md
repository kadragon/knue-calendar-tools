# Harvester Runbook

Run commands from `apps/event-harvester`. Use Node.js 22 or newer and the Wrangler
installed by `npm ci`. The staging environment has a separate Worker and Durable
Object with its schedule disabled. The production Worker runs every 15 minutes.

## Settings

| Setting | Purpose |
| --- | --- |
| `AI_GATEWAY_URL` | Full provider-native URL ending in `/openai/chat/completions` |
| `AI_GATEWAY_TOKEN` | Token for the authenticated gateway |
| `OPENAI_MODEL` | OpenAI model with image and structured output support |
| `GOOGLE_CALENDAR_ID` | Calendar shared with the service account |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account credentials as a single JSON string |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID` | Optional notification destination |
| `STATE_IMPORT_TOKEN` | Temporary secret enabling the snapshot endpoint |
| `SIMILARITY_THRESHOLD`, `LOOKBACK_DAYS` | Optional matching overrides, defaulting to 0.85 and 60 |

Configure the OpenAI API key as BYOK in AI Gateway. Set credentials as Worker
secrets in the intended environment and use separate test credentials and a
separate Google Calendar for staging. A protected JSON file or standard input
can be passed to `npx wrangler secret bulk --env staging`.

## Local and staging verification

Run `npm run test:coverage` for local scheduled runs with stubbed services. For a
manual local run, supply test settings in an ignored `.dev.vars`, initialize the
local Durable Object using the import endpoint, then run
`npm run dev -- --test-scheduled`. Wrangler exposes a local handler at
`/cdn-cgi/local/scheduled`.

For staging, use `npm run deploy -- --env staging` after configuring the staging
settings. Initialize the staging state, then set the staging cron expression in
`wrangler.jsonc` and deploy staging again. Confirm one scheduled run with the
test calendar, including a bulletin with an image. Restore the staging schedule
to an empty list when the check is complete.

## State initialization and production cutover

Production started with the `bbs28` watermark set to `84558`, the last processed
ID at cutover. The legacy SQLite records and failure counts were left in the
legacy database. The bootstrap snapshot was:

```json
{"version":1,"records":[],"watermarks":[{"feedId":"bbs28","id":84558}],"failures":[]}
```

For staging or recovery with a new Durable Object, deploy the target environment
with its cron list temporarily set to `[]`. Enable `workers_dev` temporarily if
needed and set a unique `STATE_IMPORT_TOKEN` secret. Select the watermark for the
intended environment. An isolated staging calendar can use empty `records`,
`watermarks`, and `failures` arrays. For recovery, use the latest confirmed
watermark and available state.

Write `Authorization: Bearer ...` to a private `data/import.headers` file and
save the snapshot to `data/import.json`. Use the intended Worker's exact URL in
`worker_url`. The endpoint accepts snapshots up to 4 MiB and returns import
counts. Repeating the same normalized snapshot is safe.

```sh
curl --fail-with-body --header @data/import.headers \
  --header 'Content-Type: application/json' --data-binary @data/import.json \
  "$worker_url/__migration/state"
curl --fail-with-body --header @data/import.headers "$worker_url/__migration/state"
```

Compare the returned counts with the snapshot. Remove the import token and
restore the environment's intended `workers_dev` setting. Before enabling a
replacement production schedule, stop the previous scheduler and wait for its
last run to finish. Restore the production cron list to `["*/15 * * * *"]` and
deploy production explicitly with `npm run deploy -- --env ""`.
Confirm the actual trigger and first scheduled run in Cloudflare, check Calendar
and Telegram output, and verify the ICS subscription and status route.

For rollback, disable the new Worker schedule and wait for any current execution.
Reconcile Calendar events and processed state before restarting the legacy cron.
A code rollback leaves Durable Object state and already created calendar events
in place.
