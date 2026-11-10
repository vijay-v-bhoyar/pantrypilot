import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensure } from "../../src/lib/errors";
import { SESSION_A1 } from "./gemini-session-admission";
import type { EvaluationTransportPolicy } from "../../src/lib/model-budget";

export const H2 = Object.freeze({ policy: "PP-FEAS-01-H2", days: 12,
  dailyHttp: 20, caseCounts: 10, caseGenerations: 10, campaignHttp: 240,
  measuredTokens: 50000, reservedTokens: 62500, rollingTokens: 250000,
  windowMs: 60000, startsPerWindow: 4, startGapMs: 16000,
  countTimeoutMs: 10000, caseTimeoutMs: 60000, blockTimeoutMs: 300000,
  maxInputBytes: 32768, maxOutputTokens: 1024, steps: 6, maxRetries: 0 });
// Separate fixed envelope: no caller-selected policy or raised quotas.
export const H3 = Object.freeze({ policy: "PP-FEAS-01-HACKATHON-H3", cases: 12,
  dailyHttp: 20, caseCounts: 6, caseGenerations: 6, campaignHttp: 144,
  measuredTokens: 50000, reservedTokens: 62500, rollingTokens: 250000,
  windowMs: 60000, startsPerWindow: 4, startGapMs: 16000,
  countTimeoutMs: 10000, caseTimeoutMs: 60000, blockTimeoutMs: 300000,
  maxInputBytes: 32768, maxOutputTokens: 1024, steps: 6, maxRetries: 0 });
type FixedPolicy = typeof H2 | typeof H3;
// Freshly observed external use is charged once under the same project lock.
// Probe-attempt and poison rows describe already reserved pairs, not extra HTTP.
export function projectDayUsed(events: Record<string, unknown>[], origin: QuotaOrigin, day: string) {
  const extra = events.filter(e => e.kind === "h3-external-accounting" && e.day === day);
  h2Assert(extra.every(e => Number.isSafeInteger(e.http) && (e.http as number) >= 0 &&
    (e.http as number) <= H2.dailyHttp));
  return events.filter(e => e.kind === "pair-reserved" && e.day === day).length * 2 +
    (origin.day === day ? origin.knownUsed : 0) + extra.reduce((n,e) => n + (e.http as number), 0);
}
export type SafetyClock = { now(): number; monotonic(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void> };
export const safetyClock: SafetyClock = { now: () => Date.now(),
  monotonic: () => performance.now(), sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); } };
