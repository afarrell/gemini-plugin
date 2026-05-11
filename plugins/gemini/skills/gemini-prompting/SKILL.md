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

**Positioning.** The gemini plugin is a **complementary peer** on Google AI Pro. Published 1,500/day total is enforced as undocumented per-model sub-pools (~100/day pro, ~1,000/day flash and lite). Pick gemini when its specific advantages matter: 1M-token context, Gemini 3.1 Pro reasoning (Deep Think is model-side at the pro tier), or a genuinely orthogonal model family for second-opinion work. For trivial consultation use **/gemma:rescue** (local, free); for sustained agentic coding sessions use **/codex:rescue** (separate subscription).

Defaults are tuned per subcommand:
- `task` (rescue, agentic) → `gemini-3.1-flash-lite-preview` — agent mode fans 1 prompt into many sub-requests, so the lite sub-pool absorbs that best
- `review` → `gemini-3-flash-preview` — strong reasoning on a bounded diff, ~1,000/day sub-pool means routine review use is well within budget
- `adversarial-review` → `gemini-3.1-pro-preview` — strongest reasoning in the catalog, fits design challenges; ~100/day sub-pool comfortably covers a few deep reviews per day. (Google references Deep Think mode at pro; the model card doesn't document how it activates, so treat that as a marketing claim rather than a guarantee.)

The cascade auto-falls-back on quota / 429 / model-not-found, AND pre-flight skips models past 90% of the empirical sub-pool to stay clear of Google's abuse-detection threshold (rolled out 2026-03-25).

**Model catalog** (Google churns these frequently — treat IDs as provisional):

| Tier | Preferred model | Alias | Empirical sub-pool | Default for |
|------|-----------------|-------|--------------------|-----------------|
| **Lite (3.1)** | `gemini-3.1-flash-lite-preview` | `lite`, `flash-lite`, `3.1-lite` | ~1,000/day | `task` (rescue) |
| **Lite (2.5)** | `gemini-2.5-flash-lite` | `2.5-lite` | ~1,000/day | Cascade target |
| **Flash (3)** | `gemini-3-flash-preview` | `flash`, `3-flash` | ~1,000/day | `review` |
| **Flash (2.5)** | `gemini-2.5-flash` | `2.5-flash` | ~1,000/day | Review cascade |
| **Pro (3.1)** | `gemini-3.1-pro-preview` | `pro`, `3-pro`, `3.1-pro` | ~100/day | `adversarial-review` |
| **Pro (2.5)** | `gemini-2.5-pro` | `2.5-pro` | ~100/day | Pinning to older gen |

**Rules for when to escalate or route elsewhere:**
- **Trivial consultation, explanation, rubber-ducking** → `/gemma:rescue` (local, free). Don't open gemini.
- **Sustained agentic coding** → `/codex:rescue` (separate subscription, doesn't touch Google quota).
- **Code review** → default `/gemini:review` (flash). Pro only if the diff is unusually large or design-critical.
- **Design challenge / adversarial review** → `/gemini:adversarial-review` (defaults to pro with Deep Think) — this is the canonical fit for Gemini 3.1 Pro.
- **Whole-codebase context (>200K tokens of input)** → gemini is the only option in the toolkit with a 1M window; lean into pro or flash here.
- **Bounded rescue** → default `/gemini:rescue` (lite). Escalate with `-m flash` if the lite pass was clearly inadequate.

**Important: model IDs drift.** Google renames and deprecates preview models frequently. The companion's fallback cascade catches "model not found" / "deprecated" / 429 errors in addition to quota exhaustion. If a whole cascade fails, check `ai.google.dev/gemini-api/docs/models` for current IDs and update `MODEL_PREFERENCES` in the companion script.

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
