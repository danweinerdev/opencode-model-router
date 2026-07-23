import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  DEFAULT_MODEL_CONFIG,
  BULK_RESEARCHER_WEBFETCH_SESSION_LIMIT,
  BULK_RESEARCHER_WEBFETCH_URL_LIMIT,
  MODELS,
  WORKERS,
  applyRoutingConfig,
  hasResultFooter,
  hooksForModels,
  loadModelConfig,
  profileAvailable,
  routeTask,
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
  assert.equal(config.agent.implementer.model, MODELS.reasoner)
  assert.equal(config.agent.extractor.model, MODELS.extractor)
  assert.equal(config.agent.orchestrator.options.reasoningEffort, "high")
  assert.equal(config.agent.reasoner.options.reasoningEffort, "medium")
  assert.equal(config.agent.implementer.options.reasoningEffort, "high")
  assert.equal(config.agent.extractor.options.reasoningEffort, "medium")
  assert.equal(config.agent["bulk-researcher"].model, MODELS.local)
  assert.equal(config.agent["bounded-editor"].model, MODELS.local)
  assert.equal(config.agent["bulk-researcher"].steps, 12)
  assert.equal(config.agent["bulk-researcher"].permission.doom_loop, "deny")
  assert.match(config.agent["bulk-researcher"].prompt, /at most 8 successful or allowed `webfetch` requests/)
  assert.match(config.agent["bulk-researcher"].prompt, /same canonical URL at most twice/)
  assert.match(config.agent["bulk-researcher"].prompt, /End with exactly one status footer/)
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

test("read-only workers share bounded shell inspection permissions", async () => {
  const config = {}
  await applyRoutingConfig(config, DEFAULT_MODEL_CONFIG, async () => true)

  for (const name of [
    "reasoner",
    "extractor",
    "bulk-researcher",
    "review-plan-drift",
    "review-quality",
    "review-spec-compliance",
    "review-blind-spots",
  ]) {
    const bash = config.agent[name].permission.bash
    assert.equal(bash["*"], "deny")
    for (const command of ["ls", "grep *", "cat *", "git diff *", "git status"]) {
      assert.equal(bash[command], "allow", `${name} should allow ${command}`)
    }
    for (const command of ["find *", "sed *", "git checkout *", "rm *"]) {
      assert.equal(bash[command], undefined, `${name} should not override the deny rule for ${command}`)
    }
  }
})

test("bounded editor prefers edit tools and blocks script-based file edits", async () => {
  const config = {}
  await applyRoutingConfig(config, DEFAULT_MODEL_CONFIG, async () => true)

  const agent = config.agent["bounded-editor"]
  const bash = agent.permission.bash
  assert.equal(bash["*"], "ask")
  for (const command of ["ls", "grep *", "cat *", "git diff *", "git status"]) {
    assert.equal(bash[command], "allow")
  }
  for (const command of ["python*", "*/python*", "node*", "sed -i*", "bash -c*"]) {
    assert.equal(bash[command], "deny")
  }
  assert.match(agent.prompt, /Use `edit` for modifications and `write` only when creating a new file/)
  assert.match(agent.prompt, /Never\s+modify files through Python/)
})

test("implementer has approved semantic implementation permissions and prompt", async () => {
  const config = {}
  await applyRoutingConfig(config, DEFAULT_MODEL_CONFIG, async () => true)

  const agent = config.agent.implementer
  const bash = agent.permission.bash
  assert.equal(agent.mode, "subagent")
  assert.equal(agent.permission["*"], "deny")
  for (const tool of ["read", "edit", "glob", "grep", "list"]) assert.equal(agent.permission[tool], "allow")
  assert.equal(agent.permission.webfetch, undefined)
  assert.equal(agent.permission.task, undefined)
  assert.equal(bash["*"], "ask")
  for (const command of ["ls", "grep *", "cat *", "git diff *", "git status"]) {
    assert.equal(bash[command], "allow")
  }
  for (const command of ["python*", "python -c*", "node*", "node -e*", "npm test", "cargo test", "bash -c*"]) {
    assert.equal(bash[command], undefined, `${command} should fall through to the ask rule`)
  }
  assert.match(agent.prompt, /exactly one\s+approved implementation task/)
  assert.match(agent.prompt, /does not match reality, requires scope expansion/)
  assert.match(agent.prompt, /do\s+not\s+own plans, scope decisions, status, SDD\/Beads artifact state, commits, or final\s+acceptance/)
  assert.match(agent.prompt, /<frugal_result role="implementer" status="complete" \/>/)
})

