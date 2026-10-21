type Environment = Record<string, string | undefined>;
type Check = {
  name: string;
  status: "CONFIGURED" | "BLOCKED" | "NOT VERIFIED";
  detail: string;
};
const profiles = ["hope", "river", "harvest", "supply"];
const nonprofits = ["hope", "river"];
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function secureUrl(value: string | undefined) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function providerReadiness(env: Environment) {
  const checks: Check[] = [];
  const configured = (name: string, present: boolean, detail: string) =>
    checks.push({ name, status: present ? "CONFIGURED" : "BLOCKED", detail });
  const unverified = (name: string, detail: string) =>
    checks.push({ name, status: "NOT VERIFIED", detail });

  configured("hostedRuntime", env.APP_ENV === "hosted" || Boolean(env.VERCEL), "Hosted demo target; this check does not change modes.");
  configured("durableStorage", env.STORAGE_MODE === "supabase", "Supabase mode must be selected.");
  configured("supabasePublicConfig", secureUrl(env.NEXT_PUBLIC_SUPABASE_URL) && nonempty(env.NEXT_PUBLIC_SUPABASE_ANON_KEY), "HTTPS project URL and public key required; not Google enablement proof.");
  configured("supabaseServerKey", nonempty(env.SUPABASE_SERVICE_ROLE_KEY), "Server-only key required; validity and access not tested.");
  configured("strongSessions", (env.SESSION_SECRET || "").trim().length >= 32, "At least 32 non-padding characters; randomness not verified.");
  configured("hostedAppUrl", secureUrl(env.APP_URL), "HTTPS application URL without embedded credentials required.");
  configured("paypalSandbox", env.PAYMENTS_MODE === "sandbox", "Sandbox only; live money is unsupported.");
  configured("providerAuthority", env.PROVIDER_ACTIONS_ENABLED === "true", "Enable only after exact provider-action approval; a flag is not approval evidence.");

  let merchants: Record<string, unknown> = {};
  let validJson = false;
  try {
    const parsed: unknown = JSON.parse(env.PAYPAL_MERCHANTS_JSON || "");
    if (record(parsed)) {
      merchants = parsed;
      validJson = true;
    }
  } catch {
    // Never include raw JSON or a parser exception in diagnostics.
  }
  configured("paypalMerchantJson", validJson, "Server-only merchant map must be a JSON object.");
  for (const profile of profiles) {
    const merchant = merchants[profile];
    configured(`paypalMerchant.${profile}`, record(merchant) && [merchant.clientId, merchant.secret, merchant.merchantId].every(nonempty), "Client ID, secret and merchant ID required for this demo profile.");
    configured(`paypalWebhook.${profile}`, record(merchant) && nonempty(merchant.webhookId), "This merchant's webhook ID required; signature delivery not tested.");
  }
  const merchantRows = profiles.map((profile) => merchants[profile]);
  configured("paypalIndependentMerchants", merchantRows.every(record) && new Set(merchantRows.map((m) => record(m) && m.clientId)).size === profiles.length && new Set(merchantRows.map((m) => record(m) && m.merchantId)).size === profiles.length && merchantRows.every((m) => record(m) && nonempty(m.clientId) && nonempty(m.merchantId)), "Four demo profiles need distinct REST client IDs and receiving merchant IDs; ownership remains unverified.");
  for (const profile of nonprofits) {
    const merchant = merchants[profile];
    const plans = record(merchant) && merchant.monthlyPlans;
    const entries = record(plans) ? Object.entries(plans) : [];
    configured(`paypalMonthlyPlans.${profile}`, entries.length > 0 && entries.every(([amount, plan]) => /^[1-9]\d*$/.test(amount) && Number.isSafeInteger(Number(amount)) && nonempty(plan)), "At least one monthly plan keyed by a positive integer amount in cents; plan amount, currency and ownership require PayPal qualification.");
  }

  configured("geminiConfig", env.AI_MODE === "gemini" && nonempty(env.GEMINI_API_KEY) && nonempty(env.GEMINI_MODEL), "Mode, key and explicit model required; no provider request is made.");
  const workspaces = (env.PROVIDER_DEMO_WORKSPACE_IDS || "").split(",").map((id) => id.trim());
  configured("syntheticWorkspaceAllowlist", workspaces.length > 0 && workspaces.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)), "Hosted AI requires approved synthetic workspace UUIDs; content and approval not verified.");
  configured("studioLicenseKey", nonempty(env.NEXT_PUBLIC_AG_STUDIO_LICENSE), "A key is present; this does not establish hosted license rights or validity.");
  configured("reconciliationToken", (env.RECONCILE_TOKEN || "").trim().length >= 32, "At least 32 non-padding characters required by the reconciliation route.");

  unverified("googleAuth", "Google provider enablement, redirect URLs and actual sign-in/cookies require qualification.");
  unverified("durableStorageProof", "Applied migrations, role denial, app persistence and hosted recovery require separate evidence.");
  unverified("paypalQualification", "Credential ownership, payer checkout, capture/refund, recurring lifecycle and signed webhooks require sandbox evidence.");
  unverified("geminiQualification", "Key rotation, available free model, account quota and live evaluation require separate evidence.");
  unverified("hostedStudioLicense", /\[TRIAL\]/i.test(env.NEXT_PUBLIC_AG_STUDIO_LICENSE || "") ? "Evaluation trial detected; hosted rights and expiry through judging require written confirmation." : "Hosted rights, license validity and expiry through judging require confirmation.");
  unverified("hostedDemo", "Deployment and actual multi-role browser journeys remain separate from configuration.");
  return { checks, exitCode: checks.some((check) => check.status === "BLOCKED") ? 1 : 0 };
}

export function formatReadiness(report: ReturnType<typeof providerReadiness>) {
  return [
    "Configuration inspection only. No credentials used, modes changed or provider requests made.",
    ...report.checks.map((check) => `${check.name}: ${check.status} (${check.detail})`),
    "Exit 0 means configuration fields pass only; NOT VERIFIED rows still block a full demo-readiness claim.",
  ].join("\n");
}
