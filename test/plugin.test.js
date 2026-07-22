import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  DEFAULT_MODEL_CONFIG,
  MODELS,
  WORKERS,
  applyRoutingConfig,
  hasResultFooter,
  loadModelConfig,
  profileAvailable,
  validateModelConfig,
  validateTask,
} from "../opencode/plugin.js"

test("configures exact models and default orchestrator", async () => {
  const config = { provider: { local: {} } }
  await applyRoutingConfig(config, DEFAULT_MODEL_CONFIG, async () => true)

  assert.equal(config.model, MODELS.orchestrator)
  assert.equal(config.small_model, MODELS.local)
  assert.equal(config.default_agent, "orchestrator")
  assert.equal(config.agent.reasoner.model, MODELS.reasoner)
  assert.equal(config.agent.extractor.model, MODELS.extractor)
  assert.equal(config.agent.orchestrator.options.reasoningEffort, "high")
  assert.equal(config.agent.reasoner.options.reasoningEffort, "medium")
  assert.equal(config.agent.extractor.options.reasoningEffort, "medium")
  assert.equal(config.agent["bulk-researcher"].model, MODELS.local)
  assert.equal(config.agent["bounded-editor"].model, MODELS.local)
  assert.equal(config.agent["bulk-researcher"].options, undefined)
  assert.equal(config.agent["bounded-editor"].options, undefined)
  assert.deepEqual(config.provider, { local: {} })
})

test("orchestrator can launch only configured workers", async () => {
  const config = {}
  await applyRoutingConfig(config, DEFAULT_MODEL_CONFIG, async () => true)
  const rules = config.agent.orchestrator.permission.task

  assert.equal(rules["*"], "deny")
  for (const worker of WORKERS) assert.equal(rules[worker], "allow")
})

test("detects the expected local model", async () => {
  const config = {
    provider: {
      "llama.cpp": {
        options: { baseURL: "http://127.0.0.1:8080/v1/" },
        models: { "qwen3-coder-next-q4": { id: "qwen3-coder-next" } },
      },
    },
  }
  const fetchImpl = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8080/v1/models")
    assert.ok(options.signal)
    return {
      ok: true,
      json: async () => ({ data: [{ id: "qwen3-coder-next" }] }),
    }
  }
  assert.equal(await profileAvailable(config, DEFAULT_MODEL_CONFIG.profiles.bulk, fetchImpl), true)
})

test("treats unavailable or unexpected local models as unhealthy", async () => {
  const config = {
    provider: {
      "llama.cpp": {
        options: { baseURL: "http://127.0.0.1:8080/v1" },
        models: { "qwen3-coder-next-q4": { id: "qwen3-coder-next" } },
      },
    },
  }
  assert.equal(
    await profileAvailable(config, DEFAULT_MODEL_CONFIG.profiles.bulk, async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "another-model" }] }),
    })),
    false,
  )
  assert.equal(
    await profileAvailable(config, DEFAULT_MODEL_CONFIG.profiles.bulk, async () => {
      throw new Error("connection refused")
    }),
    false,
  )
})

test("falls back Qwen roles and hidden agents to Luna medium", async () => {
  const config = {}
  await applyRoutingConfig(
    config,
    DEFAULT_MODEL_CONFIG,
    async (_config, profile) => profile.startup_check !== true,
  )

  assert.equal(config.small_model, MODELS.extractor)
  for (const name of ["bulk-researcher", "bounded-editor", "summary", "compaction", "title"]) {
    assert.equal(config.agent[name].model, MODELS.extractor)
    assert.equal(config.agent[name].options.reasoningEffort, "medium")
  }
})

test("applies a complete project model configuration", async () => {
  const project = structuredClone(DEFAULT_MODEL_CONFIG)
  project.profiles.orchestration = {
    model: "anthropic/claude-fable-5",
    variant: "high",
  }
  project.profiles.reasoning = { model: "anthropic/claude-sonnet-4-6" }
  project.profiles.extraction = { model: "anthropic/claude-haiku-4-5" }
  project.profiles.bulk = { model: "anthropic/claude-haiku-4-5" }
  validateModelConfig(project)

  const config = {}
  await applyRoutingConfig(config, project)
  assert.equal(config.model, "anthropic/claude-fable-5")
  assert.equal(config.agent.orchestrator.variant, "high")
  assert.equal(config.agent.reasoner.model, "anthropic/claude-sonnet-4-6")
  assert.equal(config.agent.extractor.model, "anthropic/claude-haiku-4-5")
  assert.equal(config.agent["bulk-researcher"].model, "anthropic/claude-haiku-4-5")
})