export const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const pacificDay = (now: number) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(now));
export function h2Assert(ok: unknown): asserts ok {
  ensure(ok, "EVAL_H2", "H2 admission or accounting was refused. Preserve existing evidence.", 503);
}
export function contained(root: string, ...parts: string[]) {
  const base = path.resolve(root), target = path.resolve(base, ...parts);
  h2Assert(target === base || target.startsWith(base + path.sep)); return target;
}
export async function safeDirectory(directory: string, create = false) {
  const absolute = path.resolve(directory), anchor = path.parse(absolute).root;
  let current = anchor;
  for (const piece of absolute.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    if (create) await mkdir(current).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
    const stat = await lstat(current); h2Assert(stat.isDirectory() && !stat.isSymbolicLink());
  }
  return absolute;
}
export async function readRecord<T>(file: string): Promise<T> {
  await safeDirectory(path.dirname(file)); const stat = await lstat(file);
  h2Assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024);
  return JSON.parse(await readFile(file, "utf8")) as T;
}
export async function writeOnce(file: string, value: unknown) {
  await safeDirectory(path.dirname(file));
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}
export type JournalEntry = { sequence: number; previous: string; value: Record<string, unknown>; hash: string };
// Independent seals detect missing/partial terminal records, not malicious rewriting of both copies.
export class H2Journal {
  constructor(readonly root: string) {}
  async initialize() {
    await safeDirectory(this.root); await mkdir(path.join(this.root, "events"));
    await mkdir(path.join(this.root, "seals"));
  }
  async read(): Promise<JournalEntry[]> {
    await safeDirectory(this.root);
    const events = await safeDirectory(path.join(this.root, "events"));
    const seals = await safeDirectory(path.join(this.root, "seals"));
    const files = (await readdir(events)).sort(), markers = (await readdir(seals)).sort();
    h2Assert(files.length <= 4096 && JSON.stringify(files) === JSON.stringify(markers));
    const result: JournalEntry[] = []; let previous = "0".repeat(64);
    for (const [sequence, file] of files.entries()) {
      h2Assert(file === `${String(sequence).padStart(6, "0")}.json`);
      const event = await readRecord<JournalEntry>(path.join(events, file));
      const marker = await readRecord<{ hash: string }>(path.join(seals, file));
      h2Assert(event.sequence === sequence && event.previous === previous &&
        event.hash === sha({ sequence, previous, value: event.value }) && marker.hash === event.hash);
      result.push(event); previous = event.hash;
    }
    return result;
  }
  async append(value: Record<string, unknown>) {
    const rows = await this.read(), sequence = rows.length;
    const previous = rows.at(-1)?.hash || "0".repeat(64);
    const event = { sequence, previous, value, hash: sha({ sequence, previous, value }) };
    const file = `${String(sequence).padStart(6, "0")}.json`;
    await writeOnce(path.join(this.root, "events", file), event);
    await writeOnce(path.join(this.root, "seals", file), { hash: event.hash });
    return event;
  }
}
export async function withProjectLock<T>(root: string, action: () => Promise<T>) {
  await safeDirectory(root); const file = path.join(root, "block.lock");
  await writeOnce(file, { owner: randomUUID(), pid: process.pid });
  // Any thrown/uncertain operation preserves the lock for separately reviewed recovery.
  const result = await action(); await unlink(file); return result;
}
export type QuotaOrigin = { project: string; day: string; knownUsed: number; evidenceReference: string };
export async function initializeQuota(root: string, origin: QuotaOrigin) {
  h2Assert(/^[a-z][a-z0-9-]{5,62}$/.test(origin.project) && /^\d{4}-\d{2}-\d{2}$/.test(origin.day) &&
    Number.isSafeInteger(origin.knownUsed) && origin.knownUsed >= 0 && origin.knownUsed <= H2.dailyHttp &&
    /^[a-zA-Z0-9._/-]{1,160}$/.test(origin.evidenceReference));
  await safeDirectory(path.dirname(root), true); await mkdir(root);
  const journal = new H2Journal(root); await journal.initialize();
  await writeOnce(path.join(root, "origin.json"), origin);
  await journal.append({ kind: "origin", ...origin });
}
export type QuotaOptions = { root: string; project: string; campaign: string; caseId: number;
  model: string; day: string; approvedDay: string; knownProjectUseReference: string;
  signal: AbortSignal; assertActive(): void; clock?: SafetyClock; transport?: typeof fetch;
  sessionPolicy?: typeof SESSION_A1.id };
export function nextStart(starts: number[], now: number) {
  const recent = starts.filter((t) => now - t < H2.windowMs);
  return Math.max(now, (starts.at(-1) ?? -Infinity) + H2.startGapMs,
    recent.length >= H2.startsPerWindow ? recent[recent.length - H2.startsPerWindow] + H2.windowMs : now);
}
export function measuredTokens(value: unknown) {
  h2Assert(typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= H2.measuredTokens);
  return value as number;
}
export function promptUsage(value: unknown) {
  h2Assert(typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= H2.reservedTokens);
  return value as number;
}
type ResponsePhase = "HTTP_STATUS" | "CONTENT_TYPE" | "BODY_READ" | "JSON_PARSE";
type TransportPhase = "ADMISSION" | "RESERVATION" | "COUNT_PACING" | "COUNT_SEND" |
  `COUNT_${ResponsePhase}` | "COUNT_VALIDATION" | "REQUEST_IDENTITY" | "COUNT_RECORD" |
  "GENERATION_PACING" | "GENERATION_SEND" | `GENERATION_${ResponsePhase}` |
  "GENERATION_USAGE" | "GENERATION_RECORD";
