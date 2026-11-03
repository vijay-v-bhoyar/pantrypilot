"use client";
import { useEffect, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import type { AppView } from "@/lib/types";
import { analysisPrompts, dashboardDefinition, type Focus } from "@/lib/dashboard";
import { usd } from "@/lib/money";
import { usableUnits } from "@/lib/inventory";
import { Field, Panel } from "./ui";
import { pantryStudioAgent } from "@/lib/studio-agent";
import { effectiveDistribution } from "@/lib/correction-totals";
import { dashboardEvidence, evidenceBrief, recommendedFocus } from "@/lib/dashboard-evidence";
ModuleRegistry.registerModules([AllCommunityModule]);
function values(w: AppView) {
  const kit = w.kits[0];
  const ready = kit && w.organizations[0].sites[0]
    ? Math.min(
        ...kit.components.map((c) =>
          Math.floor(
            usableUnits(
              w,
              w.actor.organizationId,
              w.organizations[0].sites[0].id,
              c.sku,
            ) / c.quantity,
          ),
        ),
      )
    : 0;
  return {
    readiness: {
      title: "Complete kits on hand",
      value: String(ready),
      detail: "Usable stock at the primary site. Planned kits remain separate.",
    },
    funds: {
      title: "Available purpose-aware funds",
      value: usd(Object.values(w.available).reduce((s, n) => s + n, 0)),
      detail: `${usd(Object.values(w.reserved).reduce((s, n) => s + n, 0))} reserved. Pending refunds excluded.`,
    },
    recovery: {
      title: "Unconfirmed recovery value",
      value: usd(
        w.recoveries
          .filter((r) =>
            ["opened", "refund_requested", "refund_pending"].includes(r.status),
          )
          .reduce((s, r) => s + r.amount, 0),
      ),
      detail: "Cancelled supplies waiting for a merchant-confirmed refund.",
    },
    evidence: {
      title: "Recorded kit distributions",
      value: String(w.distributions.reduce((s, d) => s + effectiveDistribution(d, w.stockCorrections), 0)),
      detail: `${w.orders.filter((o) => o.status === "received").length} received shipments. Sandbox payments do not prove community impact.`,
    },
  };
}
export default function Analytics({ w, run }: {
  w: AppView; run: (command: string, data: unknown) => Promise<unknown>;
}) {
  const [focus, setFocus] = useState<Focus>("readiness");
  const [prompt, setPrompt] = useState<string>(analysisPrompts[0]);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const v = values(w), evidence = dashboardEvidence(w), brief = evidenceBrief(focus, evidence);
  function select(next: Focus) { setFocus(next); }
  async function save() {
    setError("");
    try {
      await run("dashboard", { name: `${focus} · ${new Date().toLocaleString()}`,
        definition: { focus, period: "all" } });
    } catch { setError("The view could not be saved. Your existing views are preserved."); }
  }
  async function ask() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(""); setAnswer("");
    try {
      // Reuse the existing validated, cancellation-aware server adapter, without a vendor UI harness.
      const agent = pantryStudioAgent((next) => { if (!controller.signal.aborted) select(next); });
      for await (const event of agent.run({ threadId: crypto.randomUUID(), runId: crypto.randomUUID(),
        messages: [{ id: crypto.randomUUID(), role: "user", content: prompt }],
        tools: [], context: [], state: {}, forwardedProps: {} },
      { params: undefined, instructions: () => undefined, tools: () => [], signal: controller.signal })) {
        if (controller.signal.aborted || active.current !== controller) break;
        if (event.type === "RUN_ERROR") setError(event.message);
        if (event.type === "TEXT_MESSAGE_CONTENT") setAnswer((text) => text + event.delta);
      }
    } catch {
      if (!controller.signal.aborted) setError("The analyst could not complete. Your current view is preserved.");
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }
  return <>
    <Panel title="Operations, with context"
      subtitle="Review verified records, save a focus, and inspect the ledger.">
      <div className="analytics-actions">
        <select aria-label="Dashboard focus" value={focus} disabled={busy}
          onChange={(event) => { setNotice(""); select(event.target.value as Focus); }}>
          {(["readiness", "funds", "recovery", "evidence"] as Focus[]).map((item) =>
            <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)} first</option>)}
        </select>
        <button className="secondary" onClick={save} disabled={busy}>Save current view</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <section aria-label="Operational evidence and next step" className="panel">
        <h3>What these records mean</h3><p>{brief.summary}</p><p>{brief.nextStep}</p>
        <p className="fine">Current workspace evidence · deterministic amounts · {w.demo ? "synthetic demo records" : "recorded operations; physical outcomes require verification"}.</p>
        <p className="fine">This explanation works without AI.</p>
        <button className="secondary" disabled={busy} onClick={() => select(recommendedFocus(evidence))}>Review next attention area</button>
      </section>
      <div className="stats-grid">
        {[focus, ...(Object.keys(v) as Focus[]).filter((item) => item !== focus)].map((item) =>
          <article className="studio-widget" key={item}><h3>{v[item].title}</h3>
            <strong>{v[item].value}</strong><p>{v[item].detail}</p></article>)}
      </div>
      {w.modes.ai === "gemini" && <form onSubmit={(event) => { event.preventDefault(); void ask(); }}>
        <Field label="Ask the bounded analytics agent">
          <select value={prompt} disabled={busy} onChange={(event) => setPrompt(event.target.value)}>
            {analysisPrompts.map((item) => <option key={item}>{item}</option>)}
          </select>
        </Field>
        <button className="primary" disabled={busy}>{busy ? "Reviewing…" : "Ask analyst & apply view"}</button>
        {busy && <button type="button" className="secondary" onClick={() => active.current?.abort()}>Cancel analysis</button>}
        <p className="fine">The analyst reviews scoped evidence and selects a view. It cannot change money or operational records.</p>
      </form>}
      {answer && <section aria-label="Analyst response" role="status">{answer}</section>}
    </Panel>
    <Panel title="Saved dashboards">
      {w.dashboards.length ? w.dashboards.map((dashboard) => <div className="list-row" key={dashboard.id}>
        <strong>{dashboard.name}</strong><button className="secondary" disabled={busy} onClick={() => {
          try {
            const parsed = dashboardDefinition.parse(dashboard.definition); select(parsed.focus);
            setNotice(parsed.studio ? "This saved view includes a layout unavailable in this version. Its focus was loaded; the original saved view is unchanged." : "");
          } catch { setError("This saved view could not be loaded. The original record is preserved."); }
        }}>Load view</button>
      </div>) : <p className="fine">Save a focus to return to it later.</p>}
    </Panel>
    <Panel title="Operational ledger explorer" subtitle="Sort and filter confirmed ledger entries. All amounts are integer USD cents.">
      <div style={{ height: 360 }}><AgGridReact
        theme={themeQuartz.withParams({ accentColor: "#176356", backgroundColor: "#fff", fontFamily: "Arial, sans-serif" })}
        rowData={w.ledger}
        columnDefs={[
          { field: "kind", headerName: "Event", filter: true },
          { field: "amount", headerName: "Amount (USD)", valueFormatter: (params) => usd(params.value || 0), filter: "agNumberColumnFilter" },
          { field: "evidence", headerName: "Evidence", filter: true },
          { field: "source", headerName: "Source", filter: true },
          { field: "createdAt", headerName: "Recorded at", filter: true },
        ]}
        defaultColDef={{ sortable: true, resizable: true, floatingFilter: true, flex: 1, minWidth: 120 }}
      /></div>
    </Panel>
  </>;
}
