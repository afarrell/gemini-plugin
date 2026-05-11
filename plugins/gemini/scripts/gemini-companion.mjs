#!/usr/bin/env node
/**
 * gemini-companion.mjs — Companion script for Gemini CLI integration with Claude Code.
 *
 * Subcommands:
 *   setup               Check Gemini binary, auth, and readiness
 *   review              Run a code review against local git state
 *   adversarial-review  Run a challenge-focused code review
 *   task                Delegate arbitrary work to Gemini
 *   estimate            Estimate context size and recommend model/scope
 *
 * Auth: Uses oauth-personal (Google subscription), not API key billing.
 * All invocations go through Gemini's headless mode (positional prompt arg).
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || process.env.USERPROFILE;

// Positioning: the gemini plugin is a COMPLEMENTARY PEER on Google AI Pro.
// Pro headline is 1,500 daily requests pooled across the Gemini CLI / Code
// Assist surface, but empirically Google enforces undocumented per-model
// sub-pools — community reports (gemini-cli #21395, #12859) converge on
// ~100/day for pro models and ~1,000/day for flash, with lite roughly
// matching flash. Sub-quota numbers below reflect those empirics, not
// Google's marketing. Update if Google publishes real numbers, or if we
// observe new behavior (404/429 patterns shift after the 2026-03-25
// abuse-detection rollout, see discussion #22970).
//
// Defaults are tuned per subcommand:
//   - task (rescue, agentic — 1 prompt → many tool calls): flash-lite
//   - review (read-only diff review): flash
//   - adversarial-review (deep design challenge): pro
//
// Reach for /gemma:rescue (local, free) for trivial consultation, /codex:rescue
// (separate subscription) for agentic coding sessions, or Claude itself when
// the main thread already has the context. Gemini's specific advantages —
// 1M-token window, orthogonal model family, Gemini 3.1 Pro reasoning — are
// what justify burning quota here.
//
// Google renames/deprecates model IDs frequently. The fallback cascade
// catches "model not found" errors and 429s, not just quota exhaustion,
// so a newly-deprecated primary still degrades cleanly.
const DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";

// FAST_MODEL is what cmdEstimate recommends when a pro-tier call on large
// context would burn meaningful sub-pool budget. Lite is the safe scope-down
// recommendation since its sub-pool absorbs heavy use best.
const FAST_MODEL = "gemini-3.1-flash-lite-preview";

// Empirical per-model daily sub-pool limits (NOT published by Google — these
// are the community-observed LOWER BOUND of the reported range, not "the"
// number). Issue #21395 reported 246 pro requests before exhaustion; #12859
// reported ~100. We pick the conservative end so the cascade pre-flight
// downgrade triggers before hitting the wall on a worst-case account, not
// the typical-case account. If you raise these numbers, do it because you've
// observed your account consistently exceeding them — not because Google's
// docs say 1,500 (they're describing the aggregate pool, not per-model).
const SUB_POOL_LIMITS = {
  "gemini-3.1-pro-preview": 100,
  "gemini-2.5-pro": 100,
  "gemini-3-flash-preview": 1000,
  "gemini-2.5-flash": 1000,
  "gemini-3.1-flash-lite-preview": 1000,
  "gemini-2.5-flash-lite": 1000,
};

// Threshold for soft-warning the user (one-line stderr note that a sub-pool
// is approaching its empirical ceiling). Below this is silent.
const USAGE_WARN_THRESHOLD = 0.7;

// Threshold for refusing to auto-pick a model (force fallback to the next
// tier in the cascade). Explicit -m bypasses this — explicit choice always
// wins, but a loud warning is emitted. The headroom under 1.0 is mostly to
// avoid surprise 429s from per-minute throttling near the daily ceiling, and
// to leave a buffer for SUB_POOL_LIMITS being a lower bound (real ceilings
// may be higher). Discussion #22970's abuse-detection enforcement targets
// third-party reuse of the OAuth token, not legitimate first-party CLI
// usage — that's a different threat model than the headroom this constant
// provides. If shipping the plugin to others changes that calculus, revisit.
const USAGE_HARD_STOP_THRESHOLD = 0.9;

const MODELS = {
  "gemini-2.5-flash": { contextWindow: 1_048_576, quotaCost: "low", tier: "flash" },
  "gemini-2.5-flash-lite": { contextWindow: 1_048_576, quotaCost: "minimal", tier: "flash-lite" },
  "gemini-2.5-pro": { contextWindow: 1_048_576, quotaCost: "high", tier: "pro" },
  "gemini-3-flash-preview": { contextWindow: 1_048_576, quotaCost: "low", tier: "flash" },
  "gemini-3.1-flash-lite-preview": { contextWindow: 1_048_576, quotaCost: "minimal", tier: "flash-lite" },
  "gemini-3.1-pro-preview": { contextWindow: 1_048_576, quotaCost: "high", tier: "pro" },
};

// Fallback cascade per subcommand. First entry is the primary; subsequent
// entries are auto-tried on quota exhaustion, 429, or model-not-found.
// Explicit `-m` never auto-falls-back — if the user named a specific model,
// respect their choice and let errors surface cleanly.
//
// Cascades step DOWN in tier so a depleted pro adversarial degrades to flash,
// not back to lite (which would silently drop quality). Lite at the bottom
// is the safety net — its sub-pool is the largest empirically and also the
// fallback target for Google's own model deprecations.
const MODEL_PREFERENCES = {
  task: ["gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite"],
  review: ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-3.1-flash-lite-preview"],
  "adversarial-review": ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"],
};

// Returns the ordered list of models to try for a subcommand. When the caller
// passed -m explicitly, the list is a single-element array (no auto-fallback —
// if the user named a model, we respect that choice). Otherwise, returns the
// subcommand's cascade from MODEL_PREFERENCES.
function selectModels(subcommand, explicit) {
  if (explicit) return [explicit];
  return MODEL_PREFERENCES[subcommand] || [DEFAULT_MODEL];
}

// Patterns that indicate a call failed in a way that a fallback model might
// succeed on: quota exhaustion, rate limits (per-minute throttle or daily
// 429s — see gemini-cli #24937 umbrella), and model-not-found (Google
// renames/deprecates model IDs frequently, so the primary may vanish between
// plugin releases).
//
// Empirically-observed error surface from the Gemini CLI:
//   Quota: "You have exhausted your capacity on this model", "quota exceeded"
//   Throttle: HTTP 429, "rate limit", "too many requests"
//   Model gone: "ModelNotFoundError: Requested entity was not found",
//              "model ... is not supported", "invalid model"
// If Google changes these strings, add the new variant here.
const FALLBACK_TRIGGER_PATTERNS = [
  /exhausted your capacity/i,
  /quota exceeded/i,
  /rate limit/i,
  /resource[_ ]exhausted/i,
  /\b429\b/,
  /too many requests/i,
  /ModelNotFoundError/,
  /requested entity was not found/i,
  /model .* not found/i,
  /model .* (is )?deprecated/i,
  /invalid model/i,
  /is not supported/i,
  /unknown model/i,
];

function looksLikeFallbackTrigger(stderr) {
  if (!stderr) return false;
  return FALLBACK_TRIGGER_PATTERNS.some((re) => re.test(stderr));
}

// ── Usage tracker ──
//
// Google publishes daily totals (1,500/day on AI Pro) but enforces
// undocumented per-model sub-pools. We mirror the count locally so we can
// (a) warn the user before they hit the wall, (b) downgrade to a cheaper
// tier in the cascade rather than spamming a saturated pool, and (c) stay
// under 90% of the empirical ceiling to avoid the account-level abuse
// detection that rolled out 2026-03-25 (gemini-cli discussion #22970).
//
// State file is a per-day map: { "YYYY-MM-DD": { modelId: count, ... }, ... }.
// We keep the last 7 days so the file doesn't grow unbounded; older days
// are pruned on every load.

const USAGE_FILE = HOME ? join(HOME, ".gemini", "claude-plugin-usage.json") : null;
const USAGE_HISTORY_DAYS = 7;

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadUsage() {
  if (!USAGE_FILE || !existsSync(USAGE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(USAGE_FILE, "utf-8")) || {};
  } catch {
    return {};
  }
}

function saveUsage(state) {
  if (!USAGE_FILE) return;
  // Prune old days so the file stays small.
  const keys = Object.keys(state).sort();
  if (keys.length > USAGE_HISTORY_DAYS) {
    for (const k of keys.slice(0, keys.length - USAGE_HISTORY_DAYS)) delete state[k];
  }
  try {
    const dir = USAGE_FILE.substring(0, USAGE_FILE.lastIndexOf("/"));
    if (!existsSync(dir)) {
      // Don't auto-create ~/.gemini — if it doesn't exist, gemini CLI isn't
      // configured and tracking is moot.
      return;
    }
    // Atomic write: tmp file + rename.
    const tmp = `${USAGE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    spawnSync("mv", [tmp, USAGE_FILE]);
  } catch {
    // Tracking is best-effort; never block the actual call on it.
  }
}

function getUsageCount(model) {
  const state = loadUsage();
  return state[todayKey()]?.[model] || 0;
}

function incrementUsageCount(model) {
  const state = loadUsage();
  const today = todayKey();
  state[today] = state[today] || {};
  state[today][model] = (state[today][model] || 0) + 1;
  saveUsage(state);
}

// Returns the threshold band the model is in for today's usage:
//   "ok" (< 70%), "warn" (70–90%), "stop" (>= 90%).
// Models without a published sub-pool limit are always "ok".
function usageBand(model) {
  const limit = SUB_POOL_LIMITS[model];
  if (!limit) return "ok";
  const used = getUsageCount(model);
  const ratio = used / limit;
  if (ratio >= USAGE_HARD_STOP_THRESHOLD) return "stop";
  if (ratio >= USAGE_WARN_THRESHOLD) return "warn";
  return "ok";
}

// Emit a stderr note showing which model ran and where today's usage stands
// against the empirical sub-pool limit. Default is terse (one line) since
// gemini calls may be frequent. `--verbose` expands to a multi-line message
// with the full quota context; `--quiet` suppresses the announcement entirely.
// Callers who want the plugin's full logic without making an API call can run
// the `explain` subcommand.
function announceModel(subcommand, resolved, explicit, { verbose = false, quiet = false } = {}) {
  if (quiet) return;

  const info = MODELS[resolved];
  const used = getUsageCount(resolved);
  const limit = SUB_POOL_LIMITS[resolved];
  const usageStr = limit ? `${used}/${limit}` : `${used}/?`;

  if (!info) {
    if (verbose) {
      process.stderr.write(
        `gemini: using ${resolved} for \`${subcommand}\` — model not in catalog; sub-pool unknown (today's count: ${used}). Run 'gemini-companion explain' for the plugin's full model policy.\n`,
      );
    } else {
      process.stderr.write(
        `gemini: ${resolved} (uncataloged, ${used}/? today). --verbose for detail.\n`,
      );
    }
    return;
  }

  const band = usageBand(resolved);
  const bandHint = band === "stop"
    ? ` ⚠ near sub-pool ceiling`
    : band === "warn"
      ? ` ⚠ ${Math.round((used / limit) * 100)}% of sub-pool used today`
      : "";

  if (!verbose) {
    // Terse one-liner: model + usage + (warn if approaching ceiling).
    process.stderr.write(
      `gemini: ${shortModel(resolved)} (${info.tier}, ${usageStr} today)${bandHint}. --verbose for detail, 'explain' for policy.\n`,
    );
    return;
  }

  // Verbose path — full context.
  const tierLine = info.quotaCost === "high"
    ? "PRO tier — empirical sub-pool ~100/day on Google AI Pro. Best used for deep reasoning on bounded input (adversarial review, design challenge, 1M-context whole-codebase analysis)."
    : info.quotaCost === "low"
      ? "FLASH tier — empirical sub-pool ~1,000/day on Google AI Pro. Good for code review, summarization, mid-depth reasoning."
      : "FLASH-LITE tier — empirical sub-pool ~1,000/day. Cheap; ideal for agentic rescue runs that fan out into many tool calls.";
  process.stderr.write(
    `gemini: using ${resolved} (${info.tier}) for \`${subcommand}\` — ${usageStr} requests today.\n  ${tierLine}\n`,
  );
  if (band === "warn") {
    process.stderr.write(
      `  ⚠ Sub-pool is ${Math.round((used / limit) * 100)}% used. Cascade will downgrade if it hits ${Math.round(USAGE_HARD_STOP_THRESHOLD * 100)}%.\n`,
    );
  } else if (band === "stop") {
    process.stderr.write(
      `  ⚠ Sub-pool ≥${Math.round(USAGE_HARD_STOP_THRESHOLD * 100)}%. Auto-downgrade engaged (or explicit -m override in effect).\n`,
    );
  }
}

// Short display name for the terse announcement. Strips the `gemini-` prefix
// and the `-preview` suffix so the line stays readable.
function shortModel(id) {
  return id.replace(/^gemini-/, "").replace(/-preview$/, "");
}

// ── Helpers ──

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: opts.timeout || 30_000,
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch {
    return opts.fallback ?? null;
  }
}

// Argv-form sibling of run() that DOES NOT spawn a shell. Use this for any
// invocation where one of the argv tokens is derived from user input (--base,
// --dirs, --files). The shell-form run() above is left in place for fully
// hardcoded commands like `git status` where there is nothing to interpolate.
function runArgv(cmd, argv, opts = {}) {
  try {
    const r = spawnSync(cmd, argv, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: opts.timeout || 30_000,
      stdio: ["pipe", "pipe", "pipe"],
      input: opts.input,
    });
    if (r.status === 0) return (r.stdout || "").trim();
    return opts.fallback ?? null;
  } catch {
    return opts.fallback ?? null;
  }
}

// Validate a git ref by asking git itself. We deliberately do NOT use a
// homemade `^[A-Za-z0-9._/-]+$` regex — git accepts perfectly legitimate
// refs like `feature/foo@bar`, `feature/foo+bar`, and `HEAD~1` that such a
// regex would reject (Codex caught this in the adversarial pass). Letting
// git decide is the only way to be both correct and safe.
//
// Returns true if the ref resolves to a commit, false otherwise. Callers
// should treat false as a hard error and refuse to proceed — passing an
// unresolved ref into the diff path is exactly the injection vector this
// function exists to close.
function isValidGitRef(ref) {
  if (typeof ref !== "string" || ref.length === 0) return false;
  const r = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
  });
  return r.status === 0;
}

// Directory names whose contents are excluded from the byte/count estimate
// regardless of how deep they sit in the tree. The original implementation
// only subtracted these at the repo root via `du -sk`, but a `node_modules`
// nested inside a workspace package still skews the estimate badly. Always-
// skip is closer to what users mean when they ask "how big is the review".
const ESTIMATE_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "vendor",
  ".venv",
  "__pycache__",
]);

// Pure-Node replacement for the `du -sk` / `find ... | wc -l` pair. Walks the
// tree synchronously, summing file sizes and counting files. Skips symlinks
// (so we never follow into a loop) and any directory whose name is in
// ESTIMATE_SKIP_DIRS at any depth. Errors on individual entries are silently
// skipped — the estimate is approximate by design.
function walkTree(root) {
  let totalBytes = 0;
  let fileCount = 0;

  function visit(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (ESTIMATE_SKIP_DIRS.has(e.name)) continue;
        visit(full);
      } else if (e.isFile()) {
        try {
          totalBytes += statSync(full).size;
          fileCount++;
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }

  // Allow root itself to be a single file rather than a directory.
  try {
    const s = statSync(root);
    if (s.isFile()) return { totalBytes: s.size, fileCount: 1 };
  } catch {
    return { totalBytes: 0, fileCount: 0 };
  }
  visit(root);
  return { totalBytes, fileCount };
}

// Length cap for `--files` patterns. Bounded input + the manual matcher below
// guarantees worst-case O(pattern * path) matching with no backtracking
// explosion — no `new RegExp` is involved at any point.
const FILES_PATTERN_MAX_LEN = 256;
const FILES_PATTERN_CHARSET = /^[A-Za-z0-9_./*?,\- ]+$/;

// Match a single path segment (no `/`) against a glob pattern segment that
// may contain `*` (any chars in this segment) and `?` (single char). Two-
// pointer + last-star backtrack — linear after collapsing a star run, so
// O(pattern * segment) worst case. No regex, no backtracking explosion.
function globMatchSegment(pattern, str) {
  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = -1;
  while (si < str.length) {
    if (pi < pattern.length && (pattern[pi] === str[si] || pattern[pi] === "?")) {
      pi++;
      si++;
    } else if (pi < pattern.length && pattern[pi] === "*") {
      starPi = pi++;
      starSi = si;
    } else if (starPi !== -1) {
      pi = starPi + 1;
      si = ++starSi;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi === pattern.length;
}

// Match a full path against a glob pattern. `**` (as a whole segment) matches
// zero or more path segments; otherwise segments match one-to-one via
// globMatchSegment. Consecutive `**` segments are collapsed in the caller so
// `**/**/**` doesn't trigger combinatorial branching.
function globMatch(pattern, path) {
  const pSegs = [];
  for (const seg of pattern.split("/")) {
    if (seg === "**" && pSegs[pSegs.length - 1] === "**") continue;
    pSegs.push(seg);
  }
  const sSegs = path.split("/");
  return matchSegments(pSegs, 0, sSegs, 0);
}

function matchSegments(pSegs, pi, sSegs, si) {
  while (pi < pSegs.length) {
    if (pSegs[pi] === "**") {
      // Last `**` matches everything remaining.
      if (pi === pSegs.length - 1) return true;
      for (let skip = 0; si + skip <= sSegs.length; skip++) {
        if (matchSegments(pSegs, pi + 1, sSegs, si + skip)) return true;
      }
      return false;
    }
    if (si >= sSegs.length) return false;
    if (!globMatchSegment(pSegs[pi], sSegs[si])) return false;
    pi++;
    si++;
  }
  return si === sSegs.length;
}

// Resolve a `--files` value (comma-separated literal paths or globs, e.g.
// "src/foo.ts" or "src/**/*.ts") to a deduplicated list of file paths. We
// implement this in-process rather than calling out to the shell so that no
// part of the user-supplied pattern reaches a shell interpreter — that's the
// whole point of the B1 fix. Patterns are validated against a tight charset
// and a length cap, then matched via the regex-free globMatch above; brace
// expansion and negation are intentionally not implemented.
function expandFilesPattern(pattern, cwd = process.cwd()) {
  if (typeof pattern !== "string" || pattern.length === 0) return [];
  if (pattern.length > FILES_PATTERN_MAX_LEN) {
    throw new Error(
      `gemini-companion: --files pattern too long (max ${FILES_PATTERN_MAX_LEN} chars)`,
    );
  }
  if (!FILES_PATTERN_CHARSET.test(pattern)) {
    throw new Error(
      "gemini-companion: --files contains unsupported characters (allowed: letters, digits, /, ., _, -, *, ?, comma, space)",
    );
  }

  const parts = pattern
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();

  for (const p of parts) {
    if (/[*?]/.test(p)) {
      const stack = [{ dir: cwd, rel: "" }];
      while (stack.length) {
        const { dir, rel } = stack.pop();
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.isSymbolicLink()) continue;
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          const childFull = join(dir, e.name);
          if (e.isDirectory()) {
            if (ESTIMATE_SKIP_DIRS.has(e.name)) continue;
            stack.push({ dir: childFull, rel: childRel });
          } else if (e.isFile() && globMatch(p, childRel) && !seen.has(childRel)) {
            seen.add(childRel);
            out.push(childRel);
          }
        }
      }
    } else {
      try {
        if (statSync(p).isFile() && !seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      } catch {
        /* nonexistent literal — skip */
      }
    }
  }
  return out;
}

