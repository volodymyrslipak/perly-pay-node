/**
 * The code `npx perly-pay init` writes. Pure: a project and what is sold
 * in, a list of files out. Each framework gets the same three things —
 *
 *   a core module   PLANS, createCheckout(), handleWebhook(), grantAccess() (the TODO)
 *   two routes      POST …/perly-pay/checkout → 303 to the invoice's page;
 *                   POST …/perly-pay/webhook  → Perly-Signature checked on the raw body
 *   a button        GET /perly-pay (or a <PayButton/> in Next.js): a form that posts to checkout
 *
 * One flow for one-off sales and for credits: an invoice with an `amount`
 * and the plan in its metadata, read back from `invoice.fulfilled`.
 */
import type { CodeStyle, Project } from "./detect.js";
import { API_VAR, KEY_VAR, WEBHOOK_SECRET_VAR } from "./env.js";

export interface Offer {
  /** What the one-off plan is called on the invoice. */
  product: string;
  /** Integer minor units: 2000 = $20.00. */
  amount: number;
  currency: "USD" | "EUR";
}

export const DEFAULT_OFFER: Offer = { product: "My service", amount: 2000, currency: "USD" };

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface Plan {
  files: GeneratedFile[];
  /** Path the buyer's form posts to. */
  checkoutPath: string;
  /** Path Perly Pay posts events to. */
  webhookPath: string;
  /** A page with the button, to try it. */
  buttonPath: string;
  /** How to wire the routes in, when the CLI cannot. */
  mount: string | null;
}

const HEADER = "Written by `npx perly-pay init`. Docs: https://pay.perly.io/docs/quick-start-npx";

const str = (s: string) => JSON.stringify(s);

/** A plain-English amount for comments: "$20.00", "€9.50". */
export function formatAmount(offer: Pick<Offer, "amount" | "currency">): string {
  const sign = offer.currency === "EUR" ? "€" : "$";
  const whole = Math.floor(offer.amount / 100);
  const cents = String(offer.amount % 100).padStart(2, "0");
  return `${sign}${whole}.${cents}`;
}

function plansLiteral(offer: Offer, indent = "  "): string {
  const credits = { product: "100 credits", amount: 1000, currency: offer.currency };
  return [
    `${indent}one_off: { description: ${str(offer.product)}, amount: ${offer.amount}, currency: ${str(offer.currency)}, credits: 0 }, // ${formatAmount(offer)}`,
    `${indent}credits_100: { description: ${str(credits.product)}, amount: ${credits.amount}, currency: ${str(credits.currency)}, credits: 100 }, // ${formatAmount(credits)}`,
  ].join("\n");
}

// ── the core module (all JavaScript frameworks) ───────────────────

