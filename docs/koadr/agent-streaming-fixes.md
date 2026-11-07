# Agent streaming fixes

Log of the failures hit while running Koadr against DeepSeek V4 on Cloudflare Workers,
and what was changed for each.

## 1. Every request failed with "The AI provider request failed"

**Symptom:** chat returned the generic provider error; no HTTP call reached DeepSeek.

**Cause:** `withAgentStreamDeadlines` / `withAgentToolCallRecovery` cloned the model
with `{ ...model, doStream }`. `provider` and `supportedUrls` are non-enumerable on
provider models, so the clone had `provider === undefined` and the SDK threw
`TypeError: Cannot read properties of undefined (reading 'split')` at
`streamLanguageModelCall` (`resolvedModel.provider.split('.')`).

**Fix:** `withStreamOverride()` rebuilds the model from explicit fields
([agent-stream.ts](../../app/lib/.server/llm/agent-stream.ts)).

## 2. `400 Thinking mode does not support this tool_choice`

**Symptom:** the provider rejected the request as soon as a plan step forced a tool.

**Cause:** the agent loop sends `toolChoice: 'required'` (or a named tool). DeepSeek V4
models run in thinking mode by default and refuse any forced `tool_choice`.

**Fix:** providers can declare `supportsToolChoice(model)`. The loop falls back to
`auto` (still narrowed through `activeTools`) for such models, and tool-call recovery
also runs under `auto` ([agent-loop.ts](../../app/lib/.server/llm/agent-loop.ts),
[deepseek.ts](../../app/lib/modules/llm/providers/deepseek.ts)).

## 3. `503 Worker exceeded resource limits` (10 ms CPU budget)

**Causes, all fixed:**

| Hot path | Fix |
|---|---|
| `processToolInvocations` rebuilt model messages for every tool part even with zero MCP servers | early return when no MCP tools are registered |
| Debug logs stringified the full system prompt and every tool JSON schema on each request | moved to `logger.debug` and reduced to key names/counts |
| `maxOutputTokens` requested DeepSeek's published 384k ceiling | `getCompletionTokenLimitHint()` caps the default at 32k |
| `PROVIDER_LIST` eagerly constructed all providers to look one up | resolve through `LLMManager.getInstance().getProvider()` |

After the changes, production requests sit at 85–610 ms CPU (previously 10–16 ms and
failing).

## 4. `Model tried to call unavailable tool 'project_write_file'. Available tools: agent_plan.`

**Symptom:** the build ran the plan step, then every later tool call failed; the model
could not edit files or run commands, so the session stalled.

**Cause:** `agent_plan` executes on the server, so the SDK reports no `toolResult` for
it. `prepareStep` rebuilt conversation history from `steps[].toolResults` only, never
saw a plan, and therefore re-narrowed `activeTools` to `['agent_plan']` on every
subsequent step.

**Fix:** when the SDK supplies no result for `agent_plan`, reconstruct its output from
the validated call input (`isAgentPlan`) so the loop advances and unlocks the project
tool set ([agent-loop.ts](../../app/lib/.server/llm/agent-loop.ts)).

## 5. Raw tool-call syntax printed instead of executed

**Symptom:** the assistant message (and the terminal panel) shows literal
`<||DSML|| invoke name="project_get_process_output">` blocks, and the turn appears to
end with "Command finished" while a command is still running.

**Cause:** the model serialised its tool calls as text in a provider-specific markup
(`<||DSML|| ...>`, `antml:invoke`, etc.) instead of using the native tool interface.
Recovery only understood JSON (`[{"name": ..., "parameters": ...}]`), so the markup was
rendered as message text and the loop lost the call.

**Recovery matches every delimiter variant:** ASCII `|`, full-width `｜` (U+FF5C),
heavy/double bars, `antml:`, and blocks written without a leading `<`.

**Fix:** the recovery layer parses this markup as a fallback, converting a well-formed
block naming an available tool into a real tool call, and strips the markup from the
visible answer.

### 5a. The same markup recovered, then hung the turn

**Symptom:** the terminal shows "Command is still running", the model prints a
`project_get_process_output` call as markup, and nothing else ever happens.

