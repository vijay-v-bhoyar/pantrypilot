import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedWorkspace } from "@/lib/seed";
import { execute, view } from "@/lib/commands";
import { balances } from "@/lib/money";
import { settleCapture, settleRefund, paymentAction } from "@/lib/payments";
import { verifyEvent } from "@/lib/paypal";
import { createWorkspace, loadWorkspace, withWorkspace } from "@/lib/storage";
import type {
  Approval,
  Donation,
  Order,
  Proposal,
  PurchaseRequest,
} from "@/lib/types";
let w = seedWorkspace(),
  root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-provider-test-"));
  vi.stubEnv("PANTRYPILOT_DATA_DIR", root);
  vi.stubEnv("STORAGE_MODE", "local");
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("PAYMENTS_MODE", "sandbox");
  vi.stubEnv("PROVIDER_ACTIONS_ENABLED", "true");
  vi.stubEnv(
    "PAYPAL_MERCHANTS_JSON",
    JSON.stringify({
      hope: {
        clientId: "test-client",
        secret: "test-only",
        merchantId: "merchant-hope",
        webhookId: "test-hook",
      },
      harvest: {
        clientId: "test-client",
        secret: "test-only",
        merchantId: "merchant-harvest",
      },
      supply: {
        clientId: "test-client",
        secret: "test-only",
        merchantId: "merchant-supply",
      },
    }),
  );
  w = seedWorkspace();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
