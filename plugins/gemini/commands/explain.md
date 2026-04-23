---
description: Print the gemini plugin's full model policy (tiers, cascades, quota rules) without making an API call
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" explain
```

Return the output verbatim. Do not summarize or paraphrase — the user invoked this command to see the full policy, not a condensed version.
