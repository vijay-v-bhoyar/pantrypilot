import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";

const run = promisify(execFile);
it("packages only allowlisted source/docs/tests with exact hashes, without overwrite", async () => {
  const base = path.resolve("output");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "handover-test-"));
  const destination = path.join(directory, "source.zip");
  try {
    const result = await run("python", ["scripts/prepare-handover.py", "--destination", destination], { timeout: 15000 });
    const receipt = JSON.parse(result.stdout);
    const manifest = JSON.parse(await readFile(path.join(directory, "source.manifest.json"), "utf8"));
    const names: string[] = Object.keys(manifest.files);
    expect(names).toContain("src/lib/model-budget.ts");
    expect(names).toContain("tests/model-budget.test.ts");
    expect(names).toContain("docs/handover/persona-workflows.json");
    for (const name of ["scripts/lib/planner-campaign.ts", "scripts/lib/planner-quota.ts",
      "tests/planner-campaign-cli.test.ts", "tests/planner-campaign.test.ts",
      "tests/planner-clock.test.ts", "tests/planner-quota.test.ts"]) {
      expect(names).toContain(name);
      expect(manifest.files[name]).toBe(createHash("sha256").update(await readFile(name)).digest("hex"));
    }
    for (const [target, source] of Object.entries({
      "README.md": "docs/public-source/README.md",
      "docs/planning/README.md": "docs/public-source/planning-index.md",
      "docs/planning/contracts.md": "docs/public-source/contracts.md",
      "docs/testing/next-local-01-v1/README.md": "docs/public-source/worksheets.md",
    })) {
      expect(names).toContain(source);
      expect(manifest.files[target]).toBe(createHash("sha256").update(await readFile(source)).digest("hex"));
      expect(manifest.files[source]).toBe(manifest.files[target]);
    }
    expect(names.filter((name) => name.startsWith("docs/planning/"))).toEqual([
      "docs/planning/README.md", "docs/planning/contracts.md",
    ]);
    expect(names.filter((name) => name.startsWith("docs/handover/"))).toEqual([
      "docs/handover/persona-workflows.json",
    ]);
    expect(names).toContain("package-lock.json");
    expect(names).toContain(".env.example");
    expect(names).toContain("LICENSE");
    expect(manifest.files.LICENSE).toBe(createHash("sha256").update(await readFile("LICENSE")).digest("hex"));
    const licensed = await run("python", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.read('LICENSE').startswith(b'MIT License'); print('MIT-in-archive')", destination]);
    expect(licensed.stdout.trim()).toBe("MIT-in-archive");
    for (const name of names) {
      expect(name).not.toMatch(/(^|\/)(?:\.data|output|node_modules|\.next|\.git|backups|test-results|playwright-report)(\/|$)/);
      expect(name === ".env.example" || !name.includes(".env")).toBe(true);
      expect(name).not.toMatch(/(^|\/)(?:\.loop|\.hackops|__pycache__|videos)(\/|$)|\.pyc$/);
      expect(name).not.toMatch(/^docs\/(?:hackathon|verification)\//);
      expect(name).not.toMatch(/account-setup|google-oauth|manual-test-results|manual-test-variants|persona-suite|personas-and-operations\.json/);
      expect(manifest.files[name]).toMatch(/^[a-f0-9]{64}$/);
    }
    const before = await readFile(destination);
    expect(createHash("sha256").update(before).digest("hex")).toBe(receipt.sha256);
    await expect(run("python", ["scripts/prepare-handover.py", "--destination", destination])).rejects.toMatchObject({ code: 1 });
    expect(await readFile(destination)).toEqual(before);
  } finally {
    if (!directory.startsWith(base + path.sep) || !path.basename(directory).startsWith("handover-test-"))
      throw new Error("Refusing cleanup outside dedicated handover test directory.");
    await rm(directory, { recursive: true, force: true });
  }
});
it("refuses credentials, a personal account address and a nonblank example key", async () => {
  const code = `import importlib.util
spec=importlib.util.spec_from_file_location('handover','scripts/prepare-handover.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
samples=[('src/example.ts',('AI'+'za'+'x'*30).encode()),('docs/example.md',('person'+'@gmail.com').encode()),('.env.example',b'GEMINI_API_KEY=private\\nPROVIDER_ACTIONS_ENABLED=false\\nAI_MODE=manual')]
for name,data in samples:
 try:m.validate_content(name,data)
 except ValueError:continue
 raise AssertionError('Sensitive candidate accepted')
print('sensitive-candidates-denied')`;
  const result = await run("python", ["-c", code]);
  expect(result.stdout.trim()).toBe("sensitive-candidates-denied"); expect(result.stderr).toBe("");
});