function donation() {
  const d = execute(
    w,
    "donor",
    "donation",
    { campaignId: "campaign-hope", amount: 2500 },
    randomUUID(),
  ) as Donation;
  d.providerId = "ORDER-ONE";
  return d;
}
function capture(d: Donation) {
  return {
    id: "ORDER-ONE",
    status: "COMPLETED",
    purchase_units: [
      {
        custom_id: `${w.id}:${d.id}`,
        payee: { merchant_id: "merchant-hope" },
        amount: { currency_code: "USD", value: "25.00" },
        payments: {
          captures: [
            {
              id: "CAPTURE-ONE",
              status: "COMPLETED",
              amount: { currency_code: "USD", value: "25.00" },
              seller_receivable_breakdown: {
                net_amount: { currency_code: "USD", value: "23.81" },
              },
            },
          ],
        },
      },
    ],
  };
}
describe("local provider contract fixtures (not live PayPal)", () => {
  it("persists uncertain capture after donor access is revoked mid-request", async () => {
    const d = donation();
    await createWorkspace(w);
    const mocked = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "test-token" }))
      .mockImplementationOnce(async () => {
        await withWorkspace(w.id, (state) => {
          execute(state, "owner-a", "revoke", { id: "donor" }, randomUUID());
        });
        throw new Error("network timeout");
      });
    vi.stubGlobal("fetch", mocked);
    await expect(
      paymentAction(
        {
          workspaceId: w.id,
          actorId: "donor",
          expiresAt: Date.now() + 10000,
          nonce: "test",
        },
        d.id,
        "capture",
      ),
    ).rejects.toThrow("timeout");
    const state = await loadWorkspace(w.id);
    expect(state.paymentOperations[0].status).toBe("uncertain");
    expect(state.donations[0].status).toBe("uncertain");
  });
  it("retires a confirmed uncaptured checkout with readback and prevents later capture", async () => {
    const d = donation();
    await createWorkspace(w);
    const data = capture(d);
    data.status = "APPROVED";
    data.purchase_units[0].payments.captures = [];
    const mocked = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "test-token" }))
      .mockResolvedValueOnce(Response.json(data));
    vi.stubGlobal("fetch", mocked);
    const s = {
      workspaceId: w.id,
      actorId: "donor",
      expiresAt: Date.now() + 10000,
      nonce: "test",
    };
    await paymentAction(s, d.id, "cancel");
    expect((await loadWorkspace(w.id)).donations[0].status).toBe("cancelled");
    await expect(paymentAction(s, d.id, "capture")).rejects.toThrow();
    expect(
      mocked.mock.calls.filter((c) => String(c[0]).endsWith("/capture")),
    ).toHaveLength(0);
  });
  it("never retires checkout while a capture is unresolved", async () => {
    const d = donation();
    w.paymentOperations.push({
      id: randomUUID(),
      subjectId: d.id,
      action: "capture",
      profile: "hope",
      requestId: randomUUID(),
      status: "uncertain",
      createdAt: new Date().toISOString(),
    });
    await createWorkspace(w);
    const mocked = vi.fn();
    vi.stubGlobal("fetch", mocked);
    await expect(
      paymentAction(
        {
          workspaceId: w.id,
          actorId: "donor",
          expiresAt: Date.now() + 10000,
          nonce: "test",
        },
        d.id,
        "cancel",
      ),
    ).rejects.toThrow("in flight");
    expect(mocked).not.toHaveBeenCalled();
    expect((await loadWorkspace(w.id)).donations[0].status).toBe(
      "awaiting_payer",
    );
  });
  it("keeps captured funds intact if retirement readback finds a completed payment", async () => {
    const d = donation();
    await createWorkspace(w);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ access_token: "test-token" }))
        .mockResolvedValueOnce(Response.json(capture(d))),
    );
    await expect(
      paymentAction(
        {
          workspaceId: w.id,
          actorId: "donor",
          expiresAt: Date.now() + 10000,
          nonce: "test",
        },
        d.id,
        "cancel",
      ),
    ).rejects.toThrow("captured");
    expect((await loadWorkspace(w.id)).donations[0].status).toBe(
      "awaiting_payer",
    );
  });
  it("validates monthly sale refunds against the original billing capture", () => {
    const d = donation();
    settleCapture(w, "hope", d.id, capture(d));
    d.subscriptionId = "MONTHLY";
    d.status = "refund_pending";
    const data = {
      id: "LEGACY-REFUND",
      state: "completed",
      sale_id: d.captureId,
      amount: { currency: "USD", total: "25.00" },
    };
    expect(() =>
      settleRefund(w, "hope", d.id, { ...data, sale_id: "OTHER" }),
    ).toThrow("original billing");
    settleRefund(w, "hope", d.id, data);
    settleRefund(w, "hope", d.id, data);
    expect(d.status).toBe("refunded");
    expect(balances(w, "hope-kits").posted).toBe(59881);
  });
  it("posts confirmed net receipts and suppresses duplicate posting", () => {
    const d = donation();
    settleCapture(w, "hope", d.id, capture(d));
    settleCapture(w, "hope", d.id, capture(d));
    expect(balances(w, "hope-kits").posted).toBe(62381);
    expect(w.ledger.filter((l) => l.subjectId === d.id)).toHaveLength(1);
  });
  it("rejects a wrong merchant, reference, order or capture amount", () => {
    const d = donation();
    const cases = [
      { ...capture(d), id: "OTHER" },
      capture(d),
      capture(d),
      capture(d),
    ];
    cases[1].purchase_units[0].payee.merchant_id = "another-merchant";
    cases[2].purchase_units[0].custom_id = "another-workspace";
    cases[3].purchase_units[0].payments.captures[0].amount.value = "250.00";
    for (const data of cases)
      expect(() => settleCapture(w, "hope", d.id, data)).toThrow();
    expect(balances(w, "hope-kits").posted).toBe(60000);
  });
  it("keeps pending capture or missing net amount out of the ledger", () => {
    const d = donation();
    const data = capture(d);
    data.purchase_units[0].payments.captures[0].status = "PENDING";
    expect(() => settleCapture(w, "hope", d.id, data)).toThrow(
      "completed capture",
    );
    const missing = capture(d);
    delete (
      missing.purchase_units[0].payments.captures[0] as {
        seller_receivable_breakdown?: unknown;
      }
    ).seller_receivable_breakdown;
    expect(() => settleCapture(w, "hope", d.id, missing)).toThrow(
      "Net donation",
    );
    expect(w.ledger).toHaveLength(2);
  });
  it("requires signed webhook headers before provider verification", async () => {
    await expect(
      verifyEvent("hope", new Headers(), { id: "EVENT" }),
    ).rejects.toThrow("signature");
  });
  it("rejects a hostile certificate URL without fetching it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const headers = new Headers({
      "paypal-auth-algo": "SHA256",
      "paypal-cert-url": "https://attacker.example/cert",
      "paypal-transmission-id": "event",
      "paypal-transmission-sig": "signature",
      "paypal-transmission-time": "time",
    });
    await expect(verifyEvent("hope", headers, {})).rejects.toThrow(
      "certificate",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires the verification API to return SUCCESS", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ access_token: "test-token" }))
        .mockResolvedValueOnce(
          Response.json({ verification_status: "FAILURE" }),
        ),
    );
    const headers = new Headers({
      "paypal-auth-algo": "SHA256",
      "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
      "paypal-transmission-id": "event",
      "paypal-transmission-sig": "signature",
      "paypal-transmission-time": "time",
    });
    await expect(verifyEvent("hope", headers, {})).rejects.toThrow(
      "could not verify",
    );
  });
  it("keeps a pending refund reserved then posts a confirmed refund exactly once", () => {
    const d = donation();
    settleCapture(w, "hope", d.id, capture(d));
    d.status = "refund_pending";
    settleRefund(w, "hope", d.id, {
      id: "REFUND",
      status: "PENDING",
      amount: { currency_code: "USD", value: "25.00" },
    });
    expect(balances(w, "hope-kits").reserved).toBe(2500);
    settleRefund(w, "hope", d.id, {
      id: "REFUND",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "25.00" },
    });
    settleRefund(w, "hope", d.id, {
      id: "REFUND",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "25.00" },
    });
    expect(balances(w, "hope-kits").posted).toBe(59881);
  });
  it("persists a timeout as uncertain and uses readback rather than duplicate capture", async () => {
    const d = donation();
    await createWorkspace(w);
    const mocked = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "test-token" }))
      .mockRejectedValueOnce(
        new Error("timeout after provider processed request"),
      );
    vi.stubGlobal("fetch", mocked);
    const s = {
      workspaceId: w.id,
      actorId: "donor",
      expiresAt: Date.now() + 100000,
      nonce: "test",
    };
    await expect(paymentAction(s, d.id, "capture")).rejects.toThrow("timeout");
    const interrupted = await loadWorkspace(w.id);
    expect(interrupted.donations[0].status).toBe("uncertain");
    expect(interrupted.paymentOperations[0].status).toBe("uncertain");
    await expect(paymentAction(s, d.id, "capture")).rejects.toThrow(
      "reconciliation",
    );
    mocked
      .mockResolvedValueOnce(Response.json({ access_token: "test-token" }))
      .mockResolvedValueOnce(Response.json(capture(d)));
    await paymentAction(s, d.id, "reconcile");
    const recovered = await loadWorkspace(w.id);
    expect(recovered.donations[0].status).toBe("confirmed");
    expect(balances(recovered, "hope-kits").posted).toBe(62381);
    expect(
      mocked.mock.calls.filter((c) => String(c[0]).endsWith("/capture")),
    ).toHaveLength(1);
  });
  it("denies the buyer invoking a supplier refund directly", async () => {
    const r = execute(
      w,
      "owner-a",
      "request",
      {
        siteId: "hope-main",
        kitId: "kit-hope",
        fundId: "hope-kits",
        target: 50,
        budget: 60000,
        deadline: new Date(Date.now() + 7 * 86400000)
          .toISOString()
          .slice(0, 10),
        notes: "",
      },
      randomUUID(),
    ) as PurchaseRequest;
    const p = execute(
      w,
      "owner-a",
      "propose",
      { id: r.id },
      randomUUID(),
    ) as Proposal;
    const a = execute(
      w,
      "owner-a",
      "approve",
      { id: p.id },
      randomUUID(),
    ) as Approval;
    const o = (
      execute(w, "owner-a", "checkout", { id: a.id }, randomUUID()) as Order[]
    )[0];
    o.captureId = "CAPTURE";
    o.status = "paid";
    await createWorkspace(w);
    await expect(
      paymentAction(
        {
          workspaceId: w.id,
          actorId: "owner-a",
          expiresAt: Date.now() + 10000,
          nonce: "test",
        },
        o.id,
        "refund",
      ),
    ).rejects.toThrow("Buyer cannot");
  });
  it("respects a nonprofit financial stop independently of another nonprofit", async () => {
    execute(w, "owner-a", "stop", { enabled: false }, randomUUID());
    expect(() =>
      execute(
        w,
        "donor",
        "donation",
        { campaignId: "campaign-hope", amount: 100 },
        randomUUID(),
      ),
    ).toThrow("paused");
    expect(() =>
      execute(
        w,
        "owner-b",
        "request",
        {
          siteId: "river-main",
          kitId: "kit-river",
          fundId: "river-kits",
          target: 10,
          budget: 10000,
          deadline: new Date(Date.now() + 7 * 86400000)
            .toISOString()
            .slice(0, 10),
          notes: "",
        },
        randomUUID(),
      ),
    ).not.toThrow();
    await createWorkspace(w);
    await withWorkspace(w.id, (state) => {
      expect(state.audit.filter((a) => a.action === "stop")).toHaveLength(1);
    });
  });
});

