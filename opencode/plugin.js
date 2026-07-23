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

export const CORE_MODEL_ROLES = Object.freeze([
  "orchestrator",
  "reasoner",
  "extractor",
  "bulk-researcher",
  "bounded-editor",
  "small-model",
  "summary",
  "compaction",
  "title",
])

export const IMPLEMENTATION_DISPATCH = Object.freeze({
  implement_task: "implementer",
})

export const REVIEW_LANE_DISPATCH = Object.freeze({
  review_plan_drift: "review-plan-drift",
  review_quality: "review-quality",
  review_spec_compliance: "review-spec-compliance",
  review_blind_spots: "review-blind-spots",
})

export const IMPLEMENTATION_ROLES = Object.freeze(Object.values(IMPLEMENTATION_DISPATCH))
export const REVIEW_LANE_ROLES = Object.freeze(Object.values(REVIEW_LANE_DISPATCH))
export const OPTIONAL_MODEL_ROLES = Object.freeze([...IMPLEMENTATION_ROLES, ...REVIEW_LANE_ROLES])
export const MODEL_ROLES = Object.freeze([...CORE_MODEL_ROLES, ...OPTIONAL_MODEL_ROLES])

export const DEFAULT_MODEL_CONFIG = Object.freeze({
  schema_version: 1,
  profiles: {
    orchestration: { model: MODELS.orchestrator, reasoning_effort: "high" },
    reasoning: { model: MODELS.reasoner, reasoning_effort: "medium" },
    implementation: { model: MODELS.reasoner, reasoning_effort: "high" },
    extraction: { model: MODELS.extractor, reasoning_effort: "medium" },
    bulk: {
      model: MODELS.local,
      startup_check: true,
      fallback: { model: MODELS.extractor, reasoning_effort: "medium" },
    },
  },
  roles: {
    orchestrator: "orchestration",
    reasoner: "reasoning",
    implementer: "implementation",
    extractor: "extraction",
    "bulk-researcher": "bulk",
    "bounded-editor": "bulk",
    "small-model": "bulk",
    summary: "bulk",
    compaction: "bulk",
    title: "bulk",
    "review-plan-drift": "reasoning",
    "review-quality": "reasoning",
    "review-spec-compliance": "extraction",
    "review-blind-spots": "orchestration",
  },
})

export const WORKERS = Object.freeze([
  "reasoner",
  "extractor",
  "bulk-researcher",
  "bounded-editor",
  ...IMPLEMENTATION_ROLES,
  ...REVIEW_LANE_ROLES,
])

const OPTIONAL_ROLE_BASE_ROLES = Object.freeze({
  implementer: "reasoner",
  "review-plan-drift": "reasoner",
  "review-quality": "reasoner",
  "review-spec-compliance": "extractor",
  "review-blind-spots": "orchestrator",
})

const REVIEW_LANE_DESCRIPTIONS = Object.freeze({
  "review-plan-drift": "Reviews a diff against the active plan and prior execution record.",
  "review-quality": "Reviews a diff and code for correctness, safety, and maintainability without intent context.",
  "review-spec-compliance": "Reviews a diff against governing specifications and designs.",
  "review-blind-spots": "Adversarially reviews a diff for edge cases, production failures, security, and concurrency.",
})

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOCAL_HEALTH_TIMEOUT_MS = 1000
export const BULK_RESEARCHER_WEBFETCH_URL_LIMIT = 2
export const BULK_RESEARCHER_WEBFETCH_SESSION_LIMIT = 8
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"])
const DEFAULT_REMOTE_WORKERS = new Set(["reasoner", "implementer", "extractor"])
const READ_ONLY_SHELL_COMMANDS = Object.freeze([
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "wc",
  "basename",
  "dirname",
  "readlink",
  "realpath",
  "file",
  "stat",
  "cmp",
  "diff",
  "git diff",
  "git show",
  "git status",
  "git log",
  "git grep",
  "git ls-files",
  "git ls-tree",
  "git rev-parse",
])
const SCRIPT_EDIT_SHELL_PATTERNS = Object.freeze([
  "python*",
  "*/python*",
  "node*",
  "*/node*",
  "perl*",
  "*/perl*",
  "ruby*",
  "*/ruby*",
  "sed -i*",
  "*/sed -i*",
  "sed --in-place*",
  "*/sed --in-place*",
  "sh -c*",
  "*/sh -c*",
  "bash -c*",
  "*/bash -c*",
  "zsh -c*",
  "*/zsh -c*",
])
const SENSITIVE = [
  /(^|[\s/])\.env(?:\.|\s|$)/i,
  /(^|[\s/])(credentials?|secrets?)(?:[\s/.:]|$)/i,
  /(^|[\s/])(?:id_rsa|id_ed25519|private[-_ ]?key)(?:[\s/.:]|$)/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
]

