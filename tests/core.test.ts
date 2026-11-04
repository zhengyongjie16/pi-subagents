import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  configureCoreFixture,
  ObserverJsonlDecoder,
  deferred,
  useTestAgentDir,
  waitUntil,
  type CoreFixtureState,
} from './fixtures/core-sdk-fixture.js';
import type { AgentInfo } from '../src/core.js';
import { parseStreamingJson, type AssistantMessage } from '@earendil-works/pi-ai';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_AGENT_DIR = useTestAgentDir();
const CORE_SDK_EXTENSION = path.join(import.meta.dir, 'fixtures', 'core-sdk-fixture.ts');

const codingAgent = await import('@earendil-works/pi-coding-agent');

const {
  AgentManager,
  EventBroadcaster,
  RpcAssistantStreamState,
  consumeFirstMatchingMailboxEvent,
  formatAgentError,
  formatContextUsage,
  normalizeContextUsage,
  readInfoFile,
  getAgent,
  getAgentDefinitionsDescription,
  getRunsDir,
  getSocketPath,
  loadSubagentConfig,
  parentScopeKey,
  parseAgentDefinitionText,
  taskStorageKey,
  toObserverEvent,
} = await import('../src/core.js');

describe('observer stream reconstruction', () => {
  function assistant(content: AssistantMessage['content'] = []): AssistantMessage {
    return {
      role: 'assistant',
      content,
      api: 'test',
      provider: 'test',
      model: 'fake',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'pending',
      timestamp: Date.now(),
    };
  }

  function startTool(stream: InstanceType<typeof RpcAssistantStreamState>, index = 0) {
    stream.update({
      type: 'toolcall_start',
      contentIndex: index,
      id: 'call-' + index,
      toolName: 'read',
    });
  }

  test('assembles delta-only messages and distinguishes tool calls from thinking', () => {
    const stream = new RpcAssistantStreamState();
    stream.start(assistant());

    stream.update({ type: 'thinking_start', contentIndex: 0 });
    stream.update({ type: 'thinking_delta', contentIndex: 0, delta: 'checking' });
    expect(stream.status).toBe('thinking');
    expect(stream.message?.content[0]).toMatchObject({ type: 'thinking', thinking: 'checking' });

    stream.update({ type: 'toolcall_start', contentIndex: 1 });
    stream.update({ type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"src' });
    stream.update({ type: 'toolcall_delta', contentIndex: 1, delta: '/ui.rs"}' });
    expect(stream.status).toBe('calling');
    expect(stream.message?.content[0]).toMatchObject({ type: 'thinking', thinking: 'checking' });
    expect(stream.message?.content[1]).toMatchObject({
      type: 'toolCall',
      arguments: { path: 'src/ui.rs' },
    });

    stream.update({
      type: 'toolcall_end',
      contentIndex: 1,
      toolCall: { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'src/ui.rs' } },
    });
    expect(stream.message?.content[1]).toEqual({
      type: 'toolCall',
      id: 'call-1',
      name: 'read',
      arguments: { path: 'src/ui.rs' },
    });
  });

  test('parses pending arguments once on demand, retaining the raw prefix for further deltas', () => {
    const stream = new RpcAssistantStreamState();
    stream.start(assistant());
    startTool(stream);
    startTool(stream, 1);
    const parse = spyOn(JSON, 'parse');
    try {
      const prefix = '{"code":"' + 'x'.repeat(32 * 1024);
      stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"code":"' });
      for (let index = 0; index < 32; index++)
        stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: 'x'.repeat(1024) });
      stream.update({ type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"中文"}' });
      expect(stream.status).toBe('calling');
      expect(stream.snapshotToolArguments()).toEqual([
        [0, prefix],
        [1, '{"path":"中文"}'],
      ]);
      expect(parse).not.toHaveBeenCalled();

      const message = stream.message;
      expect(message?.content[0]).toMatchObject({ arguments: { code: 'x'.repeat(32 * 1024) } });
      expect(message?.content[1]).toMatchObject({ arguments: { path: '中文' } });
      const parsed = parse.mock.calls.length;
      expect(parsed).toBeGreaterThan(0);
      expect(stream.message).toBe(message);
      expect(stream.flushToolArguments()).toBe(false);
      expect(parse.mock.calls.length).toBe(parsed);
      expect(stream.snapshotToolArguments()[0]).toEqual([0, prefix]);

      const tail = '\\n中文😀","nested":{"items":[1,{"ok":true}]}}';
      stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: tail });
      expect(parse.mock.calls.length).toBe(parsed);
      expect(stream.message?.content[0]).toMatchObject({
        arguments: {
          code: 'x'.repeat(32 * 1024) + '\n中文😀',
          nested: { items: [1, { ok: true }] },
        },
      });
      expect(stream.snapshotToolArguments()[0]).toEqual([0, prefix + tail]);
    } finally {
      parse.mockRestore();
    }
  });

  test('sync/resume at every delta boundary preserves escaped, nested and Unicode arguments', () => {
    const args = { code: '中文😀\n"quoted"\\tail', nested: { items: [1, { ok: true }], empty: null } };
    const raw = JSON.stringify(args);
    const stream = new RpcAssistantStreamState();
    stream.start(assistant());
    startTool(stream);
    for (let index = 0; index <= raw.length; index++) {
      if (index) stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: raw[index - 1] });
      const prefix = raw.slice(0, index);
      expect(stream.message?.content[0]).toMatchObject({ arguments: parseStreamingJson(prefix) });
      expect(stream.snapshotToolArguments()).toEqual([[0, prefix]]);
      const resumed = new RpcAssistantStreamState();
      resumed.resume(
        structuredClone(stream.message!),
        stream.status,
        stream.snapshotToolArguments(),
      );
      resumed.update({ type: 'toolcall_delta', contentIndex: 0, delta: raw.slice(index) });
      expect(resumed.message?.content[0]).toMatchObject({
        id: 'call-0',
        name: 'read',
        arguments: args,
      });
      expect(resumed.snapshotToolArguments()).toEqual([[0, raw]]);
    }
  });

  test.each(['toolcall_end', 'cumulative', 'finish'])(
    '%s adopts authoritative arguments without parsing stale pending fragments',
    (source) => {
      const stream = new RpcAssistantStreamState();
      stream.start(assistant());
      startTool(stream);
      stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"stale":' });
      const call = Object.freeze({
        type: 'toolCall' as const,
        id: 'final',
        name: 'read',
        arguments: Object.freeze({ path: 'final' }),
      });
      const final = assistant([call]);
      const parse = spyOn(JSON, 'parse');
      try {
        if (source === 'toolcall_end')
          stream.update({ type: source, contentIndex: 0, toolCall: call });
        else if (source === 'cumulative')
          stream.update({ type: 'toolcall_delta', contentIndex: 0 }, final);
        else stream.finish(final);
        expect(stream.message?.content[0]).toBe(call);
        expect(stream.flushToolArguments()).toBe(false);
        expect(parse).not.toHaveBeenCalled();
        expect(stream.snapshotToolArguments()).toEqual([]);
      } finally {
        parse.mockRestore();
      }
    },
  );

  test('finish without a replacement message preserves the last pending arguments', () => {
    const stream = new RpcAssistantStreamState();
    stream.start(assistant());
    startTool(stream);
    stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"last"}' });
    stream.finish();
    expect(stream.snapshotToolArguments()).toEqual([]);
    expect(stream.message?.content[0]).toMatchObject({ arguments: { path: 'last' } });
  });

  test.each(['start', 'clear', 'resume', 'text_start', 'thinking_start', 'toolcall_start'])(
    '%s discards pending arguments before a new message or content block replaces them',
    (source) => {
      const stream = new RpcAssistantStreamState();
      stream.start(assistant());
      startTool(stream);
      stream.update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"old":true}' });
      const parse = spyOn(JSON, 'parse');
      try {
        if (source === 'start') stream.start(assistant());
        else if (source === 'clear') stream.clear();
        else if (source === 'resume') stream.resume(assistant(), 'streaming');
        else stream.update({ type: source, contentIndex: 0 });
        expect(stream.flushToolArguments()).toBe(false);
        if (source === 'clear') expect(stream.message).toBeNull();
        else if (source === 'start' || source === 'resume')
          expect(stream.message?.content).toEqual([]);
        else
          expect(stream.message?.content[0]).toMatchObject({
            type:
              source === 'toolcall_start'
                ? 'toolCall'
                : source === 'text_start'
                  ? 'text'
                  : 'thinking',
          });
        expect(stream.snapshotToolArguments()).toEqual(source === 'toolcall_start' ? [[0, '']] : []);
        expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    },
  );

  test('broadcasting delta-only updates never parses arguments, including with a connected observer', () => {
    const broadcaster = new EventBroadcaster(randomUUID());
    const write = mock(() => true);
    broadcaster['connections'].push({ write } as any);
    broadcaster.broadcast({ type: 'message_start', message: assistant() });
    const emit = (delta: any) =>
      broadcaster.broadcast({ type: 'message_update', assistantMessageEvent: delta });
    emit({ type: 'toolcall_start', contentIndex: 0, id: 'call-0', toolName: 'read' });
    const parse = spyOn(JSON, 'parse');
    try {
      for (const delta of ['{"path":"', '中文', '\\n', '😀"}'])
        emit({ type: 'toolcall_delta', contentIndex: 0, delta });
      expect(write).toHaveBeenCalledTimes(6);
      expect(parse).not.toHaveBeenCalled();
      expect(broadcaster['assistantStream'].snapshotToolArguments()).toEqual([
        [0, '{"path":"中文\\n😀"}'],
      ]);
      expect(broadcaster['assistantStream'].message?.content[0]).toMatchObject({
        arguments: { path: '中文\n😀' },
      });
      const parsed = parse.mock.calls.length;
      emit({
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'call-0', name: 'read', arguments: { path: 'final' } },
      });
      expect(broadcaster['assistantStream'].message?.content[0]).toMatchObject({
        arguments: { path: 'final' },
      });
      expect(parse.mock.calls.length).toBe(parsed);
    } finally {
      parse.mockRestore();
    }
  });
});

describe('filesystem error reporting', () => {
  test('explains explicit quota error codes on every platform', () => {
    expect(
      formatAgentError(Object.assign(new Error('write failed'), { code: 'EDQUOT' })),
    ).toContain('Disk quota exceeded (EDQUOT).');
  });

  test.skipIf(os.constants.errno.EDQUOT === undefined)(
    'explains quota errors that Node leaves unnamed',
    () => {
      const error = Object.assign(
        new Error(`Unknown system error -${os.constants.errno.EDQUOT}, write`),
        {
          errno: -os.constants.errno.EDQUOT,
        },
      );
      expect(formatAgentError(error)).toContain('Disk quota exceeded (EDQUOT).');
    },
  );
});

describe('session-scoped identities', () => {
  test('separates parent sessions and formerly colliding task names', () => {
    expect(parentScopeKey('parent-a')).not.toBe(parentScopeKey('parent-b'));
    expect(taskStorageKey('review/api')).not.toBe(taskStorageKey('review__api'));
  });
});

describe('agent templates', () => {
  test('parses optional routing and extension fields', () => {
    const definition = parseAgentDefinitionText(
      `---
name: reviewer
provider: openai-codex
model: gpt-5.6-sol
thinking: high
extensions: @scope/tools, ~/.pi/helper.ts
skills: web-investigate
---
Review the requested files.`,
      'fallback',
    );
    expect(definition).toMatchObject({
      name: 'reviewer',
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      thinking: 'high',
      extensions: ['@scope/tools', '~/.pi/helper.ts'],
      skills: ['web-investigate'],
      prompt: 'Review the requested files.',
    });
  });

  test('trims routing values and treats blank values as omitted', () => {
    expect(
      parseAgentDefinitionText(
        `---
provider: "  openai  "
model: '  accounts/team/model  '
---`,
        'trimmed',
      ),
    ).toMatchObject({ provider: 'openai', model: 'accounts/team/model' });
    expect(
      parseAgentDefinitionText(
        `---
provider: "   "
model: '   '
---`,
        'blank',
      ),
    ).toMatchObject({ provider: undefined, model: undefined });
  });

  test('describes full pairs and model-only routes without advertising provider-only routing', () => {
    const directory = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents');
    const templates = {
      'description-full': 'provider: " template-provider "\nmodel: " template-model "',
      'description-model-only': 'provider: "   "\nmodel: template-model\nthinking: medium',
      'description-provider-only': 'provider: template-provider\nmodel: "   "',
    };
    fs.mkdirSync(directory, { recursive: true });
    try {
      for (const [name, fields] of Object.entries(templates)) {
        fs.writeFileSync(
          path.join(directory, `${name}.md`),
          `---\nname: ${name}\n${fields}\n---\n`,
        );
      }
      const description = getAgentDefinitionsDescription();
      expect(description).toContain(
        '- `description-full` — model: template-provider/template-model',
      );
      expect(description).toContain(
        '- `description-model-only` — model: template-model (inherited provider) — thinking: medium',
      );
      expect(
        description.split('\n').find((line) => line.startsWith('- `description-provider-only`')),
      ).toBe('- `description-provider-only`');
    } finally {
      for (const name of Object.keys(templates))
        fs.rmSync(path.join(directory, `${name}.md`), { force: true });
    }
  });
});

