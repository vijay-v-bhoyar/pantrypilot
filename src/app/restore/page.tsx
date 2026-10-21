"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sprout } from "lucide-react";
export default function Restore() {
  const router = useRouter();
  const [id, setId] = useState(""),
    [error, setError] = useState("");
  return (
    <main className="welcome-loading">
      <Sprout size={40} />
      <h1>Resume a restored demo</h1>
      <p>Run the local restore command, then enter its new workspace ID.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await fetch("/api/restore-session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspaceId: id }),
          });
          const d = await r.json();
          if (r.ok) router.push("/workspace");
          else setError(d.error?.message || "Restore session unavailable.");
        }}
      >
        <label className="field">
          <span>Restored workspace UUID</span>
          <input value={id} onChange={(e) => setId(e.target.value)} required />
        </label>
        <button className="primary">Resume isolated workspace</button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
