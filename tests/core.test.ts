import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  configureCoreFixture,
  ObserverJsonlDecoder,
  useTestAgentDir,
  waitUntil,
  type CoreFixtureState,
} from './fixtures/core-sdk-fixture.js';
import type { AgentInfo, AgentResponseEntry } from '../src/core.js';
import {
  getCurrentSystemMessage,
  parseStreamingJson,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
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
  formatAgentError,
  formatContextUsage,
  normalizeContextUsage,
  readInfoFile,
  getAgent,
  getAgentDefinition,
  getAgentDefinitionsDescription,
  listAgentDefinitions,
  getRunsDir,
  getSocketPath,
  loadSubagentConfig,
  parentScopeKey,
  parseAgentDefinitionText,
  taskStorageKey,
  toObserverEvent,
} = await import('../src/core.js');

describe('observer stream reconstruction', () => {
  test('widget textPreview is bounded public text and never parses streaming tool arguments', () => {
    const broadcaster = new EventBroadcaster(randomUUID());
    const stream = broadcaster['assistantStream'];
    stream.start(assistant());
    stream.update({ type: 'thinking_start', contentIndex: 0 });
    stream.update({ type: 'thinking_delta', contentIndex: 0, delta: 'PRIVATE_THINKING' });
    startTool(stream, 1);
    stream.update({
      type: 'toolcall_delta',
      contentIndex: 1,
      delta: '{"secret":"PRIVATE_ARGUMENTS' + 'x'.repeat(32 * 1024),
    });
    const raw = stream.snapshotToolArguments();
    const parse = spyOn(JSON, 'parse');
    try {
      expect(stream.textPreview).toBeUndefined();
      stream.update({ type: 'text_start', contentIndex: 2 });
      const publicText = 'Public answer ' + 'a'.repeat(512);
      stream.update({
        type: 'text_delta',
        contentIndex: 2,
        delta: '\n  ' + publicText + '\nnot the preview',
      });
      for (let index = 0; index < 5; index++) {
        expect(stream.textPreview).toBe(publicText.slice(0, 180));
        expect(broadcaster.getWidgetActivity()).toEqual({
          activeTools: [],
          responsePreview: stream.textPreview,
        });
        expect(stream.textPreview).not.toMatch(/PRIVATE_|not the preview/);
      }
      expect(stream.snapshotToolArguments()).toEqual(raw);
      expect(parse).not.toHaveBeenCalled();
      stream.clear();
      expect(stream.textPreview).toBeUndefined();
    } finally {
      parse.mockRestore();
    }
  });

  test('widget activity tracks concurrent same-name call IDs without changing observer nesting or results', () => {
    const broadcaster = new EventBroadcaster(randomUUID());
    const emit = (type: string, toolCallId: string, extra: any = {}) =>
      broadcaster.broadcast({ type, toolCallId, toolName: 'codemode', ...extra });
    const active = broadcaster['activeTools'];
    emit('tool_execution_start', 'a', { args: { secret: 'PRIVATE_ARGUMENTS' } });
    emit('tool_execution_start', 'b');
    emit('tool_execution_start', 'top/read', { toolName: 'read' });
    for (const type of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end']) {
      emit(type, 'orphan/child', { parentToolCallId: 'missing' });
      emit(type, 'b', { parentToolCallId: 'a' });
    }
    const activity = broadcaster.getWidgetActivity();
    expect(activity).toEqual({
      activeTools: ['codemode', 'codemode', 'read'],
      responsePreview: undefined,
    });
    (activity.activeTools as string[]).pop();
    expect(broadcaster.getWidgetActivity().activeTools).toEqual(['codemode', 'codemode', 'read']);
    emit('tool_execution_end', 'a', { result: { content: [] }, isError: true });
    expect(broadcaster.getWidgetActivity().activeTools).toEqual(['codemode', 'read']);
    expect(broadcaster['activeTools']).toBe(active);
    expect(active.get('a')).toMatchObject({ result: { content: [] }, isError: true });
    expect(active.size).toBe(3); // Observer results survive until toolResult message_end.
    broadcaster.broadcast({
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'a' },
    });
    emit('tool_execution_end', 'b', { result: { content: [] } });
    expect(broadcaster.getWidgetActivity().activeTools).toEqual(['read']);
    broadcaster.broadcast({ type: 'agent_settled' });
    expect(broadcaster.getWidgetActivity()).toEqual({
      activeTools: [],
      responsePreview: undefined,
    });
    expect(active.size).toBe(0);
  });

  test('widget activity retains bounded final text through tool results and clears it on user/settled', () => {
    const broadcaster = new EventBroadcaster(randomUUID());
    const final = assistant([
      { type: 'thinking', thinking: 'PRIVATE_THINKING' },
      { type: 'toolCall', id: 'call-0', name: 'read', arguments: { secret: 'PRIVATE_ARGUMENTS' } },
      { type: 'text', text: '\nPublic answer ' + 'x'.repeat(512) + '\nsecond line' },
    ]);
    broadcaster.broadcast({ type: 'message_start', message: final });
    const preview = broadcaster.getWidgetActivity().responsePreview!;
    expect(preview).toBe(('Public answer ' + 'x'.repeat(512)).slice(0, 180));
    expect(preview).not.toMatch(/PRIVATE_|second line/);
    broadcaster.broadcast({ type: 'message_end', message: final });
    expect(broadcaster['assistantStream'].textPreview).toBeUndefined();
    expect(broadcaster.getWidgetActivity().responsePreview).toBe(preview);
    broadcaster.broadcast({
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'call-0' },
    });
    broadcaster.broadcast({
      type: 'message_start',
      message: assistant([{ type: 'thinking', thinking: 'PRIVATE_THINKING' }]),
    });
    expect(broadcaster.getWidgetActivity().responsePreview).toBe(preview);
    broadcaster.broadcast({
      type: 'message_start',
      message: { role: 'user', content: 'next task' },
    });
    expect(broadcaster.getWidgetActivity().responsePreview).toBeUndefined();
    broadcaster.broadcast({ type: 'message_end', message: final });
    expect(broadcaster.getWidgetActivity().responsePreview).toBe(preview);
    broadcaster.broadcast({ type: 'agent_settled' });
    expect(broadcaster.getWidgetActivity().responsePreview).toBeUndefined();
  });
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
    const args = {
      code: '中文😀\n"quoted"\\tail',
      nested: { items: [1, { ok: true }], empty: null },
    };
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
        expect(stream.snapshotToolArguments()).toEqual(
          source === 'toolcall_start' ? [[0, '']] : [],
        );
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
  test.each([
    ['color: " ReD "', '#DC2626'],
    ['color: neon-cyan', '#06B6D4'],
    ['color: " MeTaLlIc-BlUe "', '#3B82F6'],
    ['color: #aAbBcC', '#AABBCC'],
    ['color: "#007777"', '#007777'],
    ['color: invalid', undefined],
    ['color: "#123"', undefined],
    ['color: {}', undefined],
    ['color:', undefined],
    ['', undefined],
  ])('parses optional badge configuration %s without changing the template', (field, color) => {
    expect(
      parseAgentDefinitionText(
        '---\nname: reviewer\n' + field + '\nmodel: fake\n---\nInstructions.',
        'fallback',
      ),
    ).toMatchObject({ name: 'reviewer', color, model: 'fake', prompt: 'Instructions.' });
  });

  test('template listing initializes only the templates directory', () => {
    const mkdir = spyOn(fs, 'mkdirSync');
    const read = spyOn(fs, 'readFileSync');
    const write = spyOn(fs, 'writeFileSync');
    const chmod = spyOn(fs, 'chmodSync');
    try {
      expect(listAgentDefinitions().map(({ name }) => name)).toEqual([
        'explorer',
        'general',
        'worker',
      ]);
      expect(fs.readdirSync(path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents'))).toEqual([]);
      expect(mkdir.mock.calls.map(([directory]) => String(directory))).toEqual([
        path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents'),
      ]);
      expect(read.mock.calls.some(([file]) => String(file) === configFile)).toBe(false);
      expect(write).not.toHaveBeenCalled();
      expect(chmod).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
      read.mockRestore();
      write.mockRestore();
      chmod.mockRestore();
    }
  });

  test('built-ins inherit runtime settings and separate delegation from child instructions', () => {
    const definitions = listAgentDefinitions();
    for (const definition of definitions) {
      expect(definition.provider).toBeUndefined();
      expect(definition.model).toBeUndefined();
      expect(definition.thinking).toBeUndefined();
      expect(definition.tools).toBeUndefined();
      expect(definition.extensions).toBeUndefined();
    }
    expect(getAgentDefinition('explorer')?.color).toBe('#10B981');
    expect(getAgentDefinition('explorer')?.prompt).toBeUndefined();
    expect(getAgentDefinition('general')?.color).toBe('#06B6D4');
    expect(getAgentDefinition('general')?.prompt).toBeUndefined();
    const worker = getAgentDefinition('worker')!;
    expect(worker.color).toBe('#F43F5E');
    expect(worker.description).toContain('Explicitly assign ownership');
    expect(worker.description).not.toContain('You are not alone in the codebase');
    expect(worker.prompt).toContain('You are not alone in the codebase');
    expect(worker.prompt).toContain('you should not revert the edits made by others');
    expect(getAgentDefinitionsDescription()).not.toContain(worker.prompt!);
    expect(getAgentDefinition()).toBeUndefined();
    expect(getAgentDefinition('generic')).toBeUndefined();
    expect(getAgentDefinition('missing')).toBeUndefined();
  });

  test.each(['explorer', 'general', 'worker'])(
    'a user template replaces the entire built-in %s definition by effective name',
    (name) => {
      const file = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents', 'custom-override.md');
      const text = '---\nname: ' + name + '\ndescription: Custom role.\n---\n';
      const original = getAgentDefinition(name);
      fs.writeFileSync(file, text);
      try {
        expect(getAgentDefinition(name)).toEqual(parseAgentDefinitionText(text, 'custom-override'));
        expect(
          listAgentDefinitions().filter((definition) => definition.name === name),
        ).toHaveLength(1);
        const description = getAgentDefinitionsDescription();
        expect(
          description.split('\n').filter((line) => line.startsWith('- `' + name + '`')),
        ).toEqual(['- `' + name + '` — Custom role.']);
        // Edits and deletion take effect for subsequent lookups without a cache.
        fs.writeFileSync(file, text + 'Custom child instructions.');
        expect(getAgentDefinition(name)?.prompt).toBe('Custom child instructions.');
      } finally {
        fs.rmSync(file, { force: true });
      }
      expect(getAgentDefinition(name)).toEqual(original);
    },
  );

  test('duplicate user names retain first-discovered precedence and are listed only once', () => {
    const directory = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents');
    const files = ['first-duplicate.md', 'second-duplicate.md'];
    for (const file of files)
      fs.writeFileSync(
        path.join(directory, file),
        '---\nname: worker\ndescription: ' + file + '\n---',
      );
    try {
      const first = fs.readdirSync(directory).find((file) => files.includes(file))!;
      expect(getAgentDefinition('worker')?.description).toBe(first);
      expect(listAgentDefinitions().filter(({ name }) => name === 'worker')).toHaveLength(1);
      expect(
        getAgentDefinitionsDescription()
          .split('\n')
          .filter((line) => line.startsWith('- `worker`')),
      ).toEqual(['- `worker` — ' + first]);
    } finally {
      for (const file of files) fs.rmSync(path.join(directory, file), { force: true });
    }
  });

  test('invalid overrides warn and leave built-ins and other valid templates available', () => {
    const directory = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents');
    const invalid = path.join(directory, 'worker.md');
    const valid = path.join(directory, 'valid-override.md');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const worker = getAgentDefinition('worker');
    try {
      fs.writeFileSync(invalid, '---\nname: worker\ndescription: |0\n  Invalid.\n---');
      fs.writeFileSync(valid, '---\nname: custom-valid\n---\nValid instructions.');
      const definitions = listAgentDefinitions();
      expect(definitions.find(({ name }) => name === 'worker')).toEqual(worker);
      expect(definitions.find(({ name }) => name === 'custom-valid')?.prompt).toBe(
        'Valid instructions.',
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(invalid);
    } finally {
      warn.mockRestore();
      fs.rmSync(invalid, { force: true });
      fs.rmSync(valid, { force: true });
    }
  });

  test('returned built-in definitions cannot mutate subsequent lookups', () => {
    const worker = getAgentDefinition('worker')!;
    const original = { ...worker };
    worker.name = 'changed';
    worker.model = 'unavailable';
    worker.description = 'Changed description.';
    worker.prompt = 'Changed prompt.';
    worker.color = '#000000';
    expect(getAgentDefinition('worker')).toEqual(original);
    expect(getAgentDefinition('changed')).toBeUndefined();
  });

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
      prompt: 'Review the requested files.',
    });
    expect(Object.hasOwn(definition, 'skills')).toBe(false);
  });

  test.each(['\n', '\r\n'])(
    'parses multiline description without changing other fields (%j)',
    (newline) => {
      const definition = parseAgentDefinitionText(
        [
          '---',
          'name: explorer',
          'description: |- # keep structure',
          '  Use explorer: # literal text',
          '  <rules>',
          '    <rule>Reuse & trust "results".</rule>',
          '  </rules>',
          '',
          '    model: not-a-route',
          '  ---',
          'provider: " template-provider "',
          'model: " template-model "',
          'thinking: off',
          'tools:',
          'extensions: @scope/tools, ~/.pi/helper.ts',
          '---',
          'Child instructions.',
          'description: this belongs to the body',
        ].join(newline),
        'fallback',
      );
      expect(definition).toEqual({
        name: 'explorer',
        description:
          'Use explorer: # literal text\n<rules>\n  <rule>Reuse & trust "results".</rule>\n</rules>\n\n  model: not-a-route\n---',
        provider: 'template-provider',
        model: 'template-model',
        thinking: 'off',
        tools: '',
        extensions: ['@scope/tools', '~/.pi/helper.ts'],
        prompt: ['Child instructions.', 'description: this belongs to the body'].join(newline),
      });
    },
  );

  test.each([
    ['|', 'First.\nSecond.\n'],
    ['|-', 'First.\nSecond.'],
    ['|+', 'First.\nSecond.\n\n'],
    ['>', 'First. Second.\n'],
    ['>-', 'First. Second.'],
    ['>+', 'First. Second.\n\n'],
    ['|2-', 'First.\nSecond.'],
    ['>-2 # explicit indent', 'First. Second.'],
  ])('uses native YAML block semantics for description: %s', (style, expected) => {
    const definition = parseAgentDefinitionText(
      [
        '---',
        'description: ' + style,
        '  First.',
        '  Second.',
        '',
        'model: fake',
        '---',
        'Body.',
      ].join('\n'),
      'fallback',
    );
    expect(definition.description).toBe(expected);
    expect(definition.model).toBe('fake');
    expect(definition.prompt).toBe('Body.');
  });

  test.each(['|', '|-', '|+', '>', '>-', '>+'])(
    'preserves native block endings before another field and at the end of frontmatter: %s',
    (style) => {
      for (const blankLines of [0, 1, 2]) {
        const block = [
          'description: ' + style,
          '  First.',
          '  Second.',
          ...Array(blankLines).fill(''),
        ];
        // Keep a following key in the native reference so the SDK preserves the YAML's final newline.
        const expected = codingAgent.parseFrontmatter(
          ['---', ...block, 'model: fake', '---'].join('\n'),
        ).frontmatter.description;
        for (const newline of ['\n', '\r\n']) {
          for (const suffix of [[], ['model: fake']]) {
            const definition = parseAgentDefinitionText(
              ['---', ...block, ...suffix, '---', 'Body.'].join(newline),
              'fallback',
            );
            expect(definition.description).toBe(expected);
            expect(definition.prompt).toBe('Body.');
          }
        }
      }
    },
  );

  test('normalizes block headers without changing quoted markers or duplicate-key precedence', () => {
    const read = (text: string) =>
      parseAgentDefinitionText('---\n' + text + '\n---', 'fallback').description;
    expect(read('description:|-\n  First.\n  Second.')).toBe('First.\nSecond.');
    expect(read('description: "|"')).toBe('|');
    expect(read("description: '>-'")).toBe('>-');
    expect(read('description: inline\ndescription: |-\n  First.\n  Second.')).toBe(
      'First.\nSecond.',
    );
    expect(read('description: |-\n  First.\n  Second.\ndescription: inline')).toBe('inline');
  });

  test('preserves legacy inline values, ignored lines and last-key-wins behavior', () => {
    const description = String.raw`Rules: prefer # literal text. Keep \n literal and \"quotes\".`;
    expect(
      parseAgentDefinitionText(
        [
          '---',
          'name: initial',
          'description: "' + description + '"',
          'provider: on',
          'model: 123',
          'tools:',
          'extensions: @scope/tools, +codemode',
          'ignored line',
          '  ignored: nested text',
          'name: final',
          '---',
          'Body.',
        ].join('\n'),
        'fallback',
      ),
    ).toMatchObject({
      name: 'final',
      description,
      provider: 'on',
      model: '123',
      tools: '',
      extensions: ['@scope/tools', '+codemode'],
      prompt: 'Body.',
    });
    expect(
      parseAgentDefinitionText('---\ndescription: Rules: prefer # literal text\n---', 'fallback')
        .description,
    ).toBe('Rules: prefer # literal text');
    for (const marker of ['>', '|']) {
      expect(
        parseAgentDefinitionText(
          '---\ndescription: ' + marker + ' ordinary inline text\n---',
          'fallback',
        ),
      ).toMatchObject({ description: marker + ' ordinary inline text' });
    }
    expect(parseAgentDefinitionText('No frontmatter.\nBody.', 'fallback')).toMatchObject({
      name: 'fallback',
      prompt: 'No frontmatter.\nBody.',
    });
  });

  test('rejects malformed blocks instead of treating their markers as descriptions', () => {
    expect(() =>
      parseAgentDefinitionText('---\ndescription: |0\n  Text.\n---', 'fallback'),
    ).toThrow();
    expect(() =>
      parseAgentDefinitionText(
        '---\ndescription: |-\n   First.\n  Bad indentation.\n---',
        'fallback',
      ),
    ).toThrow();
  });

  test('reports an invalid template path without hiding valid templates', () => {
    const directory = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents');
    const valid = path.join(directory, 'valid-multiline.md');
    const invalid = path.join(directory, 'invalid-multiline.md');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(directory, { recursive: true });
    try {
      fs.writeFileSync(valid, '---\ndescription: |-\n  First.\n  Second.\n---');
      fs.writeFileSync(invalid, '---\ndescription: |0\n  Invalid.\n---');
      const definitions = listAgentDefinitions();
      expect(definitions.find(({ name }) => name === 'valid-multiline')?.description).toBe(
        'First.\nSecond.',
      );
      expect(definitions.some(({ name }) => name === 'invalid-multiline')).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(invalid);
    } finally {
      warn.mockRestore();
      fs.rmSync(valid, { force: true });
      fs.rmSync(invalid, { force: true });
    }
  });

  test('formats multiline descriptions separately from route metadata', () => {
    const directory = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents');
    const templates = {
      multiline:
        'description: |\n  Explore.\n\n  <rules>\n    <rule>Reuse & trust.</rule>\n  </rules>\n  Give paths.\n  - Narrow scope.\nmodel: fake\nthinking: high\nextensions: @scope/tools',
      'single-line': 'description: Inline description.\nmodel: fake',
    };
    fs.mkdirSync(directory, { recursive: true });
    try {
      for (const [name, fields] of Object.entries(templates)) {
        fs.writeFileSync(path.join(directory, name + '.md'), '---\n' + fields + '\n---');
      }
      const description = getAgentDefinitionsDescription();
      expect(description).toContain(
        [
          '- `multiline` — model: fake (inherited provider) — thinking: high — extensions: @scope/tools',
          '  Description:',
          '    Explore.',
          '    ',
          '    <rules>',
          '      <rule>Reuse & trust.</rule>',
          '    </rules>',
          '    Give paths.',
          '    - Narrow scope.',
        ].join('\n'),
      );
      expect(description).toContain(
        '- `single-line` — Inline description. — model: fake (inherited provider)',
      );
    } finally {
      for (const name of Object.keys(templates))
        fs.rmSync(path.join(directory, name + '.md'), { force: true });
    }
  });

  test.each(['defaults', 'default'])(
    'ignores retired %s sections without extension fallback',
    (key) => {
      const legacy = { skills: ['missing-retired-skill'], extensions: [CORE_SDK_EXTENSION] };
      for (const extensions of [undefined, [], {}]) {
        writeConfig({ extensions, [key]: legacy, retentionDays: 7 });
        expect(loadSubagentConfig()).toEqual({ retentionDays: 7 });
      }
      writeConfig({ extensions: ['+codemode'], [key]: legacy });
      expect(loadSubagentConfig()).toEqual({ extensions: ['+codemode'] });
    },
  );

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

  test.each([
    ['omitted', undefined, undefined],
    ['comma-separated', ' first, , second ', ['first', 'second']],
    ['mixed array', [' first ', null, 7, false, '', ' second '], ['first', 'second']],
    ['empty string', '', undefined],
    ['blank string', ' , , ', undefined],
    ['empty array', [], undefined],
    ['invalid object', {}, undefined],
    ['invalid scalar', false, undefined],
  ])('normalizes top-level configuration lists (%s)', (_label, value, expected) => {
    writeConfig({ models: value, extensions: value });
    expect(loadSubagentConfig()).toEqual(
      expected ? { models: expected, extensions: expected } : {},
    );
  });

  test('reuses a configuration snapshot without caching later storage changes', () => {
    writeConfig({ storageDir: 'first-runs' });
    const config = loadSubagentConfig();
    writeConfig({ storageDir: 'second-runs' });
    const read = spyOn(fs, 'readFileSync');
    try {
      expect(getRunsDir(config)).toBe(path.join(packageDir, 'first-runs'));
      expect(read).not.toHaveBeenCalled();
      expect(getRunsDir()).toBe(path.join(packageDir, 'second-runs'));
      expect(read.mock.calls.filter(([file]) => String(file) === configFile)).toHaveLength(1);
    } finally {
      read.mockRestore();
      fs.rmSync(configFile, { force: true });
    }
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

  test('reads metadata directly without filtering properties or rewriting the file', () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    const file = path.join(fixtureDir, randomUUID() + '.info.json');
    const metadata = {
      taskName: 'review/api',
      status: 'completed',
      tools: '',
      extensions: [],
      extra: { value: 1 },
    };
    const saved = JSON.stringify(metadata);
    try {
      fs.writeFileSync(file, saved);
      expect(readInfoFile(file)).toEqual(metadata);
      expect(fs.readFileSync(file, 'utf8')).toBe(saved);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('keeps disk history in creation order when activity changes', async () => {
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
          parentSessionId,
          status: 'completed',
          updatedAt: agent.lastActivity,
        }),
      );
    }

    const manager = new AgentManager();
    try {
      expect(
        manager.listAgentInfos(undefined, parentSessionId).map((agent) => agent.taskName),
      ).toEqual(['newer', 'older']);
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
        fs.writeFileSync(
          file,
          file === info ? JSON.stringify({ status: 'completed' }) : 'artifact',
        );
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
    socket.setEncoding('utf8');
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
      buffer += chunk;
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
  fs.writeFileSync(configFile, JSON.stringify({ extensions: [CORE_SDK_EXTENSION], ...config }));
}
let fixture: CoreFixtureState;
beforeEach(() => {
  fixture = configureCoreFixture();
  writeConfig();
});
async function settled(manager: InstanceType<typeof AgentManager>, info: AgentInfo) {
  await waitUntil(() => {
    const live = manager['live'].get(info.id);
    return !live || (!live.run && !live.closing);
  }, 7000);
}
async function released(manager: InstanceType<typeof AgentManager>, info: AgentInfo) {
  await waitUntil(() => !manager['live'].has(info.id), 7000);
}
async function coldDispose(manager: InstanceType<typeof AgentManager>, info: AgentInfo) {
  await settled(manager, info);
  const live = manager['live'].get(info.id);
  if (live) await manager['terminateSession'](live);
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

describe('task names', () => {
  test.each([
    [' Worker_1-A \t', 'Worker_1-A'],
    [' review/api \n', 'review/api'],
  ])('trims task names without changing path separators (%s)', async (input, taskName) => {
    const parent = 'task-name-' + randomUUID();
    const activity: string[] = [];
    const manager = new AgentManager({
      onActivityChange: (event) => {
        if (event.parentSessionId === parent) activity.push(event.taskName);
      },
    });
    try {
      expect(await manager.spawnAgent(spawnParams(parent, input, 'hold task'))).toEqual({
        task_name: taskName,
        nickname: null,
      });
      const info = manager.getAgentInfo(input, parent);
      expect(info.taskName).toBe(taskName);
      expect(info).not.toHaveProperty('canonicalName');
      expect(JSON.parse(fs.readFileSync(info.infoFile, 'utf8'))).not.toHaveProperty(
        'canonicalName',
      );
      expect(getAgent(input, parent)?.id).toBe(info.id);
      expect(manager.getWidgetSnapshot(parent)[0].taskName).toBe(taskName);
      expect(manager.listAgents(undefined, parent)).toEqual([
        { agent_name: taskName, agent_status: 'running' },
      ]);
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      expect(await manager.sendMessage(parent, input, 'hold steer')).toEqual({ delivery: 'steer' });
      await manager.interruptAgent(parent, input);
      await settled(manager, info);
      expect(manager.readAgentResponse(input, parent)).toMatchObject({
        agent_name: taskName,
        status: 'interrupted',
        last_task_message: 'hold steer',
      });
      expect(new Set(activity)).toEqual(new Set([taskName]));
    } finally {
      await manager.shutdown();
    }
  });

  test.each([
    '/worker',
    'worker/',
    '/review/api/',
    '//review/api',
    'review/api//',
    ' /worker ',
    ' worker/ ',
    '/',
    '',
    '   ',
    'review//api',
    'review/../api',
    'review api',
  ])('rejects invalid task names instead of accepting an alias (%s)', async (taskName) => {
    const parent = 'invalid-task-name-' + randomUUID();
    const manager = new AgentManager();
    try {
      await expect(
        manager.spawnAgent(spawnParams(parent, taskName, 'must not run')),
      ).rejects.toThrow('task_name must use');
      expect(() => getAgent(taskName, parent)).toThrow('task_name must use');
      expect(() => manager.getAgentInfo(taskName, parent)).toThrow('task_name must use');
      expect(() => manager.readAgentResponse(taskName, parent)).toThrow('task_name must use');
      await expect(manager.sendMessage(parent, taskName, 'must not run')).rejects.toThrow(
        'task_name must use',
      );
      await expect(manager.interruptAgent(parent, taskName)).rejects.toThrow('task_name must use');
      expect(manager.listAgentInfos(undefined, parent)).toEqual([]);
      expect(manager.listAgents(undefined, parent)).toEqual([]);
      expect(fixture.instances).toEqual([]);
    } finally {
      await manager.shutdown();
    }
  });
});

describe('resident agent lists', () => {
  test('includes startup and closing sessions until real cleanup deletes the resident', async () => {
    const startup = Promise.withResolvers<void>();
    const shutdown = Promise.withResolvers<void>();
    fixture.startupGate = startup.promise;
    fixture.shutdownGate = shutdown.promise;
    const parent = 'resident-lifecycle-' + randomUUID();
    let initialState:
      | {
          resident: boolean;
          hasSession: boolean;
          agents: ReturnType<InstanceType<typeof AgentManager>['listAgents']>;
        }
      | undefined;
    const manager = new AgentManager({
      onActivityChange(event) {
        if (event.parentSessionId !== parent || event.status !== 'starting') return;
        const live = [...manager['live'].values()].find(
          (entry) => entry.info.taskName === event.taskName,
        );
        initialState = {
          resident: live !== undefined,
          hasSession: live?.session !== undefined,
          agents: manager.listAgents(undefined, parent),
        };
      },
    });
    const spawning = manager.spawnAgent(spawnParams(parent, 'worker', 'hold work'));
    let stopping: Promise<void> | undefined;
    try {
      await waitUntil(() => fixture.instances[0]?.events.includes('session_start') ?? false);
      expect(initialState).toEqual({
        resident: true,
        hasSession: false,
        agents: [{ agent_name: 'worker', agent_status: 'starting' }],
      });
      const info = manager.getAgentInfo('worker', parent);
      expect(manager.listAgents(undefined, parent)).toEqual([
        { agent_name: 'worker', agent_status: 'starting' },
      ]);
      startup.resolve();
      await spawning;
      expect(manager.listAgents(undefined, parent)).toEqual([
        { agent_name: 'worker', agent_status: 'running' },
      ]);
      stopping = manager.shutdown();
      await waitUntil(() => fixture.instances[0].shutdowns === 1);
      expect(manager['live'].get(info.id)?.closing).toBe(true);
      for (let read = 0; read < 3; read++)
        expect(manager.listAgents(undefined, parent)).toEqual([
          { agent_name: 'worker', agent_status: 'interrupted' },
        ]);
      shutdown.resolve();
      await stopping;
      await released(manager, info);
      expect(manager.listAgents(undefined, parent)).toEqual([]);
      expect(manager.listAgentInfos(undefined, parent).map((entry) => entry.taskName)).toEqual([
        'worker',
      ]);
    } finally {
      startup.resolve();
      shutdown.resolve();
      await spawning.catch(() => {});
      await stopping;
      await manager.shutdown();
    }
  });

  test('reads residents without disk I/O, native initialization or LRU changes', async () => {
    writeConfig({ maxAgents: 2 });
    const parent = 'resident-readonly-' + randomUUID();
    const manager = new AgentManager();
    try {
      for (const task of ['old', 'new']) {
        await manager.spawnAgent(spawnParams(parent, task, 'finished ' + task));
        await settled(manager, manager.getAgentInfo(task, parent));
      }
      const old = manager.getAgentInfo('old', parent);
      const residents = [...manager['live'].values()];
      const recency = residents.map((live) => live.lastUsedAt);
      const infos = residents.map((live) => ({ ...live.info }));
      const reads = spyOn(fs, 'readFileSync');
      const scans = spyOn(fs, 'readdirSync');
      const exists = spyOn(fs, 'existsSync');
      const stats = spyOn(fs, 'statSync');
      const writes = spyOn(fs, 'writeFileSync');
      const history = spyOn(manager, 'listAgentInfos');
      try {
        for (let read = 0; read < 5; read++) {
          expect(manager.listAgents('old', parent)).toEqual([
            { agent_name: 'old', agent_status: 'completed' },
          ]);
          expect(manager.listAgents(undefined, parent)).toHaveLength(2);
          expect(manager.listAgents(undefined, 'other-parent')).toEqual([]);
        }
        for (const operation of [reads, scans, exists, stats, writes, history])
          expect(operation).not.toHaveBeenCalled();
        expect([...manager['live'].values()]).toEqual(residents);
        expect(residents.map((live) => live.lastUsedAt)).toEqual(recency);
        expect(residents.map((live) => live.info)).toEqual(infos);
        expect(fixture.instances).toHaveLength(2);
      } finally {
        for (const operation of [reads, scans, exists, stats, writes, history])
          operation.mockRestore();
      }
      await manager.spawnAgent(spawnParams(parent, 'replacement', 'hold replacement'));
      await released(manager, old);
      expect(
        manager
          .listAgents(undefined, parent)
          .map((entry) => entry.agent_name)
          .sort(),
      ).toEqual(['new', 'replacement']);
      expect(manager.listAgentInfos(undefined, parent)).toHaveLength(3);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally {
      await manager.shutdown();
    }
  });

  test('retains every hot terminal state while excluding cold history, other managers and parent scopes', async () => {
    writeConfig({ maxAgents: 6 });
    const parent = 'resident-list-' + randomUUID();
    const foreign = 'resident-foreign-' + randomUUID();
    const manager = new AgentManager();
    let observer: InstanceType<typeof AgentManager> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'review/cold', 'cold history'));
      const cold = manager.getAgentInfo('review/cold', parent);
      await coldDispose(manager, cold);
      expect(manager.listAgents(undefined, parent)).toEqual([]);
      for (const [task, message, status] of [
        ['review/done', 'finished', 'completed'],
        ['review/failed', 'fail request', 'failed'],
        ['review/stopped', 'hold until interrupted', 'interrupted'],
      ] as const) {
        await manager.spawnAgent(spawnParams(parent, task, message));
        const info = manager.getAgentInfo(task, parent);
        if (status === 'interrupted') await manager.interruptAgent(parent, task);
        await settled(manager, info);
        expect(manager['live'].get(info.id)?.info.status).toBe(status);
      }
      await manager.spawnAgent(spawnParams(parent, 'review/api', 'hold local'));
      await manager.spawnAgent(spawnParams(parent, 'review2', 'hold literal prefix'));
      await manager.spawnAgent(spawnParams(foreign, 'review/api', 'hold foreign'));
      const entries = manager.listAgents(undefined, parent);
      expect([...entries].sort((a, b) => a.agent_name.localeCompare(b.agent_name))).toEqual([
        { agent_name: 'review/api', agent_status: 'running' },
        { agent_name: 'review/done', agent_status: 'completed' },
        { agent_name: 'review/failed', agent_status: 'failed' },
        { agent_name: 'review/stopped', agent_status: 'interrupted' },
        { agent_name: 'review2', agent_status: 'running' },
      ]);
      expect(manager.listAgents('review', parent)).toEqual(
        entries.filter((entry) => entry.agent_name.startsWith('review/')),
      );
      for (const prefix of [' review/ \n', ' \t ', '/review', 'review//'])
        expect(() => manager.listAgents(prefix, parent)).toThrow('path_prefix');
      expect(manager.listAgents(undefined, foreign)).toEqual([
        { agent_name: 'review/api', agent_status: 'running' },
      ]);
      expect(manager.listAgents(undefined, 'unrelated-parent')).toEqual([]);
      const history = manager.listAgentInfos(undefined, parent);
      expect(history).toHaveLength(6);
      expect(history.map((info) => info.taskName)).toContain('review/cold');
      expect(history.every((info) => info.parentSessionId === parent)).toBe(true);
      expect(manager.listAgentInfos('review', parent)).toHaveLength(5);
      expect(() => manager.listAgentInfos(' review/ ', parent)).toThrow('path_prefix');
      expect(() => manager.listAgentInfos('/review', parent)).toThrow('path_prefix');
      observer = new AgentManager();
      await observer.ready();
      expect(observer.listAgents(undefined, parent)).toEqual([]);
      expect(observer.listAgents(undefined, foreign)).toEqual([]);
      expect(observer.listAgentInfos(undefined, parent)).toEqual(history);
      entries[0].agent_name = 'not-an-agent';
      expect(
        manager.listAgents(undefined, parent).some((entry) => entry.agent_name === 'not-an-agent'),
      ).toBe(false);
    } finally {
      await observer?.shutdown();
      await manager.shutdown();
    }
  });

  test('sorts residents by creation descending and UUID ties, not activity, status or insertion order', async () => {
    const parent = 'resident-sort-' + randomUUID();
    const manager = new AgentManager();
    try {
      for (const [task, message] of [
        ['old', 'hold old active'],
        ['newer', 'finished'],
        ['tie-a', 'fail request'],
        ['tie-b', 'hold interrupted'],
      ]) {
        await manager.spawnAgent(spawnParams(parent, task, message));
        const info = manager.getAgentInfo(task, parent);
        if (task === 'tie-b') await manager.interruptAgent(parent, task);
        if (task !== 'old') await settled(manager, info);
      }
      const infos = ['old', 'newer', 'tie-a', 'tie-b'].map(
        (task) => manager['live'].get(manager.getAgentInfo(task, parent).id)!.info,
      );
      for (let index = 0; index < infos.length; index++) {
        infos[index].createdAt = [10, 100, 50, 50][index];
        infos[index].updatedAt = infos[index].lastActivity = 1000 - index;
      }
      const ties = [infos[2], infos[3]].sort((a, b) => a.id.localeCompare(b.id));
      expect(manager.listAgents(undefined, parent)).toEqual(
        [infos[1], ...ties, infos[0]].map((info) => ({
          agent_name: info.taskName,
          agent_status: info.status,
        })),
      );
      expect([...manager['live'].keys()]).toEqual(infos.map((info) => info.id));
    } finally {
      await manager.shutdown();
    }
  });
});

describe('strict list path prefixes', () => {
  test('rejects malformed prefixes before reading empty resident or history lists', async () => {
    const manager = new AgentManager();
    await manager.ready();
    const parent = 'invalid-list-prefix-' + randomUUID();
    const reads = spyOn(fs, 'readFileSync');
    const scans = spyOn(fs, 'readdirSync');
    try {
      for (const prefix of [
        '', ' ', '\t', '\n', '/', '/review', '//review',
        'review/', 'review//', 'review//auth',
        ' review', 'review ', ' review ', 'review\n', 'review\r', 'review\r\n', 'review\t',
        'review auth', 'review/ auth', 'review/auth ', 'review\\auth',
        '.', '..', 'review/./auth', 'review/../auth',
        'review.auth', 'review/*', 'review?', 'review#auth', 'review:auth',
        'review%2fauth', '审查', 'review/\u0000auth', 'review\u2028', 'review\u2029',
      ]) {
        expect(() => manager.listAgents(prefix, parent)).toThrow('path_prefix');
        expect(() => manager.listAgentInfos(prefix, parent)).toThrow('path_prefix');
      }
      for (const prefix of [null, 123, true, false, [], ['review'], {}]) {
        expect(() => manager.listAgents(prefix as never, parent)).toThrow('path_prefix');
        expect(() => manager.listAgentInfos(prefix as never, parent)).toThrow('path_prefix');
      }
      expect(reads).not.toHaveBeenCalled();
      expect(scans).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      scans.mockRestore();
      await manager.shutdown();
    }
  });

  test('matches exact paths and descendants without matching sibling name prefixes', async () => {
    const tasks = [
      'review', 'review/auth', 'review/auth/session', 'review/auth2',
      'review2', 'reviewer', 'Review_1-A', 'Review_1-A/part', 'Review_1-A2',
    ];
    writeConfig({ maxAgents: tasks.length });
    const parent = 'list-path-boundaries-' + randomUUID();
    const manager = new AgentManager();
    try {
      for (const task of tasks) {
        await manager.spawnAgent(spawnParams(parent, task, 'finished ' + task));
        await settled(manager, manager.getAgentInfo(task, parent));
      }
      const lists = [
        (prefix?: string) => manager.listAgents(prefix, parent).map((entry) => entry.agent_name).sort(),
        (prefix?: string) => manager.listAgentInfos(prefix, parent).map((info) => info.taskName).sort(),
      ];
      for (const names of lists) {
        expect(names()).toEqual([...tasks].sort());
        expect(names('review')).toEqual([
          'review', 'review/auth', 'review/auth/session', 'review/auth2',
        ]);
        expect(names('review/auth')).toEqual(['review/auth', 'review/auth/session']);
        expect(names('review2')).toEqual(['review2']);
        expect(names('reviewer')).toEqual(['reviewer']);
        expect(names('Review_1-A')).toEqual(['Review_1-A', 'Review_1-A/part']);
        expect(names('Review')).toEqual([]);
        expect(names('missing')).toEqual([]);
      }
    } finally {
      await manager.shutdown();
    }
  });
});

describe('widget snapshots', () => {
  test.each(['warm', 'cold'] as const)(
    'captures template color for repeated instances, persistence and %s continuation',
    async (mode) => {
      const parent = 'configured-color-' + randomUUID();
      const directory = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents');
      fs.mkdirSync(directory, { recursive: true });
      const templates = [
        ['badge-valid', 'color: " ReD "', '#DC2626'],
        ['badge-absent', '', undefined],
        ['badge-invalid', 'color: "not-a-color"', undefined],
      ] as const;
      for (const [name, field] of templates)
        fs.writeFileSync(
          path.join(directory, name + '.md'),
          '---\nname: ' + name + '\n' + field + '\n---\nhold instructions.',
        );
      const manager = new AgentManager();
      try {
        const agents = [...templates, templates[0]].map(([type, , color], index) => ({
          type,
          color,
          name: 'worker-' + index,
        }));
        for (const { type, color, name } of agents) {
          expect(
            await manager.spawnAgent({
              ...spawnParams(parent, name, 'hold first'),
              agent_type: type,
            }),
          ).toEqual({ task_name: name, nickname: null });
          const info = manager.getAgentInfo(name, parent);
          expect(info.color).toBe(color);
          expect(JSON.parse(fs.readFileSync(info.infoFile, 'utf8')).color).toBe(color);
        }
        expect(
          manager
            .listAgentInfos(undefined, parent)
            .map((info) => info.color)
            .sort(),
        ).toEqual(agents.map((agent) => agent.color).sort());
        const firstSession = manager['live'].get(
          manager.getAgentInfo('worker-0', parent).id,
        )!.session;
        const reads = spyOn(fs, 'readFileSync'),
          scans = spyOn(fs, 'readdirSync'),
          writes = spyOn(fs, 'writeFileSync');
        try {
          for (let frame = 0; frame < 5; frame++) {
            const snapshots = manager.getWidgetSnapshot(parent);
            expect(snapshots.map((snapshot) => snapshot.color)).toEqual(
              agents.map((agent) => agent.color),
            );
            (snapshots[0] as any).color = '#FFFFFF';
          }
          expect(reads).not.toHaveBeenCalled();
          expect(scans).not.toHaveBeenCalled();
          expect(writes).not.toHaveBeenCalled();
        } finally {
          reads.mockRestore();
          scans.mockRestore();
          writes.mockRestore();
        }
        for (const { name } of agents) {
          const info = manager.getAgentInfo(name, parent);
          await manager.interruptAgent(parent, name);
          await settled(manager, info);
          if (mode === 'cold') await coldDispose(manager, info);
        }
        // The effective presentation value belongs to the original instance, not today's template.
        for (const [name] of templates)
          fs.writeFileSync(
            path.join(directory, name + '.md'),
            '---\nname: ' + name + '\ncolor: blue\n---\nChanged instructions.',
          );
        const readsOnResume = spyOn(fs, 'readFileSync');
        try {
          for (const { name, color } of agents) {
            expect(await manager.sendMessage(parent, name, 'hold continuation')).toEqual({
              delivery: 'prompt',
            });
            expect(manager.getAgentInfo(name, parent).color).toBe(color);
            expect(
              manager.getWidgetSnapshot(parent).find((snapshot) => snapshot.taskName === name)
                ?.color,
            ).toBe(color);
            expect(manager.readAgentResponse(name, parent)).not.toHaveProperty('color');
          }
          expect(
            readsOnResume.mock.calls.some(([file]) =>
              String(file).startsWith(directory + path.sep),
            ),
          ).toBe(false);
        } finally {
          readsOnResume.mockRestore();
        }
        const resumedSession = manager['live'].get(
          manager.getAgentInfo('worker-0', parent).id,
        )!.session;
        if (mode === 'warm') expect(resumedSession).toBe(firstSession);
        else expect(resumedSession).not.toBe(firstSession);
        for (const entry of manager.listAgents(undefined, parent))
          expect(Object.keys(entry).sort()).toEqual(['agent_name', 'agent_status']);
      } finally {
        await manager.shutdown();
        for (const [name] of templates)
          fs.rmSync(path.join(directory, name + '.md'), { force: true });
      }
    },
  );

  test('old and malformed saved colors resume as plain even when the current template has a color', async () => {
    const parent = 'old-color-' + randomUUID();
    const template = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents', 'old-badge.md');
    fs.mkdirSync(path.dirname(template), { recursive: true });
    fs.writeFileSync(template, '---\nname: old-badge\ncolor: cyan\n---\n');
    const manager = new AgentManager();
    try {
      await manager.spawnAgent({
        ...spawnParams(parent, 'worker', 'first'),
        agent_type: 'old-badge',
      });
      const first = manager.getAgentInfo('worker', parent);
      await coldDispose(manager, first);
      for (const color of [undefined, null, {}, ['red'], 123, 'toString', '__proto__', '#GGGGGG']) {
        const saved = JSON.parse(fs.readFileSync(first.infoFile, 'utf8'));
        if (color === undefined) delete saved.color;
        else saved.color = color;
        fs.writeFileSync(first.infoFile, JSON.stringify(saved));
        const original = fs.readFileSync(first.infoFile, 'utf8');
        expect(readInfoFile(first.infoFile)?.color).toBeUndefined();
        expect(fs.readFileSync(first.infoFile, 'utf8')).toBe(original); // Reading is not a migration.
        expect(await manager.sendMessage(parent, 'worker', 'hold old continuation')).toEqual({
          delivery: 'prompt',
        });
        expect(manager.getWidgetSnapshot(parent)[0].color).toBeUndefined();
        expect(manager.getAgentInfo('worker', parent).color).toBeUndefined();
        await manager.interruptAgent(parent, 'worker');
        await coldDispose(manager, first);
      }
    } finally {
      await manager.shutdown();
      fs.rmSync(template, { force: true });
    }
  });

  test('lifecycle notifications expose exact statuses, including interrupted without a completion notification', async () => {
    const parent = 'widget-statuses-' + randomUUID();
    const activity: Array<{ taskName: string; active: boolean; status?: AgentInfo['status'] }> = [];
    const completions: string[] = [];
    const manager = new AgentManager({
      onActivityChange: (event) => activity.push(event),
      onCompletion: (event) => completions.push(event.taskName),
    });
    try {
      await manager.spawnAgent(spawnParams(parent, 'success', 'first'));
      await settled(manager, manager.getAgentInfo('success', parent));
      await manager.spawnAgent(spawnParams(parent, 'failure', 'fail this request'));
      await settled(manager, manager.getAgentInfo('failure', parent));
      await manager.spawnAgent(spawnParams(parent, 'cancelled', 'hold until interrupted'));
      await waitUntil(() => fixture.instances.at(-1)!.activeStreams === 1);
      await manager.interruptAgent(parent, 'cancelled');
      expect(new Set(activity.map((event) => event.status))).toEqual(
        new Set(['starting', 'running', 'completed', 'failed', 'interrupted']),
      );
      for (const event of activity)
        expect(event.active).toBe(event.status === 'starting' || event.status === 'running');
      expect(
        activity.filter((event) => !event.active).map((event) => [event.taskName, event.status]),
      ).toEqual([
        ['success', 'completed'],
        ['failure', 'failed'],
        ['cancelled', 'interrupted'],
      ]);
      expect(completions).toEqual(['success', 'failure']);
      expect(manager.readAgentResponse('cancelled', parent).status).toBe('interrupted');
    } finally {
      await manager.shutdown();
    }
  });

  test('cumulates only assistant usage, caches by entry count/session identity, and is memory-only', async () => {
    const parent = 'widget-cache-' + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold source'));
      await manager.spawnAgent(spawnParams(parent, 'replacement', 'hold replacement'));
      await waitUntil(() => fixture.instances.every((instance) => instance.activeStreams === 1));
      await manager.spawnAgent(spawnParams(parent, 'finished', 'finished'));
      await settled(manager, manager.getAgentInfo('finished', parent));
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      const other = manager['live'].get(manager.getAgentInfo('replacement', parent).id)!;
      const source = live.session!,
        replacement = other.session!;
      const store = source.sessionManager,
        otherStore = replacement.sessionManager;
      const base = structuredClone(fixture.instances[0].requests[0].message);
      const usage = {
        ...base.usage,
        input: 10,
        output: 2,
        cacheWrite: 3,
        cacheRead: 10000,
        totalTokens: 99999,
      };
      const first = store.appendMessage({ ...base, stopReason: 'stop', usage });
      store.appendContextEdit(first, null); // Raw historical usage still counts after projection omits it.
      store.appendMessage({
        ...base,
        stopReason: 'error',
        usage: { ...usage, input: 7, output: 4, cacheWrite: 5 },
      });
      store.appendMessage({
        ...base,
        stopReason: 'aborted',
        usage: { ...usage, input: 11, output: 6, cacheWrite: 8 },
      });
      store.appendMessage({
        role: 'user',
        content: 'not assistant usage',
        timestamp: Date.now(),
        usage,
      } as any);
      store.appendMessage({
        role: 'toolResult',
        toolCallId: 'nested',
        toolName: 'read',
        content: [],
        isError: false,
        timestamp: Date.now(),
        usage,
      });
      store.appendUsage('cache_warm', 'test', 'fake', usage);
      store.appendCompaction('summary with separate usage', null, 100000, undefined, false, usage);
      store.appendCompaction('another compaction', null, 100000);
      otherStore.appendMessage({
        ...base,
        usage: { ...usage, input: 9, output: 0, cacheWrite: 0 },
      });
      while (otherStore.getEntryCount() < store.getEntryCount())
        otherStore.appendCustomEntry('padding');
      expect(otherStore.getEntryCount()).toBe(store.getEntryCount());
      live.info.contextUsage = { tokens: 22, contextWindow: 500000, percent: 0.0044 };
      const before = structuredClone(live.info),
        otherBefore = structuredClone(other.info);
      const savedInfo = fs.readFileSync(info.infoFile, 'utf8');
      const savedSession = fs.readFileSync(info.sessionFile, 'utf8');
      const scan = spyOn(store, 'getEntries'),
        otherScan = spyOn(otherStore, 'getEntries');
      const sample = spyOn(source, 'getContextUsage');
      const io = [
        spyOn(fs, 'readFileSync'),
        spyOn(fs, 'writeFileSync'),
        spyOn(fs, 'appendFileSync'),
        spyOn(fs, 'renameSync'),
        spyOn(fs, 'readdirSync'),
        spyOn(fs, 'statSync'),
        spyOn(fs, 'existsSync'),
      ];
      try {
        const snapshot = manager.getWidgetSnapshot(parent)[0];
        expect(snapshot).toMatchObject({
          tokens: 56,
          compactionCount: 2,
          contextUsage: before.contextUsage,
        });
        expect(snapshot.contextUsage).not.toBe(live.info.contextUsage);
        snapshot.contextUsage!.tokens = 999;
        for (let index = 0; index < 5; index++)
          expect(manager.getWidgetSnapshot(parent)[0].contextUsage).toEqual(before.contextUsage);
        expect(scan).toHaveBeenCalledTimes(1);
        expect(otherScan).toHaveBeenCalledTimes(1);
        expect(sample).not.toHaveBeenCalled();
        // Swap two real native sessions at the same entry count; identity must invalidate both caches.
        live.session = replacement;
        other.session = source;
        expect(manager.getWidgetSnapshot(parent).map((entry) => entry.tokens)).toEqual([9, 56]);
        expect(scan).toHaveBeenCalledTimes(2);
        expect(otherScan).toHaveBeenCalledTimes(2);
        for (const operation of io) expect(operation).not.toHaveBeenCalled();
        expect(live.info).toEqual(before);
        expect(other.info).toEqual(otherBefore);
      } finally {
        live.session = source;
        other.session = replacement;
        for (const operation of io) operation.mockRestore();
        sample.mockRestore();
      }
      expect(fs.readFileSync(info.infoFile, 'utf8')).toBe(savedInfo);
      expect(fs.readFileSync(info.sessionFile, 'utf8')).toBe(savedSession);
      manager.getWidgetSnapshot(parent);
      const scans = scan.mock.calls.length;
      // Native ordinary messages do not emit entry_appended; count alone must detect this append.
      store.appendMessage({ ...base, usage: { ...usage, input: 4, output: 0, cacheWrite: 0 } });
      expect(manager.getWidgetSnapshot(parent)[0].tokens).toBe(60);
      expect(manager.getWidgetSnapshot(parent)[0].tokens).toBe(60);
      expect(scan.mock.calls.length).toBe(scans + 1);
      scan.mockRestore();
      otherScan.mockRestore();
    } finally {
      await manager.shutdown();
    }
  });

  test.each(['warm', 'cold'] as const)(
    'restores historical tokens/compactions on %s resume, resetting only the display clock',
    async (mode) => {
      const gate = Promise.withResolvers<void>(),
        next = Promise.withResolvers<void>();
      fixture.responseGate = gate.promise;
      fixture.tokens = (text) => (text === 'first' ? 50 : 70);
      const parent = 'widget-resume-' + randomUUID();
      const manager = new AgentManager();
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
        const info = manager.getAgentInfo('worker', parent);
        const firstLive = manager['live'].get(info.id)!;
        const firstSession = firstLive.session!;
        const firstClock = firstLive.run!.displayStartedAt;
        const startedAt = info.startedAt;
        await settled(manager, info);
        if (mode === 'cold') await coldDispose(manager, info);
        const history =
          mode === 'warm'
            ? firstSession.sessionManager
            : codingAgent.SessionManager.open(
                info.sessionFile,
                path.dirname(info.sessionFile),
                info.cwd,
              );
        history.appendCompaction('historical widget compaction', null, 50);
        await manager.sendMessage(parent, 'worker', 'hold second');
        await waitUntil(() => fixture.instances.at(-1)!.activeStreams === 1);
        const live = manager['live'].get(info.id)!;
        if (mode === 'warm') expect(live.session).toBe(firstSession);
        else expect(live.session).not.toBe(firstSession);
        const run = live.run!,
          resumedAt = run.displayStartedAt;
        expect(resumedAt).toBeGreaterThan(firstClock);
        const clock = spyOn(Date, 'now').mockReturnValue(run.displayStartedAt + 1234);
        try {
          expect(manager.getWidgetSnapshot(parent)[0]).toMatchObject({
            tokens: 50,
            compactionCount: 1,
            elapsedMs: 1234,
          });
          expect(manager.getWidgetSnapshot(parent)[0].elapsedMs).toBe(1234);
        } finally {
          clock.mockRestore();
        }
        expect(await manager.sendMessage(parent, 'worker', 'hold steered')).toEqual({
          delivery: 'steer',
        });
        manager.getWidgetSnapshot(parent);
        expect(live.run).toBe(run);
        expect(live.run!.displayStartedAt).toBe(resumedAt);
        expect(live.info.startedAt).toBe(startedAt);
        expect(readInfoFile(info.infoFile)?.startedAt).toBe(startedAt);
        gate.resolve();
        await settled(manager, info);
        expect(manager.getWidgetSnapshot(parent)).toEqual([]);
        if (mode === 'cold') await coldDispose(manager, info);
        fixture.responseGate = next.promise;
        await manager.sendMessage(parent, 'worker', 'hold third');
        expect(manager.getWidgetSnapshot(parent)[0]).toMatchObject({
          tokens: 190,
          compactionCount: 1,
        });
        expect(manager.getAgentInfo('worker', parent).startedAt).toBe(startedAt);
        expect(readInfoFile(info.infoFile)?.startedAt).toBe(startedAt);
        expect(fixture.instances).toHaveLength(mode === 'warm' ? 1 : 3);
      } finally {
        gate.resolve();
        next.resolve();
        await manager.shutdown();
      }
    },
  );

  test('does not reset elapsed time for steer, native retry, or repeated reads', async () => {
    const gate = Promise.withResolvers<void>();
    fixture.responseGate = gate.promise;
    fixture.tokens = 20;
    fixture.onLoad = (pi) => {
      pi.on('message_end', (event) => {
        if (event.message.role === 'assistant' && event.message.stopReason === 'error')
          event.message.errorMessage = '503 overloaded';
      });
    };
    const parent = 'widget-retry-' + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold first'));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      const run = live.run!,
        started = run.displayStartedAt;
      live.session!.settingsManager.applyOverrides({
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 300, maxAgentDelayMs: 300 },
      });
      const before = manager.getWidgetSnapshot(parent)[0].elapsedMs!;
      expect(await manager.sendMessage(parent, 'worker', 'fail retry')).toEqual({
        delivery: 'steer',
      });
      expect(manager.getWidgetSnapshot(parent)[0].elapsedMs).toBeGreaterThanOrEqual(before);
      expect(live.run!.displayStartedAt).toBe(started);
      gate.resolve();
      await waitUntil(() => live.session!.isRetrying);
      for (let index = 0; index < 3; index++)
        expect(manager.getWidgetSnapshot(parent)[0]).toMatchObject({
          tokens: 40,
          compactionCount: 0,
        });
      expect(live.run).toBe(run);
      expect(live.run!.displayStartedAt).toBe(started);
      await settled(manager, info);
      expect(fixture.instances[0].requests).toHaveLength(3);
      expect(manager.getAgentInfo('worker', parent).status).toBe('failed');
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('isolates parent scopes, includes starting/running memory only, and omits every final status', async () => {
    const parent = 'widget-scope-' + randomUUID(),
      foreign = 'widget-foreign-' + randomUUID();
    const startup = Promise.withResolvers<void>();
    const manager = new AgentManager();
    let starting: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold local'));
      await manager.spawnAgent(spawnParams(foreign, 'worker', 'hold foreign'));
      for (const [task, command, status] of [
        ['done', 'done', 'completed'],
        ['failed', 'fail now', 'failed'],
        ['stopped', 'hold interrupted', 'interrupted'],
      ]) {
        await manager.spawnAgent(spawnParams(parent, task, command));
        const info = manager.getAgentInfo(task, parent);
        if (status === 'interrupted') await manager.interruptAgent(parent, task);
        await settled(manager, info);
        expect(manager.getAgentInfo(task, parent).status).toBe(status);
      }
      const done = manager.getAgentInfo('done', parent);
      fs.writeFileSync(done.infoFile, JSON.stringify({ ...done, status: 'running' }));
      fixture.startupGate = startup.promise;
      const instances = fixture.instances.length;
      starting = manager.spawnAgent(spawnParams(parent, 'starting', 'hold startup'));
      await waitUntil(
        () => fixture.instances[instances]?.events.includes('session_start') ?? false,
      );
      expect(
        manager.getWidgetSnapshot(parent).map(({ taskName, status }) => [taskName, status]),
      ).toEqual([
        ['worker', 'running'],
        ['starting', 'starting'],
      ]);
      expect(manager.getWidgetSnapshot(foreign).map(({ taskName }) => taskName)).toEqual([
        'worker',
      ]);
      expect(manager.getWidgetSnapshot('unrelated-parent')).toEqual([]);
      startup.resolve();
      await starting;
    } finally {
      startup.resolve();
      await starting;
      await manager.shutdown();
    }
    expect(manager.getWidgetSnapshot(parent)).toEqual([]);
    expect(manager.getWidgetSnapshot(foreign)).toEqual([]);
  });

  test('uses the native effective model/thinking (including clamp), with configured fallback before a session', async () => {
    const parent = 'widget-native-model-' + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent({
        ...spawnParams(parent, 'worker', 'hold model'),
        thinking: 'xhigh',
      });
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      const session = live.session!;
      await session.setModel(
        fixture.instances[0].ctx!.modelRegistry.find('template-provider', 'template-model')!,
      );
      session.setThinkingLevel('xhigh');
      expect(session.thinkingLevel).toBe('high');
      expect(manager.getWidgetSnapshot(parent)[0]).toMatchObject({
        provider: 'template-provider',
        modelId: 'template-model',
        thinking: 'high',
      });
      expect(live.info).toMatchObject({ provider: 'test', modelId: 'fake', thinking: 'xhigh' });
      live.session = undefined;
      try {
        expect(manager.getWidgetSnapshot(parent)[0]).toMatchObject({
          provider: 'test',
          modelId: 'fake',
          thinking: 'xhigh',
          tokens: undefined,
          compactionCount: undefined,
        });
      } finally {
        live.session = session;
      }
    } finally {
      await manager.shutdown();
    }
  });

  test.each(['completed', 'failed'] as const)(
    'display getter failures cannot change %s results, completion delivery or cleanup',
    async (status) => {
      const gate = Promise.withResolvers<void>();
      fixture.responseGate = gate.promise;
      const parent = 'widget-fault-' + randomUUID();
      const notices: any[] = [],
        errors: Error[] = [];
      const manager = new AgentManager({
        onCompletion: (event) => notices.push(event),
        onError: (error) => errors.push(error),
      });
      const spies: Array<ReturnType<typeof spyOn>> = [];
      fixture.onLoad = (pi) => {
        pi.on('message_end', (event) => {
          if (event.message.role === 'assistant' && status === 'failed') {
            event.message.stopReason = 'error';
            event.message.errorMessage = 'original model failure';
          }
        });
      };
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', 'hold outcome'));
        const info = manager.getAgentInfo('worker', parent);
        const live = manager['live'].get(info.id)!;
        const session = live.session!,
          store = session.sessionManager;
        const fail = () => {
          throw new Error('display getter failure');
        };
        spies.push(spyOn(live.broadcaster, 'getWidgetActivity').mockImplementation(fail));
        spies.push(spyOn(store, 'getEntries').mockImplementationOnce(fail));
        expect(manager.getWidgetSnapshot(parent)[0]).toMatchObject({
          tokens: undefined,
          compactionCount: undefined,
          activeTools: [],
        });
        const count = spyOn(store, 'getEntryCount').mockImplementationOnce(fail);
        spies.push(count);
        expect(manager.getWidgetSnapshot(parent)[0].tokens).toBeUndefined();
        Object.defineProperty(session, 'model', { configurable: true, get: fail });
        try {
          expect(manager.getWidgetSnapshot(parent)[0]).toMatchObject({
            provider: 'test',
            modelId: 'fake',
            tokens: 0,
          });
        } finally {
          delete (session as any).model;
        }
        const unsubscribe = session.subscribe((event) => {
          if (event.type === 'message_end' && event.message.role === 'assistant') {
            count.mockImplementationOnce(fail);
            expect(manager.getWidgetSnapshot(parent)[0].tokens).toBeUndefined();
          }
        });
        gate.resolve();
        await coldDispose(manager, info);
        unsubscribe();
        expect(notices[0]).toMatchObject({
          status,
          ...(status === 'completed'
            ? { finalResponse: 'response:hold outcome' }
            : { error: 'original model failure' }),
        });
        expect(notices).toHaveLength(1);
        expect(errors).toEqual([]);
        expect(manager.getAgentInfo('worker', parent).status).toBe(status);
        expect(manager['live'].has(info.id)).toBe(false);
        expect(fixture.instances[0].shutdowns).toBe(1);
        expect(fs.existsSync(activeMarker(info.id))).toBe(false);
        expect(manager.getWidgetSnapshot(parent)).toEqual([]);
      } finally {
        gate.resolve();
        for (const spy of spies) spy.mockRestore();
        await manager.shutdown();
      }
    },
  );
});