describe('run storage', () => {
  const packageDir = path.join(TEST_AGENT_DIR, 'pi-subagents');
  const configFile = path.join(packageDir, 'config.json');
  const fixtureDir = path.join(TEST_AGENT_DIR, 'retention-fixture');

  test('uses persistent package storage by default', () => {
    fs.rmSync(configFile, { force: true });
    expect(getRunsDir()).toBe(path.join(packageDir, 'runs'));
  });

  test('loads the model response timeout from package configuration', () => {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ modelResponseTimeoutMs: 1234 }));
    expect(loadSubagentConfig().modelResponseTimeoutMs).toBe(1234);
    fs.rmSync(configFile, { force: true });
  });

  test('keeps legacy temporary runs discoverable', () => {
    fs.rmSync(configFile, { force: true });
    const parentSessionId = 'legacy-parent';
    const id = '11111111-1111-4111-8111-111111111111';
    const legacyRoot = path.join(
      process.env.PI_SUBAGENT_TEMP_DIR!,
      'pi-subagents',
      os.userInfo().username,
      'runs',
    );
    const legacyScope = path.join(legacyRoot, parentScopeKey(parentSessionId));
    fs.mkdirSync(legacyScope, { recursive: true });
    fs.writeFileSync(
      path.join(legacyScope, `${id}.info.json`),
      JSON.stringify({
        id,
        taskName: 'legacy',
        status: 'closed',
        finalResponse: 'legacy response',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    expect(getAgent('legacy', parentSessionId)).toMatchObject({
      id,
      status: 'completed',
      finalResponse: 'legacy response',
    });
    fs.rmSync(legacyScope, { recursive: true, force: true });
  });

  test('keeps agent lists in creation order when activity changes', async () => {
    fs.rmSync(configFile, { force: true });
    const parentSessionId = 'creation-order';
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const now = Date.now();
    const agents = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        taskName: 'older',
        createdAt: now - 2000,
        lastActivity: now,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        taskName: 'newer',
        createdAt: now - 1000,
        lastActivity: now - 1000,
      },
    ];
    fs.mkdirSync(scope, { recursive: true });
    for (const agent of agents) {
      fs.writeFileSync(
        path.join(scope, `${agent.id}.info.json`),
        JSON.stringify({
          ...agent,
          canonicalName: `/${agent.taskName}`,
          parentSessionId,
          status: 'completed',
          updatedAt: agent.lastActivity,
        }),
      );
    }

    const manager = new AgentManager();
    try {
      expect(
        manager.listAgents(undefined, parentSessionId).map((agent) => agent.agent_name),
      ).toEqual(['/newer', '/older']);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test('checks directory entries linearly when pruning many runs', async () => {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ storageDir: fixtureDir, retentionDays: 3 }));
    const scope = path.join(fixtureDir, 'b'.repeat(24));
    fs.mkdirSync(scope, { recursive: true });
    const count = 32;
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      fs.writeFileSync(
        path.join(scope, `${id}.info.json`),
        JSON.stringify({ id, status: 'completed', createdAt: Date.now() }),
      );
      fs.writeFileSync(path.join(scope, `${id}.jsonl`), '');
      fs.writeFileSync(path.join(scope, `${id}.log`), '');
    }
    let checked = 0;
    let observed = 0;
    const readdir = fs.readdirSync;
    const scan = spyOn(fs, 'readdirSync').mockImplementation(((directory, options) => {
      const entries = readdir(directory, options);
      if (String(directory) === scope && options?.withFileTypes) {
        for (const entry of entries as fs.Dirent[]) {
          observed++;
          const isFile = entry.isFile.bind(entry);
          entry.isFile = () => {
            checked++;
            return isFile();
          };
        }
      }
      return entries;
    }) as typeof fs.readdirSync);
    let manager: InstanceType<typeof AgentManager> | undefined;
    try {
      manager = new AgentManager();
      await manager.ready();
      expect(observed).toBe(count * 3);
      expect(checked).toBeGreaterThan(0);
      expect(checked).toBeLessThanOrEqual(observed * 4);
    } finally {
      scan.mockRestore();
      await manager?.shutdown();
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(configFile, { force: true });
    }
  });

  test('preserves artifact ownership and recent activity while pruning grouped runs', async () => {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ storageDir: fixtureDir, retentionDays: 3 }));
    const scope = path.join(fixtureDir, 'b'.repeat(24));
    fs.mkdirSync(scope, { recursive: true });
    const now = Date.now();
    const oldTime = new Date(now - 4 * 24 * 60 * 60 * 1000);
    const cases = [
      { id: randomUUID(), keep: false },
      { id: randomUUID(), keep: true, recentFile: '.log' },
      { id: randomUUID(), keep: true, recentFile: '.info.json.123.tmp' },
      { id: randomUUID(), keep: true, recentMetadata: 'lastActivity' },
      { id: randomUUID(), keep: true, recentMetadata: 'updatedAt' },
      { id: randomUUID(), keep: true, recentMetadata: 'createdAt' },
      { id: randomUUID(), keep: false, corrupt: true },
      { id: randomUUID(), keep: true, corrupt: true, recentFile: '.jsonl' },
    ];
    const suffixes = ['.info.json', '.jsonl', '.log', '.info.json.123.tmp'];
    const uppercaseId = 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF';
    const orphanId = randomUUID();
    const preserved = [
      cases[0].id + '.notes',
      cases[0].id + '.info.json.bad.tmp',
      'not-an-agent.info.json',
      orphanId + '.jsonl',
      orphanId + '.log',
      orphanId + '.info.json.123.tmp',
      uppercaseId.toLowerCase() + '.log',
    ];
    const artifactDirectory = path.join(scope, cases[0].id + '.info.json.456.tmp');
    let manager: InstanceType<typeof AgentManager> | undefined;
    try {
      for (const record of cases) {
        for (const suffix of suffixes) {
          const file = path.join(scope, record.id + suffix);
          fs.writeFileSync(
            file,
            suffix !== '.info.json'
              ? 'artifact'
              : record.corrupt
                ? '{'
                : JSON.stringify({
                    id: record.id,
                    status: 'completed',
                    createdAt: oldTime.getTime(),
                    updatedAt: oldTime.getTime(),
                    lastActivity: oldTime.getTime(),
                    ...(record.recentMetadata ? { [record.recentMetadata]: now } : {}),
                  }),
          );
          const modified = suffix === record.recentFile ? new Date(now) : oldTime;
          fs.utimesSync(file, modified, modified);
        }
      }
      for (const [index, name] of preserved.entries()) {
        const file = path.join(scope, name);
        fs.writeFileSync(file, 'keep');
        const modified = index < 2 ? new Date(now) : oldTime;
        fs.utimesSync(file, modified, modified);
      }
      fs.mkdirSync(artifactDirectory);
      const uppercaseInfo = path.join(scope, uppercaseId + '.info.json');
      fs.writeFileSync(uppercaseInfo, JSON.stringify({ status: 'completed' }));
      fs.utimesSync(uppercaseInfo, oldTime, oldTime);
      const lowercaseLog = path.join(scope, uppercaseId.toLowerCase() + '.log');
      fs.utimesSync(lowercaseLog, new Date(now), new Date(now));

      manager = new AgentManager();
      await manager.ready();
      for (const record of cases)
        for (const suffix of suffixes)
          expect(fs.existsSync(path.join(scope, record.id + suffix))).toBe(record.keep);
      for (const name of preserved) expect(fs.existsSync(path.join(scope, name))).toBe(true);
      expect(fs.statSync(artifactDirectory).isDirectory()).toBe(true);
      expect(fs.existsSync(uppercaseInfo)).toBe(false);
    } finally {
      await manager?.shutdown();
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(configFile, { force: true });
    }
  });

  test.each([false, true])(
    'deletes metadata last and retains it on artifact deletion failure (fail=%s)',
    async (fail) => {
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify({ storageDir: fixtureDir, retentionDays: 3 }));
      const scope = path.join(fixtureDir, 'b'.repeat(24));
      fs.mkdirSync(scope, { recursive: true });
      const id = randomUUID();
      const oldTime = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
      const info = path.join(scope, id + '.info.json');
      const artifacts = ['.jsonl', '.log', '.info.json.123.tmp'].map((suffix) =>
        path.join(scope, id + suffix),
      );
      for (const file of [info, ...artifacts]) {
        fs.writeFileSync(file, file === info ? JSON.stringify({ status: 'completed' }) : 'artifact');
        fs.utimesSync(file, oldTime, oldTime);
      }
      const attempts: string[] = [];
      let failedArtifact: string | undefined;
      const remove = fs.rmSync;
      const deletion = spyOn(fs, 'rmSync').mockImplementation((file, options) => {
        if (path.dirname(String(file)) === scope) {
          attempts.push(String(file));
          if (fail && attempts.length === 1) {
            failedArtifact = String(file);
            throw new Error('simulated deletion failure');
          }
        }
        return remove(file, options);
      });
      let manager: InstanceType<typeof AgentManager> | undefined;
      try {
        manager = new AgentManager();
        await manager.ready();
        expect(attempts.filter((file) => file !== info).sort()).toEqual([...artifacts].sort());
        expect(fs.existsSync(info)).toBe(fail);
        for (const file of artifacts) expect(fs.existsSync(file)).toBe(file === failedArtifact);
        if (fail) {
          expect(failedArtifact).toBeDefined();
          expect(attempts).not.toContain(info);
        } else expect(attempts.at(-1)).toBe(info);
      } finally {
        deletion.mockRestore();
        await manager?.shutdown();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
        fs.rmSync(configFile, { force: true });
      }
    },
  );

  test('removes expired runs and outputs using configurable retention', () => {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.writeFileSync(configFile, JSON.stringify({ storageDir: fixtureDir, retentionDays: 3 }));

    const now = Date.now();
    const oldTime = new Date(now - 4 * 24 * 60 * 60 * 1000);
    const scope = path.join(fixtureDir, 'a'.repeat(24));
    const unrelatedScope = path.join(fixtureDir, 'unrelated');
    const outputs = path.join(fixtureDir, '_outputs');
    const expiredId = '11111111-1111-4111-8111-111111111111';
    const activeId = '22222222-2222-4222-8222-222222222222';
    const expiredInfo = path.join(scope, `${expiredId}.info.json`);
    const activeInfo = path.join(scope, `${activeId}.info.json`);
    const expiredOutput = path.join(
      outputs,
      `${oldTime.getTime()}-33333333-3333-4333-8333-333333333333.txt`,
    );
    const activeMarker = path.join(
      process.env.PI_SUBAGENT_TEMP_DIR!,
      'pi-subagents',
      os.userInfo().username,
      'sockets',
      `${activeId}.peek.json`,
    );
    const unrelatedAgentFile = path.join(scope, `${expiredId}.notes`);
    const staleLock = path.join(scope, `.task-${'c'.repeat(24)}.lock`);
    const liveOwnerLock = path.join(scope, `.task-${'d'.repeat(24)}.lock`);

    try {
      fs.mkdirSync(scope, { recursive: true });
      fs.mkdirSync(unrelatedScope, { recursive: true });
      fs.mkdirSync(outputs, { recursive: true });
      fs.mkdirSync(path.dirname(activeMarker), { recursive: true });
      for (const [file, id] of [
        [expiredInfo, expiredId],
        [activeInfo, activeId],
      ]) {
        fs.writeFileSync(
          file,
          JSON.stringify({
            id,
            createdAt: oldTime.getTime(),
            updatedAt: oldTime.getTime(),
            lastActivity: oldTime.getTime(),
          }),
        );
        fs.utimesSync(file, oldTime, oldTime);
      }
      fs.writeFileSync(
        activeMarker,
        JSON.stringify({ pid: process.pid, startedAt: now, token: 'test' }),
      );
      fs.writeFileSync(unrelatedAgentFile, 'keep');
      fs.writeFileSync(staleLock, '');
      fs.writeFileSync(liveOwnerLock, JSON.stringify({ pid: process.pid }));
      fs.utimesSync(staleLock, oldTime, oldTime);
      fs.utimesSync(liveOwnerLock, oldTime, oldTime);
      fs.writeFileSync(expiredOutput, 'old');
      fs.utimesSync(expiredOutput, oldTime, oldTime);
      fs.writeFileSync(path.join(outputs, 'unrelated.txt'), 'keep');
      fs.writeFileSync(path.join(unrelatedScope, 'unrelated.txt'), 'keep');

      new AgentManager();
      expect(fs.existsSync(expiredInfo)).toBe(false);
      expect(fs.existsSync(activeInfo)).toBe(true);
      expect(fs.existsSync(unrelatedAgentFile)).toBe(true);
      expect(fs.existsSync(staleLock)).toBe(false);
      expect(fs.existsSync(liveOwnerLock)).toBe(true);
      expect(fs.existsSync(expiredOutput)).toBe(false);
      expect(fs.existsSync(path.join(outputs, 'unrelated.txt'))).toBe(true);
      expect(fs.existsSync(path.join(unrelatedScope, 'unrelated.txt'))).toBe(true);

      fs.writeFileSync(configFile, JSON.stringify({ storageDir: fixtureDir, retentionDays: 0 }));
      fs.writeFileSync(expiredInfo, '{}');
      fs.utimesSync(expiredInfo, oldTime, oldTime);
      new AgentManager();
      expect(fs.existsSync(expiredInfo)).toBe(true);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(activeMarker, { force: true });
      fs.rmSync(configFile, { force: true });
    }
  });
});

async function readSocketEvents(socketPath: string, count: number): Promise<any[]> {
  return await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const events: any[] = [];
    let buffer = '';
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(events);
    };
    socket.setTimeout(1000, () => finish(new Error('Timed out waiting for subagent events.')));
    socket.on('error', (error) => finish(error));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (events.length < count) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        events.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
      finish();
    });
  });
}

function spawnParams(parentSessionId: string, task_name: string, message: string) {
  return {
    task_name,
    message,
    cwd: TEST_AGENT_DIR,
    parentSessionId,
    inheritedProvider: 'test',
    inheritedModelId: 'fake',
  };
}

const configFile = path.join(TEST_AGENT_DIR, 'pi-subagents', 'config.json');
function writeConfig(config: Record<string, any> = {}) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(
    configFile,
    JSON.stringify({ defaults: { extensions: [CORE_SDK_EXTENSION] }, ...config }),
  );
}
let fixture: CoreFixtureState;
beforeEach(() => {
  fixture = configureCoreFixture();
  writeConfig();
});
async function released(manager: InstanceType<typeof AgentManager>, info: AgentInfo) {
  await waitUntil(() => !manager['live'].has(info.id), 7000);
}
function sessionMessages(info: AgentInfo): any[] {
  if (!fs.existsSync(info.sessionFile)) return [];
  return fs
    .readFileSync(info.sessionFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message);
}
const markerDir = path.join(TEST_AGENT_DIR, 'pi-subagents', os.userInfo().username, 'sockets');
const activeMarker = (id: string) => path.join(markerDir, id + '.active.json');
const peekMarker = (id: string) => path.join(markerDir, id + '.peek.json');

describe('spawn model and thinking resolution', () => {
  test('caller wins, then the template, then the inherited value, then the default', async () => {
    const parentSessionId = 'spawn-overrides';
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
      recursive: true,
      force: true,
    });
    const templateFile = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents', 'routed.md');
    fs.mkdirSync(path.dirname(templateFile), { recursive: true });
    fs.writeFileSync(
      templateFile,
      '---\nname: routed\nprovider: template-provider\nmodel: template-model\nthinking: medium\n---\nRouted template.',
    );
    const modelOnlyFile = path.join(path.dirname(templateFile), 'caller-priority.md');
    fs.writeFileSync(
      modelOnlyFile,
      '---\nname: caller-priority\nmodel: unregistered-template-model\n---\n',
    );
    const manager = new AgentManager();
    const spawn = async (task: string, overrides: Record<string, unknown>) => {
      await manager.spawnAgent({
        ...spawnParams(parentSessionId, task, 'work'),
        inheritedThinking: 'low',
        ...overrides,
      });
      return manager.getAgentInfo(task, parentSessionId);
    };
    const callerModel = { model: { provider: 'openai', modelId: 'gpt-5' } };
    try {
      expect(await spawn('inherited', {})).toMatchObject({ model: 'test:fake', thinking: 'low' });
      expect(await spawn('caller-model', callerModel)).toMatchObject({
        model: 'openai:gpt-5',
        thinking: 'low',
      });
      expect(await spawn('caller-thinking', { thinking: 'max' })).toMatchObject({
        model: 'test:fake',
        thinking: 'max',
      });
      expect(await spawn('template', { agent_type: 'routed' })).toMatchObject({
        model: 'template-provider:template-model',
        thinking: 'medium',
      });
      expect(
        await spawn('caller-beats-template', {
          agent_type: 'routed',
          ...callerModel,
          thinking: 'xhigh',
        }),
      ).toMatchObject({ model: 'openai:gpt-5', thinking: 'xhigh' });
      expect(
        await spawn('caller-beats-model-only', { agent_type: 'caller-priority', ...callerModel }),
      ).toMatchObject({ model: 'openai:gpt-5', thinking: 'low' });
      await manager.spawnAgent(spawnParams(parentSessionId, 'default-thinking', 'work'));
      expect(manager.getAgentInfo('default-thinking', parentSessionId)).toMatchObject({
        model: 'test:fake',
        thinking: 'high',
      });
      await expect(spawn('missing', { agent_type: 'absent' })).rejects.toThrow(
        'Agent template not found',
      );
    } finally {
      await manager.shutdown();
      fs.rmSync(templateFile, { force: true });
      fs.rmSync(modelOnlyFile, { force: true });
    }
  });

  test.each([
    ['model-only', 'model: template-model', 'test', 'template-model'],
    ['blank-provider', 'provider: "   "\nmodel: template-model', 'test', 'template-model'],
    [
      'trimmed-pair',
      'provider: " template-provider "\nmodel: " template-model "',
      'template-provider',
      'template-model',
    ],
    ['provider-only', 'provider: template-provider', 'test', 'fake'],
    ['blank-model', 'provider: template-provider\nmodel: "   "', 'test', 'fake'],
    ['empty-model', 'provider: template-provider\nmodel:', 'test', 'fake'],
    ['blank-both', 'provider: "   "\nmodel: "   "', 'test', 'fake'],
  ])('resolves %s without changing inherited thinking', async (name, fields, provider, modelId) => {
    const parentSessionId = `template-resolution-${name}`;
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const templateFile = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents', `${name}.md`);
    const manager = new AgentManager();
    fs.writeFileSync(templateFile, `---\nname: ${name}\n${fields}\n---\n`);
    try {
      await manager.spawnAgent({
        ...spawnParams(parentSessionId, 'worker', 'hold routing'),
        agent_type: name,
        inheritedThinking: 'xhigh',
      });
      expect(manager.getAgentInfo('worker', parentSessionId)).toMatchObject({
        provider,
        modelId,
        model: `${provider}:${modelId}`,
        thinking: 'xhigh',
      });
    } finally {
      await manager.shutdown();
      fs.rmSync(templateFile, { force: true });
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });
});

describe('SDK model validation', () => {
  test.each([
    ['unknown-provider', 'fake'],
    ['test', 'not-registered'],
    ['test', 'Fake'],
    ['openai', 'gpt'],
    ['openai', 'custom/unregistered'],
  ])(
    'rejects unavailable exact route %s/%s before submitting a prompt',
    async (provider, modelId) => {
      const parent = 'unavailable-' + randomUUID();
      const completions: any[] = [];
      const manager = new AgentManager({
        onUnclaimedCompletion: (event) => completions.push(event),
      });
      try {
        await expect(
          manager.spawnAgent({
            ...spawnParams(parent, 'worker', 'must not run'),
            model: { provider, modelId },
          }),
        ).rejects.toThrow(provider + '/' + modelId);
        const info = manager.getAgentInfo('worker', parent);
        expect(info).toMatchObject({ provider, modelId, status: 'failed', messageCount: 0 });
        expect(info.finalResponse).toBeUndefined();
        await released(manager, info);
        expect(fixture.instances.flatMap((instance) => instance.inputs)).toEqual([]);
        expect(sessionMessages(info)).toEqual([]);
        expect(completions).toEqual([
          expect.objectContaining({ status: 'failed', error: info.error }),
        ]);
        expect((await manager.waitAgent(parent, ['worker'])).event?.id).toBe(completions[0].id);
        expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      } finally {
        await manager.shutdown();
      }
    },
  );

  test('an explicit extension load error fails startup without falling back to another model', async () => {
    const parent = 'bad-extension-' + randomUUID();
    const extension = path.join(TEST_AGENT_DIR, 'bad-extension.ts');
    fs.writeFileSync(
      extension,
      'export default () => { throw new Error("explicit fixture load failure"); };',
    );
    writeConfig({ defaults: { extensions: [CORE_SDK_EXTENSION, extension] } });
    const manager = new AgentManager();
    try {
      await expect(
        manager.spawnAgent(spawnParams(parent, 'worker', 'must not run')),
      ).rejects.toThrow('explicit fixture load failure');
      const info = manager.getAgentInfo('worker', parent);
      expect(info.status).toBe('failed');
      expect(sessionMessages(info)).toEqual([]);
      await released(manager, info);
    } finally {
      await manager.shutdown();
      fs.rmSync(extension, { force: true });
    }
  });

  test('accepts a slash-containing model ID and retains the saved route/resources when templates change', async () => {
    const parent = 'saved-route-' + randomUUID();
    const template = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents', 'saved-route.md');
    const id = 'accounts/fireworks/models/glm-5p2';
    fs.writeFileSync(
      template,
      '---\nname: saved-route\nprovider: fireworks\nmodel: ' + id + '\n---\nTemplate instructions.',
    );
    const manager = new AgentManager();
    try {
      await manager.spawnAgent({
        ...spawnParams(parent, 'worker', 'first'),
        agent_type: 'saved-route',
      });
      const first = manager.getAgentInfo('worker', parent);
      await released(manager, first);
      fs.writeFileSync(
        template,
        '---\nname: saved-route\nprovider: openai\nmodel: gpt-5\n---\nChanged template.',
      );
      expect(await manager.sendMessage(parent, 'worker', 'second')).toEqual({ delivery: 'prompt' });
      await released(manager, first);
      const info = manager.getAgentInfo('worker', parent);
      expect(info).toMatchObject({ provider: 'fireworks', modelId: id, messageCount: 2 });
      expect(fixture.instances).toHaveLength(2);
      expect(fixture.instances[0].requests[0].text).toBe('Template instructions.\n\nfirst');
      expect(fixture.instances[1].requests[0].text).toBe('second');
      expect(info.extensionPaths).toEqual([CORE_SDK_EXTENSION]);
      fixture = configureCoreFixture({ routes: [['test', 'fake']] });
      await expect(manager.sendMessage(parent, 'worker', 'must not run')).rejects.toThrow(
        'fireworks/' + id,
      );
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        status: 'failed',
        messageCount: 2,
        provider: 'fireworks',
        modelId: id,
      });
      expect(fixture.instances.flatMap((instance) => instance.requests)).toEqual([]);
    } finally {
      await manager.shutdown();
      fs.rmSync(template, { force: true });
    }
  });

  test.each(['failed', 'interrupted'] as const)(
    'records distinct startup failures after a previous %s run',
    async (prior) => {
      const parent = 'retry-' + randomUUID();
      const completions: any[] = [];
      const manager = new AgentManager({
        onUnclaimedCompletion: (event) => completions.push(event),
      });
      try {
        await manager.spawnAgent(
          spawnParams(parent, 'worker', prior === 'failed' ? 'fail old' : 'hold old'),
        );
        if (prior === 'interrupted') await manager.interruptAgent(parent, 'worker');
        const initial = manager.getAgentInfo('worker', parent);
        await released(manager, initial);
        expect(manager.getAgentInfo('worker', parent).status).toBe(prior);
        fixture = configureCoreFixture({ routes: [['test', 'other']] });
        let previousId = manager['mailbox'].at(-1)!.id;
        for (let attempt = 0; attempt < 2; attempt++) {
          const before = completions.length;
          await expect(manager.sendMessage(parent, 'worker', 'must not run')).rejects.toThrow(
            'test/fake',
          );
          const info = manager.getAgentInfo('worker', parent);
          await released(manager, info);
          expect(info).toMatchObject({ status: 'failed', messageCount: 1 });
          expect(info.finalResponse).toBeUndefined();
          expect(completions.slice(before)).toEqual([
            expect.objectContaining({ status: 'failed', error: info.error }),
          ]);
          expect(completions.at(-1).id).not.toBe(previousId);
          previousId = completions.at(-1).id;
          expect((await manager.waitAgent(parent, ['worker'])).event?.id).toBe(previousId);
        }
        expect(fixture.instances.flatMap((instance) => instance.inputs)).toEqual([]);
      } finally {
        await manager.shutdown();
      }
    },
  );
});

