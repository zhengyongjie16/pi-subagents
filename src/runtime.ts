import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionServices,
  type PromptOptions,
} from '@earendil-works/pi-coding-agent';

export interface ChildSessionOptions {
  info: {
    cwd: string;
    sessionFile: string;
    provider: string;
    modelId: string;
    thinking?: AgentSession['thinkingLevel'];
    tools?: string;
    extensionPaths?: string[];
  };
  systemPromptPath: string;
  /** Parent's effective trust decision for a matching working directory. */
  projectTrusted?: boolean;
  /** Transfers cleanup ownership, including when binding subsequently fails. */
  onCreated: (session: AgentSession) => void;
  checkCanceled: () => void;
  onError: (error: unknown) => void;
  /** Synchronously registers the parent's cancellation/closing request. */
  onShutdown: () => void;
  log: (text: string) => void;
}

function checkDiagnostics(
  services: AgentSessionServices,
  log: ChildSessionOptions['log'],
  logged: Set<string>,
): void {
  const loader = services.resourceLoader;
  const extensions = loader.getExtensions();
  const diagnostics = [
    ...services.diagnostics,
    ...extensions.errors.map(({ path, error }) => ({
      type: 'error',
      message: `${path}: ${error}`,
    })),
    ...(extensions.warnings ?? []).map(({ path, warning }) => ({
      type: 'warning',
      message: `${path}: ${warning}`,
    })),
    ...[loader.getSkills(), loader.getPrompts(), loader.getThemes()].flatMap(({ diagnostics }) =>
      diagnostics.map(({ type, path, message }) => ({
        type,
        message: path ? `${path}: ${message}` : message,
      })),
    ),
  ];
  const errors: string[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.type === 'error') errors.push(diagnostic.message);
    else {
      const message = `${diagnostic.type}: ${diagnostic.message}`;
      if (!logged.has(message)) {
        logged.add(message);
        log(message);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

/** Assemble one independent SDK session. The caller owns all lifecycle tracking and cleanup. */
export async function createChildSession(options: ChildSessionOptions): Promise<AgentSession> {
  const { info, checkCanceled } = options;
  checkCanceled();
  const cwd = resolve(info.cwd);
  const systemPromptPath = resolve(options.systemPromptPath);
  // Pass the validated file path to preserve the loader's file semantics.
  const systemPrompt = await readFile(systemPromptPath, 'utf8');
  checkCanceled();
  if (!systemPrompt.replace(/^\uFEFF/, '').trim())
    throw new Error(`System prompt is empty: ${systemPromptPath}`);

  const agentDir = getAgentDir();
  // Gate project settings until the effective trust decision is resolved.
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  // Resolve headless trust from the parent's decision, native store, and default policy.
  const projectTrusted =
    options.projectTrusted ??
    new ProjectTrustStore(agentDir).get(cwd) ??
    (!hasTrustRequiringProjectResources(cwd) ||
      settingsManager.getDefaultProjectTrust() === 'always');
  settingsManager.setProjectTrusted(projectTrusted);

  const codemode = info.extensionPaths?.includes('builtin:codemode');
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: {
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: systemPromptPath,
      appendSystemPrompt: [],
      additionalExtensionPaths: info.extensionPaths,
      extensionFactories: codemode
        ? [{ name: 'codemode', builtin: true, replaceable: true, factory: createCodemodeExtension() }]
        : [],
    },
  });
  checkCanceled();
  const loggedDiagnostics = new Set<string>();
  checkDiagnostics(services, options.log, loggedDiagnostics);
  if (!services.resourceLoader.getSystemPrompt()?.trim())
    throw new Error(`System prompt is empty: ${systemPromptPath}`);
  // Resource loading reloads settings; extend the resolved selection afterwards.
  if (codemode) {
    const defaults = settingsManager.getDefaultTools();
    settingsManager.applyOverrides({ defaultTools: defaults ? [...defaults, 'codemode'] : ['+codemode'] });
  }

  const available = await services.modelRuntime.getAvailable(info.provider);
  checkCanceled();
  const model = available.find(
    (model) => model.provider === info.provider && model.id === info.modelId,
  );
  if (!model) throw new Error(`Model is not available: ${info.provider}/${info.modelId}`);

  const tools = info.tools
    ?.split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.open(info.sessionFile, dirname(info.sessionFile), cwd),
    model,
    thinkingLevel: info.thinking,
    ...(tools === undefined ? {} : tools.length ? { tools } : { noTools: 'builtin' as const }),
  });
  // Transfer cleanup ownership before cancellation checks and extension binding.
  options.onCreated(session);
  checkCanceled();
  // Binding forwards hook/provider failures through onError; collect them for startup validation.
  const bindingErrors: string[] = [];
  let binding = true;
  try {
    await session.bindExtensions({
      mode: 'print',
      onError(error) {
        if (binding)
          bindingErrors.push(
            `Extension "${error.extensionPath}" error: ${error.event}: ${error.error}`,
          );
        options.onError(error);
      },
      shutdownHandler: options.onShutdown,
    });
  } finally {
    binding = false;
  }
  checkCanceled();
  if (bindingErrors.length) throw new Error(bindingErrors.join('\n'));
  // resources_discover runs during binding and can add diagnostics after services creation.
  checkDiagnostics(services, options.log, loggedDiagnostics);

  const stillAvailable = await session.modelRuntime.getAvailable(info.provider);
  checkCanceled();
  if (
    !stillAvailable.some((model) => model.provider === info.provider && model.id === info.modelId)
  ) {
    throw new Error(
      `Model is not available after extension binding: ${info.provider}/${info.modelId}`,
    );
  }
  if (session.model?.provider !== info.provider || session.model.id !== info.modelId) {
    throw new Error(
      `Extensions changed the selected model: expected ${info.provider}/${info.modelId}, got ${session.model?.provider}/${session.model?.id}`,
    );
  }
  return session;
}

/** Return the submitted prompt promise; the caller also waits for native idle to track completion. */
export function promptChildSession(
  session: AgentSession,
  message: string,
  preflightResult: NonNullable<PromptOptions['preflightResult']>,
): Promise<void> {
  return session.prompt(message, { source: 'rpc', preflightResult });
}

/**
 * Call once after initialization, submitted input, and native work have exited.
 * The timeout bounds extension shutdown.
 */
export async function shutdownChildSession(
  session: AgentSession,
  timeoutMs = 5_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Child session_shutdown timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    session.dispose();
  }
}
