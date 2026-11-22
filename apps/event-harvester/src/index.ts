import { AiResponseParseError, extractTextFromImage, generateEventInfos, generateSummary, type AiEnv } from "./lib/ai.js";
import {
  obtainAccessToken,
  listEvents,
  createEvent,
  type CalendarEnv,
  type GoogleCalendarEvent,
} from "./lib/calendar.js";
import { isDuplicate, computeHash } from "./lib/dedupe.js";
import { sendNotification } from "./lib/telegram.js";
import { parseRss } from "./lib/rss.js";
import {
  getProcessedRecord,
  completeItem,
  getPendingPlan,
  listPendingPlans,
  putPendingPlan,
  getMaxProcessedId,
  updateMaxProcessedId,
  getItemFailureCount,
  recordItemFailure,
  clearItemFailureCount,
  LEGACY_FEED_ID,
  type StateEnv,
} from "./lib/state.js";
import { isWithinLastWeek, buildDescription, splitLongEvent } from "./lib/transforms.js";
import type {
  CalendarEventInput,
  FeedSource,
  GoogleCalendarAttachment,
  ProcessedRecord,
  RssItem,
  PreviewContent,
} from "./types.js";
import { buildAttachmentFromFile, getFileType } from "./lib/utils.js";
import { Buffer } from "node:buffer";

export interface Env extends StateEnv, CalendarEnv, AiEnv {
  SIMILARITY_THRESHOLD?: string;
  LOOKBACK_DAYS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_USER_ID?: string;
}

export const FEEDS: readonly FeedSource[] = [
  {
    id: LEGACY_FEED_ID,
    url: "https://www.knue.ac.kr/rssBbsNtt.do?bbsNo=28",
    label: "행사세미나",
  },
];

const MAX_CONSECUTIVE_ITEM_FAILURES = 3;
const MAX_HARVEST_MS = 8 * 60_000;
const MAX_ITEMS_PER_RUN = 20;
const MAX_PENDING_RETRIES_PER_FEED = 5;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const KNUE_USER_AGENT = "knue-event-harvester/1.0";

interface HarvestBudget {
  remaining: number;
  deadline: number;
}

function claimAttempt(budget: HarvestBudget): boolean {
  if (budget.remaining <= 0 || Date.now() >= budget.deadline) return false;
  budget.remaining -= 1;
  return true;
}

function buildCalendarEventUrl(eventId: string, calendarId: string): string {
  const eidRaw = `${eventId} ${calendarId}`;
  const eidEncoded = btoa(eidRaw)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `https://calendar.google.com/calendar/u/0/r/event?eid=${eidEncoded}`;
}

async function fetchRssFeed(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": KNUE_USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`);
  return response.text();
}

function detectImageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  const header = bytes.toString("ascii", 0, 6);
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

async function fetchImageAsBase64(url: string): Promise<PreviewContent | null> {
  if (!URL.canParse(url)) return null;
  const source = new URL(url);
  if (source.protocol !== "https:" || !["www.knue.ac.kr", "knue.ac.kr"].includes(source.hostname)) {
    return null;
  }
  const response = await fetch(source, {
    headers: { "User-Agent": KNUE_USER_AGENT },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`Announcement image temporarily unavailable (${response.status})`);
    }
    return null;
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_IMAGE_BYTES || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_IMAGE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, length);
  const contentType = detectImageType(bytes);
  return contentType ? { sourceType: "image", imageBase64: bytes.toString("base64"), contentType } : null;
}

// Stage 1: Enrich item with OCR + AI outputs.
// I/O: image fetch and AI Gateway calls.
async function enrichItem(
  env: Env,
  item: RssItem,
): Promise<{ eventInputs: CalendarEventInput[] }> {
  let previewText: string | undefined;
  if (item.attachment?.url && getFileType(item.attachment.filename) === "image") {
    const imageContent = await fetchImageAsBase64(item.attachment.url);
    if (imageContent) {
      try {
        previewText = await extractTextFromImage(env, imageContent);
      } catch {
        throw new Error("Announcement image extraction failed; retry the post");
      }
      if (previewText) {
        console.log(`OCR extracted ${previewText.length} chars from image for item ${item.id}`);
      }
    }
  }

  const [summary, rawInputs] = await Promise.all([
    generateSummary(env, {
      title: item.title,
      description: item.descriptionHtml,
      previewText,
      attachmentText: item.attachment?.filename
        ? `첨부파일: ${item.attachment.filename}`
        : undefined,
      link: item.link,
      pubDate: item.pubDate,
    }),
    generateEventInfos(env, item, previewText),
  ]);

  const description = buildDescription(item, summary);
  const eventInputs = rawInputs.map((raw) => {
    const withEndTime = raw.startTime && !raw.endTime ? { ...raw, endTime: raw.startTime } : raw;
    return { ...withEndTime, description };
  });

  return { eventInputs };
}

