import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  ConnectionError,
  IdempotencyError,
  InvalidRequestError,
  LicenseClient,
  PerlyPay,
  RateLimitError,
  SignatureVerificationError,
  backoffMs,
  webhooks,
} from "./index";
import { Http } from "./http";
import { hmacSha256, sha256, toHex } from "./sha256";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const header = (call: Call | undefined, name: string) => (call?.init.headers as Record<string, string>)[name];

function client(responses: (Response | Error)[], maxRetries = 2) {
  const { fn, calls } = fakeFetch(responses);
  const sleeps: number[] = [];
  const http = new Http({
    secretKey: "sk_test_abc",
    baseUrl: "http://pay.test/api/v1",
    maxRetries,
    timeoutMs: 1000,
    fetch: fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { http, calls, sleeps };
}

describe("PerlyPay client", () => {
  it("takes only a secret key and knows its mode", () => {
    expect(() => new PerlyPay("pk_test_nope")).toThrow(/secret key/);
    expect(new PerlyPay("sk_live_x").mode).toBe("live");
    expect(new PerlyPay("sk_test_x", { baseUrl: "http://localhost:3211/" }).baseUrl).toBe("http://localhost:3211");
  });

  it("sends the key, JSON and an Idempotency-Key on POST, none on GET", async () => {
    const { fn, calls } = fakeFetch([json(201, { id: "inv_1" }), json(200, { id: "inv_1" })]);
    const pay = new PerlyPay("sk_test_abc", { baseUrl: "http://pay.test", fetch: fn });
    await pay.invoices.create({ line_items: [{ price: "price_1" }] });
    await pay.invoices.retrieve("inv_1");
    expect(calls[0]?.url).toBe("http://pay.test/api/v1/invoices");
    expect(header(calls[0], "Authorization")).toBe("Bearer sk_test_abc");
    expect(header(calls[0], "Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ line_items: [{ price: "price_1" }] });
    expect(header(calls[1], "Idempotency-Key")).toBeUndefined();
    expect(calls[1]?.url).toBe("http://pay.test/api/v1/invoices/inv_1");
  });

  it("uses your Idempotency-Key when you give one", async () => {
    const { fn, calls } = fakeFetch([json(201, {})]);
    await new PerlyPay("sk_test_abc", { baseUrl: "http://pay.test", fetch: fn }).customers.create({ email: "a@b.co" }, { idempotencyKey: "order-42" });
    expect(header(calls[0], "Idempotency-Key")).toBe("order-42");
  });

  it("puts list filters in the query and walks every page", async () => {
    const { fn, calls } = fakeFetch([
      json(200, { object: "list", data: [{ id: "a" }, { id: "b" }], has_more: true, next_cursor: "c1" }),
      json(200, { object: "list", data: [{ id: "c" }], has_more: false, next_cursor: null }),
    ]);
    const pay = new PerlyPay("sk_test_abc", { baseUrl: "http://pay.test", fetch: fn });
    const seen: string[] = [];
    for await (const inv of pay.invoices.listAll({ status: "paid", limit: 2 })) seen.push(inv.id);
    expect(seen).toEqual(["a", "b", "c"]);
    expect(calls[0]?.url).toBe("http://pay.test/api/v1/invoices?status=paid&limit=2");
    expect(calls[1]?.url).toBe("http://pay.test/api/v1/invoices?status=paid&limit=2&cursor=c1");
  });
});

describe("retries", () => {
  it("retries a 5xx with the same Idempotency-Key, then succeeds", async () => {
    const { http, calls, sleeps } = client([json(503, { error: { type: "api_error", code: "x", message: "down" } }), json(200, { ok: true })]);
    await expect(http.request("POST", "/x", { a: 1 })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(header(calls[0], "Idempotency-Key")).toBe(header(calls[1], "Idempotency-Key"));
    expect(sleeps).toHaveLength(1);
  });

  it("waits as long as Retry-After says on a 429, and gives up after maxRetries", async () => {
    const limited = () => json(429, { error: { type: "rate_limit_error", code: "rate_limited", message: "slow" } }, { "retry-after": "2" });
    const { http, calls, sleeps } = client([limited(), limited(), limited()]);
    const error = await http.request("GET", "/x").catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("does not retry a 4xx and surfaces the API's error", async () => {
    const { http, calls } = client([
      json(400, { error: { type: "invalid_request_error", code: "parameter_invalid", message: "Bad.", param: "line_items[0].price" } }, { "perly-request-id": "req_1" }),
    ]);
    const error = await http.request("POST", "/x", {}).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error).toMatchObject({ code: "parameter_invalid", param: "line_items[0].price", status: 400, requestId: "req_1", message: "Bad." });
    expect(calls).toHaveLength(1);
  });

  it("retries a 409 only while the first request with the key is still running", async () => {
    const running = json(409, { error: { type: "idempotency_error", code: "idempotency_in_progress", message: "wait" } });
    const reused = json(409, { error: { type: "idempotency_error", code: "idempotency_key_reused", message: "no" } });
    const a = client([running, json(200, { ok: 1 })]);
    await expect(a.http.request("POST", "/x", {})).resolves.toEqual({ ok: 1 });
    const b = client([reused]);
    await expect(b.http.request("POST", "/x", {})).rejects.toBeInstanceOf(IdempotencyError);
    expect(b.calls).toHaveLength(1);
  });

  it("retries a network failure, then says it could not connect", async () => {
    const { http, calls } = client([new TypeError("fetch failed"), new TypeError("fetch failed")], 1);
    const error = await http.request("GET", "/x").catch((e) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).code).toBe("connection_failed");
    expect(calls).toHaveLength(2);
  });

  it("maps 401 to an AuthenticationError", async () => {
    const { http } = client([json(401, { error: { type: "authentication_error", code: "api_key_invalid", message: "no" } })]);
    await expect(http.request("GET", "/x")).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("backs off exponentially with jitter, capped", () => {
    expect(backoffMs(0, null, () => 0)).toBe(250);
    expect(backoffMs(0, null, () => 1)).toBe(500);
    expect(backoffMs(3, null, () => 1)).toBe(4000);
    expect(backoffMs(10, null, () => 1)).toBe(8000);
    expect(backoffMs(0, "3")).toBe(3000);
  });
});

describe("LicenseClient", () => {
  it("calls the public endpoints without any key", async () => {
    const { fn, calls } = fakeFetch([json(200, { object: "license_check", valid: true })]);
    const r = await new LicenseClient({ baseUrl: "http://pay.test", fetch: fn }).validate({ key: "AAAAA-BBBBB-CCCCC-DDDDD" });
    expect(r.valid).toBe(true);
    expect(calls[0]?.url).toBe("http://pay.test/api/v1/license_keys/validate");
    expect(header(calls[0], "Authorization")).toBeUndefined();
  });
});

describe("webhooks", () => {
  const secret = "whsec_testSECRET";
  const event = { id: "evt_1", object: "event", type: "invoice.paid", livemode: false, object_type: "invoice", object_id: "inv_1", data: {}, created: "2026-10-08T00:00:00.000Z" };
  const body = JSON.stringify(event);
  const t = 1_790_000_000;

  it("signs exactly as the spec says: hex HMAC-SHA256(secret, t + '.' + body)", async () => {
    const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    expect(webhooks.sign(body, secret, t)).toBe(`t=${t},v1=${expected}`);
  });

  it("verifies a good signature synchronously and returns the event", () => {
    const h = webhooks.sign(body, secret, t);
    expect(webhooks.verify(body, h, secret, { now: t + 10 })).toEqual(event);
    expect(webhooks.verify(new TextEncoder().encode(body), h, secret, { now: t })).toEqual(event);
    expect(webhooks.verify(Buffer.from(body), h, secret, { now: t })).toEqual(event);
    const pay = new PerlyPay("sk_test_x");
    expect(pay.webhooks.verify(body, h, secret, { now: t })).toMatchObject({ type: "invoice.paid" });
  });

  it("refuses a wrong secret, a changed body, a stale or future timestamp, and junk", () => {
    const h = webhooks.sign(body, secret, t);
    const refuse = (f: () => unknown, code: string) => {
      try {
        f();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureVerificationError);
        expect((e as SignatureVerificationError).code).toBe(code);
      }
    };
    refuse(() => webhooks.verify(body, h, "whsec_other", { now: t }), "signature_mismatch");
    refuse(() => webhooks.verify(body.replace("invoice.paid", "invoice.fake"), h, secret, { now: t }), "signature_mismatch");
    refuse(() => webhooks.verify(body, h, secret, { now: t + 301 }), "timestamp_out_of_tolerance");
    refuse(() => webhooks.verify(body, h, secret, { now: t - 301 }), "timestamp_out_of_tolerance");
    refuse(() => webhooks.verify(body, "v1=abc", secret, { now: t }), "malformed_signature");
    refuse(() => webhooks.verify(body, null, secret, { now: t }), "no_signature");
    refuse(() => webhooks.verify(body, h, "", { now: t }), "no_secret");
  });

  it("accepts any v1 that matches (two during a secret roll)", () => {
    const good = webhooks.sign(body, secret, t).split("v1=")[1];
    const h = `t=${t},v1=${"0".repeat(64)},v1=${good}`;
    expect(webhooks.verify(body, h, secret, { now: t })).toEqual(event);
  });

  it("builds a signed test request", () => {
    const req = webhooks.testRequest(event, secret, t);
    expect(webhooks.verify(req.body, req.headers["Perly-Signature"], secret, { now: t })).toEqual(event);
  });

  it("hashes like node:crypto, for empty, block-edge, long and multi-byte input, and long keys", () => {
    const enc = new TextEncoder();
    for (const text of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000), "Перлина 🐟"]) {
      expect(toHex(sha256(enc.encode(text))), text).toBe(createHash("sha256").update(text).digest("hex"));
    }
    const longKey = "k".repeat(100);
    expect(toHex(hmacSha256(enc.encode(longKey), enc.encode("m")))).toBe(createHmac("sha256", longKey).update("m").digest("hex"));
  });

  it("compares in constant time over equal lengths", () => {
    expect(webhooks.safeEqual("abc", "abc")).toBe(true);
    expect(webhooks.safeEqual("abc", "abd")).toBe(false);
    expect(webhooks.safeEqual("abc", "ab")).toBe(false);
  });
});

describe("credits", () => {
  const usage = { id: "cu_1", object: "credit_usage", livemode: false, customer: "cus_1", product: null, entitlement: null, credits: 3, action: "chat", balance: 97, created: "2026-10-20T00:00:00.000Z" };
  const balance = { object: "credit_balance", livemode: false, customer: "cus_1", product: null, balance: 97, low_balance_threshold: null, low: false, top_up_url: "https://pay.perly.io/topup/abc" };
  const pay = (responses: (Response | Error)[]) => {
    const { fn, calls } = fakeFetch(responses);
    return { pay: new PerlyPay("sk_test_abc", { baseUrl: "http://pay.test", fetch: fn, maxRetries: 2 }), calls };
  };
  const query = (call: Call | undefined) => Object.fromEntries(new URL(call!.url).searchParams);

  it("names the customer by id, email or your own id", async () => {
    const { pay: p, calls } = pay([json(200, balance), json(200, balance), json(200, balance), json(200, balance)]);
    await p.credits.balance("cus_0123456789abcdef0123456789abcdef");
    await p.credits.balance("ada@example.com", { product: "prod_1" });
    await p.credits.balance("user_42");
    await p.credits.balance({ external_id: "ada@example.com" });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(Array(4).fill("/api/v1/credits/balance"));
    expect(query(calls[0])).toEqual({ customer: "cus_0123456789abcdef0123456789abcdef" });
    expect(query(calls[1])).toEqual({ customer_email: "ada@example.com", product: "prod_1" });
    expect(query(calls[2])).toEqual({ customer_external_id: "user_42" });
    expect(query(calls[3])).toEqual({ customer_external_id: "ada@example.com" });
  });

  it("consumes in one line, with your idempotency key reused on every retry", async () => {
    const { pay: p, calls } = pay([json(503, { error: { type: "api_error", code: "internal", message: "x" } }), json(200, usage)]);
    const spent = await p.credits.consume("user_42", 3, { action: "chat", idempotencyKey: "req-7" });
    expect(spent.balance).toBe(97);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toBe("http://pay.test/api/v1/credits/consume");
      expect(header(c, "Idempotency-Key")).toBe("req-7");
      expect(JSON.parse(String(c.init.body))).toEqual({ customer_external_id: "user_42", credits: 3, action: "chat" });
    }
  });

  it("keeps one fresh key across retries when you give none, and takes the API's own params", async () => {
    const { pay: p, calls } = pay([new Error("socket hang up"), json(200, usage), json(200, usage)]);
    await p.credits.consume({ id: "cus_1" }, 1);
    expect(header(calls[0], "Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(header(calls[1], "Idempotency-Key")).toBe(header(calls[0], "Idempotency-Key"));
    await p.credits.consume({ customer_email: "ada@example.com", credits: 2, product: "prod_1" });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ customer_email: "ada@example.com", credits: 2, product: "prod_1" });
  });

  it("says insufficient credits as an error with its code, and does not retry it", async () => {
    const { pay: p, calls } = pay([json(409, { error: { type: "invalid_request_error", code: "insufficient_credits", message: "Not enough credits left (2).", param: "credits" } })]);
    const error = await p.credits.consume("user_42", 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error).toMatchObject({ code: "insufficient_credits", status: 409 });
    expect(calls).toHaveLength(1);
  });

  it("gives the top-up page's address", async () => {
    const { pay: p, calls } = pay([json(200, balance)]);
    expect(await p.credits.topUpUrl({ email: "ada@example.com" }, { product: "prod_1" })).toBe("https://pay.perly.io/topup/abc");
    expect(query(calls[0])).toEqual({ customer_email: "ada@example.com", product: "prod_1" });
  });

  it("lists spends by action", async () => {
    const { pay: p, calls } = pay([json(200, { object: "list", data: [usage], has_more: false, next_cursor: null })]);
    const page = await p.credits.usage({ action: "chat", limit: 5 });
    expect(page.data[0]?.action).toBe("chat");
    expect(query(calls[0])).toEqual({ action: "chat", limit: "5" });
  });
});
