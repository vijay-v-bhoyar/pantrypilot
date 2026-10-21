import { z } from "zod";
import { loadWorkspace } from "@/lib/storage";
import { respond } from "@/lib/http";
import { campaignReceived } from "@/lib/campaign-funding";
export async function GET(request: Request) {
  return respond(async () => {
    const id = z
      .string()
      .uuid()
      .parse(new URL(request.url).searchParams.get("workspace"));
    const w = await loadWorkspace(id);
    return {
      demo: w.demo,
      campaigns: w.campaigns
        .filter((c) => c.status === "published")
        .map((c) => ({
          id: c.id,
          title: c.title,
          description: c.description,
          goal: c.goal,
          targetKits: c.targetKits,
          restricted: c.restricted,
          organization: w.organizations.find((o) => o.id === c.organizationId)
            ?.name,
          received: campaignReceived(w, c),
        })),
    };
  });
}
