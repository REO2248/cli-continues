# 2026-04-27 P1 Parser Debug Audit

## Scope

Focused audit for hidden P0/P1 bugs in `continues`, especially Claude, Codex,
Droid, and Copilot. No P0 was confirmed. This note records only P1 findings
that should be fixed before broad multi-agent use.

## Primary Sources

- Claude Code CLI resume and hooks:
  https://code.claude.com/docs/en/cli-usage,
  https://code.claude.com/docs/en/hooks
- OpenAI Codex CLI resume and rollout layout:
  https://developers.openai.com/codex/cli/features,
  https://developers.openai.com/codex/cli/reference,
  https://github.com/openai/codex/blob/main/codex-rs/rollout/src/list.rs
- GitHub Copilot CLI session storage and command reference:
  https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices,
  https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/copilot-cli/chronicle,
  https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
- Factory Droid CLI, exec, and hooks:
  https://docs.factory.ai/reference/cli-reference,
  https://docs.factory.ai/cli/droid-exec/overview,
  https://docs.factory.ai/reference/hooks-reference

## P1 Findings

| ID | Area | Symptom | Mechanism | Required Regression |
|---|---|---|---|---|
| P1-01 | Codex resume | Same-tool Codex resume can start fresh or fail. | `src/parsers/registry.ts` uses obsolete `-c experimental_resume=<path>` instead of `codex resume <id>`. | Assert Codex native args/display use `resume <id>`. |
| P1-02 | Droid resume | Same-tool Droid resume uses an invalid top-level flag. | `droid -s <id>` mixes `droid exec --session-id` semantics into interactive resume. | Assert Droid native args/display use `--resume <id>`. |
| P1-03 | Cross-tool resume | Invalid `--in` can write handoff files before failing. | Target validation happens after `extractContext()`, local `.continues-handoff.md`, and global context writes. | Invalid target rejects before extract/write/save. |
| P1-04 | Copilot cache | `COPILOT_HOME` changes can serve stale cached sessions. | Copilot parser reads `COPILOT_HOME`, but adapter metadata lacks `envVar`, so index fingerprint ignores it. | `indexNeedsRebuild()` returns true after `COPILOT_HOME` changes. |
| P1-05 | Claude handoff | Recent handoff can omit the last user request. | Parser slices raw conversational rows before dropping assistant thinking/tool-only rows. | Fixture with user plus many tool-only assistant rows still includes user. |
| P1-06 | Claude subagents | Claude `Agent` sidecar results can be missed. | Parser relies on queue-operation task IDs and ignores `toolUseResult.agentId`/sidecar output. | Fixture with `Agent` + `toolUseResult.agentId` extracts subagent result. |
| P1-07 | Claude ordering | Old Claude sessions can appear newest. | Parser sorts by filesystem `mtime`, which metadata touches can update after transcript activity. | Fixture uses transcript timestamps instead of stat `mtime`. |
| P1-08 | Codex compaction | Long Codex handoffs lose canonical compacted state. | Parser ignores top-level `compacted` rollout records. | Fixture with `compacted.payload.message` renders compact summary. |
| P1-09 | Codex edits | `edit_file` calls do not populate `filesModified`. | Function-call edit tools fall through to generic MCP summaries. | Fixture with `edit_file` and MCP-namespaced edit tracks paths as edits. |
| P1-10 | Codex stdin | `write_stdin` summaries are blank for current Codex logs. | Parser reads `input`/`data`, but logs use `chars`. | Fixture with `chars` appears in tool summary. |
| P1-11 | Droid discovery | Documented Droid transcript roots may be missed. | Parser scans only `~/.factory/sessions`, while hooks expose `.factory/projects/.../*.jsonl`. | Fixture under both roots is discovered and deduped. |
| P1-12 | Droid recency | Long Droid sessions sort stale. | Parser scans only first 100 lines and derives `updatedAt` from that window. | Long fixture orders by true latest timestamp. |
| P1-13 | Droid edits | Droid edit/patch calls lose diffs and modified files. | Shared Anthropic extractor misses `old_str/new_str`, `ApplyPatch input.input`, and `morph___edit_file`. | Fixture covers all three forms and tracks files/diffs. |
| P1-14 | Copilot handoff | Recent Copilot handoffs can lose the actual conversation. | Parser slices raw event tail before filtering conversation events; tool/hook/shutdown events dominate tails. | Fixture with 20+ non-message tail events still includes last conversation. |
| P1-15 | Copilot writes | Native Copilot `create` calls are not classified as writes. | Lowercase `create` is absent from `WRITE_TOOLS`, so files are not tracked. | Fixture with `toolName: "create"` tracks the new file. |

## Implementation Order

1. Fix registry/resume validation first because these are user-facing command
   correctness bugs with low code churn.
2. Fix shared tool classification/extraction before parser-specific edit tests,
   so Droid/Copilot/Codex file tracking uses one canonical vocabulary where
   practical.
3. Fix parser-tail and timestamp bugs with focused fixtures for each tool.
4. Run parser regression tests, then the full project checks.

## Fix Status

Status after the 2026-04-27 fix pass:

- P1-01 through P1-04: fixed in registry/resume/cache handling.
- P1-05 through P1-07: fixed in Claude transcript trimming, Agent sidecar
  extraction, and transcript timestamp ordering.
- P1-08 through P1-10: fixed in Codex compaction parsing, namespaced edit
  classification, and `write_stdin.chars` summaries.
- P1-11 through P1-13: fixed in Droid root discovery/dedupe/recency scanning and
  shared Anthropic-style tool extraction.
- P1-14 through P1-15: fixed in Copilot full-event parsing before trimming and
  lowercase `create` write classification.

Primary files changed:

- `src/parsers/claude.ts`
- `src/parsers/codex.ts`
- `src/parsers/copilot.ts`
- `src/parsers/droid.ts`
- `src/parsers/registry.ts`
- `src/utils/resume.ts`
- `src/utils/tool-extraction.ts`
- `src/utils/jsonl.ts`
- `src/types/tool-names.ts`
- `src/types/schemas.ts`

## Verification Commands

If `node_modules` is missing, run `pnpm install` first. Then run:

```bash
pnpm test
pnpm run check
```

Do not run watch, real e2e, stress, or local-machine session tests unless a user
explicitly asks for them.

Known verification note: `pnpm test` passed after the fix pass. `pnpm run check`
may still fail in this repository on unrelated pre-existing Biome findings in
files such as `src/__tests__/e2e-conversions.test.ts`,
`src/__tests__/extract-handoffs.ts`, and `src/utils/tool-summarizer.ts`; confirm
whether those files are in scope before changing them.