describe('SDK lifecycle and cancellation races', () => {
  test('spawn returns on native acceptance, then releases and reopens the same native history', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'lifecycle-' + randomUUID();
    const manager = new AgentManager();
    try {
      expect(await manager.spawnAgent(spawnParams(parent, 'worker', 'hold first'))).toEqual({
        task_name: '/worker',
        nickname: null,
      });
      const info = manager.getAgentInfo('worker', parent);
      expect(info.status).toBe('running');
      const firstSession = manager['live'].get(info.id)!.session!;
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      gate.resolve();
      await released(manager, info);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:hold first');
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(await manager.sendMessage(parent, 'worker', 'second')).toEqual({ delivery: 'prompt' });
      const secondSession = manager['live'].get(info.id)?.session;
      if (secondSession) expect(secondSession).not.toBe(firstSession);
      await released(manager, info);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:second');
      expect(
        sessionMessages(info)
          .filter((entry) => entry.role !== 'system')
          .map((entry) => entry.role),
      ).toEqual(['user', 'assistant', 'user', 'assistant']);
      const reopened = codingAgent.SessionManager.open(
        info.sessionFile,
        path.dirname(info.sessionFile),
        info.cwd,
      );
      expect(
        reopened.buildSessionContext().messages.filter((message) => message.role !== 'system'),
      ).toHaveLength(4);
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([1, 1]);
      expect(
        fixture.instances[1].requests[0].context.messages
          .filter((entry: any) => entry.role !== 'system')
          .map((entry: any) => entry.role),
      ).toEqual(['user', 'assistant', 'user']);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      expect(fs.existsSync(peekMarker(info.id))).toBe(false);
      if (process.platform !== 'win32') expect(fs.existsSync(getSocketPath(info.id))).toBe(false);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('steers a running native session without opening a second session', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'steer-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold initial'));
      expect(await manager.sendMessage(parent, 'worker', 'next instruction')).toEqual({
        delivery: 'steer',
      });
      expect(fixture.instances).toHaveLength(1);
      gate.resolve();
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe(
        'response:next instruction',
      );
      expect(info.sessionFile).toBe(manager.getAgentInfo('worker', parent).sessionFile);
      expect(fixture.instances[0].inputs.map((event) => event.source)).toEqual(['rpc', 'rpc']);
      expect(completions).toHaveLength(1);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test.each(['fail', 'aborted'])(
    'treats normal prompt resolution with %s stopReason as a non-success',
    async (command) => {
      const parent = 'stop-reason-' + randomUUID();
      const completions: any[] = [];
      const manager = new AgentManager({
        onUnclaimedCompletion: (event) => completions.push(event),
      });
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', command + ' now'));
        const info = manager.getAgentInfo('worker', parent);
        await released(manager, info);
        expect(manager.getAgentInfo('worker', parent).status).toBe('failed');
        expect(manager.readAgentResponse('worker', parent).error).toContain(
          command === 'fail' ? 'fixture failure' : 'aborted',
        );
        expect(completions).toHaveLength(1);
        expect(fixture.instances[0].shutdowns).toBe(1);
      } finally {
        await manager.shutdown();
      }
    },
  );

  test("handled input ends with this run's empty response, never the previous answer", async () => {
    const parent = 'handled-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:first');
      await manager.sendMessage(parent, 'worker', 'handled empty');
      await released(manager, info);
      const after = manager.getAgentInfo('worker', parent);
      expect(after.status).toBe('completed');
      expect(after.finalResponse ?? '').toBe('');
      expect(after.messageCount).toBe(2);
      expect(fixture.instances[1].requests).toEqual([]);
      expect(completions).toHaveLength(2);
      expect(completions[1].finalResponse ?? '').toBe('');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(manager.getAgentInfo('worker', parent).status).toBe('completed');
    } finally {
      await manager.shutdown();
    }
  });

  test('handled input that starts native work is not finalized or disposed before native idle', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'handled-work-' + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'handled work'));
      const info = manager.getAgentInfo('worker', parent);
      expect(manager['live'].has(info.id)).toBe(true);
      expect(fixture.instances[0].activeStreams).toBe(1);
      expect(fixture.instances[0].shutdowns).toBe(0);
      expect(info.status).toBe('running');
      gate.resolve();
      await released(manager, info);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe(
        'response:hold handled-owned-work',
      );
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test.each(['initialization', 'input'])(
    'interrupt tracks late %s until it exits, without rollback or duplicate completion',
    async (phase) => {
      const gate = deferred();
      fixture = configureCoreFixture(
        phase === 'initialization'
          ? { startupGate: gate.promise }
          : {
              input: async () => {
                await gate.promise;
              },
            },
      );
      const parent = 'cancel-' + phase + '-' + randomUUID();
      const completions: any[] = [];
      const manager = new AgentManager({
        onUnclaimedCompletion: (event) => completions.push(event),
      });
      const pending = manager.spawnAgent(spawnParams(parent, 'worker', 'hold late')).then(
        () => undefined,
        (error) => error,
      );
      try {
        await waitUntil(() =>
          phase === 'initialization'
            ? fixture.instances[0]?.events.includes('session_start')
            : Boolean(fixture.instances[0]?.inputs.length),
        );
        const info = manager.getAgentInfo('worker', parent);
        const interruption = manager.interruptAgent(parent, 'worker');
        await waitUntil(() => manager.getAgentInfo('worker', parent).status === 'interrupted');
        expect(manager['live'].has(info.id)).toBe(true);
        expect(fixture.instances[0].shutdowns).toBe(0);
        gate.resolve();
        await interruption;
        expect(await pending).toBeInstanceOf(Error);
        await released(manager, info);
        expect(manager.getAgentInfo('worker', parent).status).toBe('interrupted');
        expect(completions).toEqual([]);
        expect((await manager.waitAgent(parent, ['worker'])).event?.status).toBe('interrupted');
        expect(manager['mailbox'].filter((event) => event.parentSessionId === parent)).toEqual([]);
        expect(fixture.instances[0].shutdowns).toBe(1);
        expect(fixture.instances[0].activeStreams).toBe(0);
        if (phase === 'initialization') expect(fixture.instances[0].inputs).toEqual([]);
      } finally {
        gate.resolve();
        await pending;
        await manager.shutdown();
      }
    },
  );

  test.each(['initialization', 'input'])(
    'startup timeout follows late %s to actual release',
    async (phase) => {
      const gate = deferred();
      fixture = configureCoreFixture(
        phase === 'initialization'
          ? { startupGate: gate.promise }
          : {
              input: async () => {
                await gate.promise;
              },
            },
      );
      const original = globalThis.setTimeout;
      const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: any,
        delay: number,
        ...args: any[]
      ) => original(callback, delay === 15000 ? 300 : delay, ...args)) as typeof setTimeout);
      const parent = 'startup-timeout-' + phase + '-' + randomUUID();
      const completions: any[] = [];
      const manager = new AgentManager({
        onUnclaimedCompletion: (event) => completions.push(event),
        onError() {},
      });
      const pending = manager.spawnAgent(spawnParams(parent, 'worker', 'hold late')).then(
        () => undefined,
        (error) => error,
      );
      try {
        const error = await pending;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(/timed out|timeout/i);
        const info = manager.getAgentInfo('worker', parent);
        expect(info.status).toBe('failed');
        expect(manager['live'].has(info.id)).toBe(true);
        expect(fixture.instances[0].shutdowns).toBe(0);
        gate.resolve();
        await released(manager, info);
        expect(completions).toHaveLength(1);
        expect(manager.getAgentInfo('worker', parent).status).toBe('failed');
        expect(fixture.instances[0].shutdowns).toBe(1);
        expect(fixture.instances[0].activeStreams).toBe(0);
      } finally {
        timers.mockRestore();
        gate.resolve();
        await pending;
        await manager.shutdown();
      }
    },
  );

  test('non-cooperative cancellation returns finitely and blocks reopening until actual release', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise, ignoreAbort: true });
    const parent = 'non-cooperative-' + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold uncooperative'));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo('worker', parent);
      const started = Date.now();
      await expect(manager.interruptAgent(parent, 'worker')).rejects.toThrow(
        /timed out|cleanup|closing/i,
      );
      expect(Date.now() - started).toBeLessThan(4000);
      expect(manager.getAgentInfo('worker', parent).status).toBe('interrupted');
      expect(manager['live'].has(info.id)).toBe(true);
      expect(fs.existsSync(activeMarker(info.id))).toBe(true);
      await expect(manager.sendMessage(parent, 'worker', 'must not reopen')).rejects.toThrow(
        /timed out|cleanup|closing/i,
      );
      expect(fixture.instances).toHaveLength(1);
      expect(fixture.instances[0].shutdowns).toBe(0);
      gate.resolve();
      await released(manager, info);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      await manager.sendMessage(parent, 'worker', 'recovered');
      await released(manager, info);
      expect(fixture.instances).toHaveLength(2);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:recovered');
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('publishes completion before extension shutdown, but closing cannot reopen the JSONL', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ shutdownGate: gate.promise });
    const parent = 'shutdown-gate-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({
      onUnclaimedCompletion: (event) => completions.push(event),
      onError() {},
    });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      await waitUntil(() => fixture.instances[0].shutdowns === 1);
      const info = manager.getAgentInfo('worker', parent);
      expect(info.status).toBe('completed');
      expect(completions).toHaveLength(1);
      expect(manager['live'].has(info.id)).toBe(true);
      await expect(manager.sendMessage(parent, 'worker', 'must not reopen')).rejects.toThrow(
        /timed out|cleanup|closing/i,
      );
      expect(fixture.instances).toHaveLength(1);
      gate.resolve();
      await released(manager, info);
      await manager.sendMessage(parent, 'worker', 'second');
      await released(manager, info);
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([1, 1]);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('a late steer cannot claim queued success or dispose the session before its input exits', async () => {
    const response = deferred();
    const input = deferred();
    fixture = configureCoreFixture({
      responseGate: response.promise,
      input: async (event) => {
        if (event.streamingBehavior === 'steer') await input.promise;
      },
    });
    const parent = 'late-steer-' + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold initial'));
      const info = manager.getAgentInfo('worker', parent);
      const pending = manager.sendMessage(parent, 'worker', 'late steer').then(
        () => undefined,
        (error) => error,
      );
      await waitUntil(() => fixture.instances[0].inputs.length === 2);
      response.resolve();
      await waitUntil(() => manager.getAgentInfo('worker', parent).status === 'completed');
      expect(manager['live'].has(info.id)).toBe(true);
      expect(fixture.instances[0].shutdowns).toBe(0);
      input.resolve();
      expect(await pending).toBeInstanceOf(Error);
      await released(manager, info);
      expect(fixture.instances[0].requests).toHaveLength(1);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe(
        'response:hold initial',
      );
    } finally {
      response.resolve();
      input.resolve();
      await manager.shutdown();
    }
  });

  test.each([false, true])(
    'steer timeout cancels the run and owns late input until cleanup (ignoreAbort=%s)',
    async (ignoreAbort) => {
      const response = deferred();
      const input = deferred();
      fixture = configureCoreFixture({
        responseGate: response.promise,
        ignoreAbort,
        input: async (event) => {
          if (event.streamingBehavior === 'steer') await input.promise;
        },
      });
      const parent = 'steer-timeout-' + randomUUID();
      const completions: any[] = [];
      const manager = new AgentManager({
        onUnclaimedCompletion: (event) => completions.push(event),
        onError() {},
      });
      let timers: ReturnType<typeof spyOn> | undefined;
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', 'hold initial'));
        await waitUntil(() => fixture.instances[0].activeStreams === 1);
        const info = manager.getAgentInfo('worker', parent);
        const live = manager['live'].get(info.id)!;
        const original = globalThis.setTimeout;
        timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
          callback: any,
          delay: number,
          ...args: any[]
        ) =>
          original(
            callback,
            delay === 15000 || delay === 2000 ? 100 : delay,
            ...args,
          )) as typeof setTimeout);
        await expect(
          manager.sendMessage(parent, 'worker', 'must not execute late'),
        ).rejects.toThrow(/steering acceptance/);
        expect(live.closing).toBe(true);
        expect(live.cancellation.signal.aborted).toBe(true);
        expect(live.pendingSteers.size).toBe(1);
        expect(manager.getAgentInfo('worker', parent).status).toBe('failed');
        expect(completions).toHaveLength(1);
        expect(completions[0].error).toMatch(/steering acceptance/);
        expect(fs.existsSync(activeMarker(info.id))).toBe(true);
        expect(fixture.instances[0].shutdowns).toBe(0);
        await expect(manager.sendMessage(parent, 'worker', 'must not reopen')).rejects.toThrow(
          /closing/,
        );
        expect(fixture.instances).toHaveLength(1);
        // Even after input returns, non-cooperative model work still owns the file.
        input.resolve();
        await waitUntil(() => live.pendingSteers.size === 0);
        if (ignoreAbort) {
          expect(manager['live'].get(info.id)).toBe(live);
          expect(fixture.instances[0].shutdowns).toBe(0);
        }
        response.resolve();
        await released(manager, info);
        expect(fixture.instances[0].requests.map((request) => request.text)).toEqual([
          'hold initial',
        ]);
        expect(fixture.instances[0].shutdowns).toBe(1);
        expect(completions).toHaveLength(1);
        expect(manager.getAgentInfo('worker', parent).status).toBe('failed');
        expect(fs.existsSync(activeMarker(info.id))).toBe(false);
        expect(
          sessionMessages(info).some((message) =>
            JSON.stringify(message).includes('must not execute late'),
          ),
        ).toBe(false);
        timers.mockRestore();
        await manager.sendMessage(parent, 'worker', 'clean recovery');
        await released(manager, info);
        expect(manager.getAgentInfo('worker', parent).sessionFile).toBe(info.sessionFile);
        expect(manager.readAgentResponse('worker', parent).finalResponse).toBe(
          'response:clean recovery',
        );
        expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([1, 1]);
      } finally {
        timers?.mockRestore();
        input.resolve();
        response.resolve();
        await manager.shutdown();
      }
    },
  );

  test('ordinary steer rejection preserves the active run, even with timeout-like error text', async () => {
    const response = deferred();
    fixture = configureCoreFixture({ responseGate: response.promise });
    const parent = 'steer-rejection-' + randomUUID();
    const manager = new AgentManager();
    let steer: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold original'));
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      const rejection = new Error('Timed out waiting for agent /worker steering acceptance.');
      steer = spyOn(live.session!, 'steer').mockRejectedValue(rejection);
      await expect(manager.sendMessage(parent, 'worker', 'rejected input')).rejects.toBe(rejection);
      expect(live.cancellation.signal.aborted).toBe(false);
      expect(live.closing).toBe(false);
      expect(live.pendingSteers.size).toBe(0);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        status: 'running',
        lastTaskMessage: 'hold original',
      });
      steer.mockRestore();
      response.resolve();
      await released(manager, info);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe(
        'response:hold original',
      );
    } finally {
      steer?.mockRestore();
      response.resolve();
      await manager.shutdown();
    }
  });

  test.each(['completed', 'interrupted'])(
    'a later steer timeout cannot replace an already %s run',
    async (status) => {
      const response = deferred();
      const input = deferred();
      fixture = configureCoreFixture({
        responseGate: response.promise,
        input: async (event) => {
          if (event.streamingBehavior === 'steer') await input.promise;
        },
      });
      const parent = 'steer-finalized-' + status + '-' + randomUUID();
      const manager = new AgentManager({ onError() {} });
      let timers: ReturnType<typeof spyOn> | undefined;
      let interruption: Promise<unknown> | undefined;
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', 'hold original'));
        const info = manager.getAgentInfo('worker', parent);
        const original = globalThis.setTimeout;
        timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
          callback: any,
          delay: number,
          ...args: any[]
        ) => original(callback, delay === 15000 ? 150 : delay, ...args)) as typeof setTimeout);
        const pending = manager.sendMessage(parent, 'worker', 'late input').catch((error) => error);
        await waitUntil(() => fixture.instances[0].inputs.length === 2);
        if (status === 'completed') response.resolve();
        else interruption = manager.interruptAgent(parent, 'worker');
        await waitUntil(() => manager.getAgentInfo('worker', parent).status === status);
        expect((await pending).message).toMatch(/steering acceptance/);
        expect(manager.getAgentInfo('worker', parent).status).toBe(status);
        input.resolve();
        response.resolve();
        await interruption;
        await released(manager, info);
        expect(manager.getAgentInfo('worker', parent).status).toBe(status);
        expect(fixture.instances[0].requests).toHaveLength(1);
        expect(fixture.instances[0].shutdowns).toBe(1);
      } finally {
        timers?.mockRestore();
        input.resolve();
        response.resolve();
        await interruption;
        await manager.shutdown();
      }
    },
  );

  test.each(['startup', 'input'])(
    'ctx.shutdown during %s cancels the child without stopping its parent',
    async (phase) => {
      fixture = configureCoreFixture({ shutdownAtStart: phase === 'startup' });
      const parent = 'extension-shutdown-' + phase + '-' + randomUUID();
      const manager = new AgentManager();
      try {
        await manager
          .spawnAgent(
            spawnParams(parent, 'worker', phase === 'input' ? 'shutdown input' : 'must not run'),
          )
          .catch(() => {});
        const info = manager.getAgentInfo('worker', parent);
        await released(manager, info);
        expect(manager.getAgentInfo('worker', parent).status).toBe('interrupted');
        expect(fixture.instances[0].requests).toEqual([]);
        expect(fixture.instances[0].shutdowns).toBe(1);
        fixture = configureCoreFixture();
        await manager.spawnAgent(spawnParams(parent, 'sibling', 'parent still alive'));
        await released(manager, manager.getAgentInfo('sibling', parent));
        expect(manager.readAgentResponse('sibling', parent).status).toBe('completed');
      } finally {
        await manager.shutdown();
      }
    },
  );

  test('shutdown takes ownership of pending initialization and refuses all new submissions', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ startupGate: gate.promise });
    const parent = 'manager-shutdown-' + randomUUID();
    const manager = new AgentManager();
    const pending = manager.spawnAgent(spawnParams(parent, 'worker', 'must not run')).then(
      () => undefined,
      (error) => error,
    );
    try {
      await waitUntil(() => fixture.instances[0]?.events.includes('session_start'));
      const shutdown = manager.shutdown();
      await expect(manager.spawnAgent(spawnParams(parent, 'new', 'must not run'))).rejects.toThrow(
        /abort|shut/i,
      );
      await expect(manager.sendMessage(parent, 'worker', 'must not run')).rejects.toThrow(
        /abort|shut/i,
      );
      gate.resolve();
      await shutdown;
      expect(await pending).toBeInstanceOf(Error);
      expect(fixture.instances[0].inputs).toEqual([]);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(manager['live'].size).toBe(0);
      await expect(
        manager.spawnAgent(spawnParams(parent, 'after', 'must not run')),
      ).rejects.toThrow(/abort|shut/i);
    } finally {
      gate.resolve();
      await pending;
      await manager.shutdown();
    }
  });

  test('rejects concurrent resumes while one initialization is pending', async () => {
    const parent = 'concurrent-resume-' + randomUUID();
    const manager = new AgentManager();
    const gate = deferred();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      fixture = configureCoreFixture({ startupGate: gate.promise });
      const first = manager.sendMessage(parent, 'worker', 'hold resume');
      await waitUntil(() => fixture.instances[0]?.events.includes('session_start'));
      await expect(manager.sendMessage(parent, 'worker', 'duplicate')).rejects.toThrow(
        /starting|startup/i,
      );
      gate.resolve();
      expect(await first).toEqual({ delivery: 'prompt' });
      expect(fixture.instances).toHaveLength(1);
      expect(manager.getAgentInfo('worker', parent).messageCount).toBe(2);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('a model-response deadline does not cover tool execution', async () => {
    const parent = 'tool-deadline-' + randomUUID();
    const manager = new AgentManager({ modelResponseTimeoutMs: 50 });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'tool hold'));
      await waitUntil(() => fixture.instances[0]?.activeTools === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(manager.getAgentInfo('worker', parent).status).toBe('running');
      await manager.interruptAgent(parent, 'worker');
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      expect(fixture.instances[0].activeTools).toBe(0);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally {
      await manager.shutdown();
    }
  });

  test('times out an endlessly streaming assistant response and releases its native resources', async () => {
    const parent = 'response-deadline-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({
      modelResponseTimeoutMs: 80,
      onUnclaimedCompletion: (event) => completions.push(event),
    });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'stream forever'));
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      expect(manager.readAgentResponse('worker', parent).error).toContain(
        'Model response exceeded 80 ms',
      );
      expect(manager.getAgentInfo('worker', parent).status).toBe('failed');
      expect(completions).toHaveLength(1);
      expect(fixture.instances[0].activeStreams).toBe(0);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally {
      await manager.shutdown();
    }
  });

  test("stream observation is delta-only and cannot mutate the SDK's assistant message", async () => {
    const parent = 'delta-observer-' + randomUUID();
    const manager = new AgentManager({ modelResponseTimeoutMs: 2000 });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'stream forever'));
      const info = manager.getAgentInfo('worker', parent);
      const [sync, update] = await readSocketEvents(getSocketPath(info.id), 2);
      expect(sync.status).toBe('calling');
      expect(sync.partialMessage.content[0]).toMatchObject({
        type: 'toolCall',
        id: 'stream-call',
        name: 'fixture_hold',
      });
      expect(update.type).toBe('message_update');
      expect(update.message).toBeUndefined();
      expect(update.assistantMessageEvent.partial).toBeUndefined();
      expect(fixture.instances[0].requests[0].message.content).toEqual([
        { type: 'toolCall', id: 'stream-call', name: 'fixture_hold', arguments: {} },
      ]);
    } finally {
      await manager.shutdown();
    }
  });

  test('observer exceptions stay outside native persistence and cannot skip cleanup', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'observer-failure-' + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold response'));
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      const broadcast = live.broadcaster.broadcast.bind(live.broadcaster);
      live.broadcaster.broadcast = (event: any) => {
        if (event.type === 'message_end' && event.message.role === 'assistant')
          throw new Error('observer fixture failure');
        broadcast(event);
      };
      gate.resolve();
      await released(manager, info);
      expect(sessionMessages(info).filter((message) => message.role === 'assistant')).toHaveLength(
        1,
      );
      expect(errors.some((error) => error.message.includes('observer fixture failure'))).toBe(true);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('repeated runs leave no sessions, timers, sockets or extension work active', async () => {
    const parent = 'resource-cycles-' + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'cycle zero'));
      const info = manager.getAgentInfo('worker', parent);
      for (let cycle = 0; cycle < 10; cycle++) {
        if (cycle) await manager.sendMessage(parent, 'worker', 'cycle ' + cycle);
        const live = manager['live'].get(info.id);
        await released(manager, info);
        expect(manager['live'].size).toBe(0);
        expect(live?.modelResponseTimer).toBeUndefined();
        expect(live?.broadcaster['server']).toBeNull();
        expect(live?.broadcaster['connections']).toEqual([]);
        expect(live?.logger['stream']).toBeNull();
        expect(fs.existsSync(activeMarker(info.id))).toBe(false);
        if (process.platform !== 'win32') expect(fs.existsSync(getSocketPath(info.id))).toBe(false);
        expect(fs.existsSync(peekMarker(info.id))).toBe(false);
      }
      expect(fixture.instances).toHaveLength(10);
      expect(
        fixture.instances.map((instance) => [
          instance.shutdowns,
          instance.activeStreams,
          instance.activeTools,
        ]),
      ).toEqual(Array.from({ length: 10 }, () => [1, 0, 0]));
      expect(sessionMessages(info).filter((message) => message.role === 'user')).toHaveLength(10);
      expect(sessionMessages(info).filter((message) => message.role === 'assistant')).toHaveLength(
        10,
      );
    } finally {
      await manager.shutdown();
    }
  });
});

