import { ensure } from "./errors";
import { configuration } from "./config";
const base = "https://api-m.sandbox.paypal.com";
type Merchant = {
  clientId: string;
  secret: string;
  merchantId: string;
  webhookId?: string;
  monthlyPlans?: Record<string, string>;
};
export function merchant(profile: string): Merchant {
  ensure(
    configuration().payments === "sandbox" && configuration().providerActions,
    "PROVIDER_DISABLED",
    "PayPal sandbox actions require explicit configuration and authorization.",
    503,
  );
  let profiles: Record<string, Merchant>;
  try {
    profiles = JSON.parse(process.env.PAYPAL_MERCHANTS_JSON || "{}");
  } catch {
    throw new Error("Invalid merchant configuration.");
  }
  const m = profiles[profile];
  ensure(
    m?.clientId && m.secret && m.merchantId,
    "MERCHANT_CONFIG",
    "This merchant profile is not configured.",
    503,
  );
  return m;
}
async function token(profile: string) {
  const m = merchant(profile);
  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${m.clientId}:${m.secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10000),
  });
  ensure(
    response.ok,
    "PAYPAL_AUTH",
    "PayPal sandbox authentication failed.",
    502,
  );
  const body = await response.json();
  ensure(
    typeof body.access_token === "string",
    "PAYPAL_AUTH",
    "PayPal returned no token.",
    502,
  );
  return body.access_token as string;
}
export async function paypal(
  profile: string,
  path: string,
  method = "GET",
  body?: unknown,
  requestId?: string,
): Promise<Record<string, unknown>> {
  ensure(
    /^\/v[12]\/[a-z0-9/_.-]+$/i.test(path),
    "PROVIDER_PATH",
    "Invalid PayPal resource path.",
  );
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token(profile)}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  ensure(
    response.ok,
    "PAYPAL_RESPONSE",
    `PayPal sandbox returned HTTP ${response.status}. The operation may require reconciliation.`,
    502,
  );
  if (response.status === 204) return {};
  return await response.json();
}
export const decimal = (cents: number) => (cents / 100).toFixed(2);
export function approvalLink(data: Record<string, unknown>) {
  const links = data.links as { rel: string; href: string }[] | undefined;
  const link = links?.find((l) =>
    ["approve", "payer-action"].includes(l.rel),
  )?.href;
  ensure(
    link && new URL(link).hostname === "www.sandbox.paypal.com",
    "APPROVAL_LINK",
    "PayPal did not provide a sandbox approval link.",
    502,
  );
  return link;
}
export async function verifyEvent(
  profile: string,
  headers: Headers,
  event: unknown,
) {
  const m = merchant(profile);
  ensure(
    m.webhookId,
    "WEBHOOK_CONFIG",
    "Configure this merchant webhook ID.",
    503,
  );
  const fields = [
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time",
  ];
  for (const field of fields)
    ensure(
      headers.get(field),
      "WEBHOOK_SIGNATURE",
      "Missing webhook signature.",
      401,
    );
  const cert = new URL(headers.get("paypal-cert-url")!);
  ensure(
    cert.protocol === "https:" && cert.hostname === "api.sandbox.paypal.com",
    "WEBHOOK_CERT",
    "Unexpected certificate origin.",
    401,
  );
  const result = await paypal(
    profile,
    "/v1/notifications/verify-webhook-signature",
    "POST",
    {
      auth_algo: headers.get(fields[0]),
      cert_url: cert.href,
      transmission_id: headers.get(fields[2]),
      transmission_sig: headers.get(fields[3]),
      transmission_time: headers.get(fields[4]),
      webhook_id: m.webhookId,
      webhook_event: event,
    },
  );
  ensure(
    result.verification_status === "SUCCESS",
    "WEBHOOK_SIGNATURE",
    "PayPal could not verify this event.",
    401,
  );
}