// Proposed append to tests/paypal.test.ts after approval; add view to the
// existing @/lib/commands import. Reuses its scoped fake-key/temp-data setup.
it.each(["capture", "refund"] as const)("redacts uncertain %s diagnostics while preserving operation and money state", async action => {
  const d = donation();
  if (action === "refund") {
    settleCapture(w,"hope",d.id,capture(d));
    execute(w,"finance-a","donationRefund",{id:d.id},randomUUID());
  }
  await createWorkspace(w);
  const marker = "SYNTHETIC_PRIVATE_PAYMENT_DIAGNOSTIC";
  const mocked = vi.fn()
    .mockResolvedValueOnce(Response.json({access_token:"fixture-token"}))
    .mockRejectedValueOnce(new Error(marker));
  vi.stubGlobal("fetch",mocked);
  await expect(paymentAction({workspaceId:w.id,actorId:action==="refund"?"finance-a":"donor",nonce:"fixture",expiresAt:Date.now()+60000},d.id,action)).rejects.toThrow(marker);
  const saved = await loadWorkspace(w.id);
  expect(saved.paymentOperations).toHaveLength(1);
  expect(saved.paymentOperations[0]).toMatchObject({subjectId:d.id,action,profile:"hope",status:"uncertain",error:"Provider outcome unknown. Reconcile the existing operation before retrying."});
  expect(saved.paymentOperations[0].id).toBeTruthy();
  expect(saved.paymentOperations[0].requestId).toBeTruthy();
  expect(saved.audit.find(a=>a.action==="paypal_uncertain")?.detail).toBe("Provider outcome unknown. Reconcile the existing operation before retrying.");
  expect(JSON.stringify(saved)).not.toContain(marker);
  for (const actor of ["owner-a","finance-a","coordinator-a","owner-b","supplier-a","donor"])
    expect(JSON.stringify(view(saved,actor))).not.toContain(marker);
  expect(saved.donations[0].status).toBe(action==="refund"?"refund_pending":"uncertain");
  expect(balances(saved,"hope-kits").posted).toBe(action==="refund"?62381:60000);
  expect(balances(saved,"hope-kits").reserved).toBe(action==="refund"?2500:0);
  expect(saved.ledger.filter(l=>l.kind==="donation_refund")).toHaveLength(0);
  expect(mocked.mock.calls.filter(c=>String(c[0]).endsWith(action==="refund"?"/refund":"/capture"))).toHaveLength(1);
});

