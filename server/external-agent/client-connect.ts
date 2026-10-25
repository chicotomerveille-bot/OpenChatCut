// One-click external client connection: writes the OpenChatCut MCP endpoint
// and token into well-known local client config files. Only the `openchatcut`
// entry is touched; every other server in each file is preserved. JSON files
// are merged atomically (write-to-temp + rename) and never clobbered when the
// existing content fails to parse.
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { codexCommand } from '../codex/command.ts';
import { resolveCodexCli } from '../codex/installation.ts';

export const CONNECT_CLIENTS = [
  'claude',
  'codex',
  'cursor',
  'antigravity',
  'qoder',
  'gemini',
  'vscode',
  'cline',
  'openclaw',
] as const;
export type ConnectClient = (typeof CONNECT_CLIENTS)[number];
/** Clients whose MCP servers live in a mergeable JSON config file. Codex is
 *  driven through its own CLI and keeps a TOML config we do not parse. */
export type JsonClient = Exclude<ConnectClient, 'codex'>;

/** `notice: 'restart-codex'` means the token went where only processes started
 *  afterwards look (the Windows user environment), so Codex must be relaunched. */
export type ClientConnectResult =
  | { ok: true; paths: string[]; notice?: 'restart-codex' }
  | { ok: false; error: 'invalid-client' | 'invalid-token' | 'config-parse-error' | 'config-write-error' | 'codex-cli-failed' | 'token-env-write-error'; detail?: string };

/** One child process: a Codex CLI call shaped by codexCommand(), or the Windows
 *  user-environment write. */
export interface ConnectCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
  readonly env: NodeJS.ProcessEnv;
}

export type ConnectCommandRunner = (command: ConnectCommand) => Promise<{ code: number | null; stderr: string }>;

