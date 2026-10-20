/**
 * perly-pay — Perly Pay's server SDK. Zero dependencies, `fetch`-based.
 *
 *   import { PerlyPay } from "perly-pay";
 *   const pay = new PerlyPay(process.env.PERLY_PAY_SECRET_KEY!);
 *   const invoice = await pay.invoices.create({ line_items: [{ price: "price_…" }] });
 *   // send the buyer to invoice.url
 *
 * Every POST carries an Idempotency-Key (yours, or a fresh UUID reused on
 * retries); 429 and 5xx are retried with backoff. Webhooks:
 * `pay.webhooks.verify(rawBody, request.headers.get("perly-signature"), secret)`.
 */
import { Http, SDK_VERSION, type Query, type RequestOptions } from "./http.js";
import type * as T from "./types.js";
import * as webhooks from "./webhooks.js";

export * from "./errors.js";
export type * from "./types.js";
export { SDK_VERSION, backoffMs, type RequestOptions } from "./http.js";
export { webhooks };
export { verify as verifyWebhook, sign as signWebhook, SIGNATURE_HEADER } from "./webhooks.js";

export interface PerlyPayOptions {
  /** Default https://pay.perly.io */
  baseUrl?: string;
  /** Retries on 429, 5xx and network errors. Default 2. */
  maxRetries?: number;
  /** Per attempt. Default 30 000 ms. */
  timeoutMs?: number;
  /** Your own fetch (a proxy, a test double). */
  fetch?: typeof fetch;
}

const enc = encodeURIComponent;
type Obj = object;

/** Shared verbs: create / retrieve / update / list, and `listAll` to walk every page. */
class Resource<O, C extends Obj = Obj, U extends Obj = Obj, L extends Obj = T.ListParams> {
  constructor(
    protected readonly http: Http,
    protected readonly path: string,
  ) {}

  create(params: C, options?: RequestOptions): Promise<O> {
    return this.http.request<O>("POST", this.path, params, undefined, options);
  }

  retrieve(id: string, options?: RequestOptions): Promise<O> {
    return this.http.request<O>("GET", `${this.path}/${enc(id)}`, undefined, undefined, options);
  }

  update(id: string, params: U, options?: RequestOptions): Promise<O> {
    return this.http.request<O>("POST", `${this.path}/${enc(id)}`, params, undefined, options);
  }

  list(params?: L & T.ListParams, options?: RequestOptions): Promise<T.List<O>> {
    return this.http.request<T.List<O>>("GET", this.path, undefined, params as Query, options);
  }