const ROUTING_POLICY = `
OpenCode model routing policy:
- The primary orchestrator owns plans, test strategy, decisions, approvals, verification judgments, and final synthesis.
- Delegate semantic analysis of large files, diffs, failures, and architecture to @reasoner.
- Delegate structured extraction, grep-result synthesis, comparison, and aggregation to @extractor.
- Delegate broad file or web collection and first-pass summaries to @bulk-researcher.
- Delegate one approved semantic code implementation task, including its specified verification, to @implementer.
- Delegate only explicit, bounded edits with named files and verification to @bounded-editor.
- Use deterministic tools directly when they answer the question without model judgment.
- Treat worker output as evidence to validate, not proof. Escalate uncertain worker results rather than inventing certainty.
`.trim()

async function prompt(name) {
  return readFile(join(ROOT, "agents", `${name}.md`), "utf8")
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function rejectUnknown(value, allowed, context) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${context} has unknown field(s): ${unknown.join(", ")}`)
}

function validateProfile(profile, context, fallback = false) {
  if (!object(profile)) throw new Error(`${context} must be an object`)
  rejectUnknown(
    profile,
    fallback
      ? ["model", "reasoning_effort", "variant"]
      : ["model", "reasoning_effort", "variant", "startup_check", "fallback"],
    context,
  )
  if (typeof profile.model !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(profile.model)) {
    throw new Error(`${context}.model must use provider/model format`)
  }
  if (profile.reasoning_effort !== undefined && !REASONING_EFFORTS.has(profile.reasoning_effort)) {
    throw new Error(`${context}.reasoning_effort is invalid`)
  }
  if (profile.variant !== undefined && (typeof profile.variant !== "string" || !profile.variant)) {
    throw new Error(`${context}.variant must be a non-empty string`)
  }
  if (profile.reasoning_effort !== undefined && profile.variant !== undefined) {
    throw new Error(`${context} cannot set both reasoning_effort and variant`)
  }
  if (!fallback && profile.startup_check !== undefined && typeof profile.startup_check !== "boolean") {
    throw new Error(`${context}.startup_check must be boolean`)
  }
  if (!fallback && profile.fallback !== undefined) {
    validateProfile(profile.fallback, `${context}.fallback`, true)
  }
  if (!fallback && profile.startup_check === true && profile.fallback === undefined) {
    throw new Error(`${context} enables startup_check without a fallback`)
  }
}

export function validateModelConfig(value) {
  if (!object(value)) throw new Error("model configuration must be an object")
  rejectUnknown(value, ["schema_version", "profiles", "roles"], "model configuration")
  if (value.schema_version !== 1) throw new Error("unsupported schema_version")
  if (!object(value.profiles) || Object.keys(value.profiles).length === 0) {
    throw new Error("profiles must be a non-empty object")
  }
  for (const [name, profile] of Object.entries(value.profiles)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid profile name: ${name}`)
    validateProfile(profile, `profiles.${name}`)
  }
  if (!object(value.roles)) throw new Error("roles must be an object")
  rejectUnknown(value.roles, MODEL_ROLES, "roles")
  for (const role of CORE_MODEL_ROLES) {
    const profile = value.roles[role]
    if (typeof profile !== "string" || !profile) throw new Error(`roles.${role} is required`)
    if (!Object.hasOwn(value.profiles, profile)) {
      throw new Error(`roles.${role} references missing profile ${profile}`)
    }
  }
  for (const role of OPTIONAL_MODEL_ROLES) {
    if (!Object.hasOwn(value.roles, role)) continue
    const profile = value.roles[role]
    if (typeof profile !== "string" || !profile) throw new Error(`roles.${role} must name a profile`)
    if (!Object.hasOwn(value.profiles, profile)) {
      throw new Error(`roles.${role} references missing profile ${profile}`)
    }
  }
  return value
}

