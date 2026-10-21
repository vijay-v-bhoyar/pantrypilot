import { z } from "zod";
import { paymentAction } from "@/lib/payments";
import { checkOrigin, getSession } from "@/lib/session";
import { body, respond } from "@/lib/http";
export async function POST(request: Request) {
  return respond(async () => {
    checkOrigin(request);
    const s = await getSession();
    const d = z
      .object({
        id: z.string().min(1).max(80),
        action: z.enum([
          "create",
          "capture",
          "cancel",
          "refund",
          "subscription",
          "cancel_subscription",
          "reconcile",
        ]),
      })
      .strict()
      .parse(await body(request));
    return paymentAction(s, d.id, d.action);
  });
}