// Proposed additions after approval. Existing tests remain unchanged.
// tests/paypal.test.ts: reuse its fake keys/temp storage and donation/capture.
function retirementSubject(kind: "donation" | "order") {
  if (kind === "donation") return {subject:donation(),profile:"hope",actor:"donor"};
  const request = execute(w,"coordinator-a","request",{siteId:"hope-main",kitId:"kit-hope",fundId:"hope-kits",target:50,budget:60000,deadline:new Date(Date.now()+7*86400000).toISOString().slice(0,10),notes:"Retirement readback regression"},randomUUID()) as PurchaseRequest;
  const proposal = execute(w,"coordinator-a","propose",{id:request.id},randomUUID()) as Proposal;
  const approval = execute(w,"finance-a","approve",{id:proposal.id},randomUUID()) as Approval;
  execute(w,"finance-a","checkout",{id:approval.id},randomUUID());
  const subject = w.orders.find(o=>o.supplierId==="harvest")!;subject.providerId="ORDER-ONE";
  return {subject,profile:"harvest",actor:"finance-a"};
}
function retirementCapture(subject: Donation | Order, profile: string) {
  const amount="amount" in subject?subject.amount:subject.total;
  return {id:subject.providerId,status:"COMPLETED",purchase_units:[{custom_id:`${w.id}:${subject.id}`,payee:{merchant_id:`merchant-${profile}`},amount:{currency_code:"USD",value:(amount/100).toFixed(2)},payments:{captures:[{id:"CAPTURE-ONE",status:"COMPLETED",amount:{currency_code:"USD",value:(amount/100).toFixed(2)},seller_receivable_breakdown:{net_amount:{currency_code:"USD",value:profile==="hope"?"23.81":(amount/100).toFixed(2)}}}]}}]};
}
it.each(["donation","order"] as const)("reconciles completed %s capture after retirement was refused",async kind=>{
  const {subject,profile,actor}=retirementSubject(kind),data=retirementCapture(subject,profile);await createWorkspace(w);
  const mocked=vi.fn(async(url:string)=>Response.json(url.endsWith("/token")?{access_token:"fixture-token"}:data));vi.stubGlobal("fetch",mocked);
  const s={workspaceId:w.id,actorId:actor,nonce:"fixture",expiresAt:Date.now()+60000};
  await expect(paymentAction(s,subject.id,"cancel")).rejects.toThrow("captured");
  await paymentAction(s,subject.id,"reconcile");await paymentAction(s,subject.id,"reconcile");
  const saved=await loadWorkspace(w.id);const target=saved.orders.find(o=>o.id===subject.id)??saved.donations.find(d=>d.id===subject.id)!;
  expect(target.status).toBe(kind==="order"?"paid":"confirmed");
  expect(saved.ledger.filter(l=>l.subjectId===subject.id)).toHaveLength(1);
  expect(saved.paymentOperations.find(o=>o.subjectId===subject.id&&o.action==="cancel")?.status).toBe("failed");
  expect(mocked.mock.calls.filter(c=>String(c[0]).endsWith("/capture"))).toHaveLength(0);
  if(kind==="order") { expect(balances(saved,"hope-kits")).toEqual({posted:43600,reserved:18410,available:25190});expect(saved.stockReservations.every(r=>!r.released)).toBe(true); }
  else expect(balances(saved,"hope-kits").posted).toBe(62381);
});
it.each(["PENDING","FAILED"])("keeps %s capture unresolved after refused retirement",async status=>{
  const {subject,profile,actor}=retirementSubject("donation"),data=retirementCapture(subject,profile);data.purchase_units[0].payments.captures[0].status=status;await createWorkspace(w);
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>Response.json(url.endsWith("/token")?{access_token:"fixture-token"}:data)));
  const s={workspaceId:w.id,actorId:actor,nonce:"fixture",expiresAt:Date.now()+60000};await expect(paymentAction(s,subject.id,"cancel")).rejects.toThrow();await expect(paymentAction(s,subject.id,"reconcile")).rejects.toThrow();
  expect((await loadWorkspace(w.id)).ledger).toEqual(w.ledger);
});
it.each(["resource","merchant","amount","missing-net"])("rejects completed retirement readback with %s mismatch",async field=>{
  const {subject,profile,actor}=retirementSubject("donation"),data=retirementCapture(subject,profile);await createWorkspace(w);
  let reads=0;vi.stubGlobal("fetch",vi.fn(async(url:string)=>{if(url.endsWith("/token"))return Response.json({access_token:"fixture-token"});reads++;if(reads===1)return Response.json(data);const bad=structuredClone(data);if(field==="resource")bad.id="OTHER";if(field==="merchant")bad.purchase_units[0].payee.merchant_id="OTHER";if(field==="amount")bad.purchase_units[0].payments.captures[0].amount.value="26.00";if(field==="missing-net")delete (bad.purchase_units[0].payments.captures[0] as {seller_receivable_breakdown?:unknown}).seller_receivable_breakdown;return Response.json(bad);}));
  const s={workspaceId:w.id,actorId:actor,nonce:"fixture",expiresAt:Date.now()+60000};await expect(paymentAction(s,subject.id,"cancel")).rejects.toThrow();await expect(paymentAction(s,subject.id,"reconcile")).rejects.toThrow();expect((await loadWorkspace(w.id)).ledger).toEqual(w.ledger);
});