export async function loadModelConfig(worktree, options = {}) {
  if (typeof options === "function") options = { readFileImpl: options }
  const { home = homedir(), readFileImpl = readFile } = options
  const candidates = [
    join(worktree, ".agents", "models.json"),
    join(home, ".agents", "models.json"),
  ].filter((path, index, paths) => paths.indexOf(path) === index)
  const warnings = []

  for (const path of candidates) {
    try {
      const value = JSON.parse(await readFileImpl(path, "utf8"))
      return {
        config: validateModelConfig(value),
        source: path,
        ...(warnings.length ? { warning: warnings.join("; ") } : {}),
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue
      warnings.push(`Ignored invalid ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    config: DEFAULT_MODEL_CONFIG,
    source: "bundled",
    ...(warnings.length ? { warning: warnings.join("; ") } : {}),
  }
}

export async function profileAvailable(config, profile, fetchImpl = globalThis.fetch) {
  if (profile.startup_check !== true) return true
  const separator = profile.model.indexOf("/")
  const providerID = profile.model.slice(0, separator)
  const modelID = profile.model.slice(separator + 1)
  const provider = config.provider?.[providerID]
  const baseURL = provider?.options?.baseURL
  const expected = provider?.models?.[modelID]?.id ?? modelID
  if (typeof baseURL !== "string" || typeof expected !== "string" || typeof fetchImpl !== "function") {
    return false
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LOCAL_HEALTH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${baseURL.replace(/\/$/, "")}/models`, {
      signal: controller.signal,
    })
    if (!response.ok) return false
    const body = await response.json()
    const ids = [
      ...(Array.isArray(body?.data) ? body.data.map((model) => model?.id) : []),
      ...(Array.isArray(body?.models)
        ? body.models.flatMap((model) => [model?.id, model?.model, model?.name])
        : []),
    ]
    return ids.includes(expected)
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function profileFields(profile) {
  return {
    model: profile.model,
    ...(profile.reasoning_effort ? { options: { reasoningEffort: profile.reasoning_effort } } : {}),
    ...(profile.variant ? { variant: profile.variant } : {}),
  }
}

function inspectionShellPermissions(defaultAction) {
  return {
    "*": defaultAction,
    ...Object.fromEntries(
      READ_ONLY_SHELL_COMMANDS.flatMap((command) => [
        [command, "allow"],
        [`${command} *`, "allow"],
      ]),
    ),
  }
}

function readOnlyShellPermissions() {
  return inspectionShellPermissions("deny")
}

function boundedEditorShellPermissions() {
  return {
    ...inspectionShellPermissions("ask"),
    ...Object.fromEntries(SCRIPT_EDIT_SHELL_PATTERNS.map((pattern) => [pattern, "deny"])),
  }
}

function implementerShellPermissions() {
  return inspectionShellPermissions("ask")
}

function localModel(config, model) {
  const providerID = model.slice(0, model.indexOf("/"))
  const baseURL = config.provider?.[providerID]?.options?.baseURL
  if (typeof baseURL !== "string") return false
  try {
    const hostname = new URL(baseURL).hostname
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  } catch {
    return false
  }
}

function hookSessionID(input) {
  const sessionID = input?.sessionID ?? input?.sessionId ?? input?.session?.id
  return typeof sessionID === "string" && sessionID ? sessionID : undefined
}

function hookAgent(input, output) {
  const agent = input?.agent ?? input?.params?.agent ?? output?.agent ?? output?.params?.agent
  return typeof agent === "string" ? agent : undefined
}

function webfetchFingerprint(url) {
  if (typeof url !== "string") return `invalid:${typeof url}:${String(url)}`
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `invalid:string:${url}`
    }
    parsed.hash = ""
    return parsed.toString()
  } catch {
    return `invalid:string:${url}`
  }
}

export async function applyRoutingConfig(
  config,
  modelConfig = DEFAULT_MODEL_CONFIG,
  availability = profileAvailable,
) {
  const prompts = Object.fromEntries(
    await Promise.all(
      ["orchestrator", "reasoner", "extractor", "bulk-researcher", "bounded-editor", "implementer", "reviewer"].map(
        async (name) => [name, await prompt(name)],
      ),
    ),
  )
  const profiles = Object.create(null)
  for (const [name, profile] of Object.entries(modelConfig.profiles)) {
    profiles[name] = (await availability(config, profile)) ? profile : profile.fallback
  }
  const role = (name) => {
    const profile = modelConfig.roles[name] ?? modelConfig.roles[OPTIONAL_ROLE_BASE_ROLES[name]]
    return profiles[profile]
  }

  config.model = role("orchestrator").model
  config.small_model = role("small-model").model
  config.default_agent = "orchestrator"
  config.agent ??= {}

  Object.assign(config.agent, {
    orchestrator: {
      description: "Plans, tests, decides, verifies, and orchestrates model-tier workers.",
      mode: "primary",
      ...profileFields(role("orchestrator")),
      prompt: prompts.orchestrator,
      permission: {
        task: {
          "*": "deny",
          ...Object.fromEntries(WORKERS.map((worker) => [worker, "allow"])),
        },
      },
    },
    reasoner: {
      description: "Analyzes large inputs, diffs, failures, architecture, and subtle semantic interactions.",
      mode: "subagent",
      ...profileFields(role("reasoner")),
      prompt: prompts.reasoner,
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: readOnlyShellPermissions(),
      },
    },
    extractor: {
      description: "Extracts, searches, compares, and aggregates structured facts without making decisions.",
      mode: "subagent",
      ...profileFields(role("extractor")),
      prompt: prompts.extractor,
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: readOnlyShellPermissions(),
      },
    },
    "bulk-researcher": {
      description: "Collects broad local or web evidence and returns concise source-linked summaries.",
      mode: "subagent",
      steps: 12,
      ...profileFields(role("bulk-researcher")),
      prompt: prompts["bulk-researcher"],
      permission: {
        "*": "deny",
        doom_loop: "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        webfetch: "allow",
        websearch: "allow",
        bash: readOnlyShellPermissions(),
      },
    },
    "bounded-editor": {
      description: "Makes simple edits limited to named files and runs explicitly requested verification.",
      mode: "subagent",
      ...profileFields(role("bounded-editor")),
      prompt: prompts["bounded-editor"],
      permission: {
        "*": "deny",
        read: "allow",
        edit: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: boundedEditorShellPermissions(),
      },
    },
    implementer: {
      description: "Implements one approved semantic code task and its specified verification without owning scope decisions.",
      mode: "subagent",
      ...profileFields(role("implementer")),
      prompt: prompts.implementer,
      permission: {
        "*": "deny",
        read: "allow",
        edit: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: implementerShellPermissions(),
      },
    },
    summary: profileFields(role("summary")),
    compaction: profileFields(role("compaction")),
    title: profileFields(role("title")),
  })
  for (const worker of REVIEW_LANE_ROLES) {
    config.agent[worker] = {
      description: REVIEW_LANE_DESCRIPTIONS[worker],
      mode: "subagent",
      ...profileFields(role(worker)),
      prompt: prompts.reviewer,
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: readOnlyShellPermissions(),
      },
    }
  }
  return {
    remoteWorkers: new Set(WORKERS.filter((worker) => !localModel(config, role(worker).model))),
  }
}

