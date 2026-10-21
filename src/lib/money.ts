import { ensure } from "./errors";
import type { Workspace } from "./types";
// Provider decimals must describe exact nonnegative cents, never rounded money.
export function providerCents(value: unknown, code = "AMOUNT") {
  ensure(typeof value === "string" && value.length <= 32 &&
    /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value), code, "Invalid provider money amount.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  ensure(amount <= BigInt(Number.MAX_SAFE_INTEGER), code, "Provider money exceeds safe whole cents.");
  return Number(amount);
}
export const cents = (value: number) => {
  ensure(
    Number.isSafeInteger(value) && value > 0 && value <= 10000000,
    "AMOUNT",
    "Use an amount between $0.01 and $100,000 in whole cents.",
  );
  return value;
};
export const usd = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value / 100,
  );
export function balances(w: Workspace, fundId: string) {
  const posted = w.ledger
    .filter((e) => e.fundId === fundId)
    .reduce((s, e) => s + e.amount, 0);
  const reserved =
    w.orders
      .filter(
        (o) =>
          o.fundId === fundId &&
          ["awaiting_payer", "uncertain"].includes(o.status),
      )
      .reduce((s, o) => s + o.total, 0) +
    w.donations
      .filter((d) => d.fundId === fundId && d.status === "refund_pending")
      .reduce((s, d) => s + d.amount, 0);
  return { posted, reserved, available: posted - reserved };
}
