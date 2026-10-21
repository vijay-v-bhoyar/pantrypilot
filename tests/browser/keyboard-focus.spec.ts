// Proposed tests/browser/keyboard-focus.spec.ts after human approval.
import { expect, test, type Locator, type Page } from "@playwright/test";
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 180; i++) {
    if (await target.evaluate(el => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard target was not reachable");
}

for (const [actor, width] of [["finance-a", 390], ["coordinator-a", 390], ["coordinator-a", 1280]] as const) {
  test(`normal-motion ${actor} workflow keeps its final keyboard control visible at ${width}px`, async ({ page }) => {
    const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
    await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ reducedMotion: "no-preference" });
    expect((await page.request.post("/api/demo", { headers: { Origin: origin, "x-forwarded-for": `focus-role-${crypto.randomUUID()}` }, data: {} })).status()).toBe(200);
    expect((await page.request.post("/api/demo", { headers: { Origin: origin }, data: { actorId: actor } })).status()).toBe(200);
    await page.goto("/workspace"); await expect(page.getByRole("combobox", { name: "Demo role", exact: true })).toHaveValue(actor);
    if (width === 390) {
      const menu = page.getByRole("button", { name: "Open navigation", exact: true });
      await tabTo(page, menu); await settle(menu); await expect(menu).toBeInViewport({ ratio: 1 }); await page.keyboard.press("Enter");
    }
    const purchase = page.locator(".sidebar").getByRole("button", { name: "Purchasing", exact: true });
    await tabTo(page, purchase); await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Save purchasing request", exact: true })).toBeVisible();
    const target = actor === "coordinator-a" ? page.getByRole("button", { name: "Save purchasing request", exact: true })
      : page.getByRole("button", { name: "Open navigation", exact: true });
    await tabTo(page, target); await settle(target);
    await expect(target).toBeFocused(); await expect(target).toBeInViewport({ ratio: 1 });
    expect(await target.evaluate(el => {
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return el.matches(":focus-visible") && hit !== null && (el === hit || el.contains(hit));
    })).toBe(true);
    await page.screenshot({ path: `output/approved-repairs-2026-10-15/keyboard-${actor}-${width}.png`, fullPage: true });
  });
}
async function settle(target: Locator) {
  await target.evaluate(el => new Promise<void>(resolve => {
    let last: number[] | null = null, stable = 0;
    const started = performance.now();
    const tick = () => {
      const r = el.getBoundingClientRect(), next = [r.x, r.y, r.width, r.height];
      stable = last && next.every((n, i) => Math.abs(n - last![i]) < 0.15) ? stable + 1 : 0;
      last = next;
      if (stable >= 8 || performance.now() - started > 1800) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}
for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
  test(`keyboard traversal preserves visible focused navigation at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
    const response = await page.request.post("/api/demo", { headers: { Origin: origin, "x-forwarded-for": `focus-${crypto.randomUUID()}` }, data: {} });
    expect(response.status()).toBe(200);
    await page.goto("/workspace");
    await expect(page.getByRole("heading", { name: "Good to see you, Morgan.", exact: true })).toBeVisible();
    const role = page.getByRole("combobox", { name: "Demo role", exact: true });
    await tabTo(page, role); await settle(role);
    const target = viewport.width === 390
      ? page.getByRole("button", { name: "Open navigation", exact: true })
      : page.locator(".sidebar").getByRole("button", { name: "Organization", exact: true });
    await tabTo(page, target); await settle(target);
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport({ ratio: 1 });
    expect(await target.evaluate(el => el.matches(":focus-visible"))).toBe(true);
    await page.keyboard.press("Enter");
    if (viewport.width === 390) await expect(page.locator(".sidebar")).toHaveClass(/mobile-open/);
    else await expect(page.locator("main .page-heading h1")).toHaveText("Organization");
  });
}
