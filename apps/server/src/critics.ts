import type { CriticKind } from "@ai-employee/brain";

/*
 * Specialist critics judge the finished change right before the commit. Which critics run is decided here by a
 * plain script over the changed files, never by a model, so a docs-only change costs nothing. Logic and backend
 * problems are the Reviewer's job.
 */

export interface CriticInfo {
  name: string;
  /** Short and specific: long checklists dilute the rules that matter. */
  checklist: string[];
}

export const CRITIC_INFO: Record<CriticKind, CriticInfo> = {
  ui: {
    name: "UI critic",
    checklist: [
      "Data the UI loads or submits has loading, empty and error states.",
      "The layout works on a narrow phone screen: no fixed widths that overflow, text wraps, tap targets are not tiny.",
      "Form controls have labels, images have alt text, clickable things are buttons or links, keyboard focus is visible, and color is not the only signal.",
      "It reuses the project's existing components, styles and design tokens instead of a one-off look.",
      "User-facing text is clear, and error messages say what happened and how to fix it.",
    ],
  },
  security: {
    name: "Security critic",
    checklist: [
      "Every new or changed endpoint, route or action checks who is logged in and whether they may do it.",
      "No secrets, keys or tokens in code, config, logs or client bundles.",
      "User input never reaches SQL, shell commands, file paths, HTML (XSS) or redirects without parameters, validation or escaping.",
      "Responses, errors and logs do not expose passwords, tokens or other users' data.",
      "New dependencies are well-known packages; nothing is downloaded and executed at runtime.",
    ],
  },
};

export const CRITIC_KINDS = Object.keys(CRITIC_INFO) as CriticKind[];

/** Changes no critic needs to see: the team's notes, docs, lockfiles, build output and binary assets. */
const IGNORED =
  /(^|\/)(\.ai|node_modules|dist|build|vendor|coverage)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.(md|mdx|txt|rst|png|jpe?g|gif|webp|ico|svg|pdf|woff2?|ttf|lock|map)$/i;

const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|styl)$/i;

/** Words that name security-relevant code wherever they appear in a path, e.g. `src/authMiddleware.ts` or `login/`. */
const SECURITY_WORD =
  /(^|[/._-])(auth|login|logout|signup|signin|register|session|token|jwt|oauth|password|crypto|secret|permission|acl|rbac|admin|upload|middleware|policy|policies)s?([/._-]|$)/i;

/**
 * Generic words only count as whole folders (`src/api/orders.ts`, not `src/api.ts` or `apps/server/`), otherwise
 * nearly every backend file would call the security critic.
 */
const SECURITY_DIR = /(^|\/)(api|routes?|controllers?|handlers?|endpoints?|db|database|migrations?)\//i;

const SECURITY_FILE =
  /(^|\/)(\.env[^/]*|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|composer\.json|Gemfile|[^/]*nginx[^/]*\.conf|[^/]*\.sql|schema\.prisma|\.gitlab-ci\.ya?ml)$|(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;

/** Added code that touches something a security reviewer should see, even in a harmless-looking path. */
const SECURITY_CODE =
  /\b(exec|execSync|execFile|spawn|child_process|eval|new Function|innerHTML|dangerouslySetInnerHTML|v-html|createHash|bcrypt|jsonwebtoken|jwt|password|passwd|secret|api[_-]?key|access[_-]?token|cookie|cors|csrf|sql|query\(|raw\()\b/i;

/** Added lines (without the leading "+") per file of a unified diff. */
export function addedLinesByFile(diff: string): Map<string, string> {
  const added = new Map<string, string>();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1]!;
      continue;
    }
    if (file && line.startsWith("+") && !line.startsWith("+++")) added.set(file, `${added.get(file) ?? ""}${line.slice(1)}\n`);
  }
  return added;
}

export interface CriticPlan {
  kind: CriticKind;
  files: string[];
  reason: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Which critics this change needs, and the files each one should look at. */
export function planCritics(files: string[], diff: string, disabled: readonly CriticKind[] = []): CriticPlan[] {
  const relevant = files.filter((file) => !IGNORED.test(file));
  const added = addedLinesByFile(diff);
  const plans: CriticPlan[] = [];

  const ui = relevant.filter((file) => UI_FILE.test(file));
  if (ui.length && !disabled.includes("ui")) plans.push({ kind: "ui", files: ui, reason: `${plural(ui.length, "UI file")} changed` });

  // Split camelCase names first, so authMiddleware.ts reads as auth-Middleware.ts.
  const words = (file: string) => file.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  const byPath = relevant.filter((file) => SECURITY_WORD.test(words(file)) || SECURITY_DIR.test(file) || SECURITY_FILE.test(file));
  const byCode = relevant.filter((file) => !byPath.includes(file) && SECURITY_CODE.test(added.get(file) ?? ""));
  const security = [...byPath, ...byCode];
  if (security.length && !disabled.includes("security")) {
    const reasons = [byPath.length ? `${plural(byPath.length, "file")} in sensitive places` : "", byCode.length ? `sensitive code in ${plural(byCode.length, "file")}` : ""];
    plans.push({ kind: "security", files: security, reason: reasons.filter(Boolean).join(" and ") });
  }
  return plans;
}

export interface CriticFinding {
  file?: string;
  line?: number | string;
  problem?: string;
  scenario?: string;
  confidence?: number;
}

export interface CriticVerdict {
  summary?: string;
  findings?: CriticFinding[];
}

/** Keeps only findings that meet the bar: a concrete problem, confidence of at least 80, at most five. */
export function blockingFindings(verdict: CriticVerdict): CriticFinding[] {
  return (verdict.findings ?? [])
    .filter((f) => f.problem?.trim() && (f.confidence === undefined || Number(f.confidence) >= 80))
    .slice(0, 5);
}
