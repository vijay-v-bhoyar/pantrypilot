import { EventEmitter } from "node:events";

export interface HiddenInput extends EventEmitter {
  isTTY?: boolean; isRaw?: boolean; readableFlowing: boolean | null;
  setRawMode(value: boolean): unknown; resume(): unknown; pause(): unknown;
}
export interface HiddenOutput { isTTY?: boolean; write(text: string): unknown }
const refused = () => new Error("Hidden key entry refused or cancelled. No credential was saved.");

/** Owner types/pastes in a real terminal. No echo, file, clipboard API or key hash. */
export function readHiddenProbeKey(input: HiddenInput, output: HiddenOutput, timeoutMs = 15000): Promise<string> {
  if (!input.isTTY || !output.isTTY || input.isRaw || input.listenerCount("data") ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) return Promise.reject(refused());
  return new Promise((resolve, reject) => {
    let buffer = "", settled = false;
    const flowing = input.readableFlowing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (accept: boolean) => {
      if (settled) return; settled = true;
      const key = accept && /^[\x21-\x7e]{16,256}$/.test(buffer) ? buffer : "";
      buffer = "";
      if (timer) clearTimeout(timer);
      input.off("data", onData).off("end", onEnd).off("close", onEnd).off("error", onEnd);
      try {
        input.setRawMode(false);
        if (flowing !== true) input.pause();
        output.write("\n");
      } catch { reject(refused()); return; }
      if (key) resolve(key); else reject(refused());
    };
    const onEnd = () => finish(false);
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "\x03";
      for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === "\r" || char === "\n") {
          finish(/^[\r\n]*$/.test(text.slice(index))); return;
        }
        if (char === "\x08" || char === "\x7f") { buffer = buffer.slice(0, -1); continue; }
        if (!/^[\x21-\x7e]$/.test(char) || buffer.length >= 256) { finish(false); return; }
        buffer += char;
      }
    };
    try {
      input.pause(); input.setRawMode(true);
      input.on("data", onData).once("end", onEnd).once("close", onEnd).once("error", onEnd);
      output.write("Enter the approved Gemini key (hidden; Enter submits, Ctrl+C cancels; 15 seconds): ");
      timer = setTimeout(onEnd, timeoutMs); input.resume();
    } catch { finish(false); }
  });
}

/** Copy only admitted runtime fields; other credentials and debug settings are excluded. */
export function probeChildEnvironment(parent: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const names = ["SystemRoot", "WINDIR", "COMSPEC", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "USERPROFILE", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS", "NODE_ENV", "NODE_OPTIONS", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE",
    "PP_H2_EGRESS_LOG", "PP_H2_ALLOW_LOOPBACK", "PP_H2_BROWSER_PRELOAD", "PP_H2_BROWSER_DENIAL_LOG",
    "APP_ENV", "STORAGE_MODE", "AI_MODE", "PAYMENTS_MODE", "FINANCIAL_ACTIONS_ENABLED", "PROVIDER_ACTIONS_ENABLED",
    "APP_URL", "PANTRYPILOT_DATA_DIR", "GEMINI_MODEL", "AI_MAX_HTTP_REQUESTS", "AI_MAX_INPUT_BYTES",
    "AI_MAX_OUTPUT_TOKENS", "AI_TIMEOUT_MS", "RUN_INITIAL_GEMINI_PROBE", "PROBE_APPROVED_APPROVAL_SHA256",
    "PROBE_CREDENTIAL_REFERENCE", "PROBE_OPERATOR", "NEXT_TELEMETRY_DISABLED"];
  const env: NodeJS.ProcessEnv = { NODE_ENV: parent.NODE_ENV };
  for (const name of names) if (parent[name] !== undefined) env[name] = parent[name];
  env.GEMINI_API_KEY = key;
  return env;
}