describe('startup storage failures', () => {
  test('records startup failure causes instead of leaving agents starting', async () => {
    const parentSessionId = 'lifecycle-startup-failure';
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const socketDir = path.join(TEST_AGENT_DIR, 'pi-subagents', os.userInfo().username, 'sockets');
    fs.rmSync(scope, { recursive: true, force: true });
    const manager = new AgentManager();
    await manager.ready();
    fs.rmSync(socketDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(socketDir), { recursive: true });
    fs.writeFileSync(socketDir, 'block startup marker creation');
    try {
      let returnedError = '';
      try {
        await manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first'));
      } catch (error) {
        returnedError = error instanceof Error ? error.message : String(error);
      }
      expect(returnedError).toContain('EEXIST');
      const failed = manager.getAgentInfo('worker', parentSessionId);
      expect(failed.status).toBe('failed');
      expect(failed.error).toBe(returnedError);
      expect(manager['live'].has(failed.id)).toBe(false);
      expect((await manager.waitAllAgents(parentSessionId, ['worker'])).responses).toEqual([
        expect.objectContaining({ agent_name: '/worker', status: 'failed', error: failed.error }),
      ]);

      fs.rmSync(socketDir, { force: true });
      fs.mkdirSync(socketDir, { recursive: true });
      expect(await manager.sendMessage(parentSessionId, 'worker', 'retry')).toEqual({
        delivery: 'prompt',
      });
      await waitUntil(() => manager.getAgentInfo('worker', parentSessionId).status === 'completed');
    } finally {
      fs.rmSync(socketDir, { recursive: true, force: true });
      fs.mkdirSync(socketDir, { recursive: true });
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test('reconciles persisted startup records that never acquired a child', async () => {
    const parentSessionId = 'lifecycle-reconcile-no-child';
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const id = '33333333-3333-4333-8333-333333333333';
    const infoFile = path.join(scope, `${id}.info.json`);
    fs.rmSync(scope, { recursive: true, force: true });
    fs.mkdirSync(scope, { recursive: true });
    fs.writeFileSync(
      infoFile,
      JSON.stringify({
        id,
        taskName: 'orphan',
        canonicalName: '/orphan',
        parentSessionId,
        provider: 'test',
        modelId: 'fake',
        model: 'test:fake',
        cwd: TEST_AGENT_DIR,
        sessionFile: path.join(scope, `${id}.jsonl`),
        infoFile,
        logFile: path.join(scope, `${id}.log`),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastActivity: Date.now(),
        messageCount: 0,
        status: 'starting',
      }),
    );
    const manager = new AgentManager();
    try {
      await manager.ready();
      expect(manager.getAgentInfo('orphan', parentSessionId)).toMatchObject({
        status: 'interrupted',
        messageCount: 0,
      });
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test("rejects an empty configured system prompt instead of falling back to Pi's default", async () => {
    const parentSessionId = 'empty-system-prompt';
    const systemPromptFile = path.join(TEST_AGENT_DIR, 'pi-subagents', 'SYSTEM.md');
    fs.mkdirSync(path.dirname(systemPromptFile), { recursive: true });
    fs.writeFileSync(systemPromptFile, '\n');
    const manager = new AgentManager();
    try {
      await expect(
        manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first')),
      ).rejects.toThrow('Subagent system prompt is empty');
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
        recursive: true,
        force: true,
      });
      fs.rmSync(systemPromptFile, { force: true });
    }
  });
});

describe('completion delivery', () => {
  test('publishes unclaimed successful and failed completions', async () => {
    const parentSessionId = 'completion-callbacks';
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = new AgentManager({
      onUnclaimedCompletion: (event: any) => completions.push(event),
    });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'settled', 'first'));
      await waitUntil(() => completions.some((event) => event.agentName === '/settled'));
      expect(completions.filter((event) => event.agentName === '/settled')).toHaveLength(1);
      expect(completions.find((event) => event.agentName === '/settled')).toMatchObject({
        status: 'completed',
        finalResponse: 'response:first',
      });

      await manager.spawnAgent(spawnParams(parentSessionId, 'crashed', 'crash now'));
      await waitUntil(() => completions.some((event) => event.agentName === '/crashed'));
      expect(completions.filter((event) => event.agentName === '/crashed')).toHaveLength(1);
      expect(completions.find((event) => event.agentName === '/crashed')).toMatchObject({
        status: 'failed',
      });
      expect(completions.find((event) => event.agentName === '/crashed').error).toContain(
        'fixture failure',
      );
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test('suppresses automatic delivery while wait tools claim completions', async () => {
    const parentSessionId = 'completion-waits';
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = new AgentManager({
      onUnclaimedCompletion: (event: any) => completions.push(event),
    });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'one', 'first'));
      const waited = await manager.waitAgent(parentSessionId, ['one']);
      expect(waited.event).toMatchObject({ agentName: '/one', status: 'completed' });
      expect(completions).toEqual([]);

      await manager.spawnAgent(spawnParams(parentSessionId, 'two', 'second'));
      const all = await manager.waitAllAgents(parentSessionId, ['two']);
      expect(all.responses).toEqual([
        expect.objectContaining({ agent_name: '/two', status: 'completed' }),
      ]);
      expect(completions).toEqual([]);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test('releases suppressed completions when wait_all_agents is cancelled', async () => {
    const parentSessionId = 'completion-wait-cancel';
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = new AgentManager({
      onUnclaimedCompletion: (event: any) => completions.push(event),
    });
    const controller = new AbortController();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'slow', 'hold slow'));
      await manager.spawnAgent(spawnParams(parentSessionId, 'fast', 'fast'));
      const wait = manager.waitAllAgents(parentSessionId, ['slow', 'fast'], controller.signal);
      await waitUntil(() => manager.getAgentInfo('fast', parentSessionId).status === 'completed');
      expect(completions).toEqual([]);
      controller.abort(new Error('cancelled'));
      await expect(wait).rejects.toThrow('aborted');
      await waitUntil(() => completions.some((event) => event.agentName === '/fast'));
      expect(completions.filter((event) => event.agentName === '/fast')).toHaveLength(1);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test('reports active and inactive lifecycle transitions', async () => {
    const parentSessionId = 'status-transitions';
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const activity: boolean[] = [];
    const manager = new AgentManager({
      onActivityChange: (event: any) => {
        if (event.parentSessionId === parentSessionId) activity.push(event.active);
      },
    });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first'));
      await waitUntil(() => manager.getAgentInfo('worker', parentSessionId).status === 'completed');
      expect(activity).toContain(true);
      expect(activity.at(-1)).toBe(false);

      const settled = manager.getAgentInfo('worker', parentSessionId);
      const rejectedAt = activity.length;
      const rejection = spyOn(codingAgent.AgentSession.prototype, 'prompt').mockRejectedValueOnce(
        new Error('fixture prompt rejection'),
      );
      try {
        await expect(
          manager.sendMessage(parentSessionId, 'worker', 'reject restart'),
        ).rejects.toThrow('fixture prompt rejection');
      } finally {
        rejection.mockRestore();
      }
      expect(manager.getAgentInfo('worker', parentSessionId)).toMatchObject({
        status: 'completed',
        finalResponse: settled.finalResponse,
        completedAt: settled.completedAt,
      });
      expect(manager['live'].has(settled.id)).toBe(false);
      expect(activity.slice(rejectedAt)).toContain(true);
      expect(activity.at(-1)).toBe(false);

      const restartAt = activity.length;
      await manager.sendMessage(parentSessionId, 'worker', 'hold restart');
      expect(activity.slice(restartAt)).toContain(true);
      await manager.interruptAgent(parentSessionId, 'worker');
      expect(activity.at(-1)).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });
});

describe('wait-all targeted polling', () => {
  function storeInfo(
    parent: string,
    taskName: string,
    overrides: Partial<AgentInfo> = {},
    root = getRunsDir(),
  ): AgentInfo {
    const id = overrides.id ?? randomUUID();
    const directory = path.join(root, parentScopeKey(parent));
    fs.mkdirSync(directory, { recursive: true });
    const info: AgentInfo = {
      id,
      taskName,
      canonicalName: '/' + taskName,
      parentSessionId: parent,
      provider: 'test',
      modelId: 'fake',
      model: 'test:fake',
      cwd: TEST_AGENT_DIR,
      sessionFile: path.join(directory, id + '.jsonl'),
      infoFile: path.join(directory, id + '.info.json'),
      logFile: path.join(directory, id + '.log'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 1,
      status: 'completed',
      finalResponse: taskName,
      ...overrides,
    };
    fs.writeFileSync(path.join(directory, id + '.info.json'), JSON.stringify(info));
    return info;
  }

  function markRunning(info: AgentInfo): void {
    fs.writeFileSync(
      activeMarker(info.id),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'wait-all-test' }),
    );
  }

  test('scans the scope once and only rereads target files across polling cycles', async () => {
    const parent = 'wait-all-read-budget-' + randomUUID();
    const manager = new AgentManager();
    await manager.ready();
    const target = storeInfo(parent, 'worker', { status: 'running' });
    markRunning(target);
    const history = Array.from({ length: 32 }, (_, index) => storeInfo(parent, 'history-' + index));
    const scope = path.dirname(target.infoFile);
    const reads = spyOn(fs, 'readFileSync');
    const scans = spyOn(fs, 'readdirSync');
    const checks = spyOn(manager as any, 'checkWaitTarget');
    const controller = new AbortController();
    let waiting: ReturnType<typeof manager.waitAllAgents> | undefined;
    try {
      waiting = manager.waitAllAgents(parent, ['worker'], controller.signal);
      await waitUntil(() => checks.mock.calls.length >= 3);
      expect(
        reads.mock.calls.filter(([file]) => String(file) === target.infoFile).length,
      ).toBeGreaterThanOrEqual(3);

      fs.writeFileSync(
        target.infoFile,
        JSON.stringify({ ...target, status: 'completed', finalResponse: 'updated on disk' }),
      );
      expect((await waiting).responses).toEqual([
        expect.objectContaining({ agent_name: '/worker', finalResponse: 'updated on disk' }),
      ]);
      const files = reads.mock.calls.map(([file]) => String(file));
      for (const info of history)
        expect(files.filter((file) => file === info.infoFile)).toHaveLength(1);
      expect(scans.mock.calls.filter(([directory]) => String(directory) === scope)).toHaveLength(1);
      expect(manager['waitAllClaims'].size).toBe(0);
    } finally {
      controller.abort();
      await waiting?.catch(() => {});
      reads.mockRestore();
      scans.mockRestore();
      checks.mockRestore();
      fs.rmSync(activeMarker(target.id), { force: true });
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test.each(['read error', 'invalid JSON'])(
    'retries initially unreadable candidates after %s without rereading resolved history',
    async (failure) => {
      const parent = 'wait-all-initial-read-retry-' + randomUUID();
      const manager = new AgentManager();
      await manager.ready();
      const first = storeInfo(parent, 'first', { createdAt: 1, status: 'running' });
      const second = storeInfo(parent, 'second', { createdAt: 2, status: 'running' });
      const unrelated = storeInfo(parent, 'unrelated');
      markRunning(first);
      markRunning(second);
      manager['defaultWaitAllTargets'].set(parent, new Set(['/first', '/second']));
      const unreadable = new Set([first.infoFile, unrelated.infoFile]);
      const read = fs.readFileSync;
      const reads = spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
        if (failure === 'read error' && unreadable.delete(String(file)))
          throw Object.assign(new Error('temporary read failure'), { code: 'EACCES' });
        return read(file, options as any);
      });
      if (failure === 'invalid JSON') {
        fs.writeFileSync(first.infoFile, '{');
        fs.writeFileSync(unrelated.infoFile, '{');
      }
      const controller = new AbortController();
      let waiting: ReturnType<typeof manager.waitAllAgents> | undefined;
      let settled = false;
      try {
        waiting = manager.waitAllAgents(parent, undefined, controller.signal);
        void waiting.then(
          () => {
            settled = true;
          },
          () => {},
        );
        fs.writeFileSync(first.infoFile, JSON.stringify(first));
        fs.writeFileSync(unrelated.infoFile, JSON.stringify(unrelated));
        fs.writeFileSync(second.infoFile, JSON.stringify({ ...second, status: 'completed' }));
        const firstReads = () =>
          reads.mock.calls.filter(([file]) => String(file) === first.infoFile).length;
        await waitUntil(() => firstReads() >= 2 || settled);
        expect(settled).toBe(false);
        await waitUntil(() => firstReads() >= 3);
        fs.writeFileSync(
          first.infoFile,
          JSON.stringify({ ...first, status: 'completed', finalResponse: 'recovered result' }),
        );
        expect((await waiting).responses).toEqual([
          expect.objectContaining({ agent_name: '/second', status: 'completed' }),
          expect.objectContaining({ agent_name: '/first', finalResponse: 'recovered result' }),
        ]);
        expect(reads.mock.calls.filter(([file]) => String(file) === unrelated.infoFile)).toHaveLength(2);
        expect(manager['waitAllClaims'].size).toBe(0);
      } finally {
        controller.abort();
        await waiting?.catch(() => {});
        reads.mockRestore();
        fs.rmSync(activeMarker(first.id), { force: true });
        fs.rmSync(activeMarker(second.id), { force: true });
        await manager.shutdown();
        fs.rmSync(path.dirname(first.infoFile), { recursive: true, force: true });
      }
    },
  );

  test('validates all explicit names and rereads actual current and legacy paths in creation order', async () => {
    const parent = 'wait-all-legacy-paths-' + randomUUID();
    const manager = new AgentManager();
    await manager.ready();
    const legacyRoot = path.join(TEST_AGENT_DIR, 'pi-subagents', os.userInfo().username, 'runs');
    const older = storeInfo(parent, 'duplicate', { createdAt: 1 });
    const newer = storeInfo(parent, 'duplicate', { id: older.id, createdAt: 3 }, legacyRoot);
    const target = storeInfo(parent, 'worker', { createdAt: 2, status: 'running' });
    markRunning(target);
    // Historical records can omit infoFile or retain a path from a previous location.
    const { infoFile: _omitted, ...withoutPath } = older;
    fs.writeFileSync(older.infoFile, JSON.stringify(withoutPath));
    fs.writeFileSync(newer.infoFile, JSON.stringify({ ...newer, infoFile: older.infoFile }));
    const controller = new AbortController();
    let waiting: ReturnType<typeof manager.waitAllAgents> | undefined;
    try {
      await expect(manager.waitAllAgents(parent, ['worker', 'missing'])).rejects.toThrow(
        'Agent not found in this parent session: /missing',
      );
      expect(manager['waitAllClaims'].size).toBe(0);
      waiting = manager.waitAllAgents(parent, ['duplicate', 'worker'], controller.signal);
      fs.writeFileSync(
        newer.infoFile,
        JSON.stringify({ ...newer, infoFile: older.infoFile, finalResponse: 'latest legacy result' }),
      );
      fs.writeFileSync(
        target.infoFile,
        JSON.stringify({ ...target, status: 'completed', finalResponse: 'worker result' }),
      );
      expect(
        (await waiting).responses.map(({ agent_name, finalResponse }) => [agent_name, finalResponse]),
      ).toEqual([
        ['/duplicate', 'latest legacy result'],
        ['/worker', 'worker result'],
        ['/duplicate', 'duplicate'],
      ]);
    } finally {
      controller.abort();
      await waiting?.catch(() => {});
      fs.rmSync(activeMarker(target.id), { force: true });
      await manager.shutdown();
      fs.rmSync(path.dirname(older.infoFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(newer.infoFile), { recursive: true, force: true });
    }
  });

  test.each(['missing', 'invalid JSON'])(
    'keeps ignoring a target file that becomes %s during a wait',
    async (change) => {
      const parent = 'wait-all-unreadable-' + randomUUID();
      const manager = new AgentManager();
      await manager.ready();
      const target = storeInfo(parent, 'worker', { status: 'running' });
      markRunning(target);
      const controller = new AbortController();
      let waiting: ReturnType<typeof manager.waitAllAgents> | undefined;
      try {
        waiting = manager.waitAllAgents(parent, ['worker'], controller.signal);
        if (change === 'missing') fs.rmSync(target.infoFile);
        else fs.writeFileSync(target.infoFile, '{');
        expect((await waiting).responses).toEqual([]);
      } finally {
        controller.abort();
        await waiting?.catch(() => {});
        fs.rmSync(activeMarker(target.id), { force: true });
        await manager.shutdown();
        fs.rmSync(path.dirname(target.infoFile), { recursive: true, force: true });
      }
    },
  );

  test('empty defaults skip history reads and [] keeps a parent-scoped target snapshot', async () => {
    const parent = 'wait-all-default-snapshot-' + randomUUID();
    const manager = new AgentManager();
    await manager.ready();
    const target = storeInfo(parent, 'worker', { status: 'running' });
    const late = storeInfo(parent, 'late', { status: 'running' });
    const foreign = storeInfo(parent + '-other', 'worker');
    markRunning(target);
    markRunning(late);
    const controller = new AbortController();
    let waiting: ReturnType<typeof manager.waitAllAgents> | undefined;
    const reads = spyOn(fs, 'readFileSync');
    try {
      expect((await manager.waitAllAgents(parent)).responses).toEqual([]);
      expect(reads.mock.calls.filter(([file]) => String(file).endsWith('.info.json'))).toEqual([]);
      reads.mockRestore();

      const defaults = new Set(['/worker']);
      manager['defaultWaitAllTargets'].set(parent, defaults);
      waiting = manager.waitAllAgents(parent, [], controller.signal);
      defaults.add('/late');
      fs.writeFileSync(target.infoFile, JSON.stringify({ ...target, status: 'completed' }));
      expect((await waiting).responses.map((info) => info.agent_name)).toEqual(['/worker']);
      expect([...defaults]).toEqual(['/late']);
    } finally {
      controller.abort();
      await waiting?.catch(() => {});
      reads.mockRestore();
      fs.rmSync(activeMarker(target.id), { force: true });
      fs.rmSync(activeMarker(late.id), { force: true });
      await manager.shutdown();
      fs.rmSync(path.dirname(target.infoFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(foreign.infoFile), { recursive: true, force: true });
    }
  });

  test('refreshes a previously completed target when it resumes while a sibling is pending', async () => {
    const parent = 'wait-all-resumed-target-' + randomUUID();
    const manager = new AgentManager();
    await manager.ready();
    const first = storeInfo(parent, 'first', { createdAt: 1 });
    const second = storeInfo(parent, 'second', { createdAt: 2, status: 'running' });
    markRunning(first);
    markRunning(second);
    const controller = new AbortController();
    const checks = spyOn(manager as any, 'checkWaitTarget');
    let waiting: ReturnType<typeof manager.waitAllAgents> | undefined;
    let settled = false;
    try {
      waiting = manager.waitAllAgents(parent, ['first', 'second'], controller.signal);
      void waiting.then(
        () => {
          settled = true;
        },
        () => {},
      );
      fs.writeFileSync(first.infoFile, JSON.stringify({ ...first, status: 'running' }));
      fs.writeFileSync(second.infoFile, JSON.stringify({ ...second, status: 'completed' }));
      await waitUntil(() => checks.mock.calls.length >= 4);
      expect(settled).toBe(false);
      fs.writeFileSync(first.infoFile, JSON.stringify({ ...first, finalResponse: 'resumed result' }));
      expect(
        (await waiting).responses.map(({ agent_name, finalResponse }) => [agent_name, finalResponse]),
      ).toEqual([
        ['/second', 'second'],
        ['/first', 'resumed result'],
      ]);
    } finally {
      controller.abort();
      await waiting?.catch(() => {});
      checks.mockRestore();
      fs.rmSync(activeMarker(first.id), { force: true });
      fs.rmSync(activeMarker(second.id), { force: true });
      await manager.shutdown();
      fs.rmSync(path.dirname(first.infoFile), { recursive: true, force: true });
    }
  });

  test('observes completion written by an external manager', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'wait-all-external-' + randomUUID();
    const owner = new AgentManager();
    const observer = new AgentManager();
    const controller = new AbortController();
    let waiting: ReturnType<typeof observer.waitAllAgents> | undefined;
    try {
      await owner.spawnAgent(spawnParams(parent, 'worker', 'hold external'));
      const target = owner.getAgentInfo('worker', parent);
      waiting = observer.waitAllAgents(parent, ['worker'], controller.signal);
      gate.resolve();
      await released(owner, target);
      expect((await waiting).responses).toEqual([
        expect.objectContaining({ status: 'completed', finalResponse: 'response:hold external' }),
      ]);
    } finally {
      controller.abort();
      gate.resolve();
      await waiting?.catch(() => {});
      await Promise.all([owner.shutdown(), observer.shutdown()]);
    }
  });
});

describe('completion mailbox', () => {
  test('waits until explicitly cancelled when no completion exists', async () => {
    const manager = new AgentManager();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('cancelled')), 10);
    await expect(manager.waitAgent('empty-parent', undefined, controller.signal)).rejects.toThrow(
      'cancelled',
    );
    await manager.shutdown();
  });

  test('consumes one matching completion without dropping siblings', () => {
    const events = [
      { id: '1', parentSessionId: 'parent', agentName: '/one', status: 'completed', createdAt: 1 },
      { id: '2', parentSessionId: 'parent', agentName: '/two', status: 'completed', createdAt: 2 },
      { id: '3', parentSessionId: 'other', agentName: '/one', status: 'completed', createdAt: 3 },
    ] as any[];
    expect(consumeFirstMatchingMailboxEvent(events, 'parent')?.agentName).toBe('/one');
    expect(events.map((event) => event.id)).toEqual(['2', '3']);
    expect(consumeFirstMatchingMailboxEvent(events, 'parent', new Set(['/two']))?.agentName).toBe(
      '/two',
    );
    expect(events.map((event) => event.id)).toEqual(['3']);
  });
});

describe('observer broadcast', () => {
  let broadcaster: InstanceType<typeof EventBroadcaster>;
  let agentId: string;
  let events: any[];
  let sockets: net.Socket[];

  beforeEach(async () => {
    agentId = randomUUID();
    events = [];
    sockets = [];
    broadcaster = new EventBroadcaster(agentId);
    broadcaster.start();
    await once(broadcaster['server']!, 'listening');
    const socket = net.connect(getSocketPath(agentId));
    sockets.push(socket);
    const decoder = new ObserverJsonlDecoder();
    socket.on('data', (chunk) => {
      for (const line of decoder.push(chunk)) events.push(JSON.parse(line));
    });
    let error: Error | undefined;
    socket.on('error', (value) => {
      error = value;
    });
    await waitUntil(() => {
      if (error) throw error;
      return events[0]?.type === 'sync';
    });
    events.length = 0;
  });

  afterEach(async () => {
    const server = broadcaster['server'];
    const closed = server ? once(server, 'close') : Promise.resolve();
    for (const socket of sockets) socket.destroy();
    broadcaster.stop();
    await closed;
  });

  const start = (id: string, toolName = 'codemode', args: any = { code: 'script' }) => ({
    type: 'tool_execution_start',
    toolCallId: id,
    toolName,
    args,
  });
  const update = (id: string, partialResult: any) => ({
    type: 'tool_execution_update',
    toolCallId: id,
    toolName: 'codemode',
    partialResult,
  });
  const end = (id: string, result: any, isError = false) => ({
    type: 'tool_execution_end',
    toolCallId: id,
    toolName: 'codemode',
    result,
    isError,
  });
  const textResult = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    details: {},
  });
  const messageEnd = (id: string) => ({
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: id },
  });
  const emit = (...values: any[]) => {
    for (const value of values) broadcaster.broadcast(value);
  };
  const snapshot = async () => (await readSocketEvents(getSocketPath(agentId), 1))[0];
  const flush = async () => {
    const token = randomUUID();
    emit({ type: 'test_barrier', token });
    await waitUntil(() =>
      events.some((event) => event.type === 'test_barrier' && event.token === token),
    );
    return events.filter((event) => event.type !== 'test_barrier');
  };
  const nested = (event: any, parentToolCallId: string) => ({ ...event, parentToolCallId });

  test('filters parallel nested notifications before state changes and preserves parent progress/results', async () => {
    const parent = start('parent');
    const partialResult = {
      ...textResult('script is running'),
      details: { calls: [{ id: 'parent/1', name: 'read', status: 'running' }] },
    };
    const result = {
      ...textResult('caught child error; script succeeded'),
      details: {
        calls: [{ id: 'parent/1', name: 'read', status: 'error', error: 'missing file' }],
      },
    };
    emit(
      parent,
      nested(start('parent/1', 'read'), 'parent'),
      nested(start('parent/2', 'powershell'), 'parent'),
      nested(update('parent/1', textResult('child-only output')), 'parent'),
      update('parent', partialResult),
    );
    expect(await snapshot()).toMatchObject({
      status: 'tool',
      toolName: 'codemode',
      activeTools: [
        { toolCallId: 'parent', toolName: 'codemode', args: parent.args, partialResult },
      ],
    });

    emit(
      nested(end('parent/1', textResult('missing file'), true), 'parent'),
      nested(end('parent/2', textResult('child-only output')), 'parent'),
      end('parent', result),
    );
    expect(await flush()).toEqual([parent, update('parent', partialResult), end('parent', result)]);
    expect((await snapshot()).activeTools).toEqual([
      {
        toolCallId: 'parent',
        toolName: 'codemode',
        args: parent.args,
        partialResult,
        result,
        isError: false,
      },
    ]);
  });

  test('ignores orphaned and multi-level nested events even without a cached parent', async () => {
    const before = await snapshot();
    for (const parent of ['missing', 'missing/child']) {
      const id = `${parent}/child`;
      emit(
        nested(start(id, 'codemode'), parent),
        nested(update(id, textResult('nested progress')), parent),
        nested(end(id, textResult('nested failure'), true), parent),
      );
    }
    expect(await flush()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  test('keeps genuine top-level read, powershell and MCP calls, including IDs with slashes', async () => {
    const expected: any[] = [];
    for (const [id, name] of [
      ['top/read', 'read'],
      ['top/shell', 'powershell'],
      ['top/mcp', 'mcp__docs'],
    ]) {
      const values = [
        start(id, name, { input: name }),
        { ...update(id, textResult('progress')), toolName: name },
        { ...end(id, textResult('output')), toolName: name },
      ];
      emit(...values);
      expected.push(...values);
    }
    expect(await flush()).toEqual(expected);
    expect(
      (await snapshot()).activeTools.map((tool: any) => [tool.toolCallId, tool.toolName]),
    ).toEqual([
      ['top/read', 'read'],
      ['top/shell', 'powershell'],
      ['top/mcp', 'mcp__docs'],
    ]);
  });

  test.each([
    { isError: false },
    { isError: true },
    { isError: false, durationMs: 84, resultDurationMs: 42, expectedDurationMs: 84 },
    { isError: true, resultDurationMs: 42, expectedDurationMs: 42 },
    { isError: false, durationMs: 0, resultDurationMs: 42, expectedDurationMs: 0 },
    { isError: true, resultDurationMs: 0, expectedDurationMs: 0 },
  ])(
    "retains a finished parent's result until its toolResult message (%j)",
    async ({ isError, durationMs, resultDurationMs, expectedDurationMs }) => {
      const result = {
        ...textResult('final script output'),
        details: { calls: [], elapsed: 42 },
        durationMs: resultDurationMs,
      };
      const inputs = [start('parent'), { ...end('parent', result, isError), durationMs }] as const;
      const original = JSON.stringify(inputs);
      const cachedTool = {
        toolCallId: 'parent',
        toolName: 'codemode',
        args: inputs[0].args,
        result: { ...result, durationMs: expectedDurationMs },
        isError,
      };
      emit(...inputs);
      expect((await snapshot()).activeTools).toEqual([cachedTool]);
      emit(messageEnd('unrelated'));
      expect((await snapshot()).activeTools).toEqual([cachedTool]);
      // Observer cache entries are released at message_end.
      emit(messageEnd('parent'));
      expect((await snapshot()).activeTools).toEqual([]);
      expect(await flush()).toEqual([...inputs, messageEnd('unrelated'), messageEnd('parent')]);
      expect(JSON.stringify(inputs)).toBe(original);
    },
  );

  test('updates and clears parallel top-level calls independently', async () => {
    emit(
      start('a'),
      start('b'),
      nested(start('a/1', 'read'), 'a'),
      nested(start('a/1/1', 'powershell'), 'a/1'),
      update('a', textResult('a progress')),
      end('a', textResult('a done')),
    );
    expect((await snapshot()).activeTools.map((tool: any) => tool.toolCallId)).toEqual(['a', 'b']);
    emit(
      messageEnd('a'),
      nested(end('a/1', textResult('late child'), true), 'a'),
      update('b', textResult('b progress')),
    );
    expect((await snapshot()).activeTools).toEqual([
      {
        toolCallId: 'b',
        toolName: 'codemode',
        args: { code: 'script' },
        partialResult: textResult('b progress'),
      },
    ]);
    emit(end('b', textResult('b done')), messageEnd('b'));
    expect((await snapshot()).activeTools).toEqual([]);
    expect((await flush()).filter((event) => event.parentToolCallId)).toEqual([]);
  });

  test('forwards non-execution lifecycle events even when they carry parent metadata', async () => {
    const values = [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'user', content: 'task' } },
      { type: 'message_end', message: { role: 'toolResult', toolCallId: 'unknown' } },
      { type: 'agent_end', messages: [] },
      { type: 'auto_retry_end', success: false, finalError: 'retry failed' },
      { type: 'agent_settled' },
    ].map((event) => ({ ...event, parentToolCallId: 'metadata-only' }));
    emit(...values);
    expect(await flush()).toEqual(values);
    expect(await snapshot()).toMatchObject({ status: 'done', activeTools: [] });
  });

  test('does not accumulate completed nested calls over 100 scripts in one unsettled run', async () => {
    for (let index = 0; index < 100; index++) {
      const id = `script-${index}`;
      emit(start(id));
      for (let child = 1; child <= 2; child++) {
        emit(
          nested(start(`${id}/${child}`, child === 1 ? 'read' : 'powershell'), id),
          nested(end(`${id}/${child}`, textResult('child output')), id),
        );
      }
      emit(
        update(id, textResult('script progress')),
        end(id, textResult('script output')),
        messageEnd(id),
      );
    }
    expect((await snapshot()).activeTools).toEqual([]);
    const live = await flush();
    for (const type of [
      'tool_execution_start',
      'tool_execution_update',
      'tool_execution_end',
      'message_end',
    ]) {
      expect(live.filter((event) => event.type === type)).toHaveLength(100);
    }
    expect(live.some((event) => event.parentToolCallId)).toBe(false);
  });

  test.each(['aborted', 'error'])(
    'preserves failure/interruption and settled cleanup (%s)',
    async (stopReason) => {
      const values = [
        start('parent'),
        { ...end('parent', textResult('Operation failed'), true), durationMs: 42 },
        {
          type: 'message_end',
          message: { role: 'assistant', content: [], stopReason, errorMessage: 'Operation failed' },
        },
        { type: 'agent_end', messages: [] },
      ];
      emit(...values);
      expect((await snapshot()).activeTools).toEqual([
        {
          toolCallId: 'parent',
          toolName: 'codemode',
          args: { code: 'script' },
          result: { ...textResult('Operation failed'), durationMs: 42 },
          isError: true,
        },
      ]);
      emit(
        { type: 'agent_settled' },
        nested(start('late/child', 'read'), 'finished-parent'),
        nested(end('late/child', textResult('late nested failure'), true), 'finished-parent'),
      );
      expect(await flush()).toEqual([...values, { type: 'agent_settled' }]);
      const sync = await snapshot();
      expect(sync).toMatchObject({
        status: 'done',
        activeTools: [],
        partialMessage: null,
        userMessage: null,
      });
      expect(sync.toolName).toBeUndefined();
    },
  );
});

const crossHostObserver = String.raw`
  import assert from "node:assert/strict";
  import net from "node:net";
  const socket = net.connect(process.argv[1]);
  socket.setEncoding("utf8");
  const timer = setTimeout(() => { console.error("observer timed out"); process.exit(2); }, 5000);
  let buffer = "", synchronized = false;
  socket.on("error", error => { console.error(error); process.exit(2); });
  socket.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n"), event = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (event.type === "sync") {
        assert.equal(event.status, "calling");
        assert.deepEqual(event.partialMessage.content[0], { type: "toolCall", id: "remote-call", name: "read", arguments: { path: "中文" } });
        assert.deepEqual(event.toolArguments, [[0, '{"path":"中文']]);
        synchronized = true;
        process.stdout.write("ready\n");
      } else if (event.type === "message_update") {
        assert.ok(synchronized);
        assert.equal(event.message, undefined);
        assert.equal(event.assistantMessageEvent.partial, undefined);
        assert.equal(event.assistantMessageEvent.delta, '😀\u2028末尾"}');
        clearTimeout(timer);
        socket.end();
        process.stdout.write("verified\n");
      }
    }
  });
`;

const runtimes: Array<[string, string]> = [['Bun', process.execPath]];
if (Bun.which('node')) runtimes.push(['Node', Bun.which('node')!]);

test.each(runtimes)(
  'keeps mid-run sync and Unicode deltas readable from a separate %s process',
  async (_name, executable) => {
    const id = randomUUID();
    const broadcaster = new EventBroadcaster(id);
    const message: any = {
      role: 'assistant',
      content: [],
      usage: {},
      api: 'test',
      provider: 'test',
      model: 'test',
      timestamp: Date.now(),
      stopReason: 'pending',
    };
    broadcaster.start();
    await once(broadcaster['server']!, 'listening');
    broadcaster.broadcast(toObserverEvent({ type: 'message_start', message }));
    message.content.push({ type: 'toolCall', id: 'remote-call', name: 'read', arguments: {} });
    broadcaster.broadcast(
      toObserverEvent({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: message },
      }),
    );
    broadcaster.broadcast(
      toObserverEvent({
        type: 'message_update',
        message,
        assistantMessageEvent: {
          type: 'toolcall_delta',
          contentIndex: 0,
          delta: '{"path":"中文',
          partial: message,
        },
      }),
    );
    const observer = spawn(
      executable,
      ['--input-type=module', '-e', crossHostObserver, getSocketPath(id)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      error = '',
      sent = false;
    observer.stdout.setEncoding('utf8');
    observer.stdout.on('data', (chunk) => {
      output += chunk;
      if (!sent && output.includes('ready')) {
        sent = true;
        broadcaster.broadcast(
          toObserverEvent({
            type: 'message_update',
            message,
            assistantMessageEvent: {
              type: 'toolcall_delta',
              contentIndex: 0,
              delta: '😀\u2028末尾"}',
              partial: message,
            },
          }),
        );
      }
    });
    observer.stderr.on('data', (chunk) => {
      error += chunk;
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        observer.on('error', reject);
        observer.on('exit', resolve);
      });
      expect(code, error).toBe(0);
      expect(output).toContain('verified');
      expect(message.content[0].arguments).toEqual({});
    } finally {
      observer.kill();
      const closed = once(broadcaster['server']!, 'close');
      broadcaster.stop();
      await closed;
    }
  },
);

describe('context usage formatting', () => {
  test.each([
    [50000, 500000, 10, '10%/500k'],
    [60000, 500000, 12, '12%/500k'],
    [1, 500000, 10.44, '10.4%/500k'],
    [0, 500000, 0, '0%/500k'],
    [1, 500000, 0.0002, '<0.1%/500k'],
    [500, 500000, 0.1, '0.1%/500k'],
    [525000, 500000, 105, '105%/500k'],
    [null, 500000, null, '?%/500k'],
    [105000, 1050000, 10, '10%/1.05M'],
    [100000, 1000000, 10, '10%/1M'],
    [1, 1000, 1, '1%/1k'],
    [1, 999, 1, '1%/999'],
  ])('formats native values %s/%s (%s)', (tokens, contextWindow, percent, expected) => {
    expect(formatContextUsage({ tokens, contextWindow, percent })).toBe(expected);
  });

  test.each(
    [
      undefined,
      null,
      false,
      0,
      [],
      {},
      { contextWindow: 0 },
      { contextWindow: -1 },
      { contextWindow: NaN },
      { contextWindow: Infinity },
      { contextWindow: '500000' },
    ].map((value) => ({ value })),
  )('rejects an unknown or invalid context window %#', ({ value }) => {
    expect(normalizeContextUsage(value)).toBeUndefined();
    expect(formatContextUsage(value)).toBe('?%/?');
  });

  test.each([
    {},
    { tokens: 0 },
    { percent: 0 },
    { tokens: null, percent: 0 },
    { tokens: 1, percent: null },
    { tokens: -1, percent: 10 },
    { tokens: 1, percent: -10 },
    { tokens: NaN, percent: 10 },
    { tokens: 1, percent: Infinity },
    { tokens: '1', percent: '10' },
  ])('normalizes an incomplete or invalid usage pair to unknown %#', (value) => {
    const input = { contextWindow: 500000, ...value };
    expect(normalizeContextUsage(input)).toEqual({
      contextWindow: 500000,
      tokens: null,
      percent: null,
    });
    expect(formatContextUsage(input)).toBe('?%/500k');
  });

  test('validates disk snapshots without migrating legacy history', () => {
    const directory = fs.mkdtempSync(path.join(TEST_AGENT_DIR, 'context-read-'));
    const file = path.join(directory, 'agent.info.json');
    try {
      for (const value of [
        { status: 'completed' },
        { status: 'completed', contextUsage: { contextWindow: 0, tokens: 0, percent: 0 } },
        { status: 'completed', contextUsage: 'bad metadata' },
      ]) {
        fs.writeFileSync(file, JSON.stringify(value));
        expect(readInfoFile(file)?.contextUsage).toBeUndefined();
      }
      fs.writeFileSync(
        file,
        '{"status":"completed","contextUsage":{"contextWindow":500000,"tokens":-1,"percent":10}}',
      );
      expect(formatContextUsage(readInfoFile(file)?.contextUsage)).toBe('?%/500k');
      fs.writeFileSync(file, 'null');
      expect(readInfoFile(file)).toBeUndefined();
      fs.writeFileSync(file, '{');
      expect(readInfoFile(file)).toBeUndefined();
      fs.rmSync(file);
      expect(readInfoFile(file)).toBeUndefined();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('SDK business scope, waits and resources', () => {
  test('identical task names stay parent-scoped; all-sessions is only a read view', async () => {
    const parentA = 'scope-a-' + randomUUID();
    const parentB = 'scope-b-' + randomUUID();
    const manager = new AgentManager();
    try {
      await Promise.all([
        manager.spawnAgent(spawnParams(parentA, '/review/api/', 'hold a')),
        manager.spawnAgent(spawnParams(parentB, 'review/api', 'hold b')),
      ]);
      const a = manager.getAgentInfo('review/api', parentA);
      const b = manager.getAgentInfo('review/api', parentB);
      expect(a.id).not.toBe(b.id);
      expect(a.sessionFile).not.toBe(b.sessionFile);
      expect(manager.listAgents('review/', parentA)).toEqual([
        expect.objectContaining({
          agent_name: '/review/api',
          agent_status: 'running',
          last_task_message: 'hold a',
        }),
      ]);
      const all = manager
        .listAgents(undefined, parentA, true)
        .filter((entry) => [parentA, parentB].includes(entry.parent_session_id!));
      expect(all).toHaveLength(2);
      expect(new Set(all.map((entry) => entry.parent_session_id))).toEqual(
        new Set([parentA, parentB]),
      );
      await expect(
        manager.sendMessage('unrelated', 'review/api', 'must not deliver'),
      ).rejects.toThrow('Agent not found');
      await expect(manager.interruptAgent('unrelated', 'review/api')).rejects.toThrow(
        'Agent not found',
      );
      await expect(
        manager.spawnAgent(spawnParams(parentA, 'review/api', 'duplicate')),
      ).rejects.toThrow(/already exists/);
      await manager.interruptAgent(parentA, 'review/api');
      expect(manager.getAgentInfo('review/api', parentB).status).toBe('running');
      expect((await manager.waitAgent(parentA, ['review/api'])).event?.status).toBe('interrupted');
      expect(fixture.instances[1].shutdowns).toBe(0);
    } finally {
      await manager.shutdown();
    }
  });

  test('read is non-consuming, wait cancellation leaves work alive, and default wait-all targets do not cross parents', async () => {
    const parent = 'wait-contract-' + randomUUID();
    const other = 'wait-other-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    const controller = new AbortController();
    try {
      await manager.spawnAgent(spawnParams(parent, 'one', 'first'));
      const info = manager.getAgentInfo('one', parent);
      await released(manager, info);
      const first = manager.readAgentResponse('one', parent);
      expect(manager.readAgentResponse('one', parent)).toEqual(first);
      expect(completions).toHaveLength(1);
      expect((await manager.waitAgent(parent, ['one'])).event?.id).toBe(completions[0].id);
      expect(manager.readAgentResponse('one', parent)).toEqual(first);
      await manager.spawnAgent(spawnParams(parent, 'two', 'hold waiting'));
      await manager.spawnAgent(spawnParams(other, 'foreign', 'hold other'));
      const waiting = manager.waitAgent(parent, ['two'], controller.signal);
      controller.abort();
      await expect(waiting).rejects.toThrow(/abort/i);
      expect(manager.getAgentInfo('two', parent).status).toBe('running');
      expect(manager.getAgentInfo('foreign', other).status).toBe('running');
      await manager.interruptAgent(parent, 'two');
      const all = await manager.waitAllAgents(parent);
      expect(all.responses).toEqual([]); // Interrupt removes its name from implicit wait-all targets.
      expect((await manager.waitAllAgents(parent, ['two'])).responses).toEqual([
        expect.objectContaining({ agent_name: '/two', status: 'interrupted' }),
      ]);
      expect(manager.getAgentInfo('foreign', other).status).toBe('running');
      expect(completions).toHaveLength(1);
    } finally {
      await manager.shutdown();
    }
  });

  test('a second manager can observe but cannot take over an active SDK session file', async () => {
    const parent = 'external-owner-' + randomUUID();
    const owner = new AgentManager();
    const observer = new AgentManager();
    try {
      await owner.spawnAgent(spawnParams(parent, 'worker', 'hold owner'));
      const info = owner.getAgentInfo('worker', parent);
      await observer.ready();
      expect(observer.readAgentResponse('worker', parent).status).toBe('running');
      await expect(observer.sendMessage(parent, 'worker', 'must not reopen')).rejects.toThrow(
        /active in another host/,
      );
      await expect(observer.interruptAgent(parent, 'worker')).rejects.toThrow(
        /active in another host/,
      );
      expect(owner.getAgentInfo('worker', parent).status).toBe('running');
      expect(fixture.instances).toHaveLength(1);
      await observer.shutdown();
      expect(owner['live'].has(info.id)).toBe(true);
    } finally {
      await Promise.all([owner.shutdown(), observer.shutdown()]);
    }
  });

  test('passes only its SYSTEM path and explicitly resolved template/skill resources, with fresh context', async () => {
    const parent = 'resource-policy-' + randomUUID();
    const root = fs.mkdtempSync(path.join(TEST_AGENT_DIR, 'resources-'));
    const cwd = path.join(root, 'project', 'nested');
    fs.mkdirSync(cwd, { recursive: true });
    const ownSystem = path.join(TEST_AGENT_DIR, 'pi-subagents', 'SYSTEM.md');
    const literalTarget = path.join(root, 'literal-target.md');
    fs.writeFileSync(literalTarget, 'FORBIDDEN_SECOND_SYSTEM_READ');
    fs.writeFileSync(ownSystem, literalTarget);
    const files: string[] = [];
    const put = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      files.push(file);
    };
    for (const dir of [TEST_AGENT_DIR, root, path.dirname(cwd), cwd]) {
      for (const name of [
        'AGENTS.md',
        'AGENTS.override.md',
        'CLAUDE.md',
        'SYSTEM.md',
        'APPEND_SYSTEM.md',
      ]) {
        put(path.join(dir, name), 'FORBIDDEN_AUTO_RESOURCE ' + name);
      }
    }
    put(
      path.join(cwd, '.pi', 'skills', 'unselected', 'SKILL.md'),
      '---\nname: unselected\ndescription: FORBIDDEN_AUTO_SKILL\n---\nDo not discover this.',
    );
    const skill = path.join(root, 'explicit-skill', 'SKILL.md');
    put(
      skill,
      '---\nname: explicit-core-skill\ndescription: EXPLICIT_CORE_SKILL_DESCRIPTION\n---\nExplicit skill body.',
    );
    const template = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents', 'resource-policy.md');
    put(
      template,
      '---\nname: resource-policy\nskills: explicit-core-skill\n---\nEXPLICIT_TEMPLATE_BODY',
    );
    const parentSession = codingAgent.SessionManager.create(cwd, root);
    parentSession.appendMessage({
      role: 'user',
      content: 'FORBIDDEN_PARENT_CONVERSATION',
      timestamp: Date.now(),
    });
    const manager = new AgentManager({ projectTrusted: () => true });
    try {
      await manager.spawnAgent({
        ...spawnParams(parent, 'worker', 'assigned work'),
        cwd,
        agent_type: 'resource-policy',
        parentSessionFile: parentSession.getSessionFile()!,
        loadedSkillPaths: { 'explicit-core-skill': path.dirname(skill) },
      });
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      expect(info.skillPaths).toEqual([path.dirname(skill)]);
      expect(info.extensionPaths).toEqual([CORE_SDK_EXTENSION]);
      expect(info.cwd).toBe(cwd);
      expect(fixture.instances).toHaveLength(1);
      const request = fixture.instances[0].requests[0];
      expect(request.text).toBe('EXPLICIT_TEMPLATE_BODY\n\nassigned work');
      const input = JSON.stringify(request.context);
      expect(input).toContain(literalTarget.replaceAll('\\', '\\\\'));
      expect(input).toContain('EXPLICIT_CORE_SKILL_DESCRIPTION');
      expect(input).not.toContain('FORBIDDEN_');
      expect(input).not.toContain('Explicit skill body.');
      fs.writeFileSync(ownSystem, 'UPDATED_OWN_SYSTEM');
      await manager.sendMessage(parent, 'worker', 'continuation');
      await released(manager, info);
      expect(JSON.stringify(fixture.instances[1].requests[0].context)).toContain(
        'UPDATED_OWN_SYSTEM',
      );
      expect(fixture.instances[1].requests[0].text).toBe('continuation');
      const nativeList = await codingAgent.SessionManager.list(cwd);
      expect(nativeList.some((session) => session.path === info.sessionFile)).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(ownSystem, { force: true });
      for (const file of files) fs.rmSync(file, { force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([undefined, '', 'read'])(
    'retains the tool-selection three-state contract (%s)',
    async (tools) => {
      const parent = 'tools-contract-' + randomUUID();
      const name = 'tool-contract-' + randomUUID();
      const template = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents', name + '.md');
      fs.writeFileSync(
        template,
        '---\nname: ' + name + (tools === undefined ? '' : '\ntools: ' + tools) + '\n---\n',
      );
      const manager = new AgentManager();
      try {
        await manager.spawnAgent({
          ...spawnParams(parent, 'worker', 'inspect tools'),
          agent_type: name,
        });
        const info = manager.getAgentInfo('worker', parent);
        await released(manager, info);
        const names = fixture.instances[0].requests[0].context.messages
          .flatMap((message: any) => message.toolsAdded ?? [])
          .map((tool: any) => tool.name);
        if (tools === 'read') expect(names).toEqual(['read']);
        else if (tools === '') expect(names).toEqual(['fixture_hold']);
        else expect(names).toEqual(expect.arrayContaining(['read', 'bash', 'fixture_hold']));
        expect(info.tools).toBe(tools);
      } finally {
        await manager.shutdown();
        fs.rmSync(template, { force: true });
      }
    },
  );
});

describe('SDK native context usage and failure cleanup', () => {
  test("saves the final persisted usage rather than message_end's previous projection or cumulative billing", async () => {
    fixture = configureCoreFixture({ tokens: (text) => (text === 'first' ? 50000 : 60000) });
    const parent = 'native-usage-' + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      expect(manager.getAgentInfo('worker', parent).contextUsage).toEqual({
        tokens: 50000,
        contextWindow: 500000,
        percent: 10,
      });
      await manager.sendMessage(parent, 'worker', 'second');
      await released(manager, info);
      const final = manager.getAgentInfo('worker', parent);
      expect(final.contextUsage).toEqual({ tokens: 60000, contextWindow: 500000, percent: 12 });
      expect(
        sessionMessages(final)
          .filter((entry) => entry.role === 'assistant')
          .reduce((sum, entry) => sum + entry.usage.totalTokens, 0),
      ).toBe(110000);
      expect(formatContextUsage(readInfoFile(final.infoFile)?.contextUsage)).toBe('12%/500k');
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([1, 1]);
    } finally {
      await manager.shutdown();
    }
  });

  test('different children sample their own native model windows', async () => {
    fixture = configureCoreFixture({
      routes: [
        ['test', 'fake', 500000],
        ['test', 'small', 200000],
      ],
      tokens: 50000,
    });
    const parent = 'native-windows-' + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, 'large', 'first'));
      await manager.spawnAgent({
        ...spawnParams(parent, 'small', 'second'),
        model: { provider: 'test', modelId: 'small' },
      });
      await Promise.all([
        released(manager, manager.getAgentInfo('large', parent)),
        released(manager, manager.getAgentInfo('small', parent)),
      ]);
      expect(formatContextUsage(manager.getAgentInfo('large', parent).contextUsage)).toBe(
        '10%/500k',
      );
      expect(formatContextUsage(manager.getAgentInfo('small', parent).contextUsage)).toBe(
        '25%/200k',
      );
    } finally {
      await manager.shutdown();
    }
  });

  test('native compaction invalidates old usage and a restored session can continue the same JSONL', async () => {
    const parent = 'compacted-' + randomUUID();
    const manager = new AgentManager();
    const gate = deferred();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      const saved = codingAgent.SessionManager.open(
        info.sessionFile,
        path.dirname(info.sessionFile),
        info.cwd,
      );
      saved.appendCompaction('saved compacted summary', null, 60000);
      fixture = configureCoreFixture({ responseGate: gate.promise });
      await manager.sendMessage(parent, 'worker', 'hold after compaction');
      const live = manager['live'].get(info.id)!;
      const usage = live.session!.getContextUsage();
      expect(usage).toEqual({ tokens: null, contextWindow: 500000, percent: null });
      manager['sampleContextUsage'](live);
      expect(manager.getAgentInfo('worker', parent).contextUsage).toEqual(usage);
      gate.resolve();
      await released(manager, info);
      expect(formatContextUsage(manager.getAgentInfo('worker', parent).contextUsage)).toBe(
        '12%/500k',
      );
      expect(fs.readFileSync(info.sessionFile, 'utf8')).toContain('saved compacted summary');
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('a failed final context sample is visible but cannot prevent completion or disposal', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'sampling-error-' + randomUUID();
    const completions: any[] = [];
    const errors: Error[] = [];
    const manager = new AgentManager({
      onError: (error) => errors.push(error),
      onUnclaimedCompletion: (event) => completions.push(event),
    });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold sample'));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo('worker', parent);
      const session = manager['live'].get(info.id)!.session!;
      spyOn(session, 'getContextUsage').mockImplementation(() => {
        throw new Error('native sample fixture failure');
      });
      gate.resolve();
      await released(manager, info);
      expect(manager.readAgentResponse('worker', parent).status).toBe('completed');
      expect(completions).toHaveLength(1);
      expect(errors.some((error) => error.message.includes('native sample fixture failure'))).toBe(
        true,
      );
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('sampling is synchronous, validates data, retries an identical failed save, and ignores replaced live objects', async () => {
    const parent = 'usage-persistence-' + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold usage'));
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      const usage = { tokens: 60000, contextWindow: 500000, percent: 12 };
      const sample = spyOn(live.session!, 'getContextUsage').mockReturnValue(usage);
      const before = manager.getAgentInfo('worker', parent);
      const rename = fs.renameSync;
      const failSave = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to) === info.infoFile) throw new Error('usage write fixture failure');
        return rename(from, to);
      });
      manager['sampleContextUsage'](live);
      expect(live.info.contextUsage).toBeUndefined();
      expect(manager.getAgentInfo('worker', parent).contextUsage).toBeUndefined();
      failSave.mockRestore();
      manager['sampleContextUsage'](live);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        contextUsage: usage,
        status: before.status,
        messageCount: before.messageCount,
        lastActivity: before.lastActivity,
      });
      const writes = spyOn(fs, 'renameSync');
      manager['sampleContextUsage'](live);
      expect(writes).not.toHaveBeenCalled();
      writes.mockRestore();
      sample.mockReturnValue({ tokens: 1, contextWindow: 0, percent: 1 });
      manager['sampleContextUsage'](live);
      expect(manager.getAgentInfo('worker', parent).contextUsage).toBeUndefined();
      sample.mockReturnValue(usage);
      manager['live'].delete(info.id);
      manager['sampleContextUsage'](live);
      expect(manager.getAgentInfo('worker', parent).contextUsage).toBeUndefined();
      manager['live'].set(info.id, live);
      expect(errors.some((error) => error.message.includes('usage write fixture failure'))).toBe(
        true,
      );
    } finally {
      await manager.shutdown();
    }
  });

  test('one failed shutdown save still cleans every child and reports the original persistence error', async () => {
    const parent = 'shutdown-save-' + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    let save: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'one', 'hold first'));
      await manager.spawnAgent(spawnParams(parent, 'two', 'hold second'));
      await waitUntil(() => fixture.instances.every((instance) => instance.activeStreams === 1));
      const one = manager.getAgentInfo('one', parent);
      const rename = fs.renameSync;
      save = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to) === one.infoFile) throw new Error('shutdown save fixture failure');
        return rename(from, to);
      });
      await expect(manager.shutdown()).rejects.toThrow('shutdown save fixture failure');
      expect(manager['live'].size).toBe(0);
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([1, 1]);
      expect(fixture.instances.every((instance) => instance.activeStreams === 0)).toBe(true);
      expect(errors.some((error) => error.message.includes('shutdown save fixture failure'))).toBe(
        true,
      );
    } finally {
      save?.mockRestore();
      await manager.shutdown();
    }
  });
});

