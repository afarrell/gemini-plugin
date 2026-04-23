---
name: gemini-cli-runtime
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
user-invocable: false
---

# Gemini CLI Runtime

Use this skill only inside the `gemini:gemini-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task "<raw arguments>"`

Auth model:
- Gemini CLI uses `oauth-personal` — the user's Google subscription, not API key billing.
- No API key setup required. Auth is pre-configured via `~/.gemini/oauth_creds.json`.

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `gemini` CLI strings or any other Bash activity.
- Do not call `setup`, `review`, or `adversarial-review` from `gemini:gemini-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gemini-prompting` skill to rewrite the user's request into a tighter prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `-m` unset by default. The companion auto-picks `gemini-3.1-flash-lite-preview` (quota-minimal) for every subcommand, with automatic fallback to `gemini-2.5-flash-lite` if the 3.1 preview is exhausted or deprecated. Flash (non-lite) and pro tiers are opt-in only — never auto-picked.
- Model aliases: `lite` / `flash-lite` / `3.1-lite` → `gemini-3.1-flash-lite-preview` (default), `2.5-lite` → `gemini-2.5-flash-lite` (fallback), `flash` → `gemini-2.5-flash` (opt-in, quota-low), `3-flash` → `gemini-3-flash-preview` (opt-in, quota-low), `pro` → `gemini-2.5-pro` (opt-in, quota-high ~1-2/month), `3-pro` / `3.1-pro` → `gemini-3.1-pro-preview` (opt-in, same quota).
- The companion writes a one-line stderr note on every call showing the model, tier, and a reminder that gemini is a reluctant fallback. Surface this to the user if they ask what ran.
- **Gemini is a fallback tool** on this subscription — the oauth-personal quotas are pathologically tight. Prefer `/gemma:rescue` (local, free), `/codex:rescue` (different subscription, more headroom), or Claude itself for most work. Only reach for gemini when the specific advantages (1M context, orthogonal model family, agentic tool use beyond gemma's tier) actually matter.
- Context scoping: `--dirs src,lib` maps to `--include-directories`. `--files "src/**/*.ts"` pipes matching files via stdin.
- The script auto-warns on stderr when estimated context is expensive (>50% with Pro, >80% with any model).
- Default to a write-capable run (`--write`) unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Do not forward them to `task`.
- If the forwarded request includes `-m` or `--model`, normalize: `lite`/`flash-lite`/`3.1-lite` → `gemini-3.1-flash-lite-preview`, `2.5-lite` → `gemini-2.5-flash-lite`, `flash` → `gemini-2.5-flash`, `3-flash` → `gemini-3-flash-preview`, `pro` → `gemini-2.5-pro`, `3-pro`/`3.1-pro` → `gemini-3.1-pro-preview`. Pass through.
- If the forwarded request includes `--resume`, add `--resume` to the gemini invocation for session continuity.
- If the forwarded request includes `--fresh`, do not add `--resume`.
- Preserve the user's task text as-is apart from stripping routing flags.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Gemini cannot be invoked, return nothing.

Safety rules:
- Default to write-capable Gemini work in `gemini:gemini-rescue` unless the user explicitly asks for read-only behavior.
- Do not inspect the repository, read files, grep, monitor progress, summarize output, or do any follow-up work of your own.
