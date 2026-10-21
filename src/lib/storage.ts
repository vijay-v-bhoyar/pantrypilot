import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { configuration } from "./config";
import { ensure } from "./errors";
import type { Workspace } from "./types";

const storageRoot = () =>
  path.resolve(
    /*turbopackIgnore: true*/ process.env.PANTRYPILOT_DATA_DIR || ".data",
  );
const queues = new Map<string, Promise<unknown>>();
function filename(id: string) {
  ensure(
    /^[a-zA-Z0-9-]{1,80}$/.test(id),
    "IDENTIFIER",
    "Invalid workspace identifier.",
  );
  return path.join(storageRoot(), `${id}.json`);
}
function supabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
export async function loadWorkspace(id: string): Promise<Workspace> {
  filename(id);
  if (configuration().storage === "supabase") {
    const { data, error } = await supabase()
      .from("workspaces")
      .select("payload")
      .eq("id", id)
      .single();
    ensure(!error && data, "NOT_FOUND", "Workspace not found.", 404);
    return {
      ...data.payload,
      stockReservations: data.payload.stockReservations || [],
    } as Workspace;
  }
  try {
    const state = JSON.parse(await readFile(filename(id), "utf8")) as Workspace;
    state.stockReservations ??= [];
    return state;
  } catch {
    throw new Error("Workspace unavailable. Start a new isolated demo.");
  }
}
export async function createWorkspace(workspace: Workspace) {
  filename(workspace.id);
  if (configuration().storage === "supabase") {
    const { error } = await supabase().from("workspaces").insert({
      id: workspace.id,
      owner_id: workspace.ownerId,
      payload: workspace,
      revision: workspace.revision,
      demo: workspace.demo,
    });
    ensure(!error, "PERSISTENCE", "Workspace could not be created.", 503);
  } else {
    await mkdir(storageRoot(), { recursive: true });
    await writeFile(filename(workspace.id), JSON.stringify(workspace), {
      flag: "wx",
    });
  }
}
export async function withWorkspace<T>(
  id: string,
  mutation: (state: Workspace) => Promise<T> | T,
  membership?: { userId: string; actorId: (result: T) => string },
): Promise<T> {
  ensure(
    !membership || configuration().storage === "supabase",
    "AUTH_CONFIG",
    "Membership enrollment requires atomic Supabase storage.",
    503,
  );
  // Serialize local mutations within the supported single Node process. Supabase uses CAS leases.
  const previous = queues.get(id) || Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      if (configuration().storage === "supabase") {
        const client = supabase();
        const lease = randomUUID();
        const { data, error } = await client.rpc("claim_workspace", {
          workspace_id: id,
          lease_id: lease,
        });
        ensure(
          !error && data,
          "BUSY",
          "Another operation is processing. Retry shortly.",
          409,
        );
        const state = data as Workspace;
        try {
          const result = await mutation(state);
          state.revision++;
          state.updatedAt = new Date().toISOString();
          const memberActor = membership?.actorId(result);
          ensure(
            !membership || state.actors.some((a) => a.id === memberActor),
            "AUTH_ENROLLMENT",
            "Membership actor could not be confirmed.",
            503,
          );
          const saved = await client.rpc(
            membership ? "save_workspace_membership" : "save_workspace",
            {
              workspace_id: id,
              lease_id: lease,
              new_payload: state,
              ...(membership
                ? {
                    member_user_id: membership.userId,
                    member_actor_id: memberActor,
                  }
                : {}),
            },
          );
          ensure(
            !saved.error && saved.data === true,
            "PERSISTENCE",
            "Operation state could not be confirmed.",
            503,
          );
          return result;
        } finally {
          await client.rpc("release_workspace", {
            workspace_id: id,
            lease_id: lease,
          });
        }
      }
      const state = await loadWorkspace(id);
      const result = await mutation(state);
      state.revision++;
      state.updatedAt = new Date().toISOString();
      const temp = `${filename(id)}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state));
      // Windows scanners/sync clients can briefly lock the destination. Retry
      // only the same staged atomic rename, never the mutation/provider action.
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temp, filename(id));
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 2 || !["EPERM", "EACCES", "EBUSY"].includes(code || "")) throw error;
          await delay(50 * (attempt + 1));
        }
      }
      return result;
    });
  queues.set(id, operation);
  try {
    return await operation;
  } finally {
    if (queues.get(id) === operation) queues.delete(id);
  }
}
