import type { AiSummary, PreviewContent, CalendarEventInput, RssItem } from "../types.js";
import { htmlToText } from "./html.js";

export interface AiEnv {
  AI_GATEWAY_URL: string;
  AI_GATEWAY_TOKEN: string;
  OPENAI_MODEL: string;
}

interface GatewayCompletion {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
  }>;
}

type ImagePart = { type: "image_url"; image_url: { url: string } };
type TextPart = { type: "text"; text: string };
type ChatMessage = { role: "system" | "user"; content: string | Array<TextPart | ImagePart> };

const AI_TIMEOUT_MS = 30_000;
const SUPPORTED_IMAGES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const JSON_FALLBACK: AiSummary = {
  summary: "요약 정보를 생성하지 못했습니다.",
  highlights: [],
  actionItems: [],
  links: [],
};


async function callGatewayChat(
  env: AiEnv,
  params: { name: string; messages: ChatMessage[]; schema: Record<string, unknown> },
): Promise<string | undefined> {
  const endpoint = new URL(env.AI_GATEWAY_URL);
  if (endpoint.origin !== "https://gateway.ai.cloudflare.com" || endpoint.username || endpoint.password ||
      !/^\/v1\/[^/]+\/[^/]+\/openai\/chat\/completions$/.test(endpoint.pathname)) {
    throw new Error("Invalid AI Gateway OpenAI Chat Completions URL");
  }
  const response = await fetch(endpoint.href, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      messages: params.messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: params.name, strict: true, schema: params.schema },
      },
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`AI Gateway request failed (${response.status})`);
  }

  const data = await response.json() as GatewayCompletion | null;
  const choice = data?.choices?.[0];
  if (!choice?.message) throw new Error("AI Gateway returned a missing completion choice");
  if (choice.message.refusal) throw new AiResponseParseError("OpenAI refused the extraction");
  if (choice.finish_reason !== "stop") {
    throw new Error("AI Gateway returned an incomplete completion");
  }
  return choice.message.content ?? undefined;
}

async function parseJson(content: string | undefined): Promise<AiSummary> {
  if (!content) return JSON_FALLBACK;
  try {
    const data = JSON.parse(content);
    return {
      summary: data.summary ?? JSON_FALLBACK.summary,
      highlights: Array.isArray(data.highlights) ? data.highlights : [],
      actionItems: Array.isArray(data.actionItems) ? data.actionItems : [],
      links: Array.isArray(data.links) ? data.links : [],
      extractedText: typeof data.extractedText === "string" ? data.extractedText : undefined,
    } satisfies AiSummary;
  } catch (error) {
    console.error("Failed to parse AI JSON", error, content);
    return JSON_FALLBACK;
  }
}

export async function extractTextFromImage(
  env: AiEnv,
  preview: PreviewContent,
): Promise<string | undefined> {
  if (preview.sourceType !== "image" || !preview.imageBase64) return undefined;
  const imageType = preview.contentType?.split(";")[0].trim().toLowerCase() ?? "image/jpeg";
  if (!SUPPORTED_IMAGES.has(imageType)) return undefined;

  const schema = {
    type: "object",
    properties: {
      extractedText: { type: "string" },
    },
    required: ["extractedText"],
    additionalProperties: false,
  };

  const content = await callGatewayChat(env, {
    name: "announcement_image_text",
    messages: [
      {
        role: "system",
        content: "이미지에서 읽을 수 있는 모든 한국어 텍스트를 추출하는 OCR 어시스턴트입니다.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "이미지에서 보이는 텍스트를 원문 그대로 추출해서 JSON 으로 반환해 주세요." },
          { type: "image_url", image_url: { url: `data:${imageType};base64,${preview.imageBase64}` } },
        ],
      },
    ],
    schema,
  });

  const parsed = content ? JSON.parse(content) : null;
  if (typeof parsed?.extractedText !== "string") {
    throw new Error("AI Gateway returned no image extraction");
  }
  return parsed.extractedText;
}

