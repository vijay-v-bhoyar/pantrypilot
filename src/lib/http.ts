import { AppError } from "./errors";
import { ZodError } from "zod";
export async function respond(action: () => Promise<unknown>) {
  try {
    return Response.json(await action());
  } catch (error) {
    if (error instanceof ZodError)
      return Response.json(
        {
          error: {
            code: "INPUT",
            message: "The request has missing or invalid fields.",
          },
        },
        { status: 422 },
      );
    const known = error instanceof AppError;
    return Response.json(
      {
        error: {
          code: known ? error.code : "UNAVAILABLE",
          message: known
            ? error.message
            : "The operation could not complete. Your existing records are preserved.",
        },
      },
      { status: known ? error.status : 503 },
    );
  }
}
export async function body(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > 65536)
    throw new AppError("SIZE", "Request is too large.", 413);
  const value = await request.text();
  if (value.length > 65536)
    throw new AppError("SIZE", "Request is too large.", 413);
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError("JSON", "Use a valid JSON request.");
  }
}