describe('spawn model and thinking resolution', () => {
  test.each([undefined, 'explorer', 'general', 'worker'] as const)(
    'built-in selection %s uses normal SDK inheritance and applies its prefix only once',
    async (agentType) => {
      const parent = 'builtin-' + randomUUID();
      const manager = new AgentManager();
      const definition = getAgentDefinition(agentType);
      try {
        await manager.spawnAgent({
          ...spawnParams(parent, 'builtin-child', 'first task'),
          agent_type: agentType,
          inheritedThinking: 'low',
        });
        const info = manager.getAgentInfo('builtin-child', parent);
        await settled(manager, info);
        expect(info).toMatchObject({
          provider: 'test',
          modelId: 'fake',
          thinking: 'low',
          extensions: [CORE_SDK_EXTENSION],
          lastTaskMessage: 'first task',
        });
        expect(info.agentType).toBe(agentType);
        expect(info.color).toBe(definition?.color);
        expect(info.tools).toBeUndefined();
        const firstInput = definition?.prompt ? definition.prompt + '\n\nfirst task' : 'first task';
        expect(fixture.instances[0].inputs.map(({ text }) => text)).toEqual([firstInput]);
        expect(manager.getAgentInfo('builtin-child', parent).status).toBe('completed');
        await manager.sendMessage(parent, 'builtin-child', 'second task');
        await settled(manager, info);
        expect(fixture.instances[0].inputs.map(({ text }) => text)).toEqual([
          firstInput,
          'second task',
        ]);
      } finally {
        await manager.shutdown();
      }
    },
  );

  test('a general override does not affect generic spawns and loaded failures never use the built-in', async () => {
    const parent = 'general-override-' + randomUUID();
    const file = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents', 'custom-general.md');
    const manager = new AgentManager();
    fs.writeFileSync(
      file,
      '---\nname: general\nmodel: unavailable-user-model\nthinking: off\n---\nCustom general instructions.',
    );
    try {
      await manager.spawnAgent({
        ...spawnParams(parent, 'generic-child', 'first task'),
        inheritedThinking: 'low',
      });
      const info = manager.getAgentInfo('generic-child', parent);
      await settled(manager, info);
      expect(info).toMatchObject({ provider: 'test', modelId: 'fake', thinking: 'low' });
      expect(info.agentType).toBeUndefined();
      expect(info.color).toBeUndefined();
      expect(fixture.instances[0].inputs[0].text).toBe('first task');
      await expect(
        manager.spawnAgent({
          ...spawnParams(parent, 'named-general', 'must not run'),
          agent_type: 'general',
        }),
      ).rejects.toThrow('test/unavailable-user-model');
      expect(manager.getAgentInfo('named-general', parent)).toMatchObject({
        agentType: 'general',
        status: 'failed',
        modelId: 'unavailable-user-model',
      });
      expect(fixture.instances.flatMap((instance) => instance.inputs)).toHaveLength(1);
    } finally {
      await manager.shutdown();
      fs.rmSync(file, { force: true });
    }
  });

  test('caller wins, then the template, then the inherited value, then the default', async () => {
    writeConfig({ maxAgents: 7 });
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
        onCompletion: (event) => completions.push(event),
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
        await settled(manager, info);
        expect(fixture.instances.flatMap((instance) => instance.inputs)).toEqual([]);
        expect(sessionMessages(info)).toEqual([]);
        expect(completions).toEqual([
          expect.objectContaining({ status: 'failed', error: info.error }),
        ]);
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
    writeConfig({ extensions: [CORE_SDK_EXTENSION, extension] });
    const manager = new AgentManager();
    try {
      await expect(
        manager.spawnAgent(spawnParams(parent, 'worker', 'must not run')),
      ).rejects.toThrow('explicit fixture load failure');
      const info = manager.getAgentInfo('worker', parent);
      expect(info.status).toBe('failed');
      expect(sessionMessages(info)).toEqual([]);
      await settled(manager, info);
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
      await coldDispose(manager, first);
      fs.writeFileSync(
        template,
        '---\nname: saved-route\nprovider: openai\nmodel: gpt-5\n---\nChanged template.',
      );
      expect(await manager.sendMessage(parent, 'worker', 'second')).toEqual({ delivery: 'prompt' });
      await coldDispose(manager, first);
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
        onCompletion: (event) => completions.push(event),
      });
      try {
        await manager.spawnAgent(
          spawnParams(parent, 'worker', prior === 'failed' ? 'fail old' : 'hold old'),
        );
        if (prior === 'interrupted') await manager.interruptAgent(parent, 'worker');
        const initial = manager.getAgentInfo('worker', parent);
        await coldDispose(manager, initial);
        expect(manager.getAgentInfo('worker', parent).status).toBe(prior);
        fixture = configureCoreFixture({ routes: [['test', 'other']] });
        for (let attempt = 0; attempt < 2; attempt++) {
          const before = completions.length;
          await expect(manager.sendMessage(parent, 'worker', 'must not run')).rejects.toThrow(
            'test/fake',
          );
          const info = manager.getAgentInfo('worker', parent);
          await coldDispose(manager, info);
          expect(info).toMatchObject({ status: 'failed', messageCount: 1 });
          expect(info.finalResponse).toBeUndefined();
          expect(completions.slice(before)).toEqual([
            expect.objectContaining({ status: 'failed', error: info.error }),
          ]);
        }
        expect(fixture.instances.flatMap((instance) => instance.inputs)).toEqual([]);
      } finally {
        await manager.shutdown();
      }
    },
  );
});

