import { ownedWorkspace } from "./owner-workspace";
export { ownedWorkspace } from "./owner-workspace";
import { z } from "zod";
import { serviceClient } from "./auth";
import { ensure } from "./errors";

const binding = z
  .object({
    workspace_id: z.string().uuid(),
    actor_id: z.string().uuid(),
    created: z.boolean(),
  })
  .strict();
export async function enrollOwner(userId: string) {
  const { data, error } = await serviceClient().rpc(
    "bootstrap_owned_workspace",
    {
      member_user_id: userId,
      initial_payload: ownedWorkspace(userId),
    },
  );
  const result = binding.safeParse(data);
  ensure(
    !error && result.success,
    "AUTH_ENROLLMENT",
    "Sign-in setup could not be confirmed. Sign in again to safely resume.",
    503,
  );
  return result.data;
}
