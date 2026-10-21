import { describe, expect, it } from "vitest";
import { formatReadiness, providerReadiness } from "../scripts/provider-readiness";

function fixture() {
  return {
    APP_ENV: "hosted", STORAGE_MODE: "supabase", APP_URL: "https://demo.example.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-public",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-server", SESSION_SECRET: "s".repeat(32),
    PAYMENTS_MODE: "sandbox", PROVIDER_ACTIONS_ENABLED: "true",
    PAYPAL_MERCHANTS_JSON: JSON.stringify(Object.fromEntries(["hope", "river", "harvest", "supply"].map((name) => [name, {
      clientId: `fixture-client-${name}`, secret: `fixture-secret-${name}`, merchantId: `fixture-merchant-${name}`,
      webhookId: `fixture-webhook-${name}`, monthlyPlans: { "2500": `fixture-plan-${name}` },
    }]))),
    AI_MODE: "gemini", GEMINI_API_KEY: "fixture-ai", GEMINI_MODEL: "fixture-model",
    PROVIDER_DEMO_WORKSPACE_IDS: "10000000-0000-4000-8000-000000000001",
    NEXT_PUBLIC_AG_STUDIO_LICENSE: "[TRIAL]_fixture-license", RECONCILE_TOKEN: "r".repeat(32),
  };
}
const status = (env: Record<string, string | undefined>, name: string) =>
  providerReadiness(env).checks.find((check) => check.name === name)?.status;

describe("configuration inspection cannot manufacture provider qualification", () => {
  it("accepts complete configuration but leaves live and license proof unverified", () => {
    const report = providerReadiness(fixture());
    expect(report.exitCode).toBe(0);
    expect(report.checks.filter((check) => check.status === "NOT VERIFIED").map((check) => check.name)).toEqual([
      "googleAuth", "durableStorageProof", "paypalQualification", "geminiQualification", "hostedStudioLicense", "hostedDemo",
    ]);
    expect(formatReadiness(report)).toContain("Evaluation trial detected");
  });
  it("rejects the old empty-merchant false positive", () => {
    const env = { ...fixture(), PAYPAL_MERCHANTS_JSON: '{"hope":{},"river":{},"harvest":{},"supply":{}}' };
    expect(providerReadiness(env).exitCode).toBe(1);
    for (const name of ["hope", "river", "harvest", "supply"]) expect(status(env, `paypalMerchant.${name}`)).toBe("BLOCKED");
    expect(status(env, "googleAuth")).toBe("NOT VERIFIED");
    expect(status(env, "hostedStudioLicense")).toBe("NOT VERIFIED");
  });
  it.each(["", "{}", "[]", "null", "true", '{"private":"LEAK_ME",broken}'])("handles incomplete or malformed JSON without exposing its contents: case %#", (json) => {
    const env = { ...fixture(), PAYPAL_MERCHANTS_JSON: json };
    expect(providerReadiness(env).exitCode).toBe(1);
    expect(formatReadiness(providerReadiness(env))).not.toContain("LEAK_ME");
  });
  it("rejects missing/blank credentials, reused receiving accounts and reused apps", () => {
    const env = fixture();
    const merchants = JSON.parse(env.PAYPAL_MERCHANTS_JSON);
    merchants.hope.secret = " "; merchants.river.clientId = merchants.harvest.clientId;
    merchants.supply.merchantId = merchants.harvest.merchantId;
    env.PAYPAL_MERCHANTS_JSON = JSON.stringify(merchants);
    expect(status(env, "paypalMerchant.hope")).toBe("BLOCKED");
    expect(status(env, "paypalIndependentMerchants")).toBe("BLOCKED");
  });
  it("checks webhook IDs and valid monthly amount mappings independently", () => {
    const env = fixture(); const merchants = JSON.parse(env.PAYPAL_MERCHANTS_JSON);
    delete merchants.harvest.webhookId; merchants.hope.monthlyPlans = { "25.00": "plan" };
    merchants.river.monthlyPlans = { "9007199254740992": "plan" };
    env.PAYPAL_MERCHANTS_JSON = JSON.stringify(merchants);
    expect(status(env, "paypalWebhook.harvest")).toBe("BLOCKED");
    expect(status(env, "paypalMonthlyPlans.hope")).toBe("BLOCKED");
    expect(status(env, "paypalMonthlyPlans.river")).toBe("BLOCKED");
  });
  it("lists all hosted blockers without throwing or enabling provider modes", () => {
    const env = { APP_ENV: "hosted", STORAGE_MODE: "local", PROVIDER_ACTIONS_ENABLED: "false" };
    expect(() => providerReadiness(env)).not.toThrow();
    expect(status(env, "supabaseServerKey")).toBe("BLOCKED");
    expect(status(env, "strongSessions")).toBe("BLOCKED");
    expect(status(env, "providerAuthority")).toBe("BLOCKED");
    expect(env.PROVIDER_ACTIONS_ENABLED).toBe("false");
  });
  it("rejects insecure/credential-bearing URLs, padded tokens and invalid workspace IDs", () => {
    const env = { ...fixture(), APP_URL: "https://user:private@demo.example.com", NEXT_PUBLIC_SUPABASE_URL: "http://example.supabase.co", RECONCILE_TOKEN: " ".repeat(32), PROVIDER_DEMO_WORKSPACE_IDS: "not-a-workspace" };
    for (const name of ["hostedAppUrl", "supabasePublicConfig", "reconciliationToken", "syntheticWorkspaceAllowlist"]) expect(status(env, name)).toBe("BLOCKED");
    expect(formatReadiness(providerReadiness(env))).not.toContain("private");
  });
  it("never prints any supplied credential, model, URL, workspace or JSON value", () => {
    const env = fixture(); const output = formatReadiness(providerReadiness(env));
    for (const value of Object.values(env).filter((value) => value.startsWith("fixture-") || value.startsWith("https://") || value.length >= 32)) expect(output).not.toContain(value);
    expect(output).toContain("No credentials used");
  });
});
