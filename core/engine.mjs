// GemInWeb core engine: RPC envelope handling shared by the native host and HTTP server.
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConfigStore, ensureDataDir, resolveDataDir } from './config.mjs';
import { normalizeInputPath, PathPolicy } from './paths.mjs';
import { buildPrimer } from './primer.mjs';
import { resolveShell } from './shell.mjs';
import { normalizeArgs, resolveToolName, TOOL_IMPLS, toolList } from './tools.mjs';
import { ToolError, VERSION, truncateHead } from './util.mjs';

export { VERSION };

/**
 * Create an engine.
 * options.home      data dir (default: DEVSPACE_GEM_HOME or ~/.devspace-gem)
 * options.config    object merged over config.json (handy for tests / embedding)
 * options.env       environment used to resolve the data dir (default process.env)
 */
export function createEngine(options = {}) {
  const home = resolve(options.home ?? resolveDataDir(options.env ?? process.env));
  ensureDataDir(home);
  const store = createConfigStore(home, options.config);
  store.get(); // creates config.json when missing
  const inflight = new Map(); // id -> AbortController

  function current() {
    const { config, error } = store.get();
    return { config, configError: error, policy: makePolicy(config) };
  }

  function makePolicy(config) {
    return new PathPolicy(config.allowedRoots, {
      protectedPaths: config.protectedPaths,
      writeProtectedPaths: config.writeProtectedPaths,
      dataDir: home,
    });
  }

  /** Resolve the request workspace (or config default). Returns { workspace, error }. */
  async function resolveWorkspace(requested, config, policy) {
    const raw = typeof requested === 'string' && requested.trim() ? requested : config.defaultWorkspace;
    try {
      const abs = resolve(normalizeInputPath(raw));
      await policy.check(abs, raw);
      const st = await stat(abs).catch(() => null);
      if (!st?.isDirectory()) return { workspace: null, error: `workspace is not an existing directory: ${raw}` };
      return { workspace: abs, error: null };
    } catch (err) {
      return { workspace: null, error: err.message };
    }
  }

  function shellInfo(config) {
    try {
      return resolveShell(config);
    } catch {
      return null;
    }
  }

  async function status() {
    const { config, configError } = current();
    const policy = makePolicy(config);
    const allowedRoots = policy.roots;
    const shell = shellInfo(config);
    return {
      version: VERSION,
      platform: process.platform,
      homeDir: homedir(),
      configPath: join(home, 'config.json'),
      dataDir: home,
      allowedRoots,
      protectedPaths: policy.protectedPaths,
      writeProtectedPaths: policy.writeProtectedPaths,
      defaultWorkspace: resolve(normalizeInputPath(config.defaultWorkspace)),
      shell: shell ?? { kind: process.platform === 'win32' ? 'powershell' : 'bash', path: null },
      commandTimeoutSec: config.commandTimeoutSec,
      maxCommandTimeoutSec: config.maxCommandTimeoutSec,
      ...(configError ? { configError } : {}),
    };
  }

  /** Run one tool. Never throws; returns the `call` result object. */
  async function callTool(toolName, args, { workspace, signal } = {}) {
    const started = Date.now();
    const def = resolveToolName(toolName);
    const done = (r) => ({ ...r, durationMs: Date.now() - started });
    if (!def) {
      return done({ ok: false, output: `Unknown tool "${toolName}". Available tools: ${toolList().map((t) => t.name).join(', ')}` });
    }
    const { config, policy } = current();
    const ws = await resolveWorkspace(workspace, config, policy);
    const ctx = {
      config,
      policy,
      workspace: ws.workspace,
      signal,
      home,
      logsDir: join(home, 'logs'),
      resolve: (p, opts) => {
        if (!ws.workspace && ws.error && !isAbsoluteLike(p)) {
          throw new ToolError(`The workspace is not usable (${ws.error}). Call open_workspace with an absolute path first.`);
        }
        return policy.resolve(p, ws.workspace, opts);
      },
    };
    let result;
    try {
      const out = await TOOL_IMPLS[def.name](normalizeArgs(def, args, toolName), ctx);
      result = typeof out === 'string' ? { ok: true, output: out } : { ok: out.ok ?? true, ...out };
    } catch (err) {
      if (err instanceof ToolError) result = { ok: false, output: err.message, ...(err.cancelled ? { cancelled: true } : {}) };
      else result = { ok: false, output: `${def.name} failed: ${err?.message ?? String(err)}` };
    }
    if (signal?.aborted && !result.cancelled) {
      result = { ...result, ok: false, cancelled: true, output: result.output ? `${result.output}\n[cancelled]` : 'Cancelled' };
    }
    const capped = result.capped;
    delete result.capped;
    if (typeof result.output !== 'string') result.output = String(result.output ?? '');
    const max = config.maxOutputChars;
    if (result.output.length > max) {
      const t = truncateHead(result.output, max);
      result.output = t.text;
      result.truncated = true;
    } else if (!capped && !result.truncated) {
      delete result.truncated;
    }
    if (!result.truncated) delete result.truncated;
    if (!result.cancelled) delete result.cancelled;
    if (!result.workspace) delete result.workspace;
    return done({ tool: def.name, ...result });
  }

  async function handle(request) {
    const id = request && typeof request === 'object' && request.id !== undefined && request.id !== null ? String(request.id) : null;
    const fail = (error) => ({ id, ok: false, error });
    const okr = (result) => ({ id, ok: true, result });
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) return fail('Bad request: expected a JSON object');
      if (id === null) return fail('Bad request: missing id');
      switch (request.type) {
        case 'ping':
          return okr({ pong: true, version: VERSION });
        case 'status':
          return okr(await status());
        case 'tools':
          return okr({ tools: toolList() });
        case 'primer': {
          const mode = request.mode === 'context' ? 'context' : 'full';
          const site = ['aistudio', 'gemini', 'generic'].includes(request.site) ? request.site : 'generic';
          const { config, policy } = current();
          const ws = await resolveWorkspace(request.workspace, config, policy);
          const info = {
            workspace: ws.workspace,
            workspaceError: ws.error,
            allowedRoots: policy.roots,
            shell: shellInfo(config),
            policy,
          };
          return okr(await buildPrimer({ mode, site, info }));
        }
        case 'call': {
          const tool = request.tool;
          if (typeof tool !== 'string' || !tool.trim()) return fail('Bad request: call needs a "tool" string');
          let args = request.args ?? {};
          if (typeof args === 'string') {
            try {
              args = args.trim() ? JSON.parse(args) : {};
            } catch {
              return fail('Bad request: args is not valid JSON');
            }
          }
          if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('Bad request: args must be an object');
          if (inflight.has(id)) return fail(`Bad request: a call with id ${id} is already running`);
          const controller = new AbortController();
          inflight.set(id, controller);
          try {
            const result = await callTool(tool, args, { workspace: request.workspace, signal: controller.signal });
            return okr(result);
          } finally {
            inflight.delete(id);
          }
        }
        case 'cancel': {
          const target = request.target === undefined || request.target === null ? null : String(request.target);
          if (!target) return fail('Bad request: cancel needs a "target" id');
          const controller = inflight.get(target);
          if (!controller || controller.signal.aborted) return okr({ cancelled: false });
          controller.abort();
          return okr({ cancelled: true });
        }
        default:
          return fail(`Unknown request type: ${request.type}`);
      }
    } catch (err) {
      return fail(`Internal error: ${err?.message ?? String(err)}`);
    }
  }

  function close() {
    for (const c of inflight.values()) c.abort();
    inflight.clear();
  }

  return {
    version: VERSION,
    home,
    configPath: join(home, 'config.json'),
    get config() {
      return store.get().config;
    },
    handle,
    callTool,
    status,
    inflightCount: () => inflight.size,
    close,
  };
}

function isAbsoluteLike(p) {
  if (typeof p !== 'string') return false;
  const s = normalizeInputPath(p);
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || (process.platform !== 'win32' && s.startsWith('/'));
}