test("rejects incomplete, dangling, and ambiguous model configuration", () => {
  const missingRole = structuredClone(DEFAULT_MODEL_CONFIG)
  delete missingRole.roles.title
  assert.throws(() => validateModelConfig(missingRole), /roles.title is required/)

  const dangling = structuredClone(DEFAULT_MODEL_CONFIG)
  dangling.roles.reasoner = "missing"
  assert.throws(() => validateModelConfig(dangling), /references missing profile/)

  const inherited = structuredClone(DEFAULT_MODEL_CONFIG)
  inherited.roles.reasoner = "toString"
  assert.throws(() => validateModelConfig(inherited), /references missing profile/)

  const ambiguous = structuredClone(DEFAULT_MODEL_CONFIG)
  ambiguous.profiles.reasoning.variant = "high"
  assert.throws(() => validateModelConfig(ambiguous), /cannot set both/)
})

test("keeps sensitive material off workers resolved to remote models", async () => {
  const config = {}
  const resolved = await applyRoutingConfig(
    config,
    DEFAULT_MODEL_CONFIG,
    async (_config, profile) => profile.startup_check !== true,
  )
  assert.equal(resolved.remoteWorkers.has("bulk-researcher"), true)
  assert.equal(resolved.remoteWorkers.has("bounded-editor"), true)
  assert.throws(
    () =>
      validateTask(
        { subagent_type: "bounded-editor", prompt: "read .env.production" },
        {},
        resolved.remoteWorkers,
      ),
    /sensitive-looking material/,
  )
})

test("keeps local workers inside the local sensitive-data boundary", async () => {
  const config = {
    provider: {
      "llama.cpp": {
        options: { baseURL: "http://127.0.0.1:8080/v1" },
      },
    },
  }
  const resolved = await applyRoutingConfig(config, DEFAULT_MODEL_CONFIG, async () => true)
  assert.equal(resolved.remoteWorkers.has("bulk-researcher"), false)
  assert.equal(resolved.remoteWorkers.has("bounded-editor"), false)
})

test("checked-in examples conform to the project model schema", async () => {
  for (const path of ["examples/gpt-based.json.example", "examples/claude-based.json.example"]) {
    validateModelConfig(JSON.parse(await readFile(path, "utf8")))
  }
})

test("loads project configuration and falls back atomically when invalid", async () => {
  const project = structuredClone(DEFAULT_MODEL_CONFIG)
  project.profiles.extraction.reasoning_effort = "low"
  const loaded = await loadModelConfig("/checkout", async (path) => {
    assert.equal(path, "/checkout/.agents/models.json")
    return JSON.stringify(project)
  })
  assert.equal(loaded.config.profiles.extraction.reasoning_effort, "low")
  assert.equal(loaded.source, "/checkout/.agents/models.json")

  const invalid = await loadModelConfig("/checkout", async () => "{}")
  assert.equal(invalid.config, DEFAULT_MODEL_CONFIG)
  assert.match(invalid.warning, /unsupported schema_version/)
})

test("task guard blocks unknown workers", () => {
  assert.throws(
    () => validateTask({ subagent_type: "general", prompt: "work" }, {}),
    /blocked unconfigured subagent/,
  )
})

test("task guard supports explicit recovery bypass", () => {
  assert.doesNotThrow(() =>
    validateTask(
      { subagent_type: "general", prompt: "work" },
      { OPENCODE_FRUGAL_ALLOW_UNROUTED: "1" },
    ),
  )
  assert.throws(
    () =>
      validateTask(
        { subagent_type: "general", prompt: "read .env.production" },
        { OPENCODE_FRUGAL_ALLOW_UNROUTED: "1" },
      ),
    /sensitive-looking material/,
  )
})

test("sensitive-looking prompts stay off remote workers", () => {
  assert.throws(
    () => validateTask({ subagent_type: "reasoner", prompt: "read .env.production" }, {}),
    /sensitive-looking material/,
  )
  assert.doesNotThrow(() =>
    validateTask({ subagent_type: "bulk-researcher", prompt: "inspect .env.example" }, {}),
  )
})

test("recognizes the worker result contract", () => {
  assert.equal(hasResultFooter('<frugal_result role="extractor" status="complete" />'), true)
  assert.equal(hasResultFooter("ordinary prose"), false)
})