export async function generateSummary(
  env: AiEnv,
  params: {
    title: string;
    description: string;
    previewText?: string;
    attachmentText?: string;
    link: string;
    pubDate: string;
  },
): Promise<AiSummary> {
  const { title, description, previewText, attachmentText, link, pubDate } = params;
  const prompt = [
    "다음 공지사항을 캘린더 설명용으로 간결하게 요약해 주세요. 본문을 옮기지 말고, 훑어볼 수 있는 수준으로 축약하세요.",
    "",
    `제목: ${title}`,
    `게시일: ${pubDate}`,
    `본문:\n${description}`,
    "",
    `첨부/미리보기:\n${previewText ?? "(없음)"}`,
    "",
    `첨부 메타:\n${attachmentText ?? "(없음)"}`,
    "",
    `원문 링크: ${link}`,
  ].join("\n");

  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      highlights: { type: "array", items: { type: "string" } },
      actionItems: { type: "array", items: { type: "string" } },
      links: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "highlights", "actionItems", "links"],
    additionalProperties: false,
  };

  try {
    const content = await callGatewayChat(env, {
      name: "announcement_summary",
      messages: [
        {
          role: "system",
          content:
            `한국교원대학교 공지사항을 구글 캘린더 설명용으로 요약하는 어시스턴트입니다.

규칙:
- summary: 1~2문장. 핵심만 (누가, 무엇을, 왜). 본문을 그대로 옮기지 말 것.
- highlights: 최대 4개. 캘린더에서 빠르게 확인할 정보만 (대상, 장소, 신청방법 등).
  - 캘린더 이벤트 자체의 시작/종료 날짜와 중복되는 정보는 제외.
  - 각 항목은 "라벨: 값" 형식, 간결하게.
- actionItems: 최대 2개. 사용자가 반드시 해야 할 행동만 (신청, 제출 등). 단순 안내는 제외.
  - 동사로 시작, 한 줄로.
- links: 본문 내 외부 URL만. 원문 링크(${link})와 동일한 URL만 제외.
- 한국어로만 작성하세요.`,
        },
        { role: "user", content: prompt },
      ],
      schema,
    });
    return parseJson(content);
  } catch (error) {
    console.error("generateSummary failed", error);
    return JSON_FALLBACK;
  }
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isOptionalCalendarTime(value: unknown): value is string | null | undefined {
  return value == null || (typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value));
}

function buildEventInput(event: unknown, pubDate: string): CalendarEventInput {
  if (typeof event !== "object" || event === null) {
    throw new AiResponseParseError("OpenAI returned an invalid event");
  }
  const fields = event as Record<string, unknown>;
  const { title, description, startTime, endTime } = fields;
  const startDate = fields.startDate ?? pubDate;
  const endDate = fields.endDate ?? startDate;
  if (typeof title !== "string" || !title.trim() || typeof description !== "string" || !description.trim() ||
      !isCalendarDate(startDate) || !isCalendarDate(endDate) || endDate < startDate ||
      !isOptionalCalendarTime(startTime) || !isOptionalCalendarTime(endTime) ||
      (endDate === startDate && startTime && endTime && endTime < startTime)) {
    throw new AiResponseParseError("OpenAI returned an unusable event");
  }
  return { title, description, startDate, endDate, startTime: startTime ?? undefined, endTime: endTime ?? undefined };
}

/**
 * Thrown when the AI responded but its payload could not be read as an event list.
 *
 * Distinct from a transport error: both abort the item, but this one says the model
 * answered and we could not use the answer. Neither may be confused with the model
 * legitimately reporting no events — that is an empty array, not a throw.
 */
export class AiResponseParseError extends Error {
  /** Raw model payload, kept off the message so logs stay bounded. */
  readonly payload?: string;

  constructor(message: string, options?: { cause?: unknown; payload?: string }) {
    super(message, { cause: options?.cause });
    this.name = "AiResponseParseError";
    this.payload = options?.payload;
  }
}

const PAYLOAD_SNIPPET_LENGTH = 200;

function snippet(content: string): string {
  return content.length > PAYLOAD_SNIPPET_LENGTH
    ? `${content.slice(0, PAYLOAD_SNIPPET_LENGTH)}…`
    : content;
}

