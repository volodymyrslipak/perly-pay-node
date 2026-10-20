/**
 * One request to the API, with what a server SDK should do for you:
 * the key, JSON in and out, an Idempotency-Key on every POST (the same
 * one across retries), retries with backoff on 429 / 5xx / network
 * errors (honouring Retry-After), and a timeout. Plain `fetch`.
 */
import { ConnectionError, PerlyPayError } from "./errors.js";

export const SDK_VERSION = "0.1.0";

export interface HttpOptions {
  /** Empty for the public endpoints (license checks from your app). */
  secretKey: string;
  baseUrl: string;
  maxRetries: number;
  timeoutMs: number;
  fetch: typeof fetch;
  /** For tests: how to wait between retries. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  /** Your own Idempotency-Key; by default every POST gets a fresh UUID. */
  idempotencyKey?: string;
  /** Per-request override of the client's retries. */
  maxRetries?: number;
  /** Per-request override of the client's timeout. */
  timeoutMs?: number;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

function uuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Exponential backoff with full jitter: ~0.5 s, 1 s, 2 s … capped at 8 s; Retry-After wins when given. */
export function backoffMs(attempt: number, retryAfter: string | null, random = Math.random): number {
  const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const cap = Math.min(8000, 500 * 2 ** attempt);
  return Math.round(cap / 2 + random() * (cap / 2));
}

function shouldRetry(status: number): boolean {
  return status === 409 || status === 429 || status >= 500;
}

export class Http {
  constructor(private readonly options: HttpOptions) {}

  async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, query?: Query, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.options.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.options.secretKey) {
      headers.Authorization = `Bearer ${this.options.secretKey}`;
      headers["Perly-Client"] = `ts/${SDK_VERSION}`;
    }
    let payload: string | undefined;
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = opts.idempotencyKey ?? uuid();
      payload = JSON.stringify(body ?? {});
    }
    const retries = opts.maxRetries ?? this.options.maxRetries;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.options.fetch(url.toString(), {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.options.timeoutMs),
        });
      } catch (error) {
        if (attempt < retries) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw new ConnectionError({
          type: "connection_error",
          code: (error as Error)?.name === "TimeoutError" ? "timeout" : "connection_failed",
          message: `Could not reach Perly Pay: ${(error as Error)?.message ?? String(error)}`,
        });
      }

      const requestId = response.headers.get("perly-request-id") ?? undefined;
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (response.ok) return json as T;

      // A conflict is retried only while the first request with this key is still running.
      const errorBody = (json as { error?: { type?: string; code?: string; message?: string; param?: string } } | null)?.error;
      const retriable =
        shouldRetry(response.status) && (response.status !== 409 || errorBody?.code === "idempotency_in_progress");
      if (retriable && attempt < retries) {
        await sleep(backoffMs(attempt, response.headers.get("retry-after")));
        continue;
      }
      throw PerlyPayError.from({
        type: errorBody?.type ?? "api_error",
        code: errorBody?.code ?? `http_${response.status}`,
        message: errorBody?.message ?? `Perly Pay answered ${response.status}.`,
        param: errorBody?.param,
        status: response.status,
        requestId,
        headers: Object.fromEntries(response.headers),
      });
    }
  }

  /** The raw bytes of a GET (a receipt's PDF). */
  async bytes(path: string, opts: RequestOptions = {}): Promise<Uint8Array> {
    const response = await this.options.fetch(this.options.baseUrl + path, {
      headers: { Authorization: `Bearer ${this.options.secretKey}`, "Perly-Client": `ts/${SDK_VERSION}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.options.timeoutMs),
    });
    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as { error?: { type?: string; code?: string; message?: string } } | null;
      throw PerlyPayError.from({
        type: json?.error?.type ?? "api_error",
        code: json?.error?.code ?? `http_${response.status}`,
        message: json?.error?.message ?? `Perly Pay answered ${response.status}.`,
        status: response.status,
        requestId: response.headers.get("perly-request-id") ?? undefined,
      });
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
