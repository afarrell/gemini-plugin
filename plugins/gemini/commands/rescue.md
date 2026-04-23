---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Gemini rescue subagent
argument-hint: "[--background|--wait] [--read-only] [-m <model|flash>] [what Gemini should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*)
---

Route this request to the `gemini:gemini-rescue` subagent.
The final user-visible response must be Gemini's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `gemini:gemini-rescue` subagent in the background.
- If the request includes `--wait`, run the `gemini:gemini-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `-m` / `--model` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Gemini companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, summarize output, or do follow-up work of its own.
- Leave `-m` unset unless the user explicitly asks. The companion auto-picks `gemini-3.1-flash-lite-preview` (quota-minimal) with automatic fallback to `gemini-2.5-flash-lite` if the 3.1 preview is exhausted or removed. Non-lite flash and pro are opt-in-only.
- **Before forwarding**, seriously consider rerouting the request. On this subscription gemini is a reluctant fallback: `/gemma:rescue` (local, free) handles most routine consultation better, `/codex:rescue` has more subscription headroom for agentic coding, and Claude itself may already have the context. Only forward to gemini if the task specifically needs gemini's 1M context, orthogonal model family for a second opinion, or agentic file work beyond gemma's tier.
- If the user asks for `lite` / `flash-lite`, that matches the default — no change needed.
- If the user asks for `flash` or `3-flash`, map accordingly. Quota-low (daily-limited) — flag the cost back briefly.
- If the user asks for `pro` / `3-pro` / `3.1-pro`, map accordingly. **Pro quota is ~1-2 calls/month on this subscription** — confirm the user wants to spend that allocation before proceeding.
- If the user asks for a concrete model name, pass it through with `-m`.
- If Gemini is missing or unauthenticated, stop and tell the user to run `/gemini:setup`.
- If the user did not supply a request, ask what Gemini should investigate or fix.