function coreModule(style: CodeStyle, offer: Offer): string {
  const ts = style === "ts";
  const t = (typed: string, plain = "") => (ts ? typed : plain);
  const exp = style === "cjs" ? "" : "export ";

  const imports =
    style === "ts"
      ? `import { PerlyPay, SignatureVerificationError, verifyWebhook, type Event, type Invoice } from "perly-pay";`
      : style === "esm"
        ? `import { PerlyPay, SignatureVerificationError, verifyWebhook } from "perly-pay";`
        : `// perly-pay is an ES module; CommonJS loads it with import().\nlet sdk;\nconst loadSdk = () => (sdk ??= import("perly-pay"));`;

  const client =
    style === "cjs"
      ? `let client;

/** The API client: ${KEY_VAR} is sk_test_… in test mode, sk_live_… once you go live. */
async function payClient() {
  const { PerlyPay } = await loadSdk();
  client ??= new PerlyPay(process.env.${KEY_VAR} ?? "", process.env.${API_VAR} ? { baseUrl: process.env.${API_VAR} } : {});
  return client;
}`
      : `let client${t(": PerlyPay | undefined")};

/** The API client: ${KEY_VAR} is sk_test_… in test mode, sk_live_… once you go live. */
${exp}function payClient()${t(": PerlyPay")} {
  client ??= new PerlyPay(process.env.${KEY_VAR} ?? "", process.env.${API_VAR} ? { baseUrl: process.env.${API_VAR} } : {});
  return client;
}`;

  const pay = style === "cjs" ? "(await payClient())" : "payClient()";
  const verifyImport = style === "cjs" ? `\n  const { SignatureVerificationError, verifyWebhook } = await loadSdk();` : "";

  const body = `/**
 * Perly Pay: crypto payments straight to your wallet. Server-only — it reads your secret key.
 * ${HEADER}
 */
${imports}

/** What you sell. Amounts are integers in cents. A plan with credits > 0 is a credit pack. */
${exp}const PLANS = {
${plansLiteral(offer)}
}${t(" as const")};

${ts ? "export type PlanId = keyof typeof PLANS;\n\n" : ""}${client}

/**
 * Opens an invoice for a plan. Send the buyer to \`invoice.url\`: they pay in bitcoin or a
 * stablecoin there, straight to your wallet. \`user\` is your id for them, read back in grantAccess.
 */
${exp}async function createCheckout(plan${t(": string")}, options${t(": { returnUrl: string; user?: string | undefined; email?: string | undefined }")})${t(": Promise<Invoice>")} {
  const id${t(": PlanId")} = Object.prototype.hasOwnProperty.call(PLANS, plan) ? ${ts ? "(plan as PlanId)" : "plan"} : "one_off";
  const { description, amount, currency, credits } = PLANS[id];
  return ${pay}.invoices.create({
    amount,
    currency,
    description,
    ...(options.email ? { customer: { email: options.email } } : {}),
    return_url: options.returnUrl,
    metadata: { plan: id, credits: String(credits), ...(options.user ? { user: options.user } : {}) },
  });
}

/**
 * A payment is complete: paid in full and its sender screened (\`invoice.fulfilled\`).
 * TODO: grant access here — mark the order paid, unlock the feature, or add \`credits\` to \`user\`.
 * A delivery is retried until you answer 2xx, so make this idempotent: remember \`invoice.id\`.
 */
${exp}async function grantAccess(invoice${t(": Invoice")})${t(": Promise<void>")} {
  const { plan, credits, user } = invoice.metadata;
  console.log(\`[perly-pay] \${invoice.id} fulfilled: plan=\${plan} credits=\${credits} user=\${user ?? "-"}\`);
}

/**
 * Checks Perly-Signature on the RAW body (not parsed JSON), then hands a completed payment
 * to grantAccess. Returns what to answer: 204 when done, 400 for a forged or stale request.
 */
${exp}async function handleWebhook(rawBody${t(": string | Uint8Array")}, signature${t(": string | null | undefined")})${t(": Promise<{ status: number; body: string }>")} {
  const secret = process.env.${WEBHOOK_SECRET_VAR};
  if (!secret) return { status: 500, body: "${WEBHOOK_SECRET_VAR} is not set." };${verifyImport}
  let event${t(": Event")};
  try {
    event = verifyWebhook(rawBody, signature, secret);
  } catch (error) {
    if (error instanceof SignatureVerificationError) return { status: 400, body: error.message };
    throw error;
  }
  if (event.type === "invoice.fulfilled") await grantAccess(event.data.object${t(" as Invoice")});
  return { status: 204, body: "" };
}
`;
  return style === "cjs" ? `${body}\nmodule.exports = { PLANS, payClient, createCheckout, grantAccess, handleWebhook };\n` : body;
}

