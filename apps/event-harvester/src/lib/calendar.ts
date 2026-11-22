import type { CalendarEventInput, ProcessedRecord, GoogleCalendarAttachment } from "../types.js";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface CalendarEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  GOOGLE_CALENDAR_ID: string;
}

export interface GoogleCalendarEvent {
  id: string;
  status?: string;
  recovered?: true; // Resolved from an earlier insert with the same application event ID
  htmlLink?: string; // Absolute link to this event in Google Calendar Web UI
  summary?: string;
  description?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attachments?: Array<{
    fileUrl: string;
    mimeType: string;
    title?: string;
  }>;
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar";
const CALENDAR_TIMEOUT_MS = 20_000;

type JwtPayload = Record<string, unknown>;

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function signJwt(payload: JwtPayload, serviceAccount: ServiceAccount): Promise<string> {
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const encoder = new TextEncoder();
  const privateKeyBuffer = pemToArrayBuffer(serviceAccount.private_key);
  const headerEncoded = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadEncoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const unsignedToken = `${headerEncoded}.${payloadEncoded}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBuffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    encoder.encode(unsignedToken),
  );

  const signatureEncoded = base64UrlEncode(signature);
  return `${unsignedToken}.${signatureEncoded}`;
}

function parseServiceAccount(env: CalendarEnv): ServiceAccount {
  try {
    const parsed = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("Invalid service account JSON");
    }
    return parsed;
  } catch {
    throw new Error("Invalid service account JSON");
  }
}

export async function obtainAccessToken(env: CalendarEnv): Promise<string> {
  const serviceAccount = parseServiceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: serviceAccount.token_uri ?? DEFAULT_TOKEN_URI,
    scope: SCOPE,
    iat: now,
    exp: now + 3600,
  };

  const assertion = await signJwt(payload, serviceAccount);
  const response = await fetch(serviceAccount.token_uri ?? DEFAULT_TOKEN_URI, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Google OAuth error: ${response.status}`);
  }

  const data = (await response.json()) as AccessTokenResponse;
  return data.access_token;
}

export async function listEvents(
  env: CalendarEnv,
  token: string,
  params: { timeMin: string; timeMax: string },
): Promise<GoogleCalendarEvent[]> {
  const allEvents: GoogleCalendarEvent[] = [];
  let nextPageToken: string | undefined;
  const signal = AbortSignal.timeout(CALENDAR_TIMEOUT_MS);

  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`,
    );
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("timeMin", params.timeMin);
    url.searchParams.set("timeMax", params.timeMax);

    if (nextPageToken) {
      url.searchParams.set("pageToken", nextPageToken);
    }

    const response = await fetch(url.toString(), {
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to list events", response.status, errorText);
      throw new Error(`Google Calendar list error ${response.status}`);
    }

    const data = (await response.json()) as {
      items?: GoogleCalendarEvent[];
      nextPageToken?: string;
    };
    if (data.items) {
      allEvents.push(...data.items);
    }
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  return allEvents;
}

export async function createEvent(
  env: CalendarEnv,
  token: string,
  input: CalendarEventInput,
  meta: ProcessedRecord,
  descriptionExtras?: Record<string, unknown>,
  attachments?: GoogleCalendarAttachment[],
  eventId?: string,
): Promise<GoogleCalendarEvent> {
  const startDate = input.startDate;
  const endDate = input.endDate;

  let start: { date?: string; dateTime?: string };
  let end: { date?: string; dateTime?: string };

  if (input.startTime && input.endTime) {
    // Timed event
    const startDateTime = `${startDate}T${input.startTime}:00+09:00`; // Assume KST
    const endDateTime = `${endDate}T${input.endTime}:00+09:00`;
    start = { dateTime: startDateTime };
    end = { dateTime: endDateTime };
  } else {
    // All-day event
    const endDateExclusive = addDays(endDate, 1);
    start = { date: startDate };
    end = { date: endDateExclusive };
  }

  const body: Record<string, unknown> = {
    ...(eventId ? { id: eventId } : {}),
    summary: input.title,
    description: input.description,
    start,
    end,
    extendedProperties: {
      private: {
        nttNo: meta.nttNo,
        hash: meta.hash,
        ...Object.fromEntries(
          Object.entries(descriptionExtras ?? {}).map(([key, value]) => [
            key,
            typeof value === "string" ? value : JSON.stringify(value),
          ]),
        ),
        ...(eventId ? { knueHarvestId: eventId, nttNo: meta.nttNo, feedId: meta.feedId } : {}),
      },
    },
  };

  // AC-4, AC-5: Google Calendar attachments 추가
  if (attachments && attachments.length > 0) {
    body.attachments = attachments;
  }

  // Google Calendar API requires supportsAttachments=true when attachments are present
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`,
  );
  if (attachments && attachments.length > 0) {
    url.searchParams.set("supportsAttachments", "true");
  }

  const signal = AbortSignal.timeout(CALENDAR_TIMEOUT_MS);
  const response = await fetch(url.toString(), {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 409 && eventId) {
    url.pathname += `/${encodeURIComponent(eventId)}`;
    url.search = "";
    const existing = await fetch(url.toString(), {
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!existing.ok) throw new Error(`Google Calendar conflict lookup error ${existing.status}`);

    const event = await existing.json() as GoogleCalendarEvent;
    const properties = event?.extendedProperties?.private;
    if (event?.id !== eventId || event.status === "cancelled" || properties?.knueHarvestId !== eventId ||
        properties.nttNo !== meta.nttNo || properties.feedId !== meta.feedId) {
      throw new Error("Google Calendar event ownership mismatch");
    }
    return { ...event, recovered: true };
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Failed to create calendar event", response.status, errorText);
    throw new Error(`Google Calendar create error ${response.status}`);
  }

  const event = await response.json() as GoogleCalendarEvent;
  if (eventId && event?.id !== eventId) {
    throw new Error("Google Calendar event ID mismatch");
  }
  return event;
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
