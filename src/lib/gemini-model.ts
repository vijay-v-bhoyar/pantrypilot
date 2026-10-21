import { ensure } from "./errors";

export function requiredGeminiModel() {
  const model = process.env.GEMINI_MODEL?.trim();
  ensure(
    model && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(model),
    "AI_MODEL",
    "Select and qualify an explicit Gemini model before enabling AI. No default or fallback model is used.",
    503,
  );
  return model;
}