type PreparedEvent = {
  input: CalendarEventInput;
  hash: string;
  meta: ProcessedRecord;
};

// Stage 2: Validate one event group (original + splits) against existing events.
// No external I/O — only crypto.subtle and in-memory comparison.
async function validateEventGroup(
  eventInput: CalendarEventInput,
  existingEvents: GoogleCalendarEvent[],
  feedId: string,
  itemId: string,
  threshold: number,
): Promise<{ kind: "duplicate"; skipHash: string } | { kind: "novel"; prepared: PreparedEvent[] }> {
  const eventsToCreate = splitLongEvent(eventInput);
  const prepared: PreparedEvent[] = [];

  for (const splitEvent of eventsToCreate) {
    const hash = await computeHash(splitEvent);
    const meta: ProcessedRecord = {
      eventId: "",
      nttNo: itemId,
      processedAt: new Date().toISOString(),
      hash,
      feedId,
    };

    if (await isDuplicate(existingEvents, splitEvent, { threshold, meta })) {
      console.log(`Duplicate detected for ${itemId} event: ${splitEvent.title}`);
      return { kind: "duplicate", skipHash: prepared[0]?.hash ?? hash };
    }

    prepared.push({ input: splitEvent, hash, meta });
  }

  return { kind: "novel", prepared };
}

interface PendingPlan {
  events: PreparedEvent[];
  attachment?: GoogleCalendarAttachment;
  rssUrl: string;
  duplicateHash?: string;
  confirmedEvents?: GoogleCalendarEvent[];
  lastAttemptedAt?: number;
}

async function prepareItemPlan(
  env: Env,
  feedId: string,
  item: RssItem,
  existingEvents: GoogleCalendarEvent[],
  similarityThreshold: number,
): Promise<PendingPlan> {
  const { eventInputs } = await enrichItem(env, item);
  const plan: PendingPlan = {
    events: [],
    attachment: buildAttachmentFromFile(item),
    rssUrl: item.link,
  };
  const seenInputs = new Set<string>();
  for (const eventInput of eventInputs) {
    const result = await validateEventGroup(
      eventInput, existingEvents, feedId, item.id, similarityThreshold,
    );
    if (result.kind === "duplicate") {
      plan.duplicateHash ??= result.skipHash;
      continue;
    }
    for (const event of result.prepared) {
      const key = JSON.stringify(event.input);
      if (seenInputs.has(key)) continue;
      plan.events.push(event);
      seenInputs.add(key);
    }
  }
  return plan;
}

async function stableEventId(feedId: string, itemId: string, index: number): Promise<string> {
  const key = new TextEncoder().encode(JSON.stringify([feedId, itemId, index]));
  const digest = await crypto.subtle.digest("SHA-256", key);
  return Buffer.from(digest).toString("hex");
}

async function executeItemPlan(
  env: Env,
  feedId: string,
  itemId: string,
  plan: PendingPlan,
  accessToken: string,
  existingEvents: GoogleCalendarEvent[],
  deadline: number,
): Promise<GoogleCalendarEvent[]> {
  const createdEvents = plan.confirmedEvents ??= [];
  if (plan.events.length > 0) {
    plan.lastAttemptedAt = Date.now();
    await putPendingPlan(env, feedId, itemId, plan);
  }
  for (let index = createdEvents.length; index < plan.events.length; index++) {
    if (Date.now() >= deadline) throw new Error("Harvest time budget exhausted");
    const event = plan.events[index];
    const eventId = await stableEventId(feedId, itemId, index);
    createdEvents.push(await createEvent(
      env, accessToken, event.input, event.meta,
      { summaryHash: event.hash, feedId },
      plan.attachment ? [plan.attachment] : undefined,
      eventId,
    ));
    await putPendingPlan(env, feedId, itemId, plan);
  }

  if (Date.now() >= deadline) throw new Error("Harvest time budget exhausted");
  const last = createdEvents.at(-1);
  await completeItem(env, feedId, itemId, {
    eventId: last?.id ?? (plan.duplicateHash ? "duplicate-skip" : ""),
    nttNo: itemId,
    processedAt: new Date().toISOString(),
    hash: plan.events.at(-1)?.hash ?? plan.duplicateHash ?? "",
    feedId,
  });

  for (const [index, event] of createdEvents.entries()) {
    if (!existingEvents.some((known) => known.id === event.id)) existingEvents.push(event);
    if (Date.now() >= deadline) continue;
    const eventUrl = event.htmlLink ?? buildCalendarEventUrl(event.id, env.GOOGLE_CALENDAR_ID);
    await sendNotification({
      eventTitle: plan.events[index].input.title,
      rssUrl: plan.rssUrl,
      eventUrl,
    }, env);
  }
  return createdEvents;
}

