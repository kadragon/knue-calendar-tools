import { DurableObject } from "cloudflare:workers";
import type { PendingPlanEntry, StateStore } from "./lib/state.js";
import type { ProcessedRecord } from "./types.js";

const IMPORT_KEY = "import";
const LEASE_KEY = "lease";
// A scheduled invocation can run for up to 15 minutes.
const LEASE_DURATION_MS = 16 * 60_000;

export interface ImportCounts {
  records: number;
  watermarks: number;
  failures: number;
}

interface StoredImport {
  hash: string;
  counts: ImportCounts;
}

interface Lease {
  token: string;
  expiresAt: number;
}

function feedPrefix(namespace: string, feedId: string) {
  return `${namespace}:${encodeURIComponent(feedId)}:`;
}

function itemKey(namespace: string, feedId: string, nttNo: string) {
  return feedPrefix(namespace, feedId) + encodeURIComponent(nttNo);
}

function watermarkKey(feedId: string) {
  return feedPrefix("watermark", feedId);
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid state snapshot");
  }
  return value as Record<string, unknown>;
}

function textField(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value)) {
    throw new Error("Invalid state snapshot field");
  }
  return value;
}

function numberField(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid state snapshot number");
  }
  return value;
}

function normalizeSnapshot(snapshot: unknown) {
  const data = asObject(snapshot);
  const { records, watermarks, failures } = data;
  if (data.version !== 1 || !Array.isArray(records) || !Array.isArray(watermarks) || !Array.isArray(failures)) {
    throw new Error("Invalid state snapshot shape");
  }

  const entries = new Map<string, ProcessedRecord | number>();
  function add(key: string, value: ProcessedRecord | number) {
    if (entries.has(key)) {
      throw new Error("Duplicate state snapshot key");
    }
    entries.set(key, value);
  }

  for (const row of records) {
    const value = asObject(row);
    const feedId = textField(value.feedId);
    const nttNo = textField(value.nttNo);
    add(itemKey("record", feedId, nttNo), {
      feedId,
      nttNo,
      eventId: textField(value.eventId, true),
      processedAt: textField(value.processedAt),
      hash: textField(value.hash, true),
    });
  }
  for (const row of watermarks) {
    const value = asObject(row);
    add(watermarkKey(textField(value.feedId)), numberField(value.id));
  }
  for (const row of failures) {
    const value = asObject(row);
    const key = itemKey("failure", textField(value.feedId), textField(value.nttNo));
    add(key, numberField(value.count));
  }

  return {
    counts: { records: records.length, watermarks: watermarks.length, failures: failures.length },
    entries: [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  };
}

export class HarvestState extends DurableObject {
  async importSnapshot(snapshot: unknown): Promise<ImportCounts> {
    const { entries, counts } = normalizeSnapshot(snapshot);
    const bytes = new TextEncoder().encode(JSON.stringify(entries));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    return this.ctx.storage.transactionSync(() => {
      const stored = this.kv.get<StoredImport>(IMPORT_KEY);
      if (stored) {
        if (stored.hash !== hash) {
          throw new Error("A different state snapshot is already initialized");
        }
        return stored.counts;
      }
      for (const [key, value] of entries) {
        this.kv.put(key, value);
      }
      this.kv.put(IMPORT_KEY, { hash, counts } satisfies StoredImport);
      return counts;
    });
  }

  getImportStatus(): ImportCounts | null {
    return this.kv.get<StoredImport>(IMPORT_KEY)?.counts ?? null;
  }

  acquireLease(): string | null {
    if (!this.getImportStatus()) return null;

    const now = Date.now();
    const lease = this.kv.get<Lease>(LEASE_KEY);
    if (lease && lease.expiresAt > now) return null;

    const token = crypto.randomUUID();
    this.kv.put(LEASE_KEY, { token, expiresAt: now + LEASE_DURATION_MS } satisfies Lease);
    return token;
  }

  releaseLease(token: string): void {
    if (this.kv.get<Lease>(LEASE_KEY)?.token === token) {
      this.kv.delete(LEASE_KEY);
    }
  }

  getProcessedRecord(token: string, feedId: string, nttNo: string): ProcessedRecord | null {
    this.requireLease(token);
    return this.kv.get<ProcessedRecord>(itemKey("record", feedId, nttNo)) ?? null;
  }

  getMaxProcessedId(token: string, feedId: string): number {
    this.requireLease(token);
    return this.kv.get<number>(watermarkKey(feedId)) ?? 0;
  }

  updateMaxProcessedId(token: string, feedId: string, id: number): void {
    if (id > this.getMaxProcessedId(token, feedId)) {
      this.kv.put(watermarkKey(feedId), id);
    }
  }

  getItemFailureCount(token: string, feedId: string, nttNo: string): number {
    this.requireLease(token);
    return this.kv.get<number>(itemKey("failure", feedId, nttNo)) ?? 0;
  }

  recordItemFailure(token: string, feedId: string, nttNo: string): number {
    const count = this.getItemFailureCount(token, feedId, nttNo) + 1;
    this.kv.put(itemKey("failure", feedId, nttNo), count);
    return count;
  }

  clearItemFailureCount(token: string, feedId: string, nttNo: string): void {
    this.requireLease(token);
    this.kv.delete(itemKey("failure", feedId, nttNo));
  }

  getPendingPlan(token: string, feedId: string, nttNo: string): unknown {
    this.requireLease(token);
    return this.kv.get(itemKey("pending", feedId, nttNo)) ?? null;
  }

  listPendingPlans(token: string, feedId: string): PendingPlanEntry[] {
    this.requireLease(token);
    const prefix = feedPrefix("pending", feedId);
    return [...this.kv.list({ prefix })].map(([key, plan]) => ({
      nttNo: decodeURIComponent(key.slice(prefix.length)),
      plan,
    }));
  }

  putPendingPlan(token: string, feedId: string, nttNo: string, plan: unknown): void {
    this.requireLease(token);
    this.kv.put(itemKey("pending", feedId, nttNo), plan);
  }

  completeItem(token: string, feedId: string, nttNo: string, record: ProcessedRecord): void {
    this.requireLease(token);
    this.ctx.storage.transactionSync(() => {
      this.kv.put(itemKey("record", feedId, nttNo), record);
      this.kv.delete(itemKey("pending", feedId, nttNo));
      this.kv.delete(itemKey("failure", feedId, nttNo));
    });
  }

  private get kv() {
    return this.ctx.storage.kv;
  }

  private requireLease(token: string): void {
    const lease = this.kv.get<Lease>(LEASE_KEY);
    if (!lease || lease.token !== token || lease.expiresAt <= Date.now()) {
      throw new Error("Harvester lease is no longer valid");
    }
  }
}

export function createStateStore(stub: DurableObjectStub<HarvestState>, token: string): StateStore {
  return {
    getProcessedRecord: (feedId, nttNo) => stub.getProcessedRecord(token, feedId, nttNo),
    getMaxProcessedId: (feedId) => stub.getMaxProcessedId(token, feedId),
    updateMaxProcessedId: (feedId, id) => stub.updateMaxProcessedId(token, feedId, id),
    getItemFailureCount: (feedId, nttNo) => stub.getItemFailureCount(token, feedId, nttNo),
    recordItemFailure: (feedId, nttNo) => stub.recordItemFailure(token, feedId, nttNo),
    clearItemFailureCount: (feedId, nttNo) => stub.clearItemFailureCount(token, feedId, nttNo),
    getPendingPlan: (feedId, nttNo) => stub.getPendingPlan(token, feedId, nttNo),
    listPendingPlans: (feedId) => stub.listPendingPlans(token, feedId),
    putPendingPlan: (feedId, nttNo, plan) => stub.putPendingPlan(token, feedId, nttNo, plan),
    completeItem: (feedId, nttNo, record) => stub.completeItem(token, feedId, nttNo, record),
  };
}