/** The little page every non-Next framework serves at GET /perly-pay. */
function buttonHtml(checkoutPath: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pay</title>
<form method="post" action="${checkoutPath}">
  <input type="hidden" name="plan" value="one_off">
  <button type="submit">Pay with crypto</button>
</form>`;
}

const ext = (style: CodeStyle) => (style === "ts" ? "ts" : "js");

// ── Next.js (App Router) ──────────────────────────────────────────

function nextFiles(project: Project, offer: Offer): Plan {
  const ts = project.style === "ts";
  const e = ts ? "ts" : "js";
  const lib = `${project.base}lib/perly-pay.${e}`;
  // app/api/perly-pay/<x>/route.ts → lib/perly-pay, the same depth with or without src/.
  const fromRoute = "../../../../lib/perly-pay";
  const checkout = `import { createCheckout } from "${fromRoute}";

/** POST from <PayButton/>: opens an invoice and sends the buyer to pay it. */
export async function POST(request${ts ? ": Request" : ""}) {
  const form = await request.formData();
  const invoice = await createCheckout(String(form.get("plan") ?? "one_off"), {
    user: form.get("user")?.toString() || undefined,
    returnUrl: new URL("/", request.url).toString(),
  });
  return Response.redirect(invoice.url, 303);
}
`;
  const webhook = `import { handleWebhook } from "${fromRoute}";

/** Perly Pay posts signed events here: add this URL in Dashboard → Developers → Webhooks. */
export async function POST(request${ts ? ": Request" : ""}) {
  const { status, body } = await handleWebhook(await request.text(), request.headers.get("perly-signature"));
  return new Response(body || null, { status });
}
`;
  const button = ts
    ? `import type { ReactNode } from "react";

/** A buy button: posts to /api/perly-pay/checkout, which sends the buyer to Perly Pay's checkout. */
export function PayButton({ plan = "one_off", user, children = "Pay with crypto" }: { plan?: string; user?: string; children?: ReactNode }) {
  return (
    <form action="/api/perly-pay/checkout" method="post">
      <input type="hidden" name="plan" value={plan} />
      {user ? <input type="hidden" name="user" value={user} /> : null}
      <button type="submit">{children}</button>
    </form>
  );
}
`
    : `/** A buy button: posts to /api/perly-pay/checkout, which sends the buyer to Perly Pay's checkout. */
export function PayButton({ plan = "one_off", user, children = "Pay with crypto" }) {
  return (
    <form action="/api/perly-pay/checkout" method="post">
      <input type="hidden" name="plan" value={plan} />
      {user ? <input type="hidden" name="user" value={user} /> : null}
      <button type="submit">{children}</button>
    </form>
  );
}
`;
  const page = `import { PayButton } from "../../components/PayButton";

/** /perly-pay: try a payment. Put <PayButton/> on your own pages and delete this one. */
export default function Page() {
  return <PayButton />;
}
`;
  return {
    files: [
      { path: lib, content: coreModule(project.style === "cjs" ? "esm" : project.style, offer) },
      { path: `${project.appDir}/api/perly-pay/checkout/route.${e}`, content: checkout },
      { path: `${project.appDir}/api/perly-pay/webhook/route.${e}`, content: webhook },
      { path: `${project.base}components/PayButton.${ts ? "tsx" : "jsx"}`, content: button },
      { path: `${project.appDir}/perly-pay/page.${ts ? "tsx" : "jsx"}`, content: page },
    ],
    checkoutPath: "/api/perly-pay/checkout",
    webhookPath: "/api/perly-pay/webhook",
    buttonPath: "/perly-pay",
    mount: null,
  };
}

// ── Express ───────────────────────────────────────────────────────

function expressFiles(project: Project, offer: Offer): Plan {
  const s = project.style;
  const head =
    s === "cjs"
      ? `const express = require("express");\nconst { createCheckout, handleWebhook } = require("../lib/perly-pay.js");`
      : `import express from "express";\nimport { createCheckout, handleWebhook } from "../lib/perly-pay.js";`;
  const exp = s === "cjs" ? "" : "export ";
  const routes = `/**
 * Perly Pay's routes. Mount them BEFORE express.json(), so the webhook gets the raw body:
 *   app.use(perlyPayRouter);
 * ${HEADER}
 */
${head}

${exp}const perlyPayRouter = express.Router();

/** Try it: a page with the button. */
perlyPayRouter.get("/perly-pay", (_req, res) => {
  res.type("html").send(${str(buttonHtml("/perly-pay/checkout"))});
});

/** The button posts here: an invoice is opened and the buyer goes to pay it. */
perlyPayRouter.post("/perly-pay/checkout", express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const invoice = await createCheckout(String(req.body?.plan ?? "one_off"), {
      user: req.body?.user || undefined,
      returnUrl: \`\${req.protocol}://\${req.get("host")}/\`,
    });
    res.redirect(303, invoice.url);
  } catch (error) {
    next(error);
  }
});

/** Perly Pay posts signed events here: add this URL in Dashboard → Developers → Webhooks. */
perlyPayRouter.post("/perly-pay/webhook", express.raw({ type: "*/*" }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      res.status(500).send("Mount perlyPayRouter before express.json(): the webhook needs the raw body.");
      return;
    }
    const { status, body } = await handleWebhook(req.body, req.get("perly-signature"));
    res.status(status).send(body);
  } catch (error) {
    next(error);
  }
});
${s === "cjs" ? "\nmodule.exports = { perlyPayRouter };\n" : ""}`;
  const routesPath = `${project.base}routes/perly-pay.${ext(s)}`;
  const importLine =
    s === "cjs" ? `const { perlyPayRouter } = require("./routes/perly-pay.js");` : `import { perlyPayRouter } from "./routes/perly-pay.js";`;
  return {
    files: [
      { path: `${project.base}lib/perly-pay.${ext(s)}`, content: coreModule(s, offer) },
      { path: routesPath, content: routes },
    ],
    checkoutPath: "/perly-pay/checkout",
    webhookPath: "/perly-pay/webhook",
    buttonPath: "/perly-pay",
    mount: `${importLine}\napp.use(perlyPayRouter); // before app.use(express.json())`,
  };
}

// ── Hono ──────────────────────────────────────────────────────────

function honoFiles(project: Project, offer: Offer): Plan {
  const s = project.style;
  const head =
    s === "cjs"
      ? `const { Hono } = require("hono");\nconst { createCheckout, handleWebhook } = require("../lib/perly-pay.js");`
      : `import { Hono } from "hono";\nimport { createCheckout, handleWebhook } from "../lib/perly-pay.js";`;
  const exp = s === "cjs" ? "" : "export ";
  const routes = `/**
 * Perly Pay's routes: app.route("/", perlyPayRoutes);
 * ${HEADER}
 */
${head}

${exp}const perlyPayRoutes = new Hono();

/** Try it: a page with the button. */
perlyPayRoutes.get("/perly-pay", (c) => c.html(${str(buttonHtml("/perly-pay/checkout"))}));

/** The button posts here: an invoice is opened and the buyer goes to pay it. */
perlyPayRoutes.post("/perly-pay/checkout", async (c) => {
  const form = await c.req.parseBody();
  const invoice = await createCheckout(String(form.plan ?? "one_off"), {
    user: typeof form.user === "string" && form.user ? form.user : undefined,
    returnUrl: new URL("/", c.req.url).toString(),
  });
  return c.redirect(invoice.url, 303);
});

/** Perly Pay posts signed events here: add this URL in Dashboard → Developers → Webhooks. */
perlyPayRoutes.post("/perly-pay/webhook", async (c) => {
  const { status, body } = await handleWebhook(await c.req.text(), c.req.header("perly-signature"));
  return new Response(body || null, { status });
});
${s === "cjs" ? "\nmodule.exports = { perlyPayRoutes };\n" : ""}`;
  const importLine =
    s === "cjs" ? `const { perlyPayRoutes } = require("./routes/perly-pay.js");` : `import { perlyPayRoutes } from "./routes/perly-pay.js";`;
  return {
    files: [
      { path: `${project.base}lib/perly-pay.${ext(s)}`, content: coreModule(s, offer) },
      { path: `${project.base}routes/perly-pay.${ext(s)}`, content: routes },
    ],
    checkoutPath: "/perly-pay/checkout",
    webhookPath: "/perly-pay/webhook",
    buttonPath: "/perly-pay",
    mount: `${importLine}\napp.route("/", perlyPayRoutes);`,
  };
}

// ── plain Node (node:http) ────────────────────────────────────────

function nodeFiles(project: Project, offer: Offer): Plan {
  const s = project.style;
  const ts = s === "ts";
  const t = (typed: string) => (ts ? typed : "");
  const head =
    s === "ts"
      ? `import type { IncomingMessage, ServerResponse } from "node:http";\nimport { createCheckout, handleWebhook } from "./lib/perly-pay.js";`
      : s === "esm"
        ? `import { createCheckout, handleWebhook } from "./lib/perly-pay.js";`
        : `const { createCheckout, handleWebhook } = require("./lib/perly-pay.js");`;
  const exp = s === "cjs" ? "" : "export ";
  const handler = `/**
 * Perly Pay's routes for a node:http server. First thing in your request handler:
 *   if (await perlyPayHandler(req, res)) return;
 * ${HEADER}
 */
${head}

const PAGE = ${str(buttonHtml("/perly-pay/checkout"))};

function readBody(req${t(": IncomingMessage")})${t(": Promise<Buffer>")} {
  return new Promise((resolve, reject) => {
    const chunks${t(": Buffer[]")} = [];
    req.on("data", (chunk${t(": Buffer")}) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Answers /perly-pay, /perly-pay/checkout and /perly-pay/webhook; false for anything else. */
${exp}async function perlyPayHandler(req${t(": IncomingMessage")}, res${t(": ServerResponse")})${t(": Promise<boolean>")} {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "GET" && path === "/perly-pay") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    return true;
  }
  if (req.method !== "POST" || (path !== "/perly-pay/checkout" && path !== "/perly-pay/webhook")) return false;
  const raw = await readBody(req);
  if (path === "/perly-pay/webhook") {
    // Perly Pay posts signed events here: add this URL in Dashboard → Developers → Webhooks.
    const signature = req.headers["perly-signature"];
    const { status, body } = await handleWebhook(raw, Array.isArray(signature) ? signature[0] : signature);
    res.writeHead(status).end(body);
    return true;
  }
  const form = new URLSearchParams(raw.toString("utf8"));
  const invoice = await createCheckout(form.get("plan") ?? "one_off", {
    user: form.get("user") || undefined,
    returnUrl: \`http://\${req.headers.host ?? "localhost"}/\`,
  });
  res.writeHead(303, { Location: invoice.url }).end();
  return true;
}
${s === "cjs" ? "\nmodule.exports = { perlyPayHandler };\n" : ""}`;
  const importLine =
    s === "cjs" ? `const { perlyPayHandler } = require("./perly-pay.js");` : `import { perlyPayHandler } from "./perly-pay.js";`;
  return {
    files: [
      { path: `${project.base}lib/perly-pay.${ext(s)}`, content: coreModule(s, offer) },
      { path: `${project.base}perly-pay.${ext(s)}`, content: handler },
    ],
    checkoutPath: "/perly-pay/checkout",
    webhookPath: "/perly-pay/webhook",
    buttonPath: "/perly-pay",
    mount: `${importLine}\n// in http.createServer(async (req, res) => { … }):\nif (await perlyPayHandler(req, res)) return;`,
  };
}

// ── Laravel (PHP SDK) ─────────────────────────────────────────────

const php = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function laravelFiles(offer: Offer): Plan {
  const config = `<?php

// Perly Pay. ${HEADER}
return [
    'secret_key' => env('${KEY_VAR}'),
    'webhook_secret' => env('${WEBHOOK_SECRET_VAR}'),
    'api' => env('${API_VAR}'),
];
`;
  const controller = `<?php

namespace App\\Http\\Controllers;

use Illuminate\\Http\\Request;
use Perly\\Pay\\Exception\\SignatureVerificationException;
use Perly\\Pay\\PerlyPay;
use Perly\\Pay\\Webhook;

/**
 * Perly Pay: crypto payments straight to your wallet.
 * ${HEADER}
 */
class PerlyPayController extends Controller
{
    /** What you sell. Amounts are integers in cents. A plan with credits > 0 is a credit pack. */
    private const PLANS = [
        'one_off' => ['description' => ${php(offer.product)}, 'amount' => ${offer.amount}, 'currency' => '${offer.currency}', 'credits' => 0], // ${formatAmount(offer)}
        'credits_100' => ['description' => '100 credits', 'amount' => 1000, 'currency' => '${offer.currency}', 'credits' => 100],
    ];

    /** Try it: a page with the button. */
    public function button()
    {
        return view('perly-pay.button');
    }

    /** The button posts here: an invoice is opened and the buyer goes to pay it. */
    public function checkout(Request $request)
    {
        $planId = (string) $request->input('plan', 'one_off');
        if (! array_key_exists($planId, self::PLANS)) {
            $planId = 'one_off';
        }
        $plan = self::PLANS[$planId];
        $metadata = ['plan' => $planId, 'credits' => (string) $plan['credits']];
        if ($request->filled('user')) {
            $metadata['user'] = (string) $request->input('user');
        }
        $invoice = $this->client()->invoices->create([
            'amount' => $plan['amount'],
            'currency' => $plan['currency'],
            'description' => $plan['description'],
            'return_url' => url('/'),
            'metadata' => $metadata,
        ]);

        return redirect()->away($invoice['url'], 303);
    }

    /** Perly Pay posts signed events here: add this URL in Dashboard → Developers → Webhooks. */
    public function webhook(Request $request)
    {
        $secret = (string) config('perly-pay.webhook_secret');
        if ($secret === '') {
            return response('${WEBHOOK_SECRET_VAR} is not set.', 500);
        }
        try {
            // The RAW body, not the parsed request.
            $event = Webhook::verify($request->getContent(), $request->header('Perly-Signature'), $secret);
        } catch (SignatureVerificationException $e) {
            return response($e->getMessage(), 400);
        }
        if (($event['type'] ?? '') === 'invoice.fulfilled') {
            $this->grantAccess($event['data']['object']);
        }

        return response()->noContent();
    }

    /**
     * A payment is complete: paid in full and its sender screened (invoice.fulfilled).
     * TODO: grant access here — mark the order paid, unlock the feature, or add credits to the user.
     * A delivery is retried until you answer 2xx, so make this idempotent: remember $invoice['id'].
     */
    private function grantAccess(array $invoice): void
    {
        $meta = $invoice['metadata'] ?? [];
        logger()->info('[perly-pay] '.$invoice['id'].' fulfilled', $meta);
    }

    private function client(): PerlyPay
    {
        $api = config('perly-pay.api');

        return new PerlyPay((string) config('perly-pay.secret_key'), $api ? ['base_url' => $api] : []);
    }
}
`;
  const routes = `<?php

// Perly Pay's routes. Load them from routes/web.php:  require __DIR__.'/perly-pay.php';
// ${HEADER}

use App\\Http\\Controllers\\PerlyPayController;
use Illuminate\\Support\\Facades\\Route;

Route::get('/perly-pay', [PerlyPayController::class, 'button']);
Route::post('/perly-pay/checkout', [PerlyPayController::class, 'checkout']);
// Perly Pay signs its webhooks (Perly-Signature); a CSRF token cannot apply to them.
Route::post('/perly-pay/webhook', [PerlyPayController::class, 'webhook'])->withoutMiddleware([
    'Illuminate\\Foundation\\Http\\Middleware\\ValidateCsrfToken',
    'Illuminate\\Foundation\\Http\\Middleware\\VerifyCsrfToken',
    'App\\Http\\Middleware\\VerifyCsrfToken',
]);
`;
  const view = `{{-- A buy button: @include('perly-pay.button') on any page. Posts to /perly-pay/checkout, which sends the buyer to Perly Pay. --}}
<form method="POST" action="{{ url('/perly-pay/checkout') }}">
    @csrf
    <input type="hidden" name="plan" value="{{ $plan ?? 'one_off' }}">
    @isset($user)<input type="hidden" name="user" value="{{ $user }}">@endisset
    <button type="submit">Pay with crypto</button>
</form>
`;
  return {
    files: [
      { path: "config/perly-pay.php", content: config },
      { path: "app/Http/Controllers/PerlyPayController.php", content: controller },
      { path: "routes/perly-pay.php", content: routes },
      { path: "resources/views/perly-pay/button.blade.php", content: view },
    ],
    checkoutPath: "/perly-pay/checkout",
    webhookPath: "/perly-pay/webhook",
    buttonPath: "/perly-pay",
    mount: `// routes/web.php\nrequire __DIR__.'/perly-pay.php';`,
  };
}

export function planFiles(project: Project, offer: Offer = DEFAULT_OFFER): Plan {
  switch (project.framework) {
    case "next":
      return nextFiles(project, offer);
    case "express":
      return expressFiles(project, offer);
    case "hono":
      return honoFiles(project, offer);
    case "laravel":
      return laravelFiles(offer);
    default:
      return nodeFiles(project, offer);
  }
}