test("registers code-review lanes with profile-specific models", async () => {
  const config = {}
  await applyRoutingConfig(config, DEFAULT_MODEL_CONFIG, async () => true)

  assert.equal(config.agent["review-plan-drift"].model, MODELS.reasoner)
  assert.equal(config.agent["review-quality"].model, MODELS.reasoner)
  assert.equal(config.agent["review-spec-compliance"].model, MODELS.extractor)
  assert.equal(config.agent["review-blind-spots"].model, MODELS.orchestrator)
  for (const name of [
    "review-plan-drift",
    "review-quality",
    "review-spec-compliance",
    "review-blind-spots",
  ]) {
    assert.equal(config.agent[name].mode, "subagent")
    assert.equal(config.agent[name].permission["*"], "deny")
    assert.equal(config.agent[name].permission.read, "allow")
  }
})

test("routes stable implementation and SDD review identifiers regardless of requested worker", () => {
  for (const requested of ["general", "bounded-editor", "reasoner"]) {
    const args = { description: "implement_task", subagent_type: requested }
    assert.equal(routeTask(args), "implementer")
    assert.equal(args.subagent_type, "implementer")
  }
  const lanes = {
    review_plan_drift: "review-plan-drift",
    review_quality: "review-quality",
    review_spec_compliance: "review-spec-compliance",
    review_blind_spots: "review-blind-spots",
  }
  for (const [description, expected] of Object.entries(lanes)) {
    const args = { description, subagent_type: "general" }
    assert.equal(routeTask(args), expected)
    assert.equal(args.subagent_type, expected)
  }
  const unrelated = { description: "ordinary research", subagent_type: "bulk-researcher" }
  assert.equal(routeTask(unrelated), undefined)
  assert.equal(unrelated.subagent_type, "bulk-researcher")
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

  const invalidLane = structuredClone(DEFAULT_MODEL_CONFIG)
  invalidLane.roles["review-quality"] = "missing"
  assert.throws(() => validateModelConfig(invalidLane), /references missing profile/)

  const nonStringLane = structuredClone(DEFAULT_MODEL_CONFIG)
  nonStringLane.roles["review-quality"] = 42
  assert.throws(() => validateModelConfig(nonStringLane), /must name a profile/)

  const invalidImplementer = structuredClone(DEFAULT_MODEL_CONFIG)
  invalidImplementer.roles.implementer = "missing"
  assert.throws(() => validateModelConfig(invalidImplementer), /references missing profile/)

  const nonStringImplementer = structuredClone(DEFAULT_MODEL_CONFIG)
  nonStringImplementer.roles.implementer = 42
  assert.throws(() => validateModelConfig(nonStringImplementer), /must name a profile/)
})

test("legacy profiles inherit code-review lane mappings", async () => {
  const legacy = structuredClone(DEFAULT_MODEL_CONFIG)
  for (const role of [
    "review-plan-drift",
    "review-quality",
    "review-spec-compliance",
    "review-blind-spots",
  ]) {
    delete legacy.roles[role]
  }
  validateModelConfig(legacy)
  const config = {}
  await applyRoutingConfig(config, legacy, async () => true)
  assert.equal(config.agent["review-plan-drift"].model, MODELS.reasoner)
  assert.equal(config.agent["review-spec-compliance"].model, MODELS.extractor)
  assert.equal(config.agent["review-blind-spots"].model, MODELS.orchestrator)
})

