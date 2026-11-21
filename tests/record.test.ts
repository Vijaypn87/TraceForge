import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprint } from "../src/canonical.js";
import { Journal } from "../src/journal.js";
import { createRecordingFetch } from "../src/record.js";
import { decodeResponseEnvelope } from "../src/envelope.js";
import { createFakeAnthropic, messageJson } from "./helpers/fake-anthropic.js";

let dir: string;
let journal: Journal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "traceforge-test-"));
  journal = Journal.open(join(dir, "t.traceforge.db"));
});

afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

const URL_ = "https://api.anthropic.com/v1/messages";

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  };
}

describe("createRecordingFetch (non-streaming)", () => {
  it("passes the upstream response through unmodified and consumable", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("hello"), headers: { "x-custom": "kept" } }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const res = await rec(URL_, post({ model: "m", messages: [] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-custom")).toBe("kept");
    const parsed = (await res.json()) as { content: Array<{ text: string }> };
    expect(parsed.content[0]!.text).toBe("hello");
  });

  it("journals exactly one event per call with correct fingerprint and bytes", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("hi") }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const init = post({ model: "m", messages: [{ role: "user", content: "q" }] });
    await (await rec(URL_, init)).text();

    const events = journal.eventsForRun(run);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe("llm_call");
    expect(e.streamed).toBe(false);
    expect(e.fingerprint).toBe(
      fingerprint({ url: URL_, method: "POST", headers: init.headers as Record<string, string>, body: init.body as string }),
    );

    const req = JSON.parse(new TextDecoder().decode(e.request)) as { url: string; body: string };
    expect(req.url).toBe(URL_);
    expect(req.body).toBe(init.body);

    const env = decodeResponseEnvelope(e.response);
    expect(env.status).toBe(200);
    const body = JSON.parse(new TextDecoder().decode(env.body)) as { content: Array<{ text: string }> };
    expect(body.content[0]!.text).toBe("hi");
  });

  it("journals sequential calls in order", async () => {
    const fake = createFakeAnthropic((_req, i) => ({ json: messageJson(`reply-${i}`) }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    await (await rec(URL_, post({ n: 1 }))).text();
    await (await rec(URL_, post({ n: 2 }))).text();
    await (await rec(URL_, post({ n: 3 }))).text();

    const events = journal.eventsForRun(run);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    const texts = events.map((e) => {
      const env = decodeResponseEnvelope(e.response);
      return (JSON.parse(new TextDecoder().decode(env.body)) as { content: Array<{ text: string }> }).content[0]!.text;
    });
    expect(texts).toEqual(["reply-0", "reply-1", "reply-2"]);
  });

  it("journals error responses too — failures are part of history", async () => {
    const fake = createFakeAnthropic(() => ({
      status: 429,
      json: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
    }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const res = await rec(URL_, post({ model: "m" }));
    expect(res.status).toBe(429);
    await res.text();

    const events = journal.eventsForRun(run);
    expect(events).toHaveLength(1);
    expect(decodeResponseEnvelope(events[0]!.response).status).toBe(429);
    expect(events[0]!.meta["status"]).toBe(429);
  });

  it("records meta: url, method, status, durationMs", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("x") }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);
    await (await rec(URL_, post({ model: "m" }))).text();

    const meta = journal.eventsForRun(run)[0]!.meta;
    expect(meta["url"]).toBe(URL_);
    expect(meta["method"]).toBe("POST");
    expect(meta["status"]).toBe(200);
    expect(typeof meta["durationMs"]).toBe("number");
  });
});

describe("secret redaction", () => {
  it("never stores api keys or cookies in the journal, and replay matching is unaffected", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("hi") }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    await (
      await rec(URL_, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-ant-SUPER-SECRET",
          "x-api-key": "sk-ant-ALSO-SECRET",
          cookie: "session=SECRET-COOKIE",
        },
        body: JSON.stringify({ turn: 0 }),
      })
    ).text();

    const event = journal.eventsForRun(run)[0]!;
    const storedRequest = new TextDecoder().decode(event.request);
    expect(storedRequest).not.toContain("SUPER-SECRET");
    expect(storedRequest).not.toContain("ALSO-SECRET");
    expect(storedRequest).not.toContain("SECRET-COOKIE");
    const headers = (JSON.parse(storedRequest) as { headers: Record<string, string> }).headers;
    expect(headers["authorization"]).toBe("[redacted]");
    expect(headers["x-api-key"]).toBe("[redacted]");
    expect(headers["cookie"]).toBe("[redacted]");
  });
});

describe("secret redaction (responses and URLs)", () => {
  it("redacts secret response headers before journaling, but passes them through to the caller", async () => {
    const fake = createFakeAnthropic(() => ({
      json: messageJson("hi"),
      headers: { "set-cookie": "session=RESP-COOKIE", "anthropic-organization-id": "org-SECRET-ID", "x-custom": "kept" },
    }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const res = await rec(URL_, post({ turn: 0 }));
    expect(res.headers.get("anthropic-organization-id")).toBe("org-SECRET-ID");
    await res.text();

    const event = journal.eventsForRun(run)[0]!;
    const stored = new TextDecoder().decode(event.response);
    expect(stored).not.toContain("RESP-COOKIE");
    expect(stored).not.toContain("org-SECRET-ID");
    const headers = decodeResponseEnvelope(event.response).headers;
    expect(headers["set-cookie"]).toBe("[redacted]");
    expect(headers["anthropic-organization-id"]).toBe("[redacted]");
    expect(headers["x-custom"]).toBe("kept");
  });

  it("redacts credential-like query parameters from stored URLs, keeps the rest, and still sends the real URL", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("hi") }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    await (await rec("https://api.example.com/v1/gen?model=m1&key=QUERY-SECRET&Access_Token=TOKEN-SECRET", post({ turn: 0 }))).text();
    expect(fake.requests[0]!.url).toContain("key=QUERY-SECRET");

    const event = journal.eventsForRun(run)[0]!;
    const all = new TextDecoder().decode(event.request) + JSON.stringify(event.meta);
    expect(all).not.toContain("QUERY-SECRET");
    expect(all).not.toContain("TOKEN-SECRET");
    expect(String(event.meta["url"])).toContain("model=m1");
    expect(String(event.meta["url"])).toContain("key=%5Bredacted%5D");
  });

  it("gives requests that differ only in a redacted query secret the same fingerprint", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("hi") }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);
    await (await rec("https://api.example.com/v1?key=AAA", post({ turn: 0 }))).text();
    await (await rec("https://api.example.com/v1?key=BBB", post({ turn: 0 }))).text();
    const [a, b] = journal.eventsForRun(run);
    expect(a!.fingerprint).toBe(b!.fingerprint);
  });
});

describe("Request-object input", () => {
  it("records a Request with a body without consuming it before the real fetch", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("hi") }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const res = await rec(new Request(URL_, post({ turn: 7 })));
    expect(res.status).toBe(200);
    await res.text();

    expect(fake.requests[0]!.body).toBe(JSON.stringify({ turn: 7 }));
    const stored = JSON.parse(new TextDecoder().decode(journal.eventsForRun(run)[0]!.request)) as { body: string | null };
    expect(stored.body).toBe(JSON.stringify({ turn: 7 }));
  });

  it("fingerprints a Request object the same as the equivalent (url, init) call", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("hi") }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);
    await (await rec(new Request(URL_, post({ turn: 1 })))).text();
    await (await rec(URL_, post({ turn: 1 }))).text();
    const [a, b] = journal.eventsForRun(run);
    expect(a!.fingerprint).toBe(b!.fingerprint);
  });
});