export async function processNewItem(
  env: Env,
  feedId: string,
  item: RssItem,
  accessToken: string,
  existingEvents: GoogleCalendarEvent[],
  similarityThreshold: number,
  deadline = Date.now() + MAX_HARVEST_MS,
): Promise<GoogleCalendarEvent[]> {
  const plan = await getPendingPlan<PendingPlan>(env, feedId, item.id)
    ?? await prepareItemPlan(env, feedId, item, existingEvents, similarityThreshold);
  return executeItemPlan(env, feedId, item.id, plan, accessToken, existingEvents, deadline);
}

export async function run(
  env: Env,
  feeds: readonly FeedSource[] = FEEDS,
): Promise<{ processed: number; created: number }> {
  const budget = { remaining: MAX_ITEMS_PER_RUN, deadline: Date.now() + MAX_HARVEST_MS };
  const accessToken = await obtainAccessToken(env);
  const lookbackDays = Number.parseInt(env.LOOKBACK_DAYS ?? "60", 10);
  const now = new Date();
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const [existing, similarityThreshold] = await Promise.all([
    listEvents(env, accessToken, {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
    }),
    Promise.resolve(Number.parseFloat(env.SIMILARITY_THRESHOLD ?? "0.85")),
  ]);

  let totalProcessed = 0;
  let totalCreated = 0;

  for (const feed of feeds) {
    try {
      const stats = await runFeed(env, feed, accessToken, existing, similarityThreshold, budget);
      totalProcessed += stats.processed;
      totalCreated += stats.created;
    } catch (error) {
      console.error(`Failed to process feed ${feed.id} (${feed.url})`, error);
    }
  }

  return { processed: totalProcessed, created: totalCreated };
}

