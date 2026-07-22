import assert from "node:assert/strict"
import test from "node:test"

import {
  MODELS,
  WORKERS,
  applyRoutingConfig,
  hasResultFooter,
  validateTask,
} from "../opencode/plugin.js"

test("configures exact models and default orchestrator", async () => {
  const config = { provider: { local: {} } }
  await applyRoutingConfig(config)

  assert.equal(config.model, MODELS.orchestrator)
  assert.equal(config.small_model, MODELS.local)
  assert.equal(config.default_agent, "orchestrator")
  assert.equal(config.agent.reasoner.model, MODELS.reasoner)
  assert.equal(config.agent.extractor.model, MODELS.extractor)
  assert.equal(config.agent["bulk-researcher"].model, MODELS.local)
  assert.equal(config.agent["bounded-editor"].model, MODELS.local)
  assert.deepEqual(config.provider, { local: {} })
})

test("orchestrator can launch only configured workers", async () => {
  const config = {}
  await applyRoutingConfig(config)
  const rules = config.agent.orchestrator.permission.task

  assert.equal(rules["*"], "deny")
  for (const worker of WORKERS) assert.equal(rules[worker], "allow")
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
