import { loadWorkspace } from "@/lib/storage";
import { view } from "@/lib/commands";
import { getSession } from "@/lib/session";
import { respond } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET() {
  return respond(async () => {
    const s = await getSession();
    return view(await loadWorkspace(s.workspaceId), s.actorId);
  });
}
