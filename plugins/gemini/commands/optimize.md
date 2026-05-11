---
description: Analyze a task and recommend the optimal Gemini model, context scope, and prompt to conserve quota
argument-hint: "[--dirs path,...] [--files pattern] [-m model] <task description>"
allowed-tools: Bash(node:*), Read, Glob
---

# /gemini:optimize

Analyze the requested Gemini task and recommend the most efficient execution strategy before spending quota.

## Step 1: Estimate context

Run the estimate against the current working directory (or scoped by any `--dirs`/`--files` flags the user passed):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" estimate --json $ARGUMENTS
```

Parse the JSON result. Note the `estimatedTokensK`, `contextUsagePercent`, `quotaCost`, `warnings`, and `recommendedModel`.

## Step 2: Analyze task complexity

From the remaining task text in `$ARGUMENTS` (after stripping flags), classify the task:

| Complexity | Signals | Model guidance |
|---|---|---|
| **Simple** | lookup, "what is", single-file, quick question | Route to **`/gemma:rescue`** (local, free). Don't open gemini at all. |
| **Moderate** | multi-file analysis, code review, documentation | Recommend `gemini-3-flash-preview` (`-m flash`). Empirical sub-pool ~1,000/day on Pro — comfortable for routine use. Or `/gemma:rescue` if local is enough. |
| **Complex** | architecture review, design challenge, security audit, cross-codebase debugging | Recommend `gemini-3.1-pro-preview` (`-m pro`). Empirical sub-pool ~100/day on Pro — plenty for a few deep reviews per day. Strongest reasoning in the catalog, 1M context for whole-codebase scope. Scope with `--dirs`/`--files` if the input is large. |

Quota reality on Google AI Pro: published 1,500/day total, enforced as undocumented per-model sub-pools (~100/day for pro models, ~1,000/day for flash and lite). The companion's local tracker (`~/.gemini/claude-plugin-usage.json`) mirrors today's count and the cascade auto-skips models past 90% to avoid abuse-detection flagging. Positioning: **gemini is a complementary peer**. Route trivial work to `/gemma:rescue`, sustained agentic coding to `/codex:rescue`, and reach for gemini specifically when 1M context, Gemini 3.1 reasoning, or orthogonal-model second opinion is what the task needs.

## Step 3: Recommend scope

If the estimate shows the full repo exceeds 200K estimated tokens:
- Use `Glob` to list top-level directories
- Based on the task description, recommend specific `--dirs` that cover the task without pulling in the whole repo
- Show estimated tokens with and without scoping

## Step 4: Suggest prompt structure

Write a ready-to-use optimized prompt for the task using Gemini best practices:
- Use XML tags for structure: `<task>`, `<constraints>`, `<output_format>`
- Be direct — no preamble
- Include scope constraints ("Focus ONLY on X. Skip Y.")
- Include output format requirements for actionable results
- Keep it tight — don't let the prompt itself waste tokens

## Output format

Present as:

### Quota impact
- Estimated context: X K tokens (~Y% of context window)
- Model: [recommended] ([quotaCost] quota cost)
- [Any warnings from estimate]

### Recommended command
A ready-to-copy `/gemini:rescue` command with optimal model and scope flags.

### Optimized prompt
The full prompt text the user can paste or use directly.

### Alternative approaches
If the task could be split into cheaper sequential calls instead of one large call, suggest that with estimated savings.

## Rules
- Never silently downgrade if the user explicitly asked for Pro or Flash — warn and recommend, but respect their choice.
- If context usage < 5% on any model, skip scoping recommendations — it's already cheap.
- For trivial / single-file lookup tasks, default-recommend `/gemma:rescue` (don't open gemini). For moderate tasks, default-recommend flash. For complex tasks where Gemini 3.1 Pro's reasoning genuinely fits, default-recommend pro.
- If no task text is provided, ask what Gemini should do.