  /** Every object, page after page: `for await (const x of pay.invoices.listAll({ limit: 100 }))`. */
  async *listAll(params?: L & T.ListParams, options?: RequestOptions): AsyncGenerator<O> {
    let cursor = params?.cursor;
    for (;;) {
      const page = await this.list({ ...(params as L), cursor } as L & T.ListParams, options);
      yield* page.data;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  protected action<R = O>(id: string, verb: string, params: Obj = {}, options?: RequestOptions): Promise<R> {
    return this.http.request<R>("POST", `${this.path}/${enc(id)}/${verb}`, params, undefined, options);
  }
}

class Invoices extends Resource<
  T.Invoice,
  T.InvoiceCreateParams,
  never,
  { status?: T.InvoiceStatus; customer?: string; subscription?: string }
> {
  /** Only while nothing has arrived. */
  cancel(id: string, options?: RequestOptions) {
    return this.action(id, "cancel", {}, options);
  }
  /** Test mode: the buyer pays in full (default), half (`short`) or a tenth more (`over`). */
  simulate(id: string, params: { outcome?: "full" | "short" | "over"; chain?: string; asset?: T.Asset } = {}, options?: RequestOptions) {
    return this.action(id, "simulate", params, options);
  }
}

class CheckoutSessions extends Resource<
  T.CheckoutSession,
  T.CheckoutSessionCreateParams,
  never,
  { status?: T.CheckoutSession["status"]; customer?: string }
> {
  expire(id: string, options?: RequestOptions) {
    return this.action(id, "expire", {}, options);
  }
}

class Subscriptions extends Resource<
  T.Subscription,
  T.SubscriptionCreateParams,
  { price?: string; cancel_at_period_end?: boolean; metadata?: T.Metadata },
  { status?: T.SubscriptionStatus; customer?: string; price?: string }
> {
  cancel(id: string, params: { at_period_end?: boolean } = {}, options?: RequestOptions) {
    return this.action(id, "cancel", params, options);
  }
  pause(id: string, options?: RequestOptions) {
    return this.action(id, "pause", {}, options);
  }
  resume(id: string, options?: RequestOptions) {
    return this.action(id, "resume", {}, options);
  }
  /** Opens one invoice for `periods` periods ahead. */
  prepay(id: string, params: { periods: number }, options?: RequestOptions) {
    return this.action<T.Invoice>(id, "prepay", params, options);
  }
}

class Entitlements extends Resource<T.Entitlement, never, never, { customer?: string; product?: string; subscription?: string }> {
  /** May this customer use this product now? */
  check(params: T.EntitlementCheckParams, options?: RequestOptions) {
    return this.http.request<T.EntitlementCheck>("GET", `${this.path}/check`, undefined, params as Query, options);
  }
  /** Spends credits from one credit pack; `action` labels it for your reports. */
  consume(id: string, params: { credits: number; action?: string }, options?: RequestOptions) {
    return this.action(id, "consume", params, options);
  }
}

/** `cus_…` or a bare uuid is an id; a string with `@` an email; any other string your own id (`external_id`). */
export function customerParams(customer: T.CustomerRef): T.CreditCustomerParams {
  if (typeof customer !== "string") {
    if ("id" in customer) return { customer: customer.id };
    if ("email" in customer) return { customer_email: customer.email };
    return { customer_external_id: customer.external_id };
  }
  if (/^cus_[0-9a-f]{32}$/i.test(customer) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customer)) return { customer };
  if (customer.includes("@")) return { customer_email: customer };
  return { customer_external_id: customer };
}

/** The API's own params (`{ customer_external_id, … }`), told apart from a CustomerRef object (`{ id }`, `{ email }`, `{ external_id }`). */
function isApiParams(value: unknown): value is T.CreditCustomerParams {
  return typeof value === "object" && value !== null && ("customer" in value || "customer_email" in value || "customer_external_id" in value);
}

/**
 * Credits, one line each — the buyer tops up themselves; you spend:
 *
 *   const { balance, top_up_url } = await pay.credits.balance("user_42");
 *   await pay.credits.consume("user_42", 3, { action: "chat", idempotencyKey: requestId });
 *   const url = await pay.credits.topUpUrl("user_42");
 */
class Credits {
  constructor(private readonly http: Http) {}

  /** What the customer has left (on `product`'s packs, or all of them), with their top-up page. */
  balance(customer: T.CustomerRef | T.CreditCustomerParams, params: { product?: string } = {}, options?: RequestOptions): Promise<T.CreditBalance> {
    const who = isApiParams(customer) ? customer : customerParams(customer);
    return this.http.request<T.CreditBalance>("GET", "/credits/balance", undefined, { ...params, ...who } as Query, options);
  }

  /**
   * Spends `credits`, never below zero: refused with an `InvalidRequestError`
   * whose `code` is `insufficient_credits` when fewer are left. Give
   * `idempotencyKey` (your request's id) and a retry never spends twice;
   * without one, the SDK's own key covers its retries.
   */
  consume(params: T.CreditConsumeParams, options?: RequestOptions): Promise<T.CreditUsage>;
  consume(
    customer: T.CustomerRef,
    credits: number,
    params?: { action?: string; product?: string; idempotencyKey?: string },
    options?: RequestOptions,
  ): Promise<T.CreditUsage>;
  consume(
    customer: T.CustomerRef | T.CreditConsumeParams,
    credits?: number | RequestOptions,
    params: { action?: string; product?: string; idempotencyKey?: string } = {},
    options: RequestOptions = {},
  ): Promise<T.CreditUsage> {
    if (isApiParams(customer)) {
      return this.http.request<T.CreditUsage>("POST", "/credits/consume", customer, undefined, (credits as RequestOptions | undefined) ?? {});
    }
    if (typeof credits !== "number") throw new TypeError("credits.consume(customer, credits): credits must be a number");
    const { idempotencyKey, ...rest } = params;
    const body = { ...customerParams(customer), credits, ...rest };
    return this.http.request<T.CreditUsage>("POST", "/credits/consume", body, undefined, { ...options, idempotencyKey: idempotencyKey ?? options.idempotencyKey });
  }

