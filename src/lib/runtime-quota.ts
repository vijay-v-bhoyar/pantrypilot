import { createHmac } from "node:crypto";
import { serviceClient } from "./auth";
import { configuration } from "./config";
import { ensure } from "./errors";
import type { Workspace } from "./types";

type Bucket = { key: string; limit: number; windowSeconds: number };
const local = new Map<string, { used: number; expiresAt: number }>();
export function quotaLimit(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  ensure(
    Number.isSafeInteger(value) && value > 0 && value <= 10000,
    "CONFIGURATION",
    "Runtime limits must be integers between 1 and 10000.",
    503,
  );
  return value;
}

// All buckets are reserved together. A rejected request consumes none of them.
export async function reserveQuota(buckets: Bucket[]) {
  ensure(
    buckets.length > 0 &&
      buckets.length <= 8 &&
      new Set(buckets.map((b) => b.key)).size === buckets.length &&
      buckets.every(
        (b) =>
          /^[a-zA-Z0-9:_-]{1,128}$/.test(b.key) &&
          Number.isSafeInteger(b.limit) &&
          b.limit > 0 &&
          b.limit <= 10000 &&
          Number.isSafeInteger(b.windowSeconds) &&
          b.windowSeconds > 0 &&
          b.windowSeconds <= 86400,
      ),
    "CONFIGURATION",
    "Invalid runtime quota policy.",
    503,
  );
  if (configuration().storage === "supabase") {
    const { data, error } = await serviceClient().rpc("reserve_runtime_quota", {
      buckets,
    });
    ensure(
      !error && typeof data === "boolean",
      "QUOTA_UNAVAILABLE",
      "Usage limits could not be confirmed. Retry shortly.",
      503,
    );
    return data;
  }
  const now = Date.now();
  for (const [key, value] of local)
    if (value.expiresAt <= now) local.delete(key);
  const entries = buckets.map((b) => {
    const window = Math.floor(now / (b.windowSeconds * 1000));
    return {
      bucket: b,
      key: `${b.key}:${b.windowSeconds}:${window}`,
      expiresAt: (window + 1) * b.windowSeconds * 1000,
    };
  });
  if (entries.some((e) => (local.get(e.key)?.used ?? 0) >= e.bucket.limit))
    return false;
  // Bound memory even if clients supply many distinct forwarding headers locally.
  ensure(
    local.size + entries.filter((e) => !local.has(e.key)).length <= 4096,
    "QUOTA_UNAVAILABLE",
    "Usage limit capacity reached. Retry later.",
    503,
  );
  for (const e of entries)
    local.set(e.key, {
      used: (local.get(e.key)?.used ?? 0) + 1,
      expiresAt: e.expiresAt,
    });
  return true;
}

export async function reserveDemoStart(request: Request) {
  const c = configuration();
  const identity = (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"
  ).slice(0, 256);
  const hash = createHmac(
    "sha256",
    process.env.SESSION_SECRET || "local-demo-only",
  )
    .update(identity)
    .digest("hex");
  const buckets: Bucket[] = [
    { key: `demo-client:${hash}`, limit: 20, windowSeconds: 3600 },
  ];
  // Global hosted cap remains effective even if the forwarding identity is missing/spoofed.
  if (c.hosted)
    buckets.push({
      key: "demo-global",
      limit: quotaLimit("DEMO_DAILY_LIMIT", 100),
      windowSeconds: 86400,
    });
  ensure(
    await reserveQuota(buckets),
    "RATE_LIMIT",
    "Demo start limit reached. Resume an existing demo.",
    429,
  );
}

export async function reserveHostedAiRun(w: Workspace) {
  if (!configuration().hosted) return;
  const allowed = (process.env.PROVIDER_DEMO_WORKSPACE_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  ensure(
    w.demo && allowed.includes(w.id),
    "PROVIDER_ADMISSION",
    "AI is available only in operator-approved synthetic demo workspaces.",
    403,
  );
  ensure(
    await reserveQuota([
      {
        key: "gemini-account",
        limit: quotaLimit("AI_ACCOUNT_DAILY_LIMIT", 40),
        windowSeconds: 86400,
      },
    ]),
    "AI_QUOTA",
    "The shared daily AI run limit was reached.",
    429,
  );
}
