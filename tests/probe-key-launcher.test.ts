import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ readProbe: vi.fn(), settings: vi.fn(), validate: vi.fn(), record: vi.fn(), spawn: vi.fn(),
  sent: [] as { command: string; args: string[]; env: NodeJS.ProcessEnv; envReference: NodeJS.ProcessEnv;
    stdio: string[]; shell: boolean }[] }));
vi.mock("../scripts/lib/planner-probe", async (original) => ({ ...await original<typeof import("../scripts/lib/planner-probe")>(),
  readProbe: m.readProbe, admitProbeRuntimeSettings: m.settings, validateProbeApproval: m.validate }));
vi.mock("../scripts/lib/planner-quota", async (original) => ({ ...await original<typeof import("../scripts/lib/planner-quota")>(), readRecord: m.record }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: m.spawn }));
import { runKeyedProbe } from "../scripts/probe-with-key";
class Input extends EventEmitter {
  isTTY = true; isRaw = false; readableFlowing: boolean | null = null;
  setRawMode(raw: boolean) { this.isRaw = raw; } pause() { this.readableFlowing = false; } resume() { this.readableFlowing = true; }
}
function io() { const input = new Input(), writes: string[] = [];return { input, writes,
  output: { isTTY: true, write(text: string) { writes.push(text); } } }; }
const id = "00000000-0000-4000-8000-000000000002", args = [id, "synthetic-approval.json"], key = "synthetic-only-launcher-key-123456";
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("GEMINI_API_KEY", undefined); m.sent.length = 0;
  m.readProbe.mockResolvedValue({ manifest: {} }); m.record.mockResolvedValue({});
  m.spawn.mockImplementation((command: string, childArgs: string[], options: { env: NodeJS.ProcessEnv; stdio: string[]; shell: boolean }) => {
    m.sent.push({ command, args: childArgs, env: { ...options.env }, envReference: options.env, stdio: options.stdio, shell: options.shell });
    const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 0)); return child;
  });
});
afterEach(() => { vi.unstubAllEnvs(); });
it.each([["init", "synthetic.json"], [id], [id, "wrong-extension.txt"], [id, "synthetic.json", "extra"]])(
  "rejects malformed/run-incompatible arguments %# before prompting or spawning", async (...values) => {
    const f = io(); await expect(runKeyedProbe(values, f.input, f.output)).rejects.toThrow();
    expect(f.writes).toEqual([]); expect(m.spawn).not.toHaveBeenCalled();
  });
it("refuses an inherited key without using or replacing it", async () => {
  vi.stubEnv("GEMINI_API_KEY", "synthetic-inherited-not-read"); const f = io();
  await expect(runKeyedProbe(args, f.input, f.output)).rejects.toThrow();
  expect(f.writes).toEqual([]); expect(m.spawn).not.toHaveBeenCalled();
});
it.each(["manifest", "settings", "approval"])("failed non-secret %s admission never prompts or spawns", async (stage) => {
  if (stage === "manifest") m.readProbe.mockRejectedValueOnce(new Error("fixture"));
  if (stage === "settings") m.settings.mockImplementationOnce(() => { throw new Error("fixture"); });
  if (stage === "approval") m.validate.mockImplementationOnce(() => { throw new Error("fixture"); });
  const f = io(); await expect(runKeyedProbe(args, f.input, f.output)).rejects.toThrow();
  expect(f.writes).toEqual([]); expect(m.spawn).not.toHaveBeenCalled();
});
it("rejects stale approval after owner input before a child can start", async () => {
  m.validate.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("stale fixture"); });
  const f = io(), result = runKeyedProbe(args, f.input, f.output); const rejected = expect(result).rejects.toThrow();
  await vi.waitFor(() => expect(f.input.isRaw).toBe(true)); f.input.emit("data", key + "\r"); await rejected;
  expect(m.spawn).not.toHaveBeenCalled(); expect(f.input.isRaw).toBe(false); expect(f.writes.join("")).not.toContain(key);
});
it("launches only the fixed existing run CLI once; secret is not an argument/output and parent stays unset", async () => {
  const f = io(), result = runKeyedProbe(args, f.input, f.output);
  await vi.waitFor(() => expect(f.input.isRaw).toBe(true)); f.input.emit("data", key + "\r"); expect(await result).toBe(0);
  expect(m.sent).toHaveLength(1); expect(m.sent[0].command).toBe(process.execPath);
  expect(m.sent[0].args.slice(0, 2)).toEqual(["--import", "tsx"]);
  expect(m.sent[0].args[2]).toMatch(/[\\/]scripts[\\/]planner-probe\.ts$/);
  expect(m.sent[0].args.slice(3, 5)).toEqual(["run", id]); expect(m.sent[0].args.join(" ")).not.toContain(key);
  expect(m.sent[0].env.GEMINI_API_KEY).toBe(key); expect(m.sent[0].envReference.GEMINI_API_KEY).toBeUndefined();
  expect(process.env.GEMINI_API_KEY).toBeUndefined(); expect(m.sent[0].shell).toBe(false);
  expect(m.sent[0].stdio).toEqual(["ignore", "ignore", "ignore"]); expect(f.writes.join("")).not.toContain(key);
  expect(m.validate).toHaveBeenCalledTimes(2); expect(m.settings).toHaveBeenCalledTimes(2);
});
it("cancellation starts no child", async () => {
  const f = io(), result = runKeyedProbe(args, f.input, f.output); const rejected = expect(result).rejects.toThrow();
  await vi.waitFor(() => expect(f.input.isRaw).toBe(true)); f.input.emit("data", "\x03"); await rejected;
  expect(m.spawn).not.toHaveBeenCalled(); expect(f.input.isRaw).toBe(false);
});
it("child failures return a generic nonzero code without propagating its diagnostic", async () => {
  m.spawn.mockImplementation(() => { const child = new EventEmitter();queueMicrotask(() => child.emit("error", new Error(key)));return child; });
  const f = io(), result = runKeyedProbe(args, f.input, f.output);
  await vi.waitFor(() => expect(f.input.isRaw).toBe(true)); f.input.emit("data", key + "\r"); expect(await result).toBe(1);
  expect(process.env.GEMINI_API_KEY).toBeUndefined(); expect(f.writes.join("")).not.toContain(key);
});