test("legacy profiles inherit the implementer mapping from reasoner", async () => {
  const legacy = structuredClone(DEFAULT_MODEL_CONFIG)
  delete legacy.roles.implementer
  validateModelConfig(legacy)
  const config = {}
  await applyRoutingConfig(config, legacy, async () => true)
  assert.equal(config.agent.implementer.model, MODELS.reasoner)
  assert.equal(config.agent.implementer.options.reasoningEffort, "medium")
})

test("project configuration selects an explicit implementer profile", async () => {
  const project = structuredClone(DEFAULT_MODEL_CONFIG)
  project.profiles.implementation = { model: "anthropic/claude-sonnet-5", variant: "high" }
  validateModelConfig(project)
  const config = {}
  await applyRoutingConfig(config, project, async () => true)
  assert.equal(config.agent.implementer.model, "anthropic/claude-sonnet-5")
  assert.equal(config.agent.implementer.variant, "high")
})

test("plugin hook routes review lanes before enforcing the allowlist", async () => {
  const hooks = hooksForModels({ config: DEFAULT_MODEL_CONFIG, source: "test" })
  const config = {}
  await hooks.config(config)
  const output = {
    args: {
      description: "review_blind_spots",
      subagent_type: "general",
      prompt: "Review the supplied diff only",
    },
  }
  await hooks["tool.execute.before"]({ tool: "task" }, output)
  assert.equal(output.args.subagent_type, "review-blind-spots")
})

test("plugin hook routes implementation dispatch before enforcing the allowlist", async () => {
  const hooks = hooksForModels({ config: DEFAULT_MODEL_CONFIG, source: "test" })
  const config = {}
  await hooks.config(config)
  const output = {
    args: { description: "implement_task", subagent_type: "general", prompt: "Implement the approved change" },
  }
  await hooks["tool.execute.before"]({ tool: "task" }, output)
  assert.equal(output.args.subagent_type, "implementer")
})

test("bulk-researcher webfetch circuit allows two canonical URL calls and rejects the third", async () => {
  const hooks = hooksForModels({ config: DEFAULT_MODEL_CONFIG, source: "test" })
  await hooks["chat.params"]({ sessionID: "bulk-url", agent: "bulk-researcher" }, {})
  const fetch = (url) => hooks["tool.execute.before"]({ tool: "webfetch", sessionID: "bulk-url" }, { args: { url } })

  for (let index = 0; index < BULK_RESEARCHER_WEBFETCH_URL_LIMIT; index += 1) {
    await fetch(`https://example.test/report#${index}`)
  }
  await assert.rejects(fetch("https://example.test/report#third"), /canonical URL has reached its limit/)
})

test("bulk-researcher webfetch circuit rejects the ninth allowed fetch", async () => {
  const hooks = hooksForModels({ config: DEFAULT_MODEL_CONFIG, source: "test" })
  await hooks["chat.message"]({ sessionID: "bulk-total", agent: "bulk-researcher" }, {})
  const fetch = (url) => hooks["tool.execute.before"]({ tool: "webfetch", sessionID: "bulk-total" }, { args: { url } })

  for (let index = 0; index < BULK_RESEARCHER_WEBFETCH_SESSION_LIMIT; index += 1) {
    await fetch(`https://example.test/${index}`)
  }
  await assert.rejects(fetch("https://example.test/ninth"), /session has reached its limit/)
})

test("bulk-researcher webfetch circuit rejects a canonical URL after an error", async () => {
  const hooks = hooksForModels({ config: DEFAULT_MODEL_CONFIG, source: "test" })
  await hooks["chat.params"]({ sessionID: "bulk-failure", agent: "bulk-researcher" }, {})
  await hooks["tool.execute.before"](
    { tool: "webfetch", sessionID: "bulk-failure", callID: "failed-call" },
    { args: { url: "https://example.test/report#first" } },
  )
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "webfetch",
          sessionID: "bulk-failure",
          callID: "failed-call",
          state: {
            status: "error",
            input: { url: "https://example.test/report#first" },
            error: "request failed",
          },
        },
      },
    },
  })

  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "webfetch", sessionID: "bulk-failure", callID: "retry-call" },
      { args: { url: "https://example.test/report#retry" } },
    ),
    /previous request for this canonical URL failed/,
  )
})

