import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AgentSession, PromptOptions } from '@earendil-works/pi-coding-agent';
import type { ChildSessionOptions } from '../src/runtime.ts';
import type { OfflineFixtureConfig } from './fixtures/sdk-offline-extension.ts';

const testFile = fileURLToPath(import.meta.url);
// Run SDK contracts in a separate process to isolate environment changes and shared-method spies.
if (process.env.PI_SUBAGENT_SDK_CONTRACT_CHILD !== '1') {
  test('real Pi SDK 1.5 offline contracts (isolated from core module mocks)', () => {
    const args = process.versions.bun
      ? ['test', testFile, '--timeout', '60000']
      : ['--test', testFile];
    const env: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT_SDK_CONTRACT_CHILD: '1' };
    // Clear Node's inherited test marker so the nested suite executes.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, args, {
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    assert.ifError(result.error);
    assert.equal(result.status, 0, output);
    assert.match(
      output,
      /native skill discovery with explicit SYSTEM\/extensions/,
      'child must execute the real suite, not silently skip it',
    );
    console.log(output.trim());
  });
} else {
  test('contracts run against the pinned development Pi SDK', () => {
    const manifest = new URL(
      '../package.json',
      import.meta.resolve('@earendil-works/pi-coding-agent'),
    );
    assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).version, '1.5.0');
  });
  const originalFetch = globalThis.fetch;
  const fetchAttempts: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    fetchAttempts.push(String(input));
    throw new Error('Network is forbidden in offline SDK contracts: ' + String(input));
  }) as typeof fetch;
  after(() => {
    globalThis.fetch = originalFetch;
    assert.deepEqual(fetchAttempts, [], 'SDK contracts must not even attempt a fetch');
  });

  const { createChildSession, promptChildSession, shutdownChildSession } =
    await import('../src/runtime.ts');
  const { CONFIG_DIR_NAME, getAgentDir, ProjectTrustStore, SessionManager } =
    await import('@earendil-works/pi-coding-agent');
  const fixtureSource = fileURLToPath(
    new URL('./fixtures/sdk-offline-extension.ts', import.meta.url),
  );
  type EventRecord = { type: string; [key: string]: any };
  type Disposition = Parameters<NonNullable<PromptOptions['preflightResult']>>[0];
  const baseSettings = {
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: 'off',
    enableAnalytics: false,
    enableInstallTelemetry: false,
    defaultProjectTrust: 'ask',
    defaultProvider: 'parent-default',
    defaultModel: 'must-not-change',
    defaultThinkingLevel: 'low',
  };
  function write(file: string, contents: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  function json(file: string, value: unknown): void {
    write(file, JSON.stringify(value));
  }
  function deferred<T = void>() {
    return Promise.withResolvers<T>();
  }
  interface Fixture {
    root: string;
    agentDir: string;
    cwd: string;
    extensionDir: string;
    extensionPath: string;
    systemPromptPath: string;
    info: ChildSessionOptions['info'];
    errors: unknown[];
    logs: string[];
    sessions: Set<AgentSession>;
    create(overrides?: Partial<ChildSessionOptions>): Promise<AgentSession>;
    close(session: AgentSession, timeoutMs?: number): Promise<void>;
    configure(config: OfflineFixtureConfig): void;
    events(): EventRecord[];
    waitFor(type: string, predicate?: (event: EventRecord) => boolean): Promise<EventRecord>;
    release(name: string): void;
  }
  async function withFixture(
    config: OfflineFixtureConfig,
    run: (fixture: Fixture) => Promise<void>,
  ): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sdk-contract-'));
    const agentDir = path.join(root, 'user');
    const cwd = path.join(root, 'work', 'project');
    const extensionDir = path.join(root, 'explicit-extension');
    const extensionPath = path.join(extensionDir, 'index.ts');
    const systemPromptPath = path.join(root, 'child-SYSTEM.md');
    const configPath = path.join(extensionDir, 'sdk-fixture.json');
    const eventsPath = path.join(extensionDir, 'sdk-events.jsonl');
    const previousEnvironment = Object.fromEntries(
      ['PI_CODING_AGENT_DIR', 'HOME'].map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, {
      PI_CODING_AGENT_DIR: agentDir,
      HOME: path.join(root, 'home'),
    });
    const sessions = new Set<AgentSession>();
    const pending: Promise<AgentSession>[] = [];
    const errors: unknown[] = [];
    const logs: string[] = [];
    const info = {
      cwd,
      sessionFile: path.join(root, 'subagents', 'child.jsonl'),
      provider: config.provider ?? 'sdk-offline',
      modelId: config.modelId ?? 'exact/model',
      extensionPaths: [extensionPath],
    };
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.dirname(info.sessionFile), { recursive: true });
    write(extensionPath, fs.readFileSync(fixtureSource, 'utf8'));
    json(configPath, config);
    json(path.join(agentDir, 'settings.json'), baseSettings);
    json(path.join(agentDir, 'auth.json'), {});
    json(path.join(agentDir, 'models.json'), { providers: {} });
    write(systemPromptPath, 'CHILD_EXPLICIT_SYSTEM');
    const f: Fixture = {
      root,
      agentDir,
      cwd,
      extensionDir,
      extensionPath,
      systemPromptPath,
      info,
      errors,
      logs,
      sessions,
      create(overrides = {}) {
        assert.equal(getAgentDir(), agentDir, 'must use the unmocked SDK and isolated agentDir');
        const promise = createChildSession({
          info,
          systemPromptPath,
          checkCanceled() {},
          onError: (error) => {
            errors.push(error);
          },
          onShutdown() {},
          log: (message) => {
            logs.push(message);
          },
          ...overrides,
          onCreated(session) {
            sessions.add(session);
            overrides.onCreated?.(session);
          },
        });
        pending.push(promise);
        void promise.catch(() => {});
        return promise;
      },
      async close(session, timeoutMs) {
        try {
          await shutdownChildSession(session, timeoutMs);
        } finally {
          sessions.delete(session);
        }
      },
      configure(config) {
        json(configPath, config);
      },
      events() {
        return fs.existsSync(eventsPath)
          ? fs
              .readFileSync(eventsPath, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((s) => JSON.parse(s))
          : [];
      },
      async waitFor(type, predicate = () => true) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const event = f.events().find((event) => event.type === type && predicate(event));
          if (event) return event;
          await delay(5);
        }
        throw new Error('Fixture event not observed: ' + type + ' ' + JSON.stringify(f.events()));
      },
      release(name) {
        write(path.join(extensionDir, 'release-' + name), 'release');
      },
    };
    try {
      await run(f);
    } finally {
      for (const name of ['factory', 'startup', 'response', 'input', 'settled', 'compaction-failed', 'shutdown']) f.release(name);
      await Promise.allSettled(pending);
      await Promise.allSettled(
        [...sessions].map(async (session) => {
          try {
            await session.abort();
            await session.waitForIdle();
          } finally {
            await f.close(session, 1_000);
          }
        }),
      );
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  function assistants(session: AgentSession) {
    return session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant');
  }
  async function prompt(session: AgentSession, message: string): Promise<Disposition[]> {
    const accepted: Disposition[] = [];
    await promptChildSession(session, message, (disposition) => {
      accepted.push(disposition);
    });
    await session.waitForIdle();
    return accepted;
  }

  test('native skill discovery with explicit SYSTEM/extensions; other automatic resources stay disabled', async () =>
    withFixture({}, async (f) => {
      const marker = 'FORBIDDEN_DEFAULT_RESOURCE';
      for (const dir of [
        f.agentDir,
        path.dirname(f.cwd),
        f.cwd,
        path.join(f.cwd, CONFIG_DIR_NAME),
      ]) {
        for (const name of [
          'SYSTEM.md',
          'APPEND_SYSTEM.md',
          'AGENTS.md',
          'AGENTS.override.md',
          'CLAUDE.md',
        ])
          write(path.join(dir, name), marker);
      }
      for (const dir of [f.agentDir, path.join(f.cwd, CONFIG_DIR_NAME)]) {
        write(path.join(dir, 'prompts', 'default-template.md'), marker);
        write(path.join(dir, 'themes', 'default.json'), '{ invalid theme');
        write(
          path.join(dir, 'extensions', 'default.ts'),
          'export default () => { throw new Error("default extension must not load"); };',
        );
      }
      const projectSkill = path.join(f.cwd, CONFIG_DIR_NAME, 'skills', 'project-skill', 'SKILL.md');
      for (const [file, name, extra] of [
        [path.join(f.agentDir, 'skills', 'user-skill', 'SKILL.md'), 'user-skill', ''],
        [projectSkill, 'project-skill', ''],
        [
          path.join(path.dirname(f.cwd), '.agents', 'skills', 'ancestor-skill', 'SKILL.md'),
          'ancestor-skill',
          '',
        ],
        [
          path.join(f.agentDir, 'skills', 'hidden-skill', 'SKILL.md'),
          'hidden-skill',
          'disable-model-invocation: true\n',
        ],
      ]) {
        write(
          file,
          '---\nname: ' +
            name +
            '\ndescription: AUTO_DESCRIPTION_' +
            name +
            '\n' +
            extra +
            '---\nAUTO_SKILL_BODY_' +
            name,
        );
      }
      write(
        path.join(f.root, 'parent-only-skill', 'SKILL.md'),
        '---\nname: parent-only-skill\ndescription: FORBIDDEN_PARENT_SKILL\n---\nNot a discovered resource.',
      );
      const session = await f.create({ projectTrusted: true });
      assert.deepEqual(session.messages, []);
      assert.match(session.systemPrompt, /CHILD_EXPLICIT_SYSTEM/);
      for (const name of ['user-skill', 'project-skill', 'ancestor-skill'])
        assert.ok(session.systemPrompt.includes('AUTO_DESCRIPTION_' + name));
      assert.ok(session.systemPrompt.includes(projectSkill));
      assert.doesNotMatch(
        session.systemPrompt,
        /FORBIDDEN_|AUTO_SKILL_BODY_|AUTO_DESCRIPTION_hidden-skill/,
      );
      assert.deepEqual(session.resourceLoader.getAgentsFiles().agentsFiles, []);
      assert.deepEqual(session.resourceLoader.getAppendSystemPrompt(), []);
      assert.deepEqual(session.resourceLoader.getPrompts().prompts, []);
      assert.deepEqual(session.resourceLoader.getThemes().themes, []);
      const skills = session.resourceLoader.getSkills().skills;
      assert.deepEqual(skills.map((skill) => skill.name).sort(), [
        'ancestor-skill',
        'hidden-skill',
        'project-skill',
        'user-skill',
      ]);
      assert.equal(
        skills.find((skill) => skill.name === 'hidden-skill')?.disableModelInvocation,
        true,
      );
      const reader = session.agent.state.tools.find((tool) => tool.name === 'read');
      assert.ok(reader, 'native read tool must remain available');
      const result = await reader.execute(
        'skill-read',
        { path: projectSkill },
        new AbortController().signal,
      );
      assert.match(JSON.stringify(result.content), /AUTO_SKILL_BODY_project-skill/);
      await prompt(session, 'Template body still belongs in the first user message');
      const request = f.events().find((event) => event.type === 'request')!;
      assert.deepEqual(request.userTexts, [
        'Template body still belongs in the first user message',
      ]);
      assert.doesNotMatch(
        request.systemPrompt,
        /FORBIDDEN_|AUTO_SKILL_BODY_|AUTO_DESCRIPTION_hidden-skill/,
      );
      assert.deepEqual(f.errors, []);
    }));

  for (const trusted of [false, true]) {
    test('native project skill discovery respects effective trust: ' + trusted, async () =>
      withFixture({}, async (f) => {
        for (const [dir, name] of [
          [path.join(f.agentDir, 'skills'), 'trusted-user-skill'],
          [path.join(f.cwd, CONFIG_DIR_NAME, 'skills'), 'trusted-project-skill'],
          [path.join(path.dirname(f.cwd), '.agents', 'skills'), 'trusted-ancestor-skill'],
        ]) {
          write(
            path.join(dir, name, 'SKILL.md'),
            '---\nname: ' + name + '\ndescription: Trust fixture\n---\nBody',
          );
        }
        const session = await f.create({ projectTrusted: trusted });
        assert.deepEqual(
          session.resourceLoader
            .getSkills()
            .skills.map((skill) => skill.name)
            .sort(),
          trusted
            ? ['trusted-ancestor-skill', 'trusted-project-skill', 'trusted-user-skill']
            : ['trusted-user-skill'],
        );
      }),
    );
  }

  test('native Pi skill exclusions remain effective', async () =>
    withFixture({}, async (f) => {
      for (const name of ['included-skill', 'excluded-skill'])
        write(
          path.join(f.agentDir, 'skills', name, 'SKILL.md'),
          '---\nname: ' + name + '\ndescription: Native settings fixture\n---\nBody',
        );
      json(path.join(f.agentDir, 'settings.json'), {
        ...baseSettings,
        skills: ['-skills/excluded-skill'],
      });
      const session = await f.create();
      assert.deepEqual(
        session.resourceLoader.getSkills().skills.map((skill) => skill.name),
        ['included-skill'],
      );
      assert.doesNotMatch(session.systemPrompt, /excluded-skill/);
    }));

  test('retired persisted skill fields are not consumed when reopening a child', async () =>
    withFixture({}, async (f) => {
      const skillPath = path.join(f.root, 'retired-skill', 'SKILL.md');
      write(skillPath, '---\nname: retired-skill\ndescription: RETIRED_SKILL_MARKER\n---\nBody');
      const legacyInfo = {
        ...f.info,
        skills: ['retired-skill'],
        skillPaths: [skillPath, path.join(f.root, 'missing-retired-skill.md')],
      };
      const session = await f.create({ info: legacyInfo });
      assert.deepEqual(session.resourceLoader.getSkills().skills, []);
      assert.doesNotMatch(session.systemPrompt, /RETIRED_SKILL_MARKER/);
    }));

  test('SYSTEM file whose text is another path is read once, not reinterpreted', async () =>
    withFixture({}, async (f) => {
      const target = path.join(f.root, 'must-not-read.md');
      write(target, 'UNEXPECTED_SECOND_READ');
      write(f.systemPromptPath, target);
      const session = await f.create();
      assert.equal(session.resourceLoader.getSystemPrompt(), target);
      assert.equal(session.resourceLoader.getSystemPromptSource()?.path, f.systemPromptPath);
      assert.ok(session.systemPrompt.includes(target));
      assert.doesNotMatch(session.systemPrompt, /UNEXPECTED_SECOND_READ/);
    }));

  test('missing or BOM/whitespace-only SYSTEM fails before extension loading', async () =>
    withFixture({}, async (f) => {
      write(f.systemPromptPath, '\uFEFF \n ');
      await assert.rejects(f.create(), /System prompt is empty/);
      fs.unlinkSync(f.systemPromptPath);
      await assert.rejects(f.create(), /ENOENT/);
      assert.deepEqual(f.events(), []);
      assert.equal(f.sessions.size, 0);
    }));

  test('tools retain undefined / allowlist / no-builtin tri-state; SDK does not load CLI builtins', async () =>
    withFixture({}, async (f) => {
      json(path.join(f.agentDir, 'settings.json'), {
        ...baseSettings,
        defaultTools: ['+codemode'],
      });
      for (const tools of [undefined, 'read', '']) {
        const session = await f.create({
          info: {
            ...f.info,
            tools,
            sessionFile: path.join(f.root, 'subagents', 'tools-' + String(tools) + '.jsonl'),
          },
        });
        const active = session.getActiveToolNames();
        if (tools === undefined) {
          assert.ok(active.includes('read'));
          assert.ok(active.includes('fixture_tool'));
        } else if (tools === 'read') assert.deepEqual(active, ['read']);
        else assert.deepEqual(active, ['fixture_tool']);
        assert.ok(
          !session.getAllTools().some((tool) => ['codemode', 'tool_search'].includes(tool.name)),
        );
        await f.close(session);
      }
    }));

  test('native codemode opt-in executes nested tools, preserves settings and restores its store', async () =>
    withFixture({}, async (f) => {
      json(path.join(f.agentDir, 'settings.json'), {
        ...baseSettings,
        defaultTools: ['read'],
        codemode: { mode: 'only', inlineBudget: 0 },
      });
      f.info.extensionPaths!.push('builtin:codemode');
      write(path.join(f.cwd, 'codemode.txt'), 'OFFLINE_CODEMODE_FILE');
      f.configure({
        codemodeScript:
          '// @options: {"timeout_ms": 15000}\n' +
          'const results = await Promise.allSettled([tools.read({ path: "codemode.txt" }), tools.fixture_tool({})]);\n' +
          'for (const result of results) { if (result.status !== "fulfilled") throw result.reason; text(result.value); }\n' +
          'store("offline-check", "CODEMODE_PERSISTED");',
      });
      let session = await f.create();
      assert.deepEqual(
        new Set(session.getActiveToolNames()),
        new Set(['read', 'codemode', 'fixture_tool']),
      );
      const metadata = session.getAllTools().find((tool) => tool.name === 'codemode')!;
      assert.equal(metadata.sourceInfo.path, 'builtin:codemode');
      assert.equal(metadata.sourceInfo.source, 'builtin');
      assert.deepEqual(session.settingsManager.getSettings().codemode, {
        mode: 'only',
        inlineBudget: 0,
      });
      assert.ok(!session.getAllTools().some((tool) => tool.name === 'tool_search'));
      await prompt(session, 'Run the offline codemode check');
      const result = session.messages.findLast((message) => message.role === 'toolResult');
      assert.ok(result?.role === 'toolResult');
      const output = JSON.stringify(result.content);
      assert.match(output, /Script completed/);
      assert.match(output, /OFFLINE_CODEMODE_FILE/);
      assert.match(output, /fixture tool/);
      await f.close(session);
      f.configure({
        codemodeScript: '// @options: {"timeout_ms": 15000}\ntext(load("offline-check"));',
      });
      session = await f.create();
      await prompt(session, 'Read the persisted codemode value');
      const stored = session.messages.findLast((message) => message.role === 'toolResult');
      assert.ok(stored?.role === 'toolResult');
      assert.match(JSON.stringify(stored.content), /Script completed/);
      assert.match(JSON.stringify(stored.content), /CODEMODE_PERSISTED/);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(f.agentDir, 'settings.json'), 'utf8')).defaultTools,
        ['read'],
      );
      assert.deepEqual(f.errors, []);
    }));

  test('native codemode opt-in respects explicit allowlists, empty tools and tool modifiers', async () =>
    withFixture({}, async (f) => {
      json(path.join(f.agentDir, 'settings.json'), { ...baseSettings, defaultTools: ['read'] });
      const cases: Array<[string, string[]]> = [
        ['read', ['read']],
        ['read,codemode', ['read', 'codemode']],
        ['', ['fixture_tool']],
        ['-codemode', ['read', 'fixture_tool']],
        ['+grep', ['read', 'codemode', 'grep', 'fixture_tool']],
      ];
      for (const [index, [tools, active]] of cases.entries()) {
        const session = await f.create({
          info: {
            ...f.info,
            tools,
            extensionPaths: [...f.info.extensionPaths!, 'builtin:codemode'],
            sessionFile: path.join(f.root, 'subagents', 'codemode-tools-' + index + '.jsonl'),
          },
        });
        assert.deepEqual(new Set(session.getActiveToolNames()), new Set(active), tools);
        await f.close(session);
      }
    }));

  test('native codemode opt-in preserves an empty default tool selection', async () =>
    withFixture({}, async (f) => {
      json(path.join(f.agentDir, 'settings.json'), { ...baseSettings, defaultTools: [] });
      const session = await f.create({
        info: { ...f.info, extensionPaths: [...f.info.extensionPaths!, 'builtin:codemode'] },
      });
      assert.deepEqual(
        new Set(session.getActiveToolNames()),
        new Set(['codemode', 'fixture_tool']),
      );
    }));

  test('native codemode opt-in does not conflict with an explicitly configured codemode file', async () =>
    withFixture({}, async (f) => {
      const codemodePath = fileURLToPath(
        new URL(
          './extensions/codemode/index.js',
          import.meta.resolve('@earendil-works/pi-coding-agent'),
        ),
      );
      const session = await f.create({
        info: {
          ...f.info,
          extensionPaths: [...f.info.extensionPaths!, 'builtin:codemode', codemodePath],
        },
      });
      assert.ok(session.getActiveToolNames().includes('codemode'));
      assert.equal(session.getAllTools().filter((tool) => tool.name === 'codemode').length, 1);
      assert.deepEqual(session.resourceLoader.getExtensions().errors, []);
      assert.deepEqual(f.errors, []);
    }));

  test('explicit effective trust overrides saved decisions and gates project settings everywhere', async () =>
    withFixture({}, async (f) => {
      const store = new ProjectTrustStore(f.agentDir);
      json(path.join(f.cwd, CONFIG_DIR_NAME, 'settings.json'), {
        defaultTools: ['fixture_tool'],
        defaultProvider: 'project-default',
      });
      for (const trusted of [false, true]) {
        store.set(f.cwd, !trusted);
        const session = await f.create({ projectTrusted: trusted });
        assert.equal(session.settingsManager.isProjectTrusted(), trusted);
        assert.equal(session.extensionRunner.createContext().isProjectTrusted(), trusted);
        assert.equal(
          f
            .events()
            .filter((event) => event.type === 'session_start')
            .at(-1)!.trusted,
          trusted,
        );
        assert.equal(
          session.settingsManager.getDefaultProvider(),
          trusted ? 'project-default' : 'parent-default',
        );
        assert.equal(session.getActiveToolNames().includes('read'), !trusted);
        await f.close(session);
      }
    }));

  test('headless trust uses child cwd, global policy and native store; unknown ask/never stay closed', async () =>
    withFixture({}, async (f) => {
      json(path.join(f.cwd, CONFIG_DIR_NAME, 'settings.json'), {
        defaultProjectTrust: 'always',
        defaultProvider: 'project-default',
      });
      const store = new ProjectTrustStore(f.agentDir);
      // Trust decisions are scoped to each working directory.
      store.set(path.join(f.root, 'other-parent-cwd'), true);
      for (const policy of ['ask', 'never', 'always']) {
        json(path.join(f.agentDir, 'settings.json'), {
          ...baseSettings,
          defaultProjectTrust: policy,
        });
        const session = await f.create();
        assert.equal(session.settingsManager.isProjectTrusted(), policy === 'always');
        assert.equal(store.get(f.cwd), null, 'headless fallback must not save a new authorization');
        await f.close(session);
      }
      for (const saved of [false, true]) {
        store.set(f.cwd, saved);
        const session = await f.create();
        assert.equal(session.settingsManager.isProjectTrusted(), saved);
        await f.close(session);
      }
    }));

  test('restoring rereads settings/current trust and never persists child route/thinking as defaults', async () =>
    withFixture({}, async (f) => {
      json(path.join(f.cwd, CONFIG_DIR_NAME, 'settings.json'), { defaultProvider: 'project-one' });
      const globalSettingsPath = path.join(f.agentDir, 'settings.json');
      const original = fs.readFileSync(globalSettingsPath, 'utf8');
      const first = await f.create({ projectTrusted: true, info: { ...f.info, thinking: 'high' } });
      assert.equal(first.thinkingLevel, 'off', 'SDK clamps unsupported thinking');
      await prompt(first, 'first child message');
      await first.setModel(first.modelRuntime.getModel(f.info.provider, 'other-model')!);
      first.setThinkingLevel('high');
      await first.settingsManager.flush();
      await f.close(first);
      json(path.join(f.cwd, CONFIG_DIR_NAME, 'settings.json'), { defaultProvider: 'project-two' });
      const second = await f.create({ projectTrusted: false });
      assert.equal(second.settingsManager.getDefaultProvider(), 'parent-default');
      assert.equal(
        second.model?.id,
        f.info.modelId,
        'saved info route wins over historical/model defaults',
      );
      assert.equal(second.sessionId, first.sessionId);
      assert.equal(assistants(second).length, 1);
      assert.notEqual(second.modelRuntime, first.modelRuntime);
      assert.notEqual(second.settingsManager, first.settingsManager);
      assert.notEqual(second.resourceLoader, first.resourceLoader);
      await second.settingsManager.flush();
      assert.equal(fs.readFileSync(globalSettingsPath, 'utf8'), original);
    }));

  test('model selection is exact: missing provider, case and partial IDs never fall back', async () =>
    withFixture({}, async (f) => {
      for (const route of [
        { provider: 'missing' },
        { modelId: 'exact' },
        { modelId: 'EXACT/model' },
      ]) {
        await assert.rejects(
          f.create({ info: { ...f.info, ...route } }),
          /Model is not available:/,
        );
      }
      assert.equal(f.sessions.size, 0);
      assert.equal(f.events().filter((event) => event.type === 'request').length, 0);
      assert.equal(f.events().filter((event) => event.type === 'factory').length, 3);
    }));

  test('filterModels exclusions fail before creating a Session', async () =>
    withFixture({ filtered: true }, async (f) => {
      await assert.rejects(f.create(), /Model is not available:/);
      assert.equal(f.sessions.size, 0);
    }));

  test('binding must not filter away or replace the exact selected route', async () => {
    for (const config of [{ filterAtStart: true }, { changeModelAtStart: true }])
      await withFixture(config, async (f) => {
        let startupError: unknown;
        try {
          await f.create();
        } catch (error) {
          startupError = error;
        }
        assert.ok(startupError, JSON.stringify(f.events()));
        assert.match(
          String(startupError),
          config.filterAtStart
            ? /not available after extension binding/
            : /changed the selected model/,
        );
        assert.equal(f.sessions.size, 1, 'onCreated transfers ownership before binding can fail');
        assert.equal(f.events().filter((event) => event.type === 'factory').length, 1);
        assert.equal(f.events().filter((event) => event.type === 'request').length, 0);
      });
  });

  test('invalid provider registration fails before creating a Session', async () =>
    withFixture({ badRegistration: true }, async (f) => {
      await assert.rejects(f.create(), /Extension .* error:/);
      assert.equal(f.sessions.size, 0);
      assert.equal(f.events().filter((event) => event.type === 'factory').length, 1);
    }));

  test('registration errors during session_start cannot silently retain the same-name old model', async () =>
    withFixture({ badRegistrationAtStart: true }, async (f) => {
      await assert.rejects(f.create(), /Extension .* error:/);
      assert.equal(f.sessions.size, 1);
      assert.ok(f.errors.length > 0);
      assert.equal(f.events().filter((event) => event.type === 'request').length, 0);
    }));

  test('explicit extension load errors fail before creating a Session', async () =>
    withFixture({}, async (f) => {
      const broken = path.join(f.root, 'broken-extension.ts');
      write(broken, 'export default () => { throw new Error("explicit factory failure"); };');
      await assert.rejects(
        f.create({ info: { ...f.info, extensionPaths: [...f.info.extensionPaths!, broken] } }),
        /explicit factory failure/,
      );
      assert.equal(f.sessions.size, 0);
      const missing = path.join(f.root, 'missing-extension.ts');
      await assert.rejects(
        f.create({ info: { ...f.info, extensionPaths: [...f.info.extensionPaths!, missing] } }),
        /missing-extension/,
      );
      assert.equal(f.sessions.size, 0);
    }));

  test('ordinary skill warnings are logged rather than promoted to startup failure', async () =>
    withFixture({}, async (f) => {
      const invalidSkill = path.join(f.agentDir, 'skills', 'warning-skill', 'SKILL.md');
      write(invalidSkill, '---\nname: warning-skill\n---\nMissing description');
      await f.create();
      assert.equal(
        f.logs.filter((message) => message.includes('warning') && message.includes('description'))
          .length,
        1,
        JSON.stringify(f.logs),
      );
    }));

  test('resources_discover diagnostics are checked after binding and unchanged warnings are not logged twice', async () =>
    withFixture({}, async (f) => {
      const invalidSkill = path.join(f.root, 'hook-warning', 'SKILL.md');
      write(invalidSkill, '---\nname: hook-warning\n---\nMissing description');
      f.configure({ resources: { skillPaths: [invalidSkill] } });
      await f.create();
      assert.equal(
        f.logs.filter((message) => message.includes('description')).length,
        1,
        JSON.stringify(f.logs),
      );
    }));

  test('explicit package and resources_discover may contribute native companion resources', async () =>
    withFixture({}, async (f) => {
      const packageSkill = path.join(f.extensionDir, 'package-skill', 'SKILL.md');
      const hookSkill = path.join(f.root, 'hook-skill', 'SKILL.md');
      const hookPrompt = path.join(f.root, 'hook-template.md');
      write(packageSkill, '---\nname: package-skill\ndescription: Package companion\n---\nBody');
      write(hookSkill, '---\nname: hook-skill\ndescription: Hook companion\n---\nBody');
      write(path.join(f.extensionDir, 'package-template.md'), 'PACKAGE_TEMPLATE_BODY');
      write(hookPrompt, 'HOOK_TEMPLATE_BODY');
      json(path.join(f.extensionDir, 'package.json'), {
        name: 'offline-fixture',
        pi: {
          extensions: ['./index.ts'],
          skills: ['./package-skill'],
          prompts: ['./package-template.md'],
        },
      });
      f.configure({ resources: { skillPaths: [hookSkill], promptPaths: [hookPrompt] } });
      const session = await f.create({ info: { ...f.info, extensionPaths: [f.extensionDir] } });
      assert.deepEqual(
        session.resourceLoader
          .getSkills()
          .skills.map((skill) => skill.name)
          .sort(),
        ['hook-skill', 'package-skill'],
      );
      assert.deepEqual(
        session.resourceLoader
          .getPrompts()
          .prompts.map((template) => template.name)
          .sort(),
        ['hook-template', 'package-template'],
      );
      await prompt(session, '/hook-template');
      assert.deepEqual(f.events().find((event) => event.type === 'request')!.userTexts, [
        'HOOK_TEMPLATE_BODY',
      ]);
      assert.equal(f.events().filter((event) => event.type === 'factory').length, 1);
    }));

  test('factory executes once per Session; same-cwd reopen keeps cached module code but fresh instance state', async () =>
    withFixture({}, async (f) => {
      const first = await f.create();
      await prompt(first, 'one');
      await f.close(first);
      const original = fs.readFileSync(f.extensionPath, 'utf8');
      const updated = original.replace(
        "const MODULE_VERSION = 'fixture-v1';",
        "const MODULE_VERSION = 'fixture-v2';",
      );
      assert.notEqual(updated, original, 'MODULE_VERSION replacement must change the fixture');
      write(f.extensionPath, updated);
      const second = await f.create();
      await prompt(second, 'two');
      assert.deepEqual(
        f
          .events()
          .filter((event) => event.type === 'factory')
          .map((event) => event.moduleVersion),
        ['fixture-v1', 'fixture-v1'],
      );
      assert.deepEqual(
        f
          .events()
          .filter((event) => event.type === 'request')
          .map((event) => event.request),
        [1, 1],
      );
      assert.equal(f.events().filter((event) => event.type === 'session_start').length, 2);
    }));

  test('initialization cancellation checks after services and after binding; ownership precedes cancellation', async () => {
    await withFixture({ factoryGate: true }, async (f) => {
      let canceled = false;
      const creating = f.create({
        checkCanceled() {
          if (canceled) throw new Error('canceled during factory');
        },
      });
      await f.waitFor('factory');
      canceled = true;
      f.release('factory');
      await assert.rejects(creating, /canceled during factory/);
      assert.equal(f.sessions.size, 0);
    });
    await withFixture({ startupGate: true }, async (f) => {
      let canceled = false;
      const creating = f.create({
        checkCanceled() {
          if (canceled) throw new Error('canceled during binding');
        },
      });
      await f.waitFor('session_start');
      assert.equal(f.sessions.size, 1);
      canceled = true;
      f.release('startup');
      await assert.rejects(creating, /canceled during binding/);
      assert.equal(f.events().filter((event) => event.type === 'request').length, 0);
    });
    await withFixture({}, async (f) => {
      let canceled = false;
      await assert.rejects(
        f.create({
          onCreated() {
            canceled = true;
          },
          checkCanceled() {
            if (canceled) throw new Error('canceled after creation');
          },
        }),
        /canceled after creation/,
      );
      assert.equal(f.sessions.size, 1);
      assert.equal(f.events().filter((event) => event.type === 'session_start').length, 0);
    });
  });

  test('headless mode has no UI; startup and idle ctx.shutdown synchronously notify only this child', async () => {
    await withFixture({ shutdownAtStart: true }, async (f) => {
      let closing = false;
      await assert.rejects(
        f.create({
          onShutdown() {
            closing = true;
          },
          checkCanceled() {
            if (closing) throw new Error('child closing');
          },
        }),
        /child closing/,
      );
      assert.equal(closing, true);
      const start = f.events().find((event) => event.type === 'session_start')!;
      assert.equal(start.mode, 'print');
      assert.equal(start.hasUI, false);
      assert.equal(f.sessions.size, 1);
    });
    await withFixture({}, async (f) => {
      let shutdowns = 0;
      const session = await f.create({
        onShutdown() {
          shutdowns++;
        },
      });
      session.extensionRunner.createContext().shutdown();
      assert.equal(shutdowns, 1);
      assert.deepEqual(await prompt(session, 'fixture:shutdown'), ['handled']);
      assert.equal(shutdowns, 2);
      assert.equal(f.events().filter((event) => event.type === 'request').length, 0);
    });
  });

  test('preflight started acknowledges acceptance before completion, preserving source rpc', async () =>
    withFixture({ responseGate: true }, async (f) => {
      const session = await f.create();
      const accepted = deferred<Disposition>();
      let finished = false;
      const raw = promptChildSession(session, 'work', accepted.resolve);
      const completion = raw
        .then(() => session.waitForIdle())
        .then(() => {
          finished = true;
        });
      assert.equal(await accepted.promise, 'started');
      await f.waitFor('request');
      assert.equal(finished, false);
      assert.equal(session.isStreaming, true);
      assert.equal(f.events().find((event) => event.type === 'input')!.source, 'rpc');
      f.release('response');
      await completion;
      assert.equal(session.getLastAssistantText(), 'offline: work');
    }));

  test('handled without a run is accepted but creates no assistant and must not reuse the previous answer', async () =>
    withFixture({}, async (f) => {
      const session = await f.create();
      await prompt(session, 'old answer');
      const before = assistants(session).length;
      assert.deepEqual(await prompt(session, 'fixture:handled'), ['handled']);
      assert.equal(assistants(session).length, before);
      assert.equal(
        session.getLastAssistantText(),
        'offline: old answer',
        'SDK history lookup is NOT a per-run result',
      );
    }));

  test('rejected preflight never reports acceptance', async () =>
    withFixture({ responseGate: true }, async (f) => {
      const session = await f.create();
      const first = prompt(session, 'busy');
      await f.waitFor('request');
      const accepted: Disposition[] = [];
      await assert.rejects(
        promptChildSession(session, 'reject while busy', (d) => {
          accepted.push(d);
        }),
        /already processing/,
      );
      assert.deepEqual(accepted, []);
      await session.abort();
      await first;
    }));

  test('handled may start independent SDK work: prompt resolves, chained waitForIdle still waits', async () =>
    withFixture({ responseGate: true }, async (f) => {
      const session = await f.create();
      const accepted: Disposition[] = [];
      const raw = promptChildSession(session, 'fixture:handled-run', (d) => {
        accepted.push(d);
      });
      let finished = false;
      const completion = raw
        .then(() => session.waitForIdle())
        .then(() => {
          finished = true;
        });
      await raw;
      assert.deepEqual(accepted, ['handled']);
      await f.waitFor('request');
      assert.equal(finished, false);
      assert.equal(session.isStreaming, true);
      f.release('response');
      await completion;
      assert.equal(session.getLastAssistantText(), 'offline: work started by handled input');
    }));

  for (const kind of ['handled', 'ordinary'] as const) {
    test('busy-time native waitForIdle covers the early-idle settled hook: ' + kind, async () =>
      withFixture({ settledGate: true }, async (f) => {
        let barrier: Promise<void> | undefined;
        let barrierFinished = false, settledEvents = 0;
        const session = await f.create({
          onCreated(session) {
            session.subscribe((event) => {
              if (event.type === 'agent_start' && !barrier) {
                barrier = session.waitForIdle().then(() => { barrierFinished = true; });
              }
              if (event.type === 'agent_settled') settledEvents++;
            });
          },
        });
        const accepted = deferred<Disposition>();
        const raw = promptChildSession(session,
          kind === 'handled' ? 'fixture:handled-settled' : 'ordinary', accepted.resolve);
        await f.waitFor('settled_entered');
        assert.equal(await accepted.promise, kind === 'handled' ? 'handled' : 'started');
        if (kind === 'handled') await raw;
        assert.equal(session.isIdle, true);
        await session.waitForIdle(); // A late waiter really does return before the hook exits in SDK 1.5.
        assert.ok(barrier);
        assert.equal(barrierFinished, false);
        assert.equal(settledEvents, 0);
        f.release('settled');
        await raw;
        await barrier;
        assert.equal(barrierFinished, true);
        assert.equal(settledEvents, 1);
        await prompt(session, 'next');
        assert.equal(session.getLastAssistantText(), 'offline: next');
        assert.equal(settledEvents, 2);
        assert.equal(f.events().filter((e) => e.type === 'factory').length, 1);
        assert.deepEqual(f.errors, []);
      }));
  }

  for (const outcome of ['cancel', 'failure'] as const) {
    test('native idle waiter precedes public compact settlement through failed hook: ' + outcome, async () =>
      withFixture({ compactionOutcome: outcome, compactionFailureGate: true }, async (f) => {
        const session = await f.create();
        await prompt(session, 'seed');
        session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 } });
        let nativeIdle: Promise<void> | undefined;
        let compactFinished = false;
        session.subscribe((event) => {
          if (event.type === 'compaction_start') nativeIdle = session.waitForIdle();
        });
        const compacting = session.compact('summary focus').then(
          (result) => { compactFinished = true; return { result, error: undefined }; },
          (error: Error) => { compactFinished = true; return { result: undefined, error }; },
        );
        const event = await f.waitFor('compaction_failed');
        assert.equal(event.aborted, outcome === 'cancel');
        assert.ok(nativeIdle);
        await nativeIdle;
        assert.equal(session.isIdle, true);
        await session.waitForIdle();
        assert.equal(compactFinished, false, 'whole public operation still awaits its failed notification hook');
        assert.equal(f.events().filter((e) => e.type === 'compaction_failed_finished').length, 0);
        f.release('compaction-failed');
        const result = await compacting;
        assert.match(result.error?.message ?? '', outcome === 'cancel' ? /cancelled/ : /fixture compaction failure/);
        assert.equal(compactFinished, true);
        assert.equal(f.events().filter((e) => e.type === 'compaction_failed_finished').length, 1);
        await prompt(session, 'after failed hook');
        assert.equal(session.getLastAssistantText(), 'offline: after failed hook');
        assert.deepEqual(f.errors, []);
      }));
  }

  test('abort idle does not cancel blocked input; caller must track raw prompt and abort late preflight', async () =>
    withFixture({ responseGate: true }, async (f) => {
      const session = await f.create();
      let closing = false;
      let lateAbort: Promise<void> | undefined;
      const accepted: Disposition[] = [];
      const raw = promptChildSession(session, 'fixture:input-gate', (disposition) => {
        accepted.push(disposition);
        if (closing) {
          lateAbort = session.abort();
          void lateAbort.catch(() => {});
        }
      });
      let finished = false;
      const completion = raw
        .then(() => session.waitForIdle())
        .then(() => {
          finished = true;
        });
      await f.waitFor('input');
      closing = true;
      await session.abort();
      assert.equal(finished, false);
      assert.deepEqual(accepted, []);
      f.release('input');
      await completion;
      await lateAbort;
      assert.deepEqual(accepted, ['started']);
      assert.equal(session.isStreaming, false);
    }));

  test('two child runtimes, histories and provider instances remain independent; steer settles once', async () =>
    withFixture({ responseGate: true, prefix: 'first' }, async (f) => {
      const first = await f.create();
      f.configure({ responseGate: true, prefix: 'second' });
      const second = await f.create({
        info: { ...f.info, sessionFile: path.join(f.root, 'subagents', 'second.jsonl') },
      });
      let settled = 0;
      first.subscribe((event) => {
        if (event.type === 'agent_settled') settled++;
      });
      assert.notEqual(first.sessionId, second.sessionId);
      assert.notEqual(first.modelRuntime, second.modelRuntime);
      assert.notEqual(
        first.modelRuntime.getProvider(f.info.provider),
        second.modelRuntime.getProvider(f.info.provider),
      );
      const firstRun = prompt(first, 'initial first');
      const secondRun = prompt(second, 'initial second');
      await f.waitFor('request', (event) => event.userTexts.includes('initial second'));
      assert.equal(await first.steer('steered first', undefined, { source: 'rpc' }), 'queued');
      await second.abort();
      await secondRun;
      assert.equal(first.isStreaming, true);
      f.release('response');
      await firstRun;
      assert.equal(settled, 1);
      assert.equal(first.getLastAssistantText(), 'first: steered first');
      assert.ok(!JSON.stringify(first.messages).includes('initial second'));
      assert.ok(!JSON.stringify(second.messages).includes('steered first'));
      assert.equal(
        f.events().find((event) => event.type === 'input' && event.text === 'steered first')!
          .source,
        'rpc',
      );
    }));

  test('late asynchronous steer may say queued after original run is idle (manager must recheck)', async () =>
    withFixture({ responseGate: true }, async (f) => {
      const session = await f.create();
      const run = prompt(session, 'original');
      await f.waitFor('request');
      const steering = session.steer('fixture:steer-gate', undefined, { source: 'rpc' });
      await f.waitFor('input', (event) => event.text === 'fixture:steer-gate');
      f.release('response');
      await run;
      f.release('input');
      assert.equal(await steering, 'queued');
      assert.equal(session.isStreaming, false);
      assert.deepEqual(session.getSteeringMessages(), ['fixture:steer-gate']);
      session.clearQueue();
    }));

  test('standard JSONL opens/resumes in the same file without entering the default resume list', async () =>
    withFixture({}, async (f) => {
      const old = SessionManager.open(
        f.info.sessionFile,
        path.dirname(f.info.sessionFile),
        'old-cwd',
      );
      old.appendMessage({
        role: 'user',
        content: 'old RPC-era user history',
        timestamp: Date.now(),
      });
      const sessionId = old.getSessionId();
      const first = await f.create();
      assert.equal(first.sessionId, sessionId);
      assert.equal(first.sessionManager.getCwd(), f.cwd);
      assert.equal(first.sessionFile, f.info.sessionFile);
      await prompt(first, 'continue child');
      await f.close(first);
      const second = await f.create();
      await prompt(second, 'continue again');
      assert.equal(second.sessionFile, f.info.sessionFile);
      assert.equal(assistants(second).length, 2);
      assert.deepEqual(
        f
          .events()
          .filter((event) => event.type === 'request')
          .at(-1)!.userTexts,
        ['old RPC-era user history', 'continue child', 'continue again'],
      );
      assert.deepEqual(await SessionManager.list(f.cwd), []);
      assert.deepEqual(await SessionManager.listAll(), []);
      // Runtime cwd overrides preserve the JSONL header used by session listings.
      assert.equal((await SessionManager.list(f.cwd, path.dirname(f.info.sessionFile))).length, 0);
      assert.equal(
        (await SessionManager.list('old-cwd', path.dirname(f.info.sessionFile))).length,
        1,
      );
      assert.equal((await SessionManager.listAll(path.dirname(f.info.sessionFile))).length, 1);
    }));

  test('message_end precedes persistence; turn_end and finished chain see authoritative context usage', async () =>
    withFixture({}, async (f) => {
      const session = await f.create();
      const samples: { event: string; persisted: number; tokens: number | null | undefined }[] = [];
      session.subscribe((event) => {
        if (
          event.type === 'turn_end' ||
          (event.type === 'message_end' && event.message.role === 'assistant')
        ) {
          samples.push({
            event: event.type,
            persisted: assistants(session).length,
            tokens: session.getContextUsage()?.tokens,
          });
        }
      });
      await prompt(session, 'usage');
      assert.equal(samples.find((sample) => sample.event === 'message_end')!.persisted, 0);
      assert.notEqual(samples.find((sample) => sample.event === 'message_end')!.tokens, 50_000);
      assert.deepEqual(
        samples.find((sample) => sample.event === 'turn_end'),
        { event: 'turn_end', persisted: 1, tokens: 50_000 },
      );
      assert.equal(session.getContextUsage()?.tokens, 50_000);
      assert.equal(
        SessionManager.open(f.info.sessionFile)
          .getBranch()
          .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant').length,
        1,
      );
    }));

  test('throwing SDK subscribers can interrupt native assistant append: observer errors must not escape', async () =>
    withFixture({}, async (f) => {
      const session = await f.create();
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_end' && event.message.role === 'assistant')
          throw new Error('observer failure');
      });
      await assert.rejects(
        promptChildSession(session, 'observer', () => {}),
        /observer failure/,
      );
      unsubscribe();
      assert.equal(assistants(session).length, 0);
    }));

  test('core fixture timer abort releases its stream and preserves default/large responses', async () =>
    withFixture({}, async (f) => {
      const { configureCoreFixture, waitUntil } = await import('./fixtures/core-sdk-fixture.ts');
      const state = configureCoreFixture({ routes: [[f.info.provider, f.info.modelId]] });
      const session = await f.create({
        info: {
          ...f.info,
          extensionPaths: [
            fileURLToPath(new URL('./fixtures/core-sdk-fixture.ts', import.meta.url)),
          ],
        },
      });
      const completion = prompt(session, 'slow timer abort');
      await waitUntil(() => state.instances[0].activeStreams === 1);
      await session.abort();
      await completion;
      const instance = state.instances[0];
      assert.equal(instance.requests[0].message.stopReason, 'aborted');
      assert.match(instance.requests[0].message.errorMessage!, /abort/i);
      assert.equal(instance.activeStreams, 0);
      assert.equal(session.isStreaming, false);
      await prompt(session, 'ordinary');
      assert.equal(session.getLastAssistantText(), 'response:ordinary');
      await prompt(session, 'large');
      assert.equal(session.getLastAssistantText(), 'x'.repeat(60 * 1024));
    }));

  test('normal prompt return is not model success: stopReason error/aborted remain authoritative', async () => {
    for (const stopReason of ['error', 'aborted'] as const)
      await withFixture({ stopReason }, async (f) => {
        const session = await f.create();
        assert.deepEqual(await prompt(session, 'fail response'), ['started']);
        const message = session.messages.filter((message) => message.role === 'assistant').at(-1)!;
        assert.equal(message.stopReason, stopReason);
        assert.match(message.errorMessage!, /fixture/);
      });
  });

  test('abort requested during preflight settles as aborted without making a provider request', async () =>
    withFixture({}, async (f) => {
      const session = await f.create();
      const settled: boolean[] = [];
      session.subscribe((event) => {
        if (event.type === 'agent_settled') settled.push(event.aborted);
      });
      assert.deepEqual(await prompt(session, 'fixture:abort-before-run'), ['started']);
      assert.deepEqual(settled, [true]);
      // Pre-run cancellation reports settled.aborted with an error assistant message.
      const assistant = session.messages.filter((message) => message.role === 'assistant').at(-1)!;
      assert.equal(assistant.stopReason, 'error');
      assert.equal(
        f.events().filter((event) => event.type === 'request').length,
        0,
        JSON.stringify(f.events()),
      );
    }));

  for (const scenario of ['success', 'interrupt', 'model-error'] as const) {
    test('native hot session reuses Session/ModelRuntime and cleans up once: ' + scenario, async () =>
      withFixture({
        prefix: 'hot',
        ...(scenario === 'interrupt' ? { responseGate: true } : {}),
        ...(scenario === 'model-error' ? { stopReason: 'error' as const } : {}),
      }, async (f) => {
        const { registerSessionResourceCleanup } = await import(
          new URL('session-resources.js', import.meta.resolve('@earendil-works/pi-ai')).href
        );
        const session = await f.create();
        const runtime = session.modelRuntime;
        const id = session.sessionId;
        let cleanupCount = 0;
        const unregister = registerSessionResourceCleanup((sessionId: string) => {
          if (sessionId === id) cleanupCount++;
        });
        try {
          const first = prompt(session, 'first');
          if (scenario === 'interrupt') {
            await f.waitFor('request');
            session.clearQueue();
            await session.abort();
          }
          await first;
          assert.equal(session.isIdle, true);
          assert.equal(cleanupCount, 0);
          if (scenario === 'model-error') assert.equal(assistants(session).at(-1)?.message.stopReason, 'error');
          await prompt(session, 'second');
          assert.equal(session.modelRuntime, runtime);
          assert.equal(session.sessionId, id);
          assert.equal(session.getLastAssistantText(), 'hot: second');
          assert.equal(cleanupCount, 0);
          for (const type of ['factory', 'session_start'])
            assert.equal(f.events().filter((e) => e.type === type).length, 1);
          assert.equal(f.events().filter((e) => e.type === 'session_shutdown').length, 0);
          assert.deepEqual(f.events().filter((e) => e.type === 'request').at(-1)?.userTexts, ['first', 'second']);
          await f.close(session);
          assert.equal(f.events().filter((e) => e.type === 'session_shutdown').length, 1);
          assert.equal(cleanupCount, 1);
        } finally {
          unregister();
        }
      }));
  }

  test('shutdown emits explicitly once, then disposes; successful paths clear their timeout', async () =>
    withFixture({}, async (f) => {
      const session = await f.create();
      const ctx = session.extensionRunner.createContext();
      await prompt(session, 'finish');
      await f.close(session, 60_000);
      assert.equal(f.events().filter((event) => event.type === 'session_shutdown').length, 1);
      assert.equal(f.events().filter((event) => event.type === 'shutdown_finished').length, 1);
      assert.throws(() => ctx.isProjectTrusted(), /stale/);
    }));

  test('bounded shutdown reports a timeout and still disposes while tracking late hook exit', async () =>
    withFixture({ shutdownGate: true }, async (f) => {
      const session = await f.create();
      const ctx = session.extensionRunner.createContext();
      let finished = false;
      const closing = f.close(session, 20).finally(() => { finished = true; });
      const result = assert.rejects(closing, /session_shutdown timed out after 20ms/);
      await delay(60);
      assert.equal(f.events().filter((event) => event.type === 'session_shutdown').length, 1);
      assert.throws(() => ctx.isProjectTrusted(), /stale/);
      assert.equal(finished, false, 'timed-out hook still owns its session until actual exit');
      f.release('shutdown');
      await f.waitFor('shutdown_finished');
      await result;
    }));

  test('shutdown hook errors reach native onError and cannot skip disposal', async () =>
    withFixture({ shutdownError: true }, async (f) => {
      const session = await f.create();
      const ctx = session.extensionRunner.createContext();
      await f.close(session);
      assert.ok(
        f.errors.some(
          (error: any) =>
            error.event === 'session_shutdown' && error.error.includes('fixture shutdown failure'),
        ),
      );
      assert.throws(() => ctx.isProjectTrusted(), /stale/);
    }));

  test('a throwing native resource cleanup cannot release ownership before a gated hook exits', async () =>
    withFixture({ shutdownGate: true }, async (f) => {
      const { registerSessionResourceCleanup } = await import(
        new URL('session-resources.js', import.meta.resolve('@earendil-works/pi-ai')).href
      );
      const session = await f.create();
      const ctx = session.extensionRunner.createContext();
      let cleanups = 0;
      let finished = false;
      const unregister = registerSessionResourceCleanup((id: string) => {
        if (id === session.sessionId && cleanups++ === 0)
          throw new Error('runtime cleanup failure');
      });
      try {
        const closing = f.close(session, 20).finally(() => {
          finished = true;
        });
        const result = assert.rejects(closing, (error: any) => {
          const message = String(error?.message ?? error);
          return (
            message.includes("session_shutdown timed out after 20ms") &&
            message.includes("Failed to cleanup session resources")
          );
        });
        await delay(60);
        assert.equal(cleanups, 1, "native disposal must still run at the timeout point");
        assert.equal(finished, false, "a throwing disposal must not release hook ownership");
        assert.equal(f.events().filter((event) => event.type === 'session_shutdown').length, 1);
        assert.equal(f.events().filter((event) => event.type === 'shutdown_finished').length, 0);
        f.release('shutdown');
        await f.waitFor('shutdown_finished');
        await result;
        assert.equal(cleanups, 1, "one session cleanup stays one");
        assert.throws(() => ctx.isProjectTrusted(), /stale/);
      } finally {
        unregister();
      }
    }));

  test('a throwing native resource cleanup surfaces the native error unchanged when the hook finished', async () =>
    withFixture({}, async (f) => {
      const { registerSessionResourceCleanup } = await import(
        new URL('session-resources.js', import.meta.resolve('@earendil-works/pi-ai')).href
      );
      const session = await f.create();
      let cleanups = 0;
      const unregister = registerSessionResourceCleanup((id: string) => {
        if (id === session.sessionId && cleanups++ === 0)
          throw new Error('runtime cleanup failure');
      });
      try {
        await assert.rejects(
          f.close(session),
          (error: any) =>
            error instanceof AggregateError &&
            error.errors.length === 1 &&
            error.errors[0] instanceof Error &&
            error.errors[0].message === 'runtime cleanup failure' &&
            error.message === "Failed to cleanup session resources",
        );
        assert.equal(cleanups, 1);
      } finally {
        unregister();
      }
    }));

  test('runtime never changes the host cwd or environment', async () =>
    withFixture({}, async (f) => {
      const cwd = process.cwd();
      const env = { ...process.env };
      const session = await f.create();
      await prompt(session, 'environment');
      await f.close(session);
      assert.equal(process.cwd(), cwd);
      assert.deepEqual({ ...process.env }, env);
    }));
}
