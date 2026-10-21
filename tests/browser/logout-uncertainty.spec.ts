// Proposed new tests/browser/logout-uncertainty.spec.ts after human approval.
import { expect, test } from "@playwright/test";
const uncertainty = "We could not confirm sign-out. Another copy of this session may remain active. Contact your workspace owner before continuing.";
for (const scenario of ["server-unconfirmed", "transport-abort", "invalid-success-acknowledgment"] as const) {
  test(`logout reports ${scenario} and hides the protected workspace`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Explore the working demo", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Good to see you, Morgan.", exact: true })).toBeVisible();
    await page.route("**/api/logout", async (route) => {
      if (scenario === "transport-abort") return route.abort("failed");
      // Preserve the actual local logout's cookie-clearing response headers.
      const response = await route.fetch();
      await route.fulfill({ response, status: scenario === "server-unconfirmed" ? 503 : 200,
        json: scenario === "server-unconfirmed"
          ? { error: { code: "LOGOUT_UNCONFIRMED", message: "SYNTHETIC_UNTRUSTED_DIAGNOSTIC" } }
          : { signedOut: false } });
    });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator("main").getByRole("alert")).toHaveText(scenario === "server-unconfirmed"
      ? "Browser credentials cleared, but server session revocation could not be confirmed. Contact your workspace owner before continuing."
      : uncertainty);
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByRole("combobox", { name: "Demo role", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Good to see you, Morgan.", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("SYNTHETIC_UNTRUSTED_DIAGNOSTIC");
    await expect(page.getByRole("link", { name: "Start an isolated demo", exact: true })).toBeVisible();
    if (scenario !== "transport-abort") {
      expect((await page.request.get("/api/workspace")).status()).toBe(401);
      expect((await page.context().cookies()).some(c => c.name === "pantrypilot_session")).toBe(false);
    }
  });
}

test("a late workspace refresh cannot restore protected content after unconfirmed logout", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the working demo", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Good to see you, Morgan.", exact: true })).toBeVisible();
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let seen!: () => void;
  const started = new Promise<void>(resolve => { seen = resolve; });
  await page.route("**/api/workspace", async route => {
    const response = await route.fetch(); seen(); await delayed; await route.fulfill({ response });
  });
  await page.route("**/api/logout", route => route.fulfill({ status: 503, json: { error: { code: "LOGOUT_UNCONFIRMED" } } }));
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click(); await started;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("server session revocation could not be confirmed");
  const completed = page.waitForResponse("**/api/workspace"); release(); await completed;
  await expect(page.getByRole("combobox", { name: "Demo role", exact: true })).toHaveCount(0);
  await expect(page.locator("main").getByRole("alert")).toContainText("server session revocation could not be confirmed");
});
