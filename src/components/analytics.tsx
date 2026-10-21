"use client";
import { useCallback, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
} from "ag-grid-community";
import {
  AgStudio,
  type AgRegistry,
  type AgWidgetDefinition,
} from "ag-studio-react";
import {
  AgStudioLicenseManager,
  AgStudioAiModule,
  AgStudioModuleRegistry,
  createAiHarness,
  type AgAiHarnessSetupParams,
  type AgEditModePanelType,
  studioTheme,
  type AgReportState,
  type AgStudioApi,
} from "ag-studio";
import type { AppView } from "@/lib/types";
import {
  dashboardDefinition,
  analysisPrompts,
  dashboardState,
  studioStateSchema,
  type Focus,
} from "@/lib/dashboard";
import { usd } from "@/lib/money";
import { usableUnits } from "@/lib/inventory";
import { Badge, Field, Panel } from "./ui";
import { pantryStudioAgent } from "@/lib/studio-agent";
import { effectiveDistribution } from "@/lib/correction-totals";
import { analystResponseSchema, dashboardEvidence, evidenceBrief, recommendedFocus } from "@/lib/dashboard-evidence";
ModuleRegistry.registerModules([AllCommunityModule]);
AgStudioModuleRegistry.registerModules([AgStudioAiModule]);
if (process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE)
  AgStudioLicenseManager.setLicenseKey(
    process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE,
  );
