import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import {
  backgroundAnsi,
  parseColor,
  TuiAltScreen,
  TuiMainScreen,
  truncateToWidth,
  visibleWidth,
  type Terminal,
} from '@earendil-works/pi-tui';
import { renderAgentBadge, resolveAgentColor } from '../src/color.js';
import { nativeTheme } from './fixtures/ui-theme.js';
import { AgentSummaryWidget } from '../src/widget.js';
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
    JSON.stringify({ extensions: [CORE_SDK_EXTENSION] }),
  );
});

const packageDir = path.resolve(import.meta.dir, '..');
const entry = path.join(packageDir, 'src', 'index.ts');
const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const toolNames = ['spawn_agent', 'wait_agent', 'list_agents', 'send_message', 'interrupt_agent'];

function terminalFixture(columns: number, rows: number) {
  let input = (_data: string) => {};
  let resize = () => {};
  const writes: string[] = [];
  const terminal: Terminal & { columns: number; rows: number } = {
    columns,
    rows,
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
  return { terminal, writes, input: (data: string) => input(data), resize: () => resize() };
}

// Separate processes keep prototype stubs, SDK caches, and agent directories out of sibling suites.
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
  AgentManager.prototype.listAgentInfos = () => [];
  function host() {
    const tools = new Map(), handlers = new Map(), commands = new Map(), shortcuts = new Map(), renderers = new Map();
    const messages = [], notifications = [], widgets = [];
    const ctx = {
      cwd: process.env.PI_CODING_AGENT_DIR, mode: "tui", hasUI: true,
      isIdle: () => true,
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
      getActiveTools() { throw new Error("Parent tools must not be read"); }, getThinkingLevel: () => "high", getSettings: () => ({}),
      sendMessage: (message, delivery) => messages.push({ message, delivery }),
    };
    return {
      tools, commands, shortcuts, renderers, messages, notifications, widgets, ctx, pi,
      async emit(name, event = {}, context = ctx) {
        const results = [];
        for (const handler of handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, context));
        return results;
      },
      call(name, params, context = ctx, signal) { return tools.get(name).execute("test-call", params, signal, undefined, context); },
    };
  }
