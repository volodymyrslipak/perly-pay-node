/**
 * The API's objects and parameters, as TypeScript. Mirrors
 * src/services/api/objects.ts (a type test in the app holds them equal).
 *
 * Fiat amounts are integers in minor units (cents) next to a `currency`.
 * On-chain amounts are integer STRINGS in the asset's smallest unit
 * (satoshis; 10⁻⁶ USDC/USDT) next to `decimals`. Times are ISO 8601.
 */

export type Currency = "USD" | "EUR";
/** On `arbitrum` and `optimism`, `USDT` is USDT0 (LayerZero's omnichain USDT): show it as USDT0 there. */
export type Asset = "BTC" | "USDC" | "USDT";
export type PriceModel = "one_time" | "pay_what_you_want" | "fixed_term" | "subscription" | "lifetime" | "credit_pack";
export type BillingInterval = "day" | "week" | "month" | "quarter" | "year" | "custom_days";
export type InvoiceStatus =
  | "open"
  | "seen"
  | "underpaid"
  | "paid"
  | "overpaid"
  | "review"
  | "expired"
  | "canceled"
  | "refunded"
  | "partially_refunded";
export type InvoiceKind = "checkout" | "payment_link" | "subscription" | "manual" | "api" | "plan";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "unpaid" | "paused" | "canceled" | "ended";
export type RefundStatus = "requested" | "awaiting_address" | "ready_to_send" | "sent" | "confirmed" | "canceled";
export type FeePayer = "buyer" | "merchant";
export type LicenseStatus = "active" | "suspended" | "revoked" | "expired";
export type CouponDuration = "once" | "repeating" | "forever";
export type Metadata = Record<string, string>;

export interface List<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ListParams {
  /** 1–100, default 10. */
  limit?: number;
  /** `next_cursor` from the previous page. */
  cursor?: string;
}

export interface Deleted {
  id: string;
  object: string;
  deleted: true;
}

// ── objects ───────────────────────────────────────────────────────

export interface Customer {
  id: string;
  object: "customer";
  livemode: boolean;
  email: string | null;
  name: string | null;
  external_id: string | null;
  country: string | null;
  locale: string | null;
  metadata: Metadata;
  created: string;
}

export interface Product {
  id: string;
  object: "product";
  livemode: boolean;
  name: string;
  description: string | null;
  image_url: string | null;
  issues_license: boolean;
  license_activation_limit: number | null;
  active: boolean;
  metadata: Metadata;
  created: string;
  updated: string;
}

export interface PriceTier {
  id: string;
  position: number;
  name: string;
  seats: number;
  unit_amount: number;
}

export interface Price {
  id: string;
  object: "price";
  livemode: boolean;
  product: string;
  model: PriceModel;
  currency: Currency;
  nickname: string | null;
  active: boolean;
  unit_amount: number | null;
  custom_amount: { minimum: number; suggested: number | null } | null;
  term_days: number | null;
  recurring: {
    interval: BillingInterval;
    interval_days: number | null;
    trial_days: number;
    grace_days: number;
    prepay_max_periods: number;
    keep_renewal_price: boolean;
  } | null;
  lifetime: { quantity_cap: number | null; tiers: PriceTier[] } | null;
  credits: number | null;
  refunds: { allowed: boolean; window_days: number | null; network_fee_payer: FeePayer };
  metadata: Metadata;
  created: string;
}

export interface Coupon {
  id: string;
  object: "coupon";
  livemode: boolean;
  code: string;
  percent_off: number | null;
  amount_off: number | null;
  currency: Currency | null;
  duration: CouponDuration;
  duration_periods: number | null;
  max_redemptions: number | null;
  times_redeemed: number;
  products: string[];
  expires_at: string | null;
  active: boolean;
  created: string;
}

export interface PaymentLink {
  id: string;
  object: "payment_link";
  livemode: boolean;
  url: string;
  slug: string;
  price: string;
  quantity: number;
  adjustable_quantity: boolean;
  allow_coupons: boolean;
  collect_name: boolean;
  success_url: string | null;
  active: boolean;
  metadata: Metadata;
  created: string;
}