function isGitRepo() {
  return run("git rev-parse --is-inside-work-tree") === "true";
}

function geminiPath() {
  return run("which gemini") || run("command -v gemini");
}

function geminiVersion() {
  return run("gemini --version");
}

function geminiAuth() {
  const settingsPath = join(HOME, ".gemini", "settings.json");
  if (!existsSync(settingsPath))
    return { type: "none", authenticated: false };
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const authType = settings?.security?.auth?.selectedType || "none";
    const oauthCreds = join(HOME, ".gemini", "oauth_creds.json");
    const hasOAuth = existsSync(oauthCreds);
    return {
      type: authType,
      authenticated: authType === "oauth-personal" && hasOAuth,
    };
  } catch {
    return { type: "unknown", authenticated: false };
  }
}

// ── Git context ──

function gitDiffForReview(args) {
  const base = args.base;
  const scope = args.scope || "auto";

  if (base) {
    if (!isValidGitRef(base)) {
      console.error(`Error: --base "${base}" is not a valid git ref.`);
      process.exit(2);
    }
    return runArgv("git", ["diff", `${base}...HEAD`], { fallback: "" });
  }

  if (scope === "branch") {
    const mainBranch =
      (runArgv("git", ["rev-parse", "--verify", "main"]) && "main") ||
      (runArgv("git", ["rev-parse", "--verify", "master"]) && "master") ||
      "main";
    return runArgv("git", ["diff", `${mainBranch}...HEAD`], { fallback: "" });
  }

  // working-tree or auto: combined staged + unstaged
  const staged = run("git diff --cached", { fallback: "" });
  const unstaged = run("git diff", { fallback: "" });
  const combined = [staged, unstaged].filter(Boolean).join("\n");

  if (combined) return combined;

  // Check for untracked files
  const untracked = run("git ls-files --others --exclude-standard", {
    fallback: "",
  });
  if (!untracked) return "";

  const files = untracked.split("\n").filter(Boolean);
  return files
    .map((f) => {
      try {
        const content = readFileSync(f, "utf-8");
        const lines = content.split("\n");
        return `--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

function gitShortstat(args) {
  const base = args.base;
  if (base) {
    if (!isValidGitRef(base)) {
      console.error(`Error: --base "${base}" is not a valid git ref.`);
      process.exit(2);
    }
    return runArgv("git", ["diff", "--shortstat", `${base}...HEAD`], { fallback: "" });
  }
  const staged = run("git diff --shortstat --cached", { fallback: "" });
  const unstaged = run("git diff --shortstat", { fallback: "" });
  return [staged, unstaged].filter(Boolean).join("; ");
}

// ── Gemini invocation ──

// Low-level invoker. Returns { stdout, stderr, status } rather than just
// stdout so callers can inspect failure modes and decide whether to fall back.
function invokeGeminiOnce({ prompt, stdin, model, approvalMode, sandbox, dirs }) {
  const args = [prompt, "-o", "text"];
  if (model) args.push("-m", model);
  if (approvalMode) args.push("--approval-mode", approvalMode);
  if (sandbox) args.push("-s");
  if (dirs) args.push("--include-directories", dirs);

  const result = spawnSync("gemini", args, {
    input: stdin || undefined,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 600_000, // 10 min max
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    console.error(`Error invoking Gemini: ${result.error.message}`);
    process.exit(1);
  }

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

// Invoker with auto-fallback across a cascade of models. Used by task,
// review, and adversarial-review when the caller didn't pass -m explicitly.
// If -m was explicit, callers pass a single-element cascade — the function
// still works but won't auto-fallback.
//
// Two reasons to advance to the next cascade entry:
//   1. Pre-flight: the local usage tracker says we're at ≥90% of the model's
//      empirical sub-pool. We skip without spending a request, since hammering
//      a saturated pool risks abuse-detection flagging.
//   2. Post-flight: the call returned nothing AND stderr matches a fallback
//      trigger pattern (quota / 429 / model-not-found).
//
// Explicit -m always tries the named model regardless — the user named it,
// they get to spend the request.
function invokeGeminiWithCascade({ prompt, stdin, cascade, explicit, subcommand, approvalMode, sandbox, dirs, verbose, quiet }) {
  for (let i = 0; i < cascade.length; i++) {
    const model = cascade[i];
    const isFallback = i > 0;
    const skipReason = !explicit && usageBand(model) === "stop"
      ? `local sub-pool tracker shows ≥${Math.round(USAGE_HARD_STOP_THRESHOLD * 100)}% of empirical ${SUB_POOL_LIMITS[model]}/day used`
      : null;

    if (skipReason) {
      if (!quiet && i < cascade.length - 1) {
        process.stderr.write(
          `gemini: skipping ${shortModel(model)} — ${skipReason}. Trying ${shortModel(cascade[i + 1])}.\n`,
        );
      } else if (!quiet) {
        process.stderr.write(
          `gemini: ${shortModel(model)} also at sub-pool ceiling. No more cascade entries.\n`,
        );
      }
      continue;
    }

    if (isFallback) {
      if (!quiet) {
        const prev = cascade[i - 1];
        process.stderr.write(
          `gemini: ${shortModel(prev)} failed — falling back to ${shortModel(model)}.\n`,
        );
      }
    } else {
      announceModel(subcommand, model, explicit, { verbose, quiet });
    }

    const { stdout, stderr, status } = invokeGeminiOnce({
      prompt,
      stdin,
      model,
      approvalMode,
      sandbox,
      dirs,
    });

    // Count the attempt only if the binary actually ran. invokeGeminiOnce
    // exits the process on spawn-time errors (binary missing, etc.), so
    // reaching this line means the request did hit Google's API and counts
    // server-side regardless of whether stdout came back useful.
    incrementUsageCount(model);

    const hasContent = stdout && stdout.trim().length > 0;
    const shouldFallback = !hasContent && looksLikeFallbackTrigger(stderr);

    if (hasContent) {
      // Pass through any stderr the CLI wrote — often info messages, occasionally
      // retry notices that don't warrant failing.
      if (stderr && status !== 0) process.stderr.write(stderr);
      return stdout;
    }

    if (!shouldFallback || i === cascade.length - 1) {
      // Either the error isn't recoverable by a fallback model, or we've run
      // out of cascade entries. Surface stderr and return empty.
      if (stderr) process.stderr.write(stderr);
      if (i === cascade.length - 1 && shouldFallback && cascade.length > 1) {
        process.stderr.write(
          `gemini: exhausted every cascade entry (${cascade.join(", ")}). Try /gemma:rescue or /codex:rescue, or wait for daily quota reset.\n`,
        );
      }
      return stdout;
    }
    // Fall through to next iteration (next model in cascade).
  }
  return "";
}

// Back-compat wrapper used by code paths that don't need cascade behavior
// (e.g. explicit -m calls where caller wants the single-model path). For
// the auto-pick subcommands we use invokeGeminiWithCascade directly.
function invokeGemini(opts) {
  const { stdout, stderr, status } = invokeGeminiOnce(opts);
  if (status !== 0 && stderr) process.stderr.write(stderr);
  return stdout;
}

// ── Subcommands ──

function cmdSetup(args) {
  const path = geminiPath();
  const version = path ? geminiVersion() : null;
  const auth = geminiAuth();

  const result = {
    available: !!path,
    binary: path || null,
    version: version || null,
    auth,
    defaultModel: DEFAULT_MODEL,
    fastModel: FAST_MODEL,
    billing: "google-subscription (oauth-personal)",
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.available) {
    console.log("## Gemini CLI Status: NOT INSTALLED\n");
    console.log("Install with: `bun install -g @google/gemini-cli`");
    console.log("Then authenticate: `gemini` (opens browser for Google OAuth)");
    return;
  }

  console.log("## Gemini CLI Status\n");
  console.log(`- **Binary:** ${result.binary}`);
  console.log(`- **Version:** ${result.version}`);
  console.log(`- **Auth:** ${result.auth.type}`);
  console.log(
    `- **Authenticated:** ${result.auth.authenticated ? "Yes" : "No"}`
  );
  console.log(`- **Billing:** ${result.billing}`);
  console.log(`- **Default model:** ${result.defaultModel}`);
  console.log(`- **Fast model:** ${result.fastModel}`);

  if (!result.auth.authenticated) {
    console.log(
      "\n> **Action required:** Run `gemini` interactively to complete Google OAuth setup."
    );
  }
}

function cmdReview(args) {
  if (!isGitRepo()) {
    console.error("Error: Not in a git repository. Review requires git changes to analyze.");
    process.exit(1);
  }
  const diff = gitDiffForReview(args);
  if (!diff) {
    console.log("Nothing to review — no changes detected in the target scope.");
    const status = run("git status --short --untracked-files=all", {
      fallback: "",
    });
    if (status) console.log(`\nGit status:\n${status}`);
    return;
  }

  const cascade = selectModels("review", args.model);
  const prompt = `You are a senior code reviewer. Review the following git diff thoroughly.

For each finding, report:
- **Severity:** critical / high / medium / low
- **File:** path and line number(s)
- **Issue:** clear description
- **Fix:** concrete suggestion

Categories to check:
1. Bugs and logic errors
2. Security vulnerabilities (injection, auth bypass, data exposure)
3. Performance issues
4. Error handling gaps
5. Code quality and readability

If no issues are found, state that explicitly and note any residual risks.

Structure your output as:
## Summary
[1-2 sentence overview]

## Findings
[Ordered by severity, most critical first]

## Verdict
[PASS / PASS WITH NOTES / NEEDS CHANGES]`;

  const output = invokeGeminiWithCascade({
    prompt,
    stdin: diff,
    cascade,
    explicit: args.model,
    subcommand: "review",
    verbose: args.verbose,
    quiet: args.quiet,
  });
  process.stdout.write(output);
}

function cmdAdversarialReview(args) {
  if (!isGitRepo()) {
    console.error("Error: Not in a git repository. Review requires git changes to analyze.");
    process.exit(1);
  }
  const diff = gitDiffForReview(args);
  if (!diff) {
    console.log(
      "Nothing to review — no changes detected in the target scope."
    );
    return;
  }

  const cascade = selectModels("adversarial-review", args.model);
  const focusText = args.rest.length > 0 ? `\n\nAdditional focus: ${args.rest.join(" ")}` : "";

  const prompt = `You are an adversarial code reviewer. Your job is NOT just to find bugs — it is to challenge the implementation approach, design choices, tradeoffs, and assumptions.

For each concern, report:
- **Category:** design / architecture / assumptions / tradeoffs / correctness / security
- **File:** path and line number(s)
- **Challenge:** what you're questioning and why
- **Risk:** what could go wrong under real-world conditions
- **Alternative:** a different approach worth considering

Questions to drive your review:
1. Is this the right approach, or is there a simpler/more robust alternative?
2. What assumptions does this code make that could break?
3. What happens at 10x scale? Under adversarial input? During partial failures?
4. Are there implicit dependencies or coupling that make this fragile?
5. What would a future maintainer misunderstand?${focusText}

Structure your output as:
## Design Challenges
[Most impactful first]

## Assumption Risks
[Implicit assumptions that could break]

## Verdict
[SOLID / ACCEPTABLE / RECONSIDER]`;

  const output = invokeGeminiWithCascade({
    prompt,
    stdin: diff,
    cascade,
    explicit: args.model,
    subcommand: "adversarial-review",
    verbose: args.verbose,
    quiet: args.quiet,
  });
  process.stdout.write(output);
}

function cmdTask(args) {
  const taskText = args.rest.join(" ");
  if (!taskText) {
    console.error("Error: No task description provided.");
    process.exit(1);
  }

  const cascade = selectModels("task", args.model);
  const write = args.write !== false; // default to write-capable
  const approvalMode = write ? "auto_edit" : "plan";

  // Auto-warn if context is likely expensive. Use the primary model for the
  // warning — fallbacks are also lite so their quota profile is the same.
  warnIfExpensive(cascade[0], args.dirs);

  // Pipe files via stdin if --files specified. We resolve the pattern in
  // process and read each file with fs — no shell expansion of user input.
  let stdin = null;
  if (args.files) {
    let matches;
    try {
      matches = expandFilesPattern(args.files);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(2);
    }
    if (matches.length === 0) {
      console.error(`Warning: --files "${args.files}" matched no files.`);
    } else {
      const chunks = [];
      for (const f of matches) {
        try {
          chunks.push(readFileSync(f, "utf-8"));
        } catch {
          /* unreadable — skip */
        }
      }
      stdin = chunks.join("\n");
    }
  }

  const output = invokeGeminiWithCascade({
    prompt: taskText,
    stdin,
    cascade,
    explicit: args.model,
    subcommand: "task",
    approvalMode,
    sandbox: args.sandbox || false,
    dirs: args.dirs,
    verbose: args.verbose,
    quiet: args.quiet,
  });
  process.stdout.write(output);
}

// ── Arg parsing ──

function parseArgs(argv) {
  const args = {
    json: false,
    base: null,
    scope: "auto",
    model: null,
    write: true,
    sandbox: false,
    dirs: null,
    files: null,
    resume: false,
    fresh: false,
    background: false,
    wait: false,
    verbose: false,
    quiet: false,
    rest: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        args.json = true;
        break;
      case "--base":
        args.base = argv[++i];
        break;
      case "--scope":
        args.scope = argv[++i];
        break;
      case "--model":
      case "-m":
        args.model = argv[++i];
        break;
      case "--write":
        args.write = true;
        break;
      case "--read-only":
        args.write = false;
        break;
      case "--sandbox":
        args.sandbox = true;
        break;
      case "--dirs":
      case "--include-directories":
        args.dirs = argv[++i];
        break;
      case "--files":
        args.files = argv[++i];
        break;
      case "--resume":
        args.resume = true;
        break;
      case "--fresh":
        args.fresh = true;
        break;
      case "--background":
        args.background = true;
        break;
      case "--wait":
        args.wait = true;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
      case "--quiet":
      case "-q":
        args.quiet = true;
        break;
      default:
        args.rest.push(arg);
    }
    i++;
  }

  // Normalize model aliases. Lite aliases collapse to the newest 3.1 lite
  // (plugin default). `2.5-*` aliases keep callers pinned to the stable older
  // generation when needed. Flash and pro aliases now point to the 3.1
  // generation by default — the older 2.5 aliases stay available for pinning.
  if (args.model === "lite" || args.model === "flash-lite") args.model = "gemini-3.1-flash-lite-preview";
  if (args.model === "3.1-lite") args.model = "gemini-3.1-flash-lite-preview";
  if (args.model === "2.5-lite") args.model = "gemini-2.5-flash-lite";
  if (args.model === "flash" || args.model === "3-flash") args.model = "gemini-3-flash-preview";
  if (args.model === "2.5-flash") args.model = "gemini-2.5-flash";
  if (args.model === "pro") args.model = "gemini-3.1-pro-preview";
  if (args.model === "3-pro" || args.model === "3.1-pro") args.model = "gemini-3.1-pro-preview";
  if (args.model === "2.5-pro") args.model = "gemini-2.5-pro";

  return args;
}

// ── Context estimation ──

// Roots to walk for byte estimation. Splits a comma list, trims, drops empty.
function dirsToRoots(dirs) {
  if (!dirs) return ["."];
  return dirs
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function quickEstimateBytes(dirs) {
  let total = 0;
  for (const root of dirsToRoots(dirs)) {
    total += walkTree(root).totalBytes;
  }
  return total;
}

function estimateContext(dirs, files) {
  let totalBytes = 0;
  let fileCount = 0;

  if (files) {
    let matches;
    try {
      matches = expandFilesPattern(files);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(2);
    }
    for (const f of matches) {
      try {
        totalBytes += statSync(f).size;
        fileCount++;
      } catch {
        /* unreadable — skip */
      }
    }
  } else {
    for (const root of dirsToRoots(dirs)) {
      const w = walkTree(root);
      totalBytes += w.totalBytes;
      fileCount += w.fileCount;
    }
  }

  const estimatedTokens = Math.ceil(totalBytes / 4);
  return { totalBytes, fileCount, estimatedTokens };
}

function warnIfExpensive(model, dirs) {
  try {
    const totalBytes = quickEstimateBytes(dirs);
    const estimatedTokens = Math.ceil(totalBytes / 4);
    const modelInfo = MODELS[model] || MODELS[DEFAULT_MODEL];
    const contextUsage = estimatedTokens / modelInfo.contextWindow;

    const subPool = SUB_POOL_LIMITS[model];
    const subPoolNote = subPool ? ` (sub-pool ~${subPool}/day)` : "";

    if (contextUsage > 0.5 && modelInfo.quotaCost === "high") {
      process.stderr.write(
        `\n>> WARNING: ~${(estimatedTokens / 1000).toFixed(0)}K estimated tokens with ${model} (~${Math.round(contextUsage * 100)}% of context window)${subPoolNote}. Large pro requests in agent mode can fan out into many sub-requests — scope with --dirs/--files if possible.\n\n`,
      );
    } else if (contextUsage > 0.5 && modelInfo.quotaCost === "low") {
      process.stderr.write(
        `\n>> NOTE: ~${(estimatedTokens / 1000).toFixed(0)}K tokens with ${model} (~${Math.round(contextUsage * 100)}% of context window)${subPoolNote}. Scope with --dirs/--files for tighter input.\n\n`,
      );
    } else if (contextUsage > 0.8) {
      process.stderr.write(
        `\n>> WARNING: ~${(estimatedTokens / 1000).toFixed(0)}K estimated tokens — ~${Math.round(contextUsage * 100)}% of context window. Risk of truncation. Scope with --dirs or --files.\n\n`,
      );
    }
  } catch {
    // Don't block task execution on estimate failure
  }
}

function cmdEstimate(args) {
  const model = args.model || DEFAULT_MODEL;
  const modelInfo = MODELS[model] || MODELS[DEFAULT_MODEL];
  const { totalBytes, fileCount, estimatedTokens } = estimateContext(args.dirs, args.files);
  const contextUsage = estimatedTokens / modelInfo.contextWindow;

  const subPool = SUB_POOL_LIMITS[model];
  const usedToday = getUsageCount(model);
  const subPoolPercent = subPool ? Math.round((usedToday / subPool) * 100) : null;

  const warnings = [];
  if (contextUsage > 0.8) {
    warnings.push("Context usage >" + Math.round(contextUsage * 100) + "% of " + model + " limit — risk of truncation");
  }
  if (modelInfo.quotaCost === "high" && !args.dirs && !args.files) {
    warnings.push("Using Pro on full repo — pro sub-pool is ~100/day and a 1M-token agent run can fan out fast. Scope with --dirs or --files when feasible.");
  }
  if (subPool && subPoolPercent >= 70) {
    warnings.push(`${model} is at ${subPoolPercent}% of its empirical sub-pool today (${usedToday}/${subPool}). Cascade will downgrade if it reaches ${Math.round(USAGE_HARD_STOP_THRESHOLD * 100)}%.`);
  }

  // When the chosen model is large-context-heavy on a non-trivial scope, the
  // lite tier is usually the right scope-down because its sub-pool absorbs
  // big inputs best. Don't recommend changing model on small inputs — the
  // chosen model is fine.
  const recommendedModel =
    contextUsage > 0.3 && modelInfo.quotaCost !== "minimal" ? FAST_MODEL : model;

  const result = {
    scope: args.dirs || args.files || "entire repo",
    fileCount,
    totalBytes,
    totalMB: +(totalBytes / 1024 / 1024).toFixed(1),
    estimatedTokens,
    estimatedTokensK: +(estimatedTokens / 1000).toFixed(0),
    model,
    modelTier: modelInfo.tier,
    contextWindow: modelInfo.contextWindow,
    contextUsagePercent: Math.round(contextUsage * 100),
    quotaCost: modelInfo.quotaCost,
    subPoolDailyLimit: subPool || null,
    subPoolUsedToday: usedToday,
    subPoolPercentUsed: subPoolPercent,
    recommendedModel,
    warnings,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("## Context Estimate\n");
  console.log(`- **Scope:** ${result.scope}`);
  console.log(`- **Files:** ${result.fileCount.toLocaleString()}`);
  console.log(`- **Size:** ${result.totalMB} MB`);
  console.log(`- **Estimated tokens:** ~${result.estimatedTokensK}K`);
  console.log(`- **Model:** ${result.model} (${result.quotaCost} quota cost)`);
  console.log(`- **Context usage:** ~${result.contextUsagePercent}%`);
  if (result.subPoolDailyLimit) {
    console.log(`- **Sub-pool today:** ${result.subPoolUsedToday}/${result.subPoolDailyLimit} requests (${result.subPoolPercentUsed}%)`);
  }
  if (result.recommendedModel !== result.model) {
    console.log(`- **Recommended model:** ${result.recommendedModel}`);
  }
  if (warnings.length) {
    console.log("\n### Warnings\n");
    for (const w of warnings) console.log(`- ${w}`);
  }
}

// Slash commands invoke the companion as `node ...mjs <sub> "$ARGUMENTS"`.
// Quoted, the entire flag-set arrives as a single argv token and parseArgs
// drops it into args.rest — silently no-opping every documented flag. Detect
// that shape and re-split the token using POSIX-style rules so quoted flags
// survive. We intentionally do NOT evaluate $VAR / $(...) / backticks — the
// parent shell already did that pass; we only split on whitespace and respect
// quote / backslash grouping.
function tokenizeShellLike(str) {
  const tokens = [];
  let current = "";
  let started = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else current += c;
    } else if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === "\\" && i + 1 < str.length && '"\\$`\n'.includes(str[i + 1])) {
        current += str[++i];
      } else current += c;
    } else if (c === "'") {
      inSingle = true;
      started = true;
    } else if (c === '"') {
      inDouble = true;
      started = true;
    } else if (c === "\\" && i + 1 < str.length) {
      current += str[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += c;
      started = true;
    }
  }
  if (inSingle || inDouble) {
    throw new Error("gemini-companion: unmatched quote in arguments");
  }
  if (started) tokens.push(current);
  return tokens;
}

function maybeRetokenize(argv) {
  // Re-split any argv element that looks like a wrapped flag block — i.e.
  // contains whitespace AND starts with `-`. This catches both shapes:
  //   ["--base main -m pro"]               (review.md / adversarial-review.md)
  //   ["--json", "--base main -m pro"]     (setup.md / similar mixed form)
  // Bare prose elements (natural-language tails for task / rescue) are passed
  // through untouched so we don't mangle quoted phrases the user intended.
  const out = [];
  for (const tok of argv) {
    if (typeof tok === "string" && /\s/.test(tok) && tok.trimStart().startsWith("-")) {
      try {
        out.push(...tokenizeShellLike(tok));
        continue;
      } catch (e) {
        console.error(e.message);
      }
    }
    out.push(tok);
  }
  return out;
}

// ── Main ──

const subcommand = process.argv[2];
const args = parseArgs(maybeRetokenize(process.argv.slice(3)));

function cmdExplain() {
  const taskCascade = MODEL_PREFERENCES.task.join(" → ");
  const reviewCascade = MODEL_PREFERENCES.review.join(" → ");
  const advCascade = MODEL_PREFERENCES["adversarial-review"].join(" → ");

  // Snapshot today's usage for each tracked model so users can see how much
  // headroom they actually have left before reading the policy text.
  const usageSnapshot = Object.entries(SUB_POOL_LIMITS)
    .map(([m, limit]) => `  ${m}: ${getUsageCount(m)}/${limit}`)
    .join("\n");

  console.log(`# Gemini Plugin — Model Policy (Google AI Pro)

The gemini plugin is a **complementary peer** in the toolkit:
- **/gemma:rescue** for trivial / free local consultation
- **/codex:rescue** for agentic coding sessions (separate subscription)
- **gemini** when its specific advantages matter: 1M-token context, Gemini
  3.1 Pro reasoning for design challenges (the strongest reasoning model
  in the catalog), or a genuinely orthogonal model family for a second opinion

## Quota model

Google AI Pro publishes a single 1,500/day total across Gemini CLI and Code
Assist. Empirically, this is **enforced as undocumented per-model sub-pools**
(community reports: gemini-cli #21395, #12859):

  gemini-3.1-pro-preview  → ~100/day
  gemini-2.5-pro          → ~100/day
  gemini-3-flash-preview  → ~1,000/day
  gemini-2.5-flash        → ~1,000/day
  flash-lite (both gens)  → ~1,000/day

These numbers are conservative ceilings. Update SUB_POOL_LIMITS in the
companion script if Google publishes real numbers or behavior changes.

## Today's usage

${usageSnapshot}

(Mirrored from this plugin's local tracker at \`~/.gemini/claude-plugin-usage.json\`.
Google's own count may differ slightly — agent mode fans 1 prompt into
multiple sub-requests that all count server-side.)

## Defaults per subcommand

| Subcommand           | Cascade                                                                                            |
|----------------------|----------------------------------------------------------------------------------------------------|
| \`task\` (rescue)      | ${taskCascade}                                                              |
| \`review\`             | ${reviewCascade}              |
| \`adversarial-review\` | ${advCascade}                |

Cascades step DOWN in tier on quota / 429 / model-not-found errors. Pre-flight,
the cascade also skips any model already at ≥${Math.round(USAGE_HARD_STOP_THRESHOLD * 100)}% of its empirical
sub-pool — staying under the line keeps the account out of Google's
abuse-detection auto-flag zone (rolled out 2026-03-25, see discussion #22970).

Explicit \`-m\` always tries the named model — your choice wins, even at 99%.

## Aliases

  lite, flash-lite, 3.1-lite  → gemini-3.1-flash-lite-preview
  2.5-lite                    → gemini-2.5-flash-lite
  flash, 3-flash              → gemini-3-flash-preview
  2.5-flash                   → gemini-2.5-flash
  pro, 3-pro, 3.1-pro         → gemini-3.1-pro-preview
  2.5-pro                     → gemini-2.5-pro

## Stderr announcements

Every call writes a one-line note showing model + today's count vs sub-pool.
- Default: terse one-line form
- \`--verbose\` / \`-v\`: multi-line context with tier guidance
- \`--quiet\` / \`-q\`: suppress entirely

## Fallback triggers

The companion advances to the next cascade entry on these stderr patterns:
  - "exhausted your capacity", "quota exceeded", "resource exhausted"
  - HTTP 429, "rate limit", "too many requests"
  - "ModelNotFoundError", "requested entity was not found",
    "model not found", "deprecated", "invalid model",
    "is not supported", "unknown model"

If every cascade entry fails, stderr says so. Try /gemma:rescue or
/codex:rescue, or wait for daily reset (midnight Pacific per Google docs).

## When to reach for gemini

- 1M-token whole-codebase context (review of large diffs, architecture audit)
- Gemini 3.1 Pro for adversarial review / design challenge (strongest
  reasoning in the catalog; Google references Deep Think mode at pro but
  the public model card doesn't document how to invoke it)
- Orthogonal second opinion (Gemini family is genuinely different from
  Claude and Gemma)
- Agentic file work where flash-lite's reasoning is enough but you want
  Gemini's tool-use rather than Codex

## Model IDs change

Google churns preview model names frequently. If the primary fails with a
"model not found" error, the cascade auto-falls-back — but if the whole
cascade fails, check https://ai.google.dev/gemini-api/docs/models for
current IDs and update MODEL_PREFERENCES in scripts/gemini-companion.mjs.
`);
}

switch (subcommand) {
  case "setup":
    cmdSetup(args);
    break;
  case "review":
    cmdReview(args);
    break;
  case "adversarial-review":
    cmdAdversarialReview(args);
    break;
  case "task":
    cmdTask(args);
    break;
  case "estimate":
    cmdEstimate(args);
    break;
  case "explain":
    cmdExplain();
    break;
  default:
    console.log(`gemini-companion: unknown subcommand "${subcommand}"`);
    console.log("Usage: gemini-companion <setup|review|adversarial-review|task|estimate|explain> [options]");
    process.exit(1);
}
