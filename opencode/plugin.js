import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const MODELS = Object.freeze({
  orchestrator: "openai/gpt-5.6-sol",
  reasoner: "openai/gpt-5.6-terra",
  extractor: "openai/gpt-5.6-luna-fast",
  local: "llama.cpp/qwen3-coder-next-q4",
})

export const WORKERS = Object.freeze([
  "reasoner",
  "extractor",
  "bulk-researcher",
  "bounded-editor",
])

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REMOTE_WORKERS = new Set(["reasoner", "extractor"])
const SENSITIVE = [
  /(^|[\s/])\.env(?:\.|\s|$)/i,
  /(^|[\s/])(credentials?|secrets?)(?:[\s/.:]|$)/i,
  /(^|[\s/])(?:id_rsa|id_ed25519|private[-_ ]?key)(?:[\s/.:]|$)/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
]

const ROUTING_POLICY = `
OpenCode Frugal routing policy:
- The primary orchestrator owns plans, test strategy, decisions, approvals, verification judgments, and final synthesis.
- Delegate semantic analysis of large files, diffs, failures, and architecture to @reasoner.
- Delegate structured extraction, grep-result synthesis, comparison, and aggregation to @extractor.
- Delegate broad file or web collection and first-pass summaries to @bulk-researcher.
- Delegate only explicit, bounded edits with named files and verification to @bounded-editor.
- Use deterministic tools directly when they answer the question without model judgment.
- Treat worker output as evidence to validate, not proof. Escalate uncertain worker results rather than inventing certainty.
`.trim()

async function prompt(name) {
  return readFile(join(ROOT, "agents", `${name}.md`), "utf8")
}

export async function applyRoutingConfig(config) {
  const prompts = Object.fromEntries(
    await Promise.all(
      ["orchestrator", ...WORKERS].map(async (name) => [name, await prompt(name)]),
    ),
  )

  config.model = MODELS.orchestrator
  config.small_model = MODELS.local
  config.default_agent = "orchestrator"
  config.agent ??= {}

  Object.assign(config.agent, {
    orchestrator: {
      description: "Plans, tests, decides, verifies, and orchestrates model-tier workers.",
      mode: "primary",
      model: MODELS.orchestrator,
      options: { reasoningEffort: "high" },
      prompt: prompts.orchestrator,
      permission: {
        task: {
          "*": "deny",
          reasoner: "allow",
          extractor: "allow",
          "bulk-researcher": "allow",
          "bounded-editor": "allow",
        },
      },
    },
    reasoner: {
      description: "Analyzes large inputs, diffs, failures, architecture, and subtle semantic interactions.",
      mode: "subagent",
      model: MODELS.reasoner,
      options: { reasoningEffort: "medium" },
      prompt: prompts.reasoner,
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: {
          "*": "deny",
          "git diff*": "allow",
          "git show*": "allow",
          "git status*": "allow",
        },
      },
    },
    extractor: {
      description: "Extracts, searches, compares, and aggregates structured facts without making decisions.",
      mode: "subagent",
      model: MODELS.extractor,
      options: { reasoningEffort: "medium" },
      prompt: prompts.extractor,
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
      },
    },
    "bulk-researcher": {
      description: "Collects broad local or web evidence and returns concise source-linked summaries.",
      mode: "subagent",
      model: MODELS.local,
      prompt: prompts["bulk-researcher"],
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        webfetch: "allow",
        websearch: "allow",
      },
    },
    "bounded-editor": {
      description: "Makes simple edits limited to named files and runs explicitly requested verification.",
      mode: "subagent",
      model: MODELS.local,
      prompt: prompts["bounded-editor"],
      permission: {
        "*": "deny",
        read: "allow",
        edit: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: "ask",
      },
    },
    summary: { model: MODELS.local },
    compaction: { model: MODELS.local },
    title: { model: MODELS.local },
  })
}

export function validateTask(args, env = process.env) {
  if (env.OPENCODE_FRUGAL_ALLOW_UNROUTED === "1") return

  const worker = args?.subagent_type
  if (!WORKERS.includes(worker)) {
    throw new Error(
      `OpenCode Frugal blocked unconfigured subagent ${JSON.stringify(worker)}; use one of: ${WORKERS.join(", ")}`,
    )
  }

  const text = typeof args.prompt === "string" ? args.prompt : ""
  if (REMOTE_WORKERS.has(worker) && SENSITIVE.some((pattern) => pattern.test(text))) {
    throw new Error(
      `OpenCode Frugal blocked sensitive-looking material from remote worker ${worker}; use a local worker or remove the sensitive input`,
    )
  }
}

export function hasResultFooter(output) {
  return /<frugal_result\s+role="[^"]+"\s+status="(?:complete|blocked|uncertain)"\s*\/>/.test(output)
}

function metricsPath(env = process.env) {
  const root = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(root, "opencode-frugal", "metrics.jsonl")
}

async function recordMetric(input, output) {
  const path = metricsPath()
  const text = typeof output.output === "string" ? output.output : ""
  const record = {
    timestamp: new Date().toISOString(),
    session_id: input.sessionID,
    worker: input.args?.subagent_type ?? null,
    output_chars: text.length,
    contract_valid: hasResultFooter(text),
    model: output.metadata?.model ?? null,
  }
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

export default async function opencodeFrugal() {
  return {
    config: applyRoutingConfig,
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(ROUTING_POLICY)
    },
    "tool.definition": async (input, output) => {
      if (input.toolID !== "task") return
      output.description = `${output.description}\n\n${ROUTING_POLICY}`
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return
      validateTask(output.args)
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return
      const valid = hasResultFooter(typeof output.output === "string" ? output.output : "")
      if (!valid) {
        output.output = `${output.output}\n\n[OpenCode Frugal: worker omitted its result contract; validate the result before relying on it.]`
      }
      await recordMetric(input, output).catch(() => {})
    },
  }
}
