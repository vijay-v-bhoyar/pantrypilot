import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { configuration } from "./config";
import { ensure } from "./errors";
export async function authClient() {
  ensure(
    configuration().storage === "supabase" &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    "AUTH_CONFIG",
    "Google sign-in requires configured Supabase Auth.",
    503,
  );
  const c = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => c.getAll(),
        setAll: (values) =>
          values.forEach(({ name, value, options }) =>
            c.set(name, value, options),
          ),
      },
    },
  );
}
export function serviceClient() {
  ensure(
    configuration().storage === "supabase",
    "AUTH_CONFIG",
    "Membership enrollment requires Supabase.",
    503,
  );
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