**Cause:** the recovered argument was corrupted. The parameter terminator matched only
the `<` of the closing tag, so
`25b02b92</｜｜DSML｜｜ parameter>` became `"25b02b92<"`. That failed the tool's input
schema, the identical call was retried on every attempt, and the turn never advanced.

**Fix:** the terminator now matches all four closing shapes
(`</x:parameter>`, `</｜｜DSML｜｜ parameter>`, `<｜｜DSML｜｜ parameter>`,
`｜｜DSML｜｜ parameter>`), and the stray `<` is dropped only when the close is
bar-delimited — a value that legitimately ends in `<` survives.
`agent-stream.spec.ts` and `provider-scenarios.spec.ts` cover each shape.

### 5b. A batch of printed calls lost every valid call

**Symptom:** the user sees the full `｜｜DSML｜｜ calls> …` block as chat text, even
though the patches inside it were perfectly valid.

**Cause:** recovery was all-or-nothing. If *any* block in the batch named a tool that
does not exist, the whole batch was rejected and the markup flushed to the UI. The same
happened when a reply contained more blocks than `MAX_RECOVERED_CALLS` (8).

**Fix:** each block is judged on its own — unknown names are skipped, the rest run, and
a short note says how many were skipped. An over-long reply keeps its first 8 calls
instead of being discarded whole. The JSON recovery path had the same flaw and is fixed
the same way ([agent-stream.ts](../../app/lib/.server/llm/agent-stream.ts)).

## 6. Invented tool names

**Symptom:** `Model tried to call unavailable tool 'project_read_command_output'`.

**Cause:** the name never existed (the real one is `project_get_process_output`). The
old error only said "use one of the supplied tools", which gave the model nothing to
correct towards, so it guessed again.

**Fix, three layers:**

1. `getToolCatalogue()` states the exact names offered on the request in an
   `<available_tools>` block ([agent-stream.ts](../../app/lib/.server/llm/agent-stream.ts)).
2. `TOOL_ALIASES` maps documented near-misses onto the real tool during recovery
   ([errors.ts](../../app/lib/.server/api/errors.ts)).
3. Unknown names still fail with a "did you mean …?" hint.

The closest-name fallback now requires a score of 4: at 2, an unrelated
`project_query_database` resolved to `project_get_process_output` and would have run
the wrong effect. `errors.spec.ts` asserts every alias target exists in
`PROJECT_TOOL_NAMES`.

## 7. Runs that stop with no error

**Symptom:** the build stops mid-task; nothing failed and nothing is reported.

**Cause (a):** the client's default step budget was 5 while `agent_plan` plus one
inspect → edit → run → test cycle exceeds it. `stopWhen` ends the stream silently.
The default is now 12, matching the server ceiling, and the settings field accepts the
same range.

**Cause (b):** a dev server that reports `running` without ever becoming ready has
nothing to fail, so the loop polled until the budget ran out. `PREVIEW_POLL_LIMIT` (4)
now ends the turn as `limited` with a stall-specific instruction
([agentLoop.ts](../../app/lib/common/agentLoop.ts)).

## 8. Failure messages that hid the cause

`Patch conflict:` used to print the 64-character revision and the whole file inline;
`Read the file first, then supply its revision as expectedRevision.` read like an
internal assertion. The chat now shows short headlines from
[toolActivity.ts](../../app/components/chat/toolActivity.ts)
("Found a bug: the file changed since the last read. Fixing…"), clamped to 140
characters. The tool output itself is unchanged — the model still receives the revision
and content it needs to repair the patch.

`Custom error:` alert titles become "Found a bug: …"; the status code, retryability and
the real description (billing, rate limit, network) are preserved.

## 9. Workspace rulebook

`.github/copilot-instructions.md` is inlined into every system prompt — build and
discuss — by `withProjectRules()`
([projectRules.ts](../../app/lib/common/prompts/projectRules.ts)). The server cannot
read `.github/`, so `app/lib/common/prompts/project-rules.md` is a bundled copy; keep
them identical with `pnpm rules:sync` and rebuild after editing. Attaching the
`.md` in the chat is no longer required.