async function runFeed(
  env: Env,
  feed: FeedSource,
  accessToken: string,
  existing: GoogleCalendarEvent[],
  similarityThreshold: number,
  budget: HarvestBudget,
): Promise<{ processed: number; created: number }> {
  let processed = 0;
  let created = 0;
  const skippedItems: string[] = [];
  const alreadyProcessedItems: string[] = [];
  let maxAdvancableId = 0;
  let minFailedId = Number.POSITIVE_INFINITY;
  let deferred = false;
  const pending = new Set<string>();

  const plans = await listPendingPlans<PendingPlan>(env, feed.id);
  plans.sort((a, b) => (a.plan.lastAttemptedAt ?? 0) - (b.plan.lastAttemptedAt ?? 0));
  for (const [index, { nttNo, plan }] of plans.entries()) {
    pending.add(nttNo);
    const itemId = Number.parseInt(nttNo, 10);
    if (index >= MAX_PENDING_RETRIES_PER_FEED || !claimAttempt(budget)) {
      if (Number.isFinite(itemId)) minFailedId = Math.min(minFailedId, itemId);
      continue;
    }
    try {
      const result = await executeItemPlan(env, feed.id, nttNo, plan, accessToken, existing, budget.deadline);
      processed += 1;
      created += result.length;
      if (Number.isFinite(itemId)) maxAdvancableId = Math.max(maxAdvancableId, itemId);
    } catch (error) {
      console.error(`Failed to resume item ${nttNo} (feed=${feed.id})`, error);
      if (Number.isFinite(itemId)) minFailedId = Math.min(minFailedId, itemId);
    }
  }

  const rssXml = await fetchRssFeed(feed.url);
  const items = parseRss(rssXml);
  const maxProcessedId = await getMaxProcessedId(env, feed.id);
  for (const item of items) {
    if (pending.has(item.id)) continue;
    const itemId = Number.parseInt(item.id, 10);
    if (!Number.isNaN(itemId) && itemId <= maxProcessedId) {
      // Trace: AC-1 — an early-exit item must not retain a stale failure streak.
      await clearItemFailureCount(env, feed.id, item.id);
      alreadyProcessedItems.push(item.id);
      processed += 1;
      break;
    }

    if (!isWithinLastWeek(item.pubDate)) {
      skippedItems.push(`Item ${item.id} - pubDate ${item.pubDate}`);
      continue;
    }

    // Check the processed record for every item, not just non-numeric ids: once a failure
    // caps the watermark, the numeric items above the cap are re-read each run, and only
    // this lookup keeps them from paying for AI enrichment (and re-writing their record)
    // again. They still count toward maxAdvancableId so the watermark can move once the
    // failure clears.
    const already = await getProcessedRecord(env, feed.id, item.id);
    if (already) {
      // Trace: AC-1 — a successful prior run clears any stale failure streak.
      await clearItemFailureCount(env, feed.id, item.id);
      alreadyProcessedItems.push(item.id);
      processed += 1;
      if (!Number.isNaN(itemId) && itemId > maxAdvancableId) {
        maxAdvancableId = itemId;
      }
      continue;
    }

    const failureCount = await getItemFailureCount(env, feed.id, item.id);
    if (failureCount >= MAX_CONSECUTIVE_ITEM_FAILURES) {
      // Trace: AC-2 — a previously exhausted failure streak is never sent to AI again.
      console.warn(
        `[${feed.id}] Permanently skipped item ${item.id} after ${failureCount} consecutive failures`,
      );
      processed += 1;
      if (!Number.isNaN(itemId) && itemId > maxAdvancableId) {
        maxAdvancableId = itemId;
      }
      continue;
    }

    if (!claimAttempt(budget)) {
      deferred = true;
      break;
    }

    try {
      const results = await processNewItem(
        env, feed.id, item, accessToken, existing, similarityThreshold, budget.deadline,
      );
      processed += 1;
      created += results.length;
      if (!Number.isNaN(itemId) && itemId > maxAdvancableId) {
        maxAdvancableId = itemId;
      }
    } catch (error) {
      // Separate the two abort causes in the logs: a parse failure means the model
      // answered and we could not use it, which points at the prompt or schema rather
      // than at the gateway being down.
      const cause = error instanceof AiResponseParseError ? "unusable AI response" : "error";
      console.error(`Failed to process item ${item.id} (feed=${feed.id}) — ${cause}`, error);
      if (error instanceof AiResponseParseError) {
        const consecutiveFailureCount = await recordItemFailure(env, feed.id, item.id);
        if (consecutiveFailureCount >= MAX_CONSECUTIVE_ITEM_FAILURES) {
          // Trace: AC-2 — the third item-specific parse failure makes the item permanently skippable.
          console.warn(
            `[${feed.id}] Permanently skipped item ${item.id} after ${consecutiveFailureCount} consecutive parse failures`,
          );
          if (!Number.isNaN(itemId) && itemId > maxAdvancableId) {
            maxAdvancableId = itemId;
          }
        } else if (!Number.isNaN(itemId) && itemId < minFailedId) {
          minFailedId = itemId;
        }
      } else if (!Number.isNaN(itemId) && itemId < minFailedId) {
        minFailedId = itemId;
      }
    }
  }

  // Cap the watermark below the lowest failed id: without this, a failure older than a
  // later success is skipped forever, because the watermark jumps past it. Items above the
  // cap get re-read next run — duplicate creation is already blocked by validateEventGroup.
  const watermark = Math.min(maxAdvancableId, minFailedId - 1);
  if (watermark < maxAdvancableId) {
    // Make the stall observable: an item that never succeeds pins the feed here forever.
    console.warn(
      `[${feed.id}] Watermark held at ${watermark} instead of ${maxAdvancableId} by failed item ${minFailedId} — it will be retried next run`,
    );
  }
  if (!deferred && watermark > 0) {
    await updateMaxProcessedId(env, feed.id, watermark.toString());
  }

  if (skippedItems.length > 0) {
    console.log(
      `[${feed.id}] Skipped ${skippedItems.length} items (older than 1 week):\n${skippedItems.join("\n")}`,
    );
  }

  if (alreadyProcessedItems.length > 0) {
    console.log(
      `[${feed.id}] Already processed ${alreadyProcessedItems.length} items (max_id: ${maxProcessedId})`,
    );
  }

  return { processed, created };
}
