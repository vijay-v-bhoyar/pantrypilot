import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { ensure } from "../src/lib/errors";
const root = process.cwd();
const assert = (ok: unknown) => ensure(ok, "COMMUNITY_BUILD", "Community-only build verification refused. No rights or release approval is claimed.");
const native = (name: string) => /^(?:ag-studio(?:-react)?|ag-grid-enterprise|ag-charts-enterprise)(?:\/|$)/.test(name) ||
  /^@ag-(?:grid|charts)-enterprise\//.test(name);
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink()); const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file)); else if (entry.isFile()) result.push(file);
  }
  return result;
}
async function main() {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
  };
  assert(!Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }).some(native));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")) as { packages: Record<string, unknown> };
  assert(!Object.keys(lock.packages).some((name) => name.split("node_modules/").some(native)));
  const modules = await lstat(path.join(root, "node_modules")); assert(modules.isDirectory() && !modules.isSymbolicLink());
  for (const name of ["ag-studio", "ag-studio-react", "ag-grid-enterprise", "ag-charts-enterprise"]) {
    let exists = false;
    try { await lstat(path.join(root, "node_modules", name)); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    assert(!exists);
  }
  let sourceCount = 0;
  for (const file of await files(path.join(root, "src"))) {
    if (!/\.tsx?$/.test(file)) continue; sourceCount++;
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        assert(!native(node.moduleSpecifier.text));
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0]; if (argument && ts.isStringLiteral(argument)) assert(!native(argument.text));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const buildId = (await readFile(path.join(root, ".next", "BUILD_ID"), "utf8")).trim(); assert(buildId.length > 0);
  const chunks = (await files(path.join(root, ".next", "static"))).filter((file) => /\.js$/.test(file));
  const traces = (await files(path.join(root, ".next", "server"))).filter((file) => /\.nft\.json$/.test(file));
  assert(sourceCount > 0 && chunks.length > 0 && traces.length > 0);
  const digest = createHash("sha256");
  for (const file of [...chunks, ...traces].sort()) {
    const data = await readFile(file); const text = data.toString("utf8");
    assert(!/(?:node_modules[\\/]|\.pnpm[\\/])ag-studio(?:-react)?(?:[\\/@]|\b)|AgStudioLicenseManager|AgStudioModuleRegistry|ag-studio-react/.test(text));
    digest.update(path.relative(root, file) + "\0").update(data);
  }
  console.log(JSON.stringify({ status: "COMMUNITY_BUILD_BOUNDARY_PASS", buildId, sourceCount,
    chunks: chunks.length, traces: traces.length, artifactDigest: digest.digest("hex"),
    scope: "no declared/locked or checked installed commercial Grid/Studio dependency; no observed compiled Studio reference; not a licence/release certificate" }));
}
main().catch(() => { console.log("Community build verification failed. Preserve the candidate and inspect its bounded receipt."); process.exitCode = 1; });
