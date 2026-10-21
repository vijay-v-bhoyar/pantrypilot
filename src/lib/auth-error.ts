export function authErrorResponse(
  request: Request,
  response: Response,
  context: "login" | "callback",
) {
  const acceptsHtml = request.headers.get("accept")?.split(",").some((entry) => {
    const [media, ...parameters] = entry.toLowerCase().trim().split(";");
    const quality = parameters.find((value) => value.trim().startsWith("q="));
    return media.trim() === "text/html" &&
      (quality === undefined || Number(quality.split("=")[1]) > 0);
  });
  if (response.status < 400 || !acceptsHtml) return response;
  const callback = context === "callback";
  const title = callback ? "Sign-in needs another try" : "Google sign-in is unavailable";
  const explanation = callback
    ? "We could not complete sign-in. Your pantry setup may already be saved. Start Google sign-in again to safely resume."
    : "Sign-in setup could not be confirmed. Return to PantryPilot and ask your pantry owner to review the setup.";
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · PantryPilot</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f7f8f2;color:#233a36;font:16px/1.6 Arial,sans-serif}main{width:min(100%,36rem);padding:28px;background:#fff;border:1px solid #e1e7df;border-radius:18px}h1{line-height:1.2}a{color:#174f46;text-decoration:underline;display:inline-block;margin:8px 16px 8px 0}a:focus-visible{outline:3px solid #174f46;outline-offset:4px}</style></head>
<body><main><p>PantryPilot</p><h1>${title}</h1><p>${explanation}</p>
<p>If you were joining a pantry, keep the original invitation tab open and return there after signing in.</p>
<a href="/">Return to PantryPilot</a>
${callback ? '<a href="/api/auth/login">Try Google sign-in again</a>' : ""}
</main></body></html>`;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.append("Vary", "Accept");
  return new Response(html, { status: response.status, headers });
}

