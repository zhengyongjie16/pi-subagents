import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import type { AgentInfo } from '../src/core.js';
import { configureCoreFixture, useTestAgentDir, waitUntil } from './fixtures/core-sdk-fixture.js';

const TEST_AGENT_DIR = useTestAgentDir();
const CORE_SDK_EXTENSION = path.join(import.meta.dir, 'fixtures', 'core-sdk-fixture.ts');
const codingAgent = await import('@earendil-works/pi-coding-agent');
const { AgentManager, getAgent, getRunsDir, parentScopeKey } = await import('../src/core.js');
type AgentManager = InstanceType<typeof AgentManager>;
const { SubagentPeekOverlay } = await import('../src/peek.js');

beforeEach(() => {
  configureCoreFixture();
  fs.writeFileSync(
    path.join(TEST_AGENT_DIR, 'pi-subagents', 'config.json'),
    JSON.stringify({ defaults: { extensions: [CORE_SDK_EXTENSION] } }),
  );
});

const packageDir = path.resolve(import.meta.dir, '..');
const entry = path.join(packageDir, 'src', 'index.ts');
const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const toolNames = [
  'spawn_agent',
  'wait_agent',
  'list_agents',
  'read_agent_response',
  'send_message',
  'interrupt_agent',
];

// Separate processes keep module mocks, SDK caches, and agent directories out of sibling suites.
function probe(source: string, executable = process.execPath, extensionEntry = entry): void {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-host-'));
  try {
    const script = path.join(temporary, 'probe.mjs');
    fs.writeFileSync(script, source);
    const result = spawnSync(executable, [script, extensionEntry], {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 40_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: temporary, PI_SUBAGENT_TEMP_DIR: temporary },
    });
    if (result.status !== 0)
      throw new Error(
        `Host probe failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
      );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const hostFixture = `
  import assert from "node:assert/strict";
  import * as fs from "node:fs";
  import * as path from "node:path";
  const { AgentManager } = await import(${JSON.stringify(pathToFileURL(path.join(packageDir, 'src', 'core.ts')).href)});
  const { default: extension } = await import(${JSON.stringify(pathToFileURL(entry).href)});
  let options;
  let shutdownCalls = 0;
  AgentManager.prototype.ready = async function() { options = this.options; };
  AgentManager.prototype.shutdown = async function() { shutdownCalls++; };
  AgentManager.prototype.listAgents = () => [];
  function host() {
    const tools = new Map(), handlers = new Map(), commands = new Map(), shortcuts = new Map(), renderers = new Map();
    const messages = [], notifications = [], widgets = [];
    const ctx = {
      cwd: process.env.PI_CODING_AGENT_DIR, mode: "tui", hasUI: true,
      isProjectTrusted: () => true,
      model: { provider: "test", id: "fake" },
      modelRegistry: { getAvailable: () => [{ provider: "test", id: "fake" }] },
      sessionManager: { getSessionId: () => "parent", getSessionFile: () => "parent.jsonl" },
      ui: {
        notify: (...args) => notifications.push(args),
        setWidget: (...args) => widgets.push(args),
        custom: async () => undefined,
      },
    };
    const pi = {
      on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
      registerTool(tool) { tools.set(tool.name, tool); },
      registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
      registerCommand(name, command) { commands.set(name, command); },
      registerShortcut(name, shortcut) { shortcuts.set(name, shortcut); },
      getActiveTools: () => ["read"], getThinkingLevel: () => "high", getSettings: () => ({}),
      sendMessage: (message, delivery) => messages.push({ message, delivery }),
    };
    return {
      tools, commands, shortcuts, renderers, messages, notifications, widgets, ctx, pi,
      async emit(name, event = {}, context = ctx) {
        for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, context);
      },
      call(name, params, context = ctx, signal) { return tools.get(name).execute("test-call", params, signal, undefined, context); },
    };
  }
`;

test('awaits browser selection and cancellation before opening details through commands and shortcuts', () => {
  probe(
    hostFixture +
      String.raw`
    const config = path.join(process.env.PI_CODING_AGENT_DIR, "pi-subagents", "config.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ shortcut: "ctrl+shift+a" }));
    for (const entrypoint of ["command", "shortcut"]) {
      for (const selected of [undefined, { task: "/worker", parentSessionId: "parent", includeAll: false }]) {
        const f = host();
        await extension(f.pi);
        const queries = [];
        AgentManager.prototype.getAgentInfo = (task, parentSessionId) => {
          queries.push({ task, parentSessionId });
          return { canonicalName: task, parentSessionId };
        };
        let select, closeDetails, overlays = 0, settled = false;
        const selection = new Promise(resolve => { select = resolve; });
        const details = new Promise(resolve => { closeDetails = resolve; });
        f.ctx.ui.custom = (_create, options) => {
          if (options?.overlay) { overlays++; return details; }
          return selection;
        };
        const run = entrypoint === "command"
          ? f.commands.get("subagents").handler("", f.ctx)
          : f.shortcuts.get("ctrl+shift+a").handler(f.ctx);
        run.then(() => { settled = true; });
        try {
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(settled, false, "browser command must wait for the user's choice");
          assert.deepEqual(queries, [], "no task lookup before selection");
          assert.deepEqual(f.notifications, []);
          select(selected);
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(overlays, selected ? 1 : 0);
          assert.deepEqual(queries, selected ? [{ task: "/worker", parentSessionId: "parent" }] : []);
          assert.equal(settled, !selected, "a selected detail overlay must also be awaited");
          closeDetails(undefined);
          await run;
          assert.deepEqual(f.notifications, [], "cancellation is not an error");
        } finally {
          select(undefined);
          closeDetails(undefined);
          await run;
          await f.emit("session_shutdown", { reason: "quit" });
        }
      }
    }
  `,
  );
});

test('uses the native render context for errors without changing successful tool previews', () => {
  probe(
    hostFixture +
      String.raw`
    const { initTheme, ToolExecutionComponent } = await import(${JSON.stringify(sdkUrl)});
    const { stripVTControlCharacters } = await import("node:util");
    initTheme("dark", false);
    const f = host();
    await extension(f.pi);
    const success = {
      spawn_agent: "✓ /worker · test/fake · high", wait_agent: "success-only",
      list_agents: "✓ 0 of 0 agents", read_agent_response: "✓ /worker",
      send_message: "✓ steered", interrupt_agent: "↯ previous: running",
    };
    const failure = {
      spawn_agent: "✗ controlled failure", wait_agent: "✗ wait failed",
      list_agents: "✗ list failed", read_agent_response: "✗ read failed",
      send_message: "✗ send failed", interrupt_agent: "✗ interrupt failed",
    };
    const details = {
      task_name: "/worker", provider: "test", modelId: "fake", thinking: "high",
      agent_name: "/worker", message: "success-only", agents: [], total: 0,
      delivery: "steer", previous_status: "running", status: "failed",
    };
    for (const [name, definition] of f.tools) {
      const invocations = [];
      const renderer = { ...definition, renderResult(...args) {
        invocations.push(args);
        return definition.renderResult(...args);
      } };
      const component = new ToolExecutionComponent(name, name + "-render", {},
        { showImages: false, outputPad: 0 }, renderer, { requestRender() {} }, f.ctx.cwd);
      const rendered = () => stripVTControlCharacters(component.render(120).join("\n"));
      component.updateResult({ content: [{ type: "text", text: "successful output" }], details, isError: false });
      assert.ok(rendered().includes(success[name]), name + " success preview changed");
      component.updateResult({ content: [{ type: "text", text: "partial output" }], details, isError: false }, true);
      assert.equal(invocations.at(-1)[1].isPartial, true);
      assert.equal(invocations.at(-1)[3].isPartial, true);
      assert.equal(invocations.at(-1)[3].isError, false);
      for (const expanded of [false, true]) {
        component.setExpanded(expanded);
        for (const errorDetails of [undefined, details]) {
          // Native ToolExecutionComponent supplies isError in render context.
          component.updateResult({ content: [{ type: "text", text: "controlled failure" }], details: errorDetails, isError: true });
          const output = rendered();
          assert.equal(Object.hasOwn(invocations.at(-1)[0], "isError"), false);
          assert.equal(invocations.at(-1)[3].isError, true);
          assert.ok(output.includes(failure[name]), name + " must render its failure state: " + output);
          assert.ok(!output.includes("✓"), name + " must not show a success checkmark");
          assert.ok(!output.includes("↯ previous:"), name + " must not show a successful interrupt");
        }
      }
      component.setExpanded(false);
      component.updateResult({ content: [{ type: "text", text: "successful output" }], details, isError: false });
      assert.ok(rendered().includes(success[name]), name + " must recover from a previous error");
    }
  `,
  );
});

test('preserves the six schemas, dynamic routing, tool arguments, and return wrappers', () => {
  probe(
    hostFixture +
      String.raw`
    const f = host();
    await extension(f.pi);
    assert.deepEqual([...f.tools.keys()], ${JSON.stringify(toolNames)});
    assert.deepEqual([...f.commands.keys()], ["subagents"]);
    assert.deepEqual([...f.renderers.keys()], ["pi-subagent-completion"]);
    assert.equal(options, undefined, "factory must not initialize a session-scoped manager");
    const plain = schema => JSON.parse(JSON.stringify(schema, (key, value) => key === "description" ? undefined : value));
    const object = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
    const string = { type: "string" }, targets = { type: "array", items: string };
    assert.deepEqual(plain(f.tools.get("spawn_agent").parameters), object({
      task_name: string, message: string, agent_type: string,
    }, ["task_name", "message"]));
    assert.deepEqual(plain(f.tools.get("wait_agent").parameters), object({ targets }));
    assert.deepEqual(plain(f.tools.get("list_agents").parameters), object({
      path_prefix: string, include_all: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 },
    }));
    for (const name of ["read_agent_response", "interrupt_agent"]) assert.deepEqual(plain(f.tools.get(name).parameters), object({ target: string }, ["target"]));
    assert.deepEqual(plain(f.tools.get("send_message").parameters), object({ target: string, message: string }, ["target", "message"]));
    const config = path.join(f.ctx.cwd, "pi-subagents", "config.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ models: ["test/fake"] }));
    await f.emit("session_start");
    const spawnSchema = plain(f.tools.get("spawn_agent").parameters);
    assert.deepEqual(spawnSchema.properties.model, { type: "string", enum: ["test/fake"] });
    assert.deepEqual(spawnSchema.properties.thinking.enum, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(spawnSchema.required, ["task_name", "message"]);
    const description = f.tools.get("spawn_agent").description;
    assert.ok(description.includes("Skills are discovered automatically by the child session."));
    assert.ok(!description.includes("Available parent skills"));
    assert.ok(!Object.hasOwn(spawnSchema.properties, "skills"));
    for (const skills of [
      [{ name: "parent-only-marker", description: "selected", filePath: "/skill/SKILL.md" }],
      [{ name: "hidden-marker", disableModelInvocation: true, filePath: "/hidden/SKILL.md" }],
      [],
    ]) {
      await f.emit("before_agent_start", { systemPromptOptions: { skills } });
      assert.equal(f.tools.get("spawn_agent").description, description);
      assert.deepEqual(plain(f.tools.get("spawn_agent").parameters), spawnSchema);
    }
    let spawned;
    AgentManager.prototype.spawnAgent = async params => { spawned = params; return { task_name: "/task", nickname: null }; };
    AgentManager.prototype.getAgentInfo = () => ({ provider: "test", modelId: "fake", thinking: "high" });
    const spawn = await f.call("spawn_agent", { task_name: "task", message: "work", model: "test/fake", thinking: "high" });
    assert.deepEqual(spawn, { content: [{ type: "text", text: "Spawned /task." }], details: { task_name: "/task", nickname: null, provider: "test", modelId: "fake", thinking: "high" } });
    assert.equal(spawned.parentSessionId, "parent");
    assert.equal(spawned.cwd, f.ctx.cwd);
    assert.equal(spawned.parentSessionFile, "parent.jsonl");
    assert.equal(spawned.inheritedTools, "read");
    assert.ok(!Object.hasOwn(spawned, "skills"));
    assert.ok(!Object.hasOwn(spawned, "loadedSkillPaths"));
    const signal = new AbortController().signal;
    let waited;
    AgentManager.prototype.waitAgent = async (...args) => { waited = args; return { message: "done", event: { status: "completed" } }; };
    const wait = await f.call("wait_agent", { targets: [" /task "] }, f.ctx, signal);
    assert.deepEqual(waited, ["parent", ["task"], signal]);
    assert.deepEqual(JSON.parse(wait.content[0].text), { message: "done", event: { status: "completed" } });
    assert.deepEqual(wait.details, { message: "done" });
    let listed;
    AgentManager.prototype.listAgents = (...args) => { listed = args; return Array.from({ length: 12 }, (_, n) => ({ agent_name: "/" + n, agent_status: "completed", ...(args[2] ? { parent_session_id: "other" } : {}) })); };
    const list = await f.call("list_agents", {});
    assert.deepEqual(listed, [undefined, "parent", false]);
    assert.equal(list.details.returned, 10);
    assert.equal(list.details.next_offset, 10);
    const history = await f.call("list_agents", { include_all: true, offset: 10 });
    assert.deepEqual(listed, [undefined, "parent", true]);
    assert.equal(history.details.returned, 2);
    assert.equal(history.details.agents[0].parent_session_id, "other");
    let scoped;
    AgentManager.prototype.readAgentResponse = (...args) => { scoped = args; return { agent_name: "/task", status: "completed", finalResponse: "answer" }; };
    const read = await f.call("read_agent_response", { target: " /task " });
    assert.deepEqual(scoped, ["task", "parent"]);
    assert.deepEqual(read.details, { agent_name: "/task", status: "completed" });
    assert.equal(JSON.parse(read.content[0].text).finalResponse, "answer");
    for (const delivery of ["steer", "prompt"]) {
      AgentManager.prototype.sendMessage = async (...args) => { scoped = args; return { delivery, status: "running" }; };
      const send = await f.call("send_message", { target: "/task", message: "next" });
      assert.deepEqual(scoped, ["parent", "task", "next"]);
      assert.deepEqual(send.details, { target: "/task", delivery, status: "running" });
    }
    AgentManager.prototype.interruptAgent = async (...args) => { scoped = args; return { previous_status: "running" }; };
    const interrupt = await f.call("interrupt_agent", { target: "/task" });
    assert.deepEqual(scoped, ["parent", "task"]);
    assert.deepEqual(interrupt, { content: [{ type: "text", text: "Interrupt request handled." }], details: { previous_status: "running" } });
    await f.emit("session_shutdown", { reason: "quit" });
  `,
  );
});

test('wait_agent preserves target previews, error prefixes and cancellation identity', () => {
  probe(
    hostFixture +
      String.raw`
    const f = host();
    await extension(f.pi);
    const theme = { fg: (_color, text) => text, bold: text => text };
    const tool = f.tools.get("wait_agent");
    const preview = args => tool.renderCall(args, theme).render(160).join("\n").trim();
    assert.equal(preview({}), "wait_agent any");
    assert.equal(preview({ targets: [] }), "wait_agent any");
    assert.equal(preview({ targets: ["/one", "/two"] }), "wait_agent /one,/two");
    for (const failure of [new Error("controlled failure"), "plain failure"]) {
      AgentManager.prototype.waitAgent = async () => { throw failure; };
      await assert.rejects(f.call("wait_agent", {}), error =>
        error.message === "wait_agent failed: " + (failure instanceof Error ? failure.message : failure));
    }
    const controller = new AbortController();
    const cancellation = new Error("wait cancelled");
    controller.abort(cancellation);
    AgentManager.prototype.waitAgent = async () => { throw cancellation; };
    await assert.rejects(f.call("wait_agent", {}, f.ctx, controller.signal), error => error === cancellation);
  `,
  );
});

test('prefers exact registered model IDs before legacy thinking suffixes without changing the allowlist union', () => {
  probe(
    hostFixture +
      String.raw`
    const f = host();
    const available = [
      { provider: "test", id: "fake" }, { provider: "test", id: "fake:high" },
      { provider: "test", id: "only:low" }, { provider: "test", id: "accounts/team/model:high" },
      { provider: "other", id: "scoped:max" },
      { provider: "audit", id: "provider/org/model" }, { provider: "audit/provider", id: "org/model" },
      { provider: "llama.cpp/http://localhost:8080", id: "repo/model:high" },
    ];
    f.ctx.modelRegistry.getAvailable = () => available;
    f.ctx.scopedModels = [{ model: available[1] }, { model: available[4] }];
    const config = path.join(f.ctx.cwd, "pi-subagents", "config.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({
      models: ["test/fake:high", "test/only:low", "test/fake:medium", "test/accounts/team/model:high", "audit/provider/org/model", "audit/provider/org/model:medium", "llama.cpp/http://localhost:8080/repo/model:high", "test/fake:unknown", "fake", "test/*:high"],
      modelsFromEnabledModels: true,
    }));
    await extension(f.pi);
    await f.emit("session_start");
    try {
      const models = ["test/fake:high", "test/only:low", "test/fake", "test/accounts/team/model:high", "audit/provider/org/model", "llama.cpp/http://localhost:8080/repo/model:high", "other/scoped:max"];
      assert.deepEqual(f.tools.get("spawn_agent").parameters.properties.model.enum, models);
      assert.deepEqual(f.notifications, [["spawn_agent models not available: test/fake:unknown, fake, test/*:high", "warning"]]);
      let spawned;
      AgentManager.prototype.spawnAgent = async params => { spawned = params; return { task_name: "/task" }; };
      AgentManager.prototype.getAgentInfo = () => ({ ...spawned.model, thinking: spawned.inheritedThinking });
      for (const model of models) {
        await f.call("spawn_agent", { task_name: "task", message: "work", model });
        const expected = available.filter(entry => entry.provider + "/" + entry.id === model)
          .sort((a, b) => b.provider.length - a.provider.length)[0];
        assert.deepEqual(spawned.model, { provider: expected.provider, modelId: expected.id });
        assert.equal(spawned.thinking, undefined, "a model suffix must not override inherited thinking");
      }
      assert.deepEqual(spawned.model, { provider: "other", modelId: "scoped:max" });
      await assert.rejects(f.call("spawn_agent", { task_name: "blocked", message: "work", model: "unapproved/model" }), /not in the configured spawn models/);
      const gone = available.splice(available.findIndex(model => model.provider === "test" && model.id === "fake:high"), 1)[0];
      await assert.rejects(f.call("spawn_agent", { task_name: "gone", message: "work", model: "test/fake:high" }), /not currently available/);
      available.push(gone);
      // A canonical reference can match multiple pairs: prefer the longest provider, regardless of catalog order.
      available.reverse();
      await f.emit("session_start");
      await f.call("spawn_agent", { task_name: "task", message: "work", model: "audit/provider/org/model" });
      assert.deepEqual(spawned.model, { provider: "audit/provider", modelId: "org/model" });
      // Resolve full registered IDs with thinking-like suffixes directly.
      available.splice(available.findIndex(model => model.provider === "test" && model.id === "fake"), 1);
      fs.writeFileSync(config, JSON.stringify({ models: ["test/fake:high"] }));
      await f.emit("session_start");
      assert.deepEqual(f.tools.get("spawn_agent").parameters.properties.model.enum, ["test/fake:high"]);
    } finally { await f.emit("session_shutdown", { reason: "quit" }); }
  `,
  );
});

test('forwards only current same-cwd effective trust and reports errors without changing control flow', () => {
  probe(
    hostFixture +
      String.raw`
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    let trusted = true, trustReads = 0;
    f.ctx.isProjectTrusted = () => { trustReads++; return trusted; };
    assert.equal(options.projectTrusted(f.ctx.cwd), true);
    trusted = false;
    assert.equal(options.projectTrusted(path.join(f.ctx.cwd, ".")), false);
    assert.equal(options.projectTrusted(path.join(f.ctx.cwd, "other")), undefined);
    assert.equal(trustReads, 2, "a different cwd must never borrow parent trust");
    trusted = "invalid";
    assert.equal(options.projectTrusted(f.ctx.cwd), undefined);
    const next = { ...f.ctx, isProjectTrusted: () => false };
    AgentManager.prototype.sendMessage = async () => ({ delivery: "prompt" });
    await f.call("send_message", { target: "task", message: "resume" }, next);
    assert.equal(options.projectTrusted(next.cwd), false, "resumption must use its current context, not the startup snapshot");
    options.onError(new Error("subscription/save failed"));
    assert.deepEqual(f.notifications.pop(), ["[subagents] subscription/save failed", "error"]);
    const logged = [], previous = console.error;
    console.error = (...args) => logged.push(args.join(" "));
    try {
      next.ui.notify = () => { throw new Error("UI unavailable"); };
      assert.doesNotThrow(() => options.onError(new Error("cleanup failed")));
      next.hasUI = false;
      assert.doesNotThrow(() => options.onError(new Error("headless failure")));
      assert.ok(logged.some(line => line.includes("cleanup failed")));
      assert.ok(logged.some(line => line.includes("headless failure")));
      await f.emit("session_shutdown", { reason: "quit" }, next);
      assert.equal(options.projectTrusted(next.cwd), undefined);
    } finally { console.error = previous; }
  `,
  );
});

test("warns when storage overlaps the current parent's custom native session directory", () => {
  probe(
    hostFixture +
      String.raw`
    const f = host();
    const config = path.join(f.ctx.cwd, "pi-subagents", "config.json");
    const sessionDir = path.join(f.ctx.cwd, "custom-sessions");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ storageDir: path.join(sessionDir, "runs") }));
    f.ctx.sessionManager.getSessionDir = () => sessionDir;
    await extension(f.pi);
    await f.emit("session_start");
    assert.ok(f.notifications.some(([message, level]) => level === "error" && message.includes("overlaps the parent session directory") && message.includes("/resume")));
    await f.emit("session_shutdown", { reason: "quit" });
  `,
  );
});

test('keeps scoped notifications, bounded full output, and widget/shortcut integration', () => {
  probe(
    hostFixture +
      String.raw`
    const config = path.join(process.env.PI_CODING_AGENT_DIR, "pi-subagents", "config.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ shortcut: "ctrl+shift+a" }));
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    assert.deepEqual([...f.shortcuts.keys()], ["ctrl+shift+a"]);
    options.onActivityChange({ parentSessionId: "other", agentName: "/ignored", active: true });
    options.onActivityChange({ parentSessionId: "parent", agentName: "/task", active: true });
    const [key, widget] = f.widgets.at(-1);
    assert.equal(key, "pi-subagents");
    const theme = { fg: (_color, text) => text };
    assert.ok(widget({}, theme).render(80).join("\n").includes("/task running"));
    assert.ok(widget({}, theme).render(30).join("\n").includes("/subagents"));
    options.onUnclaimedCompletion({ parentSessionId: "other", agentName: "/ignored", status: "completed" });
    assert.equal(f.messages.length, 0);
    const event = { parentSessionId: "parent", agentName: "/task", status: "completed", finalResponse: "answer" };
    options.onUnclaimedCompletion(event);
    assert.deepEqual(f.messages[0], { message: {
      customType: "pi-subagent-completion",
      content: "<subagent_notification>\n" + JSON.stringify({ agent_name: "/task", status: "completed", final_response: "answer" }, null, 2) + "\n</subagent_notification>",
      display: true, details: { agent_name: "/task", status: "completed" },
    }, delivery: { deliverAs: "steer", triggerTurn: true } });
    options.onUnclaimedCompletion({ ...event, finalResponse: "x".repeat(100_000) });
    const large = f.messages.at(-1).message;
    assert.ok(Buffer.byteLength(large.content) <= 50 * 1024);
    assert.ok(large.content.includes("Output truncated"));
    assert.ok(fs.readFileSync(large.details.fullOutputPath, "utf8").includes("x".repeat(100_000)));
    options.onActivityChange({ parentSessionId: "parent", agentName: "/task", active: false });
    assert.equal(f.widgets.at(-1)[1], undefined);
    await f.emit("session_shutdown", { reason: "quit" });
    options.onUnclaimedCompletion(event);
    assert.equal(f.messages.length, 2, "no stale delivery after shutdown");
  `,
  );
});

test('reports persistence/cleanup errors on every shutdown reason even if widget cleanup fails', () => {
  probe(
    hostFixture +
      String.raw`
    for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
      const f = host();
      await extension(f.pi);
      await f.emit("session_start");
      const count = shutdownCalls;
      AgentManager.prototype.shutdown = async function() {
        shutdownCalls++;
        throw new AggregateError([new Error("save failed"), new Error("dispose failed")], "shutdown failed");
      };
      f.ctx.ui.setWidget = () => { throw new Error("widget cleanup failed"); };
      await f.emit("session_shutdown", { reason });
      assert.equal(shutdownCalls, count + 1);
      const errors = f.notifications.map(([message]) => message).join("\n");
      for (const text of ["widget cleanup failed", "save failed", "dispose failed"]) assert.ok(errors.includes(text), errors);
    }
  `,
  );
});

const runtimes: Array<[string, string]> = [['Bun', process.execPath]];
if (Bun.which('node')) runtimes.push(['Node', Bun.which('node')!]);

test.each(runtimes)(
  'preserves multiline template text through real SDK tools, reload and child input (%s)',
  (_name, executable) => {
    probe(
      String.raw`
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import * as path from "node:path";
    process.env.PI_OFFLINE = "1";
    const { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
    const { configureCoreFixture } = await import(${JSON.stringify(pathToFileURL(path.join(packageDir, 'tests', 'fixtures', 'core-sdk-fixture.ts')).href)});
    const { getCurrentTools } = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))});
    const fixturePath = ${JSON.stringify(CORE_SDK_EXTENSION)};
    const fixture = configureCoreFixture();
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const directory = path.join(agentDir, "pi-subagents");
    const templatePath = path.join(directory, "agents", "multiline.md");
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ defaults: { extensions: [fixturePath] } }));
    const template = [
      "---", "name: multiline", "description: |-", "  First exploration line.", "  <rules>",
      "    <rule>Reuse & trust.</rule>", "  </rules>", "hint: |-", "  Give exact paths.", "  - Narrow scope.",
      "provider: test", "model: fake", "thinking: off", "tools: read", "---", "Child template instructions.",
    ].join("\n");
    fs.writeFileSync(templatePath, template);
    const settings = { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
    const settingsManager = SettingsManager.inMemory(settings);
    settingsManager.setProjectTrusted(true);
    const services = await createAgentSessionServices({
      cwd: agentDir, agentDir, settingsManager, resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [process.argv[2], fixturePath],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const model = (await services.modelRuntime.getAvailable("test")).find(model => model.id === "fake");
    const { session } = await createAgentSessionFromServices({ services, model, sessionManager: SessionManager.inMemory(agentDir) });
    const errors = [];
    try {
      await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
      const spawnTool = () => session.getToolDefinition("spawn_agent");
      const schema = JSON.stringify(spawnTool().parameters);
      const checkDescription = (description, firstLine) => {
        assert.ok(description.includes("  Description:\n    " + firstLine + "\n    <rules>\n      <rule>Reuse & trust.</rule>\n    </rules>"), description);
        assert.ok(description.includes("  Caller hint:\n    Give exact paths.\n    - Narrow scope."), description);
        assert.ok(description.includes("model: test/fake — thinking: off"), description);
        assert.ok(!description.includes("Child template instructions."));
      };
      checkDescription(spawnTool().description, "First exploration line.");
      await session.prompt("Inspect template descriptions.");
      checkDescription(getCurrentTools(fixture.instances[0].requests.at(-1).context.messages).find(tool => tool.name === "spawn_agent").description, "First exploration line.");
      const ctx = session.extensionRunner.createContext();
      const result = await spawnTool().execute("spawn", { task_name: "multiline-child", agent_type: "multiline", message: "work" }, undefined, undefined, ctx);
      const waited = await session.getToolDefinition("wait_agent").execute("wait", { targets: ["multiline-child"] }, undefined, undefined, ctx);
      assert.equal(JSON.parse(waited.content[0].text).event.status, "completed");
      assert.equal(result.details.provider, "test");
      assert.equal(result.details.modelId, "fake");
      assert.equal(result.details.thinking, "off");
      assert.equal(fixture.instances.at(-1).inputs[0].text, "Child template instructions.\n\nwork");
      fs.writeFileSync(templatePath, template.replace("First exploration line.", "Updated exploration line.").replace("\nhint: |-", "\ncaller_hint: |-"));
      await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      assert.equal(JSON.stringify(spawnTool().parameters), schema);
      await session.prompt("Inspect refreshed template descriptions.");
      checkDescription(getCurrentTools(fixture.instances[0].requests.at(-1).context.messages).find(tool => tool.name === "spawn_agent").description, "Updated exploration line.");
      assert.deepEqual(errors, []);
    } finally {
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { session.dispose(); }
    }
  `,
      executable,
    );
  },
);

test.each(runtimes)(
  'validates dynamic spawn schemas and enforces thinking overrides with real SDK children (%s)',
  (_name, executable) => {
    probe(
      String.raw`
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import * as path from "node:path";
    process.env.PI_OFFLINE = "1";
    const { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
    const { validateToolArguments } = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))});
    const fixturePath = ${JSON.stringify(path.join(packageDir, 'tests', 'fixtures', 'core-sdk-fixture.ts'))};
    const { configureCoreFixture } = await import(${JSON.stringify(pathToFileURL(path.join(packageDir, 'tests', 'fixtures', 'core-sdk-fixture.ts')).href)});
    const nativeThinking = [];
    const fixture = configureCoreFixture({
      routes: [["test", "fake"], ["test", "fake:high"], ["test", "template-model"], ["template-provider", "template-model"],
        ["tenant/gateway", "accounts/team/model"], ["tenant/gateway", "accounts/team/model:high"],
        ["llama.cpp/http://localhost:8080", "repo/model:high"]],
      onStart: pi => { nativeThinking.push(pi.getThinkingLevel()); },
    });
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const settings = { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
    const config = path.join(agentDir, "pi-subagents", "config.json");
    const templates = path.join(path.dirname(config), "agents");
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(path.join(templates, "routed.md"), "---\nname: routed\nprovider: template-provider\nmodel: template-model\nthinking: medium\n---\n");
    fs.writeFileSync(path.join(templates, "model-only.md"), "---\nname: model-only\nmodel: template-model\n---\n");
    const writeConfig = models => fs.writeFileSync(config, JSON.stringify({ defaults: { extensions: [fixturePath] }, ...(models ? { models } : {}) }));
    writeConfig();
    const settingsManager = SettingsManager.inMemory(settings);
    settingsManager.setProjectTrusted(true);
    const services = await createAgentSessionServices({
      cwd: agentDir, agentDir, settingsManager, resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [process.argv[2], fixturePath],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const model = (await services.modelRuntime.getAvailable("test")).find(model => model.id === "fake");
    assert.ok(model);
    const { session } = await createAgentSessionFromServices({ services, model, thinkingLevel: "off", sessionManager: SessionManager.inMemory(agentDir) });
    const errors = [];
    try {
      await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
      const ctx = session.extensionRunner.createContext();
      const spawnTool = () => session.getToolDefinition("spawn_agent");
      const validate = args => validateToolArguments(spawnTool(), { type: "toolCall", id: "routing", name: "spawn_agent", arguments: args });
      const execute = args => spawnTool().execute("routing", args, undefined, undefined, ctx);
      const spawn = async (task_name, extra = {}) => {
        const result = await execute(validate({ task_name, message: "work", ...extra }));
        const child = fixture.instances.at(-1);
        assert.equal(child.ctx.model.provider, result.details.provider);
        assert.equal(child.ctx.model.id, result.details.modelId);
        assert.equal(nativeThinking.at(-1), result.details.thinking);
        const waited = await session.getToolDefinition("wait_agent").execute("wait", { targets: [task_name] }, undefined, undefined, ctx);
        assert.equal(JSON.parse(waited.content[0].text).event.status, "completed");
        return result.details;
      };
      assert.equal(spawnTool().parameters.properties.thinking, undefined);
      const hidden = validate({ task_name: "hidden", message: "work", thinking: "high" });
      assert.equal(hidden.thinking, "high", "native validation permits this undeclared extra property");
      const initialChildren = fixture.instances.length;
      await assert.rejects(execute(hidden), /thinking.*configured spawn models/);
      assert.equal(fixture.instances.length, initialChildren, "rejection must precede child creation");
      assert.equal((await spawn("inherited")).thinking, "off");
      assert.equal((await spawn("template-inherited", { agent_type: "routed" })).thinking, "medium");

      const allowedModels = ["test/fake", "test/fake:high", "tenant/gateway/accounts/team/model",
        "tenant/gateway/accounts/team/model:high", "llama.cpp/http://localhost:8080/repo/model:high"];
      writeConfig([...allowedModels, "tenant/gateway/accounts/team/model:medium"]);
      await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      const schema = JSON.parse(JSON.stringify(spawnTool().parameters));
      assert.deepEqual(schema.required, ["task_name", "message"]);
      assert.deepEqual(schema.properties.model, { type: "string", enum: allowedModels, description: schema.properties.model.description });
      assert.deepEqual(schema.properties.thinking, { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: schema.properties.thinking.description });
      assert.ok(!JSON.stringify(schema).includes("\"~"), "TypeBox internals must not leak into the provider-facing schema");
      assert.equal(validate({ task_name: "optional", message: "work" }).thinking, undefined);
      for (const thinking of schema.properties.thinking.enum) assert.equal(validate({ task_name: "valid", message: "work", thinking }).thinking, thinking);
      const beforeInvalid = fixture.instances.length;
      for (const thinking of ["invalid", "HIGH", "", null, false, 1, [], {}]) {
        await assert.rejects(execute({ task_name: "invalid", message: "work", thinking }), /thinking.*(one of|level)/);
      }
      for (const thinking of ["invalid", "HIGH", "", false, 1, [], {}]) {
        assert.throws(() => validate({ task_name: "invalid", message: "work", thinking }), /thinking/);
      }
      assert.throws(() => validate({ task_name: "invalid-model", message: "work", model: "test/not-allowed" }), /model/);
      assert.equal(fixture.instances.length, beforeInvalid);
      assert.equal((await spawn("ordinary", { model: "test/fake" })).modelId, "fake");
      const colon = await spawn("colon", { model: "test/fake:high" });
      assert.equal(colon.modelId, "fake:high");
      assert.equal(colon.thinking, "off", "the exact ID suffix is not a thinking override");
      for (const [task, model, provider, modelId] of [
        ["slash-provider", "tenant/gateway/accounts/team/model", "tenant/gateway", "accounts/team/model"],
        ["slash-provider-colon", "tenant/gateway/accounts/team/model:high", "tenant/gateway", "accounts/team/model:high"],
        ["url-provider", "llama.cpp/http://localhost:8080/repo/model:high", "llama.cpp/http://localhost:8080", "repo/model:high"],
      ]) {
        const routed = await spawn(task, { model });
        assert.equal(routed.provider, provider);
        assert.equal(routed.modelId, modelId);
        assert.equal(routed.thinking, "off", "a routing suffix must not change inherited thinking");
      }
      const overridden = await spawn("caller-priority", { agent_type: "routed", model: "test/fake:high", thinking: "high" });
      assert.equal(overridden.provider, "test");
      assert.equal(overridden.modelId, "fake:high");
      assert.equal(overridden.thinking, "high");
      assert.equal((await spawn("thinking-only", { thinking: "low" })).thinking, "low");
      assert.equal((await spawn("template-priority", { model: "test/fake", agent_type: "routed" })).thinking, "medium");

      const stale = validate({ task_name: "stale", message: "work", thinking: "high" });
      writeConfig(["missing/model"]);
      await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      assert.equal(spawnTool().parameters.properties.model, undefined);
      assert.equal(spawnTool().parameters.properties.thinking, undefined);
      await assert.rejects(execute(stale), /thinking.*configured spawn models/);
      assert.equal((await spawn("inherited-again")).thinking, "off");
      const first = await spawn("model-only-first", { agent_type: "model-only" });
      assert.equal(first.provider, "test");
      assert.equal(first.modelId, "template-model");
      await session.setModel(session.modelRuntime.getModel("template-provider", "template-model"));
      const changed = await spawn("model-only-current", { agent_type: "model-only" });
      assert.equal(changed.provider, "template-provider");
      assert.equal(changed.modelId, "template-model");
      assert.deepEqual(errors, []);
    } finally {
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { session.dispose(); }
    }
  `,
      executable,
    );
  },
);

test.each(runtimes)(
  'runs six registered tools and repeated child cleanup alongside an active SDK parent (%s)',
  (_name, executable) => {
    probe(
      String.raw`
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import * as path from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    import * as net from "node:net";
    const { AgentSession, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
    const { createAssistantMessageEventStream } = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))});
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const fixtureSource = ${JSON.stringify(path.join(packageDir, 'tests', 'fixtures', 'sdk-offline-extension.ts'))};
    const fixture = (name, prefix) => {
      const directory = path.join(agentDir, name);
      fs.mkdirSync(directory);
      const extension = path.join(directory, "extension.ts");
      fs.copyFileSync(fixtureSource, extension);
      fs.writeFileSync(path.join(directory, "sdk-fixture.json"), JSON.stringify({ prefix, responseGate: true }));
      return { directory, extension };
    };
    const childFixture = fixture("child-provider", "child");
    const config = path.join(agentDir, "pi-subagents", "config.json");
    fs.mkdirSync(path.dirname(config));
    fs.writeFileSync(config, JSON.stringify({ retentionDays: 0, defaults: { extensions: [childFixture.extension] } }));
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    settingsManager.setProjectTrusted(false);
    let drive, driverError, finishDriver, releaseParent;
    const driverFinished = new Promise(resolve => { finishDriver = resolve; });
    const parentHold = new Promise(resolve => { releaseParent = resolve; });
    const services = await createAgentSessionServices({
      cwd: agentDir, agentDir, settingsManager,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [process.argv[2]],
        extensionFactories: [pi => {
          let request = 0;
          pi.registerProvider("sdk-offline", {
            api: "host-offline", apiKey: "offline-only", baseUrl: "http://offline.invalid",
            models: [{ id: "exact/model", name: "Offline host", reasoning: false, input: ["text"],
              contextWindow: 500_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
            streamSimple(model) {
              const stream = createAssistantMessageEventStream();
              const first = request++ === 0;
              const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
                content: first ? [
                  { type: "toolCall", id: "host-driver-call", name: "host_driver", arguments: {} },
                  { type: "toolCall", id: "parent-hold-call", name: "parent_hold", arguments: {} },
                ] : [{ type: "text", text: "parent: complete" }],
                stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              };
              stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: message.stopReason, message });
              stream.end();
              return stream;
            },
          });
          pi.registerTool({ name: "host_driver", label: "Host test", description: "Offline six-tool driver",
            parameters: { type: "object", properties: {} },
            async execute(_id, _args, _signal, _update, ctx) {
              try {
                await drive(ctx);
                return { content: [{ type: "text", text: "six tools verified" }], details: {} };
              } catch (error) { driverError = error; throw error; }
              finally { finishDriver(); }
            },
          });
          pi.registerTool({ name: "parent_hold", label: "Hold parent", description: "Keep parent work active independently",
            parameters: { type: "object", properties: {} },
            async execute() { await parentHold; return { content: [{ type: "text", text: "parent released" }], details: {} }; },
          });
        }],
      },
    });
    assert.ok(!services.diagnostics.some(diagnostic => diagnostic.type === "error"));
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const model = (await services.modelRuntime.getAvailable("sdk-offline")).find(model => model.id === "exact/model");
    assert.ok(model);
    const { session } = await createAgentSessionFromServices({ services, model, sessionManager: SessionManager.inMemory(agentDir) });
    const errors = [], called = new Set();
    let parentRun, restoreCounters = () => {};
    try {
      await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
      // Count child lifecycle calls and observer resources.
      const childSessions = new Set(), subscriptions = new Set(), timeouts = new Set(), intervals = new Set(), servers = new Set();
      let created = 0, disposed = 0;
      const subscribe = AgentSession.prototype.subscribe, dispose = AgentSession.prototype.dispose;
      AgentSession.prototype.subscribe = function(listener) {
        const unsubscribe = subscribe.call(this, listener);
        if (this === session) return unsubscribe;
        if (!childSessions.has(this)) { childSessions.add(this); created++; }
        const token = {};
        subscriptions.add(token);
        return () => { subscriptions.delete(token); unsubscribe(); };
      };
      AgentSession.prototype.dispose = function(...args) {
        try { return dispose.apply(this, args); }
        finally { if (childSessions.delete(this)) disposed++; }
      };
      const originalTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
      globalThis.setTimeout = (callback, ms, ...args) => {
        const timer = originalTimers.setTimeout(() => { timeouts.delete(timer); callback(...args); }, ms);
        timeouts.add(timer);
        return timer;
      };
      globalThis.clearTimeout = timer => { timeouts.delete(timer); return originalTimers.clearTimeout(timer); };
      globalThis.setInterval = (...args) => { const timer = originalTimers.setInterval(...args); intervals.add(timer); return timer; };
      globalThis.clearInterval = timer => { intervals.delete(timer); return originalTimers.clearInterval(timer); };
      const listen = net.Server.prototype.listen;
      net.Server.prototype.listen = function(...args) {
        servers.add(this);
        this.once("close", () => servers.delete(this));
        try { return listen.apply(this, args); } catch (error) { servers.delete(this); throw error; }
      };
      restoreCounters = () => {
        AgentSession.prototype.subscribe = subscribe; AgentSession.prototype.dispose = dispose;
        Object.assign(globalThis, originalTimers); net.Server.prototype.listen = listen;
      };
      const counts = () => ({ sessions: childSessions.size, subscriptions: subscriptions.size, timeouts: timeouts.size, intervals: intervals.size, servers: servers.size });
      const empty = { sessions: 0, subscriptions: 0, timeouts: 0, intervals: 0, servers: 0 };
      const reclaimed = async label => {
        const deadline = Date.now() + 2_000;
        while (Object.values(counts()).some(Boolean) && Date.now() < deadline) await delay(5);
        assert.deepEqual(counts(), empty, label);
        assert.equal(created, disposed, label);
        const files = fs.readdirSync(agentDir, { recursive: true });
        assert.ok(!files.some(file => /\.(active\.json|sock)$/.test(String(file))), label + ": observer files remain");
      };
      // The assistant-issued host_driver call exercises native nested-tool validation, hooks, and recording.
      drive = async ctx => {
        const call = async (name, args, options) => {
          called.add(name);
          const result = await ctx.executeTool(name, args, options);
          assert.ok(!result.isError, JSON.stringify(result));
          return result.result;
        };
        assert.equal(session.isStreaming, true);
        const spawned = await call("spawn_agent", { task_name: "worker", message: "child work" });
        assert.equal(spawned.details.task_name, "/worker");
        assert.equal((await call("list_agents", {})).details.agents[0].agent_status, "running");
        assert.equal((await call("send_message", { target: "/worker", message: "steered work" })).details.delivery, "steer");
        const controller = new AbortController();
        const canceledWait = ctx.executeTool("wait_agent", { targets: ["worker"] }, { signal: controller.signal });
        await delay(5);
        controller.abort(new Error("cancel only the wait"));
        assert.equal((await canceledWait).isError, true);
        assert.equal((await call("list_agents", {})).details.agents[0].agent_status, "running");
        const waiting = call("wait_agent", { targets: ["worker"] });
        await delay(5);
        fs.writeFileSync(path.join(childFixture.directory, "release-response"), "");
        const completion = JSON.parse((await waiting).content[0].text).event;
        assert.equal(completion.status, "completed");
        assert.equal(completion.finalResponse, "child: steered work");
        await reclaimed("initial completion");
        const read = JSON.parse((await call("read_agent_response", { target: "worker" })).content[0].text);
        assert.equal(read.finalResponse, "child: steered work");
        settingsManager.setProjectTrusted(true);
        assert.equal((await call("send_message", { target: "worker", message: "resumed work" })).details.delivery, "prompt");
        const resumed = JSON.parse((await call("wait_agent", { targets: ["worker"] })).content[0].text);
        assert.equal(resumed.event.finalResponse, "child: resumed work");
        const events = fs.readFileSync(path.join(childFixture.directory, "sdk-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert.deepEqual(events.filter(event => event.type === "session_start").map(event => event.trusted), [false, true]);
        await reclaimed("first resumption");
        for (let turn = 0; turn < 8; turn++) {
          await call("send_message", { target: "worker", message: "repeat " + turn });
          const result = JSON.parse((await call("wait_agent", { targets: ["worker"] })).content[0].text);
          assert.equal(result.event.finalResponse, "child: repeat " + turn);
          await reclaimed("repeated resumption " + turn);
          assert.equal(session.isStreaming, true);
        }
        fs.rmSync(path.join(childFixture.directory, "release-response"));
        await call("spawn_agent", { task_name: "canceled", message: "cancel child work" });
        assert.equal((await call("interrupt_agent", { target: "canceled" })).details.previous_status, "running");
        assert.equal((await call("list_agents", {})).details.agents.find(agent => agent.agent_name === "/canceled").agent_status, "interrupted");
        await reclaimed("interruption");
        assert.equal(created, 11);
        assert.equal(disposed, 11);
        assert.equal(session.isStreaming, true, "child work/cancellation must not stop the active parent turn");
        assert.deepEqual([...called].sort(), ${JSON.stringify([...toolNames].sort())});
      };
      parentRun = session.prompt("run the offline host driver").then(() => session.waitForIdle());
      void parentRun.catch(() => {});
      await driverFinished;
      if (driverError) throw driverError;
      releaseParent();
      await parentRun;
      assert.ok(session.getLastAssistantText().startsWith("parent:"));
      const driverResult = session.messages.find(message => message.role === "toolResult" && message.toolName === "host_driver");
      assert.ok(driverResult && !driverResult.isError);
      assert.deepEqual([...new Set(driverResult.nestedCalls.calls.map(call => call.name))].sort(), ${JSON.stringify([...toolNames].sort())});
      assert.deepEqual(errors, []);
    } finally {
      releaseParent();
      fs.writeFileSync(path.join(childFixture.directory, "release-response"), "");
      await session.abort();
      await parentRun?.catch(() => {});
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { session.dispose(); restoreCounters(); }
    }
  `,
      executable,
    );
  },
);

test.each(runtimes)(
  'uses native parent new/resume/fork/reload/quit lifecycles to clean up children (%s)',
  (_name, executable) => {
    probe(
      String.raw`
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import * as path from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const fixtureSource = ${JSON.stringify(path.join(packageDir, 'tests', 'fixtures', 'sdk-offline-extension.ts'))};
    const provider = name => {
      const directory = path.join(agentDir, name);
      fs.mkdirSync(directory);
      const extension = path.join(directory, "extension.ts");
      fs.copyFileSync(fixtureSource, extension);
      fs.writeFileSync(path.join(directory, "sdk-fixture.json"), JSON.stringify({ responseGate: true }));
      return { directory, extension };
    };
    const parent = provider("parent"), child = provider("child");
    fs.writeFileSync(path.join(parent.directory, "release-response"), "");
    const config = path.join(agentDir, "pi-subagents", "config.json");
    fs.mkdirSync(path.dirname(config));
    fs.writeFileSync(config, JSON.stringify({ retentionDays: 0, defaults: { extensions: [child.extension] } }));
    const started = [], stopped = [], errors = [];
    const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      settingsManager.setProjectTrusted(false);
      const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [process.argv[2], parent.extension],
        extensionFactories: [pi => {
          pi.on("session_start", event => { started.push(event.reason); });
          pi.on("session_shutdown", event => { stopped.push(event.reason); });
        }],
      } });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const model = (await services.modelRuntime.getAvailable("sdk-offline")).find(model => model.id === "exact/model");
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, {
      cwd: agentDir, agentDir, sessionManager: SessionManager.create(agentDir, path.join(agentDir, "native-sessions")),
    });
    const bind = session => session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    let disposed = false, closed = 0;
    const startChild = async task => {
      const session = runtime.session, ctx = session.extensionRunner.createContext();
      const result = await session.getToolDefinition("spawn_agent").execute("lifecycle-probe", { task_name: task, message: "pending child " + task }, undefined, undefined, ctx);
      assert.equal(result.details.task_name, "/" + task);
      return ctx.sessionManager.getSessionId();
    };
    const checkClosed = async (task, parentId) => {
      const deadline = Date.now() + 2_000;
      let files;
      do { files = fs.readdirSync(agentDir, { recursive: true }).map(String);
        if (!files.some(file => /\.(active\.json|sock)$/.test(file))) break;
        await delay(5);
      } while (Date.now() < deadline);
      assert.ok(!files.some(file => /\.(active\.json|sock)$/.test(file)));
      const info = files.filter(file => file.endsWith(".info.json")).map(file => JSON.parse(fs.readFileSync(path.join(agentDir, file), "utf8")))
        .find(info => info.taskName === task && info.parentSessionId === parentId);
      assert.equal(info?.status, "interrupted");
      const events = fs.readFileSync(path.join(child.directory, "sdk-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.type === "shutdown_finished").length, ++closed);
    };
    try {
      await runtime.session.prompt("seed a persistent parent session");
      const originalFile = runtime.session.sessionFile;
      const entryId = runtime.session.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user").id;
      let owner = await startChild("on-new");
      assert.deepEqual(await runtime.newSession(), { cancelled: false });
      await checkClosed("on-new", owner);
      owner = await startChild("on-resume");
      assert.deepEqual(await runtime.switchSession(originalFile), { cancelled: false });
      await checkClosed("on-resume", owner);
      owner = await startChild("on-fork");
      assert.equal((await runtime.fork(entryId, { position: "at" })).cancelled, false);
      await checkClosed("on-fork", owner);
      owner = await startChild("on-reload");
      await runtime.session.reload();
      await checkClosed("on-reload", owner);
      owner = await startChild("on-quit");
      await runtime.dispose();
      disposed = true;
      await checkClosed("on-quit", owner);
      assert.deepEqual(started, ["startup", "new", "resume", "fork", "reload"]);
      assert.deepEqual(stopped, ["new", "resume", "fork", "reload", "quit"]);
      assert.deepEqual(errors, []);
    } finally {
      fs.writeFileSync(path.join(child.directory, "release-response"), "");
      if (!disposed) await runtime.dispose();
    }
  `,
      executable,
    );
  },
);

const loaderSmoke = `
  import assert from "node:assert/strict";
  import * as fs from "node:fs";
  import * as path from "node:path";
  const { DefaultResourceLoader, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const loader = new DefaultResourceLoader({
    cwd: agentDir, agentDir, settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [process.argv[2]],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()], ${JSON.stringify(toolNames)});
  assert.ok(extension.commands.has("subagents"));
  for (const { definition } of extension.tools.values()) {
    const schema = JSON.parse(JSON.stringify(definition.parameters));
    assert.equal(schema.type, "object");
    assert.ok(typeof definition.execute === "function");
  }
  assert.equal(fs.existsSync(path.join(agentDir, "pi-subagents", "runs")), false, "file loading alone must not initialize manager resources");
  for (const shutdown of extension.handlers.get("session_shutdown") ?? []) await shutdown({ type: "session_shutdown", reason: "quit" }, {});
`;

test("loads the source through Pi's real TypeScript extension loader on Bun", () =>
  probe(loaderSmoke));
test.skipIf(!Bun.which('node'))(
  "loads the source through Pi's real TypeScript extension loader on Node",
  () => probe(loaderSmoke, Bun.which('node')!),
);

test('packs runtime.ts without an SDK copy and loads the extracted package through Pi', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pack-'));
  try {
    const packed = Bun.spawnSync(
      ['npm', 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', temporary],
      { cwd: packageDir, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
    );
    if (packed.exitCode !== 0) throw new Error(new TextDecoder().decode(packed.stderr));
    const [metadata] = JSON.parse(new TextDecoder().decode(packed.stdout));
    expect(metadata.files.map((file: { path: string }) => file.path).sort()).toEqual(
      [
        'LICENSE',
        'README.md',
        'src/core.ts',
        'src/index.ts',
        'package.json',
        'src/peek.ts',
        'src/runtime.ts',
      ].sort(),
    );
    const unpacked = Bun.spawnSync(
      ['tar', '-xzf', path.join(temporary, metadata.filename), '-C', temporary],
      { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 },
    );
    if (unpacked.exitCode !== 0) throw new Error(new TextDecoder().decode(unpacked.stderr));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(temporary, 'package', 'package.json'), 'utf8'),
    );
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.bundledDependencies).toBeUndefined();
    for (const name of ['pi-ai', 'pi-coding-agent', 'pi-tui']) {
      expect(manifest.peerDependencies['@earendil-works/' + name]).toBe('>=1.0.0');
      expect(manifest.devDependencies['@earendil-works/' + name]).toBe('1.5.0');
    }
    expect(manifest.engines.node).toBe('>=22.19.0');
    expect(manifest.pi.extensions).toEqual(['./src/index.ts']);
    const packedEntry = path.join(temporary, 'package', 'src', 'index.ts');
    probe(loaderSmoke, process.execPath, packedEntry);
    if (Bun.which('node')) probe(loaderSmoke, Bun.which('node')!, packedEntry);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

describe('extension completion delivery and TUI', () => {
  test('collects native codemode renderers through the real extension API without registering or activating another tool', async () => {
    const { default: subagentExtension } = await import('../src/index.js');
    const loader = new codingAgent.DefaultResourceLoader({
      cwd: TEST_AGENT_DIR,
      agentDir: TEST_AGENT_DIR,
      settingsManager: codingAgent.SettingsManager.inMemory({}),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [codingAgent.createCodemodeExtension(), subagentExtension],
    });
    try {
      await loader.reload();
      const loaded = loader.getExtensions();
      expect(loaded.errors).toEqual([]);
      expect(loaded.extensions).toHaveLength(2);
      const [native, subagents] = loaded.extensions;
      const definition = native.tools.get('codemode')!.definition;
      expect(definition.defaultActive).toBe(false);
      const collected = {
        renderShell: definition.renderShell,
        renderCall: definition.renderCall,
        renderResult: definition.renderResult,
      };
      expect([...native.tools.keys()]).toEqual(['codemode']);
      expect([...subagents.tools.keys()]).toEqual([
        'spawn_agent',
        'wait_agent',
        'list_agents',
        'read_agent_response',
        'send_message',
        'interrupt_agent',
      ]);
      expect(() => loaded.runtime.getActiveTools()).toThrow('Extension runtime not initialized');

      const parentId = 'renderer-contract-parent';
      const scope = path.join(getRunsDir(), parentScopeKey(parentId));
      fs.mkdirSync(scope, { recursive: true });
      const id = randomUUID();
      const info: AgentInfo = {
        id,
        parentSessionId: parentId,
        taskName: 'contract',
        canonicalName: '/contract',
        status: 'completed',
        cwd: TEST_AGENT_DIR,
        provider: 'test',
        modelId: 'fake',
        model: 'test:fake',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
        sessionFile: path.join(scope, `${id}.jsonl`),
        infoFile: path.join(scope, `${id}.info.json`),
        logFile: path.join(scope, `${id}.log`),
      };
      fs.writeFileSync(info.infoFile, JSON.stringify(info));
      const settings = {
        terminal: { showImages: false, imageWidthCells: 42 },
        outputPad: 0 as const,
      };
      loaded.runtime.getSettings = mock(() => settings);
      let opened = 0;
      const ctx: any = {
        mode: 'tui',
        sessionManager: { getSessionId: () => parentId },
        ui: {
          setWidget() {},
          async custom(create: any) {
            const component = create(
              { terminal: { rows: 80 }, requestRender() {} },
              { fg: (_color: string, text: string) => text, bold: (text: string) => text },
              {},
              () => {},
            );
            if (opened++ === 0)
              return { task: 'contract', parentSessionId: parentId, includeAll: false };
            try {
              expect(component).toBeInstanceOf(SubagentPeekOverlay);
              expect(component['nativeCodemodeRenderers']).toEqual(collected);
              expect(Object.keys(component['nativeCodemodeRenderers'])).toEqual([
                'renderShell',
                'renderCall',
                'renderResult',
              ]);
              expect(component['toolExecutionOptions']).toEqual({
                showImages: false,
                imageWidthCells: 42,
                outputPad: 0,
              });
              component.handleInput('\x0f');
              expect(component['disposed']).toBe(false);
            } finally {
              component.dispose();
            }
            return undefined;
          },
        },
      };
      try {
        await subagents.commands.get('subagents')!.handler('', ctx);
        expect(opened).toBe(2);
        expect(loaded.runtime.getSettings).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(scope, { recursive: true, force: true });
      }
    } finally {
      for (const extension of loader.getExtensions().extensions) {
        for (const shutdown of extension.handlers.get('session_shutdown') ?? []) {
          await shutdown({ type: 'session_shutdown' }, {} as any);
        }
      }
    }
  });

  test.each([undefined, '', 'ctrl+shift+a'])(
    'opens the browser with optional shortcut %s',
    async (shortcut) => {
      const configFile = path.join(TEST_AGENT_DIR, 'pi-subagents', 'config.json');
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify({ shortcut }));
      const commands = new Map<string, any>();
      const shortcuts = new Map<string, any>();
      let shutdown: (() => Promise<void>) | undefined;
      let menusOpened = 0;
      const ctx: any = {
        mode: 'tui',
        sessionManager: { getSessionId: () => 'shortcut-test-parent' },
        ui: {
          setWidget() {},
          async custom(create: any) {
            const theme = {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            };
            const menu = create({ requestRender() {} }, theme, {}, () => {});
            try {
              expect(menu.render(80).join('\n')).toContain('Subagents');
              menusOpened++;
              return undefined;
            } finally {
              menu.dispose?.();
            }
          },
        },
      };
      const { default: subagentExtension } = await import('../src/index.js');
      try {
        await subagentExtension({
          on(name: string, handler: any) {
            if (name === 'session_shutdown') shutdown = handler;
          },
          registerTool() {},
          registerMessageRenderer() {},
          registerCommand(name: string, command: any) {
            commands.set(name, command);
          },
          registerShortcut(key: string, options: any) {
            shortcuts.set(key, options);
          },
        } as any);
        expect([...commands.keys()]).toEqual(['subagents']);
        expect([...shortcuts.keys()]).toEqual(shortcut ? [shortcut] : []);
        await commands.get('subagents').handler('', ctx);
        expect(menusOpened).toBe(1);
        if (shortcut) {
          await shortcuts.get(shortcut).handler(ctx);
          expect(menusOpened).toBe(2);
        }
      } finally {
        await shutdown?.();
        fs.rmSync(configFile, { force: true });
      }
    },
  );

  describe('agent browser', () => {
    async function withBrowser(run: (fixture: any) => Promise<void>) {
      const parentId = `browser-${randomUUID()}`;
      const otherId = `other-${randomUUID()}`;
      const scopes = new Set<string>();
      const records = new Map<string, AgentInfo>();
      let sequence = 0;
      const put = (name: string, overrides: Partial<AgentInfo> = {}, parent = parentId) => {
        const scope = path.join(getRunsDir(), parentScopeKey(parent));
        scopes.add(scope);
        fs.mkdirSync(scope, { recursive: true });
        const previous = records.get(`${parent}/${name}`);
        const id = previous?.id ?? randomUUID();
        const now = Date.now() + sequence++;
        const info: AgentInfo = {
          id,
          taskName: name,
          canonicalName: `/${name}`,
          parentSessionId: parent,
          status: 'completed',
          cwd: TEST_AGENT_DIR,
          provider: 'test',
          modelId: 'fake',
          thinking: 'off',
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
          infoFile: path.join(scope, `${id}.info.json`),
          sessionFile: path.join(scope, `${id}.jsonl`),
          logFile: path.join(scope, `${id}.log`),
          ...previous,
          ...overrides,
        };
        records.set(`${parent}/${name}`, info);
        fs.writeFileSync(info.infoFile, JSON.stringify(info));
        return info;
      };
      const commands = new Map<string, any>();
      const tools = new Map<string, any>();
      let shutdown: (() => Promise<void>) | undefined;
      const { default: subagentExtension } = await import('../src/index.js');

      const originalList = AgentManager.prototype.listAgents;
      const originalInfos = AgentManager.prototype.listAgentInfos;
      const originalInfo = AgentManager.prototype.getAgentInfo;
      const originalConnect = (SubagentPeekOverlay.prototype as any).connectSocket;
      const list = mock(function (
        this: AgentManager,
        ...args: Parameters<AgentManager['listAgentInfos']>
      ) {
        return originalInfos.apply(this, args);
      });
      AgentManager.prototype.listAgentInfos = list;
      (SubagentPeekOverlay.prototype as any).connectSocket = () => {};
      const requestRender = mock(() => {});
      const selections: any[] = [];
      const opened: AgentInfo[] = [];
      const notify = mock((_message: string, _level?: string) => {});
      const theme = {
        ansi: '',
        fg(_color: string, text: string) {
          return this.ansi ? `${this.ansi}${text}\x1b[0m` : text;
        },
        bold: (text: string) => text,
      };
      const ctx: any = {
        mode: 'tui',
        sessionManager: { getSessionId: () => parentId },
        ui: { notify, setWidget() {} },
      };
      const fixture = {
        tools,
        parentId,
        otherId,
        put,
        list,
        selections,
        opened,
        ctx,
        theme,
        requestRender,
        notify,
        tui: { terminal: { rows: 40 }, requestRender } as any,
        remove(info: AgentInfo) {
          fs.rmSync(info.infoFile, { force: true });
        },
        command: () => commands.get('subagents').handler('', ctx),
        async open(
          interact: (browser: any) => any,
          overlay?: (component: any, index: number) => any,
        ) {
          ctx.ui.custom = async (create: any) => {
            let component: any;
            let result: any;
            const done = (value: any) => {
              result = value;
              if (!(component instanceof SubagentPeekOverlay)) selections.push(value);
              component?.dispose?.();
            };
            component = create(fixture.tui, theme, {}, done);
            try {
              if (component instanceof SubagentPeekOverlay) {
                opened.push(component['info']);
                await overlay?.(component, opened.length - 1);
              } else {
                await interact(component);
              }
              return result;
            } finally {
              component.dispose?.();
            }
          };
          await fixture.command();
        },
      };
      try {
        await subagentExtension({
          on(name: string, handler: any) {
            if (name === 'session_shutdown') shutdown = handler;
          },
          registerTool(tool: any) {
            tools.set(tool.name, tool);
          },
          registerMessageRenderer() {},
          registerCommand(name: string, command: any) {
            commands.set(name, command);
          },
          registerShortcut() {},
          getSettings: () => ({ terminal: { showImages: false }, outputPad: 0 }),
        } as any);
        await run(fixture);
      } finally {
        await shutdown?.();
        AgentManager.prototype.listAgents = originalList;
        AgentManager.prototype.listAgentInfos = originalInfos;
        AgentManager.prototype.getAgentInfo = originalInfo;
        (SubagentPeekOverlay.prototype as any).connectSocket = originalConnect;
        for (const scope of scopes) fs.rmSync(scope, { recursive: true, force: true });
      }
    }

    const selectedRow = (browser: any, width = 120) =>
      stripVTControlCharacters(
        browser
          .render(width)
          .find((line: string) => stripVTControlCharacters(line).startsWith('› ')) ?? '',
      );

    test('reads each metadata file once per browser frame and never on a cache hit', async () => {
      await withBrowser(async (f) => {
        const own = Array.from({ length: 12 }, (_, index) => f.put(`history/${index}`));
        const other = f.put('history/0', { modelId: 'other-model' }, f.otherId);
        const tracked = new Set([...own, other].map((info) => info.infoFile));
        await f.open((browser: any) => {
          // Exclude manager startup/reconciliation and later detail lookups from this budget.
          const reads: string[] = [];
          const originalRead = fs.readFileSync;
          const read = spyOn(fs, 'readFileSync').mockImplementation(((...args: any[]) => {
            const file = String(args[0]);
            if (tracked.has(file)) reads.push(file);
            return originalRead.apply(fs, args as any);
          }) as typeof fs.readFileSync);
          const getInfo = spyOn(AgentManager.prototype, 'getAgentInfo');
          const renderSnapshot = (width: number, expected = own) => {
            reads.length = 0;
            const lines = browser.render(width);
            expect(reads).toHaveLength(expected.length);
            expect([...reads].sort()).toEqual(
              expected.map((info: AgentInfo) => info.infoFile).sort(),
            );
            return lines;
          };
          try {
            const first = renderSnapshot(120);
            reads.length = 0;
            expect(browser.render(120)).toBe(first);
            expect(reads).toEqual([]);
            for (const key of ['j', 'k', 'r']) {
              browser.handleInput(key);
              expect(reads).toEqual([]);
              renderSnapshot(120);
              reads.length = 0;
            }
            renderSnapshot(80);
            reads.length = 0;
            browser.invalidate();
            expect(reads).toEqual([]);
            renderSnapshot(80);
            reads.length = 0;
            browser.handleInput('\t');
            expect(reads).toEqual([]);
            const all = renderSnapshot(120, [...own, other]);
            reads.length = 0;
            expect(browser.render(120)).toBe(all);
            browser.handleInput('q');
            expect(reads).toEqual([]);
            expect(getInfo).not.toHaveBeenCalled();
          } finally {
            read.mockRestore();
            getInfo.mockRestore();
          }
        });
      });
    });

    test('shows task previews only when present, without context or new timers', async () => {
      const originalSet = globalThis.setInterval;
      const interval = mock(() => {
        throw new Error('The browser must not create an interval');
      });
      globalThis.setInterval = interval as any;
      try {
        await withBrowser(async (f) => {
          f.put('review', {
            createdAt: 300,
            lastTaskMessage: '中文任务 \n preview',
            contextUsage: { tokens: 50000, contextWindow: 500000, percent: 10 },
          });
          f.put('plain', { createdAt: 200 });
          f.put('empty', { createdAt: 100, lastTaskMessage: '' });
          await f.open((browser: any) => {
            const lines = browser.render(120);
            const review = lines.findIndex((line: string) => line.includes('/review'));
            const plain = lines.findIndex((line: string) => line.includes('/plain'));
            const empty = lines.findIndex((line: string) => line.includes('/empty'));
            expect(lines[review + 1]).toBe('  中文任务 preview');
            expect(plain).toBe(review + 2);
            expect(empty).toBe(plain + 1);
            expect(lines[empty + 1]).toBe('');
            expect(lines.join('\n')).not.toContain('ctx');
            expect(lines.join('\n')).not.toContain('10%/500k');
            browser.handleInput('q');
          });
        });
        expect(interval).not.toHaveBeenCalled();
      } finally {
        globalThis.setInterval = originalSet;
      }
    });

    test('keeps the 180-character task preview limit even in a wide browser', async () => {
      await withBrowser(async (f) => {
        f.put('long-preview', { lastTaskMessage: '  ' + 'x'.repeat(200) + '\n tail' });
        await f.open((browser: any) => {
          expect(browser.render(240)).toContain('  ' + 'x'.repeat(179) + '…');
          browser.handleInput('q');
        });
      });
    });

    test('refreshes saved metadata and previews with r', async () => {
      await withBrowser(async (f) => {
        f.put('live', { status: 'running', lastTaskMessage: 'initial preview' });
        await f.open((browser: any) => {
          const first = browser.render(80);
          f.put('live', { status: 'completed', lastTaskMessage: 'updated preview' });
          expect(browser.render(80)).toBe(first);
          const reads = f.list.mock.calls.length;
          browser.handleInput('r');
          expect(f.requestRender).toHaveBeenCalledTimes(1);
          expect(f.list).toHaveBeenCalledTimes(reads);
          const refreshed = browser.render(80).join('\n');
          expect(refreshed).toContain('completed');
          expect(refreshed).toContain('updated preview');
          expect(refreshed).not.toContain('initial preview');
          browser.handleInput('q');
        });
      });
    });

    test('navigates pages and clamps selection after deletion or an empty list', async () => {
      await withBrowser(async (f) => {
        const history = Array.from({ length: 12 }, (_, index) =>
          f.put(`history/${index}`, { createdAt: 100 - index }),
        );
        await f.open((browser: any) => {
          expect(browser.render(120).join('\n')).toContain('↓ 2 more');
          for (let index = 0; index < 11; index++) {
            browser.handleInput(index % 2 ? 'j' : '\x1b[B');
            browser.render(120);
          }
          expect(selectedRow(browser)).toContain('/history/11');
          expect(browser.render(120).join('\n')).toContain('↑ 2 more');
          browser.handleInput('\x1b[A');
          expect(selectedRow(browser)).toContain('/history/10');
          browser.handleInput('k');
          expect(selectedRow(browser)).toContain('/history/9');
          browser.handleInput('j');
          browser.render(120);
          browser.handleInput('j');
          browser.render(120);
          f.remove(history[11]);
          f.remove(history[10]);
          browser.handleInput('r');
          expect(selectedRow(browser)).toContain('/history/9');
          for (const info of history) f.remove(info);
          browser.handleInput('r');
          expect(browser.render(80).join('\n')).toContain('No subagents for this session');
          for (const key of ['j', 'k', '\x1b[A', '\x1b[B', '\r']) browser.handleInput(key);
          expect(f.selections).toEqual([]);
          f.put('returned');
          browser.handleInput('r');
          expect(selectedRow(browser)).toContain('/returned');
          browser.handleInput('\r');
        });
        expect(f.opened.map((info: AgentInfo) => info.canonicalName)).toEqual(['/returned']);
      });
    });

    test.each(['unrefreshed', 'r pending', 'scope pending', 'selection pending'])(
      'Enter uses the displayed item after insertion (%s)',
      async (refresh) => {
        await withBrowser(async (f) => {
          f.put('first', { createdAt: 200 });
          f.put('target', { createdAt: 100 });
          await f.open((browser: any) => {
            browser.render(120);
            browser.handleInput('j');
            expect(selectedRow(browser)).toContain('/target');
            f.put('inserted', { createdAt: 300 });
            if (refresh === 'r pending') browser.handleInput('r');
            if (refresh === 'scope pending') browser.handleInput('\t');
            if (refresh === 'selection pending') browser.handleInput('k');
            const reads = f.list.mock.calls.length;
            browser.handleInput('\r');
            expect(f.list).toHaveBeenCalledTimes(reads);
          });
          expect(f.selections).toEqual([
            { task: '/target', parentSessionId: f.parentId, includeAll: false },
          ]);
          expect(f.opened[0].canonicalName).toBe('/target');
        });
      },
    );

    test('skips a record lost while reading the snapshot and safely selects a survivor', async () => {
      await withBrowser(async (f) => {
        const gone = f.put('gone', { createdAt: 200 });
        f.put('survivor', { createdAt: 100 });
        await f.open((browser: any) => {
          const originalRead = fs.readFileSync;
          let removed = false;
          const read = spyOn(fs, 'readFileSync').mockImplementation(((...args: any[]) => {
            if (String(args[0]) === gone.infoFile) {
              f.remove(gone);
              removed = true;
            }
            return originalRead.apply(fs, args as any);
          }) as typeof fs.readFileSync);
          try {
            expect(() => browser.render(80)).not.toThrow();
            expect(removed).toBe(true);
            expect(browser.render(80).join('\n')).not.toContain('/gone');
            expect(selectedRow(browser, 80)).toContain('/survivor');
            browser.handleInput('\r');
          } finally {
            read.mockRestore();
          }
        });
        expect(f.opened[0].canonicalName).toBe('/survivor');
      });
    });

    test.each([undefined, null, 42, '', ' \t '])(
      'skips an invalid persisted task label (%s) without opening another agent',
      async (canonicalName) => {
        await withBrowser(async (f) => {
          f.put('invalid', { createdAt: 200, canonicalName });
          f.put('survivor', { createdAt: 100 });
          await f.open((browser: any) => {
            expect(browser.render(80).join('\n')).toContain('/survivor');
            browser.handleInput('\r');
            expect(f.selections).toEqual([]);
            browser.handleInput('j');
            expect(selectedRow(browser, 80)).toContain('/survivor');
            browser.handleInput('\r');
          });
          expect(f.opened.map((info: AgentInfo) => info.canonicalName)).toEqual(['/survivor']);
        });
      },
    );

    test('does not open a different agent when the displayed Enter target disappears', async () => {
      await withBrowser(async (f) => {
        const gone = f.put('gone', { createdAt: 200 });
        f.put('survivor', { createdAt: 100 });
        await f.open((browser: any) => {
          browser.render(80);
          f.remove(gone);
          browser.handleInput('\r');
        });
        expect(f.selections[0].task).toBe('/gone');
        expect(f.opened).toEqual([]);
        expect(f.notify).toHaveBeenCalledWith(expect.stringContaining('Agent not found'), 'error');
      });
    });

    test.each([
      ['\x1b[D', 'previous'],
      ['\x1b[C', 'next'],
    ])('handles a disappearing %s overlay navigation target', async (key, direction) => {
      await withBrowser(async (f) => {
        const previous = f.put('previous', { createdAt: 300 });
        f.put('middle', { createdAt: 200 });
        const next = f.put('next', { createdAt: 100 });
        const list = AgentManager.prototype.listAgents;
        let navigating = false;
        AgentManager.prototype.listAgents = function (...args) {
          const entries = list.apply(this, args);
          if (navigating) f.remove(direction === 'next' ? next : previous);
          return entries;
        };
        await f.open(
          (browser: any) => {
            browser.render(120);
            browser.handleInput('j');
            expect(selectedRow(browser)).toContain('/middle');
            browser.handleInput('\r');
          },
          (overlay: any) => {
            navigating = true;
            overlay.handleInput(key);
          },
        );
        expect(f.opened.map((info: AgentInfo) => info.canonicalName)).toEqual(['/middle']);
        expect(f.notify).toHaveBeenCalledWith(expect.stringContaining('Agent not found'), 'error');
      });
    });

    test('all-session browsing distinguishes identical names and remains read-only', async () => {
      await withBrowser(async (f) => {
        const own = f.put('same', { modelId: 'own-model' });
        const other = f.put('same', { modelId: 'other-model' }, f.otherId);
        const before = [own, other].map((info) => fs.readFileSync(info.infoFile, 'utf8'));
        const controlNames = ['spawnAgent', 'sendMessage', 'interruptAgent'] as const;
        const originals = controlNames.map((name) => (AgentManager.prototype as any)[name]);
        const controls = controlNames.map((name) => {
          const control = mock(() => {
            throw new Error(`Browser must not call ${name}`);
          });
          (AgentManager.prototype as any)[name] = control;
          return control;
        });
        try {
          await f.open(
            (browser: any) => {
              expect(browser.render(120).join('\n')).not.toContain('other-model');
              browser.handleInput('\t');
              const lines = browser.render(120).join('\n');
              expect(lines).toContain('own-model');
              expect(lines).toContain('other-model');
              expect(selectedRow(browser)).toEndWith(f.otherId.slice(-8));
              browser.handleInput('j');
              expect(selectedRow(browser)).toEndWith(f.parentId.slice(-8));
              browser.handleInput('\t');
              expect(selectedRow(browser)).toContain('/same');
              browser.handleInput('\t');
              expect(selectedRow(browser)).toEndWith(f.otherId.slice(-8));
              browser.handleInput('\r');
            },
            (overlay: any, index: number) => overlay.handleInput(['\x1b[C', '\x1b[D', 'q'][index]),
          );
          expect(f.selections).toEqual([
            { task: '/same', parentSessionId: f.otherId, includeAll: true },
          ]);
          expect(f.opened.map((info: AgentInfo) => info.parentSessionId)).toEqual([
            f.otherId,
            f.parentId,
            f.otherId,
          ]);
          for (const control of controls) expect(control).not.toHaveBeenCalled();
          expect([own, other].map((info) => fs.readFileSync(info.infoFile, 'utf8'))).toEqual(
            before,
          );
        } finally {
          controlNames.forEach((name, index) => {
            (AgentManager.prototype as any)[name] = originals[index];
          });
        }
      });
    });

    test('aligns model/thinking columns and keeps private previews out of paginated tool results', async () => {
      await withBrowser(async (f) => {
        await f.open((browser: any) => {
          // Seed after manager.ready(): startup recovery must not interrupt this display fixture.
          const createdAt = Date.now();
          for (let index = 0; index < 12; index++) {
            f.put('history/' + index, {
              status: index === 0 ? 'running' : 'completed',
              lastTaskMessage: 'private task context ' + index,
              modelId: index === 0 ? 'MiniMax-M3' : 'a-model-name-that-is-longer-than-the-column',
              thinking: index === 0 ? 'high' : 'medium',
              createdAt: createdAt - index,
            });
          }
          const lines = browser.render(120);
          const firstIndex = lines.findIndex((line: string) => line.includes('/history/0'));
          const first = lines[firstIndex];
          const second = lines.find((line: string) => line.includes('/history/1 '));
          expect(first).toMatch(/\/history\/0\s+running\s+\S+\s+MiniMax-M3\s+high/);
          expect(lines[firstIndex + 1]).toContain('private task context 0');
          expect(second.indexOf('a-model-name')).toBe(first.indexOf('MiniMax-M3'));
          expect(visibleWidth(second.slice(0, second.indexOf('medium')))).toBe(
            visibleWidth(first.slice(0, first.indexOf('high'))),
          );
          expect(second).not.toContain('a-model-name-that-is-longer-than-the-column');
          for (const width of [80, 50, 32])
            expect(browser.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(
              true,
            );
          const narrow = browser.render(50).find((line: string) => line.includes('/history/0'));
          expect(narrow).toContain('high');
          expect(narrow).not.toContain('MiniMax-M3');
          browser.handleInput('\t');
          const all = browser.render(80).find((line: string) => line.includes('/history/0'));
          expect(all).toContain('MiniMax-M3');
          expect(all).toContain('high');
          expect(all.trimEnd()).toEndWith(f.parentId.slice(-8));
          browser.handleInput('q');
        });
        const list = (params: any) =>
          f.tools.get('list_agents').execute('list', params, undefined, undefined, f.ctx);
        const first = await list({});
        expect(JSON.parse(first.content[0].text)).toMatchObject({
          total: 12,
          returned: 10,
          offset: 0,
          limit: 10,
          next_offset: 10,
        });
        expect(first.details.agents[0]).toEqual({
          agent_name: '/history/0',
          agent_status: 'running',
        });
        expect(first.content[0].text).not.toContain('private task context');
        expect(JSON.parse((await list({ offset: 10 })).content[0].text)).toMatchObject({
          total: 12,
          returned: 2,
          offset: 10,
          next_offset: null,
        });
      });
    });

    test('clips wide ANSI previews at 32/38/50/80/120 columns and invalidates theme caches', async () => {
      await withBrowser(async (f) => {
        // Inject wide labels directly because task creation accepts ASCII names.
        f.put('wide', {
          canonicalName: '/中文很长的名称'.repeat(6),
          modelId: '宽模型'.repeat(10),
          lastTaskMessage: '\x1b[31m中文任务 😀\tcombining é '.repeat(20) + '\x1b[0m',
        });
        f.theme.ansi = '\x1b[36m';
        await f.open((browser: any) => {
          for (const width of [32, 38, 50, 80, 120]) {
            const lines = browser.render(width);
            expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
            const preview = lines
              .map(stripVTControlCharacters)
              .find((line: string) => line.startsWith('  中文任务'));
            expect(preview).toStartWith('  中文任务 😀');
            expect(lines.join('\n')).not.toContain('\t');
          }
          const first = browser.render(120);
          expect(first.join('\n')).toContain('\x1b[36m');
          f.theme.ansi = '\x1b[35m';
          browser.invalidate();
          const themed = browser.render(120).join('\n');
          expect(themed).toContain('\x1b[35m');
          expect(themed).not.toContain('\x1b[36m');
          browser.handleInput('q');
        });
      });
    });

    test.each(['regular', 'fullscreen'] as const)(
      'native %s TUI list supports manual refresh and resize',
      async (mode) => {
        await withBrowser(async (f) => {
          f.put('native', { lastTaskMessage: '中文任务 '.repeat(30) });
          let input: (data: string) => void = () => {};
          let resize = () => {};
          const writes: string[] = [];
          const terminal: Terminal & { columns: number; rows: number } = {
            columns: 120,
            rows: 35,
            kittyProtocolActive: false,
            start(onInput, onResize) {
              input = onInput;
              resize = onResize;
            },
            stop() {},
            async drainInput() {},
            write(data) {
              writes.push(data);
            },
            moveBy() {},
            hideCursor() {},
            showCursor() {},
            clearLine() {},
            clearFromCursor() {},
            clearScreen() {},
            setTitle() {},
            setProgress() {},
            setProgramStatus() {},
          };
          const tui = mode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
          f.tui = tui;
          await f.open((browser: any) => {
            tui.addChild(browser);
            tui.setFocus(browser);
            tui.start();
            const draw = () => {
              writes.length = 0;
              tui.renderNow(true);
              return stripVTControlCharacters(writes.join(''));
            };
            try {
              expect(draw()).toContain('中文任务');
              f.put('native', { lastTaskMessage: 'updated preview' });
              input('r');
              expect(draw()).toContain('updated preview');
              for (const width of [32, 38, 50, 80, 120]) {
                terminal.columns = width;
                resize();
                expect(draw()).toContain('updated preview');
                expect(
                  browser.render(width).every((line: string) => visibleWidth(line) <= width),
                ).toBe(true);
              }
              input('\x1b');
              expect(f.selections).toEqual([undefined]);
            } finally {
              tui.stop();
            }
          });
        });
      },
    );

    test('does not construct a browser outside TUI mode', async () => {
      await withBrowser(async (f) => {
        f.ctx.mode = 'rpc';
        f.ctx.ui.custom = mock(() => {
          throw new Error('custom is unavailable');
        });
        await f.command();
        expect(f.ctx.ui.custom).not.toHaveBeenCalled();
        expect(f.notify).toHaveBeenCalledWith(
          expect.stringContaining('interactive TUI'),
          'warning',
        );
      });
    });
  });
});

test('six public tools carry native usage through metadata and the detail footer without consuming reads', async () => {
  codingAgent.initTheme('dark', false);
  configureCoreFixture({
    tokens: (text) => (text.includes('fourteen') ? 70000 : text.includes('twelve') ? 60000 : 50000),
  });
  const parent = 'public-sdk-chain-' + randomUUID();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const sent: any[] = [];
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const ctx: any = {
    mode: 'tui',
    cwd: TEST_AGENT_DIR,
    model: { provider: 'test', id: 'fake' },
    modelRegistry: { getAvailable: () => [{ provider: 'test', id: 'fake' }] },
    sessionManager: { getSessionId: () => parent },
    ui: { notify: mock(() => {}), setWidget() {} },
  };
  const { default: extension } = await import('../src/index.js');
  const execute = (name: string, params: any) =>
    tools.get(name).execute('public-sdk-chain', params, undefined, undefined, ctx);
  const done = (percent: number) =>
    waitUntil(
      () =>
        getAgent('worker', parent)?.status === 'completed' &&
        getAgent('worker', parent)?.contextUsage?.tokens === percent * 5000,
    );
  try {
    await extension({
      on(name: string, handler: any) {
        handlers.set(name, handler);
      },
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
      registerShortcut() {},
      registerMessageRenderer() {},
      sendMessage(message: any) {
        sent.push(message);
      },
      getThinkingLevel: () => 'high',
      getActiveTools: () => ['read'],
      getSettings: () => ({ terminal: { showImages: false }, outputPad: 0 }),
    } as any);
    await handlers.get('session_start')({}, ctx);
    expect([...tools.keys()]).toEqual(toolNames);
    expect(
      (await execute('spawn_agent', { task_name: 'worker', message: 'sample ten' })).content[0]
        .text,
    ).toBe('Spawned /worker.');
    await done(10);
    const beforeRead = sent.length;
    const read = await execute('read_agent_response', { target: 'worker' });
    expect(read.content[0].text).toContain('response:sample ten');
    expect(await execute('read_agent_response', { target: 'worker' })).toEqual(read);
    expect(sent).toHaveLength(beforeRead);
    expect((await execute('wait_agent', { targets: ['worker'] })).content[0].text).toContain(
      'response:sample ten',
    );
    expect((await execute('list_agents', {})).content[0].text).not.toContain('contextUsage');
    let detailOpened = 0;
    ctx.ui.custom = async (create: any) => {
      let component: any;
      let result: any;
      const frames: string[] = [];
      const tui = {
        terminal: { rows: 35 },
        requestRender() {
          if (component instanceof SubagentPeekOverlay)
            frames.push(stripVTControlCharacters(component.render(80).join('\n')));
        },
      };
      component = create(tui, theme, {}, (value: any) => {
        result = value;
        component.dispose?.();
      });
      try {
        if (component instanceof SubagentPeekOverlay) {
          detailOpened++;
          expect(component.render(80).at(-2)).toContain('│ 12%/500k │ ←/→ agent');
          expect(
            (await execute('send_message', { target: 'worker', message: 'sample fourteen' }))
              .details.delivery,
          ).toBe('prompt');
          await done(14);
          await waitUntil(() => frames.some((frame) => frame.includes('│ 14%/500k │ ←/→ agent')));
          component.handleInput('q');
        } else {
          expect(component.render(80).join('\n')).not.toMatch(/ctx |Context:|%\/500k/);
          expect(
            (await execute('send_message', { target: 'worker', message: 'sample twelve' })).details
              .delivery,
          ).toBe('prompt');
          await done(12);
          component.handleInput('\r');
        }
        return result;
      } finally {
        component.dispose?.();
      }
    };
    await commands.get('subagents').handler('', ctx);
    expect(detailOpened).toBe(1);
    const resumed = JSON.parse((await execute('wait_agent', { targets: ['worker'] })).content[0].text);
    expect(resumed.event.finalResponse).toBe('response:sample fourteen');
    const saved = getAgent('worker', parent)!;
    expect(saved.contextUsage).toMatchObject({ tokens: 70000, contextWindow: 500000 });
    expect(saved.contextUsage!.percent!).toBeCloseTo(14);
    const beforeHistory = fs.readFileSync(saved.sessionFile, 'utf8');
    ctx.ui.custom = async (create: any) => {
      let component: any;
      let result: any;
      component = create(
        { terminal: { rows: 35 }, requestRender() {} },
        theme,
        {},
        (value: any) => {
          result = value;
          component.dispose?.();
        },
      );
      try {
        if (component instanceof SubagentPeekOverlay) {
          expect(component.render(80).at(-2)).toContain('│ 14%/500k │ ←/→ agent');
          component.handleInput('q');
        } else component.handleInput('\r');
        return result;
      } finally {
        component.dispose?.();
      }
    };
    await commands.get('subagents').handler('', ctx);
    expect(fs.readFileSync(saved.sessionFile, 'utf8')).toBe(beforeHistory);
    await execute('send_message', { target: 'worker', message: 'hold interrupt via tool' });
    expect((await execute('interrupt_agent', { target: 'worker' })).details.previous_status).toBe(
      'running',
    );
    expect(getAgent('worker', parent)?.status).toBe('interrupted');
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  } finally {
    await handlers.get('session_shutdown')?.();
  }
});
