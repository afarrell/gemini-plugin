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
| **Moderate** | multi-file analysis, documentation, review | Default lite (`gemini-3.1-flash-lite-preview`) if gemini's specific advantages are actually needed. Otherwise prefer `/gemma:rescue` (deeper models like 31B) or `/codex:rescue`. |
| **Complex** | architecture review, security audit, cross-codebase debugging, refactoring impact | Try gemma-31B first. If that was clearly insufficient, a single `-m 3-pro` call may be justified — but pro quota is **~1-2 calls/month**; confirm with the user it's worth one of them. Scope aggressively with `--dirs` / `--files`. |

Quota reality on this subscription (oauth-personal): lite = minimal (default, generous daily limit), flash (non-lite) = low (daily-limited, depletes fast — opt-in only), pro = high (~1-2 calls/month — opt-in only, precious). Positioning: **gemini plugin is a reluctant fallback tool**. Route most work to `/gemma:rescue`, `/codex:rescue`, or Claude itself. Only recommend gemini when its specific advantages (1M context, orthogonal model family, specific agentic needs) actually matter.

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
- Default-recommend lite for most tasks. Only recommend flash/pro when the complexity signals genuinely require deeper reasoning.
- If no task text is provided, ask what Gemini should do.
