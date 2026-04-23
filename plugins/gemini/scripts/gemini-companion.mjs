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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || process.env.USERPROFILE;

// Positioning: the gemini plugin is a RELUCTANT FALLBACK. The oauth-personal
// subscription has extremely tight daily limits — pro tiers are ~1-2/month,
// non-lite flash is daily-limited and depletes fast. For routine work, the
// gemma plugin (local, free) or Codex are always better choices. Gemini is
// for special cases: massive context (1M+ tokens), agentic file access with
// deeper reasoning than gemma, or deliberate second-opinion work.
//
// Default across every subcommand: gemini-3.1-flash-lite-preview. Falls
// back to gemini-2.5-flash-lite if the 3.1 lite tier is exhausted. Nothing
// else is auto-picked — flash (non-lite) and pro tiers require explicit -m.
//
// Google renames/deprecates model IDs frequently (see readme note). The
// fallback cascade also catches "model not found" errors, not just quota
// exhaustion, so a newly-deprecated primary still degrades cleanly.
const DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";

// FAST_MODEL is what cmdEstimate recommends when a pro-tier call on large
// context would burn the day's pro allocation. Lite is always the right
// recommendation — no point suggesting flash (which is also quota-limited)
// when lite is what the plugin uses by default.
const FAST_MODEL = "gemini-3.1-flash-lite-preview";

const MODELS = {
  "gemini-2.5-flash": { contextWindow: 1_048_576, quotaCost: "low", tier: "flash" },
  "gemini-2.5-flash-lite": { contextWindow: 1_048_576, quotaCost: "minimal", tier: "flash-lite" },
  "gemini-2.5-pro": { contextWindow: 1_048_576, quotaCost: "high", tier: "pro" },
  "gemini-3-flash-preview": { contextWindow: 1_048_576, quotaCost: "low", tier: "flash" },
  "gemini-3.1-flash-lite-preview": { contextWindow: 1_048_576, quotaCost: "minimal", tier: "flash-lite" },
  "gemini-3.1-pro-preview": { contextWindow: 1_048_576, quotaCost: "high", tier: "pro" },
};