  /** The buyer's own top-up page — stable for the customer; on one product when named. */
  async topUpUrl(customer: T.CustomerRef, params: { product?: string } = {}, options?: RequestOptions): Promise<string> {
    return (await this.balance(customer, params, options)).top_up_url;
  }

  /** Spends, newest first: by customer, product or action. */
  usage(params: T.ListParams & { customer?: string; product?: string; action?: string } = {}, options?: RequestOptions): Promise<T.List<T.CreditUsage>> {
    return this.http.request<T.List<T.CreditUsage>>("GET", "/credits/usage", undefined, params as Query, options);
  }
}

class LicenseKeys extends Resource<T.LicenseKey, never, never, { customer?: string; product?: string; status?: T.LicenseStatus }> {
  validate(params: T.LicenseScope & { instance?: string; instance_name?: string }, options?: RequestOptions) {
    return this.http.request<T.LicenseCheck>("POST", `${this.path}/validate`, params, undefined, options);
  }
  activate(params: T.LicenseScope & { instance_name: string }, options?: RequestOptions) {
    return this.http.request<T.LicenseCheck>("POST", `${this.path}/activate`, params, undefined, options);
  }
  deactivate(params: T.LicenseScope & ({ instance: string } | { instance_name: string }), options?: RequestOptions) {
    return this.http.request<T.LicenseCheck>("POST", `${this.path}/deactivate`, params, undefined, options);
  }
  revoke(id: string, options?: RequestOptions) {
    return this.action(id, "revoke", {}, options);
  }
}

class Refunds extends Resource<
  T.Refund,
  { invoice: string; amount?: string; reason?: string },
  never,
  { invoice?: string; status?: T.RefundStatus }
> {
  /** What a refund of this invoice would send now. */
  quote(params: { invoice: string }, options?: RequestOptions) {
    return this.http.request<T.RefundQuote>("GET", `${this.path}/quote`, undefined, params, options);
  }
  /** After you sent `amount_to_send` to `refund_address`. */
  markSent(id: string, params: { txid: string }, options?: RequestOptions) {
    return this.action(id, "mark_sent", params, options);
  }
}

class Receipts extends Resource<T.Receipt, never, never, { invoice?: string; kind?: T.Receipt["kind"] }> {
  pdf(id: string, options?: RequestOptions): Promise<Uint8Array> {
    return this.http.bytes(`${this.path}/${enc(id)}/pdf`, options);
  }
}

class WebhookEndpoints extends Resource<
  T.WebhookEndpoint,
  T.WebhookEndpointCreateParams,
  { url?: string; enabled_events?: string[]; description?: string | null; disabled?: boolean }
> {
  del(id: string, options?: RequestOptions) {
    return this.http.request<T.Deleted>("DELETE", `${this.path}/${enc(id)}`, undefined, undefined, options);
  }
  /** A new signing secret; the old one stops at once. */
  rollSecret(id: string, options?: RequestOptions) {
    return this.action(id, "roll_secret", {}, options);
  }
}

export class PerlyPay {
  readonly baseUrl: string;
  readonly mode: "test" | "live";

  readonly invoices: Invoices;
  readonly checkoutSessions: CheckoutSessions;
  readonly products: Resource<T.Product, T.ProductCreateParams, Partial<T.ProductCreateParams>, { active?: boolean }>;
  readonly prices: Resource<
    T.Price,
    T.PriceCreateParams,
    { nickname?: string | null; active?: boolean; refunds?: T.RefundTerms; metadata?: T.Metadata },
    { product?: string; model?: T.PriceModel; active?: boolean }
  >;
  readonly customers: Resource<T.Customer, T.CustomerCreateParams, T.CustomerCreateParams, { email?: string; external_id?: string }>;
  readonly subscriptions: Subscriptions;
  readonly paymentLinks: Resource<
    T.PaymentLink,
    T.PaymentLinkCreateParams,
    Partial<Omit<T.PaymentLinkCreateParams, "price" | "slug">> & { active?: boolean },
    { active?: boolean; price?: string }
  >;
  readonly coupons: Resource<
    T.Coupon,
    T.CouponCreateParams,
    { active?: boolean; expires_at?: string | null; max_redemptions?: number | null },
    { active?: boolean; code?: string }
  >;
  readonly entitlements: Entitlements;
  readonly credits: Credits;
  readonly licenseKeys: LicenseKeys;
  readonly portalSessions: { create(params: { customer: string; return_url?: string }, options?: RequestOptions): Promise<T.PortalSession> };
  readonly payments: Resource<T.Payment, never, never, { invoice?: string; asset?: T.Asset }>;
  readonly refunds: Refunds;
  readonly receipts: Receipts;
  readonly events: Resource<T.Event, never, never, { type?: string; object?: string }>;
  readonly webhookEndpoints: WebhookEndpoints;
  readonly webhooks = webhooks;

