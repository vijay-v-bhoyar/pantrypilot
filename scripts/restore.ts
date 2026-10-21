import { readFile } from "node:fs/promises";
import { configuration } from "../src/lib/config";
import { restoreDemo } from "../src/lib/snapshot";
import { createWorkspace } from "../src/lib/storage";
if (configuration().storage !== "local")
  throw new Error("Restore is local only.");
if (!process.argv[2])
  throw new Error("Usage: npm run restore -- <snapshot path>");
const w = restoreDemo(JSON.parse(await readFile(process.argv[2], "utf8")));
await createWorkspace(w);
console.log(
  `Restored as new isolated workspace ${w.id}. POST this UUID to /api/restore-session from the local app to resume.`,
);