export interface ClientConnectOptions {
  /** Base directory that stands in for the user home. Defaults to os.homedir(). */
  baseDir?: string;
  /** Codex CLI override (tests inject a stub here). Defaults to auto-detection. */
  codexBin?: string;
  /** Platform whose CLI lookup, token storage and app-data root apply. Defaults
   *  to process.platform. */
  platform?: NodeJS.Platform;
  /** Stands in for the platform's application-data directory (Windows
   *  %APPDATA%, macOS Library/Application Support, Linux ~/.config): VS Code and
   *  its extensions keep user scope there. Injectable so tests never read the
   *  real one. */
  appDataDir?: string;
  /** Runs every child process (tests record them instead). Defaults to spawn. */
  runCommand?: ConnectCommandRunner;
  /** Codex CLI lookup on Windows (tests stub it). Defaults to resolveCodexCli(). */
  resolveCodexBin?: () => Promise<string | null>;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOKEN_ENV_VAR = 'OPENCHATCUT_MCP_TOKEN';
const CODEX_BIN_FALLBACKS = ['.local/bin/codex', '/Applications/ChatGPT.app/Contents/Resources/codex'];
/** Reported in place of a file path when the token becomes a Windows user variable. */
const WINDOWS_USER_ENV_LOCATION = `HKCU\\Environment\\${TOKEN_ENV_VAR}`;

// Nothing on Windows reads ~/.zshrc, so there the token becomes a user
// environment variable (#161). [Environment]::SetEnvironmentVariable(..., 'User')
// is the call the reporter confirmed: it writes HKCU\Environment and broadcasts
// WM_SETTINGCHANGE, so a Codex Desktop or terminal started afterwards inherits
// the variable without signing out; `reg add` skips that broadcast. The script
// is constant and the token reaches it only through the child's environment,
// never a command line as `setx` or `reg add` would need. Reading the value
// back turns a write that did not stick into an error, not a false "connected".
const WINDOWS_SAVE_TOKEN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$token = $env:${TOKEN_ENV_VAR}`,
  'if (-not $token) { exit 2 }',
  `[Environment]::SetEnvironmentVariable('${TOKEN_ENV_VAR}', $token, 'User')`,
  `if ([Environment]::GetEnvironmentVariable('${TOKEN_ENV_VAR}', 'User') -cne $token) { exit 3 }`,
].join('; ');

/** Home-relative path for display, absolute when the file lives outside it. */
export function displayClientPath(baseDir: string, file: string): string {
  const rel = path.relative(baseDir, file);
  return rel.startsWith('..') ? file : `~/${rel.split(path.sep).join('/')}`;
}

/** One config file a client reads, plus the keys from the file root down to its
 *  server map (`['mcpServers']`, `['servers']`, `['mcp', 'servers']`). */
export interface ClientConfigTarget {
  file: string;
  serverPath: readonly [string, ...string[]];
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.occ-connect-tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

type MergeFailure = { ok: false; error: 'config-parse-error' | 'config-write-error'; detail?: string };

/** Merge the server map at `serverPath`, creating intermediate objects. Every
 *  level is validated first, so a hand-edited `"mcp": []` is refused instead of
 *  being silently replaced by an object. */
async function mergeJsonConfig(
  file: string,
  serverPath: ClientConfigTarget['serverPath'],
  build: (servers: Record<string, unknown>) => void,
): Promise<{ ok: true } | MergeFailure> {
  let root: Record<string, unknown> = {};
  try {
    const text = await readFile(file, 'utf8');
    if (text.trim()) {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'config-parse-error', detail: file };
      }
      root = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, error: 'config-parse-error', detail: file };
    }
  }
  let parent: Record<string, unknown> = root;
  for (const key of serverPath.slice(0, -1)) {
    const current = parent[key];
    if (current === undefined) {
      const created: Record<string, unknown> = {};
      parent[key] = created;
      parent = created;
      continue;
    }
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return { ok: false, error: 'config-parse-error', detail: key };
    }
    parent = current as Record<string, unknown>;
  }
  const leaf = serverPath[serverPath.length - 1] ?? '';
  if (!leaf) return { ok: false, error: 'config-parse-error', detail: 'serverPath' };
  const servers = parent[leaf];
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
    return { ok: false, error: 'config-parse-error', detail: leaf };
  }
  const map = (servers as Record<string, unknown> | undefined) ?? {};
  parent[leaf] = map;
  build(map);
  try {
    await writeAtomic(file, `${JSON.stringify(root, null, 2)}\n`);
  } catch (error) {
    return { ok: false, error: 'config-write-error', detail: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Windows %APPDATA%, macOS Library/Application Support, Linux ~/.config. */
function appDataRoot(baseDir: string, platform: NodeJS.Platform, options: ClientConnectOptions): string {
  if (options.appDataDir) return options.appDataDir;
  if (platform === 'win32') return process.env.APPDATA ?? path.join(baseDir, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(baseDir, 'Library', 'Application Support');
  return path.join(baseDir, '.config');
}

/** VS Code keeps user-scope settings (and extensions' globalStorage) under the
 *  application-data tree rather than the home directory itself. */
function vsCodeUserDir(baseDir: string, platform: NodeJS.Platform, options: ClientConnectOptions): string {
  return path.join(appDataRoot(baseDir, platform, options), 'Code', 'User');
}

/** Config files this client reads. Qoder ships an international and a China
 *  build that keep the same settings file under `.qoder` or `.qoder-cn`, and
 *  only the installed one is meaningful, so an absent sibling is skipped; when
 *  neither exists yet the documented `.qoder` path is created. Cline does the
 *  same across its CLI home and the VS Code extension's globalStorage copy.
 *  Exported so the read-only status check inspects exactly the files the writer
 *  touches. */
export async function clientConfigTargets(
  client: JsonClient,
  baseDir: string,
  options: ClientConnectOptions = {},
): Promise<ClientConfigTarget[]> {
  const platform = options.platform ?? process.platform;
  const mcpServers = (file: string): ClientConfigTarget[] => [{ file, serverPath: ['mcpServers'] }];
  if (client === 'claude') return mcpServers(path.join(baseDir, '.claude.json'));
  if (client === 'cursor') return mcpServers(path.join(baseDir, '.cursor', 'mcp.json'));
  if (client === 'antigravity') return mcpServers(path.join(baseDir, '.gemini', 'antigravity', 'mcp_config.json'));
  if (client === 'gemini') return mcpServers(path.join(baseDir, '.gemini', 'settings.json'));
  if (client === 'vscode') return [{ file: path.join(vsCodeUserDir(baseDir, platform, options), 'mcp.json'), serverPath: ['servers'] }];
  if (client === 'openclaw') return [{ file: path.join(baseDir, '.openclaw', 'openclaw.json'), serverPath: ['mcp', 'servers'] }];
  if (client === 'cline') {
    const targets: ClientConfigTarget[] = [{
      file: path.join(baseDir, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
      serverPath: ['mcpServers'],
    }];
    // The VS Code extension keeps its own copy. Only the installed build has
    // that directory, so writing it unconditionally would leave a file the
    // extension never reads.
    const extension = path.join(
      vsCodeUserDir(baseDir, platform, options),
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );
    if (await isDirectory(path.dirname(extension))) targets.push({ file: extension, serverPath: ['mcpServers'] });
    return targets;
  }
  const homes: string[] = [];
  for (const dir of ['.qoder', '.qoder-cn']) {
    if (await isDirectory(path.join(baseDir, dir))) homes.push(dir);
  }
  return (homes.length ? homes : ['.qoder']).map((dir) => ({
    file: path.join(baseDir, dir, 'settings.json'),
    serverPath: ['mcpServers'] as const,
  }));
}

/** The server entry each client's own schema accepts. They differ by one field
 *  at a time, so the shape is spelled out rather than configurable. */
function clientEntry(client: JsonClient, endpoint: string, token: string): Record<string, unknown> {
  const headers = { Authorization: `Bearer ${token}` };
  if (client === 'antigravity') return { httpUrl: endpoint, headers };
  if (client === 'cline') return { transport: { type: 'streamableHttp', url: endpoint, headers } };
  if (client === 'openclaw') return { url: endpoint, transport: 'streamable-http', headers };
  if (client === 'gemini') return { url: endpoint, type: 'http', headers };
  return { type: 'http', url: endpoint, headers };
}

async function connectJsonClients(
  targets: readonly ClientConfigTarget[],
  entry: Record<string, unknown>,
): Promise<{ ok: true; paths: string[] } | MergeFailure> {
  const written: string[] = [];
  for (const target of targets) {
    const result = await mergeJsonConfig(target.file, target.serverPath, (servers) => {
      servers.openchatcut = entry;
    });
    if (!result.ok) return result;
    written.push(target.file);
  }
  return { ok: true, paths: written };
}

/** No shell and no input: Windows PowerShell waits for EOF on an open stdin
 *  pipe. Only stderr is kept, bounded, for the failure detail. */
function spawnCommand(command: ConnectCommand): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      env: command.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stderr: stderr || 'spawn failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/** Codex CLIs to try in order. Windows reuses the built-in Codex agent's lookup,
 *  which knows OPENCHATCUT_CODEX_PATH, the npm `codex.cmd` shim and the `.exe`
 *  installs; elsewhere a `codex` on PATH comes first, then ~/.local/bin and the
 *  CLI bundled in the macOS ChatGPT app. */
async function codexCandidates(baseDir: string, platform: NodeJS.Platform, options: ClientConnectOptions): Promise<string[]> {
  if (options.codexBin) return [options.codexBin];
  if (platform === 'win32') {
    const found = await (options.resolveCodexBin ?? resolveCodexCli)();
    return found ? [found] : [];
  }
  return ['codex', ...CODEX_BIN_FALLBACKS.map((relative) => (relative.startsWith('/') ? relative : path.join(baseDir, relative)))];
}

/** macOS/Linux: one `export` line for the token, kept current in ~/.zshrc. */
async function saveTokenToZshrc(token: string, baseDir: string, codexConfig: string): Promise<ClientConnectResult> {
  const zshrc = path.join(baseDir, '.zshrc');
  const wanted = `export ${TOKEN_ENV_VAR}='${token}'`;
  try {
    let text = '';
    try {
      text = await readFile(zshrc, 'utf8');
    } catch {
      /* first connection - file does not exist yet */
    }
    const lines = text.split('\n');
    const idx = lines.findIndex((line) => /^\s*(export\s+)?OPENCHATCUT_MCP_TOKEN=/.test(line));
    if (idx >= 0) {
      if (lines[idx].trim() !== wanted) lines[idx] = wanted;
      await writeAtomic(zshrc, lines.join('\n'));
    } else {
      const suffix = text && !text.endsWith('\n') ? '\n' : '';
      await writeAtomic(zshrc, `${text}${suffix}# OpenChatCut MCP token (added by OpenChatCut)\n${wanted}\n`);
    }
  } catch (error) {
    return { ok: false, error: 'config-write-error', detail: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, paths: [codexConfig, displayClientPath(baseDir, zshrc)] };
}