describe('SDK acceptance and observer edge cases', () => {
  test.each(['completed', 'failed', 'interrupted'] as const)(
    'a submitted but unaccepted prompt rejection restores the previous %s snapshot',
    async (status) => {
      const parent = 'unaccepted-' + randomUUID();
      const completions: any[] = [];
      const manager = new AgentManager({
        onUnclaimedCompletion: (event) => completions.push(event),
      });
      let prompt: ReturnType<typeof spyOn> | undefined;
      try {
        await manager.spawnAgent(
          spawnParams(
            parent,
            'worker',
            status === 'completed' ? 'first' : status === 'failed' ? 'fail first' : 'hold first',
          ),
        );
        if (status === 'interrupted') await manager.interruptAgent(parent, 'worker');
        const original = manager.getAgentInfo('worker', parent);
        await released(manager, original);
        const before = manager.getAgentInfo('worker', parent);
        const count = completions.length;
        prompt = spyOn(codingAgent.AgentSession.prototype, 'prompt').mockRejectedValueOnce(
          new Error('unaccepted prompt fixture rejection'),
        );
        await expect(manager.sendMessage(parent, 'worker', 'not accepted')).rejects.toThrow(
          'unaccepted prompt fixture rejection',
        );
        await released(manager, before);
        const after = manager.getAgentInfo('worker', parent);
        expect(after).toMatchObject({
          status,
          messageCount: before.messageCount,
          completedAt: before.completedAt,
          lastTaskMessage: before.lastTaskMessage,
        });
        expect(after.finalResponse).toBe(before.finalResponse);
        expect(after.error).toBe(before.error);
        expect(completions).toHaveLength(count);
        expect(fixture.instances[1].requests).toEqual([]);
        expect(fixture.instances[1].shutdowns).toBe(1);
      } finally {
        prompt?.mockRestore();
        await manager.shutdown();
      }
    },
  );

  test('a delayed unaccepted rejection cannot restore a completed snapshot over explicit interrupt', async () => {
    const gate = deferred();
    const parent = 'reject-after-interrupt-' + randomUUID();
    const manager = new AgentManager();
    let prompt: ReturnType<typeof spyOn> | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      prompt = spyOn(codingAgent.AgentSession.prototype, 'prompt').mockImplementationOnce(
        async () => {
          await gate.promise;
          throw new Error('late unaccepted fixture rejection');
        },
      );
      pending = manager.sendMessage(parent, 'worker', 'not accepted').then(
        () => undefined,
        (error) => error,
      );
      await waitUntil(() => Boolean(manager['live'].get(info.id)?.promptFinished));
      const interruption = manager.interruptAgent(parent, 'worker');
      await waitUntil(() => manager.getAgentInfo('worker', parent).status === 'interrupted');
      gate.resolve();
      await interruption;
      expect(await pending).toBeInstanceOf(Error);
      await released(manager, info);
      expect(manager.readAgentResponse('worker', parent)).toMatchObject({ status: 'interrupted' });
      expect(manager.getAgentInfo('worker', parent).finalResponse).toBeUndefined();
      expect((await manager.waitAgent(parent, ['worker'])).event?.status).toBe('interrupted');
    } finally {
      gate.resolve();
      await pending;
      prompt?.mockRestore();
      await manager.shutdown();
    }
  });

  test('a rejection after acceptance fails this run rather than restoring the previous answer', async () => {
    const gate = deferred();
    const parent = 'accepted-rejection-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    let prompt: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      prompt = spyOn(codingAgent.AgentSession.prototype, 'prompt').mockImplementationOnce(
        async (_text, options) => {
          options?.preflightResult?.('started');
          await gate.promise;
          throw new Error('accepted run fixture failure');
        },
      );
      expect(await manager.sendMessage(parent, 'worker', 'accepted new task')).toEqual({
        delivery: 'prompt',
      });
      gate.resolve();
      await released(manager, info);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        status: 'failed',
        messageCount: 2,
        error: 'accepted run fixture failure',
      });
      expect(manager.getAgentInfo('worker', parent).finalResponse).toBeUndefined();
      expect(completions).toHaveLength(2);
      expect(fixture.instances[1].shutdowns).toBe(1);
    } finally {
      gate.resolve();
      prompt?.mockRestore();
      await manager.shutdown();
    }
  });

  test('settled.aborted without an assistant is a failed run, not the previous response', async () => {
    const parent = 'settled-without-assistant-' + randomUUID();
    const manager = new AgentManager();
    let prompt: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      prompt = spyOn(codingAgent.AgentSession.prototype, 'prompt').mockImplementationOnce(
        async (_text, options) => {
          options?.preflightResult?.('handled');
          await Promise.resolve(); // Let the caller track the submitted prompt first.
          manager['handleSessionEvent'](manager['live'].get(info.id)!, {
            type: 'agent_settled',
            aborted: true,
          } as any);
        },
      );
      await manager.sendMessage(parent, 'worker', 'handled aborted');
      await released(manager, info);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        status: 'failed',
        error: 'Agent ended with aborted.',
      });
      expect(manager.getAgentInfo('worker', parent).finalResponse).toBeUndefined();
      expect(fixture.instances[1].requests).toEqual([]);
    } finally {
      prompt?.mockRestore();
      await manager.shutdown();
    }
  });

  test('nested native tool activity is retained by the manager but filtered only from observer state', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'nested-native-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold nested'));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      for (const event of [
        { type: 'tool_execution_start', args: {} },
        {
          type: 'tool_execution_update',
          partialResult: { content: [{ type: 'text', text: 'nested progress' }] },
        },
        {
          type: 'tool_execution_end',
          result: { content: [{ type: 'text', text: 'nested error' }] },
          isError: true,
        },
      ]) {
        live.lastActivityPersistedAt = 0;
        manager['handleSessionEvent'](live, {
          ...event,
          toolCallId: 'parent/child',
          toolName: 'read',
          parentToolCallId: 'parent',
        } as any);
        expect(manager.getAgentInfo('worker', parent).lastActivity).toBe(live.info.lastActivity);
        expect(live.lastActivityPersistedAt).toBeGreaterThan(0);
      }
      const [sync] = await readSocketEvents(getSocketPath(info.id), 1);
      expect(sync.activeTools).toEqual([]);
      expect(completions).toEqual([]);
      gate.resolve();
      await released(manager, info);
      expect(completions).toEqual([
        expect.objectContaining({ status: 'completed', finalResponse: 'response:hold nested' }),
      ]);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe(
        'response:hold nested',
      );
      expect((await manager.waitAllAgents(parent, ['worker'])).responses).toEqual([
        expect.objectContaining({ status: 'completed' }),
      ]);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('an uncooperative manager shutdown is bounded, refuses new work, and finishes late cleanup', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise, ignoreAbort: true });
    const parent = 'uncooperative-shutdown-' + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold shutdown'));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo('worker', parent);
      const started = Date.now();
      await expect(manager.shutdown()).rejects.toThrow(/closing/);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(manager['live'].has(info.id)).toBe(true);
      expect(fs.existsSync(activeMarker(info.id))).toBe(true);
      await expect(manager.spawnAgent(spawnParams(parent, 'late', 'must not run'))).rejects.toThrow(
        /shut/,
      );
      await expect(manager.sendMessage(parent, 'worker', 'must not run')).rejects.toThrow(/shut/);
      gate.resolve();
      await released(manager, info);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fixture.instances[0].activeStreams).toBe(0);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });
});

