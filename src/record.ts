import { fingerprint } from "./canonical.js";
import {
  encodeRequestRecord,
  encodeResponseEnvelope,
  headersToRecord,
  type RequestRecord,
} from "./envelope.js";
import type { Journal, RunId } from "./journal.js";

// Journals are shareable artifacts ("attach it to the bug report"), so
// credentials must never reach disk. Redaction happens here — before
// fingerprinting AND before storage — in both record and replay paths, so
// fingerprints stay consistent. Fingerprints strip authorization/x-api-key
// as volatile anyway; cookie redacts to a constant, which both sides see.
const SECRET_HEADERS = new Set(["authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"]);

// Response headers additionally carry account identifiers that have no place
// in a shareable artifact.
const SECRET_RESPONSE_HEADERS = new Set([...SECRET_HEADERS, "anthropic-organization-id"]);

const REDACTED = "[redacted]";

export function redactSecrets(
  headers: Record<string, string>,
  secret: ReadonlySet<string> = SECRET_HEADERS,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = secret.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

export function redactResponseHeaders(headers: Record<string, string>): Record<string, string> {
  return redactSecrets(headers, SECRET_RESPONSE_HEADERS);
}

// Query parameters that conventionally carry credentials (e.g. Gemini's
// ?key=, presigned-URL signatures). Matched case-insensitively on the name.
const SECRET_QUERY_PARAMS = new Set([
  "key",
  "api_key",
  "apikey",
  "api-key",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth",
  "secret",
  "client_secret",
  "password",
  "signature",
  "sig",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "x-goog-credential",
]);

/** Mask credential-like query values. Applied before fingerprinting in both
 * record and replay, so redacted URLs still match each other. */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  for (const name of new Set(parsed.searchParams.keys())) {
    if (SECRET_QUERY_PARAMS.has(name.toLowerCase())) {
      const count = parsed.searchParams.getAll(name).length;
      parsed.searchParams.delete(name);
      for (let i = 0; i < count; i++) parsed.searchParams.append(name, REDACTED);
      changed = true;
    }
  }
  return changed ? parsed.toString() : url;
}

export async function requestFromFetchArgs(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<RequestRecord> {
  // Constructing a Request from a Request consumes the original's body, so
  // build from a clone: the caller's input must stay usable for the real fetch.
  const req = new Request(input instanceof Request ? input.clone() : input, init);
  const body = req.method === "GET" || req.method === "HEAD" ? null : await req.clone().text();
  const hasBody = init?.body !== undefined || (input instanceof Request && input.body !== null);
  return {
    url: redactUrl(req.url),
    method: req.method,
    headers: redactSecrets(headersToRecord(req.headers)),
    body: body === "" && !hasBody ? null : body,
  };
}

export function createRecordingFetch(journal: Journal, run: RunId, base: typeof fetch = fetch): typeof fetch {
  // Journal seq is completion order (events append when responses settle).
  // arrivalIndex captures request-issue order so replay can pair racing
  // identical requests with the responses their callers originally received.
  let arrival = 0;
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const arrivalIndex = arrival;
    arrival += 1;
    const record = await requestFromFetchArgs(input, init);
    return performAndJournal(journal, run, base, input, init, record, fingerprint(record), arrivalIndex);
  }) as typeof fetch;
}

/** Execute a request against the live transport and journal the outcome.
 * Shared by plain recording and the hybrid replay miss-path, so everything
 * a hybrid session serves live lands in the journal the same way. */
export async function performAndJournal(
  journal: Journal,
  run: RunId,
  base: typeof fetch,
  input: string | URL | Request,
  init: RequestInit | undefined,
  record: RequestRecord,
  fp: string,
  arrivalIndex: number,
): Promise<Response> {
  const started = performance.now();

  const res = await base(input, init);
  const isEventStream = (res.headers.get("content-type") ?? "").includes("text/event-stream");

  const journalEvent = (envelope: { streamed: boolean; body: Uint8Array; chunks: Uint8Array[]; truncated: boolean }) => {
    journal.appendEvent(run, {
      kind: "llm_call",
      fingerprint: fp,
      request: encodeRequestRecord(record),
      response: encodeResponseEnvelope({
        status: res.status,
        statusText: res.statusText,
        headers: redactResponseHeaders(headersToRecord(res.headers)),
        ...envelope,
      }),
      streamed: envelope.streamed,
      meta: {
        url: record.url,
        method: record.method,
        status: res.status,
        arrivalIndex,
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        ...(envelope.truncated ? { truncated: true } : {}),
      },
    });
  };

  if (!isEventStream || res.body === null) {
    const bodyBytes = new Uint8Array(await res.clone().arrayBuffer());
    journalEvent({ streamed: false, body: bodyBytes, chunks: [], truncated: false });
    return res;
  }

  // Streaming: tee chunk-by-chunk so the consumer sees the exact upstream
  // framing, and journal the framed chunk log when the stream settles.
  const upstream = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let settled = false;
  const settle = (truncated: boolean) => {
    if (settled) return;
    settled = true;
    journalEvent({ streamed: true, body: new Uint8Array(0), chunks, truncated });
  };

  const tee = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await upstream.read();
        if (done) {
          settle(false);
          controller.close();
          return;
        }
        chunks.push(value);
        controller.enqueue(value);
      } catch (err) {
        settle(true);
        controller.error(err);
      }
    },
    async cancel(reason) {
      settle(true);
      await upstream.cancel(reason);
    },
  });

  return new Response(tee, { status: res.status, statusText: res.statusText, headers: res.headers });
}
