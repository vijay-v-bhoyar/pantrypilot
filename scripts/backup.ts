import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadWorkspace } from "../src/lib/storage";
import { snapshot } from "../src/lib/snapshot";
import { configuration } from "../src/lib/config";
const id = process.argv[2];
if (!id || configuration().storage !== "local")
  throw new Error(
    "Usage: npm run backup -- <workspace UUID>. Local storage only.",
  );
const w = await loadWorkspace(id);
const root = path.resolve("backups");
await mkdir(root, { recursive: true });
const target = path.join(root, `${w.id}-${Date.now()}.json`);
await writeFile(target, JSON.stringify(snapshot(w), null, 2), { flag: "wx" });
console.log(`Local snapshot saved: ${target}`);
