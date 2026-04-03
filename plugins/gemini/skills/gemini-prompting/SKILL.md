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
- `gemini-2.5-flash` (default): Good reasoning, cheap on quota. Use for most tasks: reviews, lookups, straightforward fixes, documentation.
- `gemini-2.5-pro` (alias: `pro`): Best reasoning, expensive on quota. Reserve for complex debugging, security audits, architecture review, multi-file refactoring. Warn the user about quota cost before using.
- `gemini-3-flash` / `gemini-3.1-pro-preview`: Next-gen models. Same quota tiers as their 2.5 equivalents.
- Default to Flash. Only escalate to Pro when the task genuinely requires deeper reasoning.
- Use `--dirs` to scope context to relevant directories — reduces tokens and improves signal-to-noise.

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
