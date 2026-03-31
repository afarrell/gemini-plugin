---
description: Check whether Gemini CLI is ready (binary, auth, subscription)
argument-hint: '[--json]'
allowed-tools: Bash(node:*), Bash(bun:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json $ARGUMENTS
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json $ARGUMENTS
```

If Gemini is already installed or bun is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Gemini is installed but not authenticated, tell the user to run `! gemini` interactively to complete Google OAuth.
- Emphasize that Gemini uses the user's Google subscription (oauth-personal), not API key billing.
