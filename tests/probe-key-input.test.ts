import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { readHiddenProbeKey, probeChildEnvironment } from "../scripts/lib/probe-key-input";
const secret = "synthetic-only-pantry-key-123456";
class Input extends EventEmitter {
  isTTY = true; isRaw = false; readableFlowing: boolean | null = null;
  rawChanges: boolean[] = [];
  setRawMode(raw: boolean) { this.isRaw = raw; this.rawChanges.push(raw); }
  pause() { this.readableFlowing = false; } resume() { this.readableFlowing = true; }
}
function fixture() {
  const input = new Input(), writes: string[] = [];
  const output = { isTTY: true, write(text: string) { writes.push(text); } };
  return { input, output, writes };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it("accepts synthetic owner entry without echo and restores the input", async () => {
  const f = fixture(), result = readHiddenProbeKey(f.input, f.output);
  f.input.emit("data", secret + "\r\n"); expect(await result).toBe(secret);
  expect(f.writes.join("")).not.toContain(secret); expect(f.input.isRaw).toBe(false);
  expect(f.input.readableFlowing).toBe(false); expect(f.input.listenerCount("data")).toBe(0);
});
it("handles backspace without writing either the wrong or corrected key", async () => {
  const f = fixture(), result = readHiddenProbeKey(f.input, f.output);
  f.input.emit("data", secret + "x\x7f\r"); expect(await result).toBe(secret);
  expect(f.writes.join("")).not.toContain(secret); expect(f.input.rawChanges).toEqual([true, false]);
});
it.each(["\r", "short\r", secret + "\x03", secret + "\x04", secret + "\x1b", "x".repeat(257),
  secret + " space\r", secret + "é\r", secret + "\rsecond-line"]) (
  "refuses invalid/cancelled entry fixture %# without echo or a retained listener", async (value) => {
    const f = fixture(), result = readHiddenProbeKey(f.input, f.output);
    const rejected = expect(result).rejects.toThrow("Hidden key entry refused or cancelled");
    f.input.emit("data", value); await rejected;
    expect(f.writes.join("")).not.toContain(secret); expect(f.input.isRaw).toBe(false);
    expect(f.input.listenerCount("data")).toBe(0);
  });
it.each(["end", "close", "error"])("restores terminal on input %s", async (event) => {
  const f = fixture(), result = readHiddenProbeKey(f.input, f.output);
  const rejected = expect(result).rejects.toThrow(); f.input.emit(event); await rejected;
  expect(f.input.isRaw).toBe(false); expect(f.input.listenerCount("data")).toBe(0);
});
it("times out, restores input and ignores later data", async () => {
  vi.useFakeTimers(); const f = fixture(), result = readHiddenProbeKey(f.input, f.output, 10);
  const rejected = expect(result).rejects.toThrow(); await vi.advanceTimersByTimeAsync(10); await rejected;
  f.input.emit("data", secret + "\r"); expect(f.input.isRaw).toBe(false); expect(f.writes.join("")).not.toContain(secret);
});
it.each(["input", "output", "raw", "listener"])("refuses unsupported terminal %s before prompting", async (kind) => {
  const f = fixture();
  if (kind === "input") f.input.isTTY = false;
  if (kind === "output") f.output.isTTY = false;
  if (kind === "raw") f.input.isRaw = true;
  if (kind === "listener") f.input.on("data", () => {});
  await expect(readHiddenProbeKey(f.input, f.output)).rejects.toThrow(); expect(f.writes).toEqual([]);
});
it("forwards admitted fields and offline guards, excludes unrelated credentials/debug and preserves the parent", () => {
  const parent = { NODE_ENV: "test" as const, APP_ENV: "local", NODE_OPTIONS: "--require=synthetic-offline-guard.cjs", PP_H2_ALLOW_LOOPBACK: "0",
    PROBE_OPERATOR: "synthetic-owner", GEMINI_API_KEY: "unrelated-existing-value", PAYPAL_SECRET: "other-secret", NODE_DEBUG: "http" };
  const original = { ...parent }, env = probeChildEnvironment(parent, secret);
  expect(env.GEMINI_API_KEY).toBe(secret); expect(env.PAYPAL_SECRET).toBeUndefined(); expect(env.NODE_DEBUG).toBeUndefined();
  expect(env.NODE_OPTIONS).toBe(parent.NODE_OPTIONS); expect(env.PP_H2_ALLOW_LOOPBACK).toBe("0"); expect(parent).toEqual(original);
});
