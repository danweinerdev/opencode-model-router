# opencode-frugal

Model-tier routing and guardrails for OpenCode.

## Roles

The table below is the bundled default. Valid project or home profiles can
replace these model assignments without changing agent permissions or prompts.

| Agent | Model | Role |
| --- | --- | --- |
| `orchestrator` | `openai/gpt-5.6-sol` | Planning, testing, decisions, and final synthesis |
| `reasoner` | `openai/gpt-5.6-terra` | Semantic analysis of files, diffs, failures, and architecture |
| `extractor` | `openai/gpt-5.6-luna-fast` | Search, extraction, comparison, and aggregation |
| `bulk-researcher` | `llama.cpp/qwen3-coder-next-q4` | Broad local and web collection with first-pass summaries |
| `bounded-editor` | `llama.cpp/qwen3-coder-next-q4` | Explicit, bounded edits and verification |

OpenAI reasoning effort defaults are `high` for the orchestrator and `medium`
for both the reasoner and extractor. The local Qwen agents intentionally set no
provider reasoning options; llama-server owns their inference tuning.

At startup, the plugin requests the configured llama-server `/models` endpoint
and requires it to advertise `qwen3-coder-next`. If the endpoint is unavailable
or the model is absent, both Qwen roles and OpenCode's small/hidden agents use
Luna Fast with medium reasoning effort for that OpenCode process. Availability
is checked only at startup; restart OpenCode to re-evaluate it.

The research and editing roles are separate capability boundaries even though
they use the same local model. External content never reaches an edit-capable
agent through this plugin.

### SDD code-review lanes

The `sdd-code-review` skill emits four stable runtime-neutral dispatch
identifiers. OpenCode Frugal rewrites those task descriptions to fresh-context,
read-only lane agents:

| Dispatch identifier | Agent role | Bundled/GPT profile |
| --- | --- | --- |
| `review_plan_drift` | `review-plan-drift` | `reasoning` |
| `review_quality` | `review-quality` | `reasoning` |
| `review_spec_compliance` | `review-spec-compliance` | `extraction` |
| `review_blind_spots` | `review-blind-spots` | `orchestration` |

The Claude example maps the blind-spots lane to its `opus-4-8` profile while
Fable 5 remains the primary orchestrator. Lane routing is deterministic: a
recognized dispatch identifier replaces the caller's requested subagent type
before permission and sensitive-data checks run.

Lane input isolation is cooperative, matching SDD Planner's contract; it is not
a filesystem sandbox. Agent permissions prevent edits and most shell commands,
while the supplied lane prompt defines which planning, specification, and code
inputs the reviewer may consult.

## Installation

This repository is designed for the declarative plugin reconciler in
`danweinerdev/opencode-env`. It does not ship or execute an installer. Add it as
a registered submodule under `$HOME/.agents/plugins/`, then run:

```sh
"$HOME/.agents/refresh.sh"
```

Restart OpenCode after activation. OpenCode loads configuration and plugins
only at startup.

## Model profiles

Model routing can be configured globally or per checkout. Start a global
GPT+Qwen profile with:

```sh
cp "$HOME/.agents/plugins/opencode-frugal/examples/gpt-based.json.example" \
  "$HOME/.agents/models.json"
```

Use `claude-based.json.example` for the Anthropic-oriented profile. The
`opencode-env` repository ignores its global `models.json`, so machine-specific
model choices are not committed.

Each checkout can override only model selection through its own file:

```text
$WORKTREE/.agents/models.json
```

Copy `examples/gpt-based.json.example` or
`examples/claude-based.json.example` as a starting point. The document defines
named profiles and maps every core runtime role to one profile. Review-lane
roles are optional for backward compatibility; omitted lanes inherit the
`reasoner`, `extractor`, or `orchestrator` role documented above. Additional
profiles may be retained as alternatives and selected by changing `roles`;
unknown fields, missing core roles, dangling profile names, and invalid model
identifiers invalidate the complete override.

Checkout-local files should also be ignored locally or by the project. The
plugin reads them but does not modify repository ignore policy.

Profiles accept `model` plus either `reasoning_effort` or `variant`, never both.
Supported reasoning-effort values are `none`, `minimal`, `low`, `medium`,
`high`, and `xhigh`. A profile can enable `startup_check` when it also supplies
a complete `fallback`. Provider endpoints and credentials remain in trusted
OpenCode configuration and cannot be overridden by this file.

Use `reasoning_effort` for OpenAI profiles and `variant` for Anthropic profiles.
OpenCode's Claude variants map to native Anthropic effort plus adaptive thinking:
Fable 5, Opus 4.7+, and Sonnet 5 support `low`, `medium`, `high`, `xhigh`, and
`max`; Opus/Sonnet 4.6 omit `xhigh`. Haiku 4.5 has no native effort control, so
the Claude example leaves its extraction and bulk profiles unset.

Resolution uses the first valid complete document in this order:

```text
$WORKTREE/.agents/models.json
$HOME/.agents/models.json
bundled defaults
```

Files are not merged. Missing files fall through silently; invalid files are
ignored atomically, reported as orchestrator system warnings, and resolution
continues at the next level. Restart OpenCode after changing either file.

## Controls

- Only configured general workers and code-review lane workers may be launched
  through `task`.
- Remote workers reject task prompts containing obvious secret-bearing paths
  or private-key material. This is a guardrail, not content classification.
- Worker responses must include the `<frugal_result ...>` footer documented in
  their prompts. Missing footers are surfaced to the orchestrator.
- Task metadata is appended to
  `${XDG_DATA_HOME:-~/.local/share}/opencode-frugal/metrics.jsonl`; prompts and
  response bodies are not recorded.

Set `OPENCODE_FRUGAL_ALLOW_UNROUTED=1` before starting OpenCode to bypass the
task-agent allowlist for recovery.
