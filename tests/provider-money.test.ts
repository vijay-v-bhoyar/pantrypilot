import { describe, expect, it } from "vitest";
import { providerCents } from "@/lib/money";

describe("exact provider money", () => {
  it.each([["0", 0], ["0.01", 1], ["1", 100], ["25.0", 2500], ["23.81", 2381],
    ["90071992547409.91", Number.MAX_SAFE_INTEGER]])("converts %s to exact whole cents", (input, expected) => {
    expect(providerCents(input)).toBe(expected);
  });
  it.each(["90071992547409.92", "23.811", "-0.01", "+1.00", "01.00", "1e2", " 25.00", "25.00 ",
    "", ".50", "1.", "Infinity", "NaN", "9".repeat(33), 25, null, undefined])("rejects ambiguous or unsafe money %s", input => {
    expect(() => providerCents(input)).toThrow();
  });
});