describe('reviewed SDK lifecycle regressions', () => {
  test('a failed final save still publishes status, wakes wait_agent, and exposes consumed-mailbox/disk inconsistency', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'failed-final-save-wait-' + randomUUID();
    const errors: Error[] = [];
    const activity: boolean[] = [];
    const notifications: any[] = [];
    const manager = new AgentManager({
      onError: (error) => errors.push(error),
      onActivityChange: (event) => activity.push(event.active),
      onUnclaimedCompletion: (event) => notifications.push(event),
    });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    let save: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold final save'));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo('worker', parent);
      const rename = fs.renameSync;
      save = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (
          String(to) === info.infoFile &&
          JSON.parse(fs.readFileSync(String(from), 'utf8')).status === 'completed'
        )
          throw new Error('final status fixture save failure');
        return rename(from, to);
      });
      const waiting = manager.waitAgent(parent, ['worker'], controller.signal);
      gate.resolve();
      expect((await waiting).event).toMatchObject({
        status: 'completed',
        finalResponse: 'response:hold final save',
      });
      await released(manager, info);
      expect(activity.at(-1)).toBe(false);
      expect(notifications).toEqual([]);
      expect(
        errors.some((error) => error.message.includes('final status fixture save failure')),
      ).toBe(true);
      expect(manager.getAgentInfo('worker', parent).status).toBe('running');
      expect(manager['live'].size).toBe(0);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      await expect(manager.waitAllAgents(parent, ['worker'], controller.signal)).rejects.toThrow(
        /persisted status|saved status|inconsistent/i,
      );
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      save?.mockRestore();
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('wait_all_agents uses an existing terminal mailbox event ahead of a stale running disk record', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'failed-final-save-all-' + randomUUID();
    const notifications: any[] = [];
    const manager = new AgentManager({
      onError() {},
      onUnclaimedCompletion: (event) => notifications.push(event),
    });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    let save: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold mailbox final'));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo('worker', parent);
      const rename = fs.renameSync;
      save = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (
          String(to) === info.infoFile &&
          JSON.parse(fs.readFileSync(String(from), 'utf8')).status === 'completed'
        )
          throw new Error('final status fixture save failure');
        return rename(from, to);
      });
      const waiting = manager.waitAllAgents(parent, ['worker'], controller.signal);
      gate.resolve();
      expect((await waiting).responses).toEqual([
        expect.objectContaining({
          agent_name: '/worker',
          status: 'completed',
          finalResponse: 'response:hold mailbox final',
        }),
      ]);
      await released(manager, info);
      expect(notifications).toEqual([]);
      expect(manager.getAgentInfo('worker', parent).status).toBe('running');
      expect(manager['mailbox'].filter((event) => event.parentSessionId === parent)).toEqual([]);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      save?.mockRestore();
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('unaccepted resume rejection wakes a waiter registered during native input with the old final event, without renotifying', async () => {
    const gate = deferred();
    const parent = 'resume-waiter-rollback-' + randomUUID();
    const notifications: any[] = [];
    const manager = new AgentManager({
      onUnclaimedCompletion: (event) => notifications.push(event),
    });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    let resuming: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await released(manager, info);
      expect(notifications).toHaveLength(1);
      fixture = configureCoreFixture({
        input: async () => {
          await gate.promise;
        },
      });
      resuming = manager.sendMessage(parent, 'worker', 'not accepted').then(
        () => undefined,
        (error) => error,
      );
      await waitUntil(() => fixture.instances[0]?.inputs.length === 1);
      const live = manager['live'].get(info.id)!;
      // Fail native auth preflight after the input hook returns.
      spyOn(live.session!.modelRuntime, 'hasConfiguredAuth').mockReturnValue(false);
      spyOn(live.session!.modelRuntime, 'checkAuth').mockResolvedValue(undefined);
      const waiting = manager.waitAgent(parent, ['worker'], controller.signal);
      expect(manager['waiters']).toHaveLength(1);
      gate.resolve();
      const error = (await resuming) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/API key|authentication/i);
      expect((await waiting).event).toMatchObject({
        agentName: '/worker',
        status: 'completed',
        finalResponse: 'response:first',
      });
      await released(manager, info);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        status: 'completed',
        messageCount: 1,
        finalResponse: 'response:first',
      });
      expect(notifications).toHaveLength(1);
      expect(fixture.instances[0].requests).toEqual([]);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      gate.resolve();
      await resuming;
      await manager.shutdown();
    }
  });

  describe('unaccepted resume completion state', () => {
    function rejectAfterInput(
      manager: InstanceType<typeof AgentManager>,
      info: AgentInfo,
      gate: ReturnType<typeof deferred>,
    ) {
      const entered = deferred();
      fixture = configureCoreFixture({
        input: async () => {
          entered.resolve();
          await gate.promise;
          const session = manager['live'].get(info.id)!.session!;
          session.modelRuntime.unregisterProvider(info.provider);
          await session.modelRuntime.refresh({ allowNetwork: false });
          // unregister also starts a native background refresh, which may finish last.
          await waitUntil(() => !session.modelRuntime.hasConfiguredAuth(info.provider));
        },
      });
      const state = fixture;
      const resuming = manager
        .sendMessage(info.parentSessionId, info.taskName, 'unaccepted native input')
        .then(
          () => undefined,
          (error) => error,
        );
      return { entered: entered.promise, resuming, state };
    }

    test('an active wait-all follows live.info replacement after an unaccepted resume rolls back', async () => {
      const parent = 'wait-all-active-rollback-' + randomUUID();
      const manager = new AgentManager();
      const controller = new AbortController();
      const response = deferred();
      const input = deferred();
      const checks = spyOn(manager as any, 'checkWaitTarget');
      let waiting: ReturnType<typeof manager.waitAllAgents> | undefined;
      let resuming: Promise<unknown> | undefined;
      let settled = false;
      try {
        await manager.spawnAgent(spawnParams(parent, 'first', 'original answer'));
        const first = manager.getAgentInfo('first', parent);
        await released(manager, first);
        fixture = configureCoreFixture({ responseGate: response.promise });
        await manager.spawnAgent(spawnParams(parent, 'second', 'hold sibling'));
        const second = manager.getAgentInfo('second', parent);
        waiting = manager.waitAllAgents(parent, ['first', 'second'], controller.signal);
        void waiting.then(
          () => {
            settled = true;
          },
          () => {},
        );
        const rejected = rejectAfterInput(manager, first, input);
        resuming = rejected.resuming;
        await rejected.entered;
        const beforePoll = checks.mock.calls.length;
        response.resolve();
        await released(manager, second);
        await waitUntil(() => checks.mock.calls.length > beforePoll);
        expect(settled).toBe(false);
        input.resolve();
        expect(await resuming).toBeInstanceOf(Error);
        expect((await waiting).responses).toEqual([
          expect.objectContaining({ agent_name: '/second', finalResponse: 'response:hold sibling' }),
          expect.objectContaining({ agent_name: '/first', finalResponse: 'response:original answer' }),
        ]);
        expect(manager['waitAllClaims'].size).toBe(0);
        await released(manager, first);
      } finally {
        controller.abort();
        response.resolve();
        input.resolve();
        await resuming;
        await waiting?.catch(() => {});
        checks.mockRestore();
        await manager.shutdown();
      }
    });

    test.each(['wait_agent', 'wait_all_agents'])(
      'commits rollback before an activity callback consumes it with %s',
      async (consumer) => {
        const gate = deferred();
        const parent = 'rollback-activity-consumer-' + randomUUID();
        const notifications: any[] = [];
        let observeRollback = false;
        let callbackWait: Promise<any> | undefined;
        const manager = new AgentManager({
          onUnclaimedCompletion: (event) => notifications.push(event),
          onActivityChange(event) {
            if (!observeRollback || event.parentSessionId !== parent || event.active) return;
            callbackWait =
              consumer === 'wait_agent'
                ? manager.waitAgent(parent, ['worker'])
                : manager.waitAllAgents(parent, ['worker']);
          },
        });
        let resuming: Promise<unknown> | undefined;
        try {
          await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
          const info = manager.getAgentInfo('worker', parent);
          await released(manager, info);
          const original = manager['mailbox'].find((event) => event.agentName === '/worker')!;
          const rejected = rejectAfterInput(manager, info, gate);
          resuming = rejected.resuming;
          await rejected.entered;
          observeRollback = true;
          gate.resolve();
          expect(await resuming).toBeInstanceOf(Error);
          await released(manager, info);
          expect(callbackWait).toBeDefined();
          const result = await callbackWait;
          if (consumer === 'wait_agent')
            expect(result.event).toMatchObject({
              id: original.id,
              finalResponse: 'response:first',
            });
          else
            expect(result.responses).toEqual([
              expect.objectContaining({ finalResponse: 'response:first' }),
            ]);
          expect(manager['mailbox']).toEqual([]);
          expect(manager['defaultWaitAllTargets'].get(parent)?.has('/worker') ?? false).toBe(false);
          expect(notifications).toHaveLength(1);
          expect(rejected.state.instances[0].requests).toEqual([]);
        } finally {
          observeRollback = false;
          gate.resolve();
          await resuming;
          await callbackWait;
          await manager.shutdown();
        }
      },
    );

    test.each(['wait_agent', 'wait_all_agents'])(
      'does not replay a completion already consumed by %s',
      async (consumer) => {
        const gate = deferred();
        const parent = 'consumed-rollback-' + randomUUID();
        const notifications: any[] = [];
        const manager = new AgentManager({
          onUnclaimedCompletion: (event) => notifications.push(event),
        });
        const controller = new AbortController();
        let resuming: Promise<unknown> | undefined;
        let waiting: Promise<any> | undefined;
        try {
          await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
          const info = manager.getAgentInfo('worker', parent);
          await released(manager, info);
          if (consumer === 'wait_agent') await manager.waitAgent(parent, ['worker']);
          else await manager.waitAllAgents(parent, ['worker']);
          expect(manager['mailbox']).toEqual([]);
          const rejected = rejectAfterInput(manager, info, gate);
          resuming = rejected.resuming;
          await rejected.entered;
          gate.resolve();
          expect(await resuming).toBeInstanceOf(Error);
          await released(manager, info);
          expect(rejected.state.instances[0].requests).toEqual([]);
          expect(manager['mailbox']).toEqual([]);
          expect(manager['defaultWaitAllTargets'].get(parent)?.has('/worker') ?? false).toBe(false);
          expect((await manager.waitAllAgents(parent)).responses).toEqual([]);
          expect(notifications).toHaveLength(1);
          expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:first');

          // A next-completion wait belongs to the next accepted turn.
          waiting = manager.waitAgent(parent, undefined, controller.signal);
          expect(manager['waiters']).toHaveLength(1);
          fixture = configureCoreFixture();
          await manager.sendMessage(parent, 'worker', 'second');
          expect((await waiting).event).toMatchObject({
            status: 'completed',
            finalResponse: 'response:second',
          });
          await released(manager, info);
          expect(notifications).toHaveLength(1);
        } finally {
          controller.abort();
          gate.resolve();
          await resuming;
          await waiting?.catch(() => {});
          await manager.shutdown();
        }
      },
    );

    test('restores a targeted waiter without satisfying an unscoped next-completion waiter', async () => {
      const gate = deferred();
      const parent = 'rollback-waiter-kinds-' + randomUUID();
      const manager = new AgentManager();
      const controller = new AbortController();
      let resuming: Promise<unknown> | undefined;
      let anyWait: Promise<any> | undefined;
      let targetedWait: Promise<any> | undefined;
      let anyResult: any;
      let targetedResult: any;
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
        const info = manager.getAgentInfo('worker', parent);
        await released(manager, info);
        await manager.waitAgent(parent, ['worker']);
        const rejected = rejectAfterInput(manager, info, gate);
        resuming = rejected.resuming;
        await rejected.entered;
        anyWait = manager.waitAgent(parent, undefined, controller.signal).then(
          (result) => {
            anyResult = result;
            return result;
          },
          (error) => error,
        );
        targetedWait = manager.waitAgent(parent, ['worker'], controller.signal).then(
          (result) => {
            targetedResult = result;
            return result;
          },
          (error) => error,
        );
        expect(manager['waiters']).toHaveLength(2);
        gate.resolve();
        expect(await resuming).toBeInstanceOf(Error);
        await released(manager, info);
        expect(anyResult).toBeUndefined();
        expect(targetedResult?.event).toMatchObject({
          status: 'completed',
          finalResponse: 'response:first',
        });
        expect(manager['waiters']).toHaveLength(1);
        expect(manager['mailbox']).toEqual([]);
      } finally {
        controller.abort();
        gate.resolve();
        await resuming;
        await anyWait;
        await targetedWait;
        await manager.shutdown();
      }
    });

    test.each(['during input', 'after rejection', 'interrupt'])(
      'preserves wait-all notification ownership: %s',
      async (phase) => {
        const responseA = deferred(),
          responseB = deferred(),
          input = deferred();
        const parent = 'rollback-claims-' + randomUUID();
        const notifications: any[] = [];
        const manager = new AgentManager({
          onUnclaimedCompletion: (event) => notifications.push(event),
        });
        const first = new AbortController(),
          second = new AbortController();
        let firstWait: Promise<any> | undefined, secondWait: Promise<any> | undefined;
        let resuming: Promise<unknown> | undefined;
        try {
          fixture = configureCoreFixture({ responseGate: responseA.promise });
          await manager.spawnAgent(spawnParams(parent, 'a', 'hold result A'));
          const infoA = manager.getAgentInfo('a', parent);
          fixture = configureCoreFixture({ responseGate: responseB.promise });
          await manager.spawnAgent(spawnParams(parent, 'b', 'hold result B'));
          firstWait = manager
            .waitAllAgents(parent, ['a', 'b'], first.signal)
            .catch((error) => error);
          secondWait = manager
            .waitAllAgents(parent, ['a', 'b'], second.signal)
            .catch((error) => error);
          responseA.resolve();
          await released(manager, infoA);
          const originalEvent = manager['mailbox'].find((event) => event.agentName === '/a')!;
          expect(originalEvent).toBeDefined();
          expect(
            [...manager['waitAllClaims']].every((claim) =>
              claim.suppressedEventIds.has(originalEvent.id),
            ),
          ).toBe(true);
          expect(notifications).toEqual([]);

          const rejected = rejectAfterInput(manager, infoA, input);
          resuming = rejected.resuming;
          await rejected.entered;
          first.abort(new Error('first claim canceled'));
          expect(await firstWait).toBeInstanceOf(Error);
          expect(notifications).toEqual([]); // The second claim still owns the notification.

          if (phase === 'during input') {
            second.abort(new Error('last claim canceled during input'));
            expect(await secondWait).toBeInstanceOf(Error);
            expect(notifications).toEqual([
              expect.objectContaining({ id: originalEvent.id, agentName: '/a' }),
            ]);
          }
          if (phase === 'interrupt') {
            const interrupting = manager.interruptAgent(parent, 'a');
            await waitUntil(() => manager.getAgentInfo('a', parent).status === 'interrupted');
            input.resolve();
            await interrupting;
          } else input.resolve();
          expect(await resuming).toBeInstanceOf(Error);
          await released(manager, infoA);

          const currentEvent = manager['mailbox'].find((event) => event.agentName === '/a')!;
          if (phase === 'interrupt') {
            expect(currentEvent).toMatchObject({ status: 'interrupted' });
            expect(currentEvent.id).not.toBe(originalEvent.id);
          } else {
            expect(currentEvent).toBe(originalEvent);
            expect(rejected.state.instances[0].requests).toEqual([]);
          }
          if (phase !== 'during input') {
            second.abort(new Error('last claim canceled'));
            expect(await secondWait).toBeInstanceOf(Error);
          }
          expect(notifications).toEqual(
            phase === 'interrupt'
              ? []
              : [
                  expect.objectContaining({
                    id: originalEvent.id,
                    agentName: '/a',
                    finalResponse: 'response:hold result A',
                  }),
                ],
          );
        } finally {
          first.abort();
          second.abort();
          input.resolve();
          responseA.resolve();
          responseB.resolve();
          await resuming;
          await firstWait;
          await secondWait;
          await manager.shutdown();
        }
      },
    );
  });

  test.each(['before', 'after'])(
    'a compaction-only busy session cannot report steer acceptance (%s await)',
    async (phase) => {
      const gate = deferred();
      const parent = 'compaction-only-steer-' + phase + '-' + randomUUID();
      const manager = new AgentManager();
      let session: any;
      let steer: ReturnType<typeof spyOn> | undefined;
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', 'hold run'));
        await waitUntil(() => fixture.instances[0].activeStreams === 1);
        const info = manager.getAgentInfo('worker', parent);
        session = manager['live'].get(info.id)!.session!;
        const compactionOnly = () => {
          // Manual compaction keeps the session busy while its agent stream is inactive.
          Object.defineProperty(session, 'isStreaming', { configurable: true, get: () => false });
          Object.defineProperty(session, 'isIdle', { configurable: true, get: () => false });
        };
        if (phase === 'before') {
          compactionOnly();
          steer = spyOn(session, 'steer');
          await expect(manager.sendMessage(parent, 'worker', 'must not queue')).rejects.toThrow(
            /finishing|stream|running|delivery/i,
          );
          expect(steer).not.toHaveBeenCalled();
        } else {
          steer = spyOn(session, 'steer').mockImplementation(async () => {
            await gate.promise;
            compactionOnly();
            return 'queued';
          });
          const pending = manager.sendMessage(parent, 'worker', 'must not claim delivery').then(
            () => undefined,
            (error) => error,
          );
          await waitUntil(() => manager['live'].get(info.id)!.pendingSteers.size === 1);
          gate.resolve();
          expect(await pending).toBeInstanceOf(Error);
          expect(manager.getAgentInfo('worker', parent).lastTaskMessage).toBe('hold run');
        }
        expect(fixture.instances).toHaveLength(1);
      } finally {
        gate.resolve();
        steer?.mockRestore();
        if (session) {
          delete session.isStreaming;
          delete session.isIdle;
        }
        await manager.shutdown();
      }
    },
  );

  test('an extension recovery after an aborted settled boundary uses the final successful settled result', async () => {
    let recovered = false;
    fixture = configureCoreFixture({
      onSettled(aborted, pi) {
        if (aborted && !recovered) {
          recovered = true;
          pi.sendUserMessage('recovered successfully');
        }
      },
    });
    const parent = 'aborted-settled-recovery-' + randomUUID();
    const notifications: any[] = [];
    const manager = new AgentManager({
      onUnclaimedCompletion: (event) => notifications.push(event),
    });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold original'));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo('worker', parent);
      const session = manager['live'].get(info.id)!.session!;
      // Native abort determines terminal status in this case.
      await session.abort();
      await released(manager, info);
      expect(fixture.instances[0].events.filter((event) => event.startsWith('settled:'))).toEqual([
        'settled:aborted',
        'settled:success',
      ]);
      expect(manager.readAgentResponse('worker', parent)).toMatchObject({
        status: 'completed',
        finalResponse: 'response:recovered successfully',
      });
      expect(notifications).toEqual([
        expect.objectContaining({
          status: 'completed',
          finalResponse: 'response:recovered successfully',
        }),
      ]);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fixture.instances[0].requests.map((request) => request.text)).toEqual([
        'hold original',
        'recovered successfully',
      ]);
    } finally {
      await manager.shutdown();
    }
  });
});

