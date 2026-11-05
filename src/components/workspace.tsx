"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Boxes,
  ChartNoAxesCombined,
  CircleHelp,
  ClipboardCheck,
  HeartHandshake,
  LayoutDashboard,
  Leaf,
  Menu,
  PackageCheck,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  ShoppingBasket,
  Sprout,
  Truck,
  Undo2,
  X,
} from "lucide-react";
import type { AppView, Proposal, Role } from "@/lib/types";
import { usd } from "@/lib/money";
import { usableUnits } from "@/lib/inventory";
import { previewInventoryCsv } from "@/lib/csv";
import { Badge, Empty, Field, Panel, Progress, Stat } from "./ui";
import WorkflowGuide from "./workflow-guide";
import StockCorrections from "./stock-corrections";
import { effectiveDistribution } from "@/lib/correction-totals";
const Analytics = dynamic(() => import("./analytics"), {
  ssr: false,
  loading: () => <p className="loading">Loading your analytics workspace…</p>,
});
type Section =
  | "overview"
  | "campaigns"
  | "inventory"
  | "procurement"
  | "recovery"
  | "supplier"
  | "donor"
  | "analytics"
  | "settings"
  | "audit";
type Run = (command: string, data: unknown) => Promise<unknown>;
const nav = [
  { id: "overview", title: "Overview", Icon: LayoutDashboard },
  { id: "campaigns", title: "Campaigns", Icon: HeartHandshake },
  { id: "inventory", title: "Inventory & kits", Icon: Boxes },
  { id: "procurement", title: "Purchasing", Icon: ShoppingBasket },
  { id: "recovery", title: "Recovery", Icon: Undo2 },
  { id: "analytics", title: "Analytics studio", Icon: ChartNoAxesCombined },
  { id: "supplier", title: "Supplier portal", Icon: Truck },
  { id: "donor", title: "My giving", Icon: Leaf },
  { id: "audit", title: "Activity", Icon: Activity },
  { id: "settings", title: "Organization", Icon: Settings },
] as const;
const demos = [
  ["owner-a", "Morgan · Hope owner"],
  ["finance-a", "Jordan · Hope finance"],
  ["coordinator-a", "Sam · Hope coordinator"],
  ["supplier-a", "Avery · Harvest supplier"],
  ["supplier-b", "Casey · Supply supplier"],
  ["donor", "Alex · Hope donor"],
  ["owner-b", "Taylor · River owner"],
];
export default function WorkspaceApp() {
  const router = useRouter();
  const sessionClosed = useRef(false);
  const [w, setW] = useState<AppView | null>(null),
    [section, setSection] = useState<Section>("overview"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [mobile, setMobile] = useState(false);
  const refresh = useCallback(async () => {
    const r = await fetch("/api/workspace", { cache: "no-store" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || "Workspace unavailable.");
    if (!sessionClosed.current) setW(data);
  }, []);
  useEffect(() => {
    let active = true;
    fetch("/api/workspace", { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok)
          throw new Error(data.error?.message || "Workspace unavailable.");
        if (active && !sessionClosed.current) {
          setW(data);
          if (data.actor.role === "donor") setSection("donor");
          if (data.actor.role === "supplier") setSection("supplier");
        }
      })
      .catch((e) => {
        if (active && !sessionClosed.current) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const action = async (endpoint: string, data: unknown) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await r.json();
      if (!r.ok)
        throw new Error(
          result.error?.message || "The request could not complete.",
        );
      await refresh();
      if (!sessionClosed.current) setNotice("Saved. Your workspace is up to date.");
      return result;
    } catch (e) {
      if (!sessionClosed.current) setError(e instanceof TypeError
        ? "We could not confirm whether this action completed. Use Refresh workspace and check the existing record before trying again."
        : (e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const run: Run = (command, data) =>
    action("/api/command", { command, data, key: crypto.randomUUID() });
  const pay = async (id: string, command: string, provider: string) => {
    const result = await (w?.modes.payments === "simulation"
      ? run(command, { id })
      : action("/api/payment", { id, action: provider }));
    const link = (result as { approvalUrl?: string })?.approvalUrl;
    if (link && ["create", "subscription"].includes(provider))
      window.open(link, "_blank", "noopener,noreferrer");
    return result;
  };
  async function signOut() {
    sessionClosed.current = true;
    setW(null);
    setNotice("");
    setError("");
    const uncertain = "We could not confirm sign-out. Another copy of this session may remain active. Contact your workspace owner before continuing.";
    try {
      const response = await fetch("/api/logout", { method: "POST" });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.signedOut !== true) {
        setW(null);
        setError(result?.error?.code === "LOGOUT_UNCONFIRMED"
          ? "Browser credentials cleared, but server session revocation could not be confirmed. Contact your workspace owner before continuing."
          : uncertain);
        return;
      }
      setW(null);
      router.push("/");
    } catch {
      setW(null);
      setError(uncertain);
    }
  }
  async function switchActor(id: string) {
    try {
      await action("/api/demo", { actorId: id });
      setSection(
        id.startsWith("supplier")
          ? "supplier"
          : id === "donor"
            ? "donor"
            : "overview",
      );
    } catch {}
  }
  const allowed = (id: Section, role: Role) =>
    role === "donor"
      ? ["donor", "campaigns"].includes(id)
      : role === "supplier"
        ? id === "supplier"
        : [
            "overview",
            "campaigns",
            "inventory",
            "procurement",
            "recovery",
            "analytics",
            "audit",
          ].includes(id) ||
          (["owner", "finance"].includes(role) && id === "settings");
  if (!w)
    return (
      <main className="welcome-loading">
        <Sprout size={36} />
        <h1>PantryPilot</h1>
        {error ? (
          <>
            <p role="alert" className="error">
              {error}
            </p>
            <Link className="primary" href="/">
              Start an isolated demo
            </Link>
            <a className="secondary" href="/api/auth/login">
              Sign in with Google
            </a>
          </>
        ) : (
          <p>Opening your pantry workspace…</p>
        )}
      </main>
    );
  const org = w.organizations[0];
  const title = nav.find((n) => n.id === section)?.title || "Overview";
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
        <div className="sidebar-brand">
          <Link className="brand" href="/">
            <span className="brandmark">
              <Sprout size={23} />
            </span>
            PantryPilot
          </Link>
          <button
            className="mobile-close icon-button"
            aria-label="Close navigation"
            onClick={() => setMobile(false)}
          >
            <X />
          </button>
        </div>
        <div className="org-card">
          <span className="org-initial">{org.name[0]}</span>
          <div>
            <strong>{org.name}</strong>
            <small>
              {org.sites.length} pantry{" "}
              {org.sites.length === 1 ? "site" : "sites"}
            </small>
          </div>
        </div>
        <span className="nav-label">YOUR WORKSPACE</span>
        <nav>
          {nav
            .filter((n) => allowed(n.id, w.actor.role))
            .map(({ id, title, Icon }) => (
              <button
                key={id}
                aria-label={title}
                className={section === id ? "active" : ""}
                onClick={() => {
                  setSection(id);
                  setMobile(false);
                }}
              >
                <Icon size={19} />
                {title}
                {id === "recovery" &&
                  w.recoveries.filter((r) => r.status !== "resolved").length >
                    0 && (
                    <span className="nav-count">{w.recoveries.length}</span>
                  )}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="care-note">
            <HeartHandshake size={22} />
            <strong>A little help goes a long way.</strong>
            <p>
              Every number connects to a record. Every purchase has a person
              behind it.
            </p>
          </div>
          <div className="profile">
            <span className="avatar">{w.actor.name[0]}</span>
            <div>
              <strong>{w.actor.name}</strong>
              <small>{w.actor.role}</small>
            </div>
            <button
              aria-label="Sign out"
              className="icon-button"
              onClick={signOut}
            >
              ↗
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label="Open navigation"
            onClick={() => setMobile(true)}
          >
            <Menu />
          </button>
          <span className="breadcrumb">
            Workspace <span>/</span> {title}
          </span>
          <div className="top-actions">
            <Badge tone="amber">
              {w.modes.payments === "simulation"
                ? "SIMULATED PAYMENTS"
                : "PAYPAL SANDBOX"}
            </Badge>
            <button
              className="icon-button"
              aria-label="Refresh workspace"
              onClick={() => refresh().catch((e) => setError(e.message))}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        <div className="demo-bar" role="region" aria-label="Workspace mode">
          <ShieldCheck size={16} />
          <span>
            {w.demo
              ? "Isolated synthetic demo. Tour each role to follow the full journey."
              : "Organization workspace. Financial actions require human approval."}
          </span>
          {w.demo && (
            <select
              aria-label="Demo role"
              value={w.actor.id}
              onChange={(e) => switchActor(e.target.value)}
            >
              {demos
                .filter(([id]) => id === w.actor.id || w.demo)
                .map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
            </select>
          )}
        </div>
        <main id="main" className="workspace-main" aria-busy={busy}>
          {error && (
            <div role="alert" className="message error">
              <CircleHelp size={18} />
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="message success">
              <PackageCheck size={18} />
              {notice}
            </div>
          )}
          <div className="page-heading">
            <div>
              <span className="eyebrow">{org.name.toUpperCase()}</span>
              <h1>
                {section === "overview"
                  ? `Good to see you, ${w.actor.name.split(" ")[0]}.`
                  : title}
              </h1>
              <p>
                {section === "overview"
                  ? "A clearer picture of your pantry. A thoughtful next step."
                  : descriptions[section]}
              </p>
            </div>
            {section === "overview" && (
              <button
                className="primary"
                onClick={() => setSection("procurement")}
              >
                <Plus size={18} /> Plan a purchase
              </button>
            )}
          </div>
          {!w.demo && ["owner", "finance", "coordinator"].includes(w.actor.role) &&
            (!org.sites.length || !w.kits.length || !w.funds.length) && (
            <Panel title="Set up your pantry" subtitle="Your new workspace starts blank. No example sites, funds, kits or money are added.">
              {!org.sites.length ? <><p>First, ask the owner to add your pantry site in Organization.</p>{w.actor.role === "owner" && <button className="primary" onClick={() => setSection("settings")}>Add your first site</button>}</>
                : !w.kits.length ? <><p>Next, define your kit in Inventory → Kit templates.</p><button className="primary" onClick={() => setSection("inventory")}>Define your first kit</button></>
                : <><p>Next, ask the owner to create a campaign and its fund purpose. No balance is created by setup.</p>{w.actor.role === "owner" && <button className="primary" onClick={() => setSection("campaigns")}>Create your first campaign</button>}</>}
            </Panel>
          )}
          <WorkflowGuide
            role={w.actor.role}
            simulated={w.modes.payments === "simulation"}
            busy={busy}
            navigate={(next) => { if (allowed(next, w.actor.role)) setSection(next); }}
          />
          <fieldset className="workspace-controls" disabled={busy}>
            {section === "overview" && <Overview w={w} navigate={setSection} />}
            {section === "campaigns" && (
              <Campaigns w={w} run={run} navigate={setSection} />
            )}
            {section === "inventory" && <Inventory w={w} run={run} navigate={setSection} />}
            {section === "procurement" && (
              <Procurement
                w={w}
                run={run}
                pay={pay}
                agent={(id) => action("/api/agent", { requestId: id })}
              />
            )}
            {section === "recovery" && <Recovery w={w} run={run} pay={pay} />}
            {section === "supplier" && <Supplier w={w} run={run} pay={pay} />}
            {section === "donor" && <Donor w={w} run={run} pay={pay} />}
            {section === "analytics" && <Analytics w={w} run={run} />}
            {section === "settings" && (
              <Organization w={w} run={run} pay={pay} />
            )}
            {section === "audit" && (
              <Panel
                title="Your activity trail"
                subtitle="Actor, action and source are preserved for every change."
              >
                {w.audit.length ? (
                  <div className="timeline">
                    {[...w.audit].reverse().map((a) => (
                      <article key={a.id}>
                        <span className="timeline-dot" />
                        <div>
                          <strong>{a.action.replaceAll("_", " ")}</strong>
                          <p>
                            {w.actors.find((x) => x.id === a.actorId)?.name ||
                              "Former member"}{" "}
                            · {new Date(a.createdAt).toLocaleString()}
                          </p>
                          <details>
                            <summary>Operation details</summary>
                            <code>{a.detail}</code>
                          </details>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <Empty title="A fresh start">
                    Actions you take will appear here.
                  </Empty>
                )}
              </Panel>
            )}
          </fieldset>
          <footer className="workspace-footer">
            <Sprout size={15} /> PantryPilot ·{" "}
            {w.demo ? "Synthetic workspace" : "Organization workspace"}{" "}
            <span>
              USD ·{" "}
              {w.modes.ai === "manual"
                ? "Rule-based planner"
                : `Gemini configured`}{" "}
              · Revision {w.revision}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
const descriptions: Record<Section, string> = {
  overview: "",
  campaigns: "Turn community generosity into purpose-aware funding.",
  inventory:
    "Know what is usable, where it lives, and what makes a complete kit.",
  procurement:
    "Compare a complete basket. Review the evidence. Approve the exact spend.",
  recovery:
    "A cancellation is a detour. Track the refund and plan your next move.",
  supplier:
    "Manage your offers, fulfill orders, and own your merchant refunds.",
  donor: "Give with intention. Keep track of your gifts and monthly support.",
  analytics: "Explore your operations with custom widgets and saved views.",
  settings: "Manage your pantry, sites, memberships, and financial controls.",
  audit: "A durable history of the people and decisions behind the numbers.",
};
function safe(p: Promise<unknown>) {
  p.catch(() => {});
}
function Overview({
  w,
  navigate,
}: {
  w: AppView;
  navigate: (s: Section) => void;
}) {
  const available = Object.values(w.available).reduce((s, n) => s + n, 0),
    reserved = Object.values(w.reserved).reduce((s, n) => s + n, 0);
  const received = w.orders.filter((o) => o.status === "received").length,
    distributed = w.distributions.reduce((s, d) => s + effectiveDistribution(d, w.stockCorrections), 0);
  const ready = w.kits[0] && w.organizations[0].sites[0]
    ? Math.min(
        ...w.kits[0].components.map((c) =>
          Math.floor(
            usableUnits(
              w,
              w.actor.organizationId,
              w.organizations[0].sites[0].id,
              c.sku,
              undefined, c.attributes,
            ) / c.quantity,
          ),
        ),
      )
    : 0;
  return (
    <>
      <div className="stats-grid">
        <Stat
          label="Available to put to work"
          value={usd(available)}
          detail={`${usd(reserved)} reserved · ${w.modes.payments === "simulation" ? "simulated ledger" : "operational ledger"}`}
          accent
        />
        <Stat
          label="Complete kits in stock"
          value={ready}
          detail={w.organizations[0].sites[0] ? `At ${w.organizations[0].sites[0].name}` : "Add your first pantry site"}
        />
        <Stat
          label="Shipments received"
          value={received}
          detail="Confirmed pantry receipts"
        />
        <Stat
          label="Kits distributed"
          value={distributed}
          detail="Recorded distributions only"
        />
      </div>
      <div className="overview-grid">
        <section className="mission-card">
          <span className="eyebrow">YOUR NEXT GOOD THING</span>
          <h2>
            Less guesswork.
            <br />
            More complete kits.
          </h2>
          <p>
            Start with your stock. Find the missing pieces. Let finance review a
            basket that includes every pack and every shipping charge.
          </p>
          <button
            className="light-button"
            onClick={() => navigate("procurement")}
          >
            Plan the next pantry run <ArrowRight size={18} />
          </button>
          <div className="mission-leaf">
            <Sprout size={170} strokeWidth={1} />
          </div>
        </section>
        <Panel
          title="The journey, at a glance"
          subtitle="Different stages. Different evidence."
        >
          <div className="journey-list">
            {[
              {
                label: "Planned kits",
                value: w.requests
                  .filter((r) => !r.replacesRequestId)
                  .reduce((s, r) => s + r.target, 0),
                Icon: ClipboardCheck,
              },
              {
                label: "Paid supplier orders",
                value: w.orders.filter(
                  (o) =>
                    !["awaiting_payer", "uncertain", "cancelled"].includes(
                      o.status,
                    ),
                ).length,
                Icon: ShoppingBasket,
              },
              {
                label: "Received shipments",
                value: received,
                Icon: PackageCheck,
              },
              {
                label: "Distributed kits",
                value: distributed,
                Icon: HeartHandshake,
              },
            ].map(({ label, value, Icon }) => (
              <div key={label}>
                <span className="icon-well">
                  <Icon size={19} />
                </span>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <p className="fine">
            Planning or payment does not establish delivery.
          </p>
        </Panel>
      </div>
      <div className="two-col">
        <Panel
          title="Community campaigns"
          action={
            <button className="text-link" onClick={() => navigate("campaigns")}>
              View all <ArrowRight size={16} />
            </button>
          }
        >
          {w.campaigns.map((c) => {
            const gifts = w.campaignReceived[c.id] ?? 0;
            return (
              <article className="campaign-summary" key={c.id}>
                <div>
                  <strong>{c.title}</strong>
                  <Badge tone="green">{c.status}</Badge>
                </div>
                <Progress value={gifts} max={c.goal} />
                <p>
                  {usd(gifts)} in net confirmed gifts{" "}
                  <span>Goal {usd(c.goal)}</span>
                </p>
              </article>
            );
          })}
        </Panel>
        <Panel title="What needs a little attention">
          <div className="attention">
            <span className="icon-well amber">
              <Undo2 size={21} />
            </span>
            <div>
              <strong>
                {
                  w.recoveries.filter(
                    (r) => !["resolved", "refund_confirmed"].includes(r.status),
                  ).length
                }{" "}
                open recovery cases
              </strong>
              <p>Refunds become available only when confirmed.</p>
            </div>
            <button
              className="icon-button"
              aria-label="Open recovery"
              onClick={() => navigate("recovery")}
            >
              <ArrowRight size={18} />
            </button>
          </div>
          <div className="attention">
            <span className="icon-well">
              <ShieldCheck size={21} />
            </span>
            <div>
              <strong>
                {w.orders.filter((o) => o.status === "awaiting_payer").length}{" "}
                orders awaiting payer approval
              </strong>
              <p>Approving a proposal and approving a payment are separate.</p>
            </div>
          </div>
          <div className="small-note">
            {w.demo
              ? "Demo starts with a $600 simulated opening balance. It is not a donor receipt."
              : "Review the fund ledger before each purchase."}
          </div>
        </Panel>
      </div>
    </>
  );
}
function Campaigns({
  w,
  run,
  navigate,
}: {
  w: AppView;
  run: Run;
  navigate: (s: Section) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="section-toolbar">
        <span>{w.campaigns.length} campaigns</span>
        {w.actor.role === "owner" && (
          <button className="primary" disabled={!w.kits.length || !w.organizations[0].sites.length} onClick={() => setOpen(!open)}>
            <Plus size={17} /> New campaign
          </button>
        )}
        {w.actor.role === "donor" && (
          <button className="primary" onClick={() => navigate("donor")}>
            Make a gift <ArrowRight size={17} />
          </button>
        )}
      </div>
      {w.actor.role === "owner" && (!w.kits.length || !w.organizations[0].sites.length) && <p role="status">Add your first site in Organization and define a kit in Inventory before creating a campaign.</p>}
      {open && (
        <Panel title="Start a campaign">
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              safe(
                run("campaign", {
                  title: f.get("title"),
                  description: f.get("description"),
                  goal: Math.round(Number(f.get("goal")) * 100),
                  targetKits: Number(f.get("target")),
                  kitId: f.get("kit"),
                  restricted: f.get("restricted") === "on",
                }).then(() => setOpen(false)),
              );
            }}
          >
            <Field label="Campaign title">
              <input name="title" required maxLength={160} />
            </Field>
            <Field label="Goal (USD)">
              <input name="goal" type="number" min="1" step="0.01" required />
            </Field>
            <Field label="Kit target">
              <input name="target" type="number" min="1" required />
            </Field>
            <Field label="Kit purpose">
              <select name="kit">
                {w.kits.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Campaign story">
              <textarea name="description" required />
            </Field>
            <label className="checkbox">
              <input name="restricted" type="checkbox" defaultChecked />{" "}
              Restrict gifts to this kit purpose
            </label>
            <button className="primary">Save draft</button>
          </form>
        </Panel>
      )}
      <div className="two-col">
        {w.campaigns.map((c) => {
          const raised = w.campaignReceived[c.id] ?? 0;
          return (
            <article className="campaign-card" key={c.id}>
              <div className="campaign-visual">
                <div className="campaign-visual-symbol">
                  <HeartHandshake size={56} strokeWidth={1.3} />
                </div>
                <Badge tone="green">{c.status}</Badge>
                <span>{c.targetKits} kits · a community effort</span>
              </div>
              <div className="campaign-body">
                <Badge>
                  {c.restricted ? "Restricted purpose" : "Unrestricted support"}
                </Badge>
                <h2>{c.title}</h2>
                <p>{c.description}</p>
                <Progress value={raised} max={c.goal} />
                <div className="campaign-money">
                  <strong>
                    {usd(raised)}
                    <small> net confirmed giving</small>
                  </strong>
                  <span>of {usd(c.goal)}</span>
                </div>
                {w.actor.role === "owner" && (
                  <div className="actions">
                    {c.status === "draft" && (
                      <button
                        className="primary"
                        onClick={() =>
                          safe(
                            run("campaignStatus", {
                              id: c.id,
                              status: "published",
                            }),
                          )
                        }
                      >
                        Publish campaign
                      </button>
                    )}
                    {c.status === "published" && (
                      <button
                        className="secondary"
                        onClick={() =>
                          safe(
                            run("campaignStatus", {
                              id: c.id,
                              status: "closed",
                            }),
                          )
                        }
                      >
                        Close campaign
                      </button>
                    )}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {w.campaigns.length === 0 && (
        <Empty title="No published campaigns">
          {w.actor.role === "owner"
            ? "Create and publish a campaign when its purpose is ready."
            : "Your pantry owner needs to publish a campaign before you can give."}
        </Empty>
      )}
      <p className="fine">
        Share published campaigns:{" "}
        <a href={`/campaigns?workspace=${w.id}`} target="_blank">
          Open public campaign page
        </a>
        . Public pages contain no donor identities.
      </p>
    </>
  );
}
function Inventory({ w, run, navigate }: { w: AppView; run: Run; navigate: (s: Section) => void }) {
  const [siteId, setSite] = useState(w.organizations[0].sites[0]?.id ?? ""),
    [tab, setTab] = useState("stock"),
    [csv, setCsv] = useState(
      w.demo ? "sku,name,quantity,expiresAt,attributes\nrice,Rice,12,2027-12-31,shelf-stable" : "",
    ),
    [preview, setPreview] = useState<ReturnType<typeof previewInventoryCsv>>(
      [],
    ),
    [csvError, setCsvError] = useState("");
  const sites = w.organizations[0].sites;
  return (
    <>
      <div className="section-toolbar">
        <div className="tabs">
          {["stock", "import", "kits", "distribute", "corrections"].map((t) => (
            <button
              key={t}
              className={tab === t ? "selected" : ""}
              onClick={() => setTab(t)}
            >
              {t === "stock"
                ? "Stock & lots"
                : t === "import"
                  ? "Import stock"
                  : t === "kits"
                    ? "Kit templates"
                    : t === "distribute" ? "Distribute" : "Corrections"}
            </button>
          ))}
        </div>
        <select
          aria-label="Pantry site"
          value={siteId}
          onChange={(e) => setSite(e.target.value)}
        >
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {!sites.length && <Empty title="Add your first pantry site">
        Ask your owner to add a site in Organization before recording stock, imports or distributions.
        {w.actor.role === "owner" && <button className="secondary" onClick={() => navigate("settings")}>Open Organization setup</button>}
      </Empty>}
      {tab === "stock" && !!sites.length && (
        <>
          <Panel
            title="Usable supplies"
            subtitle="Expired lots are retained in history and excluded from kit readiness."
          >
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Supply</th>
                    <th>SKU</th>
                    <th>Units</th>
                    <th>Expiry</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {w.inventory
                    .filter((l) => l.siteId === siteId)
                    .map((l) => (
                      <tr key={l.id}>
                        <td>
                          <strong>{l.name}</strong>
                          <small className="cell-note">
                            Lot {l.id.slice(0, 8)} · v{l.version}
                            <br />Attributes: {l.attributes?.join(", ") || "Unverified"}
                          </small>
                        </td>
                        <td>{l.sku}</td>
                        <td>{l.quantity}</td>
                        <td>
                          {l.expiresAt || "Unknown"}
                          {l.expiresAt &&
                            l.expiresAt <
                              new Date().toISOString().slice(0, 10) && (
                              <Badge tone="amber">Expired</Badge>
                            )}
                        </td>
                        <td>
                          <form
                            className="inline-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              const f = new FormData(e.currentTarget);
                              safe(
                                run("adjust", {
                                  id: l.id,
                                  quantity: Number(f.get("quantity")),
                                  reason: String(f.get("reason")),
                                  attributes: f.getAll("attributes"),
                                  version: l.version,
                                }),
                              );
                            }}
                          >
                            <input
                              aria-label={`Adjust ${l.name} quantity`}
                              name="quantity"
                              type="number"
                              min="0"
                              defaultValue={l.quantity}
                              required
                            />
                            <input
                              aria-label={`Adjustment reason for ${l.name}`}
                              name="reason"
                              placeholder="Reason"
                              required
                            />
                            <button className="secondary small">Adjust</button>
                            <details key={l.version}><summary>Verify product attributes</summary>
                              <label><input aria-label={`Shelf-stable for ${l.name}`} type="checkbox" name="attributes" value="shelf-stable" defaultChecked={l.attributes?.includes("shelf-stable")} /> Shelf-stable</label>
                              <label><input aria-label={`Household for ${l.name}`} type="checkbox" name="attributes" value="household" defaultChecked={l.attributes?.includes("household")} /> Household</label>
                              <small>Check only attributes supported by this lot’s records; explain the verification in the adjustment reason.</small>
                            </details>
                          </form>
                          {sites.length > 1 && (
                            <form
                              className="inline-form"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const f = new FormData(e.currentTarget);
                                safe(
                                  run("transfer", {
                                    id: l.id,
                                    siteId: f.get("site"),
                                    quantity: Number(f.get("quantity")),
                                  }),
                                );
                              }}
                            >
                              <select
                                name="site"
                                aria-label={`Transfer ${l.name} to`}
                              >
                                {sites
                                  .filter((s) => s.id !== siteId)
                                  .map((s) => (
                                    <option key={s.id} value={s.id}>
                                      {s.name}
                                    </option>
                                  ))}
                              </select>
                              <input
                                name="quantity"
                                type="number"
                                aria-label={`Transfer ${l.name} quantity`}
                                min="1"
                                max={l.quantity}
                                defaultValue={1}
                              />
                              <button className="secondary small">
                                Transfer
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {!w.inventory.some((l) => l.siteId === siteId) && (
              <Empty title="No stock at this site">
                Add a lot or transfer stock from another site.
              </Empty>
            )}
          </Panel>
          <Panel title="Add a stock lot">
            <form
              className="form-grid"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                safe(
                  run("inventory", {
                    siteId,
                    sku: f.get("sku"),
                    name: f.get("name"),
                    quantity: Number(f.get("quantity")),
                    expiresAt: f.get("expires") || undefined,
                    attributes: f.getAll("attributes"),
                  }),
                );
              }}
            >
              <Field label="SKU">
                <input name="sku" required />
              </Field>
              <Field label="Supply name">
                <input name="name" required />
              </Field>
              <Field label="Units">
                <input name="quantity" type="number" min="1" required />
              </Field>
              <Field label="Expiry (leave blank if unknown)">
                <input name="expires" type="date" />
              </Field>
              <button className="primary">Add lot</button>
              <fieldset><legend>Verified product attributes</legend>
                <label><input type="checkbox" name="attributes" value="shelf-stable" /> Shelf-stable</label>
                <label><input type="checkbox" name="attributes" value="household" /> Household</label>
                <p className="fine">Leave unsupported attributes unchecked. Unknown lots cannot satisfy a kit that requires them.</p>
              </fieldset>
            </form>
          </Panel>
        </>
      )}
      {tab === "import" && !!sites.length && (
        <Panel
          title="Review before importing"
          subtitle="CSV: sku,name,quantity,expiresAt with optional attributes column (shelf-stable|household). Omitted attributes stay unverified. Up to 100 lots; formula prefixes rejected."
        >
          <Field label="Paste inventory CSV">
            <textarea
              rows={7}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setPreview([]);
              }}
            />
          </Field>
          <button
            className="secondary"
            onClick={() => {
              try {
                setPreview(previewInventoryCsv(csv));
                setCsvError("");
              } catch (e) {
                setCsvError((e as Error).message);
              }
            }}
          >
            Preview import
          </button>
          {csvError && (
            <p className="error" role="alert">
              {csvError}
            </p>
          )}
          {preview.length > 0 && (
            <>
              <pre>{JSON.stringify(preview, null, 2)}</pre>
              <button
                className="primary"
                onClick={() =>
                  safe(
                    run("import", { siteId, rows: preview }).then(() => {
                      setPreview([]);
                      setTab("stock");
                    }),
                  )
                }
              >
                Confirm {preview.length} lots
              </button>
            </>
          )}
        </Panel>
      )}
      {tab === "kits" && (
        <>
          <div className="two-col">
            {w.kits.map((k) => (
              <Panel key={k.id} title={k.name}>
                {k.components.map((c) => (
                  <div className="list-row" key={c.sku}>
                    <strong>{c.name}</strong>
                    <span>
                      {c.quantity} units ·{" "}
                      {c.attributes.join(", ") || "attributes unknown"}
                    </span>
                  </div>
                ))}
              </Panel>
            ))}
          </div>
          <Panel
            title="Create a kit template"
            subtitle="Use one component per line: sku,name,units,shelf-stable or household"
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const components = String(f.get("components"))
                  .split("\n")
                  .filter(Boolean)
                  .map((row) => {
                    const [sku, name, count, attribute] = row.split(",");
                    return {
                      sku,
                      name,
                      quantity: Number(count),
                      attributes: attribute ? [attribute.trim()] : [],
                    };
                  });
                safe(run("kit", { name: f.get("name"), components }));
              }}
            >
              <Field label="Kit name">
                <input name="name" required />
              </Field>
              <Field label="Components">
                <textarea
                  name="components"
                  defaultValue={w.demo ? "rice,Rice,2,shelf-stable\nbeans,Beans,2,shelf-stable" : ""}
                  rows={5}
                  required
                />
              </Field>
              <button className="primary">Save kit</button>
            </form>
          </Panel>
        </>
      )}
      {tab === "corrections" && <StockCorrections w={w} run={run} />}
      {tab === "distribute" && !!sites.length && (
        <Panel
          title="Record a distribution"
          subtitle="This consumes actual usable stock, earliest expiry first. No recipient records are collected."
        >
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              safe(
                run("distribute", {
                  siteId,
                  kitId: f.get("kit"),
                  quantity: Number(f.get("quantity")),
                }),
              );
            }}
          >
            <Field label="Kit">
              <select name="kit">
                {w.kits.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Kits handed out">
              <input name="quantity" min="1" type="number" required />
            </Field>
            {!w.kits.length && <p role="status">Define a kit in Kit templates before recording a distribution.</p>}
            <button className="primary" disabled={!w.kits.length}>Record distribution</button>
          </form>
          <div className="timeline">
            {w.distributions.map((d) => (
              <article key={d.id}>
                <PackageCheck size={18} />
                <div>
                  <strong>{effectiveDistribution(d, w.stockCorrections)} kits distributed</strong>
                  <p>Original recorded count: {d.quantity}. Corrections retain the original history.</p>
                  <p>
                    {sites.find((s) => s.id === d.siteId)?.name} ·{" "}
                    {new Date(d.createdAt).toLocaleString()}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}
function ProposalCard({ p, w, run }: { p: Proposal; w: AppView; run: Run }) {
  const approvals = w.approvals.filter((a) => a.proposalId === p.id);
  return (
    <Panel
      title={`Basket · ${usd(p.total)}`}
      subtitle={`${p.source === "gemini" ? "Gemini + deterministic validation" : "Rule-based comparison"} · ${p.lines.length} offers`}
    >
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Supply / merchant</th>
              <th>Packs</th>
              <th>Units</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l) => (
              <tr key={l.catalogId}>
                <td>
                  {l.name}
                  <small className="cell-note">
                    {w.suppliers.find((s) => s.id === l.supplierId)?.name} ·
                    catalog v{l.version}
                  </small>
                </td>
                <td>{l.packs}</td>
                <td>{l.units}</td>
                <td>{usd(l.cost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={3}>Shipping</th>
              <td>{usd(p.shipping)}</td>
            </tr>
            <tr>
              <th colSpan={3}>Exact total</th>
              <td>
                <strong>{usd(p.total)}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {p.shortages.length > 0 ? (
        <div className="warning">
          <strong>Needs attention before approval</strong>
          {p.shortages.map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </div>
      ) : (
        <Badge tone="green">Constraints satisfied at proposal time</Badge>
      )}
      <details>
        <summary>See comparison evidence</summary>
        {p.explanations.map((e, i) => (
          <p key={i}>{e}</p>
        ))}
        <code>Proposal digest: {p.digest}</code>
      </details>
      {["owner", "finance"].includes(w.actor.role) && (
        <div className="actions">
          <button
            className="primary"
            disabled={!!p.shortages.length || !w.modes.financialActions}
            onClick={() => safe(run("approve", { id: p.id }))}
          >
            <ShieldCheck size={17} /> Approve exact basket
          </button>
          {approvals
            .filter(
              (a) => !a.consumed && a.expiresAt > new Date().toISOString(),
            )
            .map((a) => (
              <button
                key={a.id}
                className="secondary"
                onClick={() => safe(run("checkout", { id: a.id }))}
              >
                Reserve funds & create orders
              </button>
            ))}
        </div>
      )}
      <p className="fine">
        Approval lasts 15 minutes. Changed stock, prices or funding will be
        rechecked.
      </p>
    </Panel>
  );
}
function Procurement({
  w,
  run,
  pay,
  agent,
}: {
  w: AppView;
  run: Run;
  pay: (id: string, command: string, provider: string) => Promise<unknown>;
  agent: (id: string) => Promise<unknown>;
}) {
  const [newRequest, setNew] = useState(w.requests.length === 0);
  return (
    <>
      <div className="section-toolbar">
        <span>
          {w.requests.length} requests · {w.orders.length} supplier orders
        </span>
        <button className="primary" onClick={() => setNew(!newRequest)}>
          <Plus size={17} /> New request
        </button>
      </div>
      {newRequest && (
        <Panel
          title="What does your pantry need?"
          subtitle="Start with a kit target, a permitted fund, and a delivery date."
        >
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              safe(
                run("request", {
                  siteId: f.get("site"),
                  kitId: f.get("kit"),
                  fundId: f.get("fund"),
                  target: Number(f.get("target")),
                  budget: Math.round(Number(f.get("budget")) * 100),
                  deadline: f.get("deadline"),
                  notes: f.get("notes") || "",
                }).then(() => setNew(false)),
              );
            }}
          >
            <Field label="Pantry site">
              <select name="site">
                {w.organizations[0].sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Kit">
              <select name="kit">
                {w.kits.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Fund">
              <select name="fund">
                {w.funds.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} · {usd(w.available[f.id] || 0)} available
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Kit target">
              <input
                type="number"
                name="target"
                min="1"
                max="1000"
                defaultValue={50}
                required
              />
            </Field>
            <Field label="Maximum budget (USD)">
              <input
                type="number"
                name="budget"
                min="1"
                step="0.01"
                defaultValue={600}
                required
              />
            </Field>
            <Field label="Delivery deadline">
              <input
                type="date"
                name="deadline"
                defaultValue={new Date(
                  new Date(w.updatedAt).getTime() + 7 * 86400000,
                )
                  .toISOString()
                  .slice(0, 10)}
                required
              />
            </Field>
            <Field label="Coordinator notes">
              <textarea
                name="notes"
                placeholder="Notes stay with the request; they do not override product constraints."
              />
            </Field>
            {(!w.organizations[0].sites.length || !w.kits.length || !w.funds.length) && <p role="status">Ask your owner to add a site in Organization, define a kit in Inventory and create a campaign fund before purchasing.</p>}
            <button className="primary" disabled={!w.organizations[0].sites.length || !w.kits.length || !w.funds.length}>Save purchasing request</button>
          </form>
        </Panel>
      )}
      {[...w.requests].reverse().map((r) => (
        <Panel
          key={r.id}
          title={`${r.target} ${w.kits.find((k) => k.id === r.kitId)?.name || "kits"}`}
          subtitle={`${w.organizations[0].sites.find((s) => s.id === r.siteId)?.name} · ${usd(r.budget)} ceiling · by ${r.deadline}`}
          action={
            <div className="actions">
              <button
                className="secondary"
                onClick={() => safe(run("propose", { id: r.id }))}
              >
                Compare approved offers
              </button>
              {w.modes.ai === "gemini" && (
                <button className="primary" onClick={() => safe(agent(r.id))}>
                  Ask Gemini planner
                </button>
              )}
            </div>
          }
        >
          {r.notes && <p>{r.notes}</p>}
          <p className="fine">
            Proposals for this request:{" "}
            {w.proposals.filter((p) => p.requestId === r.id).length}
          </p>
        </Panel>
      ))}
      {[...w.proposals].reverse().map((p) => (
        <ProposalCard key={p.id} p={p} w={w} run={run} />
      ))}
      <Panel
        title="Supplier orders"
        subtitle="Funds remain reserved until capture or a confirmed local cancellation."
      >
        {!w.orders.length ? (
          <Empty title="No orders yet">
            Approve a basket, then create the supplier orders.
          </Empty>
        ) : (
          w.orders.map((o) => (
            <div className="order-row" key={o.id}>
              <div>
                <strong>
                  {w.suppliers.find((s) => s.id === o.supplierId)?.name}
                </strong>
                <p>
                  {usd(o.total)} ·{" "}
                  {o.lines.map((l) => `${l.packs} × ${l.name}`).join(", ")}
                </p>
                <Badge tone={o.status === "received" ? "green" : "neutral"}>
                  {o.status.replaceAll("_", " ")}
                </Badge>{" "}
                <Badge>{o.evidence}</Badge>
                {o.status === "received" && <p>
                  {o.receipt
                    ? `Original receipt: ${o.receipt.movements.reduce((s, m) => s + m.quantity, 0)} units. Effective receipt: ${w.stockCorrections?.filter(c => c.kind === "receipt" && c.sourceId === o.id && c.status === "applied").at(-1)?.quantity ?? o.receipt.movements.reduce((s, m) => s + m.quantity, 0)} units.`
                    : "Legacy receipt has no saved lot provenance."}
                  {" "}Report discrepancies in Inventory → Corrections; money recovery is separate.
                </p>}
              </div>
              <div className="actions">
                {o.status === "awaiting_payer" &&
                  ["owner", "finance"].includes(w.actor.role) && (
                    <>
                      {w.modes.payments === "sandbox" && !o.providerId && (
                        <button
                          className="primary"
                          onClick={() => safe(pay(o.id, "capture", "create"))}
                        >
                          Open PayPal approval
                        </button>
                      )}
                      {o.approvalUrl && (
                        <a
                          className="secondary"
                          href={o.approvalUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          PayPal approval ↗
                        </a>
                      )}
                      <button
                        className="primary"
                        onClick={() => safe(pay(o.id, "capture", "capture"))}
                      >
                        {w.modes.payments === "simulation"
                          ? "Simulate payer approval"
                          : "Confirm capture"}
                      </button>
                      {(w.modes.payments === "simulation" || o.providerId) && (
                        <button
                          className="secondary"
                          onClick={() =>
                            safe(pay(o.id, "cancelPayment", "cancel"))
                          }
                        >
                          {w.modes.payments === "simulation"
                            ? "Cancel"
                            : "Retire uncaptured checkout"}
                        </button>
                      )}
                    </>
                  )}
                {o.status === "uncertain" && (
                  <button
                    className="secondary"
                    onClick={() => safe(pay(o.id, "capture", "reconcile"))}
                  >
                    Reconcile with PayPal
                  </button>
                )}
                {o.status === "fulfilled" && (
                  <button
                    className="primary"
                    onClick={() => safe(run("receive", { id: o.id }))}
                  >
                    Confirm pantry receipt
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </Panel>
    </>
  );
}
function Recovery({
  w,
  run,
  pay,
}: {
  w: AppView;
  run: Run;
  pay: (id: string, command: string, provider: string) => Promise<unknown>;
}) {
  return (
    <>
      <div className="stats-grid">
        <Stat
          label="Recovery cases"
          value={w.recoveries.length}
          detail="Supplier-reported cancellations"
        />
        <Stat
          label="Awaiting merchant refund"
          value={usd(
            w.recoveries
              .filter((r) =>
                ["opened", "refund_requested", "refund_pending"].includes(
                  r.status,
                ),
              )
              .reduce((s, r) => s + r.amount, 0),
          )}
          detail="Unavailable for replacement spending"
        />
        <Stat
          label="Confirmed refunds"
          value={usd(
            w.recoveries
              .filter((r) =>
                [
                  "refund_confirmed",
                  "replacement_proposed",
                  "resolved",
                ].includes(r.status),
              )
              .reduce((s, r) => s + r.amount, 0),
          )}
          detail="Posted back to the original fund"
        />
        <Stat
          label="Replacement proposals"
          value={w.recoveries.filter((r) => r.replacementProposalId).length}
          detail="Each needs a fresh human approval"
        />
      </div>
      {!w.recoveries.length ? (
        <Panel title="Recovery desk">
          <Empty title="No detours to handle">
            A supplier partial cancellation opens a case here. Use the supplier
            role tour to try it.
          </Empty>
        </Panel>
      ) : (
        w.recoveries.map((r) => (
          <Panel
            key={r.id}
            title={`${usd(r.amount)} to recover`}
            subtitle={r.reason}
            action={
              <Badge tone={r.status === "refund_confirmed" ? "green" : "amber"}>
                {r.status.replaceAll("_", " ")}
              </Badge>
            }
          >
            <div className="recovery-steps">
              {[
                "Cancellation recorded",
                "Finance requests refund",
                "Supplier confirms refund",
                "Receive & replan",
              ].map((label, i) => (
                <div key={label}>
                  <span>{i + 1}</span>
                  {label}
                </div>
              ))}
            </div>
            <p className="fine">
              Original order {r.orderId.slice(0, 8)} · Original fund preserved ·{" "}
              {r.refundId || "No confirmed refund ID yet"}
            </p>
            <div className="actions">
              {["owner", "finance"].includes(w.actor.role) &&
                ["opened", "refund_failed"].includes(r.status) && (
                  <button
                    className="primary"
                    onClick={() => safe(run("requestRefund", { id: r.id }))}
                  >
                    Approve & request refund
                  </button>
                )}
              {r.status === "refund_requested" && (
                <p className="small-note">
                  The supplier merchant must authorize and issue this refund in
                  their portal.
                </p>
              )}
              {r.status === "refund_confirmed" && (
                <button
                  className="primary"
                  onClick={() => safe(run("replacement", { id: r.id }))}
                >
                  Draft replacement basket
                </button>
              )}
              {r.replacementProposalId && (
                <span className="fine">
                  Replacement is in Purchasing. Review and approve it
                  separately.
                </span>
              )}
              {r.status === "refund_pending" && w.actor.role === "supplier" && (
                <button
                  className="secondary"
                  onClick={() => safe(pay(r.id, "confirmRefund", "reconcile"))}
                >
                  Read refund status
                </button>
              )}
            </div>
          </Panel>
        ))
      )}
    </>
  );
}
function Supplier({
  w,
  run,
  pay,
}: {
  w: AppView;
  run: Run;
  pay: (id: string, command: string, provider: string) => Promise<unknown>;
}) {
  const supplier = w.suppliers.find((s) => s.id === w.actor.supplierId);
  return (
    <>
      <Panel
        title={`${supplier?.name || "Supplier"} catalogue`}
        subtitle="Version changes invalidate existing unconsumed purchase approvals."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Supply</th>
                <th>Pack size</th>
                <th>Price / stock / delivery</th>
              </tr>
            </thead>
            <tbody>
              {w.catalog
                .filter((c) => c.supplierId === w.actor.supplierId)
                .map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      <small className="cell-note">
                        {c.sku} · v{c.version} · {c.provenance}
                      </small>
                    </td>
                    <td>
                      {c.packSize} {c.unit}
                    </td>
                    <td>
                      <form
                        className="inline-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          safe(
                            run("catalog", {
                              id: c.id,
                              price: Math.round(Number(f.get("price")) * 100),
                              availablePacks: Number(f.get("stock")),
                              deliveryDays: Number(f.get("days")),
                            }),
                          );
                        }}
                      >
                        <input
                          name="price"
                          aria-label={`${c.name} pack price USD`}
                          defaultValue={c.price / 100}
                          type="number"
                          min="0.01"
                          step="0.01"
                        />
                        <input
                          name="stock"
                          aria-label={`${c.name} packs available`}
                          defaultValue={c.availablePacks}
                          type="number"
                          min="0"
                        />
                        <input
                          name="days"
                          aria-label={`${c.name} delivery days`}
                          defaultValue={c.deliveryDays}
                          type="number"
                          min="1"
                        />
                        <button className="secondary">Update offer</button>
                      </form>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Your fulfillment queue">
        <details className="card-details">
          <summary>Add a supplier offer</summary>
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              safe(
                run("catalogCreate", {
                  sku: f.get("sku"),
                  name: f.get("name"),
                  unit: f.get("unit"),
                  packSize: Number(f.get("packSize")),
                  price: Math.round(Number(f.get("price")) * 100),
                  availablePacks: Number(f.get("stock")),
                  deliveryDays: Number(f.get("days")),
                  attributes: f.getAll("attributes"),
                  ...(f.get("expiry") ? { expiresAt: f.get("expiry") } : {}),
                }),
              );
            }}
          >
            <Field label="Offer SKU">
              <input name="sku" required maxLength={80} />
            </Field>
            <Field label="Supply name">
              <input name="name" required maxLength={120} />
            </Field>
            <Field label="Unit">
              <input name="unit" required maxLength={30} defaultValue="units" />
            </Field>
            <Field label="Units per pack">
              <input
                name="packSize"
                type="number"
                min="1"
                max="1000"
                required
                defaultValue="10"
              />
            </Field>
            <Field label="Pack price USD">
              <input
                name="price"
                type="number"
                min="0.01"
                step="0.01"
                required
              />
            </Field>
            <Field label="Packs available">
              <input
                name="stock"
                type="number"
                min="0"
                max="10000"
                required
                defaultValue="10"
              />
            </Field>
            <Field label="Delivery days">
              <input
                name="days"
                type="number"
                min="1"
                max="90"
                required
                defaultValue="3"
              />
            </Field>
            <Field label="Offer expiry, if verified">
              <input name="expiry" type="date" />
            </Field>
            <label>
              <input type="checkbox" name="attributes" value="shelf-stable" />{" "}
              Verified shelf-stable product
            </label>
            <label>
              <input type="checkbox" name="attributes" value="household" />{" "}
              Household product
            </label>
            <p className="helper">
              Use the kit component SKU to match an offer. Missing product
              attributes remain unknown.
            </p>
            <button className="primary">Add offer</button>
          </form>
        </details>
        {!w.orders.length ? (
          <Empty title="No orders for your merchant">
            Finance must approve and pay an order before fulfillment.
          </Empty>
        ) : (
          w.orders.map((o) => (
            <article className="supplier-order" key={o.id}>
              <div className="section-toolbar">
                <strong>
                  Order {o.id.slice(0, 8)} · {usd(o.total)}
                </strong>
                <Badge>{o.status}</Badge>
              </div>
              {o.lines.map((l) => (
                <div className="list-row" key={l.catalogId}>
                  <span>
                    {l.packs} packs · {l.name} · {l.units} units remaining
                  </span>
                  {["paid", "accepted", "partial"].includes(o.status) &&
                    l.packs > 0 && (
                      <form
                        className="inline-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          safe(
                            run("partialCancel", {
                              id: o.id,
                              catalogId: l.catalogId,
                              packs: Number(f.get("packs")),
                              reason: f.get("reason"),
                            }),
                          );
                        }}
                      >
                        <input
                          name="packs"
                          aria-label={`${l.name} packs to cancel`}
                          type="number"
                          min="1"
                          max={l.packs}
                          defaultValue={1}
                        />
                        <input
                          name="reason"
                          aria-label={`${l.name} cancellation reason`}
                          defaultValue="Supplier stock shortage"
                          required
                        />
                        <button className="secondary">Cancel packs</button>
                      </form>
                    )}
                </div>
              ))}
              <div className="actions">
                {o.status === "paid" && (
                  <button
                    className="secondary"
                    onClick={() =>
                      safe(run("fulfill", { id: o.id, status: "accepted" }))
                    }
                  >
                    Accept order
                  </button>
                )}
                {["paid", "accepted", "partial"].includes(o.status) && (
                  <button
                    className="primary"
                    onClick={() =>
                      safe(run("fulfill", { id: o.id, status: "fulfilled" }))
                    }
                  >
                    Mark remaining shipment fulfilled
                  </button>
                )}
                {["paid", "accepted", "partial"].includes(o.status) && (
                  <button
                    className="secondary"
                    onClick={() =>
                      safe(
                        run("cancelOrder", {
                          id: o.id,
                          reason:
                            "Supplier cancelled the entire remaining order, including shipping.",
                        }),
                      )
                    }
                  >
                    Cancel remaining order
                  </button>
                )}
              </div>
              {w.recoveries
                .filter((r) => r.orderId === o.id)
                .map((r) => (
                  <div className="warning" key={r.id}>
                    <strong>
                      {usd(r.amount)} refund · {r.status}
                    </strong>
                    {r.status === "refund_requested" && (
                      <div className="actions">
                        <button
                          className="primary"
                          onClick={() =>
                            safe(pay(r.id, "confirmRefund", "refund"))
                          }
                        >
                          {w.modes.payments === "simulation"
                            ? "Simulate merchant-authorized refund"
                            : "Approve & issue PayPal refund"}
                        </button>
                        {w.modes.payments === "simulation" && (
                          <button
                            className="secondary"
                            onClick={() =>
                              safe(run("failRefund", { id: r.id }))
                            }
                          >
                            Simulate failed refund
                          </button>
                        )}
                      </div>
                    )}
                    {r.status === "refund_pending" && (
                      <button
                        className="secondary"
                        onClick={() =>
                          safe(pay(r.id, "confirmRefund", "reconcile"))
                        }
                      >
                        Reconcile refund
                      </button>
                    )}
                  </div>
                ))}
            </article>
          ))
        )}
      </Panel>
    </>
  );
}
function Donor({
  w,
  run,
  pay,
}: {
  w: AppView;
  run: Run;
  pay: (id: string, command: string, provider: string) => Promise<unknown>;
}) {
  const [frequency, setFrequency] = useState("once");
  const hasPublishedCampaign = w.campaigns.some((c) => c.status === "published");
  return (
    <>
      <div className="two-col">
        <Panel
          title="A gift that goes somewhere"
          subtitle="Choose a campaign and how you want to support it."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              safe(
                run(frequency === "once" ? "donation" : "subscription", {
                  campaignId: f.get("campaign"),
                  amount: Math.round(Number(f.get("amount")) * 100),
                }),
              );
            }}
          >
            <Field label="Campaign">
              <select name="campaign">
                {w.campaigns
                  .filter((c) => c.status === "published")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
              </select>
            </Field>
            <div className="tabs">
              <button
                type="button"
                className={frequency === "once" ? "selected" : ""}
                onClick={() => setFrequency("once")}
              >
                One-time gift
              </button>
              <button
                type="button"
                className={frequency === "monthly" ? "selected" : ""}
                onClick={() => setFrequency("monthly")}
              >
                Monthly support
              </button>
            </div>
            <Field label="Gift amount (USD)">
              {frequency === "once" ? (
                <input
                  key="once"
                  name="amount"
                  type="number"
                  min="0.01"
                  max="100000"
                  step="0.01"
                  defaultValue={25}
                  required
                />
              ) : (
                <select key="monthly" name="amount">
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      ${n} / month
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {!hasPublishedCampaign && (
              <p role="status" className="helper">
                There are no open campaigns available. Contact your pantry owner before giving.
              </p>
            )}
            <button className="primary large" disabled={!hasPublishedCampaign}>
              Continue to{" "}
              {w.modes.payments === "simulation"
                ? "simulated"
                : "PayPal sandbox"}{" "}
              approval <ArrowRight size={17} />
            </button>
            <p className="fine">
              You will review the payment separately. This sandbox gift is not a
              tax-deductible donation.
            </p>
          </form>
        </Panel>
        <section className="donor-note">
          <HeartHandshake size={42} strokeWidth={1.5} />
          <h2>
            Small gifts.
            <br />
            Shared possibility.
          </h2>
          <p>
            Your gift stays with its campaign purpose. A monthly subscription
            becomes funding only when a billing payment is confirmed.
          </p>
          <Badge tone="green">No public donor identities</Badge>
        </section>
      </div>
      <Panel title="Your gift history">
        {w.donations.filter((d) => d.donorId === w.actor.id).length === 0 ? (
          <Empty title="Your story starts with a gift">
            Confirmed gifts and acknowledgments will be kept here.
          </Empty>
        ) : (
          w.donations
            .filter((d) => d.donorId === w.actor.id)
            .map((d) => (
              <div className="order-row" key={d.id}>
                <div>
                  <strong>
                    {usd(d.amount)} ·{" "}
                    {w.campaigns.find((c) => c.id === d.campaignId)?.title ||
                      "Campaign"}
                  </strong>
                  <p>
                    {new Date(d.createdAt).toLocaleDateString()} ·{" "}
                    <Badge>{d.status === "refund_pending" && d.refundStatus === "failed" ? "refund needs review" : d.status}</Badge> <Badge>{d.evidence}</Badge>
                  </p>
                  {d.status === "refund_pending" && (
                    <p className="helper">
                      <strong>{d.refundStatus === "failed" ? "Refund needs review" : "Refund pending"}</strong><br />
                      {d.refundStatus === "failed"
                        ? "The provider reported a failed refund. Your gift is not confirmed as refunded. Contact the pantry to review the existing refund. Do not make another gift to retry this refund."
                        : "Your gift is not yet confirmed as refunded. Check its existing status with the pantry; a pending refund is not completed money."}
                    </p>
                  )}
                  {d.status === "uncertain" && (
                    <p className="helper">The payment outcome is not confirmed. Read the existing gift status before starting another payment; contact the pantry if it remains unresolved.</p>
                  )}
                </div>
                <div className="actions">
                  {d.status === "awaiting_payer" && (
                    <>
                      {w.modes.payments === "sandbox" && !d.providerId && (
                        <button
                          className="primary"
                          onClick={() => safe(pay(d.id, "capture", "create"))}
                        >
                          Open PayPal approval
                        </button>
                      )}
                      <button
                        className="primary"
                        onClick={() => safe(pay(d.id, "capture", "capture"))}
                      >
                        {w.modes.payments === "simulation"
                          ? "Simulate payer approval"
                          : "Confirm gift capture"}
                      </button>
                      {(w.modes.payments === "simulation" || d.providerId) && (
                        <button
                          className="secondary"
                          onClick={() =>
                            safe(pay(d.id, "cancelPayment", "cancel"))
                          }
                        >
                          {w.modes.payments === "simulation"
                            ? "Cancel gift"
                            : "Retire uncaptured checkout"}
                        </button>
                      )}
                    </>
                  )}
                  {["confirmed", "refunded"].includes(d.status) && (
                    <a
                      className="secondary"
                      href={`/api/receipt?id=${d.id}`}
                      target="_blank"
                    >
                      <ArrowDownToLine size={16} /> Acknowledgment
                    </a>
                  )}
                  {d.status === "uncertain" && (
                    <button
                      className="secondary"
                      onClick={() => safe(pay(d.id, "capture", "reconcile"))}
                    >
                      Reconcile gift
                    </button>
                  )}
                </div>
              </div>
            ))
        )}
      </Panel>
      <Panel title="Monthly support">
        {w.subscriptions
          .filter((s) => s.donorId === w.actor.id)
          .map((s) => (
            <div key={s.id} className="order-row">
              <div>
                <strong>{usd(s.amount)} / month</strong>
                <p>
                  {w.campaigns.find((c) => c.id === s.campaignId)?.title} ·{" "}
                  {s.status} · {s.evidence}
                </p>
              </div>
              <div className="actions">
                {s.status === "awaiting_payer" && (
                  <button
                    className="primary"
                    onClick={() =>
                      safe(
                        pay(
                          s.id,
                          "activateSubscription",
                          s.providerId ? "reconcile" : "subscription",
                        ),
                      )
                    }
                  >
                    {s.providerId
                      ? "Check activation"
                      : w.modes.payments === "simulation"
                        ? "Simulate subscription activation"
                        : "Approve in PayPal"}
                  </button>
                )}
                {s.approvalUrl && s.status === "awaiting_payer" && (
                  <a
                    className="secondary"
                    href={s.approvalUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    PayPal approval ↗
                  </a>
                )}
                {s.status === "active" && (
                  <button
                    className="secondary"
                    onClick={() =>
                      safe(
                        pay(s.id, "cancelSubscription", "cancel_subscription"),
                      )
                    }
                  >
                    Cancel future giving
                  </button>
                )}
              </div>
            </div>
          ))}
        {!w.subscriptions.length && (
          <Empty title="No monthly commitments">
            Monthly support can be cancelled by its donor at any time.
          </Empty>
        )}
      </Panel>
    </>
  );
}
function Organization({
  w,
  run,
  pay,
}: {
  w: AppView;
  run: Run;
  pay: (id: string, command: string, provider: string) => Promise<unknown>;
}) {
  const [invite, setInvite] = useState("");
  return (
    <>
      <div className="two-col">
        <Panel title="Your organization">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              safe(
                run("organization", {
                  name: f.get("name"),
                  description: f.get("description"),
                }),
              );
            }}
          >
            <Field label="Organization name">
              <input
                name="name"
                defaultValue={w.organizations[0].name}
                required
              />
            </Field>
            <Field label="Description">
              <textarea
                name="description"
                defaultValue={w.organizations[0].description}
                required
              />
            </Field>
            <button className="primary" disabled={w.actor.role !== "owner"}>
              Save organization
            </button>
          </form>
        </Panel>
        <Panel title="Pantry sites">
          {w.organizations[0].sites.map((s) => (
            <div className="list-row" key={s.id}>
              <span>{s.name}</span>
              <Badge>Active site</Badge>
            </div>
          ))}
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              safe(
                run("site", {
                  name: new FormData(e.currentTarget).get("name"),
                }),
              );
            }}
          >
            <input
              aria-label="New site name"
              name="name"
              required
              placeholder="New site name"
            />
            <button className="secondary" disabled={w.actor.role !== "owner"}>
              Add site
            </button>
          </form>
        </Panel>
      </div>
      <Panel
        title="Purpose-aware funds"
        subtitle="Opening balances, gifts, spending and refunds remain separate ledger entries."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fund</th>
                <th>Purpose</th>
                <th>Available</th>
                <th>Reserved</th>
              </tr>
            </thead>
            <tbody>
              {w.funds.map((f) => (
                <tr key={f.id}>
                  <td>{f.name}</td>
                  <td>
                    {f.restricted ? "Restricted" : "Unrestricted"} ·{" "}
                    {w.kits.find((k) => k.id === f.purpose)?.name || f.purpose}
                  </td>
                  <td>{usd(w.available[f.id] || 0)}</td>
                  <td>{usd(w.reserved[f.id] || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details>
          <summary>View immutable ledger</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Amount</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {w.ledger.map((l) => (
                  <tr key={l.id}>
                    <td>{l.kind}</td>
                    <td>{usd(l.amount)}</td>
                    <td>
                      {l.evidence} · {l.source}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Panel>
      {w.actor.role === "owner" && (
        <Panel
          title="People & permissions"
          subtitle="Expiring invitations are single use. Revoked members lose access on their next request."
        >
          {w.actors.map((a) => (
            <div className="list-row" key={a.id}>
              <strong>{a.name}</strong>
              <select
                aria-label={`Role for ${a.name}`}
                disabled={a.id === w.actor.id || a.role === "supplier"}
                value={a.role}
                onChange={(e) =>
                  safe(run("member", { id: a.id, role: e.target.value }))
                }
              >
                {["owner", "finance", "coordinator", "donor"].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
                {a.role === "supplier" && (
                  <option value="supplier">supplier</option>
                )}
              </select>
              {a.id !== w.actor.id && (
                <button
                  className="secondary small"
                  onClick={() => safe(run("revoke", { id: a.id }))}
                >
                  Revoke access
                </button>
              )}
            </div>
          ))}
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              safe(
                run("invite", {
                  role: new FormData(e.currentTarget).get("role"),
                }).then((result) => {
                  const token = (result as { token: string }).token;
                  setInvite(
                    `${location.origin}/join?workspace=${w.id}&token=${token}`,
                  );
                }),
              );
            }}
          >
            <select name="role" aria-label="Invitation role">
              <option value="coordinator">Coordinator</option>
              <option value="finance">Finance</option>
              <option value="donor">Donor</option>
              <option value="owner">Owner</option>
            </select>
            <button className="primary">Create invitation link</button>
          </form>
          {invite && (
            <Field label="Invitation link — share only with the intended member">
              <input
                readOnly
                value={invite}
                onFocus={(e) => e.target.select()}
              />
            </Field>
          )}
        </Panel>
      )}
      {w.actor.role === "owner" && (
        <Panel
          title="Approved suppliers"
          subtitle="Register a supplier, then invite its representative. Merchant activation requires separate operator verification."
        >
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              safe(
                run("supplier", {
                  name: f.get("name"),
                  shipping: Math.round(Number(f.get("shipping")) * 100),
                }),
              );
            }}
          >
            <Field label="Supplier name">
              <input name="name" required maxLength={120} />
            </Field>
            <Field label="Shipping USD per order">
              <input
                name="shipping"
                type="number"
                min="0"
                step="0.01"
                required
                defaultValue="0"
              />
            </Field>
            <button className="primary">Register supplier</button>
          </form>
          {w.suppliers.map((s) => (
            <div className="list-row" key={s.id}>
              <strong>{s.name}</strong>
              <span>{usd(s.shipping)} shipping</span>
              <button
                className="secondary"
                onClick={() =>
                  safe(
                    run("invite", { role: "supplier", supplierId: s.id }).then(
                      (result) => {
                        const token = (result as { token: string }).token;
                        setInvite(
                          `${location.origin}/join?workspace=${w.id}&token=${token}`,
                        );
                      },
                    ),
                  )
                }
              >
                Invite supplier representative
              </button>
            </div>
          ))}
        </Panel>
      )}
      <Panel title="Donation & billing operations">
        {w.donations
          .filter(
            (d) => d.status === "confirmed" || d.status === "refund_pending",
          )
          .map((d) => (
            <div key={d.id} className="list-row">
              <span>
                {usd(d.amount)} · {d.status}
              </span>
              <button
                className="secondary"
                onClick={() =>
                  safe(
                    d.status === "confirmed"
                      ? run("donationRefund", { id: d.id })
                      : pay(
                          d.id,
                          "confirmDonationRefund",
                          d.refundId ? "reconcile" : "refund",
                        ),
                  )
                }
              >
                {d.status === "confirmed"
                  ? "Approve donation refund"
                  : w.modes.payments === "simulation"
                    ? "Simulate confirmed refund"
                    : d.refundId
                      ? "Reconcile PayPal refund"
                      : "Issue approved PayPal refund"}
              </button>
            </div>
          ))}
        {w.modes.payments === "simulation" &&
          w.subscriptions
            .filter((s) => s.status === "active")
            .map((s) => (
              <div key={s.id} className="list-row">
                <span>
                  Monthly {usd(s.amount)} · activation has no ledger posting
                </span>
                <button
                  className="secondary"
                  onClick={() =>
                    safe(
                      run("billSubscription", {
                        id: s.id,
                        eventId: crypto.randomUUID(),
                      }),
                    )
                  }
                >
                  Simulate confirmed billing event
                </button>
              </div>
            ))}
      </Panel>
      {w.actor.role === "owner" && (
        <Panel
          title="Financial stop control"
          subtitle="A pause blocks new spending, giving and refunds. Existing records and readback remain available."
        >
          <Badge tone={w.modes.financialActions ? "green" : "amber"}>
            {w.modes.financialActions
              ? "Financial actions enabled"
              : "Financial actions paused"}
          </Badge>
          <button
            className="secondary"
            onClick={() =>
              safe(run("stop", { enabled: !w.modes.financialActions }))
            }
          >
            {w.modes.financialActions
              ? "Pause financial actions"
              : "Resume financial actions"}
          </button>
        </Panel>
      )}
      {w.actor.role === "owner" && (
        <Panel
          title="AI stop control"
          subtitle="Pause new runs and abort active runs in this process. Other hosted instances reject their output when saving; distributed cancellation needs hosted qualification."
        >
          <Badge tone={w.modes.aiPaused ? "amber" : "green"}>
            {w.modes.aiPaused ? "AI paused" : "AI enabled"}
          </Badge>
          <button
            className="secondary"
            onClick={() =>
              safe(run("agentStop", { enabled: w.modes.aiPaused }))
            }
          >
            {w.modes.aiPaused ? "Resume AI runs" : "Pause AI runs"}
          </button>
        </Panel>
      )}
    </>
  );
}
