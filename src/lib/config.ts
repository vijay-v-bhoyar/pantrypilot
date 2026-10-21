import { ensure } from "./errors";
export function configuration() {
  const hosted =
    process.env.APP_ENV === "hosted" || Boolean(process.env.VERCEL);
  const storage = process.env.STORAGE_MODE || "local";
  const payments = process.env.PAYMENTS_MODE || "simulation";
  const ai = process.env.AI_MODE || "manual";
  ensure(
    ["local", "supabase"].includes(storage),
    "CONFIGURATION",
    "Unknown storage mode.",
    503,
  );
  ensure(
    ["simulation", "sandbox"].includes(payments),
    "CONFIGURATION",
    "Live money is not supported.",
    503,
  );
  ensure(
    ["manual", "gemini"].includes(ai),
    "CONFIGURATION",
    "Unknown AI mode.",
    503,
  );
  if (hosted) {
    ensure(
      storage === "supabase",
      "CONFIGURATION",
      "Hosted access requires durable Supabase storage.",
      503,
    );
    ensure(
      (process.env.SESSION_SECRET || "").length >= 32,
      "CONFIGURATION",
      "Hosted sessions require a configured strong signing secret.",
      503,
    );
    let app: URL;
    try {
      app = new URL(process.env.APP_URL || "");
    } catch {
      throw new Error("Hosted APP_URL must be configured.");
    }
    ensure(
      app.protocol === "https:" && !app.username && !app.password,
      "CONFIGURATION",
      "Hosted APP_URL must use HTTPS.",
      503,
    );
  }
  if (storage === "supabase")
    ensure(
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      "CONFIGURATION",
      "Supabase storage is not configured.",
      503,
    );
  return {
    hosted,
    storage,
    payments,
    ai,
    financialActions: process.env.FINANCIAL_ACTIONS_ENABLED !== "false",
    providerActions: process.env.PROVIDER_ACTIONS_ENABLED === "true",
  };
}
