"use client";
import type { ReactNode } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { usd } from "@/lib/money";
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span>✳</span>
      <h3>{title}</h3>
      <p>{children || "Your next action will appear here."}</p>
    </div>
  );
}
export function Stat({
  label,
  value,
  detail,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  accent?: boolean;
}) {
  return (
    <article className={`stat ${accent ? "accent" : ""}`}>
      <div className="stat-label">
        {label}
        <ArrowUpRight size={17} />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
export function Panel({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Progress({ value, max }: { value: number; max: number }) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label="Campaign funding progress"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <i
        style={{ width: `${Math.min(100, Math.max(0, (value / max) * 100))}%` }}
      />
    </div>
  );
}
export function Amount({ value }: { value: number }) {
  return <span className="tabular">{usd(value)}</span>;
}
