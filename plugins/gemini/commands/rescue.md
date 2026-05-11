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
- Leave `-m` unset unless the user explicitly asks. For `task` (rescue), the companion auto-picks `gemini-3.1-flash-lite-preview` with cascade fallback to `gemini-2.5-flash-lite`. Lite is the right default for rescue specifically — agent mode fans 1 prompt into many tool-call sub-requests, and the lite sub-pool (~1,000/day) absorbs that best.
- **Before forwarding**, consider whether the task is a fit for gemini. `/gemma:rescue` (local, free) is better for trivial consultation. `/codex:rescue` (separate subscription) is better for sustained agentic coding. Forward to gemini when the task specifically needs gemini's 1M context, an orthogonal model family for a second opinion, or Gemini 3.1's particular reasoning style.
- If the user asks for `lite` / `flash-lite`, that matches the rescue default — no change needed.
- If the user asks for `flash` or `3-flash`, map to `gemini-3-flash-preview`. Empirical sub-pool ~1,000/day on Pro — comfortable for occasional flash rescues, no need to flag cost on routine usage.
- If the user asks for `pro` / `3-pro` / `3.1-pro`, map to `gemini-3.1-pro-preview`. Empirical sub-pool ~100/day on Pro — fine for a one-off but consider whether the rescue actually needs pro reasoning. Most rescues don't.
- If the user asks for a concrete model name, pass it through with `-m`.
- If Gemini is missing or unauthenticated, stop and tell the user to run `/gemini:setup`.
- If the user did not supply a request, ask what Gemini should investigate or fix.
