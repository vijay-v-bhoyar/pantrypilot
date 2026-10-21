import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { seedWorkspace } from "@/lib/seed";
import {
  quotaLimit,
  reserveDemoStart,
  reserveHostedAiRun,
  reserveQuota,
} from "@/lib/runtime-quota";
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/auth", () => ({ serviceClient: () => ({ rpc: mock.rpc }) }));
beforeEach(() => {
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("STORAGE_MODE", "local");
  vi.stubEnv("PAYMENTS_MODE", "simulation");
  mock.rpc.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function hosted() {
  vi.stubEnv("APP_ENV", "hosted");
  vi.stubEnv("STORAGE_MODE", "supabase");
  vi.stubEnv("SESSION_SECRET", "fixture-signing-secret-never-real-123456789");
  vi.stubEnv("APP_URL", "https://demo.example.com");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-not-a-real-key");
}
it("admits exactly the limit during concurrent local attempts", async () => {
  const bucket = { key: `test:${randomUUID()}`, limit: 3, windowSeconds: 3600 };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => reserveQuota([bucket])),
  );
  expect(results.filter(Boolean)).toHaveLength(3);
  expect(mock.rpc).not.toHaveBeenCalled();
});
it("rejects all buckets atomically without consuming an available bucket", async () => {
  const a = { key: `test:${randomUUID()}`, limit: 1, windowSeconds: 3600 };
  const b = { ...a, key: `test:${randomUUID()}` };
  expect(await reserveQuota([a])).toBe(true);
  expect(await reserveQuota([b, a])).toBe(false);
  expect(await reserveQuota([b])).toBe(true);
});
it("rolls over expired windows and isolates independent clients", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T10:00:00Z"));
  const a = { key: `test:${randomUUID()}`, limit: 1, windowSeconds: 60 };
  expect(await reserveQuota([a])).toBe(true);
  expect(await reserveQuota([a])).toBe(false);
  expect(await reserveQuota([{ ...a, key: `test:${randomUUID()}` }])).toBe(
    true,
  );
  vi.advanceTimersByTime(60000);
  expect(await reserveQuota([a])).toBe(true);
});
it("rejects malformed policies and fractional or non-finite environment limits", async () => {
  for (const value of ["NaN", "Infinity", "0", "-1", "1.5", "10001", ""]) {
    vi.stubEnv("AI_ACCOUNT_DAILY_LIMIT", value);
    expect(() => quotaLimit("AI_ACCOUNT_DAILY_LIMIT", 40)).toThrow("integers");
  }
  await expect(reserveQuota([])).rejects.toThrow("policy");
  const b = { key: "test:duplicate", limit: 1, windowSeconds: 60 };
  await expect(reserveQuota([b, b])).rejects.toThrow("policy");
  await expect(reserveQuota([{ ...b, key: "../outside" }])).rejects.toThrow(
    "policy",
  );
});
it("uses shared Supabase admission and fails closed on error or malformed result", async () => {
  hosted();
  const b = { key: "test:hosted", limit: 2, windowSeconds: 60 };
  mock.rpc
    .mockResolvedValueOnce({ data: true, error: null })
    .mockResolvedValueOnce({ data: false, error: null });
  expect(await reserveQuota([b])).toBe(true);
  expect(await reserveQuota([b])).toBe(false);
  expect(mock.rpc).toHaveBeenCalledWith("reserve_runtime_quota", {
    buckets: [b],
  });
  for (const value of [
    { data: null, error: { message: "secret database details" } },
    { data: "true", error: null },
  ]) {
    mock.rpc.mockResolvedValue(value);
    await expect(reserveQuota([b])).rejects.toThrow("could not be confirmed");
  }
});
it("reserves hosted global and hashed client limits together", async () => {
  hosted();
  vi.stubEnv("DEMO_DAILY_LIMIT", "2");
  mock.rpc.mockResolvedValue({ data: true, error: null });
  await reserveDemoStart(
    new Request("https://demo.example.com/api/demo", {
      headers: { "x-forwarded-for": "192.0.2.5, 192.0.2.8" },
    }),
  );
  const params = mock.rpc.mock.calls[0][1];
  expect(params.buckets).toHaveLength(2);
  expect(params.buckets[0].key).toMatch(/^demo-client:[a-f0-9]{64}$/);
  expect(JSON.stringify(params)).not.toContain("192.0.2");
  expect(params.buckets[1]).toEqual({
    key: "demo-global",
    limit: 2,
    windowSeconds: 86400,
  });
  mock.rpc.mockResolvedValue({ data: false, error: null });
  await expect(
    reserveDemoStart(new Request("https://demo.example.com/api/demo")),
  ).rejects.toMatchObject({ status: 429 });
});
it("denies unapproved and non-synthetic hosted workspaces before using a quota", async () => {
  hosted();
  const w = seedWorkspace();
  vi.stubEnv("PROVIDER_DEMO_WORKSPACE_IDS", "");
  await expect(reserveHostedAiRun(w)).rejects.toMatchObject({
    code: "PROVIDER_ADMISSION",
    status: 403,
  });
  vi.stubEnv("PROVIDER_DEMO_WORKSPACE_IDS", `${w.id}-spoofed`);
  await expect(reserveHostedAiRun(w)).rejects.toMatchObject({ status: 403 });
  vi.stubEnv("PROVIDER_DEMO_WORKSPACE_IDS", w.id);
  w.demo = false;
  await expect(reserveHostedAiRun(w)).rejects.toMatchObject({ status: 403 });
  expect(mock.rpc).not.toHaveBeenCalled();
});
it("shares one AI quota across approved workspaces and counts unsuccessful attempts", async () => {
  hosted();
  const a = seedWorkspace(),
    b = seedWorkspace();
  vi.stubEnv("PROVIDER_DEMO_WORKSPACE_IDS", ` ${a.id},${b.id} `);
  vi.stubEnv("AI_ACCOUNT_DAILY_LIMIT", "1");
  mock.rpc
    .mockResolvedValueOnce({ data: true, error: null })
    .mockResolvedValueOnce({ data: false, error: null });
  await reserveHostedAiRun(a);
  await expect(reserveHostedAiRun(b)).rejects.toMatchObject({
    code: "AI_QUOTA",
    status: 429,
  });
  expect(mock.rpc.mock.calls[0][1]).toEqual(mock.rpc.mock.calls[1][1]);
  expect(mock.rpc.mock.calls[0][1].buckets[0].key).toBe("gemini-account");
});