// Fallback cascade per subcommand. First entry is the primary; subsequent
// entries are auto-tried only on quota exhaustion or model-not-found errors.
// Explicit `-m` never auto-falls-back — if the user named a specific model,
// respect their choice and let errors surface cleanly.
const MODEL_PREFERENCES = {
  task: ["gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite"],
  review: ["gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite"],
  "adversarial-review": ["gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite"],
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
// succeed on: quota exhaustion, rate limits, and model-not-found (Google
// renames/deprecates model IDs frequently, so the primary may vanish between
// plugin releases).
//
// Empirically-observed error surface from the Gemini CLI (see scripts README):
//   Quota: "You have exhausted your capacity on this model", "quota exceeded"
//   Model gone: "ModelNotFoundError: Requested entity was not found",
//              "model ... is not supported", "invalid model"
// If Google changes these strings, add the new variant here.
const FALLBACK_TRIGGER_PATTERNS = [
  /exhausted your capacity/i,
  /quota exceeded/i,
  /rate limit/i,
  /resource[_ ]exhausted/i,
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

// Emit a stderr note showing which model ran. Default is terse (one line,
// ~60-80 chars) since gemini calls may be frequent and a long banner becomes
// noise. `--verbose` expands to a multi-line message with the full quota
// context; `--quiet` suppresses the announcement entirely. Callers who want
// the plugin's full logic without making an API call can run the `explain`
// subcommand.
function announceModel(subcommand, resolved, explicit, { verbose = false, quiet = false } = {}) {
  if (quiet) return;

  const info = MODELS[resolved];
  if (!info) {
    if (verbose) {
      process.stderr.write(
        `gemini: using ${resolved} for \`${subcommand}\` — model not in catalog; quota profile unknown. Prefer /gemma:rescue for routine work. Run 'gemini-companion explain' for the plugin's full model policy.\n`,
      );
    } else {
      process.stderr.write(
        `gemini: ${resolved} (uncataloged) — quota unknown. --verbose for detail.\n`,
      );
    }
    return;
  }

  if (!verbose) {
    // Terse one-liner. The quota tier is implicit in the model name for lite
    // callers (most common path), explicit for flash/pro so the caller sees cost.
    const costHint = info.quotaCost === "high"
      ? " (quota-high, ~1-2/month)"
      : info.quotaCost === "low"
        ? " (quota-low, daily-limited)"
        : "";
    const routingHint = info.quotaCost === "minimal"
      ? " — prefer /gemma:rescue when possible"
      : "";
    process.stderr.write(
      `gemini: ${shortModel(resolved)}${costHint}${routingHint}. --verbose for detail, 'explain' for full policy.\n`,
    );
    return;
  }

  // Verbose path — the full multi-line framing for users who want it.
  if (info.quotaCost === "high") {
    process.stderr.write(
      `gemini: using ${resolved} (${info.tier}, quota-high) for \`${subcommand}\` — PRO quota is ~1-2 calls/month on this subscription. Only use if this is special-case work. For routine: /gemma:rescue, /codex:rescue, or Claude itself.\n`,
    );
    return;
  }
  if (info.quotaCost === "low") {
    process.stderr.write(
      `gemini: using ${resolved} (${info.tier}, quota-low) for \`${subcommand}\` — non-lite flash is daily-limited and depletes fast. For routine work: /gemma:rescue.\n`,
    );
    return;
  }
  process.stderr.write(
    `gemini: using ${resolved} (${info.tier}, quota-minimal) for \`${subcommand}\`. Gemini is a reluctant fallback — prefer /gemma:rescue for routine consultation when possible.\n`,
  );
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
    return run(`git diff ${base}...HEAD`, { fallback: "" });
  }

  if (scope === "branch") {
    const mainBranch =
      run("git rev-parse --verify main 2>/dev/null && echo main") ||
      run("git rev-parse --verify master 2>/dev/null && echo master") ||
      "main";
    return run(`git diff ${mainBranch}...HEAD`, { fallback: "" });
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
  if (base) return run(`git diff --shortstat ${base}...HEAD`, { fallback: "" });
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
function invokeGeminiWithCascade({ prompt, stdin, cascade, explicit, subcommand, approvalMode, sandbox, dirs, verbose, quiet }) {
  for (let i = 0; i < cascade.length; i++) {
    const model = cascade[i];
    const isFallback = i > 0;

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
          `gemini: exhausted every default model (${cascade.join(", ")}). Use -m flash / -m pro (quota-limited) or /gemma:rescue instead.\n`,
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

  // Pipe files via stdin if --files specified
  let stdin = null;
  if (args.files) {
    stdin = run(`cat ${args.files} 2>/dev/null`, { fallback: "", timeout: 15_000 });
    if (!stdin) {
      console.error(`Warning: --files "${args.files}" matched no files.`);
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

  // Normalize model aliases. `lite` / `flash-lite` → the newest lite (3.1),
  // which is also the plugin's default. `2.5-lite` is kept as the fallback
  // model's explicit alias so callers can pin to the stable older generation.
  // Pro and non-lite flash aliases stay the same but are now opt-in only.
  if (args.model === "lite" || args.model === "flash-lite") args.model = "gemini-3.1-flash-lite-preview";
  if (args.model === "3.1-lite") args.model = "gemini-3.1-flash-lite-preview";
  if (args.model === "2.5-lite") args.model = "gemini-2.5-flash-lite";
  if (args.model === "flash") args.model = "gemini-2.5-flash";
  if (args.model === "3-flash") args.model = "gemini-3-flash-preview";
  if (args.model === "pro") args.model = "gemini-2.5-pro";
  if (args.model === "3-pro" || args.model === "3.1-pro") args.model = "gemini-3.1-pro-preview";

  return args;
}

// ── Context estimation ──

function quickEstimateBytes(dirs) {
  const paths = dirs ? dirs.split(",").map((p) => p.trim()) : ["."];
  let totalKB = 0;
  for (const p of paths) {
    const duOut = run(`du -sk "${p}" 2>/dev/null`, { timeout: 5000, fallback: "0" });
    const match = duOut?.match(/^(\d+)/);
    if (match) totalKB += parseInt(match[1], 10);
  }
  // Subtract common large dirs when scanning whole repo
  if (!dirs) {
    for (const skip of [".git", "node_modules", "dist", ".next", "vendor", ".venv", "__pycache__"]) {
      const skipOut = run(`du -sk "${skip}" 2>/dev/null`, { timeout: 3000, fallback: "0" });
      const skipKB = parseInt(skipOut?.match(/^(\d+)/)?.[1] || "0", 10);
      totalKB = Math.max(0, totalKB - skipKB);
    }
  }
  return totalKB * 1024;
}

function estimateContext(dirs, files) {
  let totalBytes = 0;
  let fileCount = 0;

  if (files) {
    const out = run(`wc -c ${files} 2>/dev/null | tail -1`, { timeout: 10_000, fallback: "0" });
    totalBytes = parseInt(out?.match(/(\d+)/)?.[1] || "0", 10);
    const countOut = run(`ls -1 ${files} 2>/dev/null | wc -l`, { timeout: 5000, fallback: "0" });
    fileCount = parseInt(countOut?.trim() || "0", 10);
  } else {
    totalBytes = quickEstimateBytes(dirs);
    const scope = dirs ? dirs.split(",").join(" ") : ".";
    const excludes = [".git", "node_modules", "dist", ".next", "vendor", ".venv", "__pycache__"]
      .map((d) => `-not -path '*/${d}/*'`)
      .join(" ");
    const countOut = run(`find ${scope} -type f ${excludes} 2>/dev/null | wc -l`, {
      timeout: 10_000,
      fallback: "0",
    });
    fileCount = parseInt(countOut?.trim() || "0", 10);
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

    if (contextUsage > 0.5 && modelInfo.quotaCost === "high") {
      process.stderr.write(
        `\n>> WARNING: ~${(estimatedTokens / 1000).toFixed(0)}K estimated tokens with ${model} (quota-high, ~${Math.round(contextUsage * 100)}% of context window). Pro quota is ~1-2 calls/month — this single call could exhaust the month. Scope aggressively with --dirs/--files, or reroute to /gemma:rescue / /codex:rescue / Claude.\n\n`,
      );
    } else if (contextUsage > 0.5 && modelInfo.quotaCost === "low") {
      process.stderr.write(
        `\n>> NOTE: ~${(estimatedTokens / 1000).toFixed(0)}K tokens with ${model} (quota-low, ~${Math.round(contextUsage * 100)}% of context window). Non-lite flash is daily-limited. Scope with --dirs/--files, or use /gemma:rescue if this isn't special-case work.\n\n`,
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

  const warnings = [];
  if (contextUsage > 0.8) {
    warnings.push("Context usage >" + Math.round(contextUsage * 100) + "% of " + model + " limit — risk of truncation");
  }
  if (contextUsage > 0.3 && modelInfo.quotaCost === "high") {
    warnings.push("Large Pro request — pro quota is ~1-2 calls/month on this subscription, and this could exhaust it. Scope aggressively or reroute to /gemma:rescue, /codex:rescue, or Claude.");
  }
  if (contextUsage > 0.3 && modelInfo.quotaCost === "low") {
    warnings.push("Flash is quota-low (daily-limited). Scope with --dirs/--files or use /gemma:rescue unless this run is special-case work.");
  }
  if (modelInfo.quotaCost === "high" && !args.dirs && !args.files) {
    warnings.push("Using Pro on full repo — scope with --dirs or --files, or route routine work to /gemma:rescue.");
  }

  // When a non-lite tier would burn heavy quota on a non-trivial context,
  // recommend the lite tier (the default). Pro and non-lite flash are both
  // opt-in-only on this subscription; don't silently recommend stepping from
  // pro to flash because flash is also quota-limited.
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
  if (result.recommendedModel !== result.model) {
    console.log(`- **Recommended model:** ${result.recommendedModel}`);
  }
  if (warnings.length) {
    console.log("\n### Warnings\n");
    for (const w of warnings) console.log(`- ${w}`);
  }
}

// ── Main ──

const subcommand = process.argv[2];
const args = parseArgs(process.argv.slice(3));

function cmdExplain() {
  const primaryLite = MODEL_PREFERENCES.task[0];
  const fallbackLite = MODEL_PREFERENCES.task[1];
  console.log(`# Gemini Plugin — Model Policy

This plugin is a **reluctant fallback** on the oauth-personal subscription.
Pro quota is ~1-2 calls/month; non-lite flash is daily-limited and depletes
fast. For most work, prefer \`/gemma:rescue\` (local, free), \`/codex:rescue\`
(different subscription, more headroom), or Claude itself.

## Defaults per subcommand

Every subcommand auto-picks \`${primaryLite}\` (quota-minimal).
On "capacity exhausted" or "model not found" errors, the companion auto-falls-
back to \`${fallbackLite}\`.

Explicit \`-m\` never auto-falls-back — if you named a model, that choice is
respected and errors surface cleanly.

## Model catalog

| Tier    | Model ID                          | Alias(es)                    | Quota cost               | Auto-used?             |
|---------|-----------------------------------|------------------------------|--------------------------|------------------------|
| Lite    | gemini-3.1-flash-lite-preview     | lite, flash-lite, 3.1-lite   | minimal                  | Yes — default          |
| Lite    | gemini-2.5-flash-lite             | 2.5-lite                     | minimal                  | Yes — fallback target  |
| Flash   | gemini-2.5-flash                  | flash                        | low (daily-limited)      | Opt-in via -m          |
| Flash   | gemini-3-flash-preview            | 3-flash                      | low (daily-limited)      | Opt-in via -m          |
| Pro     | gemini-2.5-pro                    | pro                          | high (~1-2/month)        | Opt-in via -m          |
| Pro     | gemini-3.1-pro-preview            | 3-pro, 3.1-pro               | high (~1-2/month)        | Opt-in via -m          |

## Stderr announcements

Every call announces on stderr so you see what quota was spent.
- Default: one-line terse form. Mentions the model and a short routing hint.
- \`--verbose\` / \`-v\`: full multi-line message with quota context.
- \`--quiet\` / \`-q\`: suppress the announcement entirely.

## Fallback behavior

The companion detects these CLI-error patterns and cascades to the next model:
  - "exhausted your capacity", "quota exceeded", "rate limit", "resource exhausted"
  - "ModelNotFoundError", "requested entity was not found", "model not found",
    "deprecated", "invalid model", "is not supported", "unknown model"

If both primary and fallback are exhausted/unavailable, the call returns
empty and stderr names the exhausted cascade. Re-run with \`-m flash\` or
\`-m pro\` if you're willing to spend quota, or route to gemma/codex.

## When to reach for gemini

- You genuinely need the 1M-token context window (massive codebase context)
- You want an orthogonal model family for a second opinion (different family
  than both Claude and gemma)
- Agentic tool use where gemma's tier is insufficient and Claude / Codex
  can't cover the job

Otherwise: /gemma:rescue first. Almost always.

## Model IDs change

Google churns preview model names frequently. If the primary fails with a
"model not found" error, the cascade auto-falls-back — but if the fallback
also fails, check https://ai.google.dev/gemini-api/docs/models for current
IDs and update MODEL_PREFERENCES in scripts/gemini-companion.mjs.
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
