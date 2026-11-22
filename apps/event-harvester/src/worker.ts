import { createHash, timingSafeEqual } from "node:crypto";
import { createStateStore, HarvestState } from "./harvest-state.js";
import { run, type Env as HarvestEnv } from "./index.js";

export { HarvestState };

interface Env extends Omit<HarvestEnv, "state"> {
  HARVEST_STATE: DurableObjectNamespace<HarvestState>;
  STATE_IMPORT_TOKEN?: string;
}

const MIGRATION_PATH = "/__migration/state";
const MIGRATION_LIMIT = 4 * 1024 * 1024;

function authorized(request: Request, token: string): boolean {
  const supplied = request.headers.get("Authorization");
  if (!supplied) return false;

  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(`Bearer ${token}`).digest(),
  );
}

async function readSnapshot(request: Request): Promise<unknown> {
  if (!request.body || Number(request.headers.get("Content-Length") ?? 0) > MIGRATION_LIMIT) {
    throw new Error("Snapshot is missing or exceeds 4 MiB");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let json = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MIGRATION_LIMIT) {
        await reader.cancel();
        throw new Error("Snapshot exceeds 4 MiB");
      }
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname !== MIGRATION_PATH || !env.STATE_IMPORT_TOKEN) {
      return new Response(null, { status: 404 });
    }
    if (!authorized(request, env.STATE_IMPORT_TOKEN)) {
      return new Response(null, { status: 401 });
    }

    const state = env.HARVEST_STATE.getByName("harvester");
    if (request.method === "GET") {
      return Response.json({ imported: await state.getImportStatus() }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
    }

    let snapshot: unknown;
    try {
      snapshot = await readSnapshot(request);
    } catch {
      return Response.json({ error: "Expected a JSON snapshot within 4 MiB" }, { status: 400 });
    }
    try {
      return Response.json({ imported: await state.importSnapshot(snapshot) });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : "State import failed",
      }, { status: 409 });
    }
  },

  async scheduled(_controller, env): Promise<void> {
    for (const key of [
      "AI_GATEWAY_URL", "AI_GATEWAY_TOKEN", "OPENAI_MODEL", "GOOGLE_CALENDAR_ID",
      "GOOGLE_SERVICE_ACCOUNT_JSON",
    ] as const) {
      if (!env[key]?.trim()) throw new Error(`Required Worker setting is missing: ${key}`);
    }
    const state = env.HARVEST_STATE.getByName("harvester");
    if (!(await state.getImportStatus())) {
      throw new Error("Harvester state is uninitialized");
    }
    const lease = await state.acquireLease();
    if (!lease) {
      console.log("Harvest skipped: a run already holds the lease");
      return;
    }
    try {
      const stats = await run({ ...env, state: createStateStore(state, lease) });
      console.log("Harvest completed", stats);
    } finally {
      await state.releaseLease(lease);
    }
  },
} satisfies ExportedHandler<Env>;
