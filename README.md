# gemini-plugin

Claude Code plugin that integrates [Gemini CLI](https://github.com/google-gemini/gemini-cli) for code review, task delegation, and codebase analysis.

Uses your Google subscription (oauth-personal) for authentication — no API key billing.

## Prerequisites

1. **Install Gemini CLI**

   ```bash
   bun install -g @google/gemini-cli
   ```

2. **Authenticate** — run `gemini` interactively to complete Google OAuth.

3. **Verify**

   ```bash
   gemini "what is 2+2" -o text --approval-mode yolo
   ```

## Installation

Install from the local directory source:

```
/plugins install /path/to/gemini-plugin
```

Or point `extraKnownMarketplaces` in `~/.claude/settings.json` at the repo directory:

```json
{
  "extraKnownMarketplaces": {
    "gemini-local": {
      "source": { "source": "directory", "path": "/path/to/gemini-plugin" }
    }
  }
}
```

## Commands

### `/gemini:rescue` — Delegate work to Gemini

Hand a task to Gemini for a second opinion, debugging, implementation, or research.

```bash
/gemini:rescue fix the race condition in src/worker.ts
/gemini:rescue --background investigate why the auth tests are flaky
/gemini:rescue -m pro refactor the database layer for connection pooling
/gemini:rescue --dirs src,lib --read-only explain how the caching layer works
```

| Flag | Description |
|------|-------------|
| `--background` | Run in the background; you'll be notified on completion |
| `--wait` | Run in the foreground (default) |
| `--read-only` | Gemini won't make file edits |
| `--dirs path,...` | Scope Gemini's context to specific directories |
| `--files pattern` | Pipe matching files to Gemini via stdin |
| `-m model` | Override model (see [Models](#models)) |

By default, Gemini runs in write mode (`--approval-mode auto_edit`) so it can read and edit files in the repo.

### `/gemini:review` — Code review

Run a Gemini code review against local git changes (staged + unstaged).

```bash
/gemini:review
/gemini:review --base main
/gemini:review --scope branch
/gemini:review --background
```

| Flag | Description |
|------|-------------|
| `--base <ref>` | Diff against a specific git ref |
| `--scope auto\|working-tree\|branch` | What to review (default: `auto`) |
| `--background` | Run in the background |
| `-m model` | Override model |

The command estimates diff size and recommends foreground vs background execution. Review output is returned verbatim — Claude will not auto-apply fixes.

### `/gemini:adversarial-review` — Challenge review

Like `/gemini:review`, but questions the implementation approach, design choices, tradeoffs, and assumptions rather than just looking for bugs.

```bash
/gemini:adversarial-review
/gemini:adversarial-review focus on the error handling strategy
/gemini:adversarial-review --base feature-branch
```

Accepts the same flags as `/gemini:review`, plus optional free-text focus areas appended after the flags.

### `/gemini:optimize` — Plan before spending quota

Analyze a task and recommend the optimal model, context scope, and prompt structure before consuming quota.

```bash
/gemini:optimize security audit of the auth module
/gemini:optimize --dirs src explain the data pipeline architecture
/gemini:optimize -m pro refactor the API layer
```

Reports:
- **Quota impact** — estimated tokens, context usage %, cost tier
- **Recommended command** — ready-to-copy `/gemini:rescue` with optimal flags
- **Optimized prompt** — structured prompt using Gemini best practices
- **Warnings** — if the task would burn significant quota

### `/gemini:setup` — Check readiness

Verify Gemini CLI installation, authentication, and configuration. Offers to install if missing.

```bash
/gemini:setup
```

## Models

**Positioning — this is a reluctant fallback tool.** The oauth-personal subscription has pathologically tight quotas: pro tiers are ~1-2 calls/month, non-lite flash is daily-limited and depletes fast. For routine work, always prefer:

- **`/gemma:rescue`** — local (Ollama), free, uses a dense 31B model for review/adversarial-review when installed. This is the default cheap-tier option.
- **`/codex:rescue`** — different subscription (ChatGPT), generally more headroom for agentic coding work.
- **Claude itself** — when the main thread already has the relevant context.

Only reach for gemini when its specific advantages matter: the 1M-token context window, an orthogonal model family for second-opinion work, or agentic tool use needing deeper reasoning than gemma can provide.

**Default across every subcommand:** `gemini-3.1-flash-lite-preview` (quota-minimal). Automatically falls back to `gemini-2.5-flash-lite` if the 3.1 preview is exhausted or deprecated. Non-lite flash and all pro tiers require explicit `-m` and should rarely be used.

**Aliases:**

| Alias | Resolves to | Quota cost | Auto-used? |
|-------|-------------|------------|-----------|
| `lite` / `flash-lite` / `3.1-lite` | `gemini-3.1-flash-lite-preview` | Minimal | **Default** |
| `2.5-lite` | `gemini-2.5-flash-lite` | Minimal | Auto-fallback when 3.1 lite fails |
| `flash` | `gemini-2.5-flash` | Low — daily-limited | Opt-in only |
| `3-flash` | `gemini-3-flash-preview` | Low — daily-limited | Opt-in only |
| `pro` | `gemini-2.5-pro` | High — **~1-2 calls/month** | Opt-in only |
| `3-pro` / `3.1-pro` | `gemini-3.1-pro-preview` | High — **~1-2 calls/month** | Opt-in only |

**Model IDs churn.** Google renames and deprecates Gemini preview models frequently. The companion's fallback cascade catches "model not found" / "deprecated" errors in addition to quota exhaustion, so a removed primary degrades cleanly. If both cascade entries fail, check [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models) for the current lite IDs and update the catalog in `scripts/gemini-companion.mjs`.

## Quota Protection

The plugin includes automatic quota protection:

- **Auto-warning**: Before every `task` invocation, the companion script estimates context size. Warnings appear on stderr when:
  - Context usage > 50% with a Pro model (quota-high — pro allocation is ~1-2 calls/month)
  - Context usage > 50% with a non-lite Flash model (quota-low — daily-limited)
  - Context usage > 80% with any model (truncation risk)
- **Stderr announcement**: The companion announces the model it's running on every call, even the lite default. The lite-tier announcement reminds you that gemini is a reluctant fallback and points at `/gemma:rescue`; non-lite tiers escalate the warning with the specific quota cost.
- **Automatic fallback**: When the default model fails with "capacity exhausted" or "model not found", the companion auto-tries the next entry in its cascade (2.5-flash-lite) and announces the switch. Never auto-falls-back to non-lite tiers — those require explicit `-m`.

- **`estimate` subcommand**: Get context metrics without spending quota:

  ```bash
  # Via the companion script directly
  node scripts/gemini-companion.mjs estimate --json
  node scripts/gemini-companion.mjs estimate --dirs src -m pro --json
  ```

  Returns: file count, total bytes, estimated tokens, context usage %, quota cost tier, recommended model, and warnings.

- **`/gemini:optimize`**: Claude-powered analysis that recommends model, scope, and prompt structure tailored to the specific task.

## Autonomous Agent

The `gemini-rescue` agent can be spawned automatically by Claude when it needs a second perspective on a problem. It acts as a thin forwarder — it shapes the prompt using Gemini best practices, invokes the companion script once, and returns Gemini's output verbatim.

It does not inspect the repo, reason through the problem, or do follow-up work on its own. This keeps the delegation clean: Gemini does the work, Claude presents the result.

## Context Scoping

Two ways to control what Gemini sees:

| Flag | How it works | Best for |
|------|-------------|----------|
| `--dirs src,lib` | Passes `--include-directories` to Gemini CLI — Gemini explores those directories itself | Exploratory tasks where Gemini should decide what to read |
| `--files "src/**/*.ts"` | Pipes matching files into Gemini via stdin | Focused analysis of known files |

Without either flag, Gemini operates on the full repo. For large repos, always scope — the `estimate` command or `/gemini:optimize` will tell you when.

## Architecture

```
gemini-plugin/
  plugins/gemini/
    .claude-plugin/plugin.json        # Plugin manifest
    agents/
      gemini-rescue.md                # Autonomous agent (thin forwarder)
    commands/
      rescue.md                       # /gemini:rescue — task delegation
      review.md                       # /gemini:review — code review
      adversarial-review.md           # /gemini:adversarial-review — challenge review
      optimize.md                     # /gemini:optimize — quota-aware planning
      setup.md                        # /gemini:setup — installation check
    scripts/
      gemini-companion.mjs            # Node.js companion (arg parsing, git diff,
                                      #   Gemini invocation, context estimation)
    skills/
      gemini-cli-runtime/SKILL.md     # Internal: how to invoke the companion script
      gemini-prompting/SKILL.md       # Internal: prompt crafting guidance
      gemini-result-handling/SKILL.md  # Internal: how to present Gemini output
```

### Design principles

- **Companion script over raw CLI strings.** All Gemini invocations go through `gemini-companion.mjs`, which handles arg parsing, model normalization, git diff extraction, and context estimation. Commands and agents never construct raw `gemini` CLI strings.

- **Thin forwarder pattern.** The rescue agent's only job is to shape a prompt and invoke the companion script once. It doesn't read files, solve problems, or add analysis — that would defeat the purpose of delegating to Gemini.

- **Review safety gate.** After presenting review findings, Claude must ask before making any changes. Auto-applying fixes from a review is forbidden.

- **Quota-aware by default.** Gemini is positioned as a reluctant fallback tool. Every call announces its model on stderr and reminds the caller that `/gemma:rescue`, `/codex:rescue`, or Claude itself is usually the better choice for routine work. The default (3.1 lite) is quota-minimal; flash and pro tiers are opt-in only.

## Auth

Uses `oauth-personal` — your Google One AI Premium or Google AI Pro subscription. No API keys, no per-token billing. Run `gemini` interactively once to authenticate, and the companion script uses the stored credentials at `~/.gemini/oauth_creds.json`.

## License

MIT