describe('SDK cleanup ownership regressions', () => {
  // Track all logger streams, including detached instances.
  function trackLogStreams() {
    const streams: fs.WriteStream[] = [];
    const create = fs.createWriteStream;
    const spy = spyOn(fs, 'createWriteStream').mockImplementation((file, options) => {
      const stream = create(file, options);
      if (String(file).endsWith('.log')) streams.push(stream);
      return stream;
    });
    return {
      streams,
      async cleanup() {
        try {
          for (const stream of streams) {
            if (stream.closed) continue;
            const closed = once(stream, 'close');
            stream.destroy();
            await closed.catch(() => {});
          }
        } finally {
          spy.mockRestore();
        }
      },
    };
  }

  test('R1: startup abort reentry owns one cleanup chain until idempotent extension shutdown releases', async () => {
    const failStartup = deferred();
    const shutdownGate = deferred();
    const tracked = trackLogStreams();
    const parent = 'reentrant-cleanup-owner-' + randomUUID();
    const manager = new AgentManager({ onError() {} });
    let timer: ReturnType<typeof setInterval> | undefined;
    let armed = false;
    let registeredBeforeAbort = false;
    let closing = false;
    let activeResources = 0;
    let freedResources = 0;
    let startupFailure: unknown;
    let pending: Promise<unknown> | undefined;
    let termination: Promise<void> | undefined;
    let dispose: ReturnType<typeof spyOn> | undefined;
    const firstFixture = (fixture = configureCoreFixture({
      async onStart(pi, ctx) {
        timer = setInterval(() => {}, 1000);
        activeResources++;
        // Start extension-owned work to expose the native cancellation signal.
        pi.sendUserMessage('hold startup-owned work');
        await waitUntil(() => Boolean(ctx.signal), 2000);
        ctx.signal!.addEventListener(
          'abort',
          () => {
            registeredBeforeAbort = Boolean([...manager['live'].values()][0]?.termination);
            ctx.shutdown(); // Native abort listeners run synchronously, reentering termination.
          },
          { once: true },
        );
        armed = true;
        await failStartup.promise;
        throw new Error('cleanup ownership startup failure');
      },
      async onShutdown() {
        if (closing) return;
        closing = true;
        await shutdownGate.promise;
        clearInterval(timer);
        activeResources--;
        freedResources++;
      },
    }));
    try {
      pending = manager
        .spawnAgent(spawnParams(parent, 'worker', 'not yet submitted'))
        .catch((error) => {
          startupFailure = error;
          return error;
        });
      await waitUntil(
        () =>
          startupFailure !== undefined || (armed && firstFixture.instances[0]?.activeStreams === 1),
        2000,
      );
      if (startupFailure !== undefined) throw startupFailure;
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      dispose = spyOn(live.session!, 'dispose');
      failStartup.resolve();
      await waitUntil(() => firstFixture.instances[0].shutdowns > 0);
      termination = live.termination;
      expect({
        registeredBeforeAbort,
        shutdowns: firstFixture.instances[0].shutdowns,
        disposals: dispose.mock.calls.length,
        liveRetained: manager['live'].get(info.id) === live,
        markerRetained: fs.existsSync(activeMarker(info.id)),
        activeResources,
        freedResources,
      }).toEqual({
        registeredBeforeAbort: true,
        shutdowns: 1,
        disposals: 0,
        liveRetained: true,
        markerRetained: true,
        activeResources: 1,
        freedResources: 0,
      });
      expect(manager['terminateSession'](live)).toBe(termination);
      await expect(
        manager.sendMessage(parent, 'worker', 'must not reopen the JSONL'),
      ).rejects.toThrow(/closing|finishing/i);
      expect(firstFixture.instances).toHaveLength(1);

      shutdownGate.resolve();
      const error = (await pending) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('cleanup ownership startup failure');
      await released(manager, info);
      expect(firstFixture.instances[0].shutdowns).toBe(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect([activeResources, freedResources]).toEqual([0, 1]);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);

      fixture = configureCoreFixture();
      await manager.sendMessage(parent, 'worker', 'reopen only after actual cleanup');
      await released(manager, info);
      expect(manager.getAgentInfo('worker', parent).sessionFile).toBe(info.sessionFile);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      failStartup.resolve();
      shutdownGate.resolve();
      clearInterval(timer);
      try {
        await pending;
        await termination?.catch(() => {});
        await manager.shutdown();
      } finally {
        dispose?.mockRestore();
        await tracked.cleanup();
      }
    }
  });

  test('R3: logging works while closing, but a closed logger stays inert when a new session appends', async () => {
    const responseGate = deferred();
    const shutdownGate = deferred();
    fixture = configureCoreFixture({
      responseGate: responseGate.promise,
      shutdownGate: shutdownGate.promise,
    });
    const tracked = trackLogStreams();
    const parent = 'logger-close-owner-' + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold logger run'));
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      live.logger.info('regression', 'normal write');
      expect(tracked.streams).toHaveLength(1);
      const original = tracked.streams[0];

      responseGate.resolve();
      await waitUntil(() => fixture.instances[0].shutdowns === 1);
      expect(live.closing).toBe(true);
      expect(original.writableEnded).toBe(false);
      live.logger.info('regression', 'closing write');
      expect(tracked.streams).toHaveLength(1);
      shutdownGate.resolve();
      await released(manager, info);
      await waitUntil(() => original.closed);
      live.logger.close();
      live.logger.close();
      const mkdir = spyOn(fs, 'mkdirSync');
      let mkdirCalls = -1;
      try {
        live.logger.info('regression', 'must not write after close');
        mkdirCalls = mkdir.mock.calls.length;
      } finally {
        mkdir.mockRestore();
      }

      fixture = configureCoreFixture();
      await manager.sendMessage(parent, 'worker', 'hold restored logger');
      const restored = manager['live'].get(info.id)!;
      expect(restored.logger).not.toBe(live.logger);
      restored.logger.info('regression', 'restored append');
      const restoredStream = tracked.streams.at(-1)!;
      await manager.interruptAgent(parent, 'worker');
      await released(manager, info);
      await waitUntil(() => restoredStream.closed);
      expect(mkdirCalls).toBe(0);
      expect(tracked.streams).toHaveLength(2);
      expect(tracked.streams.every((stream) => stream.closed)).toBe(true);
      const messages = fs
        .readFileSync(info.logFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.category === 'regression')
        .map((entry) => entry.message);
      expect(messages).toEqual(['normal write', 'closing write', 'restored append']);
    } finally {
      responseGate.resolve();
      shutdownGate.resolve();
      try {
        await manager.shutdown();
      } finally {
        await tracked.cleanup();
      }
    }
  });

  test('R3: repeated close before the first write cannot mkdir or create a stream', async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const tracked = trackLogStreams();
    const manager = new AgentManager();
    const parent = 'logger-never-opened-' + randomUUID();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold never logged'));
      const info = manager.getAgentInfo('worker', parent);
      const logger = manager['live'].get(info.id)!.logger;
      expect(tracked.streams).toHaveLength(0);
      logger.close();
      logger.close();
      const mkdir = spyOn(fs, 'mkdirSync');
      try {
        logger.info('regression', 'must stay unopened');
        expect(mkdir).not.toHaveBeenCalled();
        expect(tracked.streams).toHaveLength(0);
        expect(logger['stream']).toBeNull();
      } finally {
        mkdir.mockRestore();
      }
    } finally {
      gate.resolve();
      try {
        await manager.shutdown();
      } finally {
        await tracked.cleanup();
      }
    }
  });

  test.each(['onError', 'console'] as const)(
    'R3: shutdown timeout and late hook errors reach %s without reopening any log stream',
    async (sink) => {
      const gate = deferred();
      const lateError = 'late cleanup hook failure ' + sink;
      fixture = configureCoreFixture({
        shutdownGate: gate.promise,
        onShutdown() {
          throw new Error(lateError);
        },
      });
      const tracked = trackLogStreams();
      const hostErrors: string[] = [];
      const consoleSpy =
        sink === 'console'
          ? spyOn(console, 'error').mockImplementation((...args: any[]) => {
              hostErrors.push(args.join(' '));
            })
          : undefined;
      const originalTimeout = globalThis.setTimeout;
      // Shorten the shutdown-hook deadline for the timeout assertion.
      const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: any,
        ms: number,
        ...args: any[]
      ) => originalTimeout(callback, ms === 5000 ? 100 : ms, ...args)) as typeof setTimeout);
      const manager = new AgentManager(
        sink === 'onError' ? { onError: (error) => hostErrors.push(error.message) } : {},
      );
      const parent = 'logger-late-cleanup-' + randomUUID();
      let dispose: ReturnType<typeof spyOn> | undefined;
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
        const info = manager.getAgentInfo('worker', parent);
        const live = manager['live'].get(info.id)!;
        dispose = spyOn(live.session!, 'dispose');
        live.logger.info('regression', 'before shutdown deadline');
        expect(tracked.streams).toHaveLength(1);
        const original = tracked.streams[0];
        await waitUntil(() => fixture.instances[0].shutdowns === 1);
        await released(manager, info);
        await waitUntil(() =>
          hostErrors.some((message) => message.includes('session_shutdown timed out')),
        );
        // The deadline must dispose and release ownership before the blocked hook exits.
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(activeMarker(info.id))).toBe(false);
        gate.resolve();
        await waitUntil(() => hostErrors.some((message) => message.includes(lateError)));
        await waitUntil(() => original.closed);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(fixture.instances[0].shutdowns).toBe(1);
        expect(manager.readAgentResponse('worker', parent).status).toBe('completed');
        expect(fs.existsSync(activeMarker(info.id))).toBe(false);
        expect({
          createdStreams: tracked.streams.length,
          openStreams: tracked.streams.filter((stream) => !stream.closed).length,
          loggerRetainsStream: live.logger['stream'] !== null,
        }).toEqual({ createdStreams: 1, openStreams: 0, loggerRetainsStream: false });
      } finally {
        gate.resolve();
        try {
          await manager.shutdown();
        } finally {
          dispose?.mockRestore();
          timers.mockRestore();
          consoleSpy?.mockRestore();
          await tracked.cleanup();
        }
      }
    },
  );
});
