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
- Call out the plugin positioning: **gemini is a reluctant fallback tool** on this subscription. Pathologically tight quotas (pro: ~1-2 calls/month, non-lite flash: daily-limited). Default across every subcommand is `gemini-3.1-flash-lite-preview` (quota-minimal) with automatic fallback to `gemini-2.5-flash-lite`. Flash (non-lite) and pro tiers require explicit `-m` and should rarely be used.
- **Prefer other tools first:** `/gemma:rescue` (local, free) for routine consultation, `/codex:rescue` (different subscription, more headroom) for agentic coding, or Claude itself when the main thread has context. Gemini only for special cases where its 1M context, orthogonal model family, or specific agentic capability actually matters.
- Model IDs drift — Google churns Gemini previews frequently. If the primary default returns "model not found", the companion auto-falls-back to `gemini-2.5-flash-lite`. If both fail, check `ai.google.dev/gemini-api/docs/models` for the current IDs and update the plugin.
