import { authClient } from "@/lib/auth";
import { respond } from "@/lib/http";
import { authErrorResponse } from "@/lib/auth-error";
export async function GET(request: Request) {
  let redirect: string | undefined;
  const result = await respond(async () => {
    const client = await authClient();
    const callback = `${process.env.APP_URL}/api/auth/callback`;
    const { data, error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callback },
    });
    if (error || !data.url) throw new Error("Google sign-in unavailable.");
    redirect = data.url;
    return {};
  });
  return redirect ? Response.redirect(redirect) : authErrorResponse(request, result, "login");
}
