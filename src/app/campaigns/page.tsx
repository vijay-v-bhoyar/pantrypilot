"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Sprout } from "lucide-react";
import { usd } from "@/lib/money";
type PublicCampaign = {
  id: string;
  title: string;
  description: string;
  goal: number;
  targetKits: number;
  received: number;
  restricted: boolean;
  organization: string;
};
export default function CampaignPage() {
  const [campaigns, setCampaigns] = useState<PublicCampaign[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("workspace");
    fetch(`/api/campaigns?workspace=${encodeURIComponent(id || "")}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok)
          throw new Error(d.error?.message || "Campaigns unavailable.");
        setCampaigns(d.campaigns);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <main className="public-main">
      <Link className="brand" href="/">
        <Sprout />
        PantryPilot
      </Link>
      <h1 style={{ marginTop: 35 }}>A community effort, with purpose.</h1>
      <p>
        Published campaigns. Aggregate giving only. All demonstration payments
        use simulation or PayPal sandbox.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="two-col">
        {campaigns.map((c) => (
          <article className="panel" key={c.id}>
            <span className="eyebrow">{c.organization}</span>
            <h2>{c.title}</h2>
            <p>{c.description}</p>
            <strong>
              {usd(c.received)} of {usd(c.goal)}
            </strong>
            <p>Net confirmed giving after completed refunds and reversals.</p>
            <p>
              {c.targetKits} kit target ·{" "}
              {c.restricted ? "Purpose restricted" : "Unrestricted support"}
            </p>
            <a
              className="primary"
              href={`/join?workspace=${new URLSearchParams(typeof window !== "undefined" ? location.search : "").get("workspace")}&campaign=${c.id}`}
            >
              Sign in to support this campaign
            </a>
          </article>
        ))}
      </div>
    </main>
  );
}