describe('native hot session lifecycle', () => {
  for (const kind of ['handled', 'ordinary'] as const) {
    test.each(['send', 'interrupt', 'shutdown'] as const)(
      'native settled barrier protects ' + kind + ' work during %s',
      async (action) => {
        const entered = Promise.withResolvers<void>(),
          gate = Promise.withResolvers<void>();
        const notices: any[] = [],
          errors: Error[] = [];
        const manager = new AgentManager({
          onCompletion: (e) => notices.push(e),
          onError: (e) => errors.push(e),
        });
        const parent = 'settled-barrier-' + randomUUID();
        let api: Parameters<NonNullable<CoreFixtureState['onStart']>>[0];
        let hookExited = false,
          hooks = 0,
          operationFinished = false;
        let operation: Promise<unknown> | undefined;
        fixture.onStart = (pi) => {
          api = pi;
        };
        fixture.input = async (event) => {
          if (event.text !== 'delegate native work') return;
          api.sendUserMessage('inner native work');
          await entered.promise;
          return { action: 'handled' };
        };
        fixture.onSettled = async () => {
          if (++hooks !== 1) return;
          entered.resolve();
          await gate.promise;
          hookExited = true;
        };
        try {
          await manager.spawnAgent(
            spawnParams(
              parent,
              'worker',
              kind === 'handled' ? 'delegate native work' : 'ordinary native work',
            ),
          );
          const info = manager.getAgentInfo('worker', parent);
          const live = manager['live'].get(info.id)!;
          const session = live.session!;
          const run = live.run;
          const dispose = spyOn(session, 'dispose');
          const broadcast = spyOn(live.broadcaster, 'broadcast');
          await entered.promise;
          await new Promise((resolve) => setTimeout(resolve, 40));
          // Real SDK early-idle window: a late waiter has already returned, but the hook has not.
          expect(session.isIdle).toBe(true);
          await session.waitForIdle();
          expect(hookExited).toBe(false);
          expect(live.run).toBeDefined();
          expect(live.run).toBe(run);
          expect(live.nativeWork).toBeDefined();
          expect(notices).toHaveLength(0);
          if (action === 'send') {
            await expect(manager.sendMessage(parent, 'worker', 'must not defer')).rejects.toThrow(
              /finishing/,
            );
          } else {
            operation = (
              action === 'interrupt' ? manager.interruptAgent(parent, 'worker') : manager.shutdown()
            ).then((value) => {
              operationFinished = true;
              return value;
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
            expect(operationFinished).toBe(false);
          }
          expect(manager['live'].get(info.id)).toBe(live);
          expect(fs.existsSync(activeMarker(info.id))).toBe(true);
          expect(dispose).not.toHaveBeenCalled();
          expect(fixture.instances[0].shutdowns).toBe(0);
          expect(live.run).toBe(run);
          gate.resolve();
          await operation;
          if (action === 'shutdown') {
            await released(manager, info);
            expect(dispose).toHaveBeenCalledTimes(1);
            expect(fs.existsSync(activeMarker(info.id))).toBe(false);
            expect(notices).toHaveLength(0);
          } else {
            await settled(manager, info);
            expect(manager.readAgentResponse('worker', parent).status).toBe(
              action === 'interrupt' ? 'interrupted' : 'completed',
            );
            await manager.sendMessage(parent, 'worker', 'clean continuation');
            await settled(manager, info);
            expect(manager['live'].get(info.id)!.session).toBe(session);
            expect(fixture.instances).toHaveLength(1);
            expect(manager.readAgentResponse('worker', parent).finalResponse).toBe(
              'response:clean continuation',
            );
            expect(notices).toHaveLength(action === 'interrupt' ? 1 : 2);
            expect(fixture.instances[0].requests.map((r) => r.text)).toEqual([
              kind === 'handled' ? 'inner native work' : 'ordinary native work',
              'clean continuation',
            ]);
          }
          expect(hookExited).toBe(true);
          expect(
            broadcast.mock.calls.filter(([event]) => event.type === 'agent_settled'),
          ).toHaveLength(action === 'shutdown' ? 1 : 2);
          expect(errors).toEqual([]);
        } finally {
          gate.resolve();
          await operation;
          await manager.shutdown();
        }
      },
    );
  }

  test('native settled barrier retains a run while late steer preflight exits and clears its old queue', async () => {
    const response = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>(),
      input = Promise.withResolvers<void>();
    fixture.responseGate = response.promise;
    fixture.input = async (event) => {
      if (event.text === 'late steer') await input.promise;
    };
    let hooks = 0;
    fixture.onSettled = async () => {
      if (++hooks === 1) {
        entered.resolve();
        await gate.promise;
      }
    };
    const manager = new AgentManager();
    const parent = 'settled-late-steer-' + randomUUID();
    let steering: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold original'));
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      const run = live.run!;
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      steering = manager.sendMessage(parent, 'worker', 'late steer').catch((e) => e);
      await waitUntil(() => fixture.instances[0].inputs.some((e) => e.text === 'late steer'));
      response.resolve();
      await entered.promise;
      expect(live.session!.isIdle).toBe(true);
      input.resolve();
      expect(await steering).toBeInstanceOf(Error);
      expect(live.run).toBe(run);
      expect(live.nativeWork).toBeDefined();
      expect(run.pendingSteers.size).toBe(0);
      expect(live.session!.pendingMessageCount).toBe(0);
      gate.resolve();
      await settled(manager, info);
      await manager.sendMessage(parent, 'worker', 'next run');
      await settled(manager, info);
      expect(fixture.instances).toHaveLength(1);
      expect(fixture.instances[0].requests.map((r) => r.text)).toEqual([
        'hold original',
        'next run',
      ]);
      expect(sessionMessages(info).some((m) => JSON.stringify(m).includes('late steer'))).toBe(
        false,
      );
    } finally {
      response.resolve();
      input.resolve();
      gate.resolve();
      await steering;
      await manager.shutdown();
    }
  });

  for (const [provider, modelId] of [
    ['test', 'template-model'],
    ['template-provider', 'fake'],
  ]) {
    test.each(['warm', 'cold'] as const)(
      'native selection drift restores saved exact route ' + provider + '/' + modelId + ' (%s)',
      async (mode) => {
        let switched = false;
        fixture = configureCoreFixture({
          routes: [
            ['test', 'fake'],
            ['test', 'template-model'],
            ['template-provider', 'fake'],
          ],
          async onSettled(_aborted, pi) {
            if (switched) return;
            switched = true;
            const model = fixture.instances[0].ctx!.modelRegistry.find(provider, modelId)!;
            if (!(await pi.setModel(model))) throw new Error('offline model switch rejected');
          },
        });
        const manager = new AgentManager();
        const parent = 'native-selection-drift-' + randomUUID();
        try {
          await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
          const info = manager.getAgentInfo('worker', parent);
          await settled(manager, info);
          const first = manager['live'].get(info.id)?.session;
          if (mode === 'warm') expect(first!.model).toMatchObject({ provider, id: modelId });
          else await coldDispose(manager, info);
          await manager.sendMessage(parent, 'worker', 'second');
          await settled(manager, info);
          expect(fixture.instances).toHaveLength(2);
          expect(fixture.instances[0].shutdowns).toBe(1);
          expect(
            fixture.instances.flatMap((i) =>
              i.requests.map((r) => [r.message.provider, r.message.model]),
            ),
          ).toEqual([
            ['test', 'fake'],
            ['test', 'fake'],
          ]);
          expect(manager.getAgentInfo('worker', parent)).toMatchObject({
            provider: 'test',
            modelId: 'fake',
            sessionFile: info.sessionFile,
            messageCount: 2,
          });
          if (mode === 'warm') expect(manager['live'].get(info.id)!.session).not.toBe(first);
          expect(sessionMessages(info).filter((m) => m.role === 'user')).toHaveLength(2);
        } finally {
          await manager.shutdown();
        }
      },
    );
  }

  test('native selection drift cannot fall back when the saved exact route is unavailable on rebuild', async () => {
    let switched = false;
    fixture.onSettled = async (_aborted, pi) => {
      if (switched) return;
      switched = true;
      await pi.setModel(fixture.instances[0].ctx!.modelRegistry.find('test', 'template-model')!);
    };
    const manager = new AgentManager();
    const parent = 'native-drift-unavailable-' + randomUUID();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      fixture.routes = [['test', 'template-model']];
      await expect(manager.sendMessage(parent, 'worker', 'must not fall back')).rejects.toThrow(
        /not available: test\/fake/,
      );
      await released(manager, info);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        provider: 'test',
        modelId: 'fake',
        status: 'failed',
      });
      expect(fixture.instances).toHaveLength(2);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fixture.instances.flatMap((i) => i.requests.map((r) => r.message.model))).toEqual([
        'fake',
      ]);
      expect(sessionMessages(info).filter((m) => m.role === 'user')).toHaveLength(1);
    } finally {
      await manager.shutdown();
    }
  });

  test('native virtual selection is retained when its physical route changes provider/model', async () => {
    fixture.onLoad = (pi) =>
      pi.registerVirtualModel({
        provider: 'offline-router',
        id: 'selected',
        name: 'Offline router',
        route(request, ctx) {
          const second = request.messages.filter((m) => m.role === 'user').length > 1;
          return {
            model: ctx.modelRegistry.find(
              second ? 'template-provider' : 'test',
              second ? 'template-model' : 'fake',
            )!,
          };
        },
      });
    const manager = new AgentManager();
    const parent = 'virtual-selection-' + randomUUID();
    try {
      await manager.spawnAgent({
        ...spawnParams(parent, 'worker', 'first'),
        model: { provider: 'offline-router', modelId: 'selected' },
      });
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      const session = manager['live'].get(info.id)!.session!;
      await manager.sendMessage(parent, 'worker', 'second');
      await settled(manager, info);
      expect(manager['live'].get(info.id)!.session).toBe(session);
      expect(session.model).toMatchObject({ provider: 'offline-router', id: 'selected' });
      expect(fixture.instances).toHaveLength(1);
      expect(
        fixture.instances[0].requests.map((r) => [r.message.provider, r.message.model]),
      ).toEqual([
        ['test', 'fake'],
        ['template-provider', 'template-model'],
      ]);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        provider: 'offline-router',
        modelId: 'selected',
      });
    } finally {
      await manager.shutdown();
    }
  });

  test.each(['success', 'cancel', 'failure'] as const)(
    'native compaction returns to safe idle and becomes eligible for capacity replacement after %s',
    async (outcome) => {
      writeConfig({ maxAgents: 1 });
      const entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>();
      fixture.onStart = (pi) => {
        if (fixture.instances.length !== 1) return;
        pi.on('session_before_compact', async (event) => {
          entered.resolve();
          await gate.promise;
          if (outcome === 'cancel') return { cancel: true };
          return {
            compaction: {
              summary: 'native offline summary',
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        });
      };
      const notices: any[] = [];
      const manager = new AgentManager({ onCompletion: (e) => notices.push(e) });
      const parent = 'native-compaction-cap-' + randomUUID();
      let compacting: Promise<any> | undefined;
      let persist: ReturnType<typeof spyOn> | undefined;
      try {
        await manager.spawnAgent(spawnParams(parent, 'a', 'first'));
        const a = manager.getAgentInfo('a', parent);
        await settled(manager, a);
        const live = manager['live'].get(a.id)!;
        const lastUsedAt = live.lastUsedAt;
        const before = manager.readAgentResponse('a', parent);
        const session = live.session!;
        session.settingsManager.applyOverrides({
          compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 },
        });
        if (outcome === 'failure') {
          // Real SDK lifecycle, with only its public persistence boundary fault-injected.
          persist = spyOn(session.sessionManager, 'appendCompaction').mockImplementationOnce(() => {
            throw new Error('native compaction persistence failure');
          });
        }
        compacting = session.compact().then(
          (result) => ({ result }),
          (error) => ({ error }),
        );
        await entered.promise;
        expect(live.run).toBeUndefined();
        expect(session.isIdle).toBe(false);
        await expect(manager.spawnAgent(spawnParams(parent, 'b', 'second'))).rejects.toThrow(
          /maxAgents|capacity|limit/i,
        );
        expect(manager['live'].get(a.id)).toBe(live);
        expect(live.closing).toBe(false);
        expect(fixture.instances.map((i) => i.shutdowns)).toEqual([0]);
        await expect(manager.sendMessage(parent, 'a', 'busy must not prompt')).rejects.toThrow(
          /finishing/,
        );
        gate.resolve();
        const result = await compacting;
        if (outcome === 'success') expect(result.result.summary).toBe('native offline summary');
        else
          expect(result.error.message).toContain(
            outcome === 'cancel' ? 'cancelled' : 'persistence failure',
          );
        await manager.spawnAgent(spawnParams(parent, 'b', 'second'));
        await settled(manager, manager.getAgentInfo('b', parent));
        await released(manager, a);
        expect(manager['live'].size).toBe(1);
        expect(fixture.instances.map((i) => i.shutdowns)).toEqual([1, 0]);
        expect(live.lastUsedAt).toBe(lastUsedAt);
        expect(manager.readAgentResponse('a', parent)).toEqual(before);
        expect(notices).toHaveLength(2);
      } finally {
        gate.resolve();
        await compacting;
        persist?.mockRestore();
        await manager.shutdown();
      }
    },
  );
  for (const outcome of ['cancel', 'failure'] as const) {
    test.each(['capacity', 'send', 'shutdown'] as const)(
      'public compact failed-hook drain protects ' + outcome + ' during %s',
      async (action) => {
        if (action === 'capacity') writeConfig({ maxAgents: 1 });
        const beforeEntered = Promise.withResolvers<void>(),
          beforeGate = Promise.withResolvers<void>();
        const failedEntered = Promise.withResolvers<void>(),
          failedGate = Promise.withResolvers<void>();
        const callback = Promise.withResolvers<{ error?: Error; result?: unknown }>();
        let hookExited = false,
          callbackCount = 0,
          stopped = false;
        let failedEvent: any;
        fixture.tokens = (text) => {
          if (text.includes('ordinary-summary-failure'))
            throw new Error('ordinary native summary failure');
          return 60000;
        };
        fixture.onStart = (pi) => {
          if (fixture.instances.length !== 1) return;
          pi.on('session_before_compact', async () => {
            beforeEntered.resolve();
            await beforeGate.promise;
            if (outcome === 'cancel') return { cancel: true };
          });
          pi.on('session_compact_failed', async (event) => {
            failedEvent = event;
            failedEntered.resolve();
            await failedGate.promise;
            hookExited = true;
          });
        };
        const notices: any[] = [],
          errors: Error[] = [];
        const manager = new AgentManager({
          onCompletion: (e) => notices.push(e),
          onError: (e) => errors.push(e),
        });
        const parent = 'public-compact-drain-' + randomUUID();
        let stopping: Promise<void> | undefined;
        try {
          await manager.spawnAgent(spawnParams(parent, 'a', 'seed'));
          const a = manager.getAgentInfo('a', parent);
          await settled(manager, a);
          const before = manager.readAgentResponse('a', parent);
          const live = manager['live'].get(a.id)!;
          const session = live.session!;
          const dispose = spyOn(session, 'dispose');
          session.settingsManager.applyOverrides({
            compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 },
          });
          // Public ExtensionContext entry point, not a direct session.compact call.
          fixture.instances[0].ctx!.compact({
            customInstructions: 'ordinary-summary-failure',
            onComplete(result) {
              callbackCount++;
              callback.resolve({ result });
            },
            onError(error) {
              callbackCount++;
              callback.resolve({ error });
            },
          });
          await beforeEntered.promise;
          expect(session.isIdle).toBe(false);
          if (action === 'capacity') {
            await expect(manager.spawnAgent(spawnParams(parent, 'b', 'second'))).rejects.toThrow(
              /maxAgents|capacity|limit/i,
            );
          }
          expect(manager['live'].get(a.id)).toBe(live);
          beforeGate.resolve();
          await failedEntered.promise;
          // SDK 1.5 has already resolved busy-time waiters before awaiting this failed hook.
          await session.waitForIdle();
          expect(session.isIdle).toBe(true);
          expect(failedEvent).toMatchObject({ reason: 'manual', aborted: outcome === 'cancel' });
          await new Promise((resolve) => setTimeout(resolve, 40));
          expect(hookExited).toBe(false);
          expect(callbackCount).toBe(0);
          expect(manager['live'].get(a.id)).toBe(live);
          expect(fs.existsSync(activeMarker(a.id))).toBe(true);
          expect(dispose).not.toHaveBeenCalled();
          const requests = fixture.instances[0].requests.length;
          if (action === 'send') {
            await expect(
              manager.sendMessage(parent, 'a', 'must not enter old failed hook'),
            ).rejects.toThrow(/finishing/);
          } else if (action === 'shutdown') {
            stopping = manager.shutdown().then(() => {
              stopped = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
            expect(stopped).toBe(false);
          }
          expect(fixture.instances[0].requests).toHaveLength(requests);
          expect(fixture.instances[0].shutdowns).toBe(0);
          expect(dispose).not.toHaveBeenCalled();
          expect(fs.existsSync(activeMarker(a.id))).toBe(true);
          expect(manager.readAgentResponse('a', parent)).toEqual(before);
          expect(notices).toHaveLength(1);
          failedGate.resolve();
          const result = await callback.promise;
          expect(result.error?.message).toContain(
            outcome === 'cancel' ? 'cancelled' : 'ordinary native summary failure',
          );
          expect(callbackCount).toBe(1);
          expect(hookExited).toBe(true);
          await stopping;
          if (action === 'capacity') {
            await manager.spawnAgent(spawnParams(parent, 'b', 'second'));
            await settled(manager, manager.getAgentInfo('b', parent));
          }
          if (action === 'capacity' || action === 'shutdown') {
            await released(manager, a);
            expect(dispose).toHaveBeenCalledTimes(1);
            expect(manager['live'].size).toBe(action === 'capacity' ? 1 : 0);
            expect(manager.readAgentResponse('a', parent)).toEqual(before);
            expect(notices).toHaveLength(action === 'capacity' ? 2 : 1);
          } else {
            expect(manager.readAgentResponse('a', parent)).toEqual(before);
            expect(notices).toHaveLength(1);
            expect(await manager.sendMessage(parent, 'a', 'after failed hook exit')).toEqual({
              delivery: 'prompt',
            });
            await settled(manager, a);
            expect(manager['live'].get(a.id)!.session).toBe(session);
            expect(manager.readAgentResponse('a', parent).finalResponse).toBe(
              'response:after failed hook exit',
            );
            expect(fixture.instances).toHaveLength(1);
            expect(notices).toHaveLength(2);
          }
          expect(errors).toEqual([]);
        } finally {
          beforeGate.resolve();
          failedGate.resolve();
          await callback.promise;
          await stopping;
          await manager.shutdown();
        }
      },
    );
  }

  test('public compact reentry registers first and each overlapping failed hook keeps its own drain', async () => {
    writeConfig({ maxAgents: 1 });
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()],
      gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const callbacks = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const observed: number[] = [];
    let failedHooks = 0,
      reentered = false;
    fixture.onStart = (pi) => {
      if (fixture.instances.length !== 1) return;
      pi.on('session_before_compact', () => ({ cancel: true }));
      pi.on('session_compact_failed', async () => {
        const index = failedHooks++;
        entered[index].resolve();
        await gates[index].promise;
      });
    };
    const notices: any[] = [],
      errors: Error[] = [];
    const manager = new AgentManager({
      onCompletion: (e) => notices.push(e),
      onError: (e) => errors.push(e),
    });
    const parent = 'compact-reentry-drain-' + randomUUID();
    let unsubscribe: (() => void) | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'a', 'seed'));
      const a = manager.getAgentInfo('a', parent);
      await settled(manager, a);
      const live = manager['live'].get(a.id)!;
      const before = manager.readAgentResponse('a', parent);
      const session = live.session!;
      const ctx = fixture.instances[0].ctx!;
      session.settingsManager.applyOverrides({
        compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 },
      });
      unsubscribe = session.subscribe((event) => {
        if (event.type !== 'compaction_start' || reentered) return;
        reentered = true;
        observed.push(live.pendingCompactions?.size ?? 0);
        ctx.compact({ onError: () => callbacks[1].resolve() });
        observed.push(live.pendingCompactions?.size ?? 0);
      });
      ctx.compact({ onError: () => callbacks[0].resolve() });
      await Promise.all(entered.map((entry) => entry.promise));
      expect(observed).toEqual([1, 2]);
      expect(live.pendingCompactions.size).toBe(2);
      await expect(manager.spawnAgent(spawnParams(parent, 'b', 'second'))).rejects.toThrow(
        /maxAgents|capacity|limit/i,
      );
      gates[0].resolve();
      await callbacks[0].promise;
      expect(live.pendingCompactions.size).toBe(1);
      expect(manager['live'].get(a.id)).toBe(live);
      expect(live.closing).toBe(false);
      expect(fs.existsSync(activeMarker(a.id))).toBe(true);
      await expect(manager.sendMessage(parent, 'a', 'must not pass second hook')).rejects.toThrow(
        /finishing/,
      );
      gates[1].resolve();
      await callbacks[1].promise;
      await manager.spawnAgent(spawnParams(parent, 'b', 'second'));
      await settled(manager, manager.getAgentInfo('b', parent));
      await released(manager, a);
      expect(live.pendingCompactions.size).toBe(0);
      expect(manager['live'].size).toBe(1);
      expect(manager.readAgentResponse('a', parent)).toEqual(before);
      expect(notices).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      gates.forEach((gate) => gate.resolve());
      await Promise.all(callbacks.map((callback) => callback.promise));
      unsubscribe?.();
      await manager.shutdown();
    }
  });

  test('an old native barrier cannot clear newer no-run work or permit eviction inside its settled hook', async () => {
    writeConfig({ maxAgents: 1 });
    const oldDelivery = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    let backgroundStarted = false;
    fixture.onStart = (pi) => {
      if (fixture.instances.length !== 1) return;
      pi.on('session_before_compact', (event) => ({
        compaction: {
          summary: 'offline summary',
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      }));
      pi.on('agent_settled', async () => {
        if (backgroundStarted) {
          entered.resolve();
          await gate.promise;
        }
      });
    };
    const notices: any[] = [],
      errors: Error[] = [];
    const manager = new AgentManager({
      onCompletion: (e) => notices.push(e),
      onError: (e) => errors.push(e),
    });
    const parent = 'native-barrier-identity-' + randomUUID();
    let background: Promise<void> | undefined;
    let waiter: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'a', 'seed'));
      const a = manager.getAgentInfo('a', parent);
      await settled(manager, a);
      const before = manager.readAgentResponse('a', parent);
      const live = manager['live'].get(a.id)!;
      const session = live.session!;
      session.settingsManager.applyOverrides({
        compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 },
      });
      const nativeWait = session.waitForIdle.bind(session);
      let delayed = false;
      waiter = spyOn(session, 'waitForIdle').mockImplementation(() => {
        const actual = nativeWait();
        if (session.isIdle || delayed) return actual;
        delayed = true;
        // Delay delivery of one genuine SDK waiter, not the SDK's work or idle getter.
        return actual.then(() => oldDelivery.promise);
      });
      await session.compact();
      const old = live.nativeWork;
      expect(old).toBeDefined();
      backgroundStarted = true;
      background = session.sendCustomMessage(
        { customType: 'background', content: 'native work', display: false },
        { triggerTurn: true },
      );
      await entered.promise;
      const current = live.nativeWork;
      expect(current).toBeDefined();
      expect(current).not.toBe(old);
      expect(live.run).toBeUndefined();
      expect(session.isIdle).toBe(true); // Native hook is still gated, despite this getter.
      await expect(manager.spawnAgent(spawnParams(parent, 'b', 'second'))).rejects.toThrow(
        /maxAgents|capacity|limit/i,
      );
      oldDelivery.resolve();
      await old;
      expect(live.nativeWork).toBe(current);
      expect(manager['live'].get(a.id)).toBe(live);
      expect(live.closing).toBe(false);
      expect(fixture.instances.map((i) => i.shutdowns)).toEqual([0]);
      await expect(manager.sendMessage(parent, 'a', 'must not defer')).rejects.toThrow(/finishing/);
      gate.resolve();
      await background;
      await manager.spawnAgent(spawnParams(parent, 'b', 'second'));
      await settled(manager, manager.getAgentInfo('b', parent));
      await released(manager, a);
      expect(manager['live'].size).toBe(1);
      expect(manager.readAgentResponse('a', parent)).toEqual(before);
      expect(notices).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      oldDelivery.resolve();
      gate.resolve();
      await background;
      waiter?.mockRestore();
      await manager.shutdown();
    }
  });

  test.each(['success', 'interrupt', 'model-error'] as const)(
    '%s then success reuses one native Session/ModelRuntime until one actual cleanup',
    async (scenario) => {
      const parent = 'hot-recovery-' + randomUUID();
      const notifications: any[] = [];
      const manager = new AgentManager({ onCompletion: (event) => notifications.push(event) });
      const { registerSessionResourceCleanup } = await import(
        new URL('session-resources.js', import.meta.resolve('@earendil-works/pi-ai')).href
      );
      let cleanups = 0;
      let unregister = () => {};
      try {
        await manager.spawnAgent(
          spawnParams(
            parent,
            'worker',
            scenario === 'interrupt'
              ? 'hold first'
              : scenario === 'model-error'
                ? 'fail first'
                : 'first',
          ),
        );
        const info = manager.getAgentInfo('worker', parent);
        const live = manager['live'].get(info.id)!;
        const session = live.session!;
        const runtime = session.modelRuntime;
        unregister = registerSessionResourceCleanup((id: string) => {
          if (id === session.sessionId) cleanups++;
        });
        if (scenario === 'interrupt') {
          await waitUntil(() => fixture.instances[0].activeStreams === 1);
          await manager.interruptAgent(parent, 'worker');
        }
        await settled(manager, info);
        expect(manager.getAgentInfo('worker', parent).status).toBe(
          scenario === 'interrupt'
            ? 'interrupted'
            : scenario === 'model-error'
              ? 'failed'
              : 'completed',
        );
        expect(manager['live'].get(info.id)).toBe(live);
        expect(cleanups).toBe(0);
        expect(fixture.instances[0].shutdowns).toBe(0);
        await manager.sendMessage(parent, 'worker', 'second');
        await settled(manager, info);
        expect(manager['live'].get(info.id)!.session).toBe(session);
        expect(session.modelRuntime).toBe(runtime);
        expect(fixture.instances).toHaveLength(1);
        expect(
          fixture.instances[0].events.filter((e) => e === 'factory' || e === 'session_start'),
        ).toEqual(['factory', 'session_start']);
        expect(manager.readAgentResponse('worker', parent)).toMatchObject({
          status: 'completed',
          finalResponse: 'response:second',
        });
        expect(manager.getAgentInfo('worker', parent).error).toBeUndefined();
        expect(cleanups).toBe(0);
        expect(notifications).toHaveLength(scenario === 'interrupt' ? 1 : 2);
        await manager.shutdown();
        expect(fixture.instances[0].shutdowns).toBe(1);
        expect(cleanups).toBe(1);
        await manager.shutdown();
        expect(cleanups).toBe(1);
      } finally {
        await manager.shutdown();
        unregister();
      }
    },
  );

  test.each([undefined, 1, 3])(
    'maxAgents=%s bounds all live sessions (the default is 5), refusing busy work without a queue or fake records',
    async (configured) => {
      if (configured !== undefined) writeConfig({ maxAgents: configured });
      const cap = configured ?? 5;
      const parent = 'live-cap-' + randomUUID();
      const notices: any[] = [],
        activity: any[] = [];
      const manager = new AgentManager({
        onCompletion: (event) => notices.push(event),
        onActivityChange: (event) => activity.push(event),
      });
      try {
        for (let index = 0; index < cap; index++)
          await manager.spawnAgent(spawnParams(parent, 'worker-' + index, 'hold work ' + index));
        await waitUntil(() => fixture.instances.every((instance) => instance.activeStreams === 1));
        const before = manager.listAgentInfos(undefined, parent);
        const files = fs.readdirSync(path.dirname(before[0].infoFile)).sort();
        await expect(
          manager.spawnAgent(spawnParams(parent, 'overflow', 'must not run')),
        ).rejects.toThrow(/capacity|maxAgents|limit/i);
        expect(manager['live'].size).toBe(cap);
        expect(manager.listAgentInfos(undefined, parent)).toEqual(before);
        expect(fs.readdirSync(path.dirname(before[0].infoFile)).sort()).toEqual(files);
        expect(activity.some((event) => event.taskName === 'overflow')).toBe(false);
        expect(notices).toEqual([]);
        expect(fixture.instances).toHaveLength(cap);
        await manager.interruptAgent(parent, 'worker-0');
        await settled(manager, manager.getAgentInfo('worker-0', parent));
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(fixture.instances).toHaveLength(cap); // Rejected work is not queued.
        await manager.spawnAgent(spawnParams(parent, 'overflow', 'hold retry'));
        expect(manager['live'].size).toBe(cap);
        expect(fixture.instances).toHaveLength(cap + 1);
        expect(fixture.instances[0].shutdowns).toBe(1);
      } finally {
        await manager.shutdown();
      }
    },
  );

  test('maxAgents accepts only explicit positive safe integers and snapshots the limit at initialization', async () => {
    for (const invalid of [0, -1, 1.5, '1', '', null, true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
      writeConfig({ maxAgents: invalid });
      expect(() => loadSubagentConfig()).toThrow(/maxAgents.*positive.*safe.*integer/i);
      expect(() => new AgentManager()).toThrow(/maxAgents/i);
    }
    fs.writeFileSync(configFile, '{"maxAgents":1e400}'); // Valid JSON that overflows to Infinity.
    expect(() => loadSubagentConfig()).toThrow(/maxAgents/i);
    for (const valid of [1, 5, Number.MAX_SAFE_INTEGER]) {
      writeConfig({ maxAgents: valid });
      expect(loadSubagentConfig().maxAgents).toBe(valid);
    }
    writeConfig({ maxAgents: 1 });
    const manager = new AgentManager();
    const parent = 'fixed-cap-' + randomUUID();
    writeConfig({ maxAgents: 5 });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold first'));
      await expect(
        manager.spawnAgent(spawnParams(parent, 'overflow', 'must not run')),
      ).rejects.toThrow(/capacity|maxAgents|limit/i);
      expect(manager['live'].size).toBe(1);
    } finally {
      await manager.shutdown();
    }
  });

  test('maxIdleSessions is ignored and warns once about migrating to maxAgents', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    writeConfig({ maxIdleSessions: 0, maxAgents: 1 });
    const manager = new AgentManager();
    const parent = 'legacy-cap-' + randomUUID();
    try {
      expect(loadSubagentConfig()).not.toHaveProperty('maxIdleSessions');
      writeConfig({ maxIdleSessions: 'invalid legacy value', maxAgents: 1 });
      expect(loadSubagentConfig().maxAgents).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0].join(' ')).toMatch(/maxIdleSessions.*maxAgents/);
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      expect(manager['live'].has(info.id)).toBe(true);
      expect(fixture.instances[0].shutdowns).toBe(0);
      await manager.sendMessage(parent, 'worker', 'hold hot');
      expect(fixture.instances).toHaveLength(1);
      await expect(
        manager.spawnAgent(spawnParams(parent, 'overflow', 'must not run')),
      ).rejects.toThrow(/capacity|maxAgents|limit/i);
    } finally {
      warn.mockRestore();
      await manager.shutdown();
    }
  });

  test('concurrent startups claim the last slots before native initialization can yield', async () => {
    writeConfig({ maxAgents: 2 });
    const gate = Promise.withResolvers<void>();
    fixture.startupGate = gate.promise;
    const parent = 'concurrent-cap-' + randomUUID();
    let peak = 0;
    const manager = new AgentManager();
    fixture.onLoad = () => {
      peak = Math.max(peak, manager['live'].size);
    };
    const outcomes: Array<{ task: string; error?: unknown }> = [];
    const pending = Array.from({ length: 8 }, (_, index) => {
      const task = 'worker-' + index;
      return manager.spawnAgent(spawnParams(parent, task, 'hold startup')).then(
        () => {
          outcomes.push({ task });
        },
        (error) => {
          outcomes.push({ task, error });
        },
      );
    });
    try {
      await waitUntil(() => fixture.instances.length === 2 && outcomes.length === 6);
      expect(manager['live'].size).toBe(2);
      expect(peak).toBe(2);
      expect(
        outcomes.every(
          ({ error }) => error instanceof Error && /capacity|maxAgents|limit/i.test(error.message),
        ),
      ).toBe(true);
      expect(manager.listAgentInfos(undefined, parent)).toHaveLength(2);
      expect(fixture.instances.every((instance) => instance.inputs.length === 0)).toBe(true);
      gate.resolve();
      await Promise.all(pending);
      expect(outcomes.filter(({ error }) => error === undefined)).toHaveLength(2);
      expect(manager['live'].size).toBe(2);
      expect(fixture.instances).toHaveLength(2);
      expect(
        fs
          .readdirSync(path.join(getRunsDir(), parentScopeKey(parent)))
          .some((name) => name.endsWith('.lock')),
      ).toBe(false);
    } finally {
      gate.resolve();
      await Promise.all(pending);
      await manager.shutdown();
    }
  });

  test('a hot hit updates LRU recency and replacement waits for actual cleanup without rewriting old finals', async () => {
    writeConfig({ maxAgents: 2 });
    const gate = Promise.withResolvers<void>();
    const parent = 'capacity-lru-' + randomUUID();
    const notices: any[] = [];
    const manager = new AgentManager({ onCompletion: (event) => notices.push(event) });
    let spawning: Promise<unknown> | undefined;
    try {
      for (const task of ['a', 'b']) {
        await manager.spawnAgent(spawnParams(parent, task, 'first ' + task));
        await settled(manager, manager.getAgentInfo(task, parent));
      }
      const a = manager.getAgentInfo('a', parent),
        b = manager.getAgentInfo('b', parent);
      const original = manager['live'].get(a.id)!.session;
      await manager.sendMessage(parent, 'a', 'hit a');
      await settled(manager, a);
      expect(manager['live'].get(a.id)!.session).toBe(original);
      const bFinal = manager.getAgentInfo('b', parent);
      const history = fs.readFileSync(b.sessionFile, 'utf8');
      const old = manager['live'].get(b.id)!;
      const dispose = spyOn(old.session!, 'dispose');
      fixture.shutdownGate = gate.promise;
      let finished = false;
      spawning = manager.spawnAgent(spawnParams(parent, 'c', 'hold replacement')).then((value) => {
        finished = true;
        return value;
      });
      await waitUntil(() => fixture.instances[1].shutdowns === 1);
      expect(finished).toBe(false);
      expect(old.closing).toBe(true);
      expect(manager['live'].size).toBe(2);
      expect(manager['live'].get(b.id)).toBe(old);
      expect(
        manager
          .listAgents(undefined, parent)
          .map((entry) => entry.agent_name)
          .sort(),
      ).toEqual(['a', 'b']);
      expect(fixture.instances).toHaveLength(2);
      expect(fs.existsSync(activeMarker(b.id))).toBe(true);
      expect(dispose).not.toHaveBeenCalled();
      expect(
        manager
          .listAgentInfos(undefined, parent)
          .map((info) => info.taskName)
          .sort(),
      ).toEqual(['a', 'b']);
      await manager.sendMessage(parent, 'a', 'hold while another slot closes');
      await expect(
        manager.spawnAgent(spawnParams(parent, 'no-queue', 'must not run')),
      ).rejects.toThrow(/capacity|maxAgents|limit/i);
      gate.resolve();
      expect(await spawning).toEqual({ task_name: 'c', nickname: null });
      expect(manager['live'].size).toBe(2);
      expect(manager['live'].has(b.id)).toBe(false);
      expect(
        manager
          .listAgents(undefined, parent)
          .map((entry) => entry.agent_name)
          .sort(),
      ).toEqual(['a', 'c']);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(manager.getAgentInfo('b', parent)).toEqual(bFinal);
      expect(fs.readFileSync(b.sessionFile, 'utf8')).toBe(history);
      expect(notices.filter((notice) => notice.taskName === 'b')).toHaveLength(1);
      expect(fixture.instances).toHaveLength(3);
    } finally {
      gate.resolve();
      await spawning;
      await manager.shutdown();
    }
  });

  test('capacity protects active work and native-busy sessions without a run, evicting only safe idle', async () => {
    writeConfig({ maxAgents: 3 });
    const manager = new AgentManager();
    const parent = 'capacity-busy-' + randomUUID();
    let busySession: any;
    try {
      await manager.spawnAgent(spawnParams(parent, 'active', 'hold active'));
      const active = manager.getAgentInfo('active', parent);
      await manager.spawnAgent(spawnParams(parent, 'busy', 'first'));
      const busy = manager.getAgentInfo('busy', parent);
      await settled(manager, busy);
      busySession = manager['live'].get(busy.id)!.session!;
      Object.defineProperty(busySession, 'isIdle', { configurable: true, get: () => false });
      for (const task of ['a', 'b']) {
        await manager.spawnAgent(spawnParams(parent, task, 'work'));
        await settled(manager, manager.getAgentInfo(task, parent));
      }
      await released(manager, manager.getAgentInfo('a', parent));
      expect(manager['live'].size).toBe(3);
      expect(manager['live'].has(active.id)).toBe(true);
      expect(manager['live'].has(busy.id)).toBe(true);
      expect(manager.getAgentInfo('active', parent).status).toBe('running');
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([0, 0, 1, 0]);
      await expect(manager.sendMessage(parent, 'busy', 'must not prompt')).rejects.toThrow(
        /finishing/,
      );
      await manager.sendMessage(parent, 'b', 'hold fills capacity');
      await expect(
        manager.spawnAgent(spawnParams(parent, 'overflow', 'must not run')),
      ).rejects.toThrow(/capacity|maxAgents|limit/i);
      expect(fixture.instances).toHaveLength(4);
    } finally {
      if (busySession) delete busySession.isIdle;
      await manager.shutdown();
    }
  });

  test('hot continuation and active steering consume no additional slot at full capacity', async () => {
    writeConfig({ maxAgents: 1 });
    const parent = 'capacity-hot-' + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      const original = manager['live'].get(info.id)!;
      expect(await manager.sendMessage(parent, 'worker', 'hold continuation')).toEqual({
        delivery: 'prompt',
      });
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      expect(await manager.sendMessage(parent, 'worker', 'hold steered')).toEqual({
        delivery: 'steer',
      });
      expect(manager['live'].get(info.id)).toBe(original);
      expect(manager['live'].size).toBe(1);
      expect(fixture.instances).toHaveLength(1);
      expect(fixture.instances[0].shutdowns).toBe(0);
      await expect(
        manager.spawnAgent(spawnParams(parent, 'overflow', 'must not run')),
      ).rejects.toThrow(/capacity|maxAgents|limit/i);
    } finally {
      await manager.shutdown();
    }
  });

  test.each(['completed', 'failed', 'interrupted'] as const)(
    'cold capacity rejection preserves %s history, results and completion state',
    async (prior) => {
      writeConfig({ maxAgents: 1 });
      const parent = 'capacity-cold-' + randomUUID();
      const notices: any[] = [],
        activity: any[] = [];
      const manager = new AgentManager({
        onCompletion: (event) => notices.push(event),
        onActivityChange: (event) => activity.push(event),
      });
      try {
        await manager.spawnAgent(
          spawnParams(
            parent,
            'cold',
            prior === 'completed' ? 'first' : prior === 'failed' ? 'fail first' : 'hold first',
          ),
        );
        const info = manager.getAgentInfo('cold', parent);
        if (prior === 'interrupted') await manager.interruptAgent(parent, 'cold');
        await coldDispose(manager, info);
        expect(manager.listAgents(undefined, parent)).toEqual([]);
        const before = manager.getAgentInfo('cold', parent);
        const response = manager.readAgentResponse('cold', parent);
        const savedInfo = fs.readFileSync(info.infoFile, 'utf8');
        const history = fs.readFileSync(info.sessionFile, 'utf8');
        await manager.spawnAgent(spawnParams(parent, 'busy', 'hold capacity'));
        const noticesBefore = notices.length,
          activityBefore = activity.length;
        for (let attempt = 0; attempt < 2; attempt++)
          await expect(manager.sendMessage(parent, 'cold', 'must not resume')).rejects.toThrow(
            /capacity|maxAgents|limit/i,
          );
        expect(manager.getAgentInfo('cold', parent)).toEqual(before);
        expect(manager.readAgentResponse('cold', parent)).toEqual(response);
        expect(manager.readAgentResponse('cold', parent)).toEqual(response);
        expect(fs.readFileSync(info.infoFile, 'utf8')).toBe(savedInfo);
        expect(fs.readFileSync(info.sessionFile, 'utf8')).toBe(history);
        expect(notices).toHaveLength(noticesBefore);
        expect(activity).toHaveLength(activityBefore);
        expect(fixture.instances).toHaveLength(2);
        expect(manager['live'].size).toBe(1);
        expect(manager.listAgents(undefined, parent)).toEqual([
          { agent_name: 'busy', agent_status: 'running' },
        ]);
        await manager.interruptAgent(parent, 'busy');
        expect(await manager.sendMessage(parent, 'cold', 'recovered')).toEqual({
          delivery: 'prompt',
        });
        await settled(manager, info);
        expect(manager.readAgentResponse('cold', parent).finalResponse).toBe('response:recovered');
        expect(manager.listAgents(undefined, parent)).toEqual([
          { agent_name: 'cold', agent_status: 'completed' },
        ]);
        expect(fixture.instances).toHaveLength(3);
      } finally {
        await manager.shutdown();
      }
    },
  );

  test('startup failure holds its slot through cleanup and releases it for the next real admission', async () => {
    writeConfig({ maxAgents: 1 });
    const gate = Promise.withResolvers<void>();
    fixture.shutdownGate = gate.promise;
    fixture.onStart = () => {
      throw new Error('capacity startup failure');
    };
    const parent = 'capacity-failure-' + randomUUID();
    const manager = new AgentManager({ onError() {} });
    const pending = manager
      .spawnAgent(spawnParams(parent, 'broken', 'must not run'))
      .catch((error) => error);
    try {
      await waitUntil(() => fixture.instances[0]?.shutdowns === 1);
      expect(manager['live'].size).toBe(1);
      await expect(manager.spawnAgent(spawnParams(parent, 'next', 'must not run'))).rejects.toThrow(
        /capacity|maxAgents|limit/i,
      );
      expect(manager.listAgentInfos(undefined, parent).map((info) => info.taskName)).toEqual([
        'broken',
      ]);
      expect(manager.listAgents(undefined, parent)).toEqual([
        { agent_name: 'broken', agent_status: 'failed' },
      ]);
      gate.resolve();
      expect((await pending).message).toContain('capacity startup failure');
      await released(manager, manager.getAgentInfo('broken', parent));
      expect(manager.listAgents(undefined, parent)).toEqual([]);
      fixture.onStart = undefined;
      await manager.spawnAgent(spawnParams(parent, 'next', 'hold next'));
      expect(manager['live'].size).toBe(1);
      expect(fixture.instances).toHaveLength(2);
    } finally {
      gate.resolve();
      await pending;
      await manager.shutdown();
    }
  });

  test('a capacity eviction timeout never releases the closing slot before the shutdown hook exits', async () => {
    writeConfig({ maxAgents: 1 });
    const gate = Promise.withResolvers<void>();
    const manager = new AgentManager({ onError() {} });
    const parent = 'capacity-timeout-' + randomUUID();
    let timers: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'old', 'first'));
      const old = manager.getAgentInfo('old', parent);
      await settled(manager, old);
      const live = manager['live'].get(old.id)!;
      fixture.shutdownGate = gate.promise;
      const original = globalThis.setTimeout;
      timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: any,
        ms: number,
        ...args: any[]
      ) =>
        original(callback, ms === 2000 || ms === 5000 ? 100 : ms, ...args)) as typeof setTimeout);
      await expect(
        manager.spawnAgent(spawnParams(parent, 'replacement', 'must not start early')),
      ).rejects.toThrow(/closing|cleanup|timed out/i);
      expect(live.closing).toBe(true);
      expect(manager['live'].get(old.id)).toBe(live);
      expect(manager['live'].size).toBe(1);
      expect(fs.existsSync(activeMarker(old.id))).toBe(true);
      expect(fixture.instances).toHaveLength(1);
      await expect(
        manager.spawnAgent(spawnParams(parent, 'another', 'must not start early')),
      ).rejects.toThrow(/capacity|maxAgents|limit/i);
      expect(manager.listAgentInfos(undefined, parent).map((info) => info.taskName)).toEqual([
        'old',
      ]);
      expect(manager.listAgents(undefined, parent)).toEqual([
        { agent_name: 'old', agent_status: 'completed' },
      ]);
      gate.resolve();
      await released(manager, old);
      expect(manager.listAgents(undefined, parent)).toEqual([]);
      timers.mockRestore();
      await manager.spawnAgent(spawnParams(parent, 'replacement', 'hold after cleanup'));
      expect(manager['live'].size).toBe(1);
      expect(fixture.instances).toHaveLength(2);
    } finally {
      timers?.mockRestore();
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('shutdown wins a pending capacity eviction and reentrant cleanup cannot admit new work', async () => {
    writeConfig({ maxAgents: 1 });
    const gate = Promise.withResolvers<void>();
    const parent = 'capacity-shutdown-' + randomUUID();
    const manager = new AgentManager({ onError() {} });
    let reentered: Promise<unknown> | undefined, replacement: Promise<unknown> | undefined;
    let stopping: Promise<unknown> | undefined;
    fixture.onShutdown = async () => {
      reentered = manager
        .spawnAgent(spawnParams(parent, 'reentrant', 'must not run'))
        .catch((error) => error);
      await gate.promise;
    };
    try {
      await manager.spawnAgent(spawnParams(parent, 'old', 'first'));
      const old = manager.getAgentInfo('old', parent);
      await settled(manager, old);
      const live = manager['live'].get(old.id)!;
      replacement = manager
        .spawnAgent(spawnParams(parent, 'replacement', 'must not run'))
        .catch((error) => error);
      await waitUntil(() => fixture.instances[0].shutdowns === 1);
      expect(await reentered).toBeInstanceOf(Error);
      expect(manager['terminateSession'](live)).toBe(live.termination);
      expect(manager['live'].size).toBe(1);
      stopping = manager.shutdown();
      const again = manager.shutdown();
      gate.resolve();
      expect(await replacement).toBeInstanceOf(Error);
      await Promise.all([stopping, again]);
      expect(manager['live'].size).toBe(0);
      expect(fixture.instances).toHaveLength(1);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(manager.listAgentInfos(undefined, parent).map((info) => info.taskName)).toEqual([
        'old',
      ]);
      await expect(
        manager.spawnAgent(spawnParams(parent, 'after', 'must not run')),
      ).rejects.toThrow(/abort|shut/i);
    } finally {
      gate.resolve();
      await reentered;
      await replacement;
      await stopping;
      await manager.shutdown();
    }
  });

  test('two cold resumes of the same ID racing separate evictions cannot overwrite the winning live run', async () => {
    writeConfig({ maxAgents: 2 });
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const parent = 'double-cold-capacity-' + randomUUID();
    const manager = new AgentManager();
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
    let shutdowns = 0;
    try {
      await manager.spawnAgent(spawnParams(parent, 'cold', 'first'));
      const cold = manager.getAgentInfo('cold', parent);
      await coldDispose(manager, cold);
      for (const task of ['a', 'b']) {
        await manager.spawnAgent(spawnParams(parent, task, 'victim ' + task));
        await settled(manager, manager.getAgentInfo(task, parent));
      }
      fixture.onShutdown = async () => {
        await gates[shutdowns++]?.promise;
      };
      first = manager.sendMessage(parent, 'cold', 'hold winning resume').catch((error) => error);
      await waitUntil(() => shutdowns === 1);
      second = manager.sendMessage(parent, 'cold', 'hold losing resume').catch((error) => error);
      await waitUntil(() => shutdowns === 2);
      expect(manager['live'].size).toBe(2);
      expect([...manager['live'].values()].every((live) => live.closing)).toBe(true);
      expect(fixture.instances).toHaveLength(3);
      gates[0].resolve();
      expect(await first).toEqual({ delivery: 'prompt' });
      const winner = manager['live'].get(cold.id)!;
      const run = winner.run;
      expect(winner.info.messageCount).toBe(2);
      gates[1].resolve();
      const rejected = await second;
      expect(rejected).toBeInstanceOf(Error);
      expect((rejected as Error).message).toMatch(/live session|startup|starting/i);
      expect(manager['live'].get(cold.id)).toBe(winner);
      expect(winner.run).toBe(run);
      expect(winner.info).toMatchObject({
        messageCount: 2,
        lastTaskMessage: 'hold winning resume',
        status: 'running',
      });
      expect(manager['live'].size).toBe(1);
      expect(fixture.instances).toHaveLength(4);
      expect(sessionMessages(cold).filter((message) => message.role === 'user')).toHaveLength(2);
    } finally {
      gates.forEach((gate) => gate.resolve());
      await Promise.all([first, second]);
      await manager.shutdown();
    }
  });

  test.each(['accepted', 'unaccepted'] as const)(
    'cold resume refreshes metadata after eviction before an %s turn; a second cold caller cannot double-claim',
    async (outcome) => {
      writeConfig({ maxAgents: 1 });
      const gate = Promise.withResolvers<void>();
      const parent = 'capacity-refresh-' + randomUUID();
      const notices: any[] = [];
      const manager = new AgentManager({ onCompletion: (event) => notices.push(event) });
      let resuming: Promise<unknown> | undefined;
      let reject: ReturnType<typeof spyOn> | undefined;
      try {
        await manager.spawnAgent(spawnParams(parent, 'cold', 'first'));
        const cold = manager.getAgentInfo('cold', parent);
        await coldDispose(manager, cold);
        await manager.spawnAgent(spawnParams(parent, 'victim', 'second'));
        await settled(manager, manager.getAgentInfo('victim', parent));
        fixture.shutdownGate = gate.promise;
        resuming = manager.sendMessage(parent, 'cold', 'fresh resume').catch((error) => error);
        await waitUntil(() => fixture.instances[1].shutdowns === 1);
        await expect(manager.sendMessage(parent, 'cold', 'duplicate cold resume')).rejects.toThrow(
          /capacity|maxAgents|limit/i,
        );
        expect(manager['live'].size).toBe(1);
        expect(fixture.instances).toHaveLength(2);
        // Simulate another completed continuation while this admission yielded to cleanup.
        const latest = {
          ...manager.getAgentInfo('cold', parent),
          messageCount: 7,
          finalResponse: 'newer persisted result',
          lastTaskMessage: 'newer persisted task',
          completedAt: Date.now(),
        };
        fs.writeFileSync(cold.infoFile, JSON.stringify(latest));
        const history = fs.readFileSync(cold.sessionFile, 'utf8');
        const noticesBefore = notices.length;
        if (outcome === 'unaccepted')
          reject = spyOn(codingAgent.AgentSession.prototype, 'prompt').mockRejectedValueOnce(
            new Error('capacity unaccepted resume'),
          );
        gate.resolve();
        const result = await resuming;
        await settled(manager, cold);
        if (outcome === 'accepted') {
          expect(result).toEqual({ delivery: 'prompt' });
          expect(manager.getAgentInfo('cold', parent)).toMatchObject({
            messageCount: 8,
            finalResponse: 'response:fresh resume',
          });
          expect(notices).toHaveLength(noticesBefore + 1);
        } else {
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).message).toContain('capacity unaccepted resume');
          expect(manager.getAgentInfo('cold', parent)).toMatchObject({
            status: latest.status,
            messageCount: latest.messageCount,
            finalResponse: latest.finalResponse,
            lastTaskMessage: latest.lastTaskMessage,
            completedAt: latest.completedAt,
          });
          expect(manager.readAgentResponse('cold', parent).finalResponse).toBe(
            latest.finalResponse,
          );
          expect(fs.readFileSync(cold.sessionFile, 'utf8')).toBe(history);
          expect(notices).toHaveLength(noticesBefore);
        }
        expect(manager['live'].size).toBeLessThanOrEqual(1);
        expect(fixture.instances).toHaveLength(3);
      } finally {
        gate.resolve();
        await resuming;
        reject?.mockRestore();
        await manager.shutdown();
      }
    },
  );

  test('eviction marks closing before a shutdown hook reenters send and holds JSONL ownership', async () => {
    writeConfig({ maxAgents: 1 });
    const gate = Promise.withResolvers<void>();
    const manager = new AgentManager();
    const parent = 'eviction-reentry-' + randomUUID();
    let reentered: Promise<unknown> | undefined, replacement: Promise<unknown> | undefined;
    let first = true;
    fixture.onShutdown = async () => {
      if (!first) return;
      first = false;
      reentered = manager
        .sendMessage(parent, 'a', 'reentered after real close')
        .catch((error) => error);
      await gate.promise;
    };
    try {
      await manager.spawnAgent(spawnParams(parent, 'a', 'first'));
      const a = manager.getAgentInfo('a', parent);
      await settled(manager, a);
      const old = manager['live'].get(a.id)!;
      const dispose = spyOn(old.session!, 'dispose');
      replacement = manager.spawnAgent(spawnParams(parent, 'b', 'hold replacement'));
      await waitUntil(() => Boolean(reentered));
      expect(old.closing).toBe(true);
      expect(manager['live'].get(a.id)).toBe(old);
      expect(fs.existsSync(activeMarker(a.id))).toBe(true);
      expect(dispose).not.toHaveBeenCalled();
      expect(fixture.instances).toHaveLength(1);
      gate.resolve();
      await replacement;
      expect(await reentered).toBeInstanceOf(Error);
      expect(manager['live'].size).toBe(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(sessionMessages(a).filter((message) => message.role === 'user')).toHaveLength(1);
      await manager.interruptAgent(parent, 'b');
      await manager.sendMessage(parent, 'a', 'reentered after real close');
      await settled(manager, a);
      expect(manager['live'].get(a.id)!.session).not.toBe(old.session);
      expect(fixture.instances).toHaveLength(3);
      expect(
        sessionMessages(a)
          .filter((message) => message.role === 'user')
          .map((message) =>
            typeof message.content === 'string'
              ? message.content
              : message.content.map((part: any) => part.text).join(''),
          ),
      ).toEqual(['first', 'reentered after real close']);
    } finally {
      gate.resolve();
      await reentered;
      await replacement;
      await manager.shutdown();
    }
  });

  test('two concurrent idle sends claim one run before asynchronous input preflight', async () => {
    const gate = Promise.withResolvers<void>();
    const manager = new AgentManager();
    const parent = 'two-idle-sends-' + randomUUID();
    let first: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      fixture.input = async (event) => {
        if (event.text === 'new round') await gate.promise;
      };
      first = manager.sendMessage(parent, 'worker', 'new round');
      const second = manager.sendMessage(parent, 'worker', 'concurrent duplicate');
      await expect(second).rejects.toThrow(/starting/);
      await waitUntil(() => fixture.instances[0].inputs.length === 2);
      expect(fixture.instances).toHaveLength(1);
      expect(manager['live'].get(info.id)!.run!.awaitingPrompt).toBe(true);
      gate.resolve();
      expect(await first).toEqual({ delivery: 'prompt' });
      await settled(manager, info);
      expect(manager.getAgentInfo('worker', parent).messageCount).toBe(2);
      expect(fixture.instances[0].requests.map((r) => r.text)).toEqual(['first', 'new round']);
    } finally {
      gate.resolve();
      await first;
      await manager.shutdown();
    }
  });

  test('an interrupt racing an idle send observes the newly registered run, not the old final', async () => {
    const manager = new AgentManager();
    const parent = 'idle-send-interrupt-' + randomUUID();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      const session = manager['live'].get(info.id)!.session;
      const sending = manager.sendMessage(parent, 'worker', 'hold new run').catch((e) => e);
      const interrupted = await manager.interruptAgent(parent, 'worker');
      await sending;
      expect(interrupted.previous_status).toBe('running');
      await settled(manager, info);
      expect(manager.getAgentInfo('worker', parent).status).toBe('interrupted');
      expect(manager['live'].get(info.id)!.session).toBe(session);
      await manager.sendMessage(parent, 'worker', 'recovered');
      await settled(manager, info);
      expect(manager['live'].get(info.id)!.session).toBe(session);
      expect(fixture.instances).toHaveLength(1);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:recovered');
    } finally {
      await manager.shutdown();
    }
  });

  test('an idle extension shutdown closes the session without replacing its old result', async () => {
    const notices: any[] = [];
    const manager = new AgentManager({ onCompletion: (e) => notices.push(e) });
    const parent = 'idle-extension-shutdown-' + randomUUID();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      const before = manager.readAgentResponse('worker', parent);
      fixture.instances[0].ctx!.shutdown();
      expect(manager['live'].get(info.id)!.closing).toBe(true);
      await released(manager, info);
      expect(manager.readAgentResponse('worker', parent)).toEqual(before);
      expect(notices).toHaveLength(1);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally {
      await manager.shutdown();
    }
  });

  test('a fatal persistence failure after steering still closes the native session', async () => {
    const manager = new AgentManager({ onError() {} });
    const parent = 'steer-save-failure-' + randomUUID();
    let save: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold first'));
      const info = manager.getAgentInfo('worker', parent);
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const rename = fs.renameSync;
      save = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to) === info.infoFile) throw new Error('steer persistence failed');
        return rename(from, to);
      });
      await expect(manager.sendMessage(parent, 'worker', 'new instruction')).rejects.toThrow(
        'steer persistence failed',
      );
      save.mockRestore();
      await released(manager, info);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fixture.instances[0].activeStreams).toBe(0);
    } finally {
      save?.mockRestore();
      await manager.shutdown();
    }
  });

  test('old response timers and finish callbacks cannot touch the next run', async () => {
    const gate = Promise.withResolvers<void>();
    fixture.responseGate = gate.promise;
    const callbacks: Array<() => void> = [];
    const original = globalThis.setTimeout;
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: any,
      ms: number,
      ...args: any[]
    ) => {
      if (ms === 1000) callbacks.push(callback);
      return original(callback, ms, ...args);
    }) as typeof setTimeout);
    const manager = new AgentManager({ modelResponseTimeoutMs: 1000 });
    const parent = 'old-timer-' + randomUUID();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      const old = live.run!;
      await settled(manager, info);
      expect(old.modelResponseTimer).toBeUndefined();
      await manager.sendMessage(parent, 'worker', 'hold second');
      await waitUntil(() => callbacks.length === 2);
      const current = live.run!;
      const currentTimer = current.modelResponseTimer;
      old.candidateResponse = 'stale answer';
      old.candidateError = 'stale error';
      callbacks[0]();
      manager['finishRun'](live, old, new Error('late execution failure'));
      expect(live.run).toBe(current);
      expect(current.cancellation.signal.aborted).toBe(false);
      expect(current.modelResponseTimer).toBe(currentTimer);
      expect(manager.getAgentInfo('worker', parent).status).toBe('running');
      gate.resolve();
      await settled(manager, info);
      expect(manager.readAgentResponse('worker', parent)).toMatchObject({
        status: 'completed',
        finalResponse: 'response:hold second',
      });
    } finally {
      timers.mockRestore();
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('one observer connection spans native runs and handled input without duplicate settled rows', async () => {
    const gate = Promise.withResolvers<void>();
    const interruptionGate = Promise.withResolvers<void>();
    fixture.responseGate = gate.promise;
    const manager = new AgentManager();
    const parent = 'hot-observer-' + randomUUID();
    const events: any[] = [];
    let socket: net.Socket | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold first'));
      const info = manager.getAgentInfo('worker', parent);
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      socket = net.connect(getSocketPath(info.id));
      const decoder = new ObserverJsonlDecoder();
      socket.on('data', (chunk) => {
        for (const line of decoder.push(chunk)) events.push(JSON.parse(line));
      });
      socket.on('error', () => {});
      await waitUntil(() => events[0]?.type === 'sync');
      gate.resolve();
      await settled(manager, info);
      await manager.sendMessage(parent, 'worker', 'handled empty');
      await settled(manager, info);
      await manager.sendMessage(parent, 'worker', 'third');
      await settled(manager, info);
      fixture.responseGate = interruptionGate.promise;
      await manager.sendMessage(parent, 'worker', 'hold fourth');
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      await manager.interruptAgent(parent, 'worker');
      await settled(manager, info);
      await waitUntil(() => events.filter((e) => e.type === 'agent_settled').length === 4);
      expect(socket.destroyed).toBe(false);
      expect(events.filter((e) => e.type === 'sync')).toHaveLength(1);
      expect(
        events
          .filter(
            (e) =>
              e.type === 'message_end' &&
              e.message.role === 'assistant' &&
              e.message.stopReason === 'stop',
          )
          .map((e) => e.message.content[0].text),
      ).toEqual(['response:hold first', 'response:third']);
      const [sync] = await readSocketEvents(getSocketPath(info.id), 1);
      expect(sync).toMatchObject({
        status: 'done',
        partialMessage: null,
        userMessage: null,
        activeTools: [],
      });
      expect(fixture.instances).toHaveLength(1);
    } finally {
      socket?.destroy();
      interruptionGate.resolve();
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('manager shutdown drains mixed active/idle/closing sessions despite save and hook failures', async () => {
    writeConfig({ maxAgents: 3 });
    const gate = Promise.withResolvers<void>();
    const errors: Error[] = [];
    const completions: any[] = [];
    const manager = new AgentManager({
      onError: (e) => errors.push(e),
      onCompletion: (e) => completions.push(e),
    });
    const parent = 'mixed-shutdown-' + randomUUID();
    let hook = 0;
    fixture.onShutdown = async () => {
      if (++hook === 1) {
        await gate.promise;
        throw new Error('mixed hook failure');
      }
    };
    let save: ReturnType<typeof spyOn> | undefined;
    let stopping: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'closing', 'first'));
      const closing = manager.getAgentInfo('closing', parent);
      await settled(manager, closing);
      void manager['terminateSession'](manager['live'].get(closing.id)!);
      await manager.spawnAgent(spawnParams(parent, 'idle', 'second'));
      const idle = manager.getAgentInfo('idle', parent);
      await settled(manager, idle);
      const idleFinal = manager.getAgentInfo('idle', parent);
      await waitUntil(() => hook === 1);
      await manager.spawnAgent(spawnParams(parent, 'active', 'hold active'));
      const active = manager.getAgentInfo('active', parent);
      const rename = fs.renameSync;
      save = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to) === active.infoFile) throw new Error('mixed save failure');
        return rename(from, to);
      });
      stopping = manager.shutdown().catch((error) => error);
      expect([...manager['live'].values()].every((live) => live.closing)).toBe(true);
      gate.resolve();
      expect(await stopping).toBeInstanceOf(AggregateError);
      expect(manager['live'].size).toBe(0);
      expect(fixture.instances.map((i) => i.shutdowns)).toEqual([1, 1, 1]);
      expect(manager.getAgentInfo('idle', parent)).toMatchObject({
        status: 'completed',
        finalResponse: idleFinal.finalResponse,
        completedAt: idleFinal.completedAt,
      });
      expect(manager.getAgentInfo('closing', parent).status).toBe('completed');
      expect(completions).toHaveLength(2);
      expect(errors.some((e) => e.message.includes('mixed hook failure'))).toBe(true);
      expect(errors.some((e) => e.message.includes('mixed save failure'))).toBe(true);
    } finally {
      save?.mockRestore();
      gate.resolve();
      await stopping;
      await manager.shutdown();
    }
  });

  test.each([false, true])(
    'a changed parent trust decision rebuilds idle resources (was %s)',
    async (initial) => {
      let trusted = initial;
      const manager = new AgentManager({ projectTrusted: () => trusted });
      const parent = 'hot-trust-' + randomUUID();
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
        const info = manager.getAgentInfo('worker', parent);
        await settled(manager, info);
        const first = manager['live'].get(info.id)!.session!;
        expect(first.settingsManager.isProjectTrusted()).toBe(initial);
        trusted = !initial;
        await manager.sendMessage(parent, 'worker', 'second');
        await settled(manager, info);
        const second = manager['live'].get(info.id)!.session!;
        expect(second).not.toBe(first);
        expect(second.settingsManager.isProjectTrusted()).toBe(!initial);
        expect(fixture.instances.map((i) => i.shutdowns)).toEqual([1, 0]);
        expect(sessionMessages(info).filter((m) => m.role === 'user')).toHaveLength(2);
      } finally {
        await manager.shutdown();
      }
    },
  );

  test('an idle child remains exclusively owned by its manager, not a cross-parent/host cache', async () => {
    const owner = new AgentManager();
    const other = new AgentManager();
    const parent = 'hot-owner-' + randomUUID();
    try {
      await owner.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = owner.getAgentInfo('worker', parent);
      await settled(owner, info);
      await expect(other.sendMessage(parent, 'worker', 'takeover')).rejects.toThrow(/another host/);
      await expect(owner.sendMessage('another-parent', 'worker', 'takeover')).rejects.toThrow(
        /not found/,
      );
      expect(fixture.instances).toHaveLength(1);
      expect(fs.existsSync(activeMarker(info.id))).toBe(true);
    } finally {
      await Promise.allSettled([owner.shutdown(), other.shutdown()]);
    }
  });

  test('a cold resume refuses missing JSONL without changing the last result or opening empty history', async () => {
    const completions: any[] = [];
    const manager = new AgentManager({ onCompletion: (e) => completions.push(e) });
    const parent = 'missing-history-' + randomUUID();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await coldDispose(manager, info);
      const before = manager.getAgentInfo('worker', parent);
      fs.unlinkSync(info.sessionFile);
      await expect(manager.sendMessage(parent, 'worker', 'must not start empty')).rejects.toThrow(
        /history is missing/,
      );
      expect(manager.getAgentInfo('worker', parent)).toEqual(before);
      expect(fixture.instances).toHaveLength(1);
      expect(completions).toHaveLength(1);
      expect(fs.existsSync(info.sessionFile)).toBe(false);
    } finally {
      await manager.shutdown();
    }
  });

  test('a handled first prompt still creates native header-only history for safe cold resume', async () => {
    const manager = new AgentManager();
    const parent = 'handled-history-' + randomUUID();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'handled first'));
      const info = manager.getAgentInfo('worker', parent);
      await coldDispose(manager, info);
      expect(sessionMessages(info)).toEqual([]);
      expect(JSON.parse(fs.readFileSync(info.sessionFile, 'utf8').split('\n')[0]).type).toBe(
        'session',
      );
      await manager.sendMessage(parent, 'worker', 'second');
      await coldDispose(manager, info);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:second');
      expect(fixture.instances.map((i) => i.shutdowns)).toEqual([1, 1]);
    } finally {
      await manager.shutdown();
    }
  });

  test('SYSTEM replaces the native base while APPEND is added; warm reuse keeps both and cold recreation rereads both', async () => {
    const system = path.join(TEST_AGENT_DIR, 'pi-subagents', 'SYSTEM.md');
    const append = path.join(TEST_AGENT_DIR, 'pi-subagents', 'APPEND_SYSTEM.md');
    const manager = new AgentManager();
    const originalSystem = fs.existsSync(system) ? fs.readFileSync(system) : undefined;
    const originalAppend = fs.existsSync(append) ? fs.readFileSync(append) : undefined;
    const parent = 'hot-resources-' + randomUUID();
    try {
      fs.writeFileSync(
        system,
        'FIRST_RESIDENT_SYSTEM\n<docs>User-authored documentation stays.</docs>',
      );
      fs.writeFileSync(
        append,
        'FIRST_RESIDENT_APPEND\n<skills>User-authored skill guidance stays.</skills>',
      );
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      const first = getCurrentSystemMessage(fixture.instances[0].requests[0].context.messages)!;
      expect(first.sections).toEqual({
        preamble: 'FIRST_RESIDENT_SYSTEM\n<docs>User-authored documentation stays.</docs>',
        addendum:
          '<addendum>\nFIRST_RESIDENT_APPEND\n<skills>User-authored skill guidance stays.</skills>\n</addendum>',
      });
      fs.writeFileSync(system, 'SECOND_COLD_SYSTEM');
      fs.writeFileSync(append, 'SECOND_COLD_APPEND');
      await manager.sendMessage(parent, 'worker', 'second');
      await settled(manager, info);
      expect(fixture.instances).toHaveLength(1);
      const second = getCurrentSystemMessage(fixture.instances[0].requests[1].context.messages)!;
      expect(second.sections).toEqual(first.sections);
      await manager['waitForTermination'](manager['live'].get(info.id)!);
      await manager.sendMessage(parent, 'worker', 'third');
      await settled(manager, info);
      expect(fixture.instances).toHaveLength(2);
      expect(
        getCurrentSystemMessage(fixture.instances[1].requests[0].context.messages)!.sections,
      ).toEqual({
        preamble: 'SECOND_COLD_SYSTEM',
        addendum: '<addendum>\nSECOND_COLD_APPEND\n</addendum>',
      });
    } finally {
      await manager.shutdown();
      if (originalSystem === undefined) fs.rmSync(system, { force: true });
      else fs.writeFileSync(system, originalSystem);
      if (originalAppend === undefined) fs.rmSync(append, { force: true });
      else fs.writeFileSync(append, originalAppend);
    }
  });

  test('warm unaccepted rollback restores the previous result without another completion', async () => {
    const gate = Promise.withResolvers<void>();
    const notices: any[] = [];
    const manager = new AgentManager({ onCompletion: (e) => notices.push(e) });
    const parent = 'hot-rollback-' + randomUUID();
    let pending: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      const before = manager.readAgentResponse('worker', parent);
      fixture.input = async (event) => {
        if (event.text === 'unaccepted') await gate.promise;
      };
      pending = manager.sendMessage(parent, 'worker', 'unaccepted').catch((e) => e);
      await waitUntil(() => fixture.instances[0].inputs.length === 2);
      const session = manager['live'].get(info.id)!.session!;
      spyOn(session.modelRuntime, 'hasConfiguredAuth').mockReturnValue(false);
      spyOn(session.modelRuntime, 'checkAuth').mockResolvedValue(undefined);
      gate.resolve();
      expect(await pending).toBeInstanceOf(Error);
      await released(manager, info);
      expect(manager.readAgentResponse('worker', parent)).toEqual(before);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        status: 'completed',
        messageCount: 1,
        finalResponse: 'response:first',
      });
      expect(notices).toHaveLength(1);
      expect(fixture.instances).toHaveLength(1);
      expect(fixture.instances[0].requests).toHaveLength(1);
    } finally {
      gate.resolve();
      await pending;
      await manager.shutdown();
    }
  });

  test('a warm acceptance timeout closes conservatively and late input cannot leak into recovery', async () => {
    const gate = Promise.withResolvers<void>();
    const manager = new AgentManager({ onError() {} });
    const parent = 'hot-acceptance-timeout-' + randomUUID();
    let timers: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      fixture.input = async (event) => {
        if (event.text === 'hold late') await gate.promise;
      };
      const original = globalThis.setTimeout;
      timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: any,
        ms: number,
        ...args: any[]
      ) =>
        original(callback, ms === 15000 || ms === 2000 ? 80 : ms, ...args)) as typeof setTimeout);
      await expect(manager.sendMessage(parent, 'worker', 'hold late')).rejects.toThrow(
        /prompt acceptance/,
      );
      expect(manager['live'].get(info.id)!.closing).toBe(true);
      await expect(manager.sendMessage(parent, 'worker', 'must not reopen')).rejects.toThrow(
        /closing/,
      );
      expect(fixture.instances).toHaveLength(1);
      gate.resolve();
      await released(manager, info);
      timers.mockRestore();
      await manager.sendMessage(parent, 'worker', 'recovered');
      await settled(manager, info);
      expect(fixture.instances).toHaveLength(2);
      expect(fixture.instances.flatMap((i) => i.requests.map((r) => r.text))).toEqual([
        'first',
        'recovered',
      ]);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:recovered');
    } finally {
      timers?.mockRestore();
      gate.resolve();
      await manager.shutdown();
    }
  });
});