export interface CheckoutSessionLine {
  id: string;
  price: string;
  quantity: number;
  custom_amount: number | null;
  unit_amount: number;
  amount: number;
}

export interface CheckoutSession {
  id: string;
  object: "checkout_session";
  livemode: boolean;
  url: string;
  status: "open" | "complete" | "expired";
  currency: Currency;
  line_items: CheckoutSessionLine[];
  subtotal: number;
  discount: number;
  total: number;
  customer: string | null;
  customer_email: string | null;
  coupon: string | null;
  payment_link: string | null;
  return_url: string | null;
  cancel_url: string | null;
  invoice: string | null;
  expires_at: string;
  metadata: Metadata;
  created: string;
}

export interface InvoiceLine {
  id: string;
  price: string | null;
  product: string | null;
  description: string;
  quantity: number;
  unit_amount: number;
  amount: number;
  period_start: string | null;
  period_end: string | null;
}

export interface Invoice {
  id: string;
  object: "invoice";
  livemode: boolean;
  url: string;
  status: InvoiceStatus;
  kind: InvoiceKind;
  number: string | null;
  customer: string | null;
  customer_email: string | null;
  customer_name: string | null;
  description: string | null;
  currency: Currency;
  subtotal: number;
  discount: number;
  total: number;
  total_usd: number;
  received_usd: number;
  pending_usd: number;
  amount_received: string;
  payment: {
    chain: string;
    asset: Asset;
    address: string;
    amount_due: string;
    decimals: number;
    btc_usd_cents: number | null;
    opened_at: string;
    expires_at: string;
  } | null;
  lines: InvoiceLine[];
  subscription: string | null;
  checkout_session: string | null;
  payment_link: string | null;
  coupon: string | null;
  receipt_number: string | null;
  review_reason: string | null;
  due_at: string | null;
  paid_at: string | null;
  fulfilled_at: string | null;
  canceled_at: string | null;
  metadata: Metadata;
  created: string;
}

export interface Subscription {
  id: string;
  object: "subscription";
  livemode: boolean;
  status: SubscriptionStatus;
  customer: string;
  price: string;
  quantity: number;
  current_period_start: string;
  current_period_end: string;
  trial_end: string | null;
  grace_days: number;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  ended_at: string | null;
  paused_at: string | null;
  pending_price: string | null;
  kept_price: number | null;
  latest_invoice: string | null;
  coupon: string | null;
  metadata: Metadata;
  created: string;
}

export interface Entitlement {
  id: string;
  object: "entitlement";
  livemode: boolean;
  active: boolean;
  customer: string | null;
  product: string | null;
  price: string | null;
  model: PriceModel;
  subscription: string | null;
  invoice: string;
  starts_at: string;
  ends_at: string | null;
  credits_total: number | null;
  credits_used: number;
  credits_remaining: number | null;
  tier: string | null;
  seat_number: number | null;
  revoked_at: string | null;
  created: string;
}

export interface CreditBalance {
  object: "credit_balance";
  livemode: boolean;
  customer: string;
  /** Null = every product's credits together. */
  product: string | null;
  balance: number;
  low_balance_threshold: number | null;
  /** At or under the threshold, or zero. */
  low: boolean;
  /** The buyer's own top-up page: stable, safe to email or show in your app. */
  top_up_url: string;
}

export interface CreditUsage {
  id: string;
  object: "credit_usage";
  livemode: boolean;
  customer: string | null;
  product: string | null;
  entitlement: string | null;
  credits: number;
  action: string | null;
  /** What was left right after. */
  balance: number;
  created: string;
}

export interface EntitlementCheck {
  object: "entitlement_check";
  has_access: boolean;
  customer: string | null;
  product: string | null;
  ends_at: string | null;
  credits_remaining: number | null;
  entitlements: Entitlement[];
}

