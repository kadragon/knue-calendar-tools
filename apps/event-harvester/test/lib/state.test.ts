import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarvestState } from "../../src/harvest-state.js";

let runtime: Miniflare;

const record = {
  feedId: "bbs28",
  nttNo: "123",
  eventId: "calendar-event-id",
  processedAt: "2026-01-01T00:00:00Z",
  hash: "summary-hash",
};
const empty = { version: 1, records: [], watermarks: [], failures: [] };

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        export { HarvestState } from "./src/harvest-state.ts";
        export default {
          async fetch(request, env) {
            const { name, method, args } = await request.json();
            const stub = env.HARVEST_STATE.getByName(name);
            try {
              return Response.json({ value: await stub[method](...args) });
            } catch (error) {
              return Response.json({ error: error.message }, { status: 400 });
            }
          },
        };
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    external: ["cloudflare:workers"],
  });
  runtime = new Miniflare(convertV4MiniflareOptions({
    name: "state-worker",
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-11-21",
    durableObjects: { HARVEST_STATE: { className: "HarvestState", useSQLite: true } },
  }));
  await runtime.ready;
});

afterAll(async () => {
  await runtime?.dispose();
});

type StateRpc = {
  [K in keyof HarvestState as HarvestState[K] extends (...args: never[]) => unknown ? K : never]:
    HarvestState[K] extends (...args: infer Args) => infer Return
      ? (...args: Args) => Promise<Awaited<Return>>
      : never;
};

function getState(name: string): StateRpc {
  // Use the Worker RPC path so workerd serializes both results and remote errors.
  return new Proxy({} as StateRpc, {
    get(_, method) {
      return async (...args: unknown[]) => {
        const response = await runtime.dispatchFetch("http://local/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, method, args }),
        });
        const result = await response.json() as { value?: unknown; error?: string };
        if (!response.ok) throw new Error(result.error);
        return result.value;
      };
    },
  });
}

describe("harvester state on workerd", () => {
  it("requires initialization and rejects malformed imports without changing state", async () => {
    const state = getState("bootstrap");
    expect(await state.getImportStatus()).toBeNull();
    expect(await state.acquireLease()).toBeNull();
    await expect(state.importSnapshot({ ...empty, watermarks: [{ feedId: "bbs28", id: -1 }] }))
      .rejects.toThrow("Invalid state snapshot number");
    await expect(state.importSnapshot({ ...empty, records: [record, record] }))
      .rejects.toThrow("Duplicate state snapshot key");
    expect(await state.getImportStatus()).toBeNull();
    expect(await state.importSnapshot(empty)).toEqual({ records: 0, watermarks: 0, failures: 0 });
    expect(await state.acquireLease()).toBeTypeOf("string");
  });

  it("reconciles an equivalent repeat import and preserves live changes", async () => {
    const state = getState("reimport");
    const secondRecord = { ...record, feedId: "bbs50", eventId: "", hash: "" };
    const snapshot = {
      version: 1,
      records: [record, secondRecord],
      watermarks: [{ feedId: "bbs28", id: 100 }],
      failures: [{ feedId: "bbs28", nttNo: "124", count: 2 }],
    };
    const counts = { records: 2, watermarks: 1, failures: 1 };
    expect(await state.importSnapshot(snapshot)).toEqual(counts);
    expect(await state.getImportStatus()).toEqual(counts);
    const token = await state.acquireLease() as string;
    expect(await state.getProcessedRecord(token, "bbs28", "123")).toEqual(record);
    expect(await state.getProcessedRecord(token, "bbs50", "123")).toEqual(secondRecord);
    expect(await state.getProcessedRecord(token, "other", "123")).toBeNull();
    expect(await state.getMaxProcessedId(token, "bbs28")).toBe(100);
    expect(await state.getItemFailureCount(token, "bbs28", "124")).toBe(2);

    await state.updateMaxProcessedId(token, "bbs28", 200);
    await state.updateMaxProcessedId(token, "bbs28", 150);
    await state.updateMaxProcessedId(token, "bbs50", 20);
    expect(await state.recordItemFailure(token, "bbs28", "124")).toBe(3);
    expect(await state.getItemFailureCount(token, "bbs50", "124")).toBe(0);
    await state.clearItemFailureCount(token, "bbs28", "124");

    expect(await state.importSnapshot({ ...snapshot, records: [secondRecord, record] })).toEqual(counts);
    await expect(state.importSnapshot(empty)).rejects.toThrow("different state snapshot");
    expect(await state.getMaxProcessedId(token, "bbs28")).toBe(200);
    expect(await state.getMaxProcessedId(token, "bbs50")).toBe(20);
    expect(await state.getItemFailureCount(token, "bbs28", "124")).toBe(0);
  });

  it("serializes overlapping leases and fences a stale owner", async () => {
    const state = getState("overlap");
    await state.importSnapshot(empty);
    const leases = await Promise.all([state.acquireLease(), state.acquireLease()]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const first = leases.find(Boolean) as string;
    await state.releaseLease(first);
    const second = await state.acquireLease() as string;
    expect(second).not.toBe(first);
    await state.releaseLease(first);
    expect(await state.acquireLease()).toBeNull();
    await expect(state.completeItem(first, "bbs28", "123", record)).rejects.toThrow("lease");
    await state.completeItem(second, "bbs28", "123", record);
    expect(await state.getProcessedRecord(second, "bbs28", "123")).toEqual(record);
  });

  it("recovers a persisted plan and finalizes record, failure count, and plan together", async () => {
    const state = getState("pending");
    await state.importSnapshot(empty);
    const first = await state.acquireLease() as string;
    const plan = { eventIds: ["a", "b"] };
    await state.putPendingPlan(first, "bbs28", "post:with:colon", plan);
    await state.recordItemFailure(first, "bbs28", "post:with:colon");
    await runtime.unsafeEvictDurableObject("state-worker", "HarvestState", { name: "pending" });
    expect(await state.acquireLease()).toBeNull();
    await state.releaseLease(first);

    const second = await state.acquireLease() as string;
    expect(await state.getPendingPlan(second, "bbs28", "post:with:colon")).toEqual(plan);
    expect(await state.listPendingPlans(second, "bbs28")).toEqual([{ nttNo: "post:with:colon", plan }]);
    expect(await state.listPendingPlans(second, "bbs50")).toEqual([]);
    const finished = { ...record, nttNo: "post:with:colon" };
    await state.completeItem(second, "bbs28", "post:with:colon", finished);
    expect(await state.getProcessedRecord(second, "bbs28", "post:with:colon")).toEqual(finished);
    expect(await state.getPendingPlan(second, "bbs28", "post:with:colon")).toBeNull();
    expect(await state.getItemFailureCount(second, "bbs28", "post:with:colon")).toBe(0);
  });
});
