import { readdir, readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { configuration } from "../src/lib/config";
import { archiveEligible } from "../src/lib/retention";
import { snapshot } from "../src/lib/snapshot";
import type { Workspace } from "../src/lib/types";
if (configuration().storage !== "local")
  throw new Error(
    "Use the separately qualified hosted retention procedure for Supabase.",
  );
const root = path.resolve(process.env.PANTRYPILOT_DATA_DIR || ".data");
const archive = path.resolve("backups/expired-demos");
const apply = process.argv.slice(2).includes("--apply");
let count = 0;
for (const file of await readdir(root).catch(() => [])) {
  if (!/^[a-zA-Z0-9-]{1,80}\.json$/.test(file)) continue;
  const target = path.resolve(root, file);
  if (path.dirname(target) !== root)
    throw new Error("Retention path escaped its data directory.");
  const w = JSON.parse(await readFile(target, "utf8")) as Workspace;
  if (!archiveEligible(w)) continue;
  count++;
  if (apply) {
    await mkdir(archive, { recursive: true });
    await writeFile(
      path.join(archive, `${w.id}-${Date.now()}.json`),
      JSON.stringify(snapshot(w)),
      { flag: "wx" },
    );
    await unlink(target);
  }
}
console.log(
  `${apply ? "Archived" : "Dry run:"} ${count} inactive synthetic workspaces. Provider-backed and active workspaces are retained. ${apply ? "Snapshots remain in backups/expired-demos." : "Run with --apply only when authorized to archive these local demos."}`,
);