/** Windows: the token becomes a user environment variable. See WINDOWS_SAVE_TOKEN_SCRIPT. */
async function saveTokenToWindowsUserEnv(token: string, run: ConnectCommandRunner, codexConfig: string): Promise<ClientConnectResult> {
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { code, stderr } = await run({
    executable: powershell,
    args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SAVE_TOKEN_SCRIPT],
    env: { ...process.env, [TOKEN_ENV_VAR]: token },
  });
  if (code !== 0) {
    // PowerShell never prints the value, but the detail reaches the browser.
    const detail = (stderr || `exit code ${code}`).split(token).join('<redacted>');
    return { ok: false, error: 'token-env-write-error', detail: detail.slice(-200) };
  }
  return { ok: true, paths: [codexConfig, WINDOWS_USER_ENV_LOCATION], notice: 'restart-codex' };
}

async function connectCodex(endpoint: string, token: string, baseDir: string, options: ClientConnectOptions): Promise<ClientConnectResult> {
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? spawnCommand;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: baseDir, CODEX_HOME: path.join(baseDir, '.codex') };
  const args = ['mcp', 'add', 'openchatcut', '--url', endpoint, '--bearer-token-env-var', TOKEN_ENV_VAR];
  let lastStderr = 'codex CLI not found';
  for (const bin of await codexCandidates(baseDir, platform, options)) {
    const { code, stderr } = await run({ ...codexCommand(bin, args, platform), env });
    if (code === 0) {
      const codexConfig = displayClientPath(baseDir, path.join(baseDir, '.codex', 'config.toml'));
      return platform === 'win32'
        ? saveTokenToWindowsUserEnv(token, run, codexConfig)
        : saveTokenToZshrc(token, baseDir, codexConfig);
    }
    lastStderr = stderr || `exit code ${code}`;
  }
  return { ok: false, error: 'codex-cli-failed', detail: lastStderr.slice(-200) };
}

export async function connectExternalClient(
  client: string,
  endpoint: string,
  token: string,
  options: ClientConnectOptions = {},
): Promise<ClientConnectResult> {
  const selected = client as ConnectClient;
  if (!CONNECT_CLIENTS.includes(selected)) {
    return { ok: false, error: 'invalid-client' };
  }
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint) || !TOKEN_PATTERN.test(token)) {
    return { ok: false, error: 'invalid-token' };
  }
  const baseDir = options.baseDir ?? homedir();
  if (selected === 'codex') return connectCodex(endpoint, token, baseDir, options);
  const targets = await clientConfigTargets(selected, baseDir, options);
  const result = await connectJsonClients(targets, clientEntry(selected, endpoint, token));
  if (!result.ok) return result;
  return { ok: true, paths: result.paths.map((file) => displayClientPath(baseDir, file)) };
}
