import { sameModel, type ModelRef } from "./spending.ts";

/*
 * Task triage (D40): before the Coder starts, a fast "System 1" scorer (TypeSafe AI's Jev) rates how hard the task is,
 * from 0 (trivial) to 1 (hard). A hard task starts straight on the stronger model instead of burning cheap rounds that
 * fail and escalate anyway; an easy or medium task keeps the cheap default, so the common case stays cheap.
 *
 * It is advisory and fail-safe. No scorer wired, no key, a timeout or a malformed answer all mean "use the default" —
 * never a failed task, and never a decision the deterministic pipeline cannot make on its own. The scorer only ever
 * sees the task prompt and the plan summary; never a secret, key, the VPS address or client data (CONVENTIONS).
 */

/** What the scorer is told about the task — non-sensitive, task-level text only. */
export interface TriageInput {
  prompt: string;
  planSummary: string;
}

/** `complexity` is clamped to [0,1] by the caller of `chooseCoderModel`; `intent` is a free-text label for the run log. */
export interface TriageResult {
  complexity: number;
  intent?: string;
}

/** What the security scorer sees: the changed files and the diff — the same material a critic model already gets. */
export interface SecurityInput {
  files: string[];
  diff: string;
}

export interface TriageScorer {
  /**
   * Rejects on abort (the outer task was cancelled) or on any transport/parse error. The pipeline treats a non-abort
   * rejection as "no signal" and keeps the default model, so an implementation may throw freely.
   */
  score(input: TriageInput, signal?: AbortSignal): Promise<TriageResult>;
  /**
   * Optional: how security-sensitive a diff is, in [0,1]. Used only to ADD the security critic when the deterministic
   * file/keyword router missed it — never to remove it. Same rejection contract as `score`.
   */
  securityScore?(input: SecurityInput, signal?: AbortSignal): Promise<number>;
}

/** A task at or above this complexity starts on the stronger model; below it keeps the cheap default. */
export const HIGH_COMPLEXITY = 0.66;

/** A change at or above this security score gets the security critic even when the file/keyword router did not ask for it. */
export const SECURITY_ROUTING_THRESHOLD = 0.6;

export interface ModelChoice {
  model: ModelRef;
  reason: string;
}

/**
 * The routing decision, kept pure so it is tested without a network. `cheap` is the Coder's normal model and `strong`
 * the escalation model. A high score picks `strong`; anything else (or `cheap === strong`) keeps `cheap`.
 */
export function chooseCoderModel(result: TriageResult, cheap: ModelRef, strong: ModelRef, threshold = HIGH_COMPLEXITY): ModelChoice {
  const complexity = clamp01(result.complexity);
  if (complexity >= threshold && !sameModel(cheap, strong)) {
    return { model: strong, reason: `complexity ${complexity.toFixed(2)} ≥ ${threshold} → stronger model` };
  }
  return { model: cheap, reason: `complexity ${complexity.toFixed(2)} < ${threshold} → default model` };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export interface JevScorerOptions {
  apiKey: string;
  /** Jev API base, e.g. https://api.typesafe.ai. */
  baseUrl?: string;
  /** POST path for a System One call, relative to `baseUrl`. */
  path?: string;
  /** Jev answers in well under a second; a task never waits long for triage. */
  timeoutMs?: number;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_PATH = "/v1/system-one";
const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * Talks to TypeSafe AI's Jev over HTTP. The request/response wire format is confined to `buildBody` and
 * `parseResult` and read defensively, because it is verified against TypeSafe's own API only where the network reaches
 * it (the VPS) — not in the build environment. Until it is confirmed there, keep triage off (no `AI_EMPLOYEE_JEV_API_KEY`);
 * once on, any format mismatch surfaces as a caught error and the pipeline simply keeps the default model.
 */
export class JevScorer implements TriageScorer {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  constructor(options: JevScorerOptions) {
    this.apiKey = options.apiKey;
    const base = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const path = options.path || DEFAULT_PATH;
    this.url = `${base}${path.startsWith("/") ? "" : "/"}${path}`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => {});
  }

  async score(input: TriageInput, signal?: AbortSignal): Promise<TriageResult> {
    return parseResult(await this.post(buildBody(input), signal));
  }

  async securityScore(input: SecurityInput, signal?: AbortSignal): Promise<number> {
    return scoreFrom(await this.post(buildSecurityBody(input), signal), "security");
  }

  /** One System One call, bounded by a timeout and cancellable by the caller's signal. Throws on a non-2xx response. */
  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Jev returned ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** The bounded, non-sensitive state and the two typed questions we ask Jev. */
export function buildBody(input: TriageInput): Record<string, unknown> {
  return {
    state: {
      task: input.prompt.slice(0, 4_000),
      plan: input.planSummary.slice(0, 4_000),
    },
    questions: {
      complexity: {
        type: "score",
        description: "How hard is this software task, from 0 (trivial one-line change) to 1 (large, risky or cross-cutting change)?",
      },
      intent: {
        type: "choice",
        options: ["coding", "debugging", "refactor", "research", "security", "deployment", "docs", "other"],
        description: "The main kind of work this task is.",
      },
    },
  };
}

/** The bounded, non-sensitive state and the one security-sensitivity question. The diff is what a critic model already sees. */
export function buildSecurityBody(input: SecurityInput): Record<string, unknown> {
  return {
    state: {
      files: input.files.slice(0, 200).join("\n"),
      diff: input.diff.slice(0, 40_000),
    },
    questions: {
      security: {
        type: "score",
        description:
          "How security-sensitive is this code change, from 0 (no security impact) to 1 (touches authentication, authorization, secrets, user input handling, SQL, shell, file paths, crypto, cookies/CORS/CSRF or similar)?",
      },
    },
  };
}

/**
 * Reads a complexity in [0,1] and an optional intent label out of Jev's answer, tolerating the shapes a score/choice
 * response is likely to take. Throws when no usable number is present, which the caller treats as "no signal".
 */
export function parseResult(data: unknown): TriageResult {
  const complexity = scoreFrom(data, "complexity");
  const intent = readString(asRecord(asRecord(data)?.answers)?.intent ?? asRecord(asRecord(data)?.data)?.intent ?? asRecord(data)?.intent);
  return intent ? { complexity, intent } : { complexity };
}

/**
 * Pulls a named score in [0,1] out of Jev's answer, tolerating the shapes a score response is likely to take (a bare
 * number, `{value}`, `{score}`, `{probability}`, or an `answers`/`data` wrapper). Throws when none is present.
 */
export function scoreFrom(data: unknown, key: string): number {
  const root = asRecord(data);
  const answers = asRecord(root?.answers) ?? asRecord(root?.data) ?? root;
  const n = readNumber(answers?.[key]) ?? (typeof root?.[key] === "number" ? root[key] : undefined) ?? readNumber(answers?.score);
  if (n === undefined) throw new Error(`Jev answer had no ${key} score`);
  return n;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A number directly, or the first plausible numeric field of an answer object. */
function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["value", "score", "probability", "confidence"]) {
    const n = record[key];
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return undefined;
}

/** A string directly, or the chosen label of a choice answer. */
function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  for (const key of ["value", "choice", "label"]) {
    const s = record?.[key];
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return undefined;
}
