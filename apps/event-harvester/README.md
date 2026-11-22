# KNUE Event Harvester

A scheduled Cloudflare Worker that reads the KNUE 행사세미나 RSS feed, extracts
event details through AI Gateway, and registers events in Google Calendar. It
can send Telegram notifications for completed posts.

Each run uses Durable Object state to coordinate execution, recover interrupted
event writes, and remember which posts were processed. See the
[runbook](docs/runbook.md) for environment settings, staging, and the initial
import from the legacy SQLite database.

## Development

Use Node.js 22 or newer and Python 3 for the snapshot utility.

```sh
npm ci
npm run typecheck
npm run test:coverage
python3 -B scripts/test_export_state.py
npm run build
```

The integration tests run the scheduled handler and Durable Object in local
workerd with stubbed upstream services. The Wrangler build is a deployment dry
run. [Architecture](docs/architecture.md).