`;

test('keeps the browser mounted beneath details through commands and shortcuts', () => {
  probe(
    hostFixture +
      String.raw`
    const config = path.join(process.env.PI_CODING_AGENT_DIR, "pi-subagents", "config.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ shortcut: "ctrl+shift+a" }));
    AgentManager.prototype.listAgentInfos = () => [{ taskName: "worker", status: "running" }];
    for (const entrypoint of ["command", "shortcut"]) {
      for (const openDetails of [false, true]) {
        const f = host();
        await extension(f.pi);
        const queries = [];
        AgentManager.prototype.getAgentInfo = (task, parentSessionId) => {
          queries.push({ task, parentSessionId });
          return { taskName: task, parentSessionId };
        };
        let browser, closeDetails, overlays = 0, settled = false, browserMounted = false;
        const details = new Promise(resolve => { closeDetails = resolve; });
        f.ctx.ui.custom = (create, options) => {
          if (options?.overlay) {
            assert.equal(browserMounted, true, "details must retain their browser background");
            overlays++;
            return details;
          }
          return new Promise(resolve => {
            browser = create({ requestRender() {} }, {
              fg: (_color, text) => text, bold: text => text,
            }, {}, () => {
              browserMounted = false;
              browser.dispose();
              resolve();
            });
            browserMounted = true;
          });
        };
        const run = entrypoint === "command"
          ? f.commands.get("subagents").handler("", f.ctx)
          : f.shortcuts.get("ctrl+shift+a").handler(f.ctx);
        run.then(() => { settled = true; });
        try {
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(settled, false);
          assert.deepEqual(queries, []);
          browser.render(120);
          if (openDetails) {
            browser.handleInput("\r");
            browser.handleInput("\r"); // A repeat Enter must not open another overlay.
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(overlays, 1);
            assert.deepEqual(queries, [{ task: "worker", parentSessionId: "parent" }]);
            assert.equal(browserMounted, true);
            assert.equal(settled, false);
            closeDetails();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(browserMounted, true, "closing details must reveal the same browser");
            assert.equal(settled, false, "only closing the browser ends the command");
          }
          browser.handleInput("q");
          await run;
          assert.equal(browserMounted, false);
          assert.deepEqual(f.notifications, []);
        } finally {
          closeDetails();
          await new Promise(resolve => setImmediate(resolve));
          browser?.handleInput("q");
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
      spawn_agent: "✓ worker · test/fake · high", wait_agent: "success-only",
      list_agents: "✓ 0 agents",
      send_message: "✓ steered", interrupt_agent: "↯ previous: pending_init",
    };
    const failure = {
      spawn_agent: "✗ controlled failure", wait_agent: "✗ wait failed",
      list_agents: "✗ list failed",
      send_message: "✗ send failed", interrupt_agent: "✗ interrupt failed",
    };
    const details = {
      task_name: "worker", provider: "test", modelId: "fake", thinking: "high",
      message: "success-only", agentCount: 0,
      delivery: "steer", previous_status: "pending_init",
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

test('keeps model-facing guidance compact without losing async contracts', () => {
  probe(
    hostFixture +
      String.raw`
    const f = host();
    await extension(f.pi);
    const spawn = f.tools.get("spawn_agent");
    const description = spawn.description;
    assert.ok(description.includes("scoped task"));
    assert.match(description, /working directory.*not.*conversation/i);
    assert.match(description, /returns on .*acceptance/i);
    assert.match(description, /results.*errors.*arrive automatically/i);
    assert.match(description, /continue other.*work/i);
    assert.ok(description.includes("wait_agent only when blocked"));
    assert.match(spawn.parameters.properties.task_name.description, /unique.*parent session/i);
    assert.ok(spawn.parameters.properties.task_name.description.includes("ASCII letters, digits, _, -, and internal /"));
    assert.ok(spawn.parameters.properties.message.description.includes("Self-contained task: context, paths, constraints, and expected output"));
    assert.ok(spawn.parameters.properties.agent_type.description.includes("omit for a generic subagent"));
    const wait = f.tools.get("wait_agent");
    assert.deepEqual(Object.keys(wait.parameters.properties), ["timeout_ms"]);
    assert.ok(wait.description.includes("input"));
    assert.ok(wait.description.includes("notification"));
    assert.ok(wait.description.includes("message and timed_out, not content"));
    assert.ok(wait.description.includes("Use only when blocked"));
    assert.ok(wait.description.includes("does not stop agents"));
    assert.match(wait.description, /prefer.*waits.*minutes.*avoid.*polling/i);
    assert.ok(f.tools.get("send_message").description.includes("input acceptance, not completion"));
    assert.ok(f.tools.get("interrupt_agent").description.includes("cooperative cancellation"));
    const list = f.tools.get("list_agents");
    for (const term of ["resident", "session", "initializing", "idle"]) assert.ok(list.description.includes(term), term);
    assert.match(list.description, /final text.*error/i);
    assert.deepEqual(Object.keys(list.parameters.properties), ["path_prefix"]);
    assert.match(list.parameters.properties.path_prefix.description, /relative task-name prefix.*omit/i);
    const checkBudget = () => {
      let chars = 0;
      for (const tool of f.tools.values()) {
        JSON.stringify({ description: tool.description, parameters: tool.parameters, outputSchema: tool.outputSchema }, (key, value) => {
          if (key === "description" && typeof value === "string") chars += value.length;
          return value;
        });
      }
      // Bound the current guidance, including strict path rules and the three shipped roles.
      // These are dependency-free prose guards, not exact token counts.
      const templateChars = spawn.description.split("\n\nAgent templates:\n")[1].length;
      assert.ok(chars - templateChars <= 2000, "Shared tool guidance exceeds 2000 characters: " + (chars - templateChars));
      assert.ok(chars <= 4000, "Guidance including built-in templates exceeds 4000 characters: " + chars);
    };
    checkBudget();
    const config = path.join(f.ctx.cwd, "pi-subagents", "config.json");
    fs.writeFileSync(config, JSON.stringify({ models: ["test/fake"] }));
    await f.emit("session_start");
    assert.equal(spawn.description, description, "routing belongs in parameter schemas, not duplicated prose");
    checkBudget();
    await f.emit("session_shutdown", { reason: "quit" });
  `,
  );
});

test('preserves the five tool contracts, dynamic routing, arguments, and return wrappers', () => {
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
    const string = { type: "string" };
    assert.deepEqual(plain(f.tools.get("spawn_agent").parameters), object({
      task_name: string, message: string, agent_type: string,
    }, ["task_name", "message"]));
    const waitSchema = plain(f.tools.get("wait_agent").parameters);
    assert.deepEqual(Object.keys(waitSchema.properties), ["timeout_ms"]);
    assert.equal(waitSchema.required, undefined);
    assert.equal(waitSchema.additionalProperties, false);
    assert.deepEqual(plain(f.tools.get("list_agents").parameters), {
      ...object({ path_prefix: { ...string, pattern: "^[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*$" } }), additionalProperties: false,
    });
    assert.deepEqual(plain(f.tools.get("interrupt_agent").parameters), object({ target: string }, ["target"]));
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
    assert.match(description, /working directory.*not.*conversation/i);
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
    AgentManager.prototype.spawnAgent = async params => { spawned = params; return { task_name: "task", nickname: null }; };
    AgentManager.prototype.getAgentInfo = () => ({ provider: "test", modelId: "fake", thinking: "high" });
    const spawn = await f.call("spawn_agent", { task_name: "task", message: "work", model: "test/fake", thinking: "high" });
    assert.deepEqual(spawn, { content: [{ type: "text", text: "Spawned task." }], details: { task_name: "task", nickname: null, provider: "test", modelId: "fake", thinking: "high" } });
    assert.equal(spawned.parentSessionId, "parent");
    assert.equal(spawned.cwd, f.ctx.cwd);
    assert.equal(spawned.parentSessionFile, "parent.jsonl");
    assert.ok(!Object.hasOwn(spawned, "inheritedTools"));
    assert.ok(!Object.hasOwn(spawned, "skills"));
    assert.ok(!Object.hasOwn(spawned, "loadedSkillPaths"));
    const signal = new AbortController().signal;
    const waiting = f.call("wait_agent", {}, f.ctx, signal);
    await new Promise(resolve => setImmediate(resolve));
    options.onCompletion({ taskName: "task", status: "completed", finalResponse: "must not repeat", parentSessionId: "parent" });
    const wait = await waiting;
    const expectedWait = { message: "Wait completed.", timed_out: false };
    assert.deepEqual(JSON.parse(wait.content[0].text), expectedWait);
    assert.deepEqual(wait.details, expectedWait);
    assert.deepEqual(wait.structuredContent, expectedWait);
    let listed;
    const agents = Array.from({ length: 12 }, (_, n) => ({ agent_name: String(n), agent_status: { completed: null } }));
    AgentManager.prototype.listAgents = (...args) => { listed = args; return agents; };
    const list = await f.call("list_agents", {});
    assert.deepEqual(listed, [undefined, "parent"]);
    assert.deepEqual(list, { content: [{ type: "text", text: JSON.stringify({ agents }, null, 2) }], details: { agentCount: agents.length }, structuredContent: { agents } });
    const prefixed = await f.call("list_agents", { path_prefix: "review/auth" });
    assert.deepEqual(listed, ["review/auth", "parent"], "Validated path prefixes are passed without normalization");
    assert.deepEqual(prefixed.structuredContent, { agents });
    let scoped;
    for (const delivery of ["steer", "prompt"]) {
      AgentManager.prototype.sendMessage = async (...args) => { scoped = args; return { delivery }; };
      const send = await f.call("send_message", { target: " task ", message: "next" });
      assert.deepEqual(scoped, ["parent", " task ", "next"], "Manager owns target trimming and validation");
      assert.deepEqual(send.details, { target: " task ", delivery });
    }
    for (const previous_status of ["pending_init", "running", "completed", "errored", "interrupted"]) {
      AgentManager.prototype.interruptAgent = async (...args) => { scoped = args; return { previous_status }; };
      const interrupt = await f.call("interrupt_agent", { target: "task" });
      assert.deepEqual(scoped, ["parent", "task"]);
      assert.deepEqual(interrupt, { content: [{ type: "text", text: "Interrupt request handled." }], details: { previous_status } });
    }
    const interruptRenderer = f.tools.get("interrupt_agent").renderResult;
    assert.equal(interruptRenderer({ details: {}, content: [] }, {}, { fg: (_c, s) => s }, { isError: false }).render(120).join("\n").trim(), "");
    await f.emit("session_shutdown", { reason: "quit" });
  `,
  );
});

test('validates strict list path prefixes and rejects removed arguments through Pi native schema validation', () => {
  probe(
    hostFixture +
      `const { validateToolArguments } = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))});` +
      String.raw`
    const f = host();
    await extension(f.pi);
    const tool = f.tools.get("list_agents");
    const validate = args => validateToolArguments(tool, { type: "toolCall", id: "resident-list", name: "list_agents", arguments: tool.prepareArguments(args) });
    for (const args of [{}, { path_prefix: "review" }, { path_prefix: "review/auth" }, { path_prefix: "Review_1-A/part" }, { path_prefix: "123" }, { path_prefix: "true" }])
      assert.deepEqual(validate(args), args, "Valid relative paths are not normalized");
    for (const path_prefix of [null, 123, true, false, [], ["review"], {}, "", " ", "\t", "/", "/review", "//review", "review/", "review//", "review//auth",
      " review", "review ", " review ", "review\n", "review\r", "review\r\n", "review\t", "review auth",
      "review/ auth", "review/auth ", "review\\auth", ".", "..", "review/./auth", "review/../auth",
      "review.auth", "review/*", "review?", "review#auth", "review:auth", "review%2fauth", "审查", "review/\u0000auth", "review\u2028", "review\u2029"])
      assert.throws(() => validate({ path_prefix }), undefined, JSON.stringify(path_prefix));
    for (const args of [{ include_all: true }, { include_all: false }, { limit: 1 }, { offset: 0 },
      { path_prefix: "review", include_all: true, limit: 100, offset: 1 }, { unknown: true }])
      assert.throws(() => validate(args), undefined, JSON.stringify(args));
    assert.equal(options, undefined, "schema rejection does not create a Manager");
  `,
  );
});

test('keeps resident ordering and both render modes consistent with public list data', () => {
  probe(
    hostFixture +
      String.raw`
    const f = host();
    await extension(f.pi);
    AgentManager.prototype.listAgentInfos = () => { throw new Error("public lists must not read disk history"); };
    const entries = [{ completed: "answer" }, "pending_init", { errored: "child error" }, "running", "interrupted"].map((status, n) => ({
      agent_name: "resident-" + n, agent_status: status,
    }));
    AgentManager.prototype.listAgents = (...args) => {
      assert.deepEqual(args, [undefined, "parent"]);
      return entries;
    };
    const expected = { agents: [entries[1], entries[3], entries[0], entries[2], entries[4]] };
    const result = await f.call("list_agents", {});
    assert.deepEqual(result, { content: [{ type: "text", text: JSON.stringify(expected, null, 2) }], details: { agentCount: 5 }, structuredContent: expected });
    const theme = { fg: (_color, text) => text };
    const render = expanded => f.tools.get("list_agents").renderResult(result, { expanded }, theme, { isError: false }).render(120).join("\n").trim();
    assert.equal(render(false), "✓ 5 agents");
    assert.deepEqual(JSON.parse(render(true)), expected);
    await f.emit("session_shutdown", { reason: "quit" });
  `,
  );
});

test('validates structured wait/list results and bounds only the list text preview', () => {
  probe(
    hostFixture +
      `const { Value } = await import(${JSON.stringify(import.meta.resolve('typebox/value'))});` +
      String.raw`
    const f = host();
    await extension(f.pi);
    const check = (name, result) => {
      const data = result.structuredContent;
      assert.ok(Value.Check(f.tools.get(name).outputSchema, data), name + ": " + JSON.stringify([...Value.Errors(f.tools.get(name).outputSchema, data)]));
      if (!result.details?.truncated) assert.deepEqual(data, JSON.parse(result.content[0].text));
      return data;
    };
    for (const name of ["spawn_agent", "send_message", "interrupt_agent"])
      assert.equal(f.tools.get(name).outputSchema, undefined, name + " must stay text-only");
    const { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } = await import(${JSON.stringify(sdkUrl)});
    await f.emit("session_start");
    for (const event of [{ status: "completed", finalResponse: "private body" }, { status: "errored", error: "private error" }]) {
      options.onCompletion({ taskName: "worker", parentSessionId: "parent", ...event });
      const result = await f.call("wait_agent", {});
      const expected = { message: "Wait completed.", timed_out: false };
      assert.deepEqual(check("wait_agent", result), expected);
      assert.deepEqual(result.details, expected);
    }
    assert.equal(Value.Check(f.tools.get("wait_agent").outputSchema, { message: "Wait completed.", timed_out: false, agent_name: "worker" }), false);
    assert.equal(Value.Check(f.tools.get("wait_agent").outputSchema, { agent_name: "worker", status: "completed" }), false);
    for (const agent_status of ["pending_init", "running", "interrupted", { completed: "answer" }, { completed: "" }, { completed: null }, { errored: "child failed" }, { errored: "" }]) {
      const agents = [{ agent_name: "worker", agent_status }];
      AgentManager.prototype.listAgents = () => agents;
      const listed = await f.call("list_agents", {});
      assert.deepEqual(check("list_agents", listed), { agents });
      assert.deepEqual(listed.details, { agentCount: 1 });
    }
    const schema = f.tools.get("list_agents").outputSchema;
    for (const agent_status of ["starting", "failed", "completed", "errored", null, {},
      { completed: false }, { completed: "answer", error: "extra" },
      { errored: null }, { errored: "failure", completed: null }]) {
      assert.equal(Value.Check(schema, { agents: [{ agent_name: "worker", agent_status }] }), false, JSON.stringify(agent_status));
    }
    assert.equal(Value.Check(schema, { agents: [{ agent_name: "worker", agent_status: "running", color: "red" }] }), false);
    assert.equal(Value.Check(schema, { agents: [], extra: true }), false);
    const render = (result, expanded) => f.tools.get("list_agents").renderResult(result, { expanded }, { fg: (_c, s) => s }, { isError: false }).render(120).map(line => line.trimEnd()).join("\n").trim();
    const makeAgents = count => Array.from({ length: count }, (_, n) => ({ agent_name: "worker-" + n, agent_status: { completed: null } }));
    for (const count of [0, 12, 101]) {
      const agents = makeAgents(count);
      AgentManager.prototype.listAgents = () => agents;
      const result = await f.call("list_agents", {});
      assert.deepEqual(check("list_agents", result), { agents }, count + " residents must all be returned");
      assert.deepEqual(result.details, { agentCount: count });
      assert.equal(render(result, false), "✓ " + count + " agents");
    }
    const bigBody = { agents: [{ agent_name: "worker", agent_status: { completed: '中文🙂"\\\n'.repeat(10_000) } }] };
    const many = { agents: makeAgents(450) };
    assert.ok(JSON.stringify(many, null, 2).split("\n").length > DEFAULT_MAX_LINES);
    assert.ok(Buffer.byteLength(JSON.stringify(many, null, 2)) < DEFAULT_MAX_BYTES);
    let outputDir;
    for (const expected of [bigBody, many]) {
      AgentManager.prototype.listAgents = () => expected.agents;
      const large = await f.call("list_agents", {});
      assert.deepEqual(check("list_agents", large), expected);
      const { agentCount, fullOutputPath } = large.details;
      assert.deepEqual(large.details, { agentCount: expected.agents.length, truncated: true, fullOutputPath });
      assert.equal(render(large, false), "✓ " + agentCount + " agents");
      assert.ok(render(large, true).includes("Output truncated"));
      const [preview, notice] = large.content[0].text.split("\n\n[Output truncated: ");
      const full = JSON.stringify(expected, null, 2);
      assert.ok(full.startsWith(preview) && preview.length < full.length, "the preview is a head excerpt of the same JSON");
      assert.ok(Buffer.byteLength(preview) <= DEFAULT_MAX_BYTES);
      assert.ok(preview.split("\n").length <= DEFAULT_MAX_LINES);
      assert.ok(notice.endsWith("Full output saved to: " + fullOutputPath + "]"));
      assert.equal(fs.readFileSync(fullOutputPath, "utf8"), full);
      outputDir = path.dirname(fullOutputPath);
    }
    fs.rmSync(outputDir, { recursive: true });
    fs.writeFileSync(outputDir, "not a directory");
    AgentManager.prototype.listAgents = () => bigBody.agents;
    const blocked = await f.call("list_agents", {});
    assert.deepEqual(check("list_agents", blocked), bigBody);
    assert.deepEqual(blocked.details, { agentCount: 1, truncated: true });
    assert.match(blocked.content[0].text, /Could not save full output/);
    assert.doesNotMatch(blocked.content[0].text, /Full output saved to:/);

    options.onCompletion({ parentSessionId: "parent", taskName: "large", status: "completed", finalResponse: bigBody.agents[0].agent_status.completed });
    assert.match(f.messages.at(-1).message.content, /Could not save full output/);
    assert.equal(f.messages.at(-1).message.details.status, "completed");
    assert.deepEqual((await f.call("wait_agent", {})).structuredContent, { message: "Wait completed.", timed_out: false });

    assert.equal(render({ details: {}, content: [] }, true), "");
    assert.equal(render({ details: {}, content: [
      { type: "image", data: "example", mimeType: "image/png" },
      { type: "text", text: "retained by hook" },
      { type: "text", text: "second block" },
    ] }, true), "retained by hook\nsecond block");
    assert.equal(render({ details: {}, content: [{ type: "text", text: "redacted" }] }, false), "redacted");
    await f.emit("session_shutdown", { reason: "quit" });
  `,
  );
});

test('preserves tool error prefixes, quota explanations, wait previews and cancellation identity', () => {
  probe(
    hostFixture +
      String.raw`
    const f = host();
    await extension(f.pi);
    const theme = { fg: (_color, text) => text, bold: text => text };
    const tool = f.tools.get("wait_agent");
    const preview = args => tool.renderCall(args, theme).render(160).join("\n").trim();
    assert.ok(preview({}).startsWith("wait_agent"));
    assert.ok(preview({ timeout_ms: 15000 }).includes("15"));
    for (const [name, method, params] of [
      ["spawn_agent", "spawnAgent", { task_name: "task", message: "work" }],
      ["send_message", "sendMessage", { target: "task", message: "next" }],
      ["interrupt_agent", "interruptAgent", { target: "task" }],
    ]) {
      for (const [failure, message] of [
        [new Error("controlled failure"), "controlled failure"],
        ["plain failure", "plain failure"],
        [Object.assign(new Error("write failed"), { code: "EDQUOT" }), "write failed\nCause: Disk quota exceeded (EDQUOT)."],
      ]) {
        AgentManager.prototype[method] = async () => { throw failure; };
        await assert.rejects(f.call(name, params), error => error.message === name + " failed: " + message);
      }
    }
    const controller = new AbortController();
    const cancellation = new Error("wait cancelled");
    controller.abort(cancellation);
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
      AgentManager.prototype.spawnAgent = async params => { spawned = params; return { task_name: "task" }; };
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
    options.onError(new AggregateError(["plain failure", Object.assign(new Error("write failed"), { code: "EDQUOT" })], "shutdown failed"));
    assert.deepEqual(f.notifications.pop(), ["[subagents] shutdown failed\nplain failure\nwrite failed\nCause: Disk quota exceeded (EDQUOT).", "error"]);
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

test('activity waits keep notifications compact and preserve natural or idle continuation', () => {
  probe(
    hostFixture +
      String.raw`
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    const event = { parentSessionId: "parent", taskName: "task", status: "completed", finalResponse: "notification body" };
    for (const idle of [false, true]) {
      f.ctx.isIdle = () => idle;
      const waiting = f.call("wait_agent", {});
      await new Promise(resolve => setImmediate(resolve));
      options.onCompletion(event);
      assert.equal(f.messages.at(-1).delivery.triggerTurn, idle, "a waiter uses natural continuation unless idle");
      assert.ok(f.messages.at(-1).message.content.includes("notification body"));
      const result = await waiting;
      const expected = { message: "Wait completed.", timed_out: false };
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
      assert.deepEqual(result.details, expected);
      assert.deepEqual(result.structuredContent, expected);
      // Activity remains pending until consumed or included in model context.
      await f.emit("context", { messages: [] });
    }
    f.ctx.isIdle = () => false;
    options.onCompletion(event);
    assert.equal(f.messages.at(-1).delivery.triggerTurn, true, "independent work keeps normal automatic delivery");
    options.onCompletion({ ...event, parentSessionId: "other" });
    assert.equal(f.messages.length, 3);
    options.onCompletion({ ...event, finalResponse: "large answer".repeat(20_000) });
    const result = await f.call("wait_agent", {});
    assert.deepEqual(result.details, { message: "Wait completed.", timed_out: false });
    assert.ok(result.content[0].text.length < 100, "notification bodies must not leak into wait results");
    await f.emit("session_shutdown", { reason: "quit" });
  `,
  );
});

test('observes every parent input source and delivery without changing the input', () => {
  probe(
    hostFixture +
      String.raw`
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    f.ctx.isIdle = () => false;
    for (const source of ["interactive", "rpc", "extension"]) {
      for (const streamingBehavior of [undefined, "steer", "followUp"]) {
        await f.emit("context", { messages: [] });
        let settled = false;
        const waiting = f.call("wait_agent", {}).then(result => { settled = true; return result; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false, "no child is required to wait for parent activity");
        const input = Object.freeze({ text: "original " + source + "/" + streamingBehavior,
          source, streamingBehavior, images: Object.freeze([{ type: "image", data: "eA==", mimeType: "image/png" }]) });
        const before = structuredClone(input);
        const outcomes = await f.emit("input", input);
        assert.ok(outcomes.every(result => result === undefined || result.action === "continue"), "wait must not handle or transform input");
        assert.deepEqual(input, before);
        const result = await waiting;
        const expected = { message: "Wait interrupted by new input.", timed_out: false };
        assert.deepEqual(JSON.parse(result.content[0].text), expected);
        assert.deepEqual(result.details, expected);
        assert.deepEqual(result.structuredContent, expected);
        assert.equal(f.messages.length, 0, "observing input must not enqueue another model message");
      }
    }
    await f.emit("session_shutdown", { reason: "quit" });
  `,
  );
});

test('consumes only the latest pending activity and clears it at the next context preparation', () => {
  probe(
    hostFixture +
      String.raw`
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    f.ctx.isIdle = () => false;
    const mail = { parentSessionId: "parent", taskName: "worker", status: "completed", finalResponse: "mail is retained" };
    const input = { text: "new instruction", source: "extension", streamingBehavior: "followUp" };
    const expectPending = async message => {
      const result = await f.call("wait_agent", {});
      assert.deepEqual(result.details, { message, timed_out: false });
      const controller = new AbortController();
      let settled = false;
      const next = f.call("wait_agent", {}, f.ctx, controller.signal);
      next.then(() => { settled = true; }, () => {});
      const canceled = assert.rejects(next, error => error === controller.signal.reason);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, "pending activity is consumed once, not replayed as a queue");
      controller.abort(new Error("cancel next wait"));
      await canceled;
    };
    options.onCompletion(mail);
    await f.emit("input", input);
    await expectPending("Wait interrupted by new input.");
    await f.emit("input", input);
    options.onCompletion(mail);
    await expectPending("Wait completed.");
    for (const activity of [() => f.emit("input", input), () => options.onCompletion(mail)]) {
      await activity();
      const messages = Object.freeze([{ role: "user", content: "older activity", timestamp: 0 }]);
      const before = structuredClone(messages);
      const outcomes = await f.emit("context", { messages });
      assert.ok(outcomes.every(result => result === undefined), "activity cleanup must not replace the model context");
      assert.deepEqual(messages, before);
      let settled = false;
      const waiting = f.call("wait_agent", {}).then(result => { settled = true; return result; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, "the older activity already entered model context");
      await f.emit("input", input);
      assert.equal((await waiting).details.message, "Wait interrupted by new input.");
    }
    assert.equal(f.messages.length, 3, "waits must not consume or replay notification messages");
    await f.emit("session_shutdown", { reason: "quit" });
  `,
  );
});

test('broadcasts activity to concurrent waits without stealing messages or canceling children', () => {
  probe(
    hostFixture +
      String.raw`
    const { getEventListeners } = await import("node:events");
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    f.ctx.isIdle = () => false;
    let interrupted = 0, finished = 0;
    AgentManager.prototype.interruptAgent = async () => { interrupted++; };
    AgentManager.prototype.listAgents = () => [{ agent_name: "worker", agent_status: "running" }];
    const controller = new AbortController();
    const canceled = f.call("wait_agent", {}, f.ctx, controller.signal);
    const rejection = assert.rejects(canceled, error => error === controller.signal.reason);
    const waits = [f.call("wait_agent", {}), f.call("wait_agent", {})];
    waits.forEach(wait => wait.then(() => { finished++; }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    controller.abort(new Error("cancel this wait only"));
    await rejection;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(interrupted, 0);
    assert.equal((await f.call("list_agents", {})).structuredContent.agents[0].agent_status, "running");
    options.onCompletion({ parentSessionId: "other", taskName: "ignored", status: "completed", finalResponse: null });
    options.onActivityChange({ parentSessionId: "parent", taskName: "worker", status: "interrupted" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, 0, "other sessions and status-only updates are not notification activity");
    const event = { parentSessionId: "parent", taskName: "worker", status: "completed", finalResponse: "original child output" };
    options.onCompletion(event);
    const results = await Promise.all(waits);
    results.forEach(result => assert.deepEqual(result.details, { message: "Wait completed.", timed_out: false }));
    assert.equal(f.messages.length, 1, "one original notification serves every waiter");
    assert.ok(f.messages[0].message.content.includes("original child output"));
    assert.equal(f.messages[0].delivery.triggerTurn, false);
    assert.equal(interrupted, 0);
    await f.emit("session_shutdown", { reason: "quit" });
  `,
  );
});

test('cancels and detaches old waits on session start and shutdown, clearing pending activity', () => {
  probe(
    hostFixture +
      String.raw`
    const { getEventListeners } = await import("node:events");
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    const mail = { parentSessionId: "parent", taskName: "old", status: "completed", finalResponse: "old session output" };
    for (const lifecycle of ["session_start", "session_shutdown"]) {
      await f.emit("context", { messages: [] });
      const controller = new AbortController();
      const waiting = f.call("wait_agent", {}, f.ctx, controller.signal);
      const rejection = assert.rejects(waiting);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);
      await f.emit(lifecycle, { reason: "reload" });
      await rejection;
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      if (lifecycle === "session_shutdown") await f.emit("session_start");
      options.onCompletion(mail);
      await f.emit(lifecycle, { reason: "reload" });
      if (lifecycle === "session_shutdown") await f.emit("session_start");
      let settled = false;
      const fresh = f.call("wait_agent", {}).then(result => { settled = true; return result; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, "a new session must not consume old pending activity");
      await f.emit("input", { text: "new session input", source: "rpc", streamingBehavior: "steer" });
      assert.equal((await fresh).details.message, "Wait interrupted by new input.");
    }
    const next = { ...f.ctx, sessionManager: { getSessionId: () => "next-parent" } };
    await f.emit("session_start", {}, next);
    let settled = false;
    const waiting = f.call("wait_agent", {}, next).then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    const before = f.messages.length;
    options.onCompletion(mail);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.messages.length, before, "old-parent notifications must not leak after replacement");
    await f.emit("input", { text: "fresh input", source: "extension", streamingBehavior: "followUp" }, next);
    await waiting;
    await f.emit("session_shutdown", { reason: "quit" }, next);
  `,
  );
});

test('validates timeout-only arguments and clamps the minimum with a test-local clock', () => {
  probe(
    hostFixture +
      `const { Value } = await import(${JSON.stringify(import.meta.resolve('typebox/value'))});
       const { validateToolArguments } = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))});` +
      String.raw`
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    const tool = f.tools.get("wait_agent");
    const guidance = tool.description + " " + JSON.stringify(tool.parameters);
    for (const value of ["30000", "10000", "3600000"]) assert.ok(guidance.replaceAll(",", "").includes(value), "document timeout boundary " + value);
    assert.match(guidance, /rais|clamp|minimum/i, "explain that low, zero and negative timeouts are raised");
    assert.equal(Value.Check(tool.parameters, {}), true);
    assert.equal(Value.Check(tool.parameters, { timeout_ms: null }), true);
    for (const timeout_ms of [-100, 0, 1, 9999, 10000])
      assert.equal(Value.Check(tool.parameters, { timeout_ms }), true, "native validation must allow minimum clamping");
    assert.equal(Value.Check(tool.parameters, { timeout_ms: 1.5 }), false);
    for (const params of [{ targets: [] }, { targets: ["worker"], timeout_ms: 10000 }, { unknown: true }]) {
      assert.equal(Value.Check(tool.parameters, params), false);
      assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "invalid-wait", name: "wait_agent", arguments: params }));
    }
    // Direct execute bypasses SDK coercion: validate primitive types and the upper bound here.
    for (const timeout_ms of [3600001, Number.MAX_SAFE_INTEGER, 1.5, NaN, Infinity, -Infinity, "10000", false, [], {}])
      await assert.rejects(f.call("wait_agent", { timeout_ms }));
    const original = { setTimeout, clearTimeout };
    const timers = new Map();
    let now = 0;
    globalThis.setTimeout = (callback, ms, ...args) => {
      const timer = { at: now + ms, callback: () => callback(...args), unref() { return this; } };
      timers.set(timer, timer);
      return timer;
    };
    globalThis.clearTimeout = timer => { timers.delete(timer); };
    const advance = ms => {
      now += ms;
      for (const [timer, entry] of [...timers]) if (entry.at <= now) { timers.delete(timer); entry.callback(); }
    };
    try {
      for (const [params, timeout] of [
        [{}, 30000], [{ timeout_ms: null }, 30000],
        ...[-100, 0, 1, 9999, 10000].map(timeout_ms => [{ timeout_ms }, 10000]),
        [{ timeout_ms: 10001 }, 10001], [{ timeout_ms: 3600000 }, 3600000],
      ]) {
        let settled = false;
        const waiting = f.call("wait_agent", params).then(result => { settled = true; return result; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(timers.size, 1);
        advance(timeout - 1);
        await Promise.resolve();
        assert.equal(settled, false, JSON.stringify(params) + " returned early");
        advance(1);
        const result = await waiting;
        const clamped = typeof params.timeout_ms === "number" && params.timeout_ms < 10000;
        const message = clamped
          ? "Wait timed out.\n\nRequested timeout of " + params.timeout_ms + "ms was clamped to the minimum of 10000ms."
          : "Wait timed out.";
        const expected = { message, timed_out: true };
        assert.deepEqual(JSON.parse(result.content[0].text), expected);
        assert.deepEqual(result.details, expected);
        assert.deepEqual(result.structuredContent, expected);
        assert.ok(Value.Check(tool.outputSchema, result.structuredContent));
        assert.equal(timers.size, 0);
      }
      const controller = new AbortController();
      const waiting = f.call("wait_agent", {}, f.ctx, controller.signal);
      const rejection = assert.rejects(waiting, error => error === controller.signal.reason);
      await new Promise(resolve => setImmediate(resolve));
      controller.abort(new Error("clock cleanup"));
      await rejection;
      assert.equal(timers.size, 0, "canceling a wait clears its timeout");
      for (const activity of [
        () => f.emit("input", { text: "cleanup", source: "interactive" }),
        () => options.onCompletion({ parentSessionId: "parent", taskName: "worker", status: "completed", finalResponse: null }),
      ]) {
        const wait = f.call("wait_agent", {});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(timers.size, 1);
        await activity();
        await wait;
        assert.equal(timers.size, 0, "activity clears its timeout");
      }
      for (const lifecycle of ["session_start", "session_shutdown"]) {
        const wait = f.call("wait_agent", {});
        const rejection = assert.rejects(wait);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(timers.size, 1);
        await f.emit(lifecycle, { reason: "reload" });
        await rejection;
        assert.equal(timers.size, 0, "session reset clears wait timeouts");
      }
    } finally {
      Object.assign(globalThis, original);
      await f.emit("session_shutdown", { reason: "quit" });
    }
  `,
  );
});

test('only native parent cancellation suppresses notification wakeups until a real restart', () => {
  probe(
    hostFixture +
      String.raw`
    const success = { role: "assistant", content: [], stopReason: "stop" };
    const failure = { ...success, stopReason: "error", errorMessage: "budget exceeded; retry aborted (ordinary model error)" };
    const cases = [
      ["normal success", false, async f => {
        await f.emit("agent_end", { messages: [success] });
        await f.emit("agent_settled", { aborted: false });
      }],
      ["ordinary model error, even with cancellation-like text", false, async f => {
        await f.emit("turn_end", { message: failure, toolResults: [] });
        await f.emit("agent_end", { messages: [failure] });
        await f.emit("agent_settled", { aborted: false });
      }],
      ["ordinary tool error", false, async f => {
        await f.emit("turn_end", { message: success, toolResults: [
          { role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "budget exceeded" }] },
        ] });
        await f.emit("agent_settled", { aborted: false });
      }],
      ["ordinary retry lifecycle", false, async f => {
        await f.emit("message_end", { message: failure });
        await f.emit("agent_end", { messages: [failure] });
        // Low-level retry events are not public extension events; model the next agent loop instead.
        f.ctx.signal = new AbortController().signal;
        await f.emit("agent_start");
        await f.emit("message_end", { message: success });
        await f.emit("agent_end", { messages: [success] });
        await f.emit("agent_settled", { aborted: false });
      }],
      ["signal abort, before agent_settled", true, (_f, controller) => controller.abort()],
      ["signal abort survives signal removal and non-aborted settlement", true, async (f, controller) => {
        controller.abort();
        f.ctx.signal = undefined;
        await f.emit("agent_settled", { aborted: false });
      }],
      ["retry cancellation without a signal uses settled fallback", true, async f => {
        f.ctx.signal = undefined;
        await f.emit("agent_settled", { aborted: true });
      }],
      ["start with an already-aborted signal must not clear interruption", true, async (f, controller) => {
        controller.abort();
        await f.emit("agent_start");
        f.ctx.signal = undefined;
      }],
      ["input and before_agent_start alone do not resume", true, async (f, controller) => {
        controller.abort();
        f.ctx.signal = new AbortController().signal;
        await f.emit("input", { text: "handled input", source: "interactive" });
        await f.emit("before_agent_start", { prompt: "not yet a real run" });
      }],
      ["new real agent_start resumes", false, async (f, controller) => {
        controller.abort();
        f.ctx.signal = new AbortController().signal;
        await f.emit("before_agent_start", { prompt: "new work" });
        await f.emit("agent_start");
      }],
      ["session_start clears interruption", false, async (f, controller) => {
        controller.abort();
        f.ctx.signal = undefined;
        await f.emit("session_start");
      }],
      ["child failure does not interrupt the parent", false, () => {
        options.onActivityChange({ parentSessionId: "parent", taskName: "errored-child", status: "errored" });
        options.onCompletion({ parentSessionId: "parent", taskName: "errored-child", status: "errored", error: "child budget exceeded" });
      }],
    ];
    for (const [label, interrupted, prepare] of cases) {
      const f = host(), controller = new AbortController();
      f.ctx.signal = controller.signal;
      await extension(f.pi);
      await f.emit("session_start");
      await f.emit("agent_start");
      try {
        await prepare(f, controller);
        const initial = f.messages.length;
        let sent = 0;
        for (const outcome of [{ status: "completed", finalResponse: "retained result" }, { status: "errored", error: "retained error" }]) {
          for (const idle of [false, true]) {
            f.ctx.isIdle = () => idle;
            for (const waiting of [false, true]) {
              await f.emit("context", { messages: [] });
              const wait = waiting ? f.call("wait_agent", {}) : undefined;
              await new Promise(resolve => setImmediate(resolve));
              const taskName = "child-" + sent++;
              options.onCompletion({ parentSessionId: "parent", taskName, ...outcome });
              await wait;
              const { status } = outcome;
              assert.equal(f.messages.length, initial + sent, label + ": every notification is retained");
              const { message, delivery } = f.messages.at(-1);
              assert.equal(message.customType, "pi-subagent-completion", label);
              assert.equal(message.display, true, label);
              assert.ok(message.content.includes(outcome.finalResponse ?? outcome.error), label);
              assert.deepEqual(message.details, { agent_name: taskName, status }, label);
              assert.deepEqual(delivery, { deliverAs: "steer", triggerTurn: !interrupted && (!waiting || idle) },
                label + ": " + JSON.stringify({ status, waiting, idle }));
            }
          }
        }
      } finally {
        await f.emit("session_shutdown", { reason: "quit" });
      }
    }
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
    options.onActivityChange({ parentSessionId: "other", taskName: "ignored", status: "running" });
    options.onActivityChange({ parentSessionId: "parent", taskName: "task", status: "pending_init" });
    const [key, widget] = f.widgets.at(-1);
    assert.equal(key, "pi-subagents");
    const theme = { fg: (_color, text) => text };
    const component = widget({}, theme);
    assert.ok(component.render(80).join("\n").includes("task"));
    assert.ok(component.render(30).join("\n").includes("/subagents"));
    options.onCompletion({ parentSessionId: "other", taskName: "ignored", status: "completed", finalResponse: null });
    assert.equal(f.messages.length, 0);
    const scope = { parentSessionId: "parent", taskName: "task" };
    for (const [outcome, fields] of [
      [{ status: "completed", finalResponse: "answer" }, { final_response: "answer" }],
      [{ status: "completed", finalResponse: "" }, { final_response: "" }],
      [{ status: "completed", finalResponse: null }, { final_response: null }],
      [{ status: "errored", error: "child budget exceeded" }, { error: "child budget exceeded" }],
      [{ status: "errored", error: "" }, { error: "" }],
    ]) {
      const { status } = outcome;
      options.onCompletion({ ...scope, ...outcome });
      const details = { agent_name: "task", status };
      assert.deepEqual(f.messages.at(-1), { message: {
        customType: "pi-subagent-completion",
        content: "<subagent_notification>\n" + JSON.stringify({ ...details, ...fields }, null, 2) + "\n</subagent_notification>",
        display: true, details,
      }, delivery: { deliverAs: "steer", triggerTurn: true } });
      const renderTheme = { fg: (color, text) => color + ":" + text };
      const rendered = f.renderers.get("pi-subagent-completion")(f.messages.at(-1).message, { expanded: false }, renderTheme);
      assert.equal(rendered.render(80).join("\n").trim(), status === "completed" ? "success:✓ task completed" : "error:✗ task errored");
    }
    const event = { ...scope, status: "completed", finalResponse: "x".repeat(100_000) };
    options.onCompletion(event);
    const large = f.messages.at(-1).message;
    assert.ok(Buffer.byteLength(large.content) <= 50 * 1024);
    assert.ok(large.content.includes("Output truncated"));
    assert.ok(large.content.startsWith("<subagent_notification>\n") && large.content.endsWith("\n</subagent_notification>"));
    assert.deepEqual(JSON.parse(fs.readFileSync(large.details.fullOutputPath, "utf8")), {
      agent_name: "task", status: "completed", final_response: event.finalResponse,
    });
    options.onActivityChange({ ...scope, status: "completed" });
    assert.deepEqual(component.render(100), ["○ Agents · 1 completed · /subagents to view details"]);
    const sent = f.messages.length;
    await f.emit("session_shutdown", { reason: "quit" });
    assert.equal(f.widgets.at(-1)[1], undefined);
    options.onCompletion(event);
    assert.equal(f.messages.length, sent, "no stale delivery after shutdown");
  `,
  );
});

test('startup summaries retain saved configured colors without exposing them in public lists or polling templates', () => {
  probe(
    hostFixture +
      `const { nativeTheme } = await import(${JSON.stringify(pathToFileURL(path.join(packageDir, 'tests', 'fixtures', 'ui-theme.ts')).href)});\n` +
      String.raw`
    let lists = 0, samples = 0;
    let entries = [
      { taskName: "configured", status: "running", color: "red" },
      { taskName: "invalid", status: "running", color: {} },
      { taskName: "old", status: "running" },
    ];
    AgentManager.prototype.listAgentInfos = () => { lists++; return entries; };
    AgentManager.prototype.listAgents = () => { throw new Error("presentation must not use the public tool view"); };
    AgentManager.prototype.getWidgetSnapshot = () => { samples++; return []; };
    const f = host(), theme = nativeTheme("dark");
    f.ctx.ui.theme = theme;
    await extension(f.pi);
    await f.emit("session_start");
    const component = f.widgets.at(-1)[1]({}, theme);
    const first = component.render(120);
    assert.ok(first[1].includes("\x1b[48;2;220;38;38m"));
    for (const row of first.slice(2)) assert.ok(!row.includes("\x1b[48;"));
    const sampled = samples;
    for (let frame = 0; frame < 5; frame++) component.render(120);
    assert.equal(samples, sampled, "render only uses captured snapshots");
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.ok(samples > sampled);
    assert.equal(lists, 1, "timer sampling must not reread history/templates");
    entries = [{ taskName: "configured", status: "running" }];
    const next = { ...f.ctx, sessionManager: { getSessionId: () => "next-parent" } };
    await f.emit("session_start", {}, next);
    assert.ok(!f.widgets.at(-1)[1]({}, theme).render(120).join("").includes("\x1b[48;"), "no previous-parent badge color");
    assert.equal(lists, 2);
    await f.emit("session_shutdown", { reason: "quit" }, next);
  `,
  );
});

test('summarizes every current-session agent by latest status without polling history or counting runs', () => {
  probe(
    hostFixture +
      String.raw`
    let listed = 0, sampled = 0;
    let entries = [
      ...[0, 1, 2].map(n => ({ taskName: "r" + n, status: n ? "running" : "pending_init" })),
      ...[0, 1, 2].map(n => ({ taskName: "c" + n, status: "completed" })),
      ...[0, 1, 2].map(n => ({ taskName: "f" + n, status: "errored" })),
      ...[0, 1, 2].map(n => ({ taskName: "i" + n, status: "interrupted" })),
    ];
    let expectedParent = "parent";
    AgentManager.prototype.listAgentInfos = (prefix, parent) => {
      assert.equal(prefix, undefined); assert.equal(parent, expectedParent);
      listed++; return entries;
    };
    AgentManager.prototype.getWidgetSnapshot = parent => {
      assert.equal(parent, expectedParent); sampled++; return [];
    };
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    const factory = f.widgets.filter(([, content]) => typeof content === "function").at(-1)[1];
    const component = factory({ terminal: { rows: 50 }, requestRender() {} }, { fg: (_c, s) => s });
    const lines = () => component.render(140);
    const title = () => lines()[0];
    assert.equal(title(), "● Agents · 3 running · 3 completed · 3 errored · 3 interrupted · /subagents to view details");
    assert.equal(lines().length, 7);
    assert.ok(lines().slice(1).join("\n").includes("r0"));
    assert.ok(!lines().slice(1).join("\n").match(/\b[cfi][0-2]\b/));
    const update = (name, status) => options.onActivityChange({
      parentSessionId: "parent", taskName: name, status,
    });
    update("r1", "running"); update("r1", "running"); update("r0", "running");
    options.onActivityChange({ parentSessionId: "other", taskName: "ignored", status: "errored" });
    assert.equal(title(), "● Agents · 3 running · 3 completed · 3 errored · 3 interrupted · /subagents to view details");
    update("r0", "completed");
    assert.equal(title(), "● Agents · 2 running · 4 completed · 3 errored · 3 interrupted · /subagents to view details");
    update("c0", "pending_init"); update("c0", "running");
    update("f0", "errored"); update("i0", "interrupted");
    assert.equal(title(), "● Agents · 3 running · 3 completed · 3 errored · 3 interrupted · /subagents to view details");
    update("r1", "errored"); update("r2", "interrupted"); update("c0", "completed");
    assert.deepEqual(lines(), ["○ Agents · 4 completed · 4 errored · 4 interrupted · /subagents to view details"]);
    const stoppedAt = sampled;
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(sampled, stoppedAt, "settled heading must not keep sampling");
    assert.equal(listed, 1, "lifecycle updates must not reread history");
    assert.equal(f.messages.length, 0, "status rendering must not send model messages");
    entries = [];
    expectedParent = "next-parent";
    const next = { ...f.ctx, sessionManager: { getSessionId: () => expectedParent } };
    await f.emit("session_start", {}, next);
    assert.equal(f.widgets.at(-1)[1], undefined);
    assert.deepEqual(component.render(140), []);
    options.onActivityChange({ parentSessionId: "parent", taskName: "old", status: "completed" });
    assert.equal(f.widgets.at(-1)[1], undefined);
    options.onActivityChange({ parentSessionId: expectedParent, taskName: "new", status: "running" });
    const newFactory = f.widgets.filter(([, content]) => typeof content === "function").at(-1)[1];
    const fresh = newFactory({}, { fg: (_c, s) => s });
    assert.equal(fresh.render(140)[0], "● Agents · 1 running · /subagents to view details");
    assert.equal(listed, 2);
    await f.emit("session_shutdown", { reason: "quit" }, next);
    assert.equal(f.widgets.at(-1)[1], undefined);
  `,
  );
});

test('restores a settled-only session heading without starting periodic history reads', () => {
  probe(
    hostFixture +
      String.raw`
    let lists = 0, samples = 0;
    AgentManager.prototype.listAgentInfos = () => { lists++; return [
      { taskName: "done", status: "completed" },
      { taskName: "error", status: "errored" },
      { taskName: "stopped", status: "interrupted" },
    ]; };
    AgentManager.prototype.getWidgetSnapshot = () => { samples++; return []; };
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    const factory = f.widgets.at(-1)[1];
    const component = factory({}, { fg: (_c, s) => s });
    assert.deepEqual(component.render(140), ["○ Agents · 1 completed · 1 errored · 1 interrupted · /subagents to view details"]);
    const idle = samples;
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(samples, idle);
    assert.equal(lists, 1);
    await f.emit("session_shutdown", { reason: "quit" });
    assert.equal(f.widgets.at(-1)[1], undefined);
  `,
  );
});

test('updates live model summaries without messages, focus changes, or repeated widget mounting', () => {
  probe(
    hostFixture +
      String.raw`
    let rows = [];
    const scopes = [];
    AgentManager.prototype.getWidgetSnapshot = parent => { scopes.push(parent); return rows; };
    const f = host();
    f.ctx.ui.custom = () => { throw new Error("summary must not take focus"); };
    await extension(f.pi);
    await f.emit("session_start");
    rows = [{
      taskName: "review", status: "running", provider: "openai-codex",
      modelId: "gpt-6.1-sol", thinking: "max", tokens: 33800,
      contextUsage: { contextWindow: 500000, tokens: 310000, percent: 62 },
      compactionCount: 1, elapsedMs: 12300, activeTools: ["read"],
      lastTaskMessage: "PRIVATE TASK DESCRIPTION", turnCount: 17, toolUses: 99,
    }];
    options.onActivityChange({ parentSessionId: "parent", taskName: "review", status: "running" });
    const factories = () => f.widgets.filter(([, content]) => typeof content === "function");
    const factory = factories().at(-1)[1];
    let renders = 0;
    const component = factory({ terminal: { rows: 40 }, requestRender() { renders++; } }, { fg: (_c, s) => s });
    const text = component.render(140).join("\n");
    assert.ok(text.includes("review"));
    assert.ok(text.includes("openai-codex/gpt-6.1-sol/max"));
    assert.ok(text.includes("33.8k token (62% · ↓1)"));
    assert.ok(text.includes("12s"));
    assert.ok(text.includes("reading"));
    assert.ok(!text.includes("PRIVATE TASK") && !text.includes("tool use") && !text.includes("↻"));
    const mounted = factories().length;
    assert.equal(mounted, 1);
    rows = [{ ...rows[0], thinking: "high", tokens: 40000 }];
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.ok(renders >= 3);
    const updated = component.render(140).join("\n");
    assert.ok(updated.includes("openai-codex/gpt-6.1-sol/high"));
    assert.ok(updated.includes("40.0k token (62% · ↓1) · 12s"));
    assert.equal(factories().length, mounted);
    assert.ok(scopes.length > 1 && scopes.every(scope => scope === "parent"));
    assert.equal(f.messages.length, 0);
    rows = [];
    options.onActivityChange({ parentSessionId: "parent", taskName: "review", status: "completed" });
    assert.deepEqual(component.render(140), ["○ Agents · 1 completed · /subagents to view details"]);
    await f.emit("session_shutdown", { reason: "quit" });
    component.dispose?.();
  `,
  );
});

test('does not mount summary widgets in RPC, JSON, or print mode', () => {
  probe(
    hostFixture +
      String.raw`
    for (const mode of ["rpc", "json", "print"]) {
      const f = host();
      f.ctx.mode = mode;
      f.ctx.hasUI = mode === "rpc";
      await extension(f.pi);
      await f.emit("session_start");
      options.onActivityChange({ parentSessionId: "parent", taskName: "task", status: "running" });
      assert.equal(f.widgets.length, 0);
      await f.emit("session_shutdown", { reason: "quit" });
      assert.equal(f.widgets.length, 0);
    }
  `,
  );
});

test.each(['regular', 'fullscreen'] as const)(
  'native %s summary redraws and resizes without taking editor focus',
  async (mode) => {
    let rows = [
      {
        taskName: 'review',
        status: 'running' as const,
        provider: 'openai-codex',
        modelId: 'gpt-6.1-sol',
        thinking: 'max' as const,
        tokens: 33800,
        elapsedMs: 12300,
        activeTools: ['read'],
      },
    ];
    const { terminal, writes, input, resize } = terminalFixture(140, 40);
    const tui = mode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    let component: any;
    let mounts = 0;
    const errors: unknown[] = [];
    const widget = new AgentSummaryWidget(
      () => rows,
      (error) => {
        errors.push(error);
        // Native notify() adds a chat component and requests another render.
        tui.addChild({ render: () => ['summary warning'], invalidate() {} });
        tui.requestRender();
      },
    );
    let brokenTheme = false;
    const theme = {
      fg: (_color: string, text: string) => {
        if (brokenTheme) throw new Error('broken summary theme');
        return text;
      },
    };
    const ctx: any = {
      mode: 'tui',
      sessionManager: { getSessionId: () => 'summary-native' },
      ui: {
        theme,
        setWidget(_key: string, content: any) {
          if (component) {
            tui.removeChild(component);
            component.dispose();
          }
          component = content?.(tui, theme);
          if (component) {
            mounts++;
            tui.addChild(component);
          }
        },
      },
    };
    widget.attach(ctx);
    widget.refresh();
    const typed: string[] = [];
    const editor = {
      render: (width: number) => ['> '.slice(0, width)],
      invalidate() {},
      handleInput(data: string) {
        typed.push(data);
      },
    };
    tui.addChild(editor);
    tui.setFocus(editor);
    tui.start();
    const draw = () => {
      writes.length = 0;
      tui.renderNow(true);
      return stripVTControlCharacters(writes.join(''));
    };
    try {
      expect(draw()).toContain('openai-codex/gpt-6.1-sol/max');
      rows = [{ ...rows[0], tokens: 40000 }];
      widget.refresh();
      expect(draw()).toContain('40.0k token');
      expect(mounts).toBe(1);
      for (const width of [1, 32, 80, 140]) {
        terminal.columns = width;
        resize();
        draw();
        expect(component.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(
          true,
        );
      }
      input('x');
      expect(typed).toEqual(['x']);
      expect(errors).toEqual([]);
      brokenTheme = true;
      draw();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(errors).toHaveLength(1); // A warning-driven redraw must not create more warnings.
      brokenTheme = false;
      draw();
      brokenTheme = true;
      draw();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(errors).toHaveLength(2); // A genuinely new failure after recovery is reported again.
    } finally {
      widget.dispose();
      tui.stop();
    }
  },
);

test('reports persistence/cleanup errors on every shutdown reason even if widget cleanup fails', () => {
  probe(
    hostFixture +
      String.raw`
    for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
      const f = host();
      await extension(f.pi);
      await f.emit("session_start");
      const count = shutdownCalls;
      options.onActivityChange({ parentSessionId: "parent", taskName: "task", status: "running" });
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
  'keeps SDK children and notification history without waking a natively canceled parent (%s)',
  (_name, executable) => {
    probe(
      String.raw`
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import * as path from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    process.env.PI_OFFLINE = "1";
    const { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
    const { configureCoreFixture, waitUntil } = await import(${JSON.stringify(pathToFileURL(CORE_SDK_EXTENSION).href)});
    const fixturePath = ${JSON.stringify(CORE_SDK_EXTENSION)};
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const config = path.join(agentDir, "pi-subagents", "config.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ extensions: [fixturePath] }));
    const settings = { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
    const textOf = message => typeof message.content === "string" ? message.content :
      (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
    for (const cancellation of ["session.abort (Esc)", "ctx.abort (budget controller)"]) {
      let releaseChild, budgetAborts = 0, parentRun;
      const childGate = new Promise(resolve => { releaseChild = resolve; });
      const fixture = configureCoreFixture({ responseGate: childGate });
      const starts = [], settled = [], errors = [];
      const settingsManager = SettingsManager.inMemory(settings);
      settingsManager.setProjectTrusted(true);
      const services = await createAgentSessionServices({
        cwd: agentDir, agentDir, settingsManager, resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          additionalExtensionPaths: [process.argv[2], fixturePath],
          extensionFactories: [pi => {
            pi.on("agent_start", (_event, ctx) => { starts.push(ctx.signal); });
            pi.on("agent_settled", event => { settled.push(event.aborted); });
            pi.on("message_update", (event, ctx) => {
              // A budget controller uses native cancellation, not a special event or error text.
              if (cancellation.startsWith("ctx.abort") && !budgetAborts &&
                  event.assistantMessageEvent.type === "toolcall_delta") {
                budgetAborts++;
                ctx.abort();
              }
            });
          }],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const model = (await services.modelRuntime.getAvailable("test")).find(model => model.id === "fake");
      assert.ok(model);
      const { session } = await createAgentSessionFromServices({ services, model, sessionManager: SessionManager.inMemory(agentDir) });
      const notifications = () => session.messages.filter(message =>
        message.role === "custom" && message.customType === "pi-subagent-completion");
      const call = (name, args) => session.getToolDefinition(name).execute(
        "cancellation-test", args, undefined, undefined, session.extensionRunner.createContext());
      try {
        await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
        const parent = fixture.instances[0];
        await call("spawn_agent", { task_name: "survivor", message: "hold child " + cancellation });
        const child = fixture.instances.at(-1);
        assert.notEqual(child, parent);
        await waitUntil(() => child.activeStreams === 1);
        parentRun = session.prompt("stream parent " + cancellation);
        void parentRun.catch(() => {});
        await waitUntil(() => parent.requests.length === 1);
        if (cancellation.startsWith("session.abort")) await session.abort();
        await parentRun;
        await session.waitForIdle();
        assert.deepEqual(settled, [true], cancellation);
        assert.equal(starts.length, 1, cancellation);
        assert.equal(starts[0].aborted, true, cancellation + ": native run signal is canceled");
        assert.equal(session.extensionRunner.createContext().signal, undefined, "SDK clears the run signal after settlement");
        assert.equal(budgetAborts, cancellation.startsWith("ctx.abort") ? 1 : 0);
        assert.equal(parent.activeStreams, 0, cancellation);
        assert.equal(child.activeStreams, 1, cancellation + ": parent abort must not cancel the child");
        assert.ok(!child.events.includes("settled:aborted"), cancellation);
        assert.equal((await call("list_agents", {})).structuredContent.agents[0].agent_status, "running", cancellation);
        releaseChild();
        await waitUntil(() => notifications().length === 1);
        await session.waitForIdle();
        await delay(100);
        assert.equal(parent.requests.length, 1, cancellation + ": child completion must not wake the canceled parent");
        assert.equal(child.activeStreams, 0, cancellation);
        const notification = notifications()[0];
        assert.deepEqual(notification.details, { agent_name: "survivor", status: "completed" });
        assert.equal(notification.display, true);
        assert.ok(textOf(notification).includes("response:hold child " + cancellation), "completed child output stays in history");
        await session.prompt("resume after " + cancellation);
        await session.waitForIdle();
        assert.equal(parent.requests.length, 2, "new user prompt starts a real parent run");
        assert.ok(parent.requests[1].context.messages.some(message => textOf(message).includes(textOf(notification))),
          "resumed parent can see the stored notification");
        assert.equal(starts[1].aborted, false, "new run has a fresh cancellation signal");
        await call("spawn_agent", { task_name: "after-resume", message: "idle child after " + cancellation });
        await waitUntil(() => parent.requests.length === 3);
        await session.waitForIdle();
        assert.equal(notifications().length, 2);
        assert.equal(parent.requests.length, 3, "normal idle notification wakeup resumes after a real agent_start");
        assert.ok(parent.requests[2].context.messages.some(message => textOf(message).includes("response:idle child after " + cancellation)));
        assert.deepEqual(settled, [true, false, false]);
        assert.deepEqual(errors, []);
      } finally {
        releaseChild();
        await session.abort();
        await parentRun?.catch(() => {});
        try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
        finally { session.dispose(); }
      }
    }
  `,
      executable,
    );
  },
);

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
    const { configureCoreFixture, waitUntil } = await import(${JSON.stringify(pathToFileURL(path.join(packageDir, 'tests', 'fixtures', 'core-sdk-fixture.ts')).href)});
    const { getCurrentTools } = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))});
    const fixturePath = ${JSON.stringify(CORE_SDK_EXTENSION)};
    const fixture = configureCoreFixture();
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const directory = path.join(agentDir, "pi-subagents");
    const templatePath = path.join(directory, "agents", "multiline.md");
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ extensions: [fixturePath] }));
    const template = [
      "---", "name: multiline", "description: |-", "  First exploration line.", "  <rules>",
      "    <rule>Reuse & trust.</rule>", "  </rules>", "  Give exact paths.", "  - Narrow scope.",
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
        assert.match(description, /continue other.*work/i);
        assert.ok(description.includes("wait_agent only when blocked"));
        assert.ok(description.includes("  Description:\n    " + firstLine + "\n    <rules>\n      <rule>Reuse & trust.</rule>\n    </rules>\n    Give exact paths.\n    - Narrow scope."), description);
        assert.ok(description.includes("model: test/fake — thinking: off"), description);
        assert.ok(!description.includes("Child template instructions."));
        assert.ok(description.includes("Use explorer for specific codebase questions."));
        assert.ok(description.includes("General agent"));
        assert.ok(description.includes("Use for execution and production work."));
        assert.ok(description.includes("Explicitly assign ownership"));
        assert.ok(!description.includes("You are not alone in the codebase"));
      };
      checkDescription(spawnTool().description, "First exploration line.");
      await session.prompt("Inspect template descriptions.");
      checkDescription(getCurrentTools(fixture.instances[0].requests.at(-1).context.messages).find(tool => tool.name === "spawn_agent").description, "First exploration line.");
      const ctx = session.extensionRunner.createContext();
      const result = await spawnTool().execute("spawn", { task_name: "multiline-child", agent_type: "multiline", message: "work" }, undefined, undefined, ctx);
      await waitUntil(() => fixture.instances.at(-1).events.includes("settled:success"));
      await session.waitForIdle(); // The completion notification also resumes an idle parent.
      assert.equal(result.details.provider, "test");
      assert.equal(result.details.modelId, "fake");
      assert.equal(result.details.thinking, "off");
      assert.equal(fixture.instances.at(-1).inputs[0].text, "Child template instructions.\n\nwork");
      fs.writeFileSync(templatePath, template.replace("First exploration line.", "Updated exploration line."));
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
    const { configureCoreFixture, waitUntil } = await import(${JSON.stringify(pathToFileURL(path.join(packageDir, 'tests', 'fixtures', 'core-sdk-fixture.ts')).href)});
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
    const writeConfig = models => fs.writeFileSync(config, JSON.stringify({ extensions: [fixturePath], ...(models ? { models } : {}) }));
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
        await waitUntil(() => child.events.includes("settled:success"));
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
  'native codemode receives structured subagent results and preserves errors and redaction (%s)',
  (_name, executable) => {
    probe(
      String.raw`
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import * as path from "node:path";
    const { Value } = await import(${JSON.stringify(import.meta.resolve('typebox/value'))});
    const { createAgentSessionServices, createAgentSessionFromServices, createCodemodeExtension, SessionManager, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const fixtureSource = ${JSON.stringify(path.join(packageDir, 'tests', 'fixtures', 'sdk-offline-extension.ts'))};
    const fixture = (name, config) => {
      const directory = path.join(agentDir, name);
      fs.mkdirSync(directory);
      const extension = path.join(directory, "extension.ts");
      fs.copyFileSync(fixtureSource, extension);
      fs.writeFileSync(path.join(directory, "sdk-fixture.json"), JSON.stringify(config));
      return { extension };
    };
    const child = fixture("child-provider", { prefix: "child" });
    const script = [
      'await tools.spawn_agent({ task_name: "worker", message: "first" });',
      'const waited = await tools.wait_agent({});',
      'if (typeof waited !== "object" || typeof waited.message !== "string" || waited.timed_out !== false || Object.keys(waited).length !== 2) throw new Error("wait contract");',
      'await tools.fixture_resident_done({ expected: "child: first" });',
      'const listed = await tools.list_agents({});',
      'if (listed === null || typeof listed !== "object" || Object.keys(listed).join() !== "agents" || !Array.isArray(listed.agents) || listed.agents.length !== 1 || Object.keys(listed.agents[0]).sort().join() !== "agent_name,agent_status" || listed.agents[0].agent_name !== "worker" || listed.agents[0].agent_status?.completed !== "child: first") throw new Error("list contract");',
      'const failures = await Promise.allSettled([tools.send_message({ target: "missing", message: "never delivered" }), tools.wait_agent({ timeout_ms: 3600001 })]);',
      'if (failures.some(result => result.status !== "rejected")) throw new Error("tool errors must reject");',
      'const redacted = await tools.list_agents({});',
      'if (redacted !== "redacted by test hook") throw new Error("native redaction must not leak structured data");',
      'await tools.send_message({ target: "worker", message: "x".repeat(100000) });',
      'const second = await tools.wait_agent({});',
      'if (typeof second.message !== "string" || second.timed_out !== false) throw new Error("second wait contract");',
      'await tools.fixture_resident_done({ expected: "child: " + "x".repeat(100000) });',
      'const large = await tools.list_agents({ path_prefix: "worker" });',
      'const finalResponse = large.agents[0]?.agent_status?.completed;',
      'if (finalResponse !== "child: " + "x".repeat(100000)) throw new Error("large structured response");',
      'text({ marker: "structured-codemode-ok", responseLength: finalResponse.length });',
    ].join("\n");
    const parent = fixture("parent-provider", { codemodeScript: script });
    const configDir = path.join(agentDir, "pi-subagents");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ retentionDays: 0, extensions: [child.extension] }));
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
      defaultTools: ["+codemode"], codemode: { mode: "only", inlineBudget: 0 },
    });
    settingsManager.setProjectTrusted(false);
    const successful = [], failures = [];
    let listCalls = 0;
    const services = await createAgentSessionServices({ cwd: agentDir, agentDir, settingsManager,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [process.argv[2], parent.extension],
        extensionFactories: [createCodemodeExtension(), pi => {
          pi.registerTool({ name: "fixture_resident_done", label: "Child gate", description: "Test-only resident completion synchronizer",
            parameters: { type: "object", properties: { expected: { type: "string" } }, required: ["expected"] },
            async execute(_id, { expected }, _signal, _update, ctx) {
              const { setTimeout: delay } = await import("node:timers/promises");
              // This fixture retains its single idle worker, so it remains listable after completion.
              for (let attempt = 0; attempt < 250; attempt++) {
                const { structuredContent: { agents } } = await session.getToolDefinition("list_agents").execute(
                  "child-gate", { path_prefix: "worker" }, undefined, undefined, ctx);
                if (agents.some(agent => agent.agent_name === "worker" && agent.agent_status?.completed === expected))
                  return { content: [{ type: "text", text: "child settled" }], details: {} };
                await delay(20);
              }
              throw new Error("Timed out waiting for the retained child response.");
            },
          });
          pi.on("tool_result", event => {
            if (event.toolName === "list_agents" && ++listCalls === 2)
              return { content: [{ type: "text", text: "redacted by test hook" }] };
          });
          pi.on("tool_execution_end", event => {
            if (!["wait_agent", "list_agents", "send_message"].includes(event.toolName)) return;
            if (event.isError) { failures.push(event); return; }
            const schema = schemas.get(event.toolName);
            if (!schema) return;
            if (event.toolName === "list_agents" && event.result.content[0]?.text === "redacted by test hook") {
              assert.equal(event.result.structuredContent, undefined);
              return;
            }
            assert.ok(Value.Check(schema, event.result.structuredContent), event.toolName + " schema");
            successful.push(event);
          });
        }],
      },
    });
    const model = (await services.modelRuntime.getAvailable("sdk-offline")).find(model => model.id === "exact/model");
    assert.ok(model);
    const { session } = await createAgentSessionFromServices({ services, model, sessionManager: SessionManager.inMemory(agentDir) });
    const schemas = new Map(["wait_agent", "list_agents"].map(name => [name, session.getToolDefinition(name).outputSchema]));
    const errors = [];
    try {
      await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
      await session.prompt("Exercise structured subagent results", { source: "rpc" });
      await session.waitForIdle();
      const result = session.messages.find(message => message.role === "toolResult" && message.toolName === "codemode");
      assert.ok(result && !result.isError, JSON.stringify(result));
      const output = JSON.stringify(result.content);
      assert.ok(output.includes("structured-codemode-ok"), output);
      assert.ok(output.includes("100007"), output);
      assert.ok(!output.includes("x".repeat(1000)), "codemode must only print the selected fields");
      assert.deepEqual(successful.map(event => event.toolName), ["wait_agent", "list_agents", "wait_agent", "list_agents"]);
      assert.deepEqual(failures.map(event => event.toolName).sort(), ["send_message", "wait_agent"]);
      assert.equal(listCalls, 3, "only the second native list is redacted");
      assert.ok(failures.every(event => event.result.structuredContent === undefined));
      const large = successful.at(-1).result;
      const { fullOutputPath } = large.details;
      const expected = { agents: [{ agent_name: "worker", agent_status: { completed: "child: " + "x".repeat(100000) } }] };
      assert.deepEqual(large.structuredContent, expected);
      assert.deepEqual(large.details, { agentCount: 1, truncated: true, fullOutputPath });
      assert.ok(large.content[0].text.includes("Output truncated"));
      assert.ok(!large.content[0].text.includes("x".repeat(1000)), "the oversized response line stays out of the text preview");
      assert.deepEqual(JSON.parse(fs.readFileSync(fullOutputPath, "utf8")), expected);
      assert.equal(session.messages.filter(message => message.role === "custom" && message.customType === "pi-subagent-completion").length, 2);
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
  'native activity waits deliver original input and child notifications once without extra SDK turns (%s)',
  (_name, executable) => {
    probe(
      String.raw`
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import * as path from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    process.env.PI_OFFLINE = "1";
    const { createAgentSessionServices, createAgentSessionFromServices, createCodemodeExtension, SessionManager, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
    const fixtureSource = ${JSON.stringify(path.join(packageDir, 'tests', 'fixtures', 'sdk-offline-extension.ts'))};
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const textOf = message => typeof message.content === "string" ? message.content :
      (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
    for (const activity of ["input", "notification", "early-input", "early-notification"]) {
      const fixture = (name, config) => {
        const directory = path.join(agentDir, activity + "-" + name);
        fs.mkdirSync(directory);
        const extension = path.join(directory, "extension.ts");
        fs.copyFileSync(fixtureSource, extension);
        fs.writeFileSync(path.join(directory, "sdk-fixture.json"), JSON.stringify(config));
        return { directory, extension };
      };
      const child = fixture("child", { prefix: "child", responseGate: true });
      const script = [
        ...(activity === "notification" ? ['await tools.spawn_agent({ task_name: "worker", message: "original child task" });'] : []),
        'const result = await tools.wait_agent({});',
        'text({ marker: "activity-wait-returned", result });',
      ].join("\n");
      const parent = fixture("parent", { prefix: "parent", codemodeScript: script });
      const configDir = path.join(agentDir, "pi-subagents");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ retentionDays: 0, extensions: [child.extension] }));
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
        defaultTools: ["+codemode"], codemode: { mode: "only", inlineBudget: 0 },
      });
      settingsManager.setProjectTrusted(false);
      const waitStarted = Promise.withResolvers(), earlyNotice = Promise.withResolvers();
      const waitResults = [], starts = [], turns = [], contexts = [], payloads = [], errors = [];
      const initialInput = "Start an activity wait", earlyInput = "early steering already in the first context";
      let session;
      const services = await createAgentSessionServices({ cwd: agentDir, agentDir, settingsManager,
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          additionalExtensionPaths: [process.argv[2], parent.extension],
          extensionFactories: [createCodemodeExtension(), pi => {
            pi.on("agent_start", () => { starts.push("start"); });
            pi.on("turn_start", () => { turns.push("turn"); });
            pi.on("context", event => { contexts.push(structuredClone(event.messages)); });
            pi.on("before_provider_request", event => { payloads.push(event.payload); });
            pi.on("message_end", async (event, ctx) => {
              if (!activity.startsWith("early-") || event.message.role !== "user" || textOf(event.message) !== initialInput) return;
              assert.equal(turns.length, 1, "early activity arrives after turn_start");
              assert.equal(contexts.length, 0, "early activity arrives before the first context preparation");
              if (activity === "early-input") {
                await session.prompt(earlyInput, { source: "rpc", streamingBehavior: "steer" });
              } else {
                const spawned = await session.getToolDefinition("spawn_agent").execute("early-child",
                  { task_name: "worker", message: "original child task" }, undefined, undefined, ctx);
                assert.equal(spawned.details.task_name, "worker");
                fs.writeFileSync(path.join(child.directory, "release-response"), "");
                await earlyNotice.promise;
              }
            });
            pi.on("tool_execution_start", event => { if (event.toolName === "wait_agent") waitStarted.resolve(); });
            pi.on("tool_execution_end", event => { if (event.toolName === "wait_agent") waitResults.push(event); });
          }],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const model = (await services.modelRuntime.getAvailable("sdk-offline")).find(model => model.id === "exact/model");
      assert.ok(model);
      ({ session } = await createAgentSessionFromServices({ services, model, sessionManager: SessionManager.inMemory(agentDir) }));
      if (activity === "early-notification") {
        const sendCustomMessage = session.sendCustomMessage;
        session.sendCustomMessage = function(message, delivery) {
          const result = sendCustomMessage.call(this, message, delivery);
          if (message.customType === "pi-subagent-completion") earlyNotice.resolve();
          return result;
        };
      }
      let run;
      try {
        await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
        run = session.prompt(initialInput, { source: "rpc" });
        void run.catch(() => {});
        await waitStarted.promise;
        await delay(10);
        assert.equal(session.isStreaming, true);
        assert.equal(waitResults.length, 0, "the wait must still be blocked when activity arrives");
        const input = "original rpc steering message";
        if (activity === "notification") fs.writeFileSync(path.join(child.directory, "release-response"), "");
        else await session.prompt(input, { source: "rpc", streamingBehavior: "steer" });
        await run;
        await session.waitForIdle();
        await delay(30);
        assert.equal(waitResults.length, 1);
        assert.equal(waitResults[0].isError, false);
        const expected = { message: activity === "notification" ? "Wait completed." : "Wait interrupted by new input.", timed_out: false };
        assert.deepEqual(waitResults[0].result.details, expected);
        assert.deepEqual(waitResults[0].result.structuredContent, expected);
        assert.deepEqual(JSON.parse(waitResults[0].result.content[0].text), expected);
        const events = fs.readFileSync(path.join(parent.directory, "sdk-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        const requests = events.filter(event => event.type === "request");
        assert.equal(requests.length, 2, activity + ": only the original request and natural post-tool continuation");
        assert.equal(payloads.length, 0, "the custom provider never invokes onPayload");
        assert.equal(contexts.length, 2, "every request prepares context without provider callbacks");
        assert.equal(turns.length, 2);
        assert.equal(starts.length, 1, "activity must not schedule an extra parent run");
        assert.equal(requests[0].userTexts.filter(text => text === initialInput).length, 1);
        if (activity !== "notification") {
          assert.equal(requests[1].userTexts.filter(text => text === input).length, 1);
          assert.equal(session.messages.filter(message => message.role === "user" && textOf(message) === input).length, 1);
          const inputs = events.filter(event => event.type === "input" && event.text === input);
          assert.equal(inputs.length, 1);
          assert.equal(inputs[0].source, "rpc");
          assert.equal(inputs[0].streamingBehavior, "steer");
        }
        if (activity === "early-input") {
          assert.equal(requests[0].userTexts.filter(text => text === earlyInput).length, 1, "early steering is already in the first context");
          assert.equal(session.messages.filter(message => message.role === "user" && textOf(message) === earlyInput).length, 1);
          assert.equal(events.filter(event => event.type === "input" && event.text === earlyInput).length, 1);
        }
        if (activity.includes("notification")) {
          const request = requests[activity === "early-notification" ? 0 : 1];
          const notices = request.userTexts.filter(text => text.startsWith("<subagent_notification>"));
          assert.equal(notices.length, 1);
          const original = JSON.parse(notices[0].replace("<subagent_notification>", "").replace("</subagent_notification>", ""));
          assert.deepEqual(original, { agent_name: "worker", status: "completed", final_response: "child: original child task" });
          assert.equal(session.messages.filter(message => message.role === "custom" && message.customType === "pi-subagent-completion").length, 1);
        }
        const controller = new AbortController();
        let lateSettled = false;
        const late = session.getToolDefinition("wait_agent").execute("after-request", {}, controller.signal, undefined, session.extensionRunner.createContext());
        late.then(() => { lateSettled = true; }, () => {});
        const rejection = assert.rejects(late, error => error === controller.signal.reason);
        await delay(5);
        assert.equal(lateSettled, false, "context preparation cleared already-delivered pending activity");
        controller.abort(new Error("cancel late wait"));
        await rejection;
        assert.deepEqual(errors, []);
      } finally {
        fs.writeFileSync(path.join(child.directory, "release-response"), "");
        await session.abort();
        await run?.catch(() => {});
        try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
        finally { session.dispose(); }
      }
    }
  `,
      executable,
    );
  },
);

test.each(runtimes)(
  'runs the public tools with raw timeout validation and repeated child cleanup alongside an active SDK parent (%s)',
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
    // This probe exercises actual repeated child cleanup, not hot idle retention.
    fs.writeFileSync(config, JSON.stringify({ retentionDays: 0, maxAgents: 1, extensions: [childFixture.extension] }));
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, steeringMode: "one-at-a-time" });
    settingsManager.setProjectTrusted(false);
    const parentRequests = [];
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
            streamSimple(model, context, options) {
              parentRequests.push(structuredClone(context.messages));
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
              void (async () => {
                await options?.onPayload?.({ messages: context.messages }, model);
                stream.push({ type: "start", partial: message });
                stream.push({ type: "done", reason: message.stopReason, message });
                stream.end();
              })();
              return stream;
            },
          });
          pi.registerTool({ name: "host_driver", label: "Host test", description: "Offline public-tool driver",
            parameters: { type: "object", properties: {} },
            async execute(_id, _args, _signal, _update, ctx) {
              try {
                await drive(ctx);
                return { content: [{ type: "text", text: "public tools verified" }], details: {} };
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
        // Keep continuations cold via host-managed native shutdown, after native work drains.
        for (const child of childSessions) {
          await child.waitForIdle();
          child.extensionRunner.createContext().shutdown();
        }
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
        // ctx.executeTool exercises native prepareArguments before Pi can coerce raw values.
        for (const timeout_ms of [1.5, false, "10000", 3600000.9]) {
          const controller = new AbortController();
          const guard = setTimeout(() => controller.abort(new Error("invalid timeout entered a wait")), 1000);
          try {
            const result = await ctx.executeTool("wait_agent", { timeout_ms }, { signal: controller.signal });
            assert.equal(result.isError, true, "raw timeout: " + JSON.stringify(timeout_ms));
            assert.equal(controller.signal.aborted, false, "raw timeout must fail before waiting: " + JSON.stringify(timeout_ms));
            assert.match(JSON.stringify(result.result.content), /timeout_ms.*integer/i);
          } finally { clearTimeout(guard); }
        }
        // Exercise the native nested-tool schema path; direct execute would bypass this validation.
        for (const args of [{ include_all: true }, { limit: 1 }, { offset: 0 }]) {
          const rejected = await ctx.executeTool("list_agents", args);
          assert.equal(rejected.isError, true, "removed list arguments: " + JSON.stringify(args));
          assert.match(JSON.stringify(rejected.result.content), new RegExp(Object.keys(args)[0]));
        }
        for (const path_prefix of [null, 123, true, false, [], ["review"], {}, "", "   ",
          "/review", "review/", " review ", "review//auth", "review\n", "review\r", "review\u2028", "review\u2029"]) {
          const rejected = await ctx.executeTool("list_agents", { path_prefix });
          assert.equal(rejected.isError, true, "invalid list path: " + JSON.stringify(path_prefix));
          assert.match(JSON.stringify(rejected.result.content), /path_prefix/);
        }
        assert.equal(created, 0, "invalid list arguments must not allocate children");
        const spawned = await call("spawn_agent", { task_name: "worker", message: "child work" });
        assert.equal(spawned.details.task_name, "worker");
        for (const target of ["/worker", "worker/"]) {
          for (const name of ["send_message", "interrupt_agent"]) {
            const args = name === "send_message" ? { target, message: "must not deliver" } : { target };
            const rejected = await ctx.executeTool(name, args);
            assert.equal(rejected.isError, true, name + ": " + target);
            assert.match(JSON.stringify(rejected.result.content), /task_name must use/);
          }
          const rejected = await ctx.executeTool("spawn_agent", { task_name: target, message: "must not run" });
          assert.equal(rejected.isError, true, "invalid spawn: " + target);
          assert.match(JSON.stringify(rejected.result.content), /task_name must use/);
        }
        assert.equal(created, 1, "invalid names must not allocate children");
        assert.equal(disposed, 0, "invalid targets must not stop the existing worker");
        assert.equal((await call("list_agents", {})).structuredContent.agents[0].agent_status, "running");
        assert.deepEqual((await call("list_agents", { path_prefix: "worker" })).structuredContent.agents,
          [{ agent_name: "worker", agent_status: "running" }]);
        assert.deepEqual((await call("list_agents", { path_prefix: "work" })).structuredContent.agents, []);
        // Spawn acceptance precedes the worker's assistant-response timer.
        const responseDeadline = Date.now() + 2_000;
        while (!timeouts.size && Date.now() < responseDeadline) await delay(5);
        assert.equal(timeouts.size, 1, "worker response timer must be active before comparing resources");
        const activeResources = counts();
        const blocked = await ctx.executeTool("spawn_agent", { task_name: "blocked", message: "over capacity" });
        assert.equal(blocked.isError, true);
        assert.match(JSON.stringify(blocked.result.content), /capacity/i);
        assert.deepEqual((await call("list_agents", {})).structuredContent.agents.map(agent => [agent.agent_name, agent.agent_status]), [["worker", "running"]],
          "capacity rejection must not leave an agent record");
        assert.deepEqual(counts(), activeResources, "capacity rejection must not allocate child resources");
        assert.equal(created, 1);
        assert.equal(disposed, 0);
        assert.equal(session.isStreaming, true, "the active parent does not consume child capacity");
        assert.equal((await call("send_message", { target: "worker", message: "steered work" })).details.delivery, "steer");
        const controller = new AbortController();
        const canceledWait = ctx.executeTool("wait_agent", {}, { signal: controller.signal });
        await delay(5);
        controller.abort(new Error("cancel only the wait"));
        assert.equal((await canceledWait).isError, true);
        assert.equal((await call("list_agents", {})).structuredContent.agents[0].agent_status, "running");
        const waiting = call("wait_agent", { timeout_ms: 10000 });
        await delay(5);
        fs.writeFileSync(path.join(childFixture.directory, "release-response"), "");
        const completion = JSON.parse((await waiting).content[0].text);
        assert.deepEqual(completion, { message: "Wait completed.", timed_out: false });
        await reclaimed("initial completion");
        assert.deepEqual((await call("list_agents", {})).structuredContent, { agents: [] },
          "a cold worker is not listed; its completion is delivered to the parent below");
        const finishWaiting = async () => {
          const waiting = call("wait_agent", { timeout_ms: null });
          await delay(5);
          fs.writeFileSync(path.join(childFixture.directory, "release-response"), "");
          assert.deepEqual(JSON.parse((await waiting).content[0].text), { message: "Wait completed.", timed_out: false });
          // A repeated wait can consume earlier pending activity; reclaimed() below is the terminal cleanup gate.
        };
        settingsManager.setProjectTrusted(true);
        fs.rmSync(path.join(childFixture.directory, "release-response"));
        assert.equal((await call("send_message", { target: "worker", message: "resumed work" })).details.delivery, "prompt");
        await finishWaiting();
        const events = fs.readFileSync(path.join(childFixture.directory, "sdk-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert.deepEqual(events.filter(event => event.type === "session_start").map(event => event.trusted), [false, true]);
        await reclaimed("first resumption");
        for (let turn = 0; turn < 8; turn++) {
          fs.rmSync(path.join(childFixture.directory, "release-response"));
          await call("send_message", { target: "worker", message: "repeat " + turn });
          await finishWaiting();
          await reclaimed("repeated resumption " + turn);
          assert.equal(session.isStreaming, true);
        }
        fs.rmSync(path.join(childFixture.directory, "release-response"));
        await call("spawn_agent", { task_name: "canceled", message: "cancel child work" });
        assert.equal((await call("interrupt_agent", { target: "canceled" })).details.previous_status, "running");
        assert.equal((await call("list_agents", {})).structuredContent.agents.find(agent => agent.agent_name === "canceled").agent_status, "interrupted");
        await reclaimed("interruption");
        assert.deepEqual((await call("list_agents", {})).structuredContent, { agents: [] }, "terminated children leave only disk history");
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
      assert.equal(parentRequests.length, 2, "waiting completions must share the natural continuation");
      const textOf = message => typeof message.content === "string" ? message.content : (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
      const notifications = messages => messages.map(textOf).filter(text => text.startsWith("<subagent_notification>"))
        .map(text => JSON.parse(text.replace("<subagent_notification>", "").replace("</subagent_notification>", "")));
      const delivered = notifications(parentRequests[1]);
      assert.deepEqual(delivered.map(result => result.final_response), ["child: steered work", "child: resumed work", ...Array.from({ length: 8 }, (_, turn) => "child: repeat " + turn)]);
      const ctx = session.extensionRunner.createContext();
      const direct = (name, args) => session.getToolDefinition(name).execute("idle-test", args, undefined, undefined, ctx);
      await direct("spawn_agent", { task_name: "idle", message: "idle result" });
      fs.writeFileSync(path.join(childFixture.directory, "release-response"), "");
      const deadline = Date.now() + 2_000;
      while (parentRequests.length < 3 && Date.now() < deadline) await delay(5);
      await session.waitForIdle();
      await reclaimed("idle automatic completion");
      assert.equal(parentRequests.length, 3, "an idle parent must still wake automatically");
      const idleNotifications = notifications(parentRequests[2]);
      assert.equal(idleNotifications.length, 11);
      assert.deepEqual(idleNotifications.at(-1), { agent_name: "idle", status: "completed", final_response: "child: idle result" });
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const waiting = session.getToolDefinition("wait_agent").execute("late-wait", {}, controller.signal, undefined, ctx);
        const rejection = assert.rejects(waiting, error => error === controller.signal.reason);
        await delay(5);
        controller.abort(new Error("late waits do not replay old completions"));
        await rejection;
      }
      await delay(10);
      assert.equal(parentRequests.length, 3, "late/repeated waits must not trigger another notification or turn");
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
    fs.writeFileSync(config, JSON.stringify({ retentionDays: 0, extensions: [child.extension] }));
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
      assert.equal(result.details.task_name, task);
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
        'src/color.ts',
        'src/core.ts',
        'src/index.ts',
        'package.json',
        'src/peek.ts',
        'src/runtime.ts',
        'src/widget.ts',
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
      expect(manifest.peerDependencies['@earendil-works/' + name]).toBe('>=1.1.0');
    }
    for (const version of Object.values(manifest.devDependencies)) expect(version).toBe('latest');
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
      expect([...subagents.tools.keys()]).toEqual(toolNames);
      expect(() => loaded.runtime.getActiveTools()).toThrow('Extension runtime not initialized');

      const parentId = 'renderer-contract-parent';
      const scope = path.join(getRunsDir(), parentScopeKey(parentId));
      fs.mkdirSync(scope, { recursive: true });
      const id = randomUUID();
      const info: AgentInfo = {
        id,
        parentSessionId: parentId,
        taskName: 'contract',
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
      let detail: SubagentPeekOverlay | undefined;
      let keptOpen = false;
      const ctx: any = {
        mode: 'tui',
        sessionManager: { getSessionId: () => parentId },
        ui: {
          setWidget() {},
          async custom(create: any) {
            let component: any;
            let close!: () => void;
            const closed = new Promise<void>((resolve) => {
              close = resolve;
            });
            component = create(
              { terminal: { rows: 80 }, requestRender() {} },
              { fg: (_color: string, text: string) => text, bold: (text: string) => text },
              {},
              close,
            );
            opened++;
            try {
              if (component instanceof SubagentPeekOverlay) {
                detail = component;
                component.handleInput('\x0f');
                keptOpen = !component['disposed'];
                component.handleInput('q');
              } else {
                component.render(120);
                component.handleInput('\r');
                await new Promise((resolve) => setImmediate(resolve));
                component.handleInput('q');
              }
              await closed;
            } finally {
              component.dispose?.();
            }
          },
        },
      };
      try {
        await subagents.commands.get('subagents')!.handler('', ctx);
        expect(opened).toBe(2);
        expect(detail).toBeInstanceOf(SubagentPeekOverlay);
        expect(detail!['nativeCodemodeRenderers']).toEqual(collected);
        expect(Object.keys(detail!['nativeCodemodeRenderers'])).toEqual([
          'renderShell',
          'renderCall',
          'renderResult',
        ]);
        expect(detail!['toolExecutionOptions']).toEqual({
          showImages: false,
          imageWidthCells: 42,
          outputPad: 0,
        });
        expect(keptOpen).toBe(true);
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
          parentSessionId: parent,
          status: 'completed',
          cwd: TEST_AGENT_DIR,
          provider: 'test',
          modelId: 'fake',
          thinking: 'off',
          createdAt: now,
          updatedAt: now,
          completedAt: overrides.createdAt ?? now,
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
        hasUI: true,
        sessionManager: { getSessionId: () => parentId },
        ui: { notify, setWidget() {} },
      };
      const detailRuns: Promise<unknown>[] = [];
      const flushDetails = async () => {
        do {
          await Promise.all(detailRuns.splice(0));
          await new Promise((resolve) => setImmediate(resolve));
        } while (detailRuns.length);
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
        flushDetails,
        tui: { terminal: { rows: 40 }, requestRender } as any,
        remove(info: AgentInfo) {
          fs.rmSync(info.infoFile, { force: true });
        },
        command: () => commands.get('subagents').handler('', ctx),
        async open(
          interact: (browser: any) => any,
          overlay?: (component: any, index: number) => any,
        ) {
          ctx.ui.custom = (create: any, options: any) => {
            let component: any;
            let result: any;
            let closed = false;
            const done = (value: any) => {
              if (closed) return;
              closed = true;
              result = value;
              if (!options?.overlay) selections.push(value);
              component?.dispose?.();
            };
            component = create(fixture.tui, fixture.theme, {}, done);
            const interaction = (async () => {
              try {
                if (options?.overlay) {
                  opened.push(component['info']);
                  await overlay?.(component, opened.length - 1);
                } else {
                  await interact(component);
                  await flushDetails();
                  if (!closed) done(undefined);
                }
                return result;
              } finally {
                component.dispose?.();
              }
            })();
            if (options?.overlay) detailRuns.push(interaction);
            return interaction;
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

    const browserNames = (browser: any) =>
      browser
        .render(120)
        .map(stripVTControlCharacters)
        .filter((line: string) =>
          /^[› ] \S+\s+(?:pending_init|running|completed|errored|interrupted)\s/.test(line),
        )
        .map((line: string) => line.trim().replace(/^› /, '').split(/\s+/)[0]);

    test('always groups Active before Done with presentation-only ordering', async () => {
      await withBrowser(async (f) => {
        await f.open(async (browser: any) => {
          // Seed after manager initialization so recovery does not interrupt display fixtures.
          f.put('running', { status: 'running', createdAt: 100, lastActivity: 9999 });
          f.put('initializing', { status: 'pending_init', createdAt: 200, completedAt: 99999 });
          f.put('completed', { createdAt: 30, completedAt: 300 });
          f.put('errored', {
            status: 'errored',
            error: 'fixture error',
            createdAt: 20,
            completedAt: 500,
          });
          f.put('interrupted', { status: 'interrupted', createdAt: 10, completedAt: 400 });
          expect(browserNames(browser)).toEqual([
            'initializing',
            'running',
            'errored',
            'interrupted',
            'completed',
          ]);
          const lines = browser.render(120);
          expect(lines).toContain(' Active (2)');
          expect(lines).toContain(' Done (3)');
          expect(lines.join('\n')).toContain('2 Active · 3 Done');
          expect(selectedRow(browser)).toMatch(/initializing\s+pending_init\s/);
          browser.handleInput('j');
          expect(selectedRow(browser)).toContain('running');
          browser.handleInput('j');
          expect(selectedRow(browser)).toContain('errored'); // The group heading is not selectable.
          const tool = await f.tools
            .get('list_agents')
            .execute('list', {}, undefined, undefined, f.ctx);
          expect(tool.details).toEqual({ agentCount: 0 });
          expect(tool.structuredContent).toEqual({ agents: [] });
          expect(JSON.parse(tool.content[0].text)).toEqual({ agents: [] });
          browser.handleInput('q');
        });
      });
    });

    test.each([undefined, NaN, 'invalid'])(
      'malformed Done creation time cannot disturb Active or detail order (%s)',
      async (createdAt) => {
        await withBrowser(async (f) => {
          await f.open(
            (browser: any) => {
              const scope = path.join(getRunsDir(), parentScopeKey(f.parentId));
              f.put('older', {
                id: 'a',
                status: 'running',
                createdAt: 100,
                infoFile: path.join(scope, 'a.info.json'),
              });
              f.put('missing', {
                id: 'b',
                createdAt: createdAt as any,
                infoFile: path.join(scope, 'b.info.json'),
              });
              f.put('newer', {
                id: 'c',
                status: 'pending_init',
                createdAt: 200,
                infoFile: path.join(scope, 'c.info.json'),
              });
              expect(browserNames(browser)).toEqual(['newer', 'older', 'missing']);
              browser.handleInput('\r');
            },
            (overlay: any, index: number) =>
              overlay.handleInput(['\x1b[C', '\x1b[C', '\x1b[C', 'q'][index]),
          );
          expect(f.opened.map((info: AgentInfo) => info.taskName)).toEqual([
            'newer',
            'older',
            'missing',
            'newer',
          ]);
        });
      },
    );

    test('sorts Done by finite end times with legacy fallbacks and deterministic ties', async () => {
      await withBrowser(async (f) => {
        await f.open((browser: any) => {
          const records = [
            f.put('latest', { createdAt: 1, completedAt: 900, updatedAt: 1 }),
            f.put('legacy', { createdAt: 2, completedAt: undefined, updatedAt: 800 }),
            f.put('invalid', { createdAt: 3, completedAt: '99999' as any, updatedAt: 700 }),
            f.put('created-only', { createdAt: 600, completedAt: Infinity, updatedAt: NaN }),
            f.put('tie-new', { createdAt: 50, completedAt: 500 }),
            f.put('tie-b', { id: 'tie-b', createdAt: 20, completedAt: 500 }),
            f.put('tie-a', { id: 'tie-a', createdAt: 20, completedAt: 500 }),
            f.put('zero', { createdAt: 10, completedAt: 0, updatedAt: 99999 }),
            f.put('missing', {
              createdAt: undefined,
              completedAt: undefined,
              updatedAt: undefined,
            }),
          ];
          const before = records.map((info) => fs.readFileSync(info.infoFile, 'utf8'));
          const expected = [
            'latest',
            'legacy',
            'invalid',
            'created-only',
            'tie-new',
            'tie-a',
            'tie-b',
            'zero',
            'missing',
          ];
          expect(browserNames(browser)).toEqual(expected);
          browser.handleInput('r');
          expect(browserNames(browser)).toEqual(expected);
          expect(records.map((info) => fs.readFileSync(info.infoFile, 'utf8'))).toEqual(before);
          browser.handleInput('q');
        });
      });
    });

    test.each(['empty', 'active', 'done'])(
      'hides empty Active but keeps the Done group (%s)',
      async (kind) => {
        await withBrowser(async (f) => {
          await f.open((browser: any) => {
            if (kind === 'active') f.put('only', { status: 'running' });
            if (kind === 'done') f.put('only', { status: 'errored', error: 'fixture error' });
            const lines = browser.render(120);
            const titleIndex = lines.findIndex((line: string) => line.includes('Subagents'));
            expect(lines[titleIndex + 1]).toBe(
              kind === 'active' ? ' Active (1)' : ' Done (' + Number(kind === 'done') + ')',
            );
            if (kind === 'active') expect(lines).toContain(' Active (1)');
            else expect(lines.some((line: string) => /^\s*Active \(/.test(line))).toBe(false);
            expect(lines).toContain(' Done (' + Number(kind === 'done') + ')');
            expect(lines.join('\n')).not.toContain('No active subagents.');
            if (kind !== 'done') expect(lines).toContain('  No done subagents.');
            if (kind === 'empty') {
              for (const key of ['j', 'k', '\r']) browser.handleInput(key);
              expect(f.selections).toEqual([]);
              expect(selectedRow(browser)).toBe('');
            } else expect(selectedRow(browser)).toContain('only');
            browser.handleInput('q');
          });
        });
      },
    );

    test.each(['dark', 'light'] as const)(
      'renders dim headings without bold, aligned and compact under the %s theme',
      async (appearance) => {
        await withBrowser(async (f) => {
          f.theme = f.ctx.ui.theme = nativeTheme(appearance);
          await f.open((browser: any) => {
            f.put('working', { status: 'running', lastTaskMessage: 'working preview' });
            f.put('finished');
            for (const width of [32, 38, 50, 80, 120]) {
              const rendered = browser.render(width);
              const lines = rendered.map(stripVTControlCharacters);
              const title = lines.find((line: string) => /^\s*Subagents\b/.test(line));
              const headings = lines.filter((line: string) => /^\s*(Active|Done) \(/.test(line));
              expect(title.indexOf('Subagents')).toBe(1);
              expect(headings).toHaveLength(2);
              const dimTitle = f.theme.fg('dim', ' Subagents (1 Active · 1 Done)');
              expect(rendered[lines.indexOf(title)]).toBe(truncateToWidth(dimTitle, width));
              for (const heading of headings)
                expect(rendered[lines.indexOf(heading)]).toBe(f.theme.fg('dim', heading));
              expect(headings.map((line: string) => line.search(/\S/))).toEqual([1, 1]);
              expect(lines[lines.indexOf(title) + 1]).toBe(' Active (1)');
              expect(lines[lines.indexOf(' Done (1)') - 1].trimEnd()).toBe('  working preview');
              expect(lines.at(-2)).toBe(''); // Keep separation from the keyboard hints.
            }
            browser.handleInput('q');
          });
        });
      },
    );

    test('uses one ten-agent window across groups without hiding either heading', async () => {
      await withBrowser(async (f) => {
        await f.open((browser: any) => {
          for (let index = 0; index < 12; index++)
            f.put('active/' + index, { status: 'running', createdAt: 100 - index });
          for (let index = 0; index < 12; index++)
            f.put('done/' + index, { completedAt: 100 - index });
          const check = () => {
            const lines = browser.render(120);
            expect(lines).toContain(' Active (12)');
            expect(lines).toContain(' Done (12)');
            expect(lines.join('\n')).not.toContain('No ');
            expect(browserNames(browser)).toHaveLength(10);
            return lines;
          };
          expect(check()).toContain('  ↓ 12 more'); // Done is below the initial window, not empty.
          for (let index = 0; index < 12; index++) {
            browser.handleInput('j');
            check();
          }
          expect(selectedRow(browser)).toContain('done/0');
          expect(browserNames(browser).some((name: string) => name.startsWith('active/'))).toBe(
            true,
          );
          for (let index = 0; index < 11; index++) {
            browser.handleInput('j');
            check();
          }
          expect(selectedRow(browser)).toContain('done/11');
          expect(check()).toContain('  ↑ 12 more');
          browser.handleInput('q');
        });
      });
    });

    test('refresh moves reused agents between groups and orders their latest finish', async () => {
      await withBrowser(async (f) => {
        await f.open((browser: any) => {
          f.put('worker', { status: 'running', createdAt: 100 });
          f.put('other', { createdAt: 200, completedAt: 500 });
          const initial = browser.render(120);
          f.put('worker', { status: 'completed', completedAt: 400 });
          expect(browser.render(120)).toBe(initial);
          browser.handleInput('r');
          expect(browserNames(browser)).toEqual(['other', 'worker']);
          expect(browser.render(120).join('\n')).not.toMatch(/^\s*Active \(/m);
          expect(browser.render(120)).toContain(' Done (2)');
          f.put('worker', { status: 'pending_init' }); // A stale prior completion does not make it Done.
          browser.handleInput('r');
          expect(browser.render(120)).toContain(' Active (1)');
          expect(browser.render(120)).toContain(' Done (1)');
          f.put('worker', { status: 'running', completedAt: undefined });
          browser.handleInput('r');
          expect(browserNames(browser)).toEqual(['worker', 'other']);
          f.put('worker', { status: 'interrupted', completedAt: 700 });
          browser.handleInput('r');
          expect(browserNames(browser)).toEqual(['worker', 'other']);
          browser.handleInput('q');
        });
      });
    });

    test('detail navigation shares group ordering and remains bound to its selected session', async () => {
      await withBrowser(async (f) => {
        await f.open(
          (browser: any) => {
            f.put('running', { status: 'running', createdAt: 100 });
            f.put('initializing', { status: 'pending_init', createdAt: 200 });
            f.put('late', { createdAt: 1, completedAt: 600 });
            f.put('early', { createdAt: 999, completedAt: 500 });
            f.put('late', { completedAt: 99999 }, f.otherId);
            expect(browserNames(browser)).toEqual(['initializing', 'running', 'late', 'early']);
            browser.handleInput('\r');
          },
          (overlay: any, index: number) => {
            f.ctx.sessionManager.getSessionId = () => f.otherId;
            // The selected agent can finish while its details remain open.
            if (index === 0) f.put('initializing', { status: 'completed', completedAt: 700 });
            overlay.handleInput(['\x1b[C', '\x1b[D', '\x1b[D', '\x1b[C', 'q'][index]);
          },
        );
        expect(f.opened.map((info: AgentInfo) => info.taskName)).toEqual([
          'initializing',
          'late',
          'initializing',
          'running',
          'initializing',
        ]);
        expect(f.opened.every((info: AgentInfo) => info.parentSessionId === f.parentId)).toBe(true);
      });
    });

    test.each(['dark', 'light'] as const)(
      'native %s browser uses configured name badges and independent two-line selection',
      async (appearance) => {
        await withBrowser(async (f) => {
          const now = Date.now() + 1000;
          const review = f.put('review', {
            color: 'red',
            agentType: 'reviewer',
            createdAt: now + 500,
            status: 'errored',
            error: 'fixture error',
            lastTaskMessage: 'review preview 中文😀 '.repeat(20),
          });
          f.put('tests', {
            color: '#dc2626',
            agentType: 'reviewer',
            createdAt: now + 400,
            lastTaskMessage: 'tests preview',
          });
          f.put('plain', { createdAt: now + 300, lastTaskMessage: 'plain preview' });
          f.put('invalid', {
            color: 'invalid',
            createdAt: now + 200,
            lastTaskMessage: 'invalid preview',
          });
          f.put('bad-record', {
            color: {} as any,
            createdAt: now + 100,
            lastTaskMessage: 'malformed preview',
          });
          for (const mode of ['truecolor', '256color'] as const) {
            const theme = nativeTheme(appearance, mode);
            f.theme = theme;
            f.ctx.ui.theme = theme;
            await f.open((browser: any) => {
              const selectedBg = backgroundAnsi(theme.colors.selectedBg, mode);
              const badgeBg = backgroundAnsi(parseColor('#DC2626'), mode);
              const checkRow = (
                name: string,
                color: string | undefined,
                selected: boolean,
                width = 120,
              ) => {
                const lines = browser.render(width);
                const index = lines.findIndex((line: string) =>
                  stripVTControlCharacters(line).includes(name),
                );
                if (resolveAgentColor(color)) expect(lines[index]).toContain(badgeBg);
                else if (!selected) expect(lines[index]).not.toMatch(/\x1b\[48;/);
                expect(lines[index]).not.toContain('\x1b[7m');
                expect(lines[index + 1]).not.toContain(badgeBg);
                for (const line of [lines[index], lines[index + 1]]) {
                  if (selected) {
                    expect(line).toStartWith(selectedBg);
                    expect(visibleWidth(line)).toBe(width);
                    expect(line).toEndWith('\x1b[49m');
                    // Badge resets and clipping must immediately restore selection.
                    for (const reset of line.matchAll(/\x1b\[(?:0|49)m/g)) {
                      const end = reset.index! + reset[0].length;
                      if (end < line.length) expect(line.slice(end)).toStartWith(selectedBg);
                    }
                  } else {
                    expect(line).not.toStartWith(selectedBg);
                  }
                }
                return lines;
              };
              const first = checkRow('review', 'red', true);
              expect(first.join('')).toContain(theme.fg('error', 'errored'.padEnd(12)));
              checkRow('tests', 'red', false);
              checkRow('plain', undefined, false);
              checkRow('invalid', undefined, false);
              checkRow('bad-record', undefined, false);
              const reads = f.list.mock.calls.length;
              expect(browser.render(120)).toBe(first);
              expect(f.list).toHaveBeenCalledTimes(reads);
              browser.handleInput('j');
              checkRow('review', 'red', false);
              checkRow('tests', 'red', true);
              browser.handleInput('j');
              checkRow('plain', undefined, true); // Selection also works without an identity color.
              for (const width of [0, 1, 2, 32, 38, 50, 80, 120])
                expect(
                  browser.render(width).every((line: string) => visibleWidth(line) <= width),
                ).toBe(true);
              browser.handleInput('k');
              checkRow('tests', 'red', true);
              // Theme invalidation changes selection/text, not explicit configured identity RGB.
              const replacement = nativeTheme(appearance === 'dark' ? 'light' : 'dark', mode);
              f.ctx.ui.theme = replacement;
              browser.invalidate();
              const chosen = browser
                .render(120)
                .find((line: string) => stripVTControlCharacters(line).startsWith('› '));
              expect(chosen).toStartWith(backgroundAnsi(replacement.colors.selectedBg, mode));
              expect(chosen).toContain(badgeBg);
              browser.handleInput('q');
            });
          }
          expect(JSON.parse(fs.readFileSync(review.infoFile, 'utf8')).status).toBe('errored');
        });
      },
    );

    test('template colors flow through real spawn metadata and snapshots to the widget and browser without template IO', async () => {
      await withBrowser(async (f) => {
        const directory = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents');
        const templates = [
          ['e2e-colored', 'color: cyan', '#0891B2'],
          ['e2e-invalid', 'color: not-a-color', undefined],
          ['e2e-plain', '', undefined],
        ] as const;
        fs.mkdirSync(directory, { recursive: true });
        for (const [name, field] of templates)
          fs.writeFileSync(
            path.join(directory, name + '.md'),
            '---\nname: ' + name + '\n' + field + '\n---\n',
          );
        const manager = new AgentManager();
        const theme = nativeTheme('dark', '256color');
        f.theme = f.ctx.ui.theme = theme;
        let component: any;
        const widget = new AgentSummaryWidget(
          () => manager.getWidgetSnapshot(f.parentId),
          (error) => {
            throw error;
          },
        );
        f.ctx.ui.setWidget = (_key: string, content: any) => {
          if (typeof content === 'function') component = content(f.tui, theme);
        };
        try {
          for (const [name, , color] of templates) {
            await manager.spawnAgent({
              task_name: name,
              message: 'hold end-to-end',
              agent_type: name,
              parentSessionId: f.parentId,
              cwd: TEST_AGENT_DIR,
              inheritedProvider: 'test',
              inheritedModelId: 'fake',
            });
            expect(manager.getAgentInfo(name, f.parentId).color).toBe(color);
          }
          // Rendering must not rediscover types; their definitions can be gone now.
          for (const [name] of templates) fs.rmSync(path.join(directory, name + '.md'));
          widget.attach(f.ctx);
          const reads = spyOn(fs, 'readFileSync'),
            scans = spyOn(fs, 'readdirSync');
          try {
            const summary = component.render(140);
            expect(summary[1]).toContain(renderAgentBadge('e2e-colored', theme, 'cyan'));
            expect(summary[3]).not.toMatch(/\x1b\[48;/);
            expect(summary[5]).not.toMatch(/\x1b\[48;/);
            widget.refresh();
            component.render(140);
            expect(reads).not.toHaveBeenCalled();
            expect(scans).not.toHaveBeenCalled();
            await f.open((browser: any) => {
              const lines = browser.render(120);
              expect(
                lines.find((line: string) =>
                  stripVTControlCharacters(line).includes('e2e-colored'),
                ),
              ).toContain(renderAgentBadge('e2e-colored', theme, 'cyan'));
              expect(lines.join('')).toContain('e2e-invalid');
              expect(lines.join('')).toContain('e2e-plain');
              browser.handleInput('q');
            });
            expect(
              reads.mock.calls.some(([file]) => String(file).startsWith(directory + path.sep)),
            ).toBe(false);
            expect(scans.mock.calls.some(([file]) => String(file) === directory)).toBe(false);
          } finally {
            reads.mockRestore();
            scans.mockRestore();
          }
        } finally {
          widget.dispose();
          await manager.shutdown();
          for (const [name] of templates)
            fs.rmSync(path.join(directory, name + '.md'), { force: true });
          fs.rmSync(path.join(getRunsDir(), parentScopeKey(f.parentId)), {
            recursive: true,
            force: true,
          });
        }
      });
    });

    test('sanitizes untrusted browser names and metadata before explicit badge styling', async () => {
      await withBrowser(async (f) => {
        f.put('unsafe', {
          taskName: '\x1b[31m工人😀\x1b[0m\nworker\x07',
          color: '#0077cc',
          modelId: '\x1b[31mmodel\x1b[0m\t中文',
          lastTaskMessage: '\x1b]8;;https://unsafe.invalid\x07public preview\x1b]8;;\x07\nmore\x9f',
        });
        f.theme = f.ctx.ui.theme = nativeTheme('light', '256color');
        await f.open((browser: any) => {
          for (const width of [0, 1, 2, 32, 80, 120]) {
            const lines = browser.render(width);
            for (const line of lines) {
              expect(visibleWidth(line)).toBeLessThanOrEqual(width);
              expect(stripVTControlCharacters(line)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
              expect(line).not.toContain('unsafe.invalid');
              expect(line).not.toContain('\x1b[31m');
            }
          }
          const text = browser.render(120).map(stripVTControlCharacters).join('\n');
          expect(text).toContain('工人😀 worker');
          expect(text).toContain('public preview more');
          browser.handleInput('q');
        });
      });
    });

    test('reads metadata once per data refresh, not on navigation, resize or theme redraw', async () => {
      await withBrowser(async (f) => {
        const own = Array.from({ length: 12 }, (_, index) => f.put('history/' + index));
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
          const renderSnapshot = (width: number, expected: AgentInfo[] = []) => {
            reads.length = 0;
            const lines = browser.render(width);
            expect([...reads].sort()).toEqual(expected.map((info) => info.infoFile).sort());
            return lines;
          };
          try {
            const first = renderSnapshot(120, own);
            const lists = f.list.mock.calls.length;
            reads.length = 0;
            expect(browser.render(120)).toBe(first);
            expect(reads).toEqual([]);
            for (const key of ['j', 'k', '\x1b[B', '\x1b[A']) {
              browser.handleInput(key);
              expect(reads).toEqual([]);
              renderSnapshot(120);
            }
            renderSnapshot(80);
            browser.invalidate();
            expect(reads).toEqual([]);
            const cached = renderSnapshot(80);
            browser.handleInput('\t');
            expect(browser.render(80)).toBe(cached);
            expect(reads).toEqual([]);
            expect(f.list).toHaveBeenCalledTimes(lists);
            browser.handleInput('r');
            expect(reads).toEqual([]);
            renderSnapshot(80, own);
            expect(f.list).toHaveBeenCalledTimes(lists + 1);
            reads.length = 0;
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

    test('navigation updates elapsed display without reloading statuses or order until r', async () => {
      await withBrowser(async (f) => {
        await f.open((browser: any) => {
          const now = Date.now();
          f.put('worker', {
            status: 'running',
            createdAt: 200,
            startedAt: now - 5000,
            lastTaskMessage: 'original preview',
          });
          f.put('done', { createdAt: 100, completedAt: 100 });
          const clock = spyOn(Date, 'now').mockReturnValue(now);
          try {
            expect(browser.render(120).find((line: string) => line.includes('worker'))).toMatch(
              /running\s+5s/,
            );
            const lists = f.list.mock.calls.length;
            f.put('worker', {
              status: 'completed',
              completedAt: now,
              lastTaskMessage: 'updated preview',
            });
            f.put('new', { status: 'running', createdAt: 300 });
            clock.mockReturnValue(now + 5000);
            browser.handleInput('j');
            expect(selectedRow(browser)).toContain('done');
            expect(browser.render(120).find((line: string) => line.includes('worker'))).toMatch(
              /running\s+10s/,
            );
            expect(browserNames(browser)).toEqual(['worker', 'done']);
            expect(browser.render(120).join('\n')).toContain('original preview');
            expect(f.list).toHaveBeenCalledTimes(lists);
            browser.handleInput('r');
            expect(browserNames(browser)).toEqual(['new', 'worker', 'done']);
            expect(browser.render(120).join('\n')).toContain('updated preview');
            expect(browser.render(120).find((line: string) => line.includes('worker'))).toMatch(
              /completed\s+5s/,
            );
            expect(f.list).toHaveBeenCalledTimes(lists + 1);
            browser.handleInput('q');
          } finally {
            clock.mockRestore();
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
            const review = lines.findIndex((line: string) => line.includes('review'));
            const plain = lines.findIndex((line: string) => line.includes('plain'));
            const empty = lines.findIndex((line: string) => line.includes('empty'));
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
          expect(selectedRow(browser)).toContain('history/11');
          expect(browser.render(120).join('\n')).toContain('↑ 2 more');
          browser.handleInput('\x1b[A');
          expect(selectedRow(browser)).toContain('history/10');
          browser.handleInput('k');
          expect(selectedRow(browser)).toContain('history/9');
          browser.handleInput('j');
          browser.render(120);
          browser.handleInput('j');
          browser.render(120);
          f.remove(history[11]);
          f.remove(history[10]);
          browser.handleInput('r');
          expect(selectedRow(browser)).toContain('history/9');
          for (const info of history) f.remove(info);
          browser.handleInput('r');
          expect(browser.render(80).join('\n')).toContain('No done subagents.');
          for (const key of ['j', 'k', '\x1b[A', '\x1b[B', '\r']) browser.handleInput(key);
          expect(f.selections).toEqual([]);
          f.put('returned');
          browser.handleInput('r');
          expect(selectedRow(browser)).toContain('returned');
          browser.handleInput('\r');
        });
        expect(f.opened.map((info: AgentInfo) => info.taskName)).toEqual(['returned']);
      });
    });

    test.each(['unrefreshed', 'r pending', 'Tab ignored', 'selection pending'])(
      'Enter uses the displayed item after insertion (%s)',
      async (refresh) => {
        await withBrowser(async (f) => {
          f.put('first', { createdAt: 200 });
          f.put('target', { createdAt: 100 });
          await f.open((browser: any) => {
            browser.render(120);
            browser.handleInput('j');
            expect(selectedRow(browser)).toContain('target');
            f.put('inserted', { createdAt: 300 });
            if (refresh === 'r pending') browser.handleInput('r');
            if (refresh === 'Tab ignored') browser.handleInput('\t');
            if (refresh === 'selection pending') browser.handleInput('k');
            const reads = f.list.mock.calls.length;
            browser.handleInput('\r');
            expect(f.list).toHaveBeenCalledTimes(reads);
          });
          expect(f.selections).toEqual([undefined]);
          expect(f.opened[0].taskName).toBe('target');
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
            expect(browser.render(80).join('\n')).not.toContain('gone');
            expect(selectedRow(browser, 80)).toContain('survivor');
            browser.handleInput('\r');
          } finally {
            read.mockRestore();
          }
        });
        expect(f.opened[0].taskName).toBe('survivor');
      });
    });

    test.each([undefined, null, 42, '', ' \t '])(
      'skips an invalid persisted task label (%s) without opening another agent',
      async (taskName) => {
        await withBrowser(async (f) => {
          f.put('invalid', { createdAt: 200, taskName });
          f.put('survivor', { createdAt: 100 });
          await f.open((browser: any) => {
            expect(browser.render(80).join('\n')).toContain('survivor');
            browser.handleInput('\r');
            expect(f.selections).toEqual([]);
            expect(f.opened).toEqual([]);
            browser.handleInput('j');
            expect(selectedRow(browser, 80)).toContain('survivor');
            browser.handleInput('\r');
          });
          expect(f.opened.map((info: AgentInfo) => info.taskName)).toEqual(['survivor']);
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
        expect(f.selections).toEqual([undefined]);
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
        const list = AgentManager.prototype.listAgentInfos;
        let navigating = false;
        AgentManager.prototype.listAgentInfos = function (...args) {
          const entries = list.apply(this, args);
          if (navigating) f.remove(direction === 'next' ? next : previous);
          return entries;
        };
        await f.open(
          (browser: any) => {
            browser.render(120);
            browser.handleInput('j');
            expect(selectedRow(browser)).toContain('middle');
            browser.handleInput('\r');
          },
          (overlay: any) => {
            navigating = true;
            overlay.handleInput(key);
          },
        );
        expect(f.opened.map((info: AgentInfo) => info.taskName)).toEqual(['middle']);
        expect(f.notify).toHaveBeenCalledWith(expect.stringContaining('Agent not found'), 'error');
      });
    });

    test('browser and detail navigation stay session-scoped and read-only', async () => {
      await withBrowser(async (f) => {
        const own = f.put('same', { modelId: 'own-model', createdAt: 200 });
        const second = f.put('second', {
          status: 'errored',
          error: 'fixture error',
          createdAt: 100,
        });
        const other = f.put('same', { modelId: 'other-model' }, f.otherId);
        const records = [own, second, other];
        const before = records.map((info) => fs.readFileSync(info.infoFile, 'utf8'));
        const controlNames = ['spawnAgent', 'sendMessage', 'interruptAgent'] as const;
        const originals = controlNames.map((name) => (AgentManager.prototype as any)[name]);
        const controls = controlNames.map((name) => {
          const control = mock(() => {
            throw new Error('Browser must not call ' + name);
          });
          (AgentManager.prototype as any)[name] = control;
          return control;
        });
        try {
          await f.open(
            (browser: any) => {
              const first = browser.render(120);
              expect(first.join('\n')).toContain('own-model');
              expect(first.join('\n')).not.toContain('other-model');
              expect(first.join('\n')).not.toMatch(/all sessions|tab:/i);
              browser.handleInput('j');
              expect(selectedRow(browser)).toContain('second');
              const frame = browser.render(120);
              const reads = f.list.mock.calls.length;
              const renders = f.requestRender.mock.calls.length;
              browser.handleInput('\t');
              expect(browser.render(120)).toBe(frame);
              expect(f.list).toHaveBeenCalledTimes(reads);
              expect(f.requestRender).toHaveBeenCalledTimes(renders);
              expect(selectedRow(browser)).toContain('second');
              browser.handleInput('\r');
            },
            (overlay: any, index: number) => overlay.handleInput(['\x1b[C', '\x1b[D', 'q'][index]),
          );
          expect(f.selections).toEqual([undefined]);
          expect(f.opened.map((info: AgentInfo) => info.taskName)).toEqual([
            'second',
            'same',
            'second',
          ]);
          expect(f.opened.every((info: AgentInfo) => info.parentSessionId === f.parentId)).toBe(
            true,
          );
          for (const call of f.list.mock.calls) expect(call).toEqual([undefined, f.parentId]);
          for (const control of controls) expect(control).not.toHaveBeenCalled();
          expect(records.map((info) => fs.readFileSync(info.infoFile, 'utf8'))).toEqual(before);
        } finally {
          controlNames.forEach((name, index) => {
            (AgentManager.prototype as any)[name] = originals[index];
          });
        }
      });
    });

    test('aligns disk-history columns while the public tool omits unloaded agents', async () => {
      await withBrowser(async (f) => {
        await f.open((browser: any) => {
          // Seed after manager.ready(): startup recovery must not interrupt this display fixture.
          const createdAt = Date.now();
          for (let index = 0; index < 12; index++) {
            f.put('history/' + index, {
              status: index === 0 ? 'pending_init' : 'completed',
              lastTaskMessage: 'private task context ' + index,
              modelId: index === 0 ? 'MiniMax-M3' : 'a-model-name-that-is-longer-than-the-column',
              thinking: index === 0 ? 'high' : 'medium',
              createdAt: createdAt - index,
            });
          }
          const lines = browser.render(120);
          expect(browserNames(browser)).toHaveLength(10);
          expect(lines).toContain(' Active (1)');
          expect(lines).toContain(' Done (11)');
          const firstIndex = lines.findIndex((line: string) => line.includes('history/0'));
          const first = lines[firstIndex];
          const second = lines.find((line: string) => line.includes('history/1 '));
          expect(first).toMatch(/history\/0\s+pending_init\s+\S+\s+MiniMax-M3\s+high/);
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
          const narrow = browser.render(50).find((line: string) => line.includes('history/0'));
          expect(narrow).toContain('high');
          expect(narrow).not.toContain('MiniMax-M3');
          const all = browser.render(80).find((line: string) => line.includes('history/0'));
          expect(all).toContain('MiniMax-M3');
          expect(all).toContain('high');
          expect(all).not.toContain(f.parentId.slice(-8));
          browser.handleInput('q');
        });
        const listed = await f.tools
          .get('list_agents')
          .execute('list', {}, undefined, undefined, f.ctx);
        expect(JSON.parse(listed.content[0].text)).toEqual({ agents: [] });
        expect(listed.details).toEqual({ agentCount: 0 });
        expect(listed.structuredContent).toEqual({ agents: [] });
      });
    });

    test('clips wide ANSI previews at 32/38/50/80/120 columns and invalidates theme caches', async () => {
      await withBrowser(async (f) => {
        // Inject wide labels directly because task creation accepts ASCII names.
        f.put('wide', {
          taskName: '中文很长的名称'.repeat(6),
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
          f.theme = nativeTheme('dark');
          f.ctx.ui.theme = f.theme;
          const { terminal, writes, input, resize } = terminalFixture(120, 35);
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

    test.each(['regular', 'fullscreen'] as const)(
      'real Pi custom UI retains the browser and restores focus after details (%s)',
      async (mode) => {
        await withBrowser(async (f) => {
          const { InteractiveMode } = await import(
            new URL('./modes/interactive/interactive-mode.js', sdkUrl).href
          );
          codingAgent.initTheme('dark', false);
          for (let index = 0; index < 12; index++)
            f.put('history/' + index, { createdAt: 100 - index });
          const { terminal, writes, input } = terminalFixture(120, 40);
          const tui = mode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
          let browser: any;
          let mounted = false;
          let mounts = 0;
          let settled = false;
          const host: any = {
            editor: { getText: () => '', setText() {} },
            ui: tui,
            extensionOverlays: new Map(),
            pushExtensionDialog(component: any) {
              browser = component;
              mounted = true;
              mounts++;
              tui.addChild(component);
              tui.setFocus(component);
            },
            removeExtensionDialog(component: any) {
              mounted = false;
              tui.removeChild(component);
              tui.setFocus(null);
            },
          };
          f.ctx.ui.custom = (factory: any, options: any) =>
            InteractiveMode.prototype.showExtensionCustom.call(host, factory, options);
          tui.start();
          const command = f.command();
          command.then(() => {
            settled = true;
          });
          const tick = () => new Promise((resolve) => setImmediate(resolve));
          try {
            await tick();
            for (let index = 0; index < 7; index++) {
              browser.render(120);
              input('j');
            }
            const selected = selectedRow(browser);
            expect(selected).toContain('history/7');
            for (const closeKey of ['\x1b', 'q']) {
              input('\r');
              input('\r');
              await tick();
              expect(mounted).toBe(true);
              expect(mounts).toBe(1);
              expect(settled).toBe(false);
              expect(tui.getFocusedComponent()).toBeInstanceOf(SubagentPeekOverlay);
              expect(host.extensionOverlays.size).toBe(1);
              writes.length = 0;
              tui.renderNow(true);
              expect(stripVTControlCharacters(writes.join(''))).toContain('Subagents');
              input(closeKey);
              await tick();
              expect(host.extensionOverlays.size).toBe(0);
              expect(tui.getFocusedComponent()).toBe(browser);
              expect(mounted).toBe(true);
              expect(settled).toBe(false);
              expect(selectedRow(browser)).toBe(selected);
            }
            input('j');
            expect(selectedRow(browser)).toContain('history/8');
            input('q');
            await command;
            expect(mounted).toBe(false);
            expect(settled).toBe(true);
          } finally {
            const focused = tui.getFocusedComponent();
            if (focused instanceof SubagentPeekOverlay) focused.handleInput('q');
            await tick();
            browser?.handleInput('q');
            await command;
            tui.stop();
          }
        });
      },
    );

    test('details do not finish the browser and selection survives a changed sort order', async () => {
      await withBrowser(async (f) => {
        f.put('first', { createdAt: 200 });
        f.put('target', { createdAt: 100 });
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        await f.open(
          async (browser: any) => {
            browser.render(120);
            browser.handleInput('j');
            const frame = browser.render(120);
            browser.handleInput('\r');
            browser.handleInput('\r');
            browser.handleInput('q'); // The background list cannot close while details own input.
            expect(f.selections).toEqual([]);
            expect(f.opened).toHaveLength(1);
            expect(browser.render(120)).toBe(frame);
            release();
            await f.flushDetails();
            expect(selectedRow(browser)).toContain('target');
            expect(f.selections).toEqual([]);
            browser.handleInput('\r');
            await f.flushDetails();
            expect(f.opened).toHaveLength(2);
            browser.handleInput('q');
          },
          async (overlay: any, index: number) => {
            if (index === 0) {
              f.put('inserted', { createdAt: 300 });
              await hold;
            }
            overlay.handleInput('q');
          },
        );
        expect(f.selections).toEqual([undefined]);
      });
    });

    test.each(['render', 'navigate', 'refresh'])(
      'detail return uses a coherent snapshot when agents arrive before its first frame (%s)',
      async (action) => {
        await withBrowser(async (f) => {
          f.put('target', { createdAt: 200 });
          f.put('other', { createdAt: 100 });
          await f.open(
            async (browser: any) => {
              expect(selectedRow(browser)).toContain('target');
              const reads = f.list.mock.calls.length;
              f.requestRender.mockImplementationOnce(() => {
                // The return selection has been restored, but its frame has not rendered yet.
                f.put('inserted', { createdAt: 300 });
              });
              browser.handleInput('\r');
              await f.flushDetails();
              expect(f.list).toHaveBeenCalledTimes(reads + 1);
              if (action === 'navigate') browser.handleInput('j');
              if (action === 'refresh') browser.handleInput('r');
              const expected =
                action === 'navigate' ? 'other' : action === 'refresh' ? 'inserted' : 'target';
              expect(selectedRow(browser)).toContain(expected);
              if (action === 'refresh') {
                expect(f.list).toHaveBeenCalledTimes(reads + 2);
                expect(browserNames(browser)).toContain('inserted');
              } else {
                expect(f.list).toHaveBeenCalledTimes(reads + 1);
                expect(browserNames(browser)).not.toContain('inserted');
                browser.handleInput('k');
                browser.render(80);
                browser.invalidate();
                browser.render(80);
                expect(f.list).toHaveBeenCalledTimes(reads + 1);
                expect(browserNames(browser)).not.toContain('inserted');
              }
              browser.handleInput('q');
            },
            (overlay: any) => overlay.handleInput('q'),
          );
        });
      },
    );

    test('last Active finishing in details returns to its position in a long Done group', async () => {
      await withBrowser(async (f) => {
        await f.open(
          async (browser: any) => {
            f.put('target', { status: 'running', createdAt: 1 });
            for (let index = 0; index < 15; index++)
              f.put('done/' + index, { completedAt: 100 - index });
            expect(selectedRow(browser)).toContain('target');
            browser.handleInput('\r');
            await f.flushDetails();
            expect(selectedRow(browser)).toContain('target');
            const lines = browser.render(120);
            expect(lines.join('\n')).not.toMatch(/^\s*Active \(/m);
            expect(lines).toContain(' Done (16)');
            expect(browserNames(browser)).toHaveLength(10);
            const hidden = lines.reduce(
              (count: number, line: string) =>
                count + Number(line.match(/[↑↓] (\d+) more/)?.[1] ?? 0),
              0,
            );
            expect(hidden + browserNames(browser).length).toBe(16);
            browser.handleInput('q');
          },
          (overlay: any) => {
            f.put('target', { status: 'completed', completedAt: 1 });
            overlay.handleInput('q');
          },
        );
      });
    });

    test('failed detail creation leaves the browser usable for another attempt', async () => {
      await withBrowser(async (f) => {
        f.put('worker');
        await f.open(async (browser: any) => {
          browser.render(120);
          const custom = f.ctx.ui.custom;
          f.ctx.ui.custom = (create: any, options: any) =>
            options?.overlay
              ? Promise.reject(new Error('detail creation failed'))
              : custom(create, options);
          browser.handleInput('\r');
          await f.flushDetails();
          expect(f.selections).toEqual([]);
          expect(f.notify).toHaveBeenCalledWith(
            expect.stringContaining('detail creation failed'),
            'error',
          );
          expect(selectedRow(browser)).toContain('worker');
          f.ctx.ui.custom = custom;
          browser.handleInput('\r');
          await f.flushDetails();
          expect(f.opened).toHaveLength(1);
          browser.handleInput('q');
        });
      });
    });

    test('closing details restores navigation before the return frame is rendered', async () => {
      await withBrowser(async (f) => {
        f.put('first', { createdAt: 300 });
        f.put('middle', { createdAt: 200 });
        f.put('last', { createdAt: 100 });
        await f.open(async (browser: any) => {
          browser.render(120);
          browser.handleInput('j');
          expect(selectedRow(browser)).toContain('middle');
          browser.handleInput('\r');
          await f.flushDetails();
          browser.handleInput('j'); // No render between closing details and the next key.
          expect(selectedRow(browser)).toContain('last');
          browser.handleInput('\r');
          await f.flushDetails();
          browser.handleInput('k');
          expect(selectedRow(browser)).toContain('middle');
          browser.handleInput('q');
        });
      });
    });

    test.each(['pending selection', 'inserted item'])(
      'return navigation is independent of render timing (%s)',
      async (change) => {
        await withBrowser(async (f) => {
          f.put('a', { createdAt: 300 });
          f.put('b', { createdAt: 200 });
          f.put('c', { createdAt: 100 });
          await f.open(
            async (browser: any) => {
              browser.render(120);
              if (change === 'pending selection') browser.handleInput('j');
              browser.handleInput('\r'); // Open the actual displayed a, not an unrendered index.
              await f.flushDetails();
              expect(f.opened[0].taskName).toBe('a');
              browser.handleInput('j'); // No return-frame render before navigation.
              expect(selectedRow(browser)).toContain('b');
              browser.handleInput('q');
            },
            (overlay: any) => {
              if (change === 'inserted item') f.put('inserted', { createdAt: 400 });
              overlay.handleInput('q');
            },
          );
        });
      },
    );

    test('detail navigation cannot reopen an overlay after its browser was disposed', async () => {
      await withBrowser(async (f) => {
        f.put('first', { createdAt: 200 });
        f.put('second', { createdAt: 100 });
        let browser: any;
        await f.open(
          (component: any) => {
            browser = component;
            browser.render(120);
            browser.handleInput('\r');
          },
          (overlay: any, index: number) => {
            if (index === 0) {
              overlay.handleInput('\x1b[C');
              browser.dispose(); // Simulate UI reset before the resolved navigation resumes.
            } else overlay.handleInput('q');
          },
        );
        expect(f.opened.map((info: AgentInfo) => info.taskName)).toEqual(['first']);
      });
    });

    test.each(['browser disposed', 'mount failed'])(
      'real Pi overlay setup releases polling resources (%s)',
      async (failure) => {
        await withBrowser(async (f) => {
          const { InteractiveMode } = await import(
            new URL('./modes/interactive/interactive-mode.js', sdkUrl).href
          );
          codingAgent.initTheme('dark', false);
          f.put('worker');
          let browser: any;
          let detail: any;
          let closeBrowser: (() => void) | undefined;
          let hides = 0;
          const host: any = {
            editor: { getText: () => '', setText() {} },
            ui: {
              ...f.tui,
              showOverlay() {
                if (failure === 'mount failed') throw new Error('overlay mounting failed');
                return {
                  hide() {
                    hides++;
                  },
                };
              },
            },
            extensionOverlays: new Map(),
            pushExtensionDialog(component: any) {
              browser = component;
            },
            removeExtensionDialog() {},
          };
          f.ctx.ui.custom = (factory: any, options: any) =>
            InteractiveMode.prototype.showExtensionCustom.call(
              host,
              (tui: any, theme: any, keys: any, done: any) => {
                if (!options?.overlay) closeBrowser = done;
                const component = factory(tui, theme, keys, done);
                if (options?.overlay) detail = component;
                return component;
              },
              options,
            );
          const command = f.command();
          try {
            await new Promise((resolve) => setImmediate(resolve));
            browser.render(120);
            browser.handleInput('\r');
            if (failure === 'browser disposed') browser.dispose(); // Before Pi installs the overlay.
            await new Promise((resolve) => setImmediate(resolve));
            expect(host.extensionOverlays.size).toBe(0);
            expect(detail['disposed']).toBe(true);
            expect(detail['pollInterval']).toBeNull();
            if (failure === 'mount failed') {
              expect(f.notify).toHaveBeenCalledWith(
                expect.stringContaining('overlay mounting failed'),
                'error',
              );
              expect(selectedRow(browser)).toContain('worker');
            } else expect(hides).toBe(1);
          } finally {
            detail?.dispose();
            closeBrowser?.();
            await command;
          }
        });
      },
    );

    test('a failed return-frame render request is reported without an unhandled promise', async () => {
      await withBrowser(async (f) => {
        f.put('worker');
        await f.open(async (browser: any) => {
          browser.render(120);
          f.requestRender.mockImplementationOnce(() => {
            throw new Error('return-frame request failed');
          });
          browser.handleInput('\r');
          await f.flushDetails();
          expect(f.notify).toHaveBeenCalledWith(
            expect.stringContaining('return-frame request failed'),
            'error',
          );
          expect(selectedRow(browser)).toContain('worker');
          browser.handleInput('\r');
          await f.flushDetails();
          expect(f.opened).toHaveLength(2);
          browser.handleInput('q');
        });
      });
    });

    test('late detail closure cannot render a disposed browser', async () => {
      await withBrowser(async (f) => {
        f.put('worker');
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        await f.open(
          async (browser: any) => {
            browser.render(120);
            browser.handleInput('\r');
            browser.dispose();
            const renders = f.requestRender.mock.calls.length;
            release();
            await f.flushDetails();
            expect(f.requestRender).toHaveBeenCalledTimes(renders);
          },
          async (overlay: any) => {
            await hold;
            overlay.handleInput('q');
          },
        );
      });
    });

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

test('public tools carry native usage through metadata and the detail footer without side effects from listing', async () => {
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
    isIdle: () => true,
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
      getActiveTools() {
        throw new Error('Parent tools must not be read');
      },
      getSettings: () => ({ terminal: { showImages: false }, outputPad: 0 }),
    } as any);
    await handlers.get('session_start')({}, ctx);
    expect([...tools.keys()]).toEqual(toolNames);
    expect(
      (await execute('spawn_agent', { task_name: 'worker', message: 'sample ten' })).content[0]
        .text,
    ).toBe('Spawned worker.');
    await done(10);
    const beforeList = sent.length;
    const listed = await execute('list_agents', {});
    const resident = {
      agents: [{ agent_name: 'worker', agent_status: { completed: 'response:sample ten' } }],
    };
    expect(JSON.parse(listed.content[0].text)).toEqual(resident);
    expect(listed.details).toEqual({ agentCount: 1 });
    expect(listed.structuredContent).toEqual(resident);
    expect(JSON.stringify(listed)).not.toContain('contextUsage');
    expect(await execute('list_agents', {})).toEqual(listed);
    expect(sent).toHaveLength(beforeList);
    const wait = await execute('wait_agent', {});
    expect(JSON.parse(wait.content[0].text)).toEqual({
      message: 'Wait completed.',
      timed_out: false,
    });
    expect(sent).toHaveLength(beforeList);
    let detailOpened = 0;
    let detailClosed = Promise.resolve();
    let detailError: unknown;
    ctx.ui.custom = async (create: any) => {
      let component: any;
      let result: any;
      let close!: () => void;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
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
        close();
      });
      try {
        if (component instanceof SubagentPeekOverlay) {
          detailClosed = closed;
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
          await detailClosed;
          await new Promise((resolve) => setImmediate(resolve));
          if (detailError) throw detailError;
          component.handleInput('q');
        }
        return result;
      } catch (error) {
        detailError = error;
        throw error;
      } finally {
        close();
        component.dispose?.();
      }
    };
    await commands.get('subagents').handler('', ctx);
    expect(detailOpened).toBe(1);
    const resumed = JSON.parse((await execute('wait_agent', {})).content[0].text);
    expect(resumed).toEqual({ message: 'Wait completed.', timed_out: false });
    expect(sent.at(-1).details).toEqual({ agent_name: 'worker', status: 'completed' });
    expect(sent.at(-1).content).toContain('response:sample fourteen');
    const saved = getAgent('worker', parent)!;
    expect(saved.contextUsage).toMatchObject({ tokens: 70000, contextWindow: 500000 });
    expect(saved.contextUsage!.percent!).toBeCloseTo(14);
    const beforeHistory = fs.readFileSync(saved.sessionFile, 'utf8');
    ctx.ui.custom = async (create: any) => {
      let component: any;
      let result: any;
      let close!: () => void;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      component = create(
        { terminal: { rows: 35 }, requestRender() {} },
        theme,
        {},
        (value: any) => {
          result = value;
          component.dispose?.();
          close();
        },
      );
      try {
        if (component instanceof SubagentPeekOverlay) {
          detailClosed = closed;
          expect(component.render(80).at(-2)).toContain('│ 14%/500k │ ←/→ agent');
          component.handleInput('q');
        } else {
          component.render(80);
          component.handleInput('\r');
          await detailClosed;
          await new Promise((resolve) => setImmediate(resolve));
          if (detailError) throw detailError;
          component.handleInput('q');
        }
        return result;
      } catch (error) {
        detailError = error;
        throw error;
      } finally {
        close();
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
