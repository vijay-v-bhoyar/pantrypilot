import { afterEach, expect, it, vi } from "vitest";
import { decodeSession, encodeSession, checkOrigin } from "@/lib/session";
afterEach(() => vi.unstubAllEnvs());
it("rejects forged, modified and expired signed sessions", () => {
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("STORAGE_MODE", "local");
  const data = {
    workspaceId: "demo",
    actorId: "donor",
    expiresAt: Date.now() + 10000,
    nonce: "test",
  };
  const signed = encodeSession(data);
  expect(decodeSession(signed)).toEqual(data);
  expect(() => decodeSession("forged.signature")).toThrow();
  const [body, signature] = signed.split(".");
  const changed = JSON.parse(Buffer.from(body, "base64url").toString());
  changed.actorId = "owner";
  expect(() =>
    decodeSession(
      `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`,
    ),
  ).toThrow();
  expect(() => decodeSession(encodeSession({ ...data, expiresAt: 0 }))).toThrow(
    "expired",
  );
});
it("requires the configured origin for cookie mutations", () => {
  vi.stubEnv("APP_URL", "http://127.0.0.1:3100");
  expect(() =>
    checkOrigin(
      new Request("http://127.0.0.1:3100/api/command", {
        headers: { origin: "https://attacker.example" },
      }),
    ),
  ).toThrow("untrusted");
  expect(() =>
    checkOrigin(new Request("http://127.0.0.1:3100/api/command")),
  ).toThrow("untrusted");
  expect(() =>
    checkOrigin(
      new Request("http://127.0.0.1:3100/api/command", {
        headers: { origin: "http://127.0.0.1:3100" },
      }),
    ),
  ).not.toThrow();
});