test("webfetch circuit does not affect non-bulk-researcher sessions", async () => {
  const hooks = hooksForModels({ config: DEFAULT_MODEL_CONFIG, source: "test" })
  await hooks["chat.params"]({ sessionID: "reasoner", agent: "reasoner" }, {})
  for (let index = 0; index <= BULK_RESEARCHER_WEBFETCH_SESSION_LIMIT; index += 1) {
    await hooks["tool.execute.before"](
      { tool: "webfetch", sessionID: "reasoner" },
      { args: { url: "https://example.test/same-url" } },
    )
  }
})

test("session lifecycle events clear bulk-researcher webfetch circuit state", async () => {
  const events = [
    (sessionID) => ({ type: "session.idle", properties: { sessionID } }),
    (sessionID) => ({ type: "session.deleted", properties: { info: { id: sessionID } } }),
    (sessionID) => ({ type: "session.error", properties: { sessionID } }),
  ]

  for (const [index, event] of events.entries()) {
    const hooks = hooksForModels({ config: DEFAULT_MODEL_CONFIG, source: "test" })
    const sessionID = `cleanup-${index}`
    const fetch = () =>
      hooks["tool.execute.before"](
        { tool: "webfetch", sessionID },
        { args: { url: "https://example.test/report" } },
      )
    await hooks["chat.params"]({ sessionID, agent: "bulk-researcher" }, {})
    await fetch()
    await fetch()
    await hooks.event({ event: event(sessionID) })
    await hooks["chat.params"]({ sessionID, agent: "bulk-researcher" }, {})
    await fetch()
    await fetch()
    await assert.rejects(fetch(), /canonical URL has reached its limit/)
  }
})

test("pre-config hook state treats every worker as remote", async () => {
  const hooks = hooksForModels({ config: DEFAULT_MODEL_CONFIG, source: "test" })
  const output = {
    args: {
      description: "review_quality",
      subagent_type: "bulk-researcher",
      prompt: "Read .env.production",
    },
  }
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "task" }, output),
    /sensitive-looking material/,
  )
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
  assert.equal(resolved.remoteWorkers.has("implementer"), true)
  assert.throws(
    () =>
      validateTask(
        { subagent_type: "bounded-editor", prompt: "read .env.production" },
        {},
        resolved.remoteWorkers,
      ),
    /sensitive-looking material/,
  )
  assert.throws(
    () =>
      validateTask(
        { subagent_type: "implementer", prompt: "read .env.production" },
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
  assert.equal(resolved.remoteWorkers.has("implementer"), true)
})

test("checked-in examples conform to the project model schema", async () => {
  for (const path of ["examples/gpt-based.json.example", "examples/claude-based.json.example"]) {
    validateModelConfig(JSON.parse(await readFile(path, "utf8")))
  }
})

test("Claude example assigns supported effort variants by role", async () => {
  const models = validateModelConfig(
    JSON.parse(await readFile("examples/claude-based.json.example", "utf8")),
  )
  const config = {}
  await applyRoutingConfig(config, models)

  assert.equal(config.agent.orchestrator.model, "anthropic/claude-fable-5")
  assert.equal(config.agent.orchestrator.variant, "high")
  assert.equal(config.agent.reasoner.model, "anthropic/claude-sonnet-5")
  assert.equal(config.agent.reasoner.variant, "medium")
  assert.equal(config.agent.implementer.model, "anthropic/claude-sonnet-5")
  assert.equal(config.agent.implementer.variant, "high")
  assert.equal(config.agent.extractor.model, "anthropic/claude-haiku-4-5")
  assert.equal(config.agent.extractor.variant, undefined)
  assert.equal(config.agent["review-blind-spots"].model, "anthropic/claude-opus-4-8")
  assert.equal(config.agent["review-blind-spots"].variant, "max")
})