export interface LicenseKey {
  id: string;
  object: "license_key";
  livemode: boolean;
  key: string;
  status: LicenseStatus;
  product: string | null;
  customer: string | null;
  entitlement: string;
  activation_limit: number | null;
  activations: number;
  expires_at: string | null;
  created: string;
}

export interface LicenseActivation {
  id: string;
  instance_name: string;
  active: boolean;
  created: string;
}

export interface LicenseCheck {
  object: "license_check";
  valid: boolean;
  reason: "not_found" | "wrong_product" | "suspended" | "revoked" | "expired" | "limit_reached" | "not_activated" | null;
  license_key: {
    key: string;
    livemode: boolean;
    status: LicenseStatus;
    product: string | null;
    activation_limit: number | null;
    activations: number;
    expires_at: string | null;
  } | null;
  activation: LicenseActivation | null;
}

export interface PortalSession {
  id: string;
  object: "portal_session";
  livemode: boolean;
  customer: string;
  url: string;
  return_url: string | null;
  expires_at: string;
  created: string;
}

export interface Payment {
  id: string;
  object: "payment";
  livemode: boolean;
  invoice: string | null;
  chain: string;
  asset: Asset;
  token: string | null;
  txid: string;
  position: number;
  amount: string;
  decimals: number;
  usd_cents: number | null;
  from_address: string | null;
  to_address: string;
  block_number: number | null;
  confirmations: number;
  arrived_at: string;
  confirmed_at: string | null;
  dropped_at: string | null;
  created: string;
}

export interface Refund {
  id: string;
  object: "refund";
  livemode: boolean;
  invoice: string;
  payment: string | null;
  status: RefundStatus;
  chain: string;
  asset: Asset;
  decimals: number;
  amount: string;
  network_fee: string | null;
  network_fee_payer: FeePayer;
  amount_to_send: string | null;
  reason: string | null;
  refund_address: string | null;
  txid: string | null;
  sent_at: string | null;
  confirmed_at: string | null;
  canceled_at: string | null;
  created: string;
}

export interface RefundQuote {
  object: "refund_quote";
  invoice: string;
  refundable: boolean;
  reason: string | null;
  chain: string | null;
  asset: Asset | null;
  decimals: number | null;
  amount: string | null;
  network_fee: string | null;
  network_fee_payer: FeePayer | null;
  amount_to_send: string | null;
}

export interface Receipt {
  id: string;
  object: "receipt";
  livemode: boolean;
  kind: "payment" | "refund";
  number: string;
  invoice: string;
  refund: string | null;
  url: string;
  pdf: string;
  customer_email: string | null;
  currency: Currency;
  amount: number;
  asset: Asset | null;
  asset_amount: string | null;
  decimals: number | null;
  issued_at: string;
  emailed_at: string | null;
}

export interface Event {
  id: string;
  object: "event";
  livemode: boolean;
  type: string;
  object_type: string;
  object_id: string | null;
  data: Record<string, unknown>;
  created: string;
}

export interface WebhookEndpoint {
  id: string;
  object: "webhook_endpoint";
  livemode: boolean;
  url: string;
  description: string | null;
  enabled_events: string[];
  status: "enabled" | "disabled";
  secret_prefix: string;
  /** Only when created or rolled. */
  secret?: string | undefined;
  created: string;
}

// ── parameters ────────────────────────────────────────────────────

export type InvoiceLineParams =
  | { price: string; quantity?: number; custom_amount?: number; description?: string }
  | { description: string; amount: number; quantity?: number };

/** `line_items`, or one `amount` with its `description` (the API takes either, not both). */
export type InvoiceCreateParams = InvoiceCreateCommon &
  ({ line_items: InvoiceLineParams[]; amount?: never; description?: never } | { amount: number; description: string; line_items?: never });