async function boundedJson(response: Response, signal: AbortSignal, phase: (value: ResponsePhase) => void) {
  phase("HTTP_STATUS"); h2Assert(response.ok);
  phase("CONTENT_TYPE"); h2Assert(/application\/json/i.test(response.headers.get("content-type") || ""));
  phase("BODY_READ");
  const clone = response.clone(), reader = clone.body?.getReader(); h2Assert(reader);
  const pieces: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader!.cancel().catch(() => {}); };
  signal.throwIfAborted(); signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) { const chunk = await reader!.read(); signal.throwIfAborted(); if (chunk.done) break;
      size += chunk.value.length; h2Assert(size <= 1024 * 1024); pieces.push(chunk.value); }
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
  phase("JSON_PARSE");
  return JSON.parse(Buffer.concat(pieces).toString("utf8")) as Record<string, unknown>;
}
export function createH2Policy(options: QuotaOptions): EvaluationTransportPolicy {
  return createFixedPolicy(options, H2, 0);
}
export function createH3Policy(options: QuotaOptions & { laterExternalReservedHttp: number }): EvaluationTransportPolicy {
  h2Assert(Number.isSafeInteger(options.laterExternalReservedHttp) && options.laterExternalReservedHttp >= 0 &&
    options.laterExternalReservedHttp <= H3.dailyHttp && Number.isInteger(options.caseId) && options.caseId >= 1 && options.caseId <= 12);
  return createFixedPolicy(options, H3, options.laterExternalReservedHttp);
}
function createFixedPolicy(options: QuotaOptions, policy: FixedPolicy, externalReserved: number): EvaluationTransportPolicy {
  const clock = options.clock || safetyClock, transport = options.transport || fetch;
  h2Assert(options.sessionPolicy === undefined || (options.sessionPolicy === SESSION_A1.id && policy === H2));
  const casePairLimit = options.sessionPolicy === SESSION_A1.id ? 3 : policy.caseCounts;
  const journal = new H2Journal(options.root); let busy = false, poisoned = false, recovered503 = 0;
  const active = () => { options.signal.throwIfAborted(); options.assertActive();
    h2Assert(!poisoned && options.day === options.approvedDay && pacificDay(clock.now()) === options.day); };
  const history = async () => {
    active(); const origin = await readRecord<QuotaOrigin>(path.join(options.root, "origin.json"));
    const events = await journal.read(); h2Assert(events.length > 0 && origin.project === options.project &&
      sha(events[0].value) === sha({ kind: "origin", ...origin }) && origin.day <= options.day &&
      /^[a-zA-Z0-9._/-]{1,160}$/.test(options.knownProjectUseReference));
    const values = events.map((e) => e.value);
    h2Assert(!values.some((e) => e.kind === "poison") && values.every((e) =>
      e.at === undefined || (typeof e.at === "number" && e.at <= clock.now())));
    return { origin, values };
  };
  const emit = async (value: Record<string, unknown>) => {
    active(); return journal.append({ ...value, at: clock.now(), day: options.day,
      campaign: options.campaign, caseId: options.caseId });
  };
  const pace = async (kind: "count-start" | "generation-start", signal: AbortSignal) => {
    for (;;) {
      const { values } = await history(); const now = clock.now();
      const starts = values.filter((e) => e.kind === kind).map((e) => e.at as number);
      const tokens = kind === "generation-start" ? values.filter((e) => e.kind === "generation-start" &&
        now - (e.at as number) < H2.windowMs).length * H2.reservedTokens : 0;
      const next = nextStart(starts, now);
      if (next <= now && tokens + (kind === "generation-start" ? H2.reservedTokens : 0) <= H2.rollingTokens) return;
      await clock.sleep(Math.max(1, next - now), signal); signal.throwIfAborted(); active();
    }
  };
  return { async dispatch(request) {
    active(); h2Assert(!busy && request.modelId === options.model); busy = true;
    const pairSignal = AbortSignal.any([request.signal, options.signal]);
    let phase: TransportPhase = "ADMISSION", httpStatus: number | undefined;
    try {
      for (;;) {
      httpStatus = undefined; phase = "ADMISSION";
      const { origin, values } = await history();
      const reserved = values.filter((e) => e.kind === "pair-reserved");
      const used = projectDayUsed(values, origin, options.day) + externalReserved;
      const own = reserved.filter((e) => e.campaign === options.campaign && e.caseId === options.caseId);
      h2Assert(used + 2 <= policy.dailyHttp && own.length < casePairLimit &&
        reserved.filter((e) => e.campaign === options.campaign).length * 2 + 2 <= policy.campaignHttp);
      const identity = sha({ model: request.modelId, api: "v1beta", body: request.body });
      const pair = randomUUID();
      phase = "RESERVATION";
      await emit({ kind: "pair-reserved", pair, identity,
        usageReference: options.knownProjectUseReference });
      phase = "COUNT_PACING";
      await pace("count-start", pairSignal); active(); request.signal.throwIfAborted();
      await emit({ kind: "count-start", pair, identity }); active();
      const countSignal = AbortSignal.any([request.signal, options.signal, AbortSignal.timeout(H2.countTimeoutMs)]);
      const nested = { ...JSON.parse(request.body), model: `models/${options.model}` };
      phase = "COUNT_SEND";
      const countResponse = await transport(`https://generativelanguage.googleapis.com/v1beta/models/${options.model}:countTokens`, {
        method: "POST", headers: request.init.headers, redirect: "error", signal: countSignal,
        body: JSON.stringify({ generateContentRequest: nested }),
      });
      httpStatus = countResponse.status;
      const counted = await boundedJson(countResponse, countSignal, value => { phase = `COUNT_${value}`; });
      countSignal.throwIfAborted(); active(); phase = "COUNT_VALIDATION";
      const count = measuredTokens(counted.totalTokens);
      phase = "REQUEST_IDENTITY";
      h2Assert(identity === sha({ model: request.modelId, api: "v1beta", body: request.body }));
      phase = "COUNT_RECORD";
      await emit({ kind: "count-result", pair, identity, count });
      phase = "GENERATION_PACING"; httpStatus = undefined;
      await pace("generation-start", pairSignal); active(); request.signal.throwIfAborted();
      await emit({ kind: "generation-start", pair, identity, reservedTokens: H2.reservedTokens });
      active(); phase = "GENERATION_SEND"; httpStatus = undefined;
      const response = await request.send(); httpStatus = response.status;
      // Retry only a returned generation503, within the original combined-pair cap.
      // Never retry the application operation, a network-unknown outcome or a money action.
      if (response.status === 503 && options.sessionPolicy === SESSION_A1.id &&
        recovered503 < SESSION_A1.diagnostic503Retries && own.length + 1 < casePairLimit &&
        used + 4 <= policy.dailyHttp) {
        await emit({ kind: "generation-transient", pair, identity, httpStatus: 503, policy: SESSION_A1.id });
        recovered503++;
        void response.body?.cancel().catch(() => {});
        // New pair means a fresh count and full two-slot reservation, not a free retry.
        continue;
      }
      const body = await boundedJson(response, pairSignal, value => { phase = `GENERATION_${value}`; });
      active(); phase = "GENERATION_USAGE";
      const usage = body.usageMetadata as { promptTokenCount?: unknown } | undefined;
      if (!(typeof usage?.promptTokenCount === "number" && Number.isSafeInteger(usage.promptTokenCount) &&
        usage.promptTokenCount > 0 && usage.promptTokenCount <= H2.reservedTokens)) {
        await emit({ kind: "usage-refused", pair, identity,
          actual: typeof usage?.promptTokenCount === "number" && Number.isSafeInteger(usage.promptTokenCount) ? usage.promptTokenCount : null });
      }
      const actual = promptUsage(usage?.promptTokenCount);
      phase = "GENERATION_RECORD";
      await emit({ kind: "generation-result", pair, identity, count, actual,
        difference: actual - count, reservation: H2.reservedTokens });
      return response;
      }
    } catch {
      poisoned = true;
      // Allowlisted phase/status only: never persist exception, body, URL or headers.
      // Preserve a durable poison even when the safety deadline elapsed.
      await journal.append({ kind: "poison", campaign: options.campaign, caseId: options.caseId,
        day: options.day, at: clock.now(), diagnostic: { version: 1, phase,
          ...(typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ?
            { httpStatus } : {}) } }).catch(() => {});
      throw new Error("H2 transport stopped; preserve accounting and review the incomplete case.");
    } finally { busy = false; }
  } };
}
export async function auditCampaignQuota(root: string, project: string, campaign: string) {
  return auditFixedQuota(root, project, campaign, H2);
}
export async function auditSessionProbeQuota(root: string, project: string, campaign: string) {
  return auditFixedQuota(root, project, campaign, H2, true);
}
export async function auditH3Quota(root: string, project: string, campaign: string) {
  return auditFixedQuota(root, project, campaign, H3);
}
async function auditFixedQuota(root: string, project: string, campaign: string, policy: FixedPolicy, recover503 = false) {
  const origin = await readRecord<QuotaOrigin>(path.join(root, "origin.json"));
  const entries = await new H2Journal(root).read(), events = entries.map((e) => e.value);
  h2Assert(origin.project === project && events.length > 0 && sha(events[0]) === sha({ kind: "origin", ...origin }) &&
    !events.some((e) => e.kind === "poison"));
  h2Assert(recover503 || !events.some(e => e.kind === "generation-transient" && e.campaign === campaign));
  const transients = events.filter(e => e.kind === "generation-transient" && e.campaign === campaign);
  h2Assert(!recover503 || transients.length <= SESSION_A1.diagnostic503Retries);
  const reservations = events.filter((e) => e.kind === "pair-reserved");
  const days = new Set(reservations.map((e) => e.day));
  for (const day of days) h2Assert(typeof day === "string" && day >= origin.day &&
    projectDayUsed(events, origin, day) <= policy.dailyHttp);
  const own = reservations.filter((e) => e.campaign === campaign);
  h2Assert(transients.every(e => own.some(p => p.pair === e.pair)));
  h2Assert(own.length * 2 <= policy.campaignHttp && new Set(own.map((e) => e.pair)).size === own.length);
  const cases = Array.from({ length: 12 }, (_, index) => {
    const pairs = own.filter((e) => e.caseId === index + 1); h2Assert(pairs.length <= policy.caseCounts);
    let countCalls = 0, generationCalls = 0;
    for (const pair of pairs) {
      const related = events.filter((e) => e.pair === pair.pair);
      const transient = related.filter(e => e.kind === "generation-transient");
      h2Assert(transient.length <= 1 && (!transient.length || (recover503 && transient[0].httpStatus === 503 &&
        transient[0].policy === SESSION_A1.id && transient[0].identity === pair.identity &&
        transient[0].campaign === campaign && transient[0].caseId === pair.caseId && transient[0].day === pair.day &&
        !related.some(e => e.kind === "generation-result"))));
      for (const kind of ["count-start", "count-result", "generation-start", ...(transient.length ? [] : ["generation-result"])]) {
        const matching = related.filter((e) => e.kind === kind);
        h2Assert(matching.length === 1 && matching[0].identity === pair.identity &&
          matching[0].campaign === campaign && matching[0].caseId === index + 1 && matching[0].day === pair.day);
      }
      measuredTokens(related.find((e) => e.kind === "count-result")!.count);
      if (!transient.length) promptUsage(related.find((e) => e.kind === "generation-result")!.actual);
      countCalls++; generationCalls++;
    }
    return { case: index + 1, countCalls, generationCalls, httpReserved: pairs.length * 2 };
  });
  h2Assert(own.every((e) => Number.isInteger(e.caseId) && (e.caseId as number) >= 1 && (e.caseId as number) <= 12));
  return { project, campaign, cases, httpReserved: own.length * 2,
    countCalls: cases.reduce((total, c) => total + c.countCalls, 0),
    generationCalls: cases.reduce((total, c) => total + c.generationCalls, 0),
    journalHead: entries.at(-1)!.hash };
}
