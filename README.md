# perly-pay

Crypto payments straight to your wallet — bitcoin and dollar stablecoins,
0% of volume. The server SDK for the [Perly Pay API](https://pay.perly.io/docs/api).

- TypeScript, **zero dependencies**, plain `fetch` (Node 18+, Deno, Bun, workers, edge)
- every POST carries an **Idempotency-Key**, reused across retries
- retries on 429 / 5xx / network errors with backoff, honouring `Retry-After`
- `webhooks.verify` checks `Perly-Signature` in constant time, synchronously

## Five minutes

**1. Install and make a client** with your secret key (Dashboard → Developers).
A `sk_test_…` key works in test mode: test networks, nothing real moves.

```bash
npm install perly-pay
```

```ts
import { PerlyPay } from "perly-pay";

const pay = new PerlyPay(process.env.PERLY_PAY_SECRET_KEY!);
```

**2. Sell something.**

```ts
const product = await pay.products.create({ name: "Pro plan" });
const price = await pay.prices.create({
  product: product.id,
  model: "one_time",
  unit_amount: 4900, // $49.00 — always integers, in cents
});
```

**3. Take a payment.** Make a checkout session and send the buyer to its `url`
(or open it over your page with [pay.js](#on-your-page)).

```ts
const session = await pay.checkoutSessions.create({
  line_items: [{ price: price.id, quantity: 1 }],
  return_url: "https://shop.example/thanks",
});
redirect(session.url);
```

The buyer picks bitcoin or USDC/USDT, pays from any wallet, and the money lands
in **your** wallet. Perly Pay never holds it.

**4. Hear about it.** Add an endpoint once and keep its secret:

```ts
const endpoint = await pay.webhookEndpoints.create({
  url: "https://shop.example/webhooks/perly",
  enabled_events: ["invoice.paid", "invoice.fulfilled", "refund.confirmed"],
});
// endpoint.secret — "whsec_…", shown only now
```

Then verify every delivery on the **raw** body:

```ts
// Next.js route handler
export async function POST(request: Request) {
  const raw = await request.text();
  const event = pay.webhooks.verify(raw, request.headers.get("perly-signature"), process.env.PERLY_PAY_WEBHOOK_SECRET!);
  if (event.type === "invoice.fulfilled") await grantAccess(event.object_id);
  return new Response(null, { status: 204 });
}
```

A signature older than five minutes is refused (replays), and any change to the body breaks it.
With Express, take the raw bytes: `express.raw({ type: "application/json" })`, then `pay.webhooks.verify(req.body, req.header("Perly-Signature"), secret)`.

**5. Try it without a wallet** (test keys only):

```ts
const invoice = await pay.invoices.create({ line_items: [{ price: price.id }], customer_email: "ada@example.com" });
await pay.invoices.simulate(invoice.id); // paid, fulfilled, receipt, webhooks ({ outcome: "short" | "over" } too)
```

## More

```ts
// Does this customer have access right now?
const { has_access } = await pay.entitlements.check({ customer_email: "ada@example.com", product: product.id });

// Subscriptions renew by invoice — no auto-debit.
const sub = await pay.subscriptions.create({ customer: "cus_…", price: "price_…" });
await pay.subscriptions.update(sub.id, { cancel_at_period_end: true });

// Refunds are non-custodial: the buyer gives an address, you send from your wallet.
const quote = await pay.refunds.quote({ invoice: invoice.id });
const refund = await pay.refunds.create({ invoice: invoice.id });
// …when refund.status is "ready_to_send", send refund.amount_to_send to refund.refund_address, then:
await pay.refunds.markSent(refund.id, { txid: "0x…" });

// Every page of a list
for await (const inv of pay.invoices.listAll({ status: "paid", limit: 100 })) console.log(inv.id);

// A receipt as PDF
const pdf = await pay.receipts.pdf("rcpt_…");
```

### Credits

Sell credits for an API or an AI service: the buyer tops up on their own page and pays — never an auto-debit — and your server spends them a call at a time. The customer is a `cus_…` id, an email, or your own id for them (`external_id`).

```ts
const { balance, low, top_up_url } = await pay.credits.balance("user_42");

// Never below zero; a retry with the same key never spends twice.
try {
  await pay.credits.consume("user_42", 3, { action: "chat", idempotencyKey: requestId });
} catch (e) {
  if (e instanceof InvalidRequestError && e.code === "insufficient_credits") return sendTopUp(await pay.credits.topUpUrl("user_42"));
  throw e;
}
```

Webhooks `credits.low` (the product's threshold, set in the dashboard) and `credits.depleted` arrive once per crossing.

### License keys from your app

Your app never holds a secret key. `LicenseClient` calls the public license endpoints with the buyer's key alone:

```ts
import { LicenseClient } from "perly-pay";

const licenses = new LicenseClient();
const result = await licenses.activate({ key: userKey, product: "prod_…", instance_name: os.hostname() });
if (!result.valid) showWhy(result.reason); // "limit_reached", "revoked", "expired", …
```

## Errors

Every failure throws a `PerlyPayError` (`InvalidRequestError`, `AuthenticationError`,
`PermissionError`, `RateLimitError`, `IdempotencyError`, `APIError`, `ConnectionError`) carrying the
API's `type`, `code`, `message`, `param`, the HTTP `status` and the `requestId` to quote to support.

```ts
try {
  await pay.invoices.create({ line_items: [] });
} catch (e) {
  if (e instanceof InvalidRequestError) console.log(e.code, e.param); // "parameter_invalid", "line_items"
}
```

## Amounts

Fiat amounts are integers in minor units (`4900` = $49.00). On-chain amounts are integer **strings** in the
asset's smallest unit (`"10000000"` USDC = 10.00 USDC; satoshis for bitcoin) — use `BigInt`, never floats.

## Options

```ts
new PerlyPay(key, {
  baseUrl: "https://pay.perly.io", // or http://localhost:3200 against a local stack
  maxRetries: 2,
  timeoutMs: 30_000,
  fetch: customFetch,
});
await pay.invoices.create(params, { idempotencyKey: `order-${orderId}` });
```

## Testing your webhook handler

```ts
import { webhooks } from "perly-pay";
const { body, headers } = webhooks.testRequest({ id: "evt_1", type: "invoice.paid", /* … */ }, secret);
await handler(new Request("http://localhost/webhooks", { method: "POST", body, headers }));
```

## On your page

pay.js opens the hosted checkout over your page. Load it pinned, with its
`integrity`, so a changed file never runs on your page:

<!-- pay.js snippet: generated by packages/embed/build.mjs -->
```html
<script src="https://pay.perly.io/pay/v1.999bed6b66c7.js"
  integrity="sha384-mZvta2bHoZN4yW6xg4DvV5Jb9jS7TPg+Pq1Upm5VFEOFdgubm8MmsAYgVHNNW45N"
  crossorigin="anonymous" defer></script>
```
<!-- /pay.js snippet -->

```html
<button data-perly-pay data-session="cs_…">Pay</button>
<script>
  addEventListener("perlypay:paid", (e) => location.assign("/thanks?invoice=" + e.detail.invoice));
</script>
```

Add your site's origin under Dashboard → Settings → Checkout so the checkout may be framed there.

## Links

- Docs: <https://pay.perly.io/docs> · API reference: <https://pay.perly.io/docs/api> · SDKs: <https://pay.perly.io/docs/sdks>
- OpenAPI: <https://pay.perly.io/api/v1/openapi.json>
- PHP: [`perly/perly-pay`](https://pay.perly.io/docs/sdks) on Composer, the same calls and the same webhook check

## Build

`npm run build` (in `packages/sdk`) writes ESM + `.d.ts` to `dist/`. Node 18.17+.

## License

MIT. The SDK is open source; the Perly Pay service it talks to is not.

## Source

This is the source of the `perly-pay` package on npm, copied from Perly Pay's own repository on each release (paths in comments such as `packages/…` refer to that layout). Issues and pull requests are welcome here.