test("loads project configuration and falls back atomically when invalid", async () => {
  const project = structuredClone(DEFAULT_MODEL_CONFIG)
  project.profiles.extraction.reasoning_effort = "low"
  const loaded = await loadModelConfig("/checkout", {
    home: "/home/user",
    readFileImpl: async (path) => {
      assert.equal(path, "/checkout/.agents/models.json")
      return JSON.stringify(project)
    },
  })
  assert.equal(loaded.config.profiles.extraction.reasoning_effort, "low")
  assert.equal(loaded.source, "/checkout/.agents/models.json")

  const invalid = await loadModelConfig("/checkout", {
    home: "/home/user",
    readFileImpl: async () => "{}",
  })
  assert.equal(invalid.config, DEFAULT_MODEL_CONFIG)
  assert.match(invalid.warning, /unsupported schema_version/)
})

test("falls back from project to home model configuration", async () => {
  const global = structuredClone(DEFAULT_MODEL_CONFIG)
  global.profiles.extraction.reasoning_effort = "low"
  const loaded = await loadModelConfig("/checkout", {
    home: "/home/user",
    readFileImpl: async (path) => {
      if (path === "/checkout/.agents/models.json") {
        const error = new Error("missing")
        error.code = "ENOENT"
        throw error
      }
      assert.equal(path, "/home/user/.agents/models.json")
      return JSON.stringify(global)
    },
  })
  assert.equal(loaded.source, "/home/user/.agents/models.json")
  assert.equal(loaded.config.profiles.extraction.reasoning_effort, "low")
  assert.equal(loaded.warning, undefined)
})

test("reports an invalid project file before using a valid home file", async () => {
  const loaded = await loadModelConfig("/checkout", {
    home: "/home/user",
    readFileImpl: async (path) =>
      path === "/checkout/.agents/models.json" ? "{}" : JSON.stringify(DEFAULT_MODEL_CONFIG),
  })
  assert.equal(loaded.source, "/home/user/.agents/models.json")
  assert.match(loaded.warning, /Ignored invalid \/checkout\/\.agents\/models.json/)
})

test("preserves direct read-function injection", async () => {
  const loaded = await loadModelConfig("/checkout", async (path) => {
    assert.equal(path, "/checkout/.agents/models.json")
    return JSON.stringify(DEFAULT_MODEL_CONFIG)
  })
  assert.equal(loaded.source, "/checkout/.agents/models.json")
})

test("uses bundled defaults when project and home files are missing", async () => {
  const paths = []
  const loaded = await loadModelConfig("/checkout", {
    home: "/home/user",
    readFileImpl: async (path) => {
      paths.push(path)
      const error = new Error("missing")
      error.code = "ENOENT"
      throw error
    },
  })
  assert.deepEqual(paths, ["/checkout/.agents/models.json", "/home/user/.agents/models.json"])
  assert.equal(loaded.config, DEFAULT_MODEL_CONFIG)
  assert.equal(loaded.source, "bundled")
  assert.equal(loaded.warning, undefined)
})

test("deduplicates identical project and home candidates", async () => {
  let reads = 0
  const loaded = await loadModelConfig("/home/user", {
    home: "/home/user",
    readFileImpl: async () => {
      reads += 1
      const error = new Error("missing")
      error.code = "ENOENT"
      throw error
    },
  })
  assert.equal(reads, 1)
  assert.equal(loaded.source, "bundled")
})

test("combines project and home validation warnings in precedence order", async () => {
  const loaded = await loadModelConfig("/checkout", {
    home: "/home/user",
    readFileImpl: async (path) =>
      path === "/checkout/.agents/models.json"
        ? "{}"
        : JSON.stringify({ schema_version: 1, profiles: {}, roles: {} }),
  })
  assert.equal(loaded.source, "bundled")
  assert.match(
    loaded.warning,
    /^Ignored invalid \/checkout\/\.agents\/models\.json:.*; Ignored invalid \/home\/user\/\.agents\/models\.json:/,
  )
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
      { OPENCODE_MODEL_ROUTER_ALLOW_UNROUTED: "1" },
    ),
  )
  assert.throws(
    () =>
      validateTask(
        { subagent_type: "general", prompt: "read .env.production" },
        { OPENCODE_MODEL_ROUTER_ALLOW_UNROUTED: "1" },
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
