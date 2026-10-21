import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withWorkspace } from "@/lib/storage";
import { seedWorkspace } from "@/lib/seed";
import type { Workspace } from "@/lib/types";
const io = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), mkdir: vi.fn() }));
vi.mock("node:fs/promises", () => io);
beforeEach(() => {
  vi.stubEnv("APP_ENV", "local"); vi.stubEnv("VERCEL", ""); vi.stubEnv("STORAGE_MODE", "local");
  for (const mock of Object.values(io)) mock.mockReset();
  io.readFile.mockResolvedValue(JSON.stringify(seedWorkspace("rename-fixture")));
  io.writeFile.mockResolvedValue(undefined); io.rename.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe("local atomic commit under file contention", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("retries a transient %s rename without rerunning the command", async code => {
    io.rename.mockRejectedValueOnce(Object.assign(new Error("file temporarily locked"), { code }));
    const mutation = vi.fn((state: Workspace) => { state.organizations[0].name = "Changed once"; return "result"; });
    expect(await withWorkspace("rename-fixture", mutation)).toBe("result");
    expect(mutation).toHaveBeenCalledTimes(1); expect(io.writeFile).toHaveBeenCalledTimes(1);
    expect(io.rename).toHaveBeenCalledTimes(2);
    expect(io.rename.mock.calls[0]).toEqual(io.rename.mock.calls[1]);
    expect(JSON.parse(io.writeFile.mock.calls[0][1]).organizations[0].name).toBe("Changed once");
  });
  it("bounds retries of a persistent lock and never reports a committed result", async () => {
    io.rename.mockRejectedValue(Object.assign(new Error("locked"), { code: "EPERM" }));
    const mutation = vi.fn(() => "result");
    await expect(withWorkspace("rename-fixture", mutation)).rejects.toThrow("locked");
    expect(mutation).toHaveBeenCalledTimes(1); expect(io.writeFile).toHaveBeenCalledTimes(1);
    expect(io.rename).toHaveBeenCalledTimes(3);
  });
  it.each(["ENOENT", "ENOSPC"])("does not retry non-contention error %s", async code => {
    io.rename.mockRejectedValue(Object.assign(new Error(code), { code }));
    const mutation = vi.fn(() => "result");
    await expect(withWorkspace("rename-fixture", mutation)).rejects.toThrow(code);
    expect(io.rename).toHaveBeenCalledTimes(1); expect(mutation).toHaveBeenCalledTimes(1);
  });
  it("does not attempt rename or replay when the staged write fails", async () => {
    io.writeFile.mockRejectedValue(new Error("write failed")); const mutation = vi.fn(() => "result");
    await expect(withWorkspace("rename-fixture", mutation)).rejects.toThrow("write failed");
    expect(io.rename).not.toHaveBeenCalled(); expect(mutation).toHaveBeenCalledTimes(1);
  });
});
