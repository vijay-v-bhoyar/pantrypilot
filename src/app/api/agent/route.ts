import { z } from "zod";
import { aiProposal } from "@/lib/ai";
import { checkOrigin, getSession } from "@/lib/session";
import { body, respond } from "@/lib/http";
export async function POST(request: Request) {
  return respond(async () => {
    checkOrigin(request);
    const s = await getSession();
    const d = z
      .object({ requestId: z.string().min(1).max(80) })
      .strict()
      .parse(await body(request));
    return aiProposal(s, d.requestId);
  });
}
