---
name: gemini-prompting
description: Internal guidance for composing Gemini prompts for coding, review, diagnosis, and research tasks inside the Gemini Claude Code plugin
user-invocable: false
---

# Gemini Prompting

Use this skill when `gemini:gemini-rescue` needs to shape a prompt before forwarding to Gemini CLI.

Gemini CLI runs in headless mode (`-p`) with the user's Google subscription. The model has full workspace access when `--approval-mode auto_edit` is set — it can read files, edit files, and run commands.

Core rules:
- Prefer one clear task per Gemini run. Split unrelated asks into separate runs.
- Tell Gemini what done looks like. Do not assume it will infer the desired end state.
- Add explicit grounding and verification rules for any task where unsupported guesses would hurt quality.
- Prefer better prompt contracts over verbose explanations.
- Use XML tags for stable internal structure when the prompt is complex.

Default prompt recipe:
- `<task>`: the concrete job and the relevant repository or failure context.
- `<output_contract>`: exact shape, ordering, and brevity requirements for the response.
- `<follow_through>`: what Gemini should do by default instead of asking routine questions.
- `<verification>`: required for debugging, implementation, or risky fixes — tells Gemini to verify its work.
- `<grounding>`: required for review, research, or anything that could drift into unsupported claims.

When to add blocks:
- Coding or debugging: add `verification` and `completeness` blocks.
- Review or adversarial review: add `grounding` and `structured_output` blocks.
- Research or recommendation tasks: add `citation` and `evidence` blocks.
- Write-capable tasks: add `scope_guard` so Gemini stays narrow and avoids unrelated refactors.

Model selection guidance (quota-aware):

**Positioning.** The gemini plugin is a **reluctant fallback tool** on this subscription. The oauth-personal daily quotas are pathologically tight — pro tiers are ~1-2 calls/month, non-lite flash is daily-limited and depletes fast. Almost every request is better served elsewhere: **/gemma:rescue** for routine consultation (local, free), **/codex:rescue** for agentic coding with cloud-tier reasoning, or **Claude itself** when the main thread has the context. Gemini is for special cases where its specific advantages matter: the 1M-token context window, a genuinely orthogonal model family, or agentic tool use with a model tier gemma can't match.

Default across every subcommand: `gemini-3.1-flash-lite-preview`, with automatic fallback to `gemini-2.5-flash-lite` if the 3.1 preview is exhausted or deprecated. Flash (non-lite) and pro tiers are opt-in-only via explicit `-m`.

**Model catalog** (Google churns these frequently — treat IDs as provisional):

| Tier | Preferred model | Alias | Quota | When to use |
|------|-----------------|-------|-------|-------------|
| **Lite (default)** | `gemini-3.1-flash-lite-preview` | `lite`, `flash-lite`, `3.1-lite` | Minimal | Always the default. Auto-fallback target. |
| **Lite (fallback)** | `gemini-2.5-flash-lite` | `2.5-lite` | Minimal | Auto-used when 3.1 lite is exhausted or removed. |
| **Flash (opt-in only)** | `gemini-2.5-flash` | `flash` | Low (daily-limited) | When lite output is clearly inadequate and the task is special-case. |
| **Flash (opt-in only)** | `gemini-3-flash-preview` | `3-flash` | Low (daily-limited) | Pro-level reasoning at flash speed. Only via explicit `-m`. |
| **Pro (opt-in only)** | `gemini-3.1-pro-preview` | `3-pro`, `3.1-pro` | High (~1-2/month) | Only for truly special cases where no other tool works. |
| **Pro (opt-in only)** | `gemini-2.5-pro` | `pro` | High | Alternate pro. Same quota constraint. |

**Rules for when to escalate or route elsewhere:**
- **Routine consultation, explanation, rubber-ducking** → `/gemma:rescue` (local, free). Don't open gemini at all.
- **Agentic coding with cloud reasoning** → `/codex:rescue` (different subscription, usually more headroom).
- **Deeper reasoning on a bounded question** → try `/gemma:rescue` with `-m dense` first; escalate to gemini only if gemma output was clearly insufficient.
- **Special-case work that needs gemini specifically** (massive context, agentic file work with deeper reasoning than gemma can give) → default is `/gemini:rescue` (3.1 lite, auto-fallback to 2.5 lite). Only use `-m flash` / `-m pro` when the lite pass was inadequate AND the task genuinely justifies burning scarce quota.

**Important: model IDs drift.** Google renames and deprecates preview models frequently. The companion's fallback cascade catches "model not found" / "deprecated" errors in addition to quota exhaustion, so a removed primary still degrades cleanly. If both cascade entries fail, check `ai.google.dev/gemini-api/docs/models` for the current lite model IDs and update the catalog.

Prompt assembly checklist:
1. Define the exact task and scope in `<task>`.
2. Choose the smallest output contract that still makes the answer easy to use.
3. Decide whether Gemini should keep going by default or stop for missing high-risk details.
4. Add verification, grounding, and safety tags only where the task needs them.
5. Remove redundant instructions before sending the prompt.

Working rules:
- Prefer explicit prompt contracts over vague nudges.
- Do not raise complexity first. Tighten the prompt before escalating.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.
- When passing workspace context, reference file paths rather than inlining content — Gemini can read files directly.
