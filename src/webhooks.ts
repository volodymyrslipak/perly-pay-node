/**
 * Webhook signatures. Every event we POST carries
 *
 *   Perly-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>
 *
 * `verify` checks it on the RAW body (before any JSON parsing — a parsed
 * and re-serialised body does not match), in constant time, and refuses
 * a timestamp more than five minutes from now (a replayed request).
 * Synchronous, plain TypeScript HMAC (./sha256.ts): runs in Node, Deno,
 * Bun, workers and edge with no dependency.
 */
import { SignatureVerificationError } from "./errors.js";
import { hmacSha256, toHex } from "./sha256.js";
import type { Event } from "./types.js";

export const SIGNATURE_HEADER = "Perly-Signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function toBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return encoder.encode(body);
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

/** HMAC-SHA256 of `t + "." + body`, as lowercase hex. */
export function computeSignature(secret: string, timestamp: number, body: string | Uint8Array | ArrayBuffer): string {
  const prefix = encoder.encode(`${timestamp}.`);
  const raw = toBytes(body);
  const message = new Uint8Array(prefix.length + raw.length);
  message.set(prefix, 0);
  message.set(raw, prefix.length);
  return toHex(hmacSha256(encoder.encode(secret), message));
}

/** Constant-time string comparison (length is not secret here: both are 64 hex). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    const v = rest.join("=");
    if (k === "t" && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) signatures.push(v.toLowerCase());
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

export interface VerifyOptions {
  /** Seconds a signature stays good. Default 300. */
  toleranceSeconds?: number;
  /** Unix seconds "now" (tests). */
  now?: number;
}

function fail(code: string, message: string): never {
  throw new SignatureVerificationError({ type: "signature_verification_error", code, message });
}

/**
 * Checks a webhook and returns its event. Throws SignatureVerificationError
 * when the header is missing or malformed, the signature does not match
 * (any `v1` may — two during a secret roll), or it is too old or too new.
 */
export function verify<T = Event>(
  rawBody: string | Uint8Array | ArrayBuffer,
  header: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): T {
  if (!secret) fail("no_secret", "Pass your endpoint's signing secret (whsec_…).");
  if (!header) fail("no_signature", `No ${SIGNATURE_HEADER} header.`);
  const parsed = parseSignatureHeader(header);
  if (!parsed) fail("malformed_signature", `${SIGNATURE_HEADER} is not t=…,v1=….`);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - parsed.timestamp) > tolerance) fail("timestamp_out_of_tolerance", "The signature is too old (or from the future).");
  const expected = computeSignature(secret, parsed.timestamp, rawBody);
  if (!parsed.signatures.some((s) => safeEqual(s, expected))) fail("signature_mismatch", "The signature does not match.");
  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(toBytes(rawBody));
  try {
    return JSON.parse(text) as T;
  } catch {
    return fail("body_not_json", "The body is not JSON.");
  }
}

/** For tests: the header we would send for `payload` (an object is JSON-encoded; use the same string as the body). */
export function sign(payload: string | object, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, body)}`;
}

/** For tests: a signed request body + headers, as if from Perly Pay. */
export function testRequest(event: object, secret: string, timestamp?: number): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  return { body, headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: sign(body, secret, timestamp) } };
}
