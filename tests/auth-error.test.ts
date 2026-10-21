import { expect, it } from "vitest";
import { authErrorResponse } from "@/lib/auth-error";
const input = (accept?: string) => new Request("http://127.0.0.1:3101/api/auth/callback?code=SYNTHETIC_PRIVATE_CODE", { headers: accept ? { Accept: accept } : {} });
it("preserves the original JSON response when Accept is absent", async () => {
  const response = Response.json({ error: { code: "AUTH", message: "No code." } }, { status: 401 });
  expect(authErrorResponse(input(), response, "callback")).toBe(response);
});
it.each([401, 503])("preserves status and body for explicit JSON status %s", async (status) => {
  const response = Response.json({ error: { code: "AUTH" } }, { status });
  const result = authErrorResponse(input("application/json"), response, "callback");
  expect(result).toBe(response); expect(result.status).toBe(status);
  expect(await result.json()).toEqual({ error: { code: "AUTH" } });
});
it("does not send HTML when the client explicitly excludes it", () => {
  const response = Response.json({ error: { code: "AUTH" } }, { status: 401 });
  expect(authErrorResponse(input("text/html;q=0.0, application/json"), response, "callback")).toBe(response);
});
it("renders static callback recovery without reflecting code or provider diagnostics", async () => {
  const response = Response.json({ error: { message: "SYNTHETIC_PRIVATE_PROVIDER_DIAGNOSTIC" } }, { status: 401, headers: { "X-Synthetic-Header": "preserved" } });
  const result = authErrorResponse(input("text/html"), response, "callback");
  expect(result.status).toBe(401); expect(result.headers.get("content-type")).toContain("text/html");
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("vary")).toContain("Accept");
  expect(result.headers.get("x-synthetic-header")).toBe("preserved");
  const html = await result.text(); expect(html).toContain('href="/"'); expect(html).toContain('href="/api/auth/login"');
  expect(html).not.toContain("SYNTHETIC_PRIVATE_CODE"); expect(html).not.toContain("SYNTHETIC_PRIVATE_PROVIDER_DIAGNOSTIC");
  expect(html).not.toContain("<script");
});
it("offers a home return for unavailable login without an automatic retry", async () => {
  const result = authErrorResponse(input("text/html"), Response.json({ error: {} }, { status: 503 }), "login");
  expect(result.status).toBe(503); const html = await result.text();
  expect(html).toContain("Return to PantryPilot"); expect(html).toContain("Google sign-in is unavailable");
  expect(html).not.toContain('href="/api/auth/login"'); expect(result.headers.get("location")).toBeNull();
});
it("preserves a successful response even when HTML is accepted", () => {
  const response = Response.json({ joined: true });
  expect(authErrorResponse(input("text/html"), response, "callback")).toBe(response);
});