export function routeTask(args) {
  const worker = IMPLEMENTATION_DISPATCH[args?.description] ?? REVIEW_LANE_DISPATCH[args?.description]
  if (worker) args.subagent_type = worker
  return worker
}

export function validateTask(args, env = process.env, remoteWorkers = DEFAULT_REMOTE_WORKERS) {
  const worker = args?.subagent_type
  const configured = WORKERS.includes(worker)
  if (!configured && env.OPENCODE_MODEL_ROUTER_ALLOW_UNROUTED !== "1") {
    throw new Error(
      `OpenCode Model Router blocked unconfigured subagent ${JSON.stringify(worker)}; use one of: ${WORKERS.join(", ")}`,
    )
  }

  const text = typeof args.prompt === "string" ? args.prompt : ""
  if ((!configured || remoteWorkers.has(worker)) && SENSITIVE.some((pattern) => pattern.test(text))) {
    throw new Error(
      `OpenCode Model Router blocked sensitive-looking material from remote worker ${worker}; use a local worker or remove the sensitive input`,
    )
  }
}

export function hasResultFooter(output) {
  return /<frugal_result\s+role="[^"]+"\s+status="(?:complete|blocked|uncertain)"\s*\/>/.test(output)
}

function metricsPath(env = process.env) {
  const root = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(root, "opencode-model-router", "metrics.jsonl")
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

export function hooksForModels(models) {
  let remoteWorkers = new Set(WORKERS)
  const sessionAgents = new Map()
  const webfetchCircuits = new Map()
  const rememberSessionAgent = (input, output) => {
    const sessionID = hookSessionID(input)
    const agent = hookAgent(input, output)
    if (sessionID && agent) sessionAgents.set(sessionID, agent)
  }
  const clearSession = (sessionID) => {
    if (typeof sessionID !== "string" || !sessionID) return
    sessionAgents.delete(sessionID)
    webfetchCircuits.delete(sessionID)
  }
  const enforceBulkResearchWebfetchLimit = (input, output) => {
    const sessionID = hookSessionID(input)
    if (!sessionID || sessionAgents.get(sessionID) !== "bulk-researcher") return
    const fingerprint = webfetchFingerprint(output?.args?.url)
    const circuit =
      webfetchCircuits.get(sessionID) ?? { total: 0, urls: new Map(), failed: new Set(), calls: new Map() }
    const urlCalls = circuit.urls.get(fingerprint) ?? 0
    if (circuit.failed.has(fingerprint)) {
      throw new Error(
        "OpenCode Model Router blocked bulk-researcher webfetch: the previous request for this canonical URL failed. Use websearch or another source and return a partial result with a blocked or uncertain footer.",
      )
    }
    if (urlCalls >= BULK_RESEARCHER_WEBFETCH_URL_LIMIT) {
      throw new Error(
        "OpenCode Model Router blocked bulk-researcher webfetch: this canonical URL has reached its limit. Use websearch or another source and return a partial result with a blocked or uncertain footer.",
      )
    }
    if (circuit.total >= BULK_RESEARCHER_WEBFETCH_SESSION_LIMIT) {
      throw new Error(
        "OpenCode Model Router blocked bulk-researcher webfetch: this session has reached its limit. Use websearch or another source and return a partial result with a blocked or uncertain footer.",
      )
    }
    circuit.total += 1
    circuit.urls.set(fingerprint, urlCalls + 1)
    if (typeof input.callID === "string" && input.callID) circuit.calls.set(input.callID, fingerprint)
    webfetchCircuits.set(sessionID, circuit)
  }
  const recordBulkResearchWebfetchFailure = (part) => {
    if (part?.type !== "tool" || part.tool !== "webfetch" || part.state?.status !== "error") return
    const circuit = webfetchCircuits.get(part.sessionID)
    if (!circuit) return
    const fingerprint = circuit.calls.get(part.callID) ?? webfetchFingerprint(part.state.input?.url)
    circuit.calls.delete(part.callID)
    circuit.failed.add(fingerprint)
  }
  const completeBulkResearchWebfetch = (input) => {
    const sessionID = hookSessionID(input)
    if (!sessionID || sessionAgents.get(sessionID) !== "bulk-researcher") return
    webfetchCircuits.get(sessionID)?.calls.delete(input.callID)
  }
  return {
    event: async ({ event }) => {
      if (event.type === "message.part.updated") recordBulkResearchWebfetchFailure(event.properties.part)
      if (event.type === "session.idle") clearSession(event.properties.sessionID)
      if (event.type === "session.deleted") clearSession(event.properties.info.id)
      if (event.type === "session.error") clearSession(event.properties.sessionID)
    },
    config: async (config) => {
      const resolved = await applyRoutingConfig(config, models.config)
      remoteWorkers = resolved.remoteWorkers
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(ROUTING_POLICY)
      if (models.warning) output.system.push(`OpenCode Model Router configuration warning: ${models.warning}`)
    },
    "tool.definition": async (input, output) => {
      if (input.toolID !== "task") return
      output.description = `${output.description}\n\n${ROUTING_POLICY}`
    },
    "chat.message": async (input, output) => {
      rememberSessionAgent(input, output)
    },
    "chat.params": async (input, output) => {
      rememberSessionAgent(input, output)
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool === "webfetch") {
        enforceBulkResearchWebfetchLimit(input, output)
        return
      }
      if (input.tool !== "task") return
      routeTask(output.args)
      validateTask(output.args, process.env, remoteWorkers)
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool === "webfetch") {
        completeBulkResearchWebfetch(input)
        return
      }
      if (input.tool !== "task") return
      const valid = hasResultFooter(typeof output.output === "string" ? output.output : "")
      if (!valid) {
        output.output = `${output.output}\n\n[OpenCode Model Router: worker omitted its result contract; validate the result before relying on it.]`
      }
      await recordMetric(input, output).catch(() => {})
    },
  }
}

export default async function opencodeModelRouter(input) {
  return hooksForModels(await loadModelConfig(input.worktree))
}