interface PantryRegistry extends AgRegistry {
  widgets: readonly AgWidgetDefinition[];
}
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
export default function Analytics({
  w,
  run,
}: {
  w: AppView;
  run: (c: string, d: unknown) => Promise<unknown>;
}) {
  const [focus, setFocus] = useState<Focus>("readiness"),
    [mode, setMode] = useState<"view" | "edit">("view"),
    [prompt, setPrompt] = useState("Show me recovery and funds"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [studioTool, setStudioTool] = useState<AgEditModePanelType>("ai"),
    [studioEnabled, setEnabled] = useState(false);
  const api = useRef<AgStudioApi<PantryRegistry> | null>(null);
  const studioAi = useCallback(
    ({ api: studioApi }: AgAiHarnessSetupParams) =>
      createAiHarness(studioApi, () => ({
        agents: [
          pantryStudioAgent((next) => {
            studioApi.setState(
              dashboardState(next) as AgReportState<PantryRegistry>,
            );
            setFocus(next);
          }),
        ],
        primary: "pantry-analyst",
        promptStarters: analysisPrompts.map((prompt) => ({
          label: prompt,
          prompt,
        })),
      })),
    [],
  );
  const v = values(w);
  const evidence = dashboardEvidence(w);
  const brief = evidenceBrief(focus, evidence);
  const operationalEvidence = (
    <section aria-label="Operational evidence and next step" className="panel">
      <h3>What these records mean</h3>
      <p>{brief.summary}</p>
      <p>{brief.nextStep}</p>
      <p className="fine">Current workspace evidence · deterministic amounts · {w.demo ? "synthetic demo records" : "recorded operations; physical outcomes require verification"}. This explanation works without AI.</p>
      <button className="secondary" onClick={() => select(recommendedFocus(evidence))}>
        Review next attention area
      </button>
    </section>
  );
  const isLocal =
    typeof window !== "undefined" &&
    ["127.0.0.1", "localhost", "::1"].includes(location.hostname);
  const licensed = isLocal || !!process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE;
  const widgets: AgWidgetDefinition[] = Object.entries(v).map(
    ([id, value]) => ({
      id: `pantry-${id}`,
      label: value.title,
      comp: () => (
        <article className="studio-widget">
          <Badge tone="green">
            {w.modes.payments === "simulation"
              ? "SYNTHETIC / SIMULATED"
              : "SANDBOX OPERATIONS"}
          </Badge>
          <h3>{value.title}</h3>
          <strong>{value.value}</strong>
          <p>{value.detail}</p>
        </article>
      ),
      form: () => [],
      defaultSize: { width: 300, height: 220 },
      minSize: { width: 200, height: 160 },
    }),
  );
  function select(next: Focus) {
    setFocus(next);
    if (api.current)
      api.current.setState(
        dashboardState(next) as AgReportState<PantryRegistry>,
      );
  }
  async function save() {
    try {
      const current = api.current?.getState();
      const cleaned = current
        ? {
            pages: current.pages.map((p) => ({
              id: p.id,
              // Metric widgets have no sorting/data-query semantics. Persist our
              // strict document shape, not SDK defaults such as `sort`.
              widgets: Object.fromEntries(
                Object.entries(p.widgets ?? {}).map(([id, widget]) => [
                  id,
                  {
                    type: widget.type,
                    dataMapping: widget.dataMapping,
                    format: widget.format,
                  },
                ]),
              ),
              widgetLayout: p.widgetLayout,
            })),
            selectedPageId: current.selectedPageId,
          }
        : undefined;
      const studio = cleaned ? studioStateSchema.parse(cleaned) : undefined;
      await run("dashboard", {
        name: `${focus} · ${new Date().toLocaleString()}`,
        definition: { focus, period: "all", studio },
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function ask() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/analytics-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await r.json();
      if (!r.ok)
        throw new Error(data.error?.message || "Analyst could not complete.");
      const parsed = analystResponseSchema.parse(data);
      select(parsed.focus);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Panel
        title="Operations, with context"
        subtitle="Each custom widget uses authorized nonprofit records, never a model-invented number."
      >
        <div className="analytics-actions">
          <select
            aria-label="Dashboard focus"
            value={focus}
            onChange={(e) => select(e.target.value as Focus)}
          >
            {["readiness", "funds", "recovery", "evidence"].map((f) => (
              <option key={f} value={f}>
                {f[0].toUpperCase() + f.slice(1)} first
              </option>
            ))}
          </select>
          <button className="secondary" onClick={save}>
            Save current view
          </button>
          <button
            className="secondary"
            disabled={!licensed}
            onClick={() => setEnabled(!studioEnabled)}
          >
            {studioEnabled ? "Close Studio canvas" : "Open AG Studio canvas"}
          </button>
          {studioEnabled && (
            <button
              className="secondary"
              onClick={() => setMode(mode === "view" ? "edit" : "view")}
            >
              {mode === "view" ? "Edit layout" : "View layout"}
            </button>
          )}
          {studioEnabled && mode === "edit" && (
            <select
              aria-label="Studio workspace tools"
              value={studioTool}
              onChange={(e) =>
                setStudioTool(e.target.value as AgEditModePanelType)
              }
            >
              <option value="ai">Dashboard analyst</option>
              <option value="edit">Layout and widgets</option>
              <option value="data">Data fields</option>
              <option value="filters">Page filters</option>
            </select>
          )}
        </div>
        {!licensed && (
          <p className="warning">
            Hosted Studio requires a configured license. The operational grid
            remains available.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!studioEnabled && operationalEvidence}
        {studioEnabled ? (
          <div className="studio-frame">
            <AgStudio<PantryRegistry>
              ai={studioAi}
              aiToolDisplay={{
                selectDashboard: {
                  label: () => ({ text: "Arrange dashboard view" }),
                },
              }}
              panels={{ edit: { left: [studioTool] }, view: { left: [] } }}
              layout={{ minWidth: 360 }}
              mode={mode}
              theme={studioTheme.withParams({
                accentColor: "#176356",
                backgroundColor: "#fcfdf8",
                fontFamily: "Arial, sans-serif",
              })}
              initialState={
                dashboardState(focus) as AgReportState<PantryRegistry>
              }
              widgets={{
                widgets,
                menu: [
                  {
                    label: "Pantry operations",
                    widgetIds: widgets.map((x) => x.id),
                  },
                ],
                defaultType: "pantry-readiness",
              }}
              data={{
                sources: [
                  { id: "ledger", data: w.ledger },
                  { id: "orders", data: w.orders },
                  { id: "inventory", data: w.inventory },
                ],
              }}
              onApiReady={(e) => {
                api.current = e.api as AgStudioApi<PantryRegistry>;
              }}
            />
          </div>
        ) : (
          <div className="stats-grid">
            {[
              focus,
              ...(Object.keys(v) as Focus[]).filter((k) => k !== focus),
            ].map((k) => (
              <article className="studio-widget" key={k}>
                <h3>{v[k].title}</h3>
                <strong>{v[k].value}</strong>
                <p>{v[k].detail}</p>
              </article>
            ))}
          </div>
        )}
        {studioEnabled && operationalEvidence}
        {w.modes.ai === "gemini" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <Field label="Ask the bounded analytics agent">
              <select
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              >
                {analysisPrompts.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
            <button className="primary" disabled={busy}>
              {busy ? "Reviewing…" : "Ask analyst & apply view"}
            </button>
            <p className="fine">
              The agent reads approved synthetic numeric evidence before choosing a view. Amounts and next steps are rendered from verified records. It cannot change money or underlying records.
            </p>
          </form>
        )}
        {studioEnabled && w.modes.ai !== "gemini" && (
          <p className="fine">
            The dashboard analyst needs a configured Gemini connection. You can
            still edit and save views.
          </p>
        )}
      </Panel>
      <Panel title="Saved dashboards">
        {w.dashboards.length ? (
          w.dashboards.map((d) => (
            <div className="list-row" key={d.id}>
              <strong>{d.name}</strong>
              <button
                className="secondary"
                onClick={() => {
                  const parsed = dashboardDefinition.parse(d.definition);
                  setFocus(parsed.focus);
                  if (parsed.studio && api.current)
                    api.current.setState(
                      parsed.studio as AgReportState<PantryRegistry>,
                    );
                  else select(parsed.focus);
                }}
              >
                Load view
              </button>
            </div>
          ))
        ) : (
          <p className="fine">
            Save a focus or edited Studio layout to return to it later.
          </p>
        )}
      </Panel>
      <Panel
        title="Operational ledger explorer"
        subtitle="Sort and filter confirmed ledger entries. All amounts are integer USD cents."
      >
        <div style={{ height: 360 }}>
          <AgGridReact
            theme={themeQuartz.withParams({
              accentColor: "#176356",
              backgroundColor: "#fff",
              fontFamily: "Arial, sans-serif",
            })}
            rowData={w.ledger}
            columnDefs={[
              { field: "kind", headerName: "Event", filter: true },
              {
                field: "amount",
                headerName: "Amount (USD)",
                valueFormatter: (p) => usd(p.value || 0),
                filter: "agNumberColumnFilter",
              },
              { field: "evidence", headerName: "Evidence", filter: true },
              { field: "source", headerName: "Source", filter: true },
              { field: "createdAt", headerName: "Recorded at", filter: true },
            ]}
            defaultColDef={{
              sortable: true,
              resizable: true,
              flex: 1,
              minWidth: 120,
            }}
          />
        </div>
      </Panel>
    </>
  );
}
