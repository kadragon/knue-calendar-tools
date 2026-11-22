# KNUE Calendar Tools on Cloudflare

## Problem Statement

Before the migration, the official academic-calendar feed ran as a Cloudflare Worker.
The bulletin harvester used a server with Node.js, cron, Ollama, and SQLite. Maintaining them together should
preserve existing calendar subscriptions, prevent duplicate events, and remove the
harvester's dependency on the server.

## Solution

Maintain both TypeScript apps in `knue-calendar-tools`,
with independent Worker configuration and deployment. Run the harvester on a
Cloudflare Cron Trigger, call OpenAI Chat Completions through Cloudflare AI Gateway,
and keep harvest state in Durable Object key-value storage.

## User Stories

- As a subscriber, I want my existing ICS URL to keep serving the academic calendar.
- As a calendar editor, I want bulletin events to keep arriving in the existing Google
  Calendar without double entries during the migration or retries.
- As an operator, I want to deploy and diagnose either Worker independently from one
  repository and run the harvester without the Ollama server.

## Implementation Decisions

- Keep the current ICS Worker name, routes, schedule, and KV binding. Give the harvester
  its own Worker, cron schedule, Durable Object binding, and secrets. Keep each app's
  lockfile and validation commands during the repository move.
- Port the current harvester, including RSS parsing, calendar matching, date handling,
  and its per-item failure logic. The version before PR #62 is a reference for the
  previous Cloudflare and OpenAI integration.
- Call the authenticated AI Gateway OpenAI provider endpoint at
  `/openai/chat/completions` with a configurable image-capable model. Store the OpenAI
  API key in AI Gateway BYOK and the gateway token, Google service account credentials,
  and Telegram token as Worker secrets. Validate structured extraction output before
  writing events and include relevant public images when the text omits necessary
  details.
- Use one Durable Object per harvester job. Its strongly consistent key-value API
  stores one record per processed post, one watermark per feed, and the item failure
  counters. Cloudflare manages the storage backend. Keep the repeatable snapshot
  importer and legacy-key support available for staging and recovery. Production
  started at the `bbs28` watermark `84558` with empty record and failure lists.
- Replace the filesystem lock with an atomic, expiring lease in the Durable Object.
  Acquire and update the lease in short storage operations and run network I/O in the
  scheduled Worker. Use stable Google Calendar event identifiers for new inserts and
  reconcile conflicts before advancing the watermark. Preserve the existing similarity
  check for historical events.
- Bound work and API timeouts per invocation. Defer unfinished items to a later run
  without advancing the source watermark past them.
- First validate the harvester in a staging Worker with isolated state and output.
  At cutover, production was initialized from the last processed bulletin ID, and
  the Cloudflare schedule was enabled at 15-minute intervals. If rollback is needed,
  disable the Worker trigger and reconcile state and events before starting the old
  cron again.

## Alternatives rejected

- A single Worker would couple ICS availability and rollbacks to harvester releases.
- Keeping the harvester on Node.js would retain its server and cron dependencies.
- A Cloudflare Container would retain a separate container runtime and image lifecycle
  for logic that can run directly in a Worker.
- Workers KV can serve stale reads across locations, and the harvester's writes to
  Google Calendar require coordinated ownership during overlapping runs.
- D1 would add a separate schema and database binding for state accessed by key.
- Starting with empty state would expose historical RSS items to reprocessing.
- Reverting PR #62 would lose fixes made after the original migration.

## Testing Decisions

- Run each app's existing tests, type checks, and build checks from its new location.
- Exercise the scheduled entry point against local Durable Object storage with
  recorded RSS fixtures and stubbed AI Gateway, Google Calendar, and Telegram endpoints.
- Verify state import with record counts, feed watermarks, and representative keys.
  Test overlap, timeout before completion, retry after a partial write, and repeated
  processing of a post already present in the imported database.
- Run a controlled staging check with a public announcement and an image attachment.
  Verify AI Gateway authentication, structured output, the chosen OpenAI model,
  destination test calendar, and API budget there.
- Verify the existing ICS subscription URL and status endpoint after cutover. Confirm
  a real scheduled harvest and inspect its state and output in Cloudflare.

## Out of Scope

- Redesigning the calendar feeds, formats, recipients, or user-facing interfaces.
- Retiring the existing repositories and production cron before cutover verification.

## Further Notes

- The harvester previously ran on Cloudflare and used OpenAI.
  [Migration away from Cloudflare and OpenAI](https://github.com/kadragon/knue-event-harvester/pull/62)
- See the [harvester runbook](../../apps/event-harvester/docs/runbook.md) for
  state initialization and schedule checks.
- References for the new interfaces.
  [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
  [AI Gateway OpenAI provider](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)
  [Durable Object key-value storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#synchronous-kv-api)
  [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
  [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
  [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
  [Image inputs](https://developers.openai.com/api/docs/guides/images-vision)