async function parseEventJsonArray(content: string | undefined, pubDate: string): Promise<CalendarEventInput[]> {
  if (!content) {
    throw new AiResponseParseError("OpenAI returned no event content");
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new AiResponseParseError(`Failed to parse event JSON: ${snippet(content)}`, {
      cause: error,
      payload: content,
    });
  }
  const events = (data as { events?: unknown })?.events;
  if (!Array.isArray(events)) {
    throw new AiResponseParseError(
      `Unexpected response format: missing events array: ${snippet(content)}`,
      { payload: content },
    );
  }
  // An empty array is the model's genuine "no events" answer.
  return events.map((event) => buildEventInput(event, pubDate));
}

export async function generateEventInfos(
  env: AiEnv,
  item: RssItem,
  previewText?: string,
): Promise<CalendarEventInput[]> {
  const bodyText = htmlToText(item.descriptionHtml);
  const prompt = [
    "공지사항 정보를 분석하여 캘린더 이벤트를 JSON으로 추출해 주세요.",
    "",
    `제목: ${item.title}`,
    `게시일: ${item.pubDate}`,
    `본문:\n${bodyText}`,
    ...(previewText ? ["", `첨부 이미지 텍스트 (본문과 충돌 시 본문 우선):\n${previewText}`] : []),
    "",
    `RSS 링크: ${item.link}`,
  ].join("\n");

  const schema = {
    type: "object",
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "행사 제목" },
            description: { type: "string", description: "행사 한 줄 요약 (최대 80자)" },
            startDate: { type: "string", description: "행사 시작일 YYYY-MM-DD" },
            endDate: { type: "string", description: "행사 종료일 YYYY-MM-DD" },
            startTime: { type: ["string", "null"], description: "시작 시각 HH:MM (24시간제) 또는 null" },
            endTime: { type: ["string", "null"], description: "종료 시각 HH:MM (24시간제) 또는 null" },
          },
          required: ["title", "description", "startDate", "endDate", "startTime", "endTime"],
          additionalProperties: false,
        },
      },
    },
    required: ["events"],
    additionalProperties: false,
  };

  let content: string | undefined;
  try {
    content = await callGatewayChat(env, {
      name: "announcement_events",
      messages: [
        {
          role: "system",
          content: `한국교원대학교 공지사항에서 캘린더 일정 정보를 추출하는 어시스턴트입니다.

추출 규칙:
- 본문에 다수의 행사가 있으면 각각 개별 이벤트로 분리합니다.

■ 빈 events 배열 반환 조건:
- 구체적인 날짜(YYYY-MM-DD 또는 M월 D일 등)가 없는 일반 공지
- 인사 발령, 조직 변경, 시설 안내, 규정 변경 등 일정이 아닌 공지
- "추후 공지", "별도 안내" 등 날짜가 미정인 경우

■ 신청/접수 마감일만 있는 경우:
- 마감일을 startDate와 endDate로 사용하고, title에 "(마감)"을 포함합니다.

■ 날짜 처리:
- 연도가 명시된 경우: 해당 연도를 그대로 사용합니다.
- 연도가 없는 경우: 게시일의 연도를 기준으로 하되, 행사일이 게시일 이전이면 연도를 +1 조정합니다 (최대 +1년까지만 허용).
- 모든 행사일은 게시일 이후여야 합니다.

■ 시간 처리 (Asia/Seoul KST):
- 종일 행사 또는 시간 미명시: startTime, endTime 모두 null
- 시작 시간만 있는 경우: endTime을 null
- 형식: HH:MM (24시간제)

■ title 작성:
- 제목 맨 앞에 행사 성격을 나타내는 이모지를 1개 붙입니다.
  예시: 세미나·강연 🎓, 채용·모집 📢, 신청·접수 마감 📝, 시험·평가 📋,
        회의·간담회 🤝, 문화·축제 🎉, 시설·공간 🏢, 장학·지원 💰, 기타 📌

■ description 작성:
- 행사의 한 줄 요약, 최대 80자, 본문을 그대로 옮기지 말 것, 빈 문자열 불가

한국어로만 작성하세요.`,
        },
        { role: "user", content: prompt },
      ],
      schema,
    });
  } catch (error) {
    console.error("generateEventInfos failed", error);
    throw error;
  }

  // Parsed outside the try so a bad payload is not relabelled as a request failure.
  return parseEventJsonArray(content, item.pubDate);
}
