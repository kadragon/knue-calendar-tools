# Architecture

## Execution and state

`src/worker.ts` registers a scheduled handler and acquires an expiring lease from
the job's `HarvestState` Durable Object. Network calls run in the scheduled
Worker. Short Durable Object methods validate the lease and update strongly
consistent key-value state. Import creates the initial state, with a digest and
counts to support safe retries.

| State | Keying | Purpose |
| --- | --- | --- |
| Processed record | Feed and post ID | Skip posts previously processed or matched |
| Watermark | Feed ID | Skip IDs below the last safely completed point |
| Failure count | Feed and post ID | Track repeated item-specific extraction failures |
| Pending plan | Feed and post ID | Resume calendar writes using the original prepared events |

A legacy snapshot includes processed records, watermarks, and failure counts.
The read-only exporter normalizes the old unqualified bulletin keys.
The authenticated import endpoint accepts the first snapshot atomically and treats
the same snapshot as an idempotent retry.

## Event flow

1. Load persisted plans and resume them, even after their posts leave the feed.
2. Parse the RSS and skip completed items. Send relevant KNUE image attachments
   through AI Gateway for extraction when present. A temporary image or OCR failure leaves the post retryable. Request a structured event list
   and summarize the announcement.
3. Check historical similarity, split long events, and save the complete write
   plan before the first Google Calendar insert.
4. Submit stable IDs derived from the feed, post, and persisted event order.
   Reconcile a duplicate-ID response with the exact event and its private source
   metadata. Persist confirmed results after each insert.
5. Atomically record completion and clear pending state. Send Telegram notifications
   after completion. Notification delivery is best effort.
6. Advance the watermark only past handled items. Runtime or item budget
   exhaustion defers work. Retry older pending plans first and reserve part of
   the run for new RSS items.

## Integrations

| Module | Service |
| --- | --- |
| `src/lib/ai.ts` | Authenticated AI Gateway OpenAI Chat Completions using BYOK |
| `src/lib/calendar.ts` | Calendar v3 REST and service account JWT signing with WebCrypto |
| `src/lib/telegram.ts` | Telegram Bot API |
| `src/lib/rss.ts` | KNUE 행사세미나 RSS (board 28) |
