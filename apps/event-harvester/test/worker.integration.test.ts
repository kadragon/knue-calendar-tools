import { generateKeyPairSync } from "node:crypto";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";

const gateway = "https://gateway.ai.cloudflare.com/v1/test/knue/openai/chat/completions";
const importUrl = "https://app.test/__migration/state";
const cron = "*/15 * * * *";

describe("harvester Worker", () => {
  it("imports progress, then resumes an interrupted plan through the scheduled handler", async () => {
    const [{ text: script }] = (await build({
      entryPoints: ["src/worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      external: ["cloudflare:workers", "node:*"],
    })).outputFiles;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const today = new Date().toISOString().slice(0, 10);
    const remote = new Map<string, Record<string, unknown>>();
    const requests: string[] = [];
    let currentInFeed = true;
    let inserts = 0;
    let alerts = 0;
    let visionUnavailable = true;
    let oauthRequests = 0;
    const firstFeed = Promise.withResolvers<void>();
    const releaseFeed = Promise.withResolvers<void>();
    let pauseFeed = true;

    const entry = (id: number) => `<item>
      <title>행사 ${id}</title>
      <link>https://www.knue.ac.kr/notice?nttNo=${id}</link>
      <pubDate>${today}</pubDate>
      <description>일정은 포스터를 참고하세요.</description>
      <filename1>poster.png</filename1>
      <url1>https://www.knue.ac.kr/poster.png</url1>
    </item>`;

    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-11-22",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { HARVEST_STATE: { className: "HarvestState", useSQLite: true } },
      bindings: {
        AI_GATEWAY_URL: gateway,
        AI_GATEWAY_TOKEN: "test-gateway-token",
        OPENAI_MODEL: "test-image-model",
        GOOGLE_CALENDAR_ID: "test-calendar",
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: "test@example.test",
          private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
        }),
        TELEGRAM_BOT_TOKEN: "test-bot",
        TELEGRAM_USER_ID: "test-chat",
        STATE_IMPORT_TOKEN: "test-import",
      },
      async outboundService(request) {
        const url = new URL(request.url);
        if (url.hostname === "oauth2.googleapis.com") {
          oauthRequests += 1;
          return Response.json({ access_token: "test-calendar-token", expires_in: 3600 });
        }
        if (url.pathname === "/rssBbsNtt.do") {
          if (pauseFeed) {
            pauseFeed = false;
            firstFeed.resolve();
            await releaseFeed.promise;
          }
          return new Response(
            `<rss><channel>${currentInFeed ? entry(103) : ""}${entry(102)}</channel></rss>`,
          );
        }
        if (url.href === "https://www.knue.ac.kr/poster.png") {
          if (request.headers.get("User-Agent") !== "knue-event-harvester/1.0") {
            return new Response(null, { status: 500 });
          }
          return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
            headers: { "Content-Type": "application/x-msdownload" },
          });
        }
        if (url.href === gateway) {
          expect(request.headers.get("cf-aig-authorization")).toBe("Bearer test-gateway-token");
          const payload = await request.json() as {
            messages: unknown[];
            response_format: { json_schema: { name: string } };
          };
          const name = payload.response_format.json_schema.name;
          requests.push(name);
          let content: unknown;
          if (name === "announcement_image_text") {
            expect(JSON.stringify(payload.messages)).toContain("data:image/png;base64,");
            if (visionUnavailable) return new Response(null, { status: 503 });
            content = { extractedText: "오전과 오후 행사 일정" };
          } else if (name === "announcement_summary") {
            content = { summary: "행사 안내", highlights: [], actionItems: [], links: [] };
          } else {
            expect(name).toBe("announcement_events");
            if (visionUnavailable) return Response.json({
              choices: [{ finish_reason: "stop", message: { content: '{"events":[]}' } }],
            });
            expect(JSON.stringify(payload.messages)).toContain("오전과 오후 행사 일정");
            content = {
              events: ["오전 행사", "오후 행사"].map((title) => ({
                title, description: "행사 일정", startDate: today, endDate: today,
                startTime: null, endTime: null,
              })),
            };
          }
          return Response.json({
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
          });
        }
        if (url.hostname === "www.googleapis.com") {
          if (request.method === "POST") {
            const event = await request.json() as Record<string, unknown> & { id: string };
            if (++inserts === 2) return new Response("retry", { status: 503 });
            if (remote.has(event.id)) return new Response(null, { status: 409 });
            remote.set(event.id, event);
            return Response.json(event);
          }
          const eventId = url.pathname.split("/").at(-1)!;
          if (eventId === "events") return Response.json({ items: [...remote.values()] });
          return Response.json(remote.get(eventId));
        }
        if (url.hostname === "api.telegram.org") {
          alerts += 1;
          return Response.json({ ok: true });
        }
        throw new Error(`Unexpected outbound host: ${url.hostname}`);
      },
    }));

    try {
      expect((await mf.dispatchFetch(importUrl)).status).toBe(401);
      const auth = { Authorization: "Bearer test-import" };
      const snapshot = {
        version: 1,
        records: [{ feedId: "bbs28", nttNo: "102", eventId: "existing", processedAt: today, hash: "" }],
        watermarks: [{ feedId: "bbs28", id: 99 }],
        failures: [],
      };
      const expectedImport = { imported: { records: 1, watermarks: 1, failures: 0 } };
      const importState = () => mf.dispatchFetch(importUrl, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(snapshot),
      });
      expect(await (await importState()).json()).toEqual(expectedImport);
      expect(await (await importState()).json()).toEqual(expectedImport);

      const worker = await mf.getWorker();
      const firstRun = worker.scheduled({ cron });
      await firstFeed.promise;
      try {
        await worker.scheduled({ cron });
        expect(oauthRequests).toBe(1);
      } finally {
        releaseFeed.resolve();
        await firstRun;
      }
      expect(remote.size).toBe(0);
      expect(alerts).toBe(0);
      expect(requests).toEqual(["announcement_image_text"]);

      visionUnavailable = false;
      requests.length = 0;
      await worker.scheduled({ cron });
      expect(remote.size).toBe(1);
      expect(alerts).toBe(0);
      expect(requests.toSorted()).toEqual([
        "announcement_events", "announcement_image_text", "announcement_summary",
      ]);

      currentInFeed = false;
      await worker.scheduled({ cron });
      expect(remote.size).toBe(2);
      expect(alerts).toBe(2);
      expect(requests).toHaveLength(3);

      await worker.scheduled({ cron });
      expect(remote.size).toBe(2);
      expect(alerts).toBe(2);
      expect(inserts).toBe(3);
    } finally {
      await mf.dispose();
    }
  });
});
