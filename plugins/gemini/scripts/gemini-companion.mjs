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
const DEFAULT_MODEL = "gemini-2.5-flash";
const FAST_MODEL = "gemini-2.5-flash";

const MODELS = {
  "gemini-2.5-flash": { contextWindow: 1_048_576, quotaCost: "low", tier: "flash" },
  "gemini-2.5-flash-lite": { contextWindow: 1_048_576, quotaCost: "minimal", tier: "flash-lite" },
  "gemini-2.5-pro": { contextWindow: 1_048_576, quotaCost: "high", tier: "pro" },
  "gemini-3-flash": { contextWindow: 1_048_576, quotaCost: "low", tier: "flash" },
  "gemini-3.1-pro-preview": { contextWindow: 1_048_576, quotaCost: "high", tier: "pro" },
};

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

function invokeGemini({ prompt, stdin, model, approvalMode, sandbox, dirs }) {
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

  if (result.status !== 0 && result.stderr) {
    // Print stderr but don't fail — Gemini sometimes writes info to stderr
    process.stderr.write(result.stderr);
  }

  return result.stdout || "";
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

  const model = args.model || DEFAULT_MODEL;
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

  const output = invokeGemini({ prompt, stdin: diff, model });
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

  const model = args.model || DEFAULT_MODEL;
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

  const output = invokeGemini({ prompt, stdin: diff, model });
  process.stdout.write(output);
}

function cmdTask(args) {
  const taskText = args.rest.join(" ");
  if (!taskText) {
    console.error("Error: No task description provided.");
    process.exit(1);
  }

  const model = args.model || DEFAULT_MODEL;
  const write = args.write !== false; // default to write-capable
  const approvalMode = write ? "auto_edit" : "plan";

  // Auto-warn if context is likely expensive
  warnIfExpensive(model, args.dirs);

  // Pipe files via stdin if --files specified
  let stdin = null;
  if (args.files) {
    stdin = run(`cat ${args.files} 2>/dev/null`, { fallback: "", timeout: 15_000 });
    if (!stdin) {
      console.error(`Warning: --files "${args.files}" matched no files.`);
    }
  }

  const output = invokeGemini({
    prompt: taskText,
    stdin,
    model,
    approvalMode,
    sandbox: args.sandbox || false,
    dirs: args.dirs,
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
      default:
        args.rest.push(arg);
    }
    i++;
  }

  // Normalize model aliases
  if (args.model === "flash") args.model = FAST_MODEL;
  if (args.model === "pro") args.model = "gemini-2.5-pro";
  if (args.model === "3-flash") args.model = "gemini-3-flash";
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
        `\n>> WARNING: ~${(estimatedTokens / 1000).toFixed(0)}K estimated tokens with ${model} (high quota cost, ~${Math.round(contextUsage * 100)}% of context window). Consider: --dirs to scope, or -m flash.\n\n`,
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
    warnings.push("Large Pro request — significant daily quota consumption. Consider Flash or scoping with --dirs");
  }
  if (modelInfo.quotaCost === "high" && !args.dirs && !args.files) {
    warnings.push("Using Pro on full repo — consider --dirs to scope, or -m flash");
  }

  const recommendedModel =
    contextUsage > 0.3 && modelInfo.quotaCost === "high" ? FAST_MODEL : model;

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
  default:
    console.log(`gemini-companion: unknown subcommand "${subcommand}"`);
    console.log("Usage: gemini-companion <setup|review|adversarial-review|task|estimate> [options]");
    process.exit(1);
}
