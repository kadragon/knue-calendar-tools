# Harvester Runbook

Run commands from `apps/event-harvester`. Use Node.js 22 or newer and the Wrangler
installed by `npm ci`. The staging environment has a separate Worker and Durable
Object. Both schedules ship disabled so importing state and enabling cron are
separate operations.

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

## Import and production cutover

1. Confirm the currently deployed ICS Worker and its subscription URL. The ICS
   Worker configuration is carried into this repository unchanged.
2. Deploy the harvester with the production schedule empty. For the one-time
   import, temporarily set production `workers_dev` to `true` and set a unique
   `STATE_IMPORT_TOKEN` secret. The endpoint is accessible only with that token.
3. Stop the old cron and wait for the last process to finish. Keep a backup of
   the production SQLite file with any associated WAL files. Export the stopped
   database using a private output directory:

   ```sh
   umask 077
   mkdir -p data
   python3 scripts/export-state.py /path/to/production/state.db > data/import.json
   ```

4. Compare records, watermarks, and failure counts before import. For an empty
   staging calendar, the explicit bootstrap snapshot is
   `{"version":1,"records":[],"watermarks":[],"failures":[]}`.
5. Write `Authorization: Bearer ...` to a private `data/import.headers` file and
   submit the snapshot. Use the intended Worker's exact URL in `worker_url`.
   The endpoint accepts snapshots up to 4 MiB and returns import counts. Repeating
   the same normalized snapshot is safe.

   ```sh
   curl --fail-with-body --header @data/import.headers \
     --header 'Content-Type: application/json' --data-binary @data/import.json \
     "$worker_url/__migration/state"
   curl --fail-with-body --header @data/import.headers "$worker_url/__migration/state"
   ```

6. Compare returned counts with the export. Remove the import token, restore
   production `workers_dev` to `false`, set the production schedule to
   `["*/15 * * * *"]`, and deploy explicitly with `npm run deploy -- --env ""`.
   Confirm the actual trigger and first scheduled run in Cloudflare. Compare
   Calendar and Telegram output and verify the ICS subscription and status route.

For rollback, disable the new Worker schedule and wait for any current execution.
Reconcile Calendar events and processed state before restarting the legacy cron.
A code rollback leaves Durable Object state and already created calendar events
in place.
