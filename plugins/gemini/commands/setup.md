---
description: Check whether Gemini CLI is ready (binary, auth, subscription)
argument-hint: '[--json]'
allowed-tools: Bash(node:*), Bash(bun:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json "$ARGUMENTS"
```

If the result says Gemini is unavailable and bun is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Gemini now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Gemini CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
bun install -g @google/gemini-cli
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json "$ARGUMENTS"
```

If Gemini is already installed or bun is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Gemini is installed but not authenticated, tell the user to run `! gemini` interactively to complete Google OAuth.
- Emphasize that Gemini uses the user's Google subscription (oauth-personal), not API key billing.
- Call out the plugin positioning: **gemini is a complementary peer** on Google AI Pro. The published 1,500/day total is enforced as undocumented per-model sub-pools (~100/day pro, ~1,000/day flash and lite). Defaults are tuned per subcommand: `task` (rescue) uses flash-lite, `review` uses flash, `adversarial-review` uses pro with model-side Deep Think reasoning.
- **Pick the right tool:** `/gemma:rescue` (local, free) for trivial consultation, `/codex:rescue` (separate subscription) for agentic coding sessions, gemini when its specific advantages matter — 1M-token context, Gemini 3.1 Pro reasoning, or genuinely orthogonal second opinion.
- Run `/gemini:explain` to see today's per-model usage, the full cascade per subcommand, and the policy in detail.
- Model IDs drift — Google churns Gemini previews frequently. The cascade auto-falls-back on "model not found" / 429 / quota errors. If every cascade entry fails, check `ai.google.dev/gemini-api/docs/models` for current IDs and update `MODEL_PREFERENCES` in the companion script.
