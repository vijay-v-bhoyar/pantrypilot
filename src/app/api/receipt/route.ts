import { getSession } from "@/lib/session";
import { loadWorkspace } from "@/lib/storage";
import { actorFor, scoped } from "@/lib/commands";
import { ensure } from "@/lib/errors";
import { usd } from "@/lib/money";
export async function GET(request: Request) {
  try {
    const s = await getSession();
    const w = await loadWorkspace(s.workspaceId);
    const a = actorFor(w, s.actorId);
    const d = scoped(
      w.donations,
      new URL(request.url).searchParams.get("id") || "",
      a,
    );
    ensure(
      d.donorId === a.id,
      "DONOR",
      "Only the donor can access this acknowledgment.",
      403,
    );
    ensure(
      d.status === "confirmed" || d.status === "refunded",
      "STATE",
      "No confirmed receipt exists.",
    );
    const c = w.campaigns.find((c) => c.id === d.campaignId)!;
    const escape = (v: string) =>
      v
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>PantryPilot acknowledgment</title><style>body{font:16px Arial;max-width:720px;margin:70px auto;padding:30px;color:#233a36}h1{color:#176356}dt{font-weight:bold;margin-top:25px}dd{margin:8px 0}aside{padding:20px;background:#f5f1de;margin-top:30px}</style><h1>Gift acknowledgment</h1><p>${escape(w.organizations.find((o) => o.id === a.organizationId)!.name)}</p><dl><dt>Campaign</dt><dd>${escape(c.title)}</dd><dt>Gift amount</dt><dd>${usd(d.amount)} USD</dd><dt>Recorded</dt><dd>${escape(d.createdAt)}</dd><dt>Reference</dt><dd>${escape(d.captureId || d.id)}</dd><dt>Status</dt><dd>${d.status}</dd></dl><aside>${d.evidence === "simulation" ? "LOCAL SIMULATION" : "PAYPAL SANDBOX"} — No real funds were donated. This is not a tax receipt and makes no tax-deductibility claim.</aside><p>Use your browser Print → Save as PDF to keep a copy.</p></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        },
      },
    );
  } catch {
    return new Response("Acknowledgment unavailable for this session.", {
      status: 403,
    });
  }
}