  constructor(secretKey: string, options: PerlyPayOptions = {}) {
    if (!/^sk_(test|live)_/.test(secretKey ?? "")) throw new Error("Perly Pay needs a secret key: sk_test_… or sk_live_…");
    this.mode = secretKey.startsWith("sk_live_") ? "live" : "test";
    this.baseUrl = (options.baseUrl ?? "https://pay.perly.io").replace(/\/+$/, "");
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) throw new Error("No fetch here: pass options.fetch (Node 18+ has one built in).");
    const http = new Http({
      secretKey,
      baseUrl: `${this.baseUrl}/api/v1`,
      maxRetries: options.maxRetries ?? 2,
      timeoutMs: options.timeoutMs ?? 30_000,
      fetch: fetchImpl,
    });
    this.invoices = new Invoices(http, "/invoices");
    this.checkoutSessions = new CheckoutSessions(http, "/checkout_sessions");
    this.products = new Resource(http, "/products");
    this.prices = new Resource(http, "/prices");
    this.customers = new Resource(http, "/customers");
    this.subscriptions = new Subscriptions(http, "/subscriptions");
    this.paymentLinks = new Resource(http, "/payment_links");
    this.coupons = new Resource(http, "/coupons");
    this.entitlements = new Entitlements(http, "/entitlements");
    this.credits = new Credits(http);
    this.licenseKeys = new LicenseKeys(http, "/license_keys");
    this.portalSessions = {
      create: (params, options) => http.request<T.PortalSession>("POST", "/portal_sessions", params, undefined, options),
    };
    this.payments = new Resource(http, "/payments");
    this.refunds = new Refunds(http, "/refunds");
    this.receipts = new Receipts(http, "/receipts");
    this.events = new Resource(http, "/events");
    this.webhookEndpoints = new WebhookEndpoints(http, "/webhook_endpoints");
  }

  static readonly VERSION = SDK_VERSION;
}

/**
 * License checks from YOUR app (a desktop app, a plugin, a CLI) — no
 * secret key, only the buyer's license key. Never ship a secret key in an app.
 *
 *   const licenses = new LicenseClient();
 *   const { valid } = await licenses.activate({ key, product: "prod_…", instance_name: os.hostname() });
 */
export class LicenseClient {
  private readonly http: Http;
  constructor(options: Omit<PerlyPayOptions, "maxRetries"> & { maxRetries?: number } = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) throw new Error("No fetch here: pass options.fetch.");
    this.http = new Http({
      secretKey: "",
      baseUrl: `${(options.baseUrl ?? "https://pay.perly.io").replace(/\/+$/, "")}/api/v1`,
      maxRetries: options.maxRetries ?? 2,
      timeoutMs: options.timeoutMs ?? 15_000,
      fetch: fetchImpl,
    });
  }
  validate(params: T.LicenseScope & { instance?: string; instance_name?: string }) {
    return this.http.request<T.LicenseCheck>("POST", "/license_keys/validate", params);
  }
  activate(params: T.LicenseScope & { instance_name: string }) {
    return this.http.request<T.LicenseCheck>("POST", "/license_keys/activate", params);
  }
  deactivate(params: T.LicenseScope & ({ instance: string } | { instance_name: string })) {
    return this.http.request<T.LicenseCheck>("POST", "/license_keys/deactivate", params);
  }
}

export default PerlyPay;
