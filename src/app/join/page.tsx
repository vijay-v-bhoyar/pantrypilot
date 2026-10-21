"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Sprout } from "lucide-react";
export default function Join() {
  const router = useRouter();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function join() {
    setBusy(true);
    try {
      const p = new URLSearchParams(location.search);
      const r = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: p.get("workspace"),
          token: p.get("token") || undefined,
          campaignId: p.get("campaign") || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || "Could not join.");
      router.push("/workspace");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <main className="welcome-loading">
      <Sprout size={40} />
      <h1>Your pantry invitation</h1>
      <p>
        First sign in with Google, then return to this invitation page and
        accept.
      </p>
      <a
        className="secondary"
        href="/api/auth/login"
        target="_blank"
        rel="noreferrer"
      >
        Sign in with Google
      </a>
      <button className="primary" onClick={join} disabled={busy}>
        {busy ? "Joining…" : "Accept invitation or join campaign"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="fine">
        Synthetic demos use the built-in role tour instead of real membership
        enrollment.
      </p>
    </main>
  );
}