describe('SDK lifecycle and cancellation races', () => {
  test('spawn returns on native acceptance, then reuses the same native session and history', async () => {
    const gate = Promise.withResolvers<void>();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'lifecycle-' + randomUUID();
    const manager = new AgentManager();
    try {
      expect(await manager.spawnAgent(spawnParams(parent, 'worker', 'hold first'))).toEqual({
        task_name: 'worker',
        nickname: null,
      });
      const info = manager.getAgentInfo('worker', parent);
      expect(info.status).toBe('running');
      const firstSession = manager['live'].get(info.id)!.session!;
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      gate.resolve();
      await settled(manager, info);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:hold first');
      expect(fixture.instances[0].shutdowns).toBe(0);
      expect(await manager.sendMessage(parent, 'worker', 'second')).toEqual({ delivery: 'prompt' });
      const secondSession = manager['live'].get(info.id)?.session;
      expect(secondSession).toBe(firstSession);
      expect(secondSession?.modelRuntime).toBe(firstSession.modelRuntime);
      await settled(manager, info);
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
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([0]);
      expect(
        fixture.instances[0].requests[1].context.messages
          .filter((entry: any) => entry.role !== 'system')
          .map((entry: any) => entry.role),
      ).toEqual(['user', 'assistant', 'user']);
      expect(fixture.instances).toHaveLength(1);
      expect(fs.existsSync(activeMarker(info.id))).toBe(true);
      expect(fs.existsSync(peekMarker(info.id))).toBe(true);
      await manager.shutdown();
      await released(manager, info);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('steers a running native session without opening a second session', async () => {
    const gate = Promise.withResolvers<void>();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'steer-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold initial'));
      expect(await manager.sendMessage(parent, 'worker', 'next instruction')).toEqual({
        delivery: 'steer',
      });
      expect(fixture.instances).toHaveLength(1);
      gate.resolve();
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
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
        onCompletion: (event) => completions.push(event),
      });
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', command + ' now'));
        const info = manager.getAgentInfo('worker', parent);
        await settled(manager, info);
        expect(manager.getAgentInfo('worker', parent).status).toBe('failed');
        expect(manager.readAgentResponse('worker', parent).error).toContain(
          command === 'fail' ? 'fixture failure' : 'aborted',
        );
        expect(completions).toHaveLength(1);
        expect(fixture.instances[0].shutdowns).toBe(0);
      } finally {
        await manager.shutdown();
      }
    },
  );

  test("handled input ends with this run's empty response, never the previous answer", async () => {
    const parent = 'handled-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:first');
      await manager.sendMessage(parent, 'worker', 'handled empty');
      await settled(manager, info);
      const after = manager.getAgentInfo('worker', parent);
      expect(after.status).toBe('completed');
      expect(after.finalResponse ?? '').toBe('');
      expect(after.messageCount).toBe(2);
      expect(fixture.instances).toHaveLength(1);
      expect(fixture.instances[0].requests).toHaveLength(1);
      expect(manager['live'].get(info.id)!.broadcaster['status']).toBe('done');
      expect(completions).toHaveLength(2);
      expect(completions[1].finalResponse ?? '').toBe('');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(manager.getAgentInfo('worker', parent).status).toBe('completed');
    } finally {
      await manager.shutdown();
    }
  });

  test('handled input that starts native work is not finalized or disposed before native idle', async () => {
    const gate = Promise.withResolvers<void>();
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
      await settled(manager, info);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe(
        'response:hold handled-owned-work',
      );
      expect(fixture.instances[0].shutdowns).toBe(0);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test.each(['initialization', 'input'])(
    'interrupt tracks late %s until it exits, without rollback or duplicate completion',
    async (phase) => {
      const gate = Promise.withResolvers<void>();
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
        onCompletion: (event) => completions.push(event),
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
        await coldDispose(manager, info);
        expect(manager.getAgentInfo('worker', parent).status).toBe('interrupted');
        expect(completions).toEqual([]);
        expect(manager.readAgentResponse('worker', parent).status).toBe('interrupted');
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
      const gate = Promise.withResolvers<void>();
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
        onCompletion: (event) => completions.push(event),
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
        await settled(manager, info);
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
    const gate = Promise.withResolvers<void>();
    fixture = configureCoreFixture({ responseGate: gate.promise, ignoreAbort: true });
    const parent = 'non-cooperative-' + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold uncooperative'));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo('worker', parent);
      // Explicitly request cold cleanup; interrupt alone now keeps a reusable hot session.
      void manager['terminateSession'](manager['live'].get(info.id)!);
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
      await settled(manager, info);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      await manager.sendMessage(parent, 'worker', 'recovered');
      await settled(manager, info);
      expect(fixture.instances).toHaveLength(2);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:recovered');
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('publishes completion before extension shutdown, but closing cannot reopen the JSONL', async () => {
    const gate = Promise.withResolvers<void>();
    fixture = configureCoreFixture({ shutdownGate: gate.promise });
    const parent = 'shutdown-gate-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({
      onCompletion: (event) => completions.push(event),
      onError() {},
    });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      void manager['terminateSession'](manager['live'].get(info.id)!);
      await waitUntil(() => fixture.instances[0].shutdowns === 1);
      expect(manager.getAgentInfo('worker', parent).status).toBe('completed');
      expect(completions).toHaveLength(1);
      expect(manager['live'].has(info.id)).toBe(true);
      await expect(manager.sendMessage(parent, 'worker', 'must not reopen')).rejects.toThrow(
        /timed out|cleanup|closing/i,
      );
      expect(fixture.instances).toHaveLength(1);
      gate.resolve();
      await settled(manager, info);
      await manager.sendMessage(parent, 'worker', 'second');
      await coldDispose(manager, info);
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([1, 1]);
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('a late steer cannot claim queued success or dispose the session before its input exits', async () => {
    const response = Promise.withResolvers<void>();
    const input = Promise.withResolvers<void>();
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
      await settled(manager, info);
      expect(fixture.instances[0].requests).toHaveLength(1);
      expect(fixture.instances[0].shutdowns).toBe(0);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe(
        'response:hold initial',
      );
      await manager.sendMessage(parent, 'worker', 'clean next round');
      await settled(manager, info);
      expect(fixture.instances).toHaveLength(1);
      expect(fixture.instances[0].requests.map((r) => r.text)).toEqual([
        'hold initial',
        'clean next round',
      ]);
      expect(sessionMessages(info).some((m) => JSON.stringify(m).includes('late steer'))).toBe(
        false,
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
      const response = Promise.withResolvers<void>();
      const input = Promise.withResolvers<void>();
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
        onCompletion: (event) => completions.push(event),
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
        expect(live.run!.cancellation.signal.aborted).toBe(true);
        expect(live.run!.pendingSteers.size).toBe(1);
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
        await waitUntil(() => live.run!.pendingSteers.size === 0);
        if (ignoreAbort) {
          expect(manager['live'].get(info.id)).toBe(live);
          expect(fixture.instances[0].shutdowns).toBe(0);
        }
        response.resolve();
        await settled(manager, info);
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
        await coldDispose(manager, info);
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
    const response = Promise.withResolvers<void>();
    fixture = configureCoreFixture({ responseGate: response.promise });
    const parent = 'steer-rejection-' + randomUUID();
    const manager = new AgentManager();
    let steer: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold original'));
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      const rejection = new Error('Timed out waiting for agent worker steering acceptance.');
      steer = spyOn(live.session!, 'steer').mockRejectedValue(rejection);
      await expect(manager.sendMessage(parent, 'worker', 'rejected input')).rejects.toBe(rejection);
      expect(live.run!.cancellation.signal.aborted).toBe(false);
      expect(live.closing).toBe(false);
      expect(live.run!.pendingSteers.size).toBe(0);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        status: 'running',
        lastTaskMessage: 'hold original',
      });
      steer.mockRestore();
      response.resolve();
      await settled(manager, info);
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
      const response = Promise.withResolvers<void>();
      const input = Promise.withResolvers<void>();
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
        await settled(manager, info);
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
        await settled(manager, info);
        expect(manager.getAgentInfo('worker', parent).status).toBe('interrupted');
        expect(fixture.instances[0].requests).toEqual([]);
        expect(fixture.instances[0].shutdowns).toBe(1);
        fixture = configureCoreFixture();
        await manager.spawnAgent(spawnParams(parent, 'sibling', 'parent still alive'));
        await settled(manager, manager.getAgentInfo('sibling', parent));
        expect(manager.readAgentResponse('sibling', parent).status).toBe('completed');
      } finally {
        await manager.shutdown();
      }
    },
  );

  test('shutdown takes ownership of pending initialization and refuses all new submissions', async () => {
    const gate = Promise.withResolvers<void>();
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
    writeConfig({ maxAgents: 1 });
    const parent = 'concurrent-resume-' + randomUUID();
    const manager = new AgentManager();
    const gate = Promise.withResolvers<void>();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await coldDispose(manager, info);
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
      await settled(manager, info);
      expect(fixture.instances[0].activeTools).toBe(0);
      expect(fixture.instances[0].shutdowns).toBe(0);
    } finally {
      await manager.shutdown();
    }
  });

  test('times out an endlessly streaming assistant response and releases its native resources', async () => {
    const parent = 'response-deadline-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({
      modelResponseTimeoutMs: 80,
      onCompletion: (event) => completions.push(event),
    });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'stream forever'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
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
    const gate = Promise.withResolvers<void>();
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
      await settled(manager, info);
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
        await coldDispose(manager, info);
        expect(manager['live'].size).toBe(0);
        expect(live?.run?.modelResponseTimer).toBeUndefined();
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
    const completions: any[] = [];
    const manager = new AgentManager({ onCompletion: (event) => completions.push(event) });
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
      expect(completions).toEqual([
        expect.objectContaining({ taskName: 'worker', status: 'failed', error: failed.error }),
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

  test.each(['missing', 'blank'])(
    'a %s SYSTEM uses the native default base and a blank APPEND adds nothing',
    async (state) => {
      const parent = 'empty-system-prompt-' + randomUUID();
      const system = path.join(TEST_AGENT_DIR, 'pi-subagents', 'SYSTEM.md');
      const append = path.join(TEST_AGENT_DIR, 'pi-subagents', 'APPEND_SYSTEM.md');
      const manager = new AgentManager();
      const originalSystem = fs.existsSync(system) ? fs.readFileSync(system) : undefined;
      const originalAppend = fs.existsSync(append) ? fs.readFileSync(append) : undefined;
      try {
        if (state === 'missing') fs.rmSync(system, { force: true });
        else fs.writeFileSync(system, '\uFEFF \n\t');
        fs.writeFileSync(append, '\uFEFF \n\t');
        await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
        await settled(manager, manager.getAgentInfo('worker', parent));
        const message = getCurrentSystemMessage(fixture.instances[0].requests[0].context.messages)!;
        expect(Object.keys(message.sections!)).toEqual(['preamble', 'tools', 'rules']);
        expect(message.sections!.preamble).toContain(
          'You are a coding assistant running inside pi',
        );
        expect(message.sections!.tools).toContain('- read:');
        expect(message.sections!.rules).toContain('- Be concise in your responses');
        expect(message.sections!.rules).toContain(
          'You are a subagent working for a main agent. Work only on the assigned task and follow its scope precisely.',
        );
        expect(manager.readAgentResponse('worker', parent).status).toBe('completed');
        expect(fs.existsSync(system)).toBe(state !== 'missing');
      } finally {
        await manager.shutdown();
        if (originalSystem === undefined) fs.rmSync(system, { force: true });
        else fs.writeFileSync(system, originalSystem);
        if (originalAppend === undefined) fs.rmSync(append, { force: true });
        else fs.writeFileSync(append, originalAppend);
      }
    },
  );

  test('a first-spawn JSONL creation failure publishes a failed completion and inactive status', async () => {
    const parentSessionId = 'lifecycle-jsonl-creation-' + randomUUID();
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const activity: boolean[] = [];
    const manager = new AgentManager({
      onCompletion: (event) => completions.push(event),
      onActivityChange: (event) => activity.push(event.active),
    });
    const original = fs.openSync;
    const open = spyOn(fs, 'openSync').mockImplementation(((
      file: any,
      flags: any,
      ...args: any[]
    ) => {
      if (String(file).endsWith('.jsonl') && flags === 'wx') {
        const error = new Error(
          'EACCES: permission denied, open ' + String(file),
        ) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return original(file, flags, ...args);
    }) as typeof fs.openSync);
    try {
      let returnedError = '';
      try {
        await manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first'));
      } catch (error) {
        returnedError = error instanceof Error ? error.message : String(error);
      }
      expect(returnedError).toContain('EACCES');
      const failed = manager.getAgentInfo('worker', parentSessionId);
      expect(failed.status).toBe('failed');
      expect(failed.error).toBe(returnedError);
      expect(manager['live'].has(failed.id)).toBe(false);
      expect(fs.existsSync(activeMarker(failed.id))).toBe(false);
      expect(activity.at(-1)).toBe(false);
      expect(completions).toEqual([
        expect.objectContaining({ taskName: 'worker', status: 'failed', error: returnedError }),
      ]);
    } finally {
      open.mockRestore();
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });
});

describe('completion delivery', () => {
  test('publishes successful and failed completions', async () => {
    const parentSessionId = 'completion-callbacks';
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = new AgentManager({
      onCompletion: (event: any) => completions.push(event),
    });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'settled', 'first'));
      await waitUntil(() => completions.some((event) => event.taskName === 'settled'));
      expect(completions.filter((event) => event.taskName === 'settled')).toHaveLength(1);
      expect(completions.find((event) => event.taskName === 'settled')).toMatchObject({
        status: 'completed',
        finalResponse: 'response:first',
      });

      await manager.spawnAgent(spawnParams(parentSessionId, 'crashed', 'crash now'));
      await waitUntil(() => completions.some((event) => event.taskName === 'crashed'));
      expect(completions.filter((event) => event.taskName === 'crashed')).toHaveLength(1);
      expect(completions.find((event) => event.taskName === 'crashed')).toMatchObject({
        status: 'failed',
      });
      expect(completions.find((event) => event.taskName === 'crashed').error).toContain(
        'fixture failure',
      );
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test.each(['completed', 'failed'] as const)(
    'publishes %s content once before settlement using a single event argument',
    async (status) => {
      const parentSessionId = 'completion-settlement-' + randomUUID();
      const completions: any[] = [];
      const order: string[] = [];
      const manager = new AgentManager({
        onCompletion: (...events) => {
          completions.push(events);
          order.push('notification');
        },
      });
      try {
        await manager.spawnAgent(
          spawnParams(parentSessionId, 'one', status === 'failed' ? 'crash now' : 'first'),
        );
        await settled(manager, manager.getAgentInfo('one', parentSessionId));
        order.push('settlement');
        expect(completions).toEqual([
          [
            expect.objectContaining({
              parentSessionId,
              taskName: 'one',
              status,
            }),
          ],
        ]);
        expect(order).toEqual(['notification', 'settlement']);
        const [event] = completions[0];
        if (status === 'completed') expect(event.finalResponse).toBe('response:first');
        else expect(event.error).toContain('fixture failure');
        const response = manager.readAgentResponse('one', parentSessionId);
        expect(response).toMatchObject({ status });
        expect(manager.readAgentResponse('one', parentSessionId)).toEqual(response);
        expect(completions).toHaveLength(1);
      } finally {
        await manager.shutdown();
      }
    },
  );

  test('a notification callback failure cannot change the saved result or strand cleanup', async () => {
    const parent = 'notification-failure-' + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({
      onCompletion: () => {
        throw new Error('notification rejected');
      },
      onError: (error) => errors.push(error),
    });
    try {
      await manager.spawnAgent(spawnParams(parent, 'one', 'first'));
      const info = manager.getAgentInfo('one', parent);
      await coldDispose(manager, info);
      expect(manager.readAgentResponse('one', parent)).toMatchObject({
        status: 'completed',
        finalResponse: 'response:first',
      });
      expect(manager['live'].has(info.id)).toBe(false);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      expect(errors.some((error) => error.message === 'notification rejected')).toBe(true);
    } finally {
      await manager.shutdown();
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

describe('SDK business scope and resources', () => {
  test('creates neither prompt file, includes the native identity rule once, and preserves user prompt files', async () => {
    const system = path.join(TEST_AGENT_DIR, 'pi-subagents', 'SYSTEM.md');
    const append = path.join(TEST_AGENT_DIR, 'pi-subagents', 'APPEND_SYSTEM.md');
    const originalSystem = fs.existsSync(system) ? fs.readFileSync(system) : undefined;
    const originalAppend = fs.existsSync(append) ? fs.readFileSync(append) : undefined;
    const managers: InstanceType<typeof AgentManager>[] = [];
    const parent = 'default-identity-' + randomUUID();
    try {
      fs.rmSync(system, { force: true });
      fs.rmSync(append, { force: true });
      const manager = new AgentManager();
      managers.push(manager);
      const identity =
        'You are a subagent working for a main agent. Work only on the assigned task and follow its scope precisely.';
      expect(fs.existsSync(system)).toBe(false);
      expect(fs.existsSync(append)).toBe(false);
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      await manager.sendMessage(parent, 'worker', 'second');
      await settled(manager, info);
      expect(fixture.instances[0].requests).toHaveLength(2);
      for (const request of fixture.instances[0].requests) {
        const message = getCurrentSystemMessage(request.context.messages)!;
        expect(Object.keys(message.sections!)).toEqual(['preamble', 'tools', 'rules']);
        expect(message.sections!.rules!.split(identity)).toHaveLength(2);
      }
      expect(fs.existsSync(system)).toBe(false);
      expect(fs.existsSync(append)).toBe(false);

      fs.writeFileSync(system, 'USER_SYSTEM_MUST_SURVIVE');
      fs.writeFileSync(append, 'USER_APPEND_MUST_SURVIVE');
      managers.push(new AgentManager());
      expect(fs.readFileSync(system, 'utf8')).toBe('USER_SYSTEM_MUST_SURVIVE');
      expect(fs.readFileSync(append, 'utf8')).toBe('USER_APPEND_MUST_SURVIVE');
    } finally {
      await Promise.allSettled(managers.map((manager) => manager.shutdown()));
      if (originalSystem === undefined) fs.rmSync(system, { force: true });
      else fs.writeFileSync(system, originalSystem);
      if (originalAppend === undefined) fs.rmSync(append, { force: true });
      else fs.writeFileSync(append, originalAppend);
    }
  });

  test('identical task names stay parent-scoped in resident lists, disk history and controls', async () => {
    const parentA = 'scope-a-' + randomUUID();
    const parentB = 'scope-b-' + randomUUID();
    const manager = new AgentManager();
    try {
      await Promise.all([
        manager.spawnAgent(spawnParams(parentA, 'review/api', 'hold a')),
        manager.spawnAgent(spawnParams(parentB, 'review/api', 'hold b')),
      ]);
      const a = manager.getAgentInfo('review/api', parentA);
      const b = manager.getAgentInfo('review/api', parentB);
      expect(a.id).not.toBe(b.id);
      expect(a.sessionFile).not.toBe(b.sessionFile);
      expect(manager.listAgents('review', parentA)).toEqual([
        { agent_name: 'review/api', agent_status: 'running' },
      ]);
      expect(manager.listAgents(undefined, parentB)).toEqual([
        { agent_name: 'review/api', agent_status: 'running' },
      ]);
      expect(manager.listAgents(undefined, 'unrelated')).toEqual([]);
      expect(manager.listAgentInfos(undefined, parentA).map((info) => info.id)).toEqual([a.id]);
      expect(manager.listAgentInfos(undefined, parentB).map((info) => info.id)).toEqual([b.id]);
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
      expect(manager.readAgentResponse('review/api', parentA).status).toBe('interrupted');
      expect(fixture.instances[1].shutdowns).toBe(0);
    } finally {
      await manager.shutdown();
    }
  });

  test('reads are non-consuming and interruption leaves work alive in other parent sessions', async () => {
    const parent = 'read-contract-' + randomUUID();
    const other = 'read-other-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, 'one', 'first'));
      const info = manager.getAgentInfo('one', parent);
      await settled(manager, info);
      const first = manager.readAgentResponse('one', parent);
      expect(manager.readAgentResponse('one', parent)).toEqual(first);
      expect(completions).toHaveLength(1);
      await manager.spawnAgent(spawnParams(parent, 'two', 'hold active'));
      await manager.spawnAgent(spawnParams(other, 'foreign', 'hold other'));
      const running = manager.readAgentResponse('two', parent);
      expect(manager.readAgentResponse('two', parent)).toEqual(running);
      expect(manager.getAgentInfo('two', parent).status).toBe('running');
      expect(manager.getAgentInfo('foreign', other).status).toBe('running');
      await manager.interruptAgent(parent, 'two');
      expect(manager.readAgentResponse('two', parent)).toMatchObject({
        agent_name: 'two',
        status: 'interrupted',
      });
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

  test('discovers skills internally without outbound summaries while retaining literal SYSTEM/extensions and fresh context', async () => {
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
    for (const dir of [TEST_AGENT_DIR, root, path.dirname(cwd), cwd].flatMap((dir) => [
      dir,
      path.join(dir, '.pi'),
    ])) {
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
      '---\nname: unselected\ndescription: AUTO_CORE_SKILL_DESCRIPTION\n---\nAutomatically discovered skill body.',
    );
    const skill = path.join(root, 'explicit-skill', 'SKILL.md');
    put(
      skill,
      '---\nname: parent-only-skill\ndescription: FORBIDDEN_PARENT_SKILL\n---\nParent-only skill body.',
    );
    const template = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents', 'resource-policy.md');
    put(template, '---\nname: resource-policy\n---\nEXPLICIT_TEMPLATE_BODY');
    const parentSession = codingAgent.SessionManager.create(cwd, root);
    parentSession.appendMessage({
      role: 'user',
      content: 'FORBIDDEN_PARENT_CONVERSATION',
      timestamp: Date.now(),
    });
    const discoveredSkills: string[][] = [];
    fixture.onLoad = (pi) => {
      pi.on('before_agent_start', (event) => {
        discoveredSkills.push(
          (event.systemPromptOptions.skills ?? []).map((skill) => skill.description),
        );
      });
    };
    const manager = new AgentManager({ projectTrusted: () => true });
    try {
      await manager.spawnAgent({
        ...spawnParams(parent, 'worker', 'assigned work'),
        cwd,
        agent_type: 'resource-policy',
        parentSessionFile: parentSession.getSessionFile()!,
      });
      const info = manager.getAgentInfo('worker', parent);
      await coldDispose(manager, info);
      for (const snapshot of [info, JSON.parse(fs.readFileSync(info.infoFile, 'utf8'))]) {
        expect(Object.hasOwn(snapshot, 'skills')).toBe(false);
        expect(Object.hasOwn(snapshot, 'skillPaths')).toBe(false);
      }
      expect(info.extensionPaths).toEqual([CORE_SDK_EXTENSION]);
      expect(info.cwd).toBe(cwd);
      expect(fixture.instances).toHaveLength(1);
      const request = fixture.instances[0].requests[0];
      expect(request.text).toBe('EXPLICIT_TEMPLATE_BODY\n\nassigned work');
      const input = JSON.stringify(request.context);
      expect(input).toContain(literalTarget.replaceAll('\\', '\\\\'));
      expect(discoveredSkills[0]).toContain('AUTO_CORE_SKILL_DESCRIPTION');
      expect(input).not.toContain('AUTO_CORE_SKILL_DESCRIPTION');
      expect(input).not.toContain('FORBIDDEN_');
      expect(input).not.toContain('Automatically discovered skill body.');
      fs.writeFileSync(ownSystem, 'UPDATED_OWN_SYSTEM');
      put(
        path.join(cwd, '.pi', 'skills', 'added-on-resume', 'SKILL.md'),
        '---\nname: added-on-resume\ndescription: RESUMED_AUTO_SKILL_DESCRIPTION\n---\nNew skill body.',
      );
      await manager.sendMessage(parent, 'worker', 'continuation');
      await settled(manager, info);
      expect(JSON.stringify(fixture.instances[1].requests[0].context)).toContain(
        'UPDATED_OWN_SYSTEM',
      );
      expect(discoveredSkills[1]).toContain('RESUMED_AUTO_SKILL_DESCRIPTION');
      expect(JSON.stringify(fixture.instances[1].requests[0].context)).not.toContain(
        'RESUMED_AUTO_SKILL_DESCRIPTION',
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

  test.each(['config', 'template', 'empty template', 'omitted template'])(
    'loads +codemode with %s extensions and on resume',
    async (source) => {
      const parent = 'codemode-' + source + '-' + randomUUID();
      const name = 'codemode-' + randomUUID();
      const template = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents', name + '.md');
      const extensions = [CORE_SDK_EXTENSION, '+codemode'];
      const fields =
        source === 'template'
          ? '\nextensions: ' + extensions.join(', ')
          : source === 'empty template'
            ? '\nextensions:'
            : '';
      if (source !== 'config')
        fs.writeFileSync(template, '---\nname: ' + name + fields + '\n---\n');
      const active: string[][] = [];
      fixture.onStart = (pi) => {
        active.push(pi.getActiveTools());
      };
      writeConfig({
        // A nonempty template replaces this list; its unused entry must never be loaded.
        extensions:
          source === 'template' ? [path.join(TEST_AGENT_DIR, 'must-not-load.ts')] : extensions,
      });
      const manager = new AgentManager();
      try {
        await manager.spawnAgent({
          ...spawnParams(parent, 'worker', 'inspect codemode'),
          ...(source !== 'config' ? { agent_type: name } : {}),
        });
        const info = manager.getAgentInfo('worker', parent);
        await coldDispose(manager, info);
        expect(info.extensions).toEqual(extensions);
        expect(info.extensionPaths).toEqual([CORE_SDK_EXTENSION, 'builtin:codemode']);
        expect(info.tools).toBeUndefined();
        expect(active[0]).toContain('codemode');
        writeConfig({ extensions: [path.join(TEST_AGENT_DIR, 'missing-on-resume.ts')] });
        await manager.sendMessage(parent, 'worker', 'continue with codemode');
        await settled(manager, info);
        expect(active).toHaveLength(2);
        expect(active[1]).toContain('codemode');
      } finally {
        await manager.shutdown();
        fs.rmSync(template, { force: true });
      }
    },
  );

  test('omits the tool snapshot even without configured extensions', async () => {
    writeConfig({ extensions: [] });
    const parent = 'no-extension-tools-' + randomUUID();
    const manager = new AgentManager();
    try {
      // Without the provider fixture, model validation stops startup after saving the snapshot.
      await expect(
        manager.spawnAgent(spawnParams(parent, 'worker', 'must not run')),
      ).rejects.toThrow('test/fake');
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      expect(info.extensions).toBeUndefined();
      expect(info.extensionPaths).toBeUndefined();
      expect(info.tools).toBeUndefined();
      expect(Object.hasOwn(JSON.parse(fs.readFileSync(info.infoFile, 'utf8')), 'tools')).toBe(
        false,
      );
      expect(fixture.instances).toHaveLength(0);
    } finally {
      await manager.shutdown();
    }
  });

  test.each([undefined, '', 'read'])(
    'retains the saved tool-selection three-state contract across cold resume (%s)',
    async (tools) => {
      const parent = 'tools-contract-' + randomUUID();
      const name = 'tool-contract-' + randomUUID();
      const template = path.join(TEST_AGENT_DIR, 'pi-subagents', 'agents', name + '.md');
      fs.writeFileSync(
        template,
        '---\nname: ' + name + (tools === undefined ? '' : '\ntools: ' + tools) + '\n---\n',
      );
      const active: string[][] = [];
      fixture.onStart = (pi) => {
        active.push(pi.getActiveTools());
      };
      const manager = new AgentManager();
      try {
        await manager.spawnAgent({
          ...spawnParams(parent, 'worker', 'inspect tools'),
          agent_type: name,
        });
        const info = manager.getAgentInfo('worker', parent);
        await coldDispose(manager, info);
        const names = fixture.instances[0].requests[0].context.messages
          .flatMap((message: any) => message.toolsAdded ?? [])
          .map((tool: any) => tool.name);
        if (tools === 'read') expect(names).toEqual(['read']);
        else if (tools === '') expect(names).toEqual(['fixture_hold']);
        else expect(names).toEqual(expect.arrayContaining(['read', 'bash', 'fixture_hold']));
        expect(info.tools).toBe(tools);
        const saved = fs.readFileSync(info.infoFile, 'utf8');
        expect(readInfoFile(info.infoFile)?.tools).toBe(tools);
        expect(fs.readFileSync(info.infoFile, 'utf8')).toBe(saved); // Reading is not a migration.
        expect(fixture.instances[0].shutdowns).toBe(1);
        fs.writeFileSync(
          template,
          '---\nname: ' + name + '\ntools: ' + (tools === 'read' ? '' : 'read') + '\n---\n',
        );
        await manager.sendMessage(parent, 'worker', 'continue with saved tools');
        await settled(manager, info);
        expect(fixture.instances).toHaveLength(2);
        expect(active).toHaveLength(2);
        expect(active[1]).toEqual(active[0]);
        expect(manager.getAgentInfo('worker', parent).tools).toBe(tools);
        const continued = JSON.parse(fs.readFileSync(info.infoFile, 'utf8'));
        expect(continued.tools).toBe(tools);
        expect(continued).not.toHaveProperty('canonicalName');

        expect(continued).toMatchObject({
          id: info.id,
          taskName: 'worker',
          sessionFile: info.sessionFile,
          infoFile: info.infoFile,
          logFile: info.logFile,
        });
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
      await settled(manager, info);
      expect(manager.getAgentInfo('worker', parent).contextUsage).toEqual({
        tokens: 50000,
        contextWindow: 500000,
        percent: 10,
      });
      await manager.sendMessage(parent, 'worker', 'second');
      await settled(manager, info);
      const final = manager.getAgentInfo('worker', parent);
      expect(final.contextUsage).toEqual({ tokens: 60000, contextWindow: 500000, percent: 12 });
      expect(
        sessionMessages(final)
          .filter((entry) => entry.role === 'assistant')
          .reduce((sum, entry) => sum + entry.usage.totalTokens, 0),
      ).toBe(110000);
      expect(formatContextUsage(readInfoFile(final.infoFile)?.contextUsage)).toBe('12%/500k');
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([0]);
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
        settled(manager, manager.getAgentInfo('large', parent)),
        settled(manager, manager.getAgentInfo('small', parent)),
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
    const gate = Promise.withResolvers<void>();
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await coldDispose(manager, info);
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
      await settled(manager, info);
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
    const gate = Promise.withResolvers<void>();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'sampling-error-' + randomUUID();
    const completions: any[] = [];
    const errors: Error[] = [];
    const manager = new AgentManager({
      onError: (error) => errors.push(error),
      onCompletion: (event) => completions.push(event),
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
      await coldDispose(manager, info);
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
        onCompletion: (event) => completions.push(event),
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
        await settled(manager, original);
        const before = manager.getAgentInfo('worker', parent);
        const count = completions.length;
        const requestCount = fixture.instances[0].requests.length;
        prompt = spyOn(codingAgent.AgentSession.prototype, 'prompt').mockRejectedValueOnce(
          new Error('unaccepted prompt fixture rejection'),
        );
        await expect(manager.sendMessage(parent, 'worker', 'not accepted')).rejects.toThrow(
          'unaccepted prompt fixture rejection',
        );
        await settled(manager, before);
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
        expect(fixture.instances).toHaveLength(1);
        expect(fixture.instances[0].requests).toHaveLength(requestCount);
        expect(fixture.instances[0].shutdowns).toBe(1);
      } finally {
        prompt?.mockRestore();
        await manager.shutdown();
      }
    },
  );

  test('a delayed unaccepted rejection cannot restore a completed snapshot over explicit interrupt', async () => {
    const gate = Promise.withResolvers<void>();
    const parent = 'reject-after-interrupt-' + randomUUID();
    const manager = new AgentManager();
    let prompt: ReturnType<typeof spyOn> | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
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
      await waitUntil(() => Boolean(manager['live'].get(info.id)?.run?.promptFinished));
      const interruption = manager.interruptAgent(parent, 'worker');
      await waitUntil(() => manager.getAgentInfo('worker', parent).status === 'interrupted');
      gate.resolve();
      await interruption;
      expect(await pending).toBeInstanceOf(Error);
      await settled(manager, info);
      expect(manager.readAgentResponse('worker', parent)).toMatchObject({ status: 'interrupted' });
      expect(manager.getAgentInfo('worker', parent).finalResponse).toBeUndefined();
    } finally {
      gate.resolve();
      await pending;
      prompt?.mockRestore();
      await manager.shutdown();
    }
  });

  test('a rejection after acceptance fails this run rather than restoring the previous answer', async () => {
    const gate = Promise.withResolvers<void>();
    const parent = 'accepted-rejection-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onCompletion: (event) => completions.push(event) });
    let prompt: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
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
      await settled(manager, info);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        status: 'failed',
        messageCount: 2,
        error: 'accepted run fixture failure',
      });
      expect(manager.getAgentInfo('worker', parent).finalResponse).toBeUndefined();
      expect(completions).toHaveLength(2);
      expect(fixture.instances[0].shutdowns).toBe(1);
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
      await settled(manager, info);
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
      await settled(manager, info);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        status: 'failed',
        error: 'Agent ended with aborted.',
      });
      expect(manager.getAgentInfo('worker', parent).finalResponse).toBeUndefined();
      expect(fixture.instances).toHaveLength(1);
      expect(fixture.instances[0].requests).toHaveLength(1);
    } finally {
      prompt?.mockRestore();
      await manager.shutdown();
    }
  });

  test('agent_settled inside the synchronous handled window still records settled.aborted', async () => {
    const parent = 'sync-settled-window-' + randomUUID();
    const manager = new AgentManager();
    let prompt: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await settled(manager, info);
      prompt = spyOn(codingAgent.AgentSession.prototype, 'prompt').mockImplementationOnce(
        async (_text, options) => {
          options?.preflightResult?.('handled');
          // Settled fires before promptChildSession returns and before the submitted
          // prompt promise can be tracked: the synchronous submission window.
          manager['handleSessionEvent'](manager['live'].get(info.id)!, {
            type: 'agent_settled',
            aborted: true,
          } as any);
        },
      );
      await manager.sendMessage(parent, 'worker', 'handled sync settled');
      await settled(manager, info);
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        status: 'failed',
        error: 'Agent ended with aborted.',
      });
      expect(manager.getAgentInfo('worker', parent).finalResponse).toBeUndefined();
    } finally {
      prompt?.mockRestore();
      await manager.shutdown();
    }
  });

  test('nested native tool activity is retained by the manager but filtered only from observer state', async () => {
    const gate = Promise.withResolvers<void>();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'nested-native-' + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onCompletion: (event) => completions.push(event) });
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
      await settled(manager, info);
      expect(completions).toEqual([
        expect.objectContaining({ status: 'completed', finalResponse: 'response:hold nested' }),
      ]);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe(
        'response:hold nested',
      );
    } finally {
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('an uncooperative manager shutdown is bounded, refuses new work, and finishes late cleanup', async () => {
    const gate = Promise.withResolvers<void>();
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
      await settled(manager, info);
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
  test('a failed final save still publishes terminal status and result despite stale disk state', async () => {
    const gate = Promise.withResolvers<void>();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = 'failed-final-save-' + randomUUID();
    const errors: Error[] = [];
    const activity: Array<{ active: boolean; status?: string }> = [];
    const notifications: any[] = [];
    const manager = new AgentManager({
      onError: (error) => errors.push(error),
      onActivityChange: (event) => activity.push(event),
      onCompletion: (event) => notifications.push(event),
    });
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
      gate.resolve();
      await settled(manager, info);
      expect(activity.at(-1)).toMatchObject({ active: false, status: 'completed' });
      expect(notifications).toEqual([
        expect.objectContaining({ status: 'completed', finalResponse: 'response:hold final save' }),
      ]);
      expect(
        errors.some((error) => error.message.includes('final status fixture save failure')),
      ).toBe(true);
      expect(manager.getAgentInfo('worker', parent).status).toBe('running');
      expect(manager['live'].size).toBe(0);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      expect(manager.readAgentResponse('worker', parent)).toMatchObject({ status: 'running' });
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally {
      save?.mockRestore();
      gate.resolve();
      await manager.shutdown();
    }
  });

  test('unaccepted cold resume rejection restores the previous final result without renotifying', async () => {
    const gate = Promise.withResolvers<void>();
    const parent = 'resume-rollback-' + randomUUID();
    const notifications: any[] = [];
    const manager = new AgentManager({
      onCompletion: (event) => notifications.push(event),
    });
    let resuming: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      await coldDispose(manager, info);
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
      gate.resolve();
      const error = (await resuming) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/API key|authentication/i);
      await settled(manager, info);
      expect(manager.readAgentResponse('worker', parent)).toMatchObject({
        agent_name: 'worker',
        status: 'completed',
        finalResponse: 'response:first',
      });
      expect(manager.getAgentInfo('worker', parent)).toMatchObject({
        status: 'completed',
        messageCount: 1,
        finalResponse: 'response:first',
      });
      expect(notifications).toHaveLength(1);
      expect(fixture.instances[0].requests).toEqual([]);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally {
      gate.resolve();
      await resuming;
      await manager.shutdown();
    }
  });

  describe('unaccepted resume completion state', () => {
    function rejectAfterInput(
      manager: InstanceType<typeof AgentManager>,
      info: AgentInfo,
      gate: PromiseWithResolvers<void>,
    ) {
      const entered = Promise.withResolvers<void>();
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

    test('commits rollback before an activity callback reads the previous result', async () => {
      const gate = Promise.withResolvers<void>();
      const parent = 'rollback-activity-read-' + randomUUID();
      const notifications: any[] = [];
      let observeRollback = false;
      let callbackResponse: AgentResponseEntry | undefined;
      const manager = new AgentManager({
        onCompletion: (event) => notifications.push(event),
        onActivityChange(event) {
          if (!observeRollback || event.parentSessionId !== parent || event.active) return;
          callbackResponse = manager.readAgentResponse('worker', parent);
        },
      });
      let resuming: Promise<unknown> | undefined;
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
        const info = manager.getAgentInfo('worker', parent);
        await coldDispose(manager, info);
        const original = manager.readAgentResponse('worker', parent);
        const rejected = rejectAfterInput(manager, info, gate);
        resuming = rejected.resuming;
        await rejected.entered;
        observeRollback = true;
        gate.resolve();
        expect(await resuming).toBeInstanceOf(Error);
        await settled(manager, info);
        expect(callbackResponse).toEqual(original);
        expect(callbackResponse).toMatchObject({
          status: 'completed',
          finalResponse: 'response:first',
        });
        expect(notifications).toHaveLength(1);
        expect(rejected.state.instances[0].requests).toEqual([]);
      } finally {
        observeRollback = false;
        gate.resolve();
        await resuming;
        await manager.shutdown();
      }
    });

    test('a rejected resume retains the old result and a subsequent accepted turn publishes a fresh completion', async () => {
      const gate = Promise.withResolvers<void>();
      const parent = 'subsequent-turn-rollback-' + randomUUID();
      const notifications: any[] = [];
      const manager = new AgentManager({
        onCompletion: (event) => notifications.push(event),
      });
      let resuming: Promise<unknown> | undefined;
      try {
        await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
        const info = manager.getAgentInfo('worker', parent);
        await coldDispose(manager, info);
        const original = manager.readAgentResponse('worker', parent);
        expect(manager.readAgentResponse('worker', parent)).toEqual(original);
        const rejected = rejectAfterInput(manager, info, gate);
        resuming = rejected.resuming;
        await rejected.entered;
        gate.resolve();
        expect(await resuming).toBeInstanceOf(Error);
        await settled(manager, info);
        expect(rejected.state.instances[0].requests).toEqual([]);
        expect(notifications).toHaveLength(1);
        expect(manager.readAgentResponse('worker', parent).finalResponse).toBe('response:first');

        fixture = configureCoreFixture();
        await manager.sendMessage(parent, 'worker', 'second');
        await settled(manager, info);
        expect(notifications).toHaveLength(2);
        expect(notifications[1]).toMatchObject({
          status: 'completed',
          finalResponse: 'response:second',
        });
        expect(manager.readAgentResponse('worker', parent)).toMatchObject({
          status: 'completed',
          finalResponse: 'response:second',
        });
      } finally {
        gate.resolve();
        await resuming;
        await manager.shutdown();
      }
    });
  });

  test.each(['before', 'after'])(
    'a compaction-only busy session cannot report steer acceptance (%s await)',
    async (phase) => {
      const gate = Promise.withResolvers<void>();
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
          await waitUntil(() => manager['live'].get(info.id)!.run!.pendingSteers.size === 1);
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
      onCompletion: (event) => notifications.push(event),
    });
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'hold original'));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo('worker', parent);
      const session = manager['live'].get(info.id)!.session!;
      // Native abort determines terminal status in this case.
      await session.abort();
      await settled(manager, info);
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
      expect(fixture.instances[0].shutdowns).toBe(0);
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
    const failStartup = Promise.withResolvers<void>();
    const shutdownGate = Promise.withResolvers<void>();
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
      await settled(manager, info);
      expect(firstFixture.instances[0].shutdowns).toBe(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect([activeResources, freedResources]).toEqual([0, 1]);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);

      fixture = configureCoreFixture();
      await manager.sendMessage(parent, 'worker', 'reopen only after actual cleanup');
      await coldDispose(manager, info);
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
    const responseGate = Promise.withResolvers<void>();
    const shutdownGate = Promise.withResolvers<void>();
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
      const mkdirWhileOpen = spyOn(fs, 'mkdirSync');
      const stderr = spyOn(console, 'error').mockImplementation(() => {});
      const previousDebug = process.env.PI_SUBAGENT_DEBUG;
      try {
        delete process.env.PI_SUBAGENT_DEBUG;
        live.logger.info('regression', 'normal write');
        expect(mkdirWhileOpen).toHaveBeenCalledTimes(1);
        expect(stderr).not.toHaveBeenCalled();
        process.env.PI_SUBAGENT_DEBUG = '1';
        live.logger.info('regression', 'same stream write');
        expect(mkdirWhileOpen).toHaveBeenCalledTimes(1);
        expect(stderr.mock.calls).toEqual([['[INFO] regression: same stream write', '']]);
      } finally {
        if (previousDebug === undefined) delete process.env.PI_SUBAGENT_DEBUG;
        else process.env.PI_SUBAGENT_DEBUG = previousDebug;
        stderr.mockRestore();
        mkdirWhileOpen.mockRestore();
      }
      expect(tracked.streams).toHaveLength(1);
      const original = tracked.streams[0];

      responseGate.resolve();
      await settled(manager, info);
      void manager['terminateSession'](live);
      await waitUntil(() => fixture.instances[0].shutdowns === 1);
      expect(live.closing).toBe(true);
      expect(original.writableEnded).toBe(false);
      live.logger.info('regression', 'closing write');
      expect(tracked.streams).toHaveLength(1);
      shutdownGate.resolve();
      await settled(manager, info);
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
      await coldDispose(manager, info);
      await waitUntil(() => restoredStream.closed);
      expect(mkdirCalls).toBe(0);
      expect(tracked.streams).toHaveLength(2);
      expect(tracked.streams.every((stream) => stream.closed)).toBe(true);
      const entries = fs
        .readFileSync(info.logFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.category === 'regression');
      for (const entry of entries) {
        expect(entry.level).toBe('INFO');
        expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
        expect(Object.keys(entry).sort()).toEqual(['category', 'level', 'message', 'ts']);
      }
      expect(entries.map((entry) => entry.message)).toEqual([
        'normal write',
        'same stream write',
        'closing write',
        'restored append',
      ]);
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
    const gate = Promise.withResolvers<void>();
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
      const gate = Promise.withResolvers<void>();
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
        await settled(manager, info);
        void manager['terminateSession'](live);
        await waitUntil(() => dispose!.mock.calls.length === 1);
        // Disposal is bounded, but the blocked hook must retain exclusive JSONL ownership.
        expect(manager['live'].get(info.id)).toBe(live);
        expect(fs.existsSync(activeMarker(info.id))).toBe(true);
        expect(original.writableEnded).toBe(false);
        await expect(manager.sendMessage(parent, 'worker', 'must not reopen')).rejects.toThrow(
          /closing/,
        );
        expect(fixture.instances).toHaveLength(1);
        gate.resolve();
        await released(manager, info);
        await waitUntil(() =>
          hostErrors.some((message) => message.includes('session_shutdown timed out')),
        );
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

  test('R4: a throwing native resource cleanup cannot release ownership before the hook exits', async () => {
    const { registerSessionResourceCleanup } = await import(
      new URL('session-resources.js', import.meta.resolve('@earendil-works/pi-ai')).href
    );
    const gate = Promise.withResolvers<void>();
    let hookExited = false;
    fixture = configureCoreFixture({
      shutdownGate: gate.promise,
      onShutdown: () => {
        hookExited = true;
      },
    });
    const hostErrors: string[] = [];
    const originalTimeout = globalThis.setTimeout;
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: any,
      ms: number,
      ...args: any[]
    ) => originalTimeout(callback, ms === 5000 ? 100 : ms, ...args)) as typeof setTimeout);
    const manager = new AgentManager({ onError: (error) => hostErrors.push(error.message) });
    const parent = 'throwing-cleanup-owner-' + randomUUID();
    let unregister = () => {};
    try {
      await manager.spawnAgent(spawnParams(parent, 'worker', 'first'));
      const info = manager.getAgentInfo('worker', parent);
      const live = manager['live'].get(info.id)!;
      const sessionId = live.session!.sessionId;
      let cleanups = 0;
      unregister = registerSessionResourceCleanup((id: string) => {
        if (id === sessionId && cleanups++ === 0)
          throw new Error('independent resource cleanup failure');
      });
      await settled(manager, info);
      void manager['terminateSession'](live);
      // The real native dispose runs at the timeout point and throws the registered failure.
      await waitUntil(() => cleanups === 1, 9000);
      let terminationSettled = false;
      // Track both outcomes; a bare .finally() would re-reject unhandled.
      void (live.termination ?? Promise.resolve()).then(
        () => {
          terminationSettled = true;
        },
        () => {
          terminationSettled = true;
        },
      );
      expect(hookExited).toBe(false);
      expect(manager['live'].get(info.id)).toBe(live);
      expect(fs.existsSync(activeMarker(info.id))).toBe(true);
      expect(terminationSettled).toBe(false);
      await expect(manager.sendMessage(parent, 'worker', 'must not reopen yet')).rejects.toThrow(
        /closing/,
      );
      expect(fixture.instances).toHaveLength(1);
      expect(hookExited).toBe(false);
      gate.resolve();
      await released(manager, info);
      expect(hookExited).toBe(true);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      expect(cleanups).toBe(1);
      await waitUntil(() =>
        hostErrors.some((message) => message.includes('Failed to cleanup session resources')),
      );
      expect(manager.readAgentResponse('worker', parent).status).toBe('completed');
      fixture = configureCoreFixture();
      await manager.sendMessage(parent, 'worker', 'after recovery');
      await coldDispose(manager, info);
      expect(manager.readAgentResponse('worker', parent).finalResponse).toBe(
        'response:after recovery',
      );
      // The reopened session derives the same sessionId from its JSONL and is disposed
      // exactly once on its own close; the throwing callback fires only for the first call.
      expect(cleanups).toBe(2);
    } finally {
      gate.resolve();
      unregister();
      try {
        await manager.shutdown();
      } finally {
        timers.mockRestore();
      }
    }
  });
});