export interface InvoiceCreateCommon {
  /** For lines without a price. Default: your account's currency. */
  currency?: Currency;
  /** A customer id, or `{ email }` to find or make one. */
  customer?: string | { email: string };
  customer_email?: string;
  coupon?: string;
  /** A one-off amount off this invoice, in minor units (a credit you owe the buyer). Not with `coupon`. */
  discount?: number;
  subscription?: string;
  return_url?: string;
  expires_in_minutes?: number;
  locale?: string;
  metadata?: Metadata;
}

export interface CheckoutSessionCreateParams {
  line_items: { price: string; quantity?: number; custom_amount?: number }[];
  return_url?: string;
  cancel_url?: string;
  customer?: string;
  customer_email?: string;
  coupon?: string;
  expires_in_minutes?: number;
  metadata?: Metadata;
}

export interface ProductCreateParams {
  name: string;
  description?: string;
  image_url?: string;
  issues_license?: boolean;
  license_activation_limit?: number;
  active?: boolean;
  metadata?: Metadata;
}

export interface RefundTerms {
  allowed: boolean;
  window_days?: number | null;
  network_fee_payer?: FeePayer;
}

interface PriceCommon {
  product: string;
  currency?: Currency;
  nickname?: string;
  refunds?: RefundTerms;
  metadata?: Metadata;
}

export type PriceCreateParams =
  | (PriceCommon & { model: "one_time"; unit_amount: number })
  | (PriceCommon & { model: "pay_what_you_want"; custom_amount: { minimum: number; suggested?: number } })
  | (PriceCommon & { model: "fixed_term"; unit_amount: number; term_days: number })
  | (PriceCommon & {
      model: "subscription";
      unit_amount: number;
      recurring: {
        interval: BillingInterval;
        interval_days?: number;
        trial_days?: number;
        grace_days?: number;
        prepay_max_periods?: number;
        keep_renewal_price?: boolean;
      };
    })
  | (PriceCommon & {
      model: "lifetime";
      unit_amount?: number;
      lifetime?: { quantity_cap?: number; tiers?: { name: string; seats: number; unit_amount: number }[] };
    })
  | (PriceCommon & { model: "credit_pack"; unit_amount: number; credits: number });

export interface CustomerCreateParams {
  email?: string;
  name?: string;
  external_id?: string;
  country?: string;
  locale?: string;
  metadata?: Metadata;
}

export interface SubscriptionCreateParams {
  customer: string;
  price: string;
  quantity?: number;
  coupon?: string;
  trial_days?: number;
  metadata?: Metadata;
}

export interface PaymentLinkCreateParams {
  price: string;
  quantity?: number;
  adjustable_quantity?: boolean;
  allow_coupons?: boolean;
  collect_name?: boolean;
  success_url?: string;
  slug?: string;
  metadata?: Metadata;
}

export interface CouponCreateParams {
  code: string;
  percent_off?: number;
  amount_off?: number;
  currency?: Currency;
  duration?: CouponDuration;
  duration_periods?: number;
  max_redemptions?: number;
  products?: string[];
  expires_at?: string;
}

export interface EntitlementCheckParams {
  customer?: string;
  customer_email?: string;
  customer_external_id?: string;
  product?: string;
  price?: string;
}

/**
 * Who holds the credits: a customer id (`cus_…`), an email (has an `@`),
 * or any other string as your own id for them (`external_id`) — or say
 * which with `{ id }`, `{ email }` or `{ external_id }`.
 */
export type CustomerRef = string | { id: string } | { email: string } | { external_id: string };

/** The API's own way to name the customer, for `credits.balance` / `credits.consume`. */
export interface CreditCustomerParams {
  customer?: string;
  customer_email?: string;
  customer_external_id?: string;
}

export interface CreditConsumeParams extends CreditCustomerParams {
  credits: number;
  product?: string;
  action?: string;
}

export interface LicenseScope {
  key: string;
  product?: string;
  merchant?: string;
}

export interface WebhookEndpointCreateParams {
  url: string;
  enabled_events?: string[];
  description?: string;
}
