import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { AppView } from "@/lib/types";
const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";

test("demo admission denies excess starts while preserving resume and role tours", async ({
  page,
  context,
}) => {
  const client = `quota-browser-${crypto.randomUUID()}`;
  const headers = { Origin: origin, "x-forwarded-for": client };
  let workspaceId = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await page.request.post("/api/demo", {
      headers,
      data: {},
    });
    expect(response.status()).toBe(200);
    workspaceId = (await response.json()).workspaceId;
  }
  const denied = await page.request.post("/api/demo", { headers, data: {} });
  expect(denied.status()).toBe(429);
  expect((await denied.json()).error.code).toBe("RATE_LIMIT");
  const resumed = await page.request.post("/api/demo", {
    headers,
    data: { actorId: "owner-a" },
  });
  expect(resumed.status()).toBe(200);
  expect((await resumed.json()).workspaceId).toBe(workspaceId);
  await context.setExtraHTTPHeaders({ "x-forwarded-for": client });
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the working demo" }).click();
  await expect(
    page.getByText("Demo start limit reached. Resume an existing demo.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/demo-start-limit.jpg",
    fullPage: true,
  });
});
async function start(page: Page) {
  await page.context().setExtraHTTPHeaders({
    "x-forwarded-for": `journey-${crypto.randomUUID()}`,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the working demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Good to see you, Morgan." }),
  ).toBeVisible();
}
test("logout invalidates copied cookies while preserving a separate browser workspace", async ({
  page,
  context,
  browser,
}) => {
  await start(page);
  const first = await (await page.request.get("/api/workspace")).json();
  const copied = await context.cookies();
  const other = await browser.newContext({ baseURL: origin });
  const replay = await browser.newContext({ baseURL: origin });
  try {
    const otherPage = await other.newPage();
    await start(otherPage);
    const second = await (
      await otherPage.request.get(`${origin}/api/workspace`)
    ).json();
    expect(second.id).not.toBe(first.id);
    const attemptedRead = await page.request.get(
      `/api/workspace?workspaceId=${second.id}`,
    );
    expect((await attemptedRead.json()).id).toBe(first.id);
    const signOut = page.getByRole("button", { name: "Sign out", exact: true });
    await signOut.scrollIntoViewIfNeeded();
    await expect(signOut).toBeInViewport();
    await page
      .locator(".sidebar")
      .screenshot({ path: "output/logout-sidebar-scrollable.png" });
    await signOut.click();
    await expect(page).toHaveURL(`${origin}/`);
    expect((await page.request.get("/api/workspace")).status()).toBe(401);
    await replay.addCookies(copied);
    const denied = await replay.request.get(`${origin}/api/workspace`);
    expect(denied.status()).toBe(401);
    expect((await denied.json()).error.code).toBe("SESSION_REVOKED");
    expect(
      (await otherPage.request.get(`${origin}/api/workspace`)).status(),
    ).toBe(200);
  } finally {
    await other.close();
    await replay.close();
  }
});
async function nav(page: Page, name: string) {
  await page
    .locator(".sidebar")
    .getByRole("button", { name, exact: true })
    .click();
}
async function role(page: Page, id: string) {
  await page.getByLabel("Demo role").selectOption(id);
  await expect(page.locator(".profile strong")).toContainText(
    id === "donor"
      ? "Alex"
      : id === "supplier-a"
        ? "Avery"
        : id === "supplier-b"
          ? "Casey"
          : id === "owner-b"
            ? "Taylor"
            : id === "finance-a"
              ? "Jordan"
              : id === "coordinator-a"
                ? "Sam"
                : "Morgan",
  );
}
async function command(page: Page, command: string, data: unknown) {
  const r = await page.request.post("/api/command", {
    headers: { Origin: origin },
    data: { command, data, key: crypto.randomUUID() },
  });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
for (const collaborative of [false, true]) {
test(`${collaborative ? "coordinator and finance handoff: " : ""}complete UI purchasing, recovery, replacement, receipt and distribution journey`, async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  if (collaborative) await role(page, "coordinator-a");
  await nav(page, "Purchasing");
  await page.getByRole("button", { name: "Save purchasing request" }).click();
  await page.getByRole("button", { name: "Compare approved offers" }).click();
  await expect(
    page.getByRole("heading", { name: "Basket · $348.10" }),
  ).toBeVisible();
  if (collaborative) {
    await expect(page.getByRole("button", { name: "Approve exact basket" })).toHaveCount(0);
    const before = await (await page.request.get("/api/workspace")).json();
    const denied = await page.request.post("/api/command", {
      headers: { Origin: origin },
      data: { command: "approve", data: { id: before.proposals[0].id }, key: crypto.randomUUID() },
    });
    expect(denied.status()).toBe(403);
    expect((await denied.json()).error.code).toBe("FORBIDDEN");
    await role(page, "finance-a");
    await nav(page, "Purchasing");
  }
  await page.getByRole("button", { name: "Approve exact basket" }).click();
  await page
    .getByRole("button", { name: "Reserve funds & create orders" })
    .click();
  const originalPayerActions = page.getByRole("button", {
    name: "Simulate payer approval",
  });
  await expect(originalPayerActions).toHaveCount(2);
  await originalPayerActions.first().click();
  await expect(originalPayerActions).toHaveCount(1);
  await originalPayerActions.first().click();
  await expect(originalPayerActions).toHaveCount(0);
  await role(page, "supplier-a");
  const riceRow = page.locator(".list-row").filter({ hasText: "Rice" }).first();
  await riceRow.locator("input[name=packs]").fill("2");
  await riceRow.getByRole("button", { name: "Cancel packs" }).click();
  await role(page, collaborative ? "finance-a" : "owner-a");
  await nav(page, "Recovery");
  await expect(
    page.getByRole("heading", { name: "$36.00 to recover" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve & request refund" }).click();
  await role(page, "supplier-a");
  await page
    .getByRole("button", { name: "Simulate merchant-authorized refund" })
    .click();
  await expect(
    page.getByRole("button", { name: "Simulate merchant-authorized refund" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Mark remaining shipment fulfilled" })
    .click();
  await expect(
    page.getByRole("button", { name: "Mark remaining shipment fulfilled" }),
  ).toHaveCount(0);
  await role(page, "supplier-b");
  await page
    .getByRole("button", { name: "Mark remaining shipment fulfilled" })
    .click();
  await expect(
    page.getByRole("button", { name: "Mark remaining shipment fulfilled" }),
  ).toHaveCount(0);
  await role(page, collaborative ? "coordinator-a" : "owner-a");
  await nav(page, "Purchasing");
  const originalReceipts = page.getByRole("button", {
    name: "Confirm pantry receipt",
  });
  await expect(originalReceipts).toHaveCount(2);
  await originalReceipts.first().click();
  await expect(originalReceipts).toHaveCount(1);
  await originalReceipts.first().click();
  await expect(originalReceipts).toHaveCount(0);
  await nav(page, "Recovery");
  await page.getByRole("button", { name: "Draft replacement basket" }).click();
  if (collaborative) await role(page, "finance-a");
  await nav(page, "Purchasing");
  const replacementBasket = page.locator(".panel").filter({
    has: page.getByRole("heading", { name: "Basket · $61.50", exact: true }),
  });
  await expect(replacementBasket).toBeVisible();
  await replacementBasket
    .getByRole("button", { name: "Approve exact basket" })
    .click();
  await expect(
    replacementBasket.getByRole("button", {
      name: "Reserve funds & create orders",
    }),
  ).toBeVisible();
  await replacementBasket
    .getByRole("button", { name: "Reserve funds & create orders" })
    .click();
  await page.getByRole("button", { name: "Simulate payer approval" }).click();
  await expect(
    page.getByRole("button", { name: "Simulate payer approval" }),
  ).toHaveCount(0);
  await role(page, "supplier-b");
  await page
    .getByRole("button", { name: "Mark remaining shipment fulfilled" })
    .click();
  await expect(
    page.getByRole("button", { name: "Mark remaining shipment fulfilled" }),
  ).toHaveCount(0);
  await role(page, collaborative ? "coordinator-a" : "owner-a");
  await nav(page, "Purchasing");
  await page.getByRole("button", { name: "Confirm pantry receipt" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm pantry receipt" }),
  ).toHaveCount(0);
  await nav(page, "Inventory & kits");
  await page.getByRole("button", { name: "Distribute", exact: true }).click();
  await page.getByLabel("Kits handed out").fill("50");
  await page.getByRole("button", { name: "Record distribution" }).click();
  await expect(
    page.getByText("50 kits distributed", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText(`Good to see you, ${collaborative ? "Sam" : "Morgan"}.`)).toBeVisible();
  if (collaborative) {
    await role(page, "finance-a");
    const finalState = await (await page.request.get("/api/workspace")).json();
    expect(finalState.available["hope-kits"]).toBe(22640);
    expect(finalState.reserved["hope-kits"]).toBe(0);
    expect(finalState.ledger.filter((entry: { kind: string }) => entry.kind === "purchase_refund")).toHaveLength(1);
    await nav(page, "Overview");
  }
  await expect(
    page
      .locator(".stat")
      .filter({ hasText: "Kits distributed" })
      .getByText("50", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: collaborative ? "output/persona-handoff-complete.png" : "output/after-journey.png", fullPage: true });
  await expect(
    page
      .locator(".journey-list > div")
      .filter({ hasText: "Planned kits" })
      .locator("strong"),
  ).toHaveText("50");
});
}
test("donor gives, downloads acknowledgment, subscribes and cancels", async ({
  page,
}) => {
  await start(page);
  await role(page, "donor");
  await page
    .getByRole("button", { name: "Continue to simulated approval" })
    .click();
  await page.getByRole("button", { name: "Simulate payer approval" }).click();
  const receipt = page.getByRole("link", { name: "Acknowledgment" });
  await expect(receipt).toBeVisible();
  const response = await page.request.get(
    (await receipt.getAttribute("href")) as string,
  );
  expect(await response.text()).toContain("not a tax receipt");
  await page
    .getByRole("button", { name: "Monthly support", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue to simulated approval" })
    .click();
  await page
    .getByRole("button", { name: "Simulate subscription activation" })
    .click();
  await page.getByRole("button", { name: "Cancel future giving" }).click();
  await expect(page.getByText(/cancelled · simulation/)).toBeVisible();
});
test("tenant privacy, role denial, CSRF and forged sessions", async ({
  page,
}) => {
  await start(page);
  const state = await (await page.request.get("/api/workspace")).json();
  const badOrigin = await page.request.post("/api/command", {
    headers: { Origin: "https://attacker.example" },
    data: {
      command: "stop",
      data: { enabled: false },
      key: crypto.randomUUID(),
    },
  });
  expect(badOrigin.status()).toBe(403);
  await role(page, "owner-b");
  const r = await page.request.post("/api/command", {
    headers: { Origin: origin },
    data: {
      command: "campaignStatus",
      data: { id: "campaign-hope", status: "closed" },
      key: crypto.randomUUID(),
    },
  });
  expect(r.status()).toBe(404);
  const river = await (await page.request.get("/api/workspace")).json();
  expect(river.organizations.map((o: { id: string }) => o.id)).toEqual([
    "river",
  ]);
  expect(JSON.stringify(river)).not.toContain("campaign-hope");
  await page
    .context()
    .addCookies([
      { name: "pantrypilot_session", value: "forged.signature", url: origin },
    ]);
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
  expect(state.id).toBeTruthy();
});
test("custom AG Studio widgets, saved layout and grid render without errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  await nav(page, "Analytics studio");
  const evidence = page.getByRole("region", { name: "Operational evidence and next step" });
  await expect(evidence).toContainText("10 complete kits are usable at the primary site");
  await page.getByLabel("Dashboard focus").selectOption("funds");
  await expect(evidence).toContainText("$600.00 available; $0.00 reserved");
  await expect(evidence).toContainText("Pending recovery is excluded from available funds");
  await evidence.getByRole("button", { name: "Review next attention area" }).click();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("readiness");
  await page.getByRole("button", { name: "Open AG Studio canvas" }).click();
  await expect(page.locator("[studio-id]")).toBeVisible();
  await expect(
    page.locator("[studio-id]").getByText("Complete kits on hand"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save current view" }).click();
  await expect(page.getByRole("button", { name: "Load view" })).toBeVisible();
  await page.getByLabel("Dashboard focus").selectOption("recovery");
  await page.getByRole("button", { name: "Load view" }).click();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("readiness");
  expect(errors).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "output/studio.png", fullPage: true });
});

async function openNativeAnalyst(page: Page) {
  await start(page);
  await nav(page, "Analytics studio");
  await page
    .getByRole("button", { name: "Open AG Studio canvas", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  const studio = page.locator("[studio-id]");
  await expect(
    studio.getByRole("button", { name: "AI Assistant", exact: true }),
  ).toBeVisible();
  await expect(
    studio.getByRole("heading", { name: "Complete kits on hand", exact: true }),
  ).toBeInViewport();
  const cards = studio.locator(".studio-widget");
  await expect(cards).toHaveCount(4);
  for (let index = 0; index < 4; index++) {
    await cards.nth(index).scrollIntoViewIfNeeded();
    await expect(cards.nth(index)).toBeInViewport({ ratio: 0.99 });
  }
  return studio;
}

test("manual operational explanations work on mobile without an analyst request", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let requests = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/analytics-agent") requests++;
  });
  await start(page);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await nav(page, "Analytics studio");
  const evidence = page.getByRole("region", { name: "Operational evidence and next step" });
  await expect(evidence).toContainText("10 complete kits are usable at the primary site");
  await page.getByLabel("Dashboard focus").selectOption("funds");
  await expect(evidence).toContainText("$600.00 available; $0.00 reserved");
  await expect(evidence).toContainText("This explanation works without AI");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(requests).toBe(0);
  await evidence.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/submission-readiness-2026-10-20/analytics-mobile.png", fullPage: true });
});

test("native Studio analyst reports real provider denial and rejects unsupported questions", async ({
  page,
}) => {
  const studio = await openNativeAnalyst(page);
  let requests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/analytics-agent") requests++;
  });
  const before = await (await page.request.get("/api/workspace")).json();
  await studio
    .getByRole("button", { name: "Show me recovery and funds", exact: true })
    .click();
  await expect(
    studio.getByText(
      "Configure and authorize Gemini before using the analyst.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("readiness");
  await studio
    .getByRole("textbox", { name: "Message input", exact: true })
    .fill("Refund every supplier payment");
  await studio
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    studio.getByText("Choose one of the suggested dashboard questions.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(requests).toBe(1);
  const after = await (await page.request.get("/api/workspace")).json();
  for (const field of ["ledger", "inventory", "orders", "agentRuns"]) {
    expect(before[field]).toEqual(expect.any(Array));
    expect(after[field]).toEqual(before[field]);
  }
  const report = await new AxeBuilder({ page })
    .include("[studio-id]")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(report.violations).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "output/studio-native-denial.png",
    fullPage: true,
  });
  await page.getByLabel("Studio workspace tools").selectOption("edit");
  await expect(
    studio.getByRole("button", { name: "Compose", exact: true }),
  ).toBeVisible();
  await expect(
    studio.getByRole("button", { name: "AI Assistant", exact: true }),
  ).toHaveCount(0);
});

test("native Studio harness applies and saves a validated view using a transport fixture", async ({
  page,
}) => {
  // This exercises the real browser harness/SDK; the response is a contract fixture, not Gemini proof.
  await page.route("**/api/analytics-agent", (route) =>
    route.fulfill({ json: { focus: "recovery", evidence: {
      availableCents: 60000, reservedCents: 0, pendingRecoveryCents: 0,
      pendingRecoveryCases: 0, readyKits: 10, receivedShipments: 0,
      recordedKits: 0, unreceivedOrders: 0,
    } } }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const studio = await openNativeAnalyst(page);
  await studio
    .getByRole("button", { name: "Show me recovery and funds", exact: true })
    .click();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("recovery");
  await expect(
    studio.getByText(
      "At analysis time: 0 unconfirmed recovery cases total $0.00. These refunds are not available to spend. Open Recovery to inspect merchant confirmation. Requesting a refund does not confirm receipt of money. Financial and inventory records are unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    studio.getByText("Arrange dashboard view", { exact: true }),
  ).toBeVisible();
  await expect(studio.locator(".studio-widget h3").first()).toHaveText(
    "Unconfirmed recovery value",
  );
  await page
    .getByRole("button", { name: "Save current view", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Load view", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Dashboard focus").selectOption("readiness");
  await page.getByRole("button", { name: "Load view", exact: true }).click();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("recovery");
  expect(errors).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "output/studio-native-contract.png",
    fullPage: true,
  });
});

test("native Studio cancellation aborts a pending request and preserves the selected view", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/analytics-agent", async (route) => {
    await pending;
    try {
      await route.fulfill({ json: { focus: "funds" } });
    } catch {
      /* Request was intentionally cancelled. */
    }
  });
  const studio = await openNativeAnalyst(page);
  await studio
    .getByRole("button", { name: "Review available funds", exact: true })
    .click();
  await expect(
    studio.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  const cancelled = page.waitForEvent("requestfailed", {
    predicate: (r) => new URL(r.url()).pathname === "/api/analytics-agent",
  });
  await studio.getByRole("button", { name: "Stop", exact: true }).click();
  await cancelled;
  release!();
  await expect(
    studio.getByRole("button", { name: "Send message", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("readiness");
});
test("desktop, mobile and donor pages have no serious accessibility violations or horizontal clipping", async ({
  page,
}) => {
  await start(page);
  await expect(page.locator(".stat")).toHaveCount(4);
  let report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(report.violations).toEqual([]);
  await page.screenshot({
    path: "output/overview-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).toBeHidden();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await nav(page, "Overview");
  await expect(page.locator(".sidebar")).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "output/overview-mobile.png", fullPage: true });
  await role(page, "donor");
  report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(report.violations).toEqual([]);
});
test("CSV preview is required and invalid imports preserve stock", async ({
  page,
}) => {
  await start(page);
  await nav(page, "Inventory & kits");
  await page.getByRole("button", { name: "Import stock", exact: true }).click();
  await page
    .getByLabel("Paste inventory CSV")
    .fill("sku,name,quantity,expiresAt\nrice,=FORMULA(),1,");
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.locator(".error[role=alert]")).toContainText("formula");
  await page
    .getByLabel("Paste inventory CSV")
    .fill("sku,name,quantity,expiresAt\nrice,Rice,12,2027-12-31");
  await page.getByRole("button", { name: "Preview import" }).click();
  await page.getByRole("button", { name: "Confirm 1 lots" }).click();
  await expect(
    page.getByRole("heading", { name: "Usable supplies" }),
  ).toBeVisible();
  await expect(
    page.getByText("Saved. Your workspace is up to date."),
  ).toBeVisible();
});
test("public campaigns expose aggregates and no actor identities", async ({
  page,
}) => {
  await start(page);
  const w = await (await page.request.get("/api/workspace")).json();
  const r = await page.request.get(`/api/campaigns?workspace=${w.id}`);
  const text = await r.text();
  expect(text).toContain("received");
  expect(text).not.toContain("Morgan");
  expect(text).not.toContain("Alex");
  const pending = await command(page, "request", {
    siteId: "hope-main",
    kitId: "kit-hope",
    fundId: "hope-kits",
    target: 50,
    budget: 60000,
    deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    notes: "",
  });
  expect(pending.id).toBeTruthy();
});
test("supplier onboarding and merchant offer entry persist", async ({
  page,
}) => {
  await start(page);
  await nav(page, "Organization");
  await page
    .getByLabel("Supplier name", { exact: true })
    .fill("Neighborhood Wholesale");
  await page.getByLabel("Shipping USD per order").fill("4.50");
  await page.getByRole("button", { name: "Register supplier" }).click();
  await expect(
    page.getByText("Neighborhood Wholesale", { exact: true }),
  ).toBeVisible();
  const row = page
    .locator(".list-row")
    .filter({ hasText: "Neighborhood Wholesale" });
  await row
    .getByRole("button", { name: "Invite supplier representative" })
    .click();
  await expect(
    page.getByLabel("Invitation link — share only with the intended member"),
  ).toHaveValue(/token=/);
  await role(page, "supplier-a");
  await page.getByText("Add a supplier offer", { exact: true }).click();
  await page.getByLabel("Offer SKU").fill("lentils");
  await page
    .getByLabel("Supply name", { exact: true })
    .fill("Shelf-stable lentils");
  await page.getByLabel("Pack price USD", { exact: true }).fill("12.00");
  await page.getByLabel("Verified shelf-stable product").check();
  await page.getByRole("button", { name: "Add offer", exact: true }).click();
  await expect(
    page.getByText("Shelf-stable lentils", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Shelf-stable lentils", { exact: true }),
  ).toBeVisible();
});

async function state(page: Page): Promise<AppView> {
  const response = await page.request.get("/api/workspace");
  expect(response.status()).toBe(200);
  return response.json();
}
async function requestFixture(page: Page) {
  const request = await command(page, "request", {
    siteId: "hope-main", kitId: "kit-hope", fundId: "hope-kits", target: 50,
    budget: 60000, deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), notes: "Synthetic persona fixture",
  });
  return command(page, "propose", { id: request.id });
}

test("donor, finance and public pages agree on net giving after refund", async ({ page }) => {
  await start(page);
  await role(page, "donor");
  await page.getByRole("button", { name: "Continue to simulated approval" }).click();
  await expect(page.getByRole("button", { name: "Simulate payer approval" })).toBeVisible();
  let donor = await state(page);
  expect(donor.campaignReceived["campaign-hope"]).toBe(0);
  await page.getByRole("button", { name: "Simulate payer approval" }).click();
  await expect(page.getByRole("link", { name: "Acknowledgment" })).toBeVisible();
  donor = await state(page);
  expect(donor.campaignReceived["campaign-hope"]).toBe(2500);
  expect(donor.ledger).toEqual([]);
  await nav(page, "Campaigns");
  await expect(page.locator(".campaign-money strong")).toContainText("$25.00");
  const publicAmount = async () => {
    const response = await page.request.get(`/api/campaigns?workspace=${donor.id}`);
    expect(response.status()).toBe(200);
    return (await response.json()).campaigns.find((c: { id: string }) => c.id === "campaign-hope").received;
  };
  expect(await publicAmount()).toBe(2500);
  await role(page, "finance-a");
  await nav(page, "Organization");
  await page.getByRole("button", { name: "Approve donation refund", exact: true }).click();
  await expect(page.getByRole("button", { name: "Simulate confirmed refund", exact: true })).toBeVisible();
  expect(await publicAmount()).toBe(2500);
  await page.getByRole("button", { name: "Simulate confirmed refund", exact: true }).click();
  await expect(page.getByRole("button", { name: "Simulate confirmed refund", exact: true })).toHaveCount(0);
  expect(await publicAmount()).toBe(0);
  const finance = await state(page);
  expect(finance.available["hope-kits"]).toBe(60000);
  expect(finance.ledger.filter((entry) => entry.kind === "donation")).toHaveLength(1);
  expect(finance.ledger.filter((entry) => entry.kind === "donation_refund")).toHaveLength(1);
  await role(page, "donor");
  await nav(page, "Campaigns");
  await expect(page.locator(".campaign-money strong")).toContainText("$0.00");
  expect((await state(page)).ledger).toEqual([]);
  await page.reload();
  await nav(page, "Campaigns");
  await expect(page.locator(".campaign-money strong")).toContainText("$0.00");
});

test("coordinator stock transfer, expired lot, kit restriction and over-distribution preserve boundaries", async ({ page }) => {
  await start(page);
  await role(page, "coordinator-a");
  await nav(page, "Inventory & kits");
  const original = await state(page);
  await page.getByLabel("SKU", { exact: true }).fill("rice");
  await page.getByLabel("Supply name", { exact: true }).fill("Expired test rice");
  await page.getByLabel("Units", { exact: true }).fill("100");
  await page.getByLabel("Expiry (leave blank if unknown)").fill("2020-01-01");
  await page.getByRole("button", { name: "Add lot", exact: true }).click();
  await expect(page.getByText("Expired test rice", { exact: true })).toBeVisible();
  const rice = page.getByRole("row").filter({ has: page.getByText("Rice · 1 lb", { exact: true }) });
  await rice.getByLabel("Transfer Rice · 1 lb to", { exact: true }).selectOption("hope-east");
  await rice.getByLabel("Transfer Rice · 1 lb quantity", { exact: true }).fill("5");
  await rice.getByRole("button", { name: "Transfer", exact: true }).click();
  await expect.poll(async () => (await state(page)).inventory.find((lot) => lot.id === "rice-stock")?.quantity).toBe(25);
  const after = await state(page);
  const transferred = after.inventory.find((lot) => lot.siteId === "hope-east" && lot.sku === "rice")!;
  expect(transferred.quantity).toBe(5);
  expect(transferred.expiresAt).toBe(original.inventory[0].expiresAt);
  expect(after.inventory.filter((lot) => lot.sku === "rice" && lot.expiresAt !== "2020-01-01").reduce((sum, lot) => sum + lot.quantity, 0)).toBe(30);
  await page.getByRole("button", { name: "Distribute", exact: true }).click();
  await page.getByLabel("Kits handed out").fill("50");
  await page.getByRole("button", { name: "Record distribution" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Not enough complete kits");
  expect((await state(page)).distributions).toEqual([]);
  expect((await state(page)).inventory).toEqual(after.inventory);
  await page.getByRole("button", { name: "Kit templates", exact: true }).click();
  await page.getByLabel("Kit name").fill("Synthetic staples kit");
  await page.getByRole("textbox", { name: "Components", exact: true }).fill("rice,Rice,2,shelf-stable\nbeans,Beans,2,shelf-stable");
  await page.getByRole("button", { name: "Save kit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Synthetic staples kit", exact: true })).toBeVisible();
  await nav(page, "Purchasing");
  await page.getByRole("combobox", { name: "Kit", exact: true }).selectOption({ label: "Synthetic staples kit" });
  await page.getByRole("button", { name: "Save purchasing request" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Fund purpose does not match the kit");
  const denied = await state(page);
  expect(denied.requests).toEqual([]);
  expect(denied.ledger).toEqual(original.ledger);
});

test("finance sees a stale approval error after supplier price changes and cannot consume it", async ({ page }) => {
  await start(page);
  const proposal = await requestFixture(page);
  await role(page, "finance-a");
  await nav(page, "Purchasing");
  await page.getByRole("button", { name: "Approve exact basket" }).click();
  await expect(page.getByRole("button", { name: "Reserve funds & create orders" })).toBeVisible();
  await role(page, "supplier-a");
  const rice = page.getByRole("row").filter({ hasText: "Rice · 12 × 1 lb" });
  await rice.getByLabel("Rice · 12 × 1 lb pack price USD", { exact: true }).fill("19.00");
  await rice.getByRole("button", { name: "Update offer" }).click();
  await expect.poll(async () => (await state(page)).catalog.find((offer) => offer.id === "harvest-rice")?.price).toBe(1900);
  await role(page, "finance-a");
  await nav(page, "Purchasing");
  await page.getByRole("button", { name: "Reserve funds & create orders" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("changed");
  const denied = await state(page);
  expect(denied.orders).toEqual([]);
  expect(denied.available["hope-kits"]).toBe(60000);
  expect(denied.reserved["hope-kits"]).toBe(0);
  await page.getByRole("button", { name: "Compare approved offers" }).click();
  await expect.poll(async () => (await state(page)).proposals.length).toBe(2);
  const fresh = (await state(page)).proposals.at(-1)!;
  expect(fresh.digest).not.toBe(proposal.digest);
  // Split packs still beat the $355.10 all-Supply option after this price change:
  // Harvest: 5 rice at $19 + 5 beans at $13.20 + $8 shipping = $169.
  // Supply: 1 rice + 2 beans + 7 oats + 5 soap + $12 shipping = $184.10.
  expect(fresh.total).toBe(35310);
  const approval = await command(page, "approve", { id: fresh.id });
  await command(page, "checkout", { id: approval.id });
  const checkedOut = await state(page);
  expect(checkedOut.orders).toHaveLength(2);
  for (const [supplierId, total] of [["harvest", 16900], ["supply", 18410]] as const) {
    expect(checkedOut.orders.find(order => order.supplierId === supplierId)).toMatchObject({
      supplierId, proposalId: fresh.id, approvalId: approval.id,
      total, status: "awaiting_payer",
    });
  }
  expect(checkedOut.reserved["hope-kits"]).toBe(35310);
  expect(checkedOut.available["hope-kits"]).toBe(24690);
  expect(checkedOut.ledger).toEqual(denied.ledger);
  expect(checkedOut.approvals.find((item) => item.id === approval.id)?.consumed).toBe(true);
});

test("owner publication and member revocation leave finance scoped and revoked sessions denied", async ({ page, browser }) => {
  await start(page);
  await nav(page, "Campaigns");
  await page.getByRole("button", { name: "New campaign", exact: true }).click();
  await page.getByLabel("Campaign title").fill("Synthetic acceptance drive");
  await page.getByLabel("Goal (USD)").fill("1200");
  await page.getByLabel("Kit target").fill("50");
  await page.getByLabel("Campaign story").fill("Synthetic persona acceptance campaign.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("button", { name: "Publish campaign" })).toBeVisible();
  const initial = await state(page);
  const created = initial.campaigns.find((campaign) => campaign.title === "Synthetic acceptance drive")!;
  const publishedIds = async () => {
    const response = await page.request.get(`/api/campaigns?workspace=${initial.id}`);
    return (await response.json()).campaigns.map((campaign: { id: string }) => campaign.id);
  };
  expect(await publishedIds()).not.toContain(created.id);
  await page.getByRole("button", { name: "Publish campaign" }).click();
  await expect.poll(publishedIds).toContain(created.id);
  const card = page.locator(".campaign-card").filter({ hasText: "Synthetic acceptance drive" });
  await card.getByRole("button", { name: "Close campaign" }).click();
  await expect.poll(publishedIds).not.toContain(created.id);
  await role(page, "finance-a");
  await nav(page, "Organization");
  await expect(page.getByRole("button", { name: "Create invitation link" })).toHaveCount(0);
  const denial = await page.request.post("/api/command", { headers: { Origin: origin }, data: {
    command: "invite", data: { role: "owner" }, key: crypto.randomUUID(),
  } });
  expect(denial.status()).toBe(403);
  const member = await browser.newContext({ baseURL: origin });
  try {
    await member.addCookies(await page.context().cookies());
    await role(page, "owner-a");
    await nav(page, "Organization");
    const row = page.locator(".list-row").filter({ hasText: "Jordan · Finance" });
    await row.getByRole("button", { name: "Revoke access", exact: true }).click();
    await expect(row).toHaveCount(0);
    const revoked = await member.request.get(`${origin}/api/workspace`);
    expect(revoked.status()).toBe(401);
    expect((await revoked.json()).error.code).toBe("SESSION_REVOKED");
    expect((await state(page)).actor.role).toBe("owner");
  } finally { await member.close(); }
});

test("owner financial and AI pauses preserve records and resume without enabling providers", async ({ page }) => {
  await start(page);
  const proposal = await requestFixture(page);
  await nav(page, "Organization");
  await page.getByRole("button", { name: "Pause financial actions" }).click();
  await expect(page.getByRole("button", { name: "Resume financial actions" })).toBeVisible();
  await page.getByRole("button", { name: "Pause AI runs" }).click();
  await expect(page.getByRole("button", { name: "Resume AI runs" })).toBeVisible();
  await role(page, "finance-a");
  await nav(page, "Purchasing");
  await expect(page.getByRole("button", { name: "Approve exact basket" })).toBeDisabled();
  const response = await page.request.post("/api/command", { headers: { Origin: origin }, data: {
    command: "approve", data: { id: proposal.id }, key: crypto.randomUUID(),
  } });
  expect(response.status()).toBe(409);
  expect((await response.json()).error.code).toBe("STOPPED");
  expect((await state(page)).orders).toEqual([]);
  await role(page, "donor");
  const giftDenied = await page.request.post("/api/command", { headers: { Origin: origin }, data: {
    command: "donation", data: { campaignId: "campaign-hope", amount: 2500 }, key: crypto.randomUUID(),
  } });
  expect(giftDenied.status()).toBe(409);
  expect((await state(page)).donations).toEqual([]);
  await role(page, "owner-a");
  await nav(page, "Organization");
  await page.getByRole("button", { name: "Resume financial actions" }).click();
  await expect(page.getByRole("button", { name: "Pause financial actions" })).toBeVisible();
  await page.getByRole("button", { name: "Resume AI runs" }).click();
  await expect(page.getByRole("button", { name: "Pause AI runs" })).toBeVisible();
  const resumed = await state(page);
  expect(resumed.modes.ai).toBe("manual");
  expect(resumed.modes.aiPaused).toBe(false);
  expect(resumed.available["hope-kits"]).toBe(60000);
  expect(resumed.approvals).toEqual([]);
});

test("failed supplier refund adds no funds, wrong merchant is denied, and renewed request credits once", async ({ page }) => {
  await start(page);
  const proposal = await requestFixture(page);
  const approval = await command(page, "approve", { id: proposal.id });
  const orders = await command(page, "checkout", { id: approval.id });
  for (const order of orders) await command(page, "capture", { id: order.id });
  await role(page, "supplier-a");
  const rice = page.locator(".list-row").filter({ hasText: "Rice" }).first();
  await rice.locator("input[name=packs]").fill("2");
  await rice.getByRole("button", { name: "Cancel packs" }).click();
  await role(page, "finance-a");
  await nav(page, "Recovery");
  await page.getByRole("button", { name: "Approve & request refund" }).click();
  await expect(page.getByText("The supplier merchant must authorize and issue this refund in their portal.")).toBeVisible();
  const before = await state(page);
  const recovery = before.recoveries[0];
  await role(page, "supplier-b");
  const wrong = await page.request.post("/api/command", { headers: { Origin: origin }, data: {
    command: "confirmRefund", data: { id: recovery.id }, key: crypto.randomUUID(),
  } });
  expect(wrong.status()).toBe(403);
  expect((await wrong.json()).error.code).toBe("MERCHANT");
  await role(page, "supplier-a");
  await page.getByRole("button", { name: "Simulate failed refund" }).click();
  await expect(page.getByText("$36.00 refund · refund_failed", { exact: true })).toBeVisible();
  await role(page, "finance-a");
  const failed = await state(page);
  expect(failed.available["hope-kits"]).toBe(before.available["hope-kits"]);
  expect(failed.ledger).toEqual(before.ledger);
  await nav(page, "Recovery");
  await page.getByRole("button", { name: "Approve & request refund" }).click();
  await role(page, "supplier-a");
  await page.getByRole("button", { name: "Simulate merchant-authorized refund" }).click();
  await expect(page.getByRole("button", { name: "Simulate merchant-authorized refund" })).toHaveCount(0);
  await role(page, "finance-a");
  const final = await state(page);
  expect(final.available["hope-kits"]).toBe(before.available["hope-kits"] + 3600);
  expect(final.ledger.filter((entry) => entry.kind === "purchase_refund")).toHaveLength(1);
});

// Proposed append to tests/browser/journey.spec.ts; reuses its native UI helper.
test("native Studio hides unrecognized upstream diagnostics and preserves records", async ({ page }) => {
  const marker = "SYNTHETIC_PRIVATE_DIAGNOSTIC_MARKER";
  await page.route("**/api/analytics-agent", route => route.fulfill({
    status: 503, json: { error: { code: "UNAVAILABLE", message: marker } },
  }));
  const studio = await openNativeAnalyst(page);
  const before = await (await page.request.get("/api/workspace")).json();
  await studio.getByRole("button", { name: "Review available funds", exact: true }).click();
  await expect(studio.getByText("The analyst is unavailable. Your dashboard is preserved.", { exact: true })).toBeVisible();
  await expect(studio).not.toContainText(marker);
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("readiness");
  const after = await (await page.request.get("/api/workspace")).json();
  for (const field of ["ledger", "inventory", "orders", "approvals", "agentRuns", "dashboards"]) {
    expect(after[field]).toEqual(before[field]);
  }
});
