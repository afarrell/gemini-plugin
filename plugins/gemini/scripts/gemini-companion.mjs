#!/usr/bin/env node
/**
 * gemini-companion.mjs — Companion script for Gemini CLI integration with Claude Code.
 *
 * Subcommands:
 *   setup               Check Gemini binary, auth, and readiness
 *   review              Run a code review against local git state
 *   adversarial-review  Run a challenge-focused code review
 *   task                Delegate arbitrary work to Gemini
 *
 * Auth: Uses oauth-personal (Google subscription), not API key billing.
 * All invocations go through `gemini -p` (headless mode).
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || process.env.USERPROFILE;
const DEFAULT_MODEL = "gemini-2.5-flash";
const FAST_MODEL = "gemini-2.5-flash";

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

function invokeGemini({ prompt, stdin, model, approvalMode, sandbox }) {
  const args = ["-p", prompt, "-o", "text"];
  if (model) args.push("-m", model);
  if (approvalMode) args.push("--approval-mode", approvalMode);
  if (sandbox) args.push("-s");

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

  const output = invokeGemini({
    prompt: taskText,
    model,
    approvalMode,
    sandbox: args.sandbox || false,
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
  if (args.model === "pro") args.model = DEFAULT_MODEL;

  return args;
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
  default:
    console.log(`gemini-companion: unknown subcommand "${subcommand}"`);
    console.log("Usage: gemini-companion <setup|review|adversarial-review|task> [options]");
    process.exit(1);
}
