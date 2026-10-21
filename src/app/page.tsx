"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  HeartHandshake,
  PackageCheck,
  ShieldCheck,
  Sprout,
  HandCoins,
  Boxes,
} from "lucide-react";
export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function start() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await r.json();
      if (!r.ok)
        throw new Error(data.error?.message || "Could not start demo.");
      router.push("/workspace");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="landing">
      <header className="landing-nav">
        <Link className="brand" href="/">
          <span className="brandmark">
            <Sprout size={23} />
          </span>
          PantryPilot
        </Link>
        <nav>
          <a href="#how">How it works</a>
          <a href="/workspace">
            Resume workspace <ArrowRight size={16} />
          </a>
        </nav>
      </header>
      <main>
        <section className="landing-hero">
          <div>
            <span className="eyebrow">
              <span className="dot" /> BUILT FOR COMMUNITY PANTRIES
            </span>
            <h1>
              Every gift.
              <br />A clearer path
              <br />
              <em>to the pantry.</em>
            </h1>
            <p className="hero-copy">
              Bring giving, supplies, and thoughtful purchasing into one place.
              Make the most of every dollar—and see what actually arrives.
            </p>
            <div className="actions">
              <button onClick={start} disabled={busy} className="primary large">
                {busy
                  ? "Preparing your workspace…"
                  : "Explore the working demo"}
                <ArrowRight size={18} />
              </button>
              <a className="text-link" href="#how">
                See the journey
              </a>
            </div>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <p className="fine">
              Free, isolated demo · Synthetic data · No real payments
            </p>
          </div>
          <div className="hero-art">
            <div className="art-caption">
              <Sprout size={16} /> A little planning. A lot of possibility.
            </div>
            <div className="basket">
              <div className="bag bag-one">
                <span>RICE</span>
                <small>everyday essentials</small>
              </div>
              <div className="bag bag-two">
                <span>OATS</span>
                <small>whole grain</small>
              </div>
              <div className="can">
                <span>BEANS</span>
              </div>
              <div className="soap">SOAP</div>
              <div className="crate">
                <Sprout size={40} />
                <span>
                  made for
                  <br />
                  our neighbors
                </span>
              </div>
            </div>
            <div className="art-note">
              <span className="icon-well">
                <PackageCheck />
              </span>
              <div>
                <strong>From a gift to a complete kit</strong>
                <small>Planned → approved → received → distributed</small>
              </div>
            </div>
            <div className="art-spark">✳</div>
          </div>
        </section>
        <section className="trust-strip">
          <span>
            <ShieldCheck size={19} /> Human approval for every purchase
          </span>
          <span>
            <HandCoins size={19} /> Purpose-aware funding
          </span>
          <span>
            <Boxes size={19} /> Counts backed by stock
          </span>
        </section>
        <section id="how" className="how">
          <span className="eyebrow">ONE CONNECTED JOURNEY</span>
          <h2>Good intentions meet good operations.</h2>
          <div className="three-col">
            {[
              {
                n: "01",
                title: "Give with purpose",
                copy: "Run a campaign and track one-time or monthly gifts against the right fund.",
                Icon: HeartHandshake,
              },
              {
                n: "02",
                title: "Plan with confidence",
                copy: "Compare supplier packs, stock, shipping, and budgets. Finance reviews every basket.",
                Icon: ShieldCheck,
              },
              {
                n: "03",
                title: "Deliver with proof",
                copy: "Recover cancelled supplies, receive shipments, and record actual kit distributions.",
                Icon: PackageCheck,
              },
            ].map(({ n, title, copy, Icon }) => (
              <article className="feature" key={n}>
                <span className="feature-num">{n}</span>
                <Icon size={27} />
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="landing-bottom">
          <h2>A calmer day at the pantry starts here.</h2>
          <button className="primary large" onClick={start} disabled={busy}>
            Open your demo <ArrowRight size={18} />
          </button>
        </section>
      </main>
      <footer>
        PantryPilot · PayPal AI Hackathon build · Sandbox demonstrations do not
        establish real-world impact.
      </footer>
    </div>
  );
}
