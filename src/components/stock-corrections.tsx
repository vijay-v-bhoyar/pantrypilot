"use client";
import { useState } from "react";
import type { AppView } from "@/lib/types";
import { effectiveDistribution } from "@/lib/correction-totals";
import { Empty, Field, Panel } from "./ui";

export default function StockCorrections({ w, run }: {
  w: AppView; run: (command: string, data: unknown) => Promise<unknown>;
}) {
  const sources = [
    ...w.distributions.map(d => ({ kind: "distribution" as const, id: d.id, siteId: d.siteId,
      original: d.quantity, effective: effectiveDistribution(d, w.stockCorrections), movements: d.movements })),
    ...w.orders.filter(o => o.status === "received").map(o => {
      const original = o.receipt?.movements.reduce((s, m) => s + m.quantity, 0) ?? 0;
      return { kind: "receipt" as const, id: o.id, siteId: o.siteId, original,
        effective: w.stockCorrections?.filter(c => c.sourceId === o.id && c.kind === "receipt" && c.status === "applied").at(-1)?.quantity ?? original,
        movements: o.receipt?.movements };
    }),
  ];
  const [selected, setSelected] = useState("");
  const source = sources.find(s => s.id === selected);
  return <>
    <Panel title="Stock corrections" subtitle="Preserve the original entry. A coordinator recounts the stock; a different owner reviews and applies exact changes. No payment or refund changes.">
      <p>Record only evidence references and stock counts. Do not include recipient or household details. If the stock moved, reject the proposal and recount.</p>
      {w.actor.role === "coordinator" && <>
        <Field label="Original record">
          <select value={selected} onChange={e => setSelected(e.target.value)}>
            <option value="">Choose a completed source</option>
            {sources.map(s => <option key={s.id} value={s.id}>{s.kind} · {s.id} · {w.organizations[0].sites.find(x => x.id === s.siteId)?.name}</option>)}
          </select>
        </Field>
        {source && (!source.movements?.length
          ? <p role="status">This legacy record has no lot provenance. Keep it unresolved for manual review. Do not guess a source lot.</p>
          : <form key={source.id} className="form-grid" onSubmit={e => {
            e.preventDefault(); const form = e.currentTarget, f = new FormData(form);
            const movements = source.movements!.map(m => ({ lotId: m.lotId, quantity: Number(f.get(m.lotId)) })).filter(m => m.quantity !== 0);
            run("correctionPropose", { kind: source.kind, sourceId: source.id, quantity: Number(f.get("quantity")),
              movements, reason: f.get("reason"), evidence: f.get("evidence") }).then(() => form.reset()).catch(() => {});
          }}>
            <p>Original: {source.original} · Effective: {source.effective} {source.kind === "distribution" ? "kits" : "units"}. Enter signed changes for the exact original lots: positive adds stock; negative removes stock. Zero leaves a lot unchanged.</p>
            <Field label={source.kind === "distribution" ? "Corrected kits handed out" : "Corrected receipt units"}>
              <input name="quantity" type="number" min="0" max="100000" defaultValue={source.effective} required />
            </Field>
            {source.movements.map(m => <Field key={m.lotId} label={`${m.sku} change · lot ${m.lotId}`}>
              <input name={m.lotId} type="number" min="-100000" max="100000" defaultValue={0} required />
            </Field>)}
            <Field label="Correction reason"><textarea name="reason" maxLength={2000} required /></Field>
            <Field label="Physical count evidence reference"><textarea name="evidence" maxLength={2000} required /></Field>
            <label className="checkbox"><input type="checkbox" required /> I checked the physical stock and exact source lots.</label>
            <button className="primary">Propose correction for owner review</button>
          </form>)}
      </>}
      {w.actor.role !== "coordinator" && <p>A coordinator submits the recount. Finance can inspect it; only an owner other than its proposer can approve. A solo operator must invite a separate coordinator.</p>}
      {sources.length === 0 && <Empty title="No completed stock records">Receive a shipment or record a distribution before reporting a discrepancy.</Empty>}
    </Panel>
    {(w.stockCorrections ?? []).map(c => <Panel key={c.id} title={`${c.kind} correction · ${c.status}`} subtitle={`Source ${c.sourceId} · site ${c.siteId} · proposal ${c.id}`}>
      <p>Original {c.originalQuantity} → corrected {c.quantity} {c.kind === "distribution" ? "kits" : "units"}. Original source history is retained.</p>
      <p>Reason: {c.reason}</p><p>Evidence: {c.evidence}</p>
      <p>Proposed by {w.actors.find(a => a.id === c.proposerId)?.name ?? c.proposerId}. Review expires {new Date(c.expiresAt).toLocaleString()}.</p>
      <ul>{c.movements.map(m => {
        const lot = c.basis?.lots.find(l => l.lotId === m.lotId);
        return <li key={m.lotId}>{m.sku} · lot {m.lotId} · {m.quantity > 0 ? "+" : ""}{m.quantity} units
          {lot && <> · recorded stock {lot.quantity} → {lot.quantity + m.quantity}, version {lot.version}, reserved {lot.reserved}, expiry {lot.expiresAt ?? "not recorded"}</>}
        </li>;
      })}</ul>
      {c.status === "proposed" && w.actor.role === "owner" && w.actor.id !== c.proposerId && <form onSubmit={e => {
        e.preventDefault(); run("correctionApprove", { id: c.id, digest: c.digest }).catch(() => {});
      }}>
        <label className="checkbox"><input type="checkbox" required /> I reviewed the recount evidence and every exact lot change above.</label>
        <button className="primary">Approve and apply exact correction</button>
      </form>}
      {c.status === "proposed" && (w.actor.role === "owner" || c.proposerId === w.actor.id) && <button className="secondary" onClick={() => run("correctionReject", { id: c.id }).catch(() => {})}>Reject proposal and recount</button>}
      {c.status === "applied" && <p role="status">Applied once by {w.actors.find(a => a.id === c.approverId)?.name ?? c.approverId}. Stock and effective totals include this correction; payments are unchanged.</p>}
    </Panel>)}
  </>;
}
