import assert from "node:assert/strict"
import test from "node:test"

import {
  MODELS,
  WORKERS,
  applyRoutingConfig,
  hasResultFooter,
  localModelAvailable,
  validateTask,
} from "../opencode/plugin.js"

test("configures exact models and default orchestrator", async () => {
  const config = { provider: { local: {} } }
  await applyRoutingConfig(config, async () => true)

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
  await applyRoutingConfig(config, async () => true)
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
  assert.equal(await localModelAvailable(config, fetchImpl), true)
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
    await localModelAvailable(config, async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "another-model" }] }),
    })),
    false,
  )
  assert.equal(
    await localModelAvailable(config, async () => {
      throw new Error("connection refused")
    }),
    false,
  )
})

test("falls back Qwen roles and hidden agents to Luna medium", async () => {
  const config = {}
  await applyRoutingConfig(config, async () => false)

  assert.equal(config.small_model, MODELS.extractor)
  for (const name of ["bulk-researcher", "bounded-editor", "summary", "compaction", "title"]) {
    assert.equal(config.agent[name].model, MODELS.extractor)
    assert.equal(config.agent[name].options.reasoningEffort, "medium")
  }
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
