// Read-only detection of clients that are already registered: the MCP guide
// shows a client as configured when its own config file already carries the
// current endpoint and token. Nothing is written here, and the token never
// leaves the process — the caller receives a state name and the paths that were
// inspected, which is all the panel needs to stop offering "Connect" for work
// that is already done.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  CONNECT_CLIENTS,
  clientConfigTargets,
  displayClientPath,
  type ClientConnectOptions,
  type ClientConfigTarget,
  type ConnectClient,
} from './client-connect.ts';

/** OpenCode keeps its config in JSONC, so OpenChatCut copies a snippet instead
 *  of writing it. It is still detectable. */
export type DetectableClient = ConnectClient | 'opencode';
export const DETECTABLE_CLIENTS = [...CONNECT_CLIENTS, 'opencode'] as const;

export type ClientConnectionState =
  /** The client already points at this endpoint with this token. */
  | 'configured'
  /** Right endpoint, different token: the app re-keyed after the client was set up. */
  | 'stale-token'
  /** An entry exists but points at another port/origin — another instance. */
  | 'other-endpoint'
  /** The config file exists and parses, but has no openchatcut entry. */
  | 'absent'
  /** No config file found at any documented location. */
  | 'no-config'
  /** The config file exists but is not valid JSON(C)/TOML. */
  | 'unreadable';

export interface ClientConnectionStatus {
  client: DetectableClient;
  state: ClientConnectionState;
  /** Files that were inspected, home-relative when inside the home directory. */
  paths: string[];
}

interface EntryView {
  url?: string;
  /** Bearer token the file carries literally. */
  token?: string;
  /** The file defers to OPENCHATCUT_MCP_TOKEN (Codex), so there is no literal
   *  token to compare. */
  envToken?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `root.mcpServers.openchatcut`, `root.servers.openchatcut`,
 *  `root.mcp.servers.openchatcut` — whichever the client uses. */
function entryAt(root: unknown, serverPath: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of serverPath) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return isRecord(node) ? node.openchatcut : undefined;
}

/** Cline nests the transport; every other JSON client keeps url+headers flat.
 *  Antigravity uses `httpUrl`. */
function viewOf(entry: unknown): EntryView | null {
  if (!isRecord(entry)) return null;
  const transport = isRecord(entry.transport) ? entry.transport : entry;
  const url = typeof transport.url === 'string'
    ? transport.url
    : typeof entry.httpUrl === 'string' ? entry.httpUrl : undefined;
  const headers = isRecord(transport.headers) ? transport.headers : undefined;
  const authorization = typeof headers?.Authorization === 'string' ? headers.Authorization : undefined;
  return { url, token: authorization?.replace(/^Bearer\s+/i, '') };
}

/** Removes line/block comments and trailing commas from JSONC without touching
 *  string contents, which is enough to read an OpenCode config. */
export function stripJsonc(text: string): string {
  let withoutComments = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === '\\') {
          end += 2;
          continue;
        }
        if (text[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      withoutComments += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    withoutComments += char;
    index += 1;
  }
  let out = '';
  index = 0;
  while (index < withoutComments.length) {
    const char = withoutComments[index];
    if (char === '"') {
      let end = index + 1;
      while (end < withoutComments.length) {
        if (withoutComments[end] === '\\') {
          end += 2;
          continue;
        }
        if (withoutComments[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      out += withoutComments.slice(index, end);
      index = end;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < withoutComments.length && /\s/.test(withoutComments[lookahead])) lookahead += 1;
      if (withoutComments[lookahead] === '}' || withoutComments[lookahead] === ']') {
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Codex keeps TOML we do not parse into an object: this section is flat, so a
 *  line scan reads it and leaves the rest of the file alone. */
function codexView(text: string): EntryView | null {
  let inSection = false;
  let found = false;
  const view: EntryView = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inSection = /^\[mcp_servers\.(?:"openchatcut"|openchatcut)\]$/.test(line);
      if (inSection) found = true;
      continue;
    }
    if (!inSection) continue;
    const url = /^url\s*=\s*"([^"]*)"/.exec(line);
    if (url) view.url = url[1];
    const bearer = /^bearer_token\s*=\s*"([^"]*)"/.exec(line);
    if (bearer) view.token = bearer[1];
    const env = /^bearer_token_env_var\s*=\s*"([^"]*)"/.exec(line);
    if (env) view.envToken = env[1] === 'OPENCHATCUT_MCP_TOKEN';
    // Codex also accepts the token as a literal header on an inline table, which
    // is what `codex mcp add --url … --header …` writes and what the panel's own
    // snippet produces. Missing it made a working setup read as a stale token.
    const header = /"Authorization"\s*=\s*"Bearer\s+([^"]*)"/i.exec(line);
    if (header) view.token = header[1];
  }
  return found ? view : null;
}

/** Localhost and 127.0.0.1 are the same endpoint for a local client, and a
 *  trailing slash is not a different server. */
function normalizeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname === '127.0.0.1' || url.hostname === '[::1]' ? 'localhost' : url.hostname;
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return value;
  }
}

type TargetRead =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  /** Parsed. `view` is null when the file simply has no openchatcut entry. */
  | { kind: 'read'; view: EntryView | null };

async function readJsonTarget(target: ClientConfigTarget, jsonc: boolean): Promise<TargetRead> {
  let text: string;
  try {
    text = await readFile(target.file, 'utf8');
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonc ? stripJsonc(text) : text);
  } catch {
    return { kind: 'unreadable' };
  }
  return { kind: 'read', view: viewOf(entryAt(parsed, target.serverPath)) };
}

function stateOfViews(views: readonly EntryView[], endpoint: string, token: string): ClientConnectionState {
  const wanted = normalizeEndpoint(endpoint);
  const states = views.map((view): ClientConnectionState => {
    if (!view.url || normalizeEndpoint(view.url) !== wanted) return 'other-endpoint';
    // Codex reads the token from the environment, so the file cannot be
    // compared; a stale variable is the CLI's own error to report.
    if (view.envToken) return 'configured';
    return view.token === token ? 'configured' : 'stale-token';
  });
  if (states.includes('configured')) return 'configured';
  if (states.includes('stale-token')) return 'stale-token';
  return 'other-endpoint';
}

async function statusFor(
  client: DetectableClient,
  endpoint: string,
  token: string,
  baseDir: string,
  options: ClientConnectOptions,
): Promise<ClientConnectionStatus> {
  const reads: { file: string; read: TargetRead }[] = [];
  const inspect = async (target: ClientConfigTarget, jsonc = false): Promise<void> => {
    reads.push({ file: target.file, read: await readJsonTarget(target, jsonc) });
  };
  if (client === 'codex') {
    const file = path.join(baseDir, '.codex', 'config.toml');
    try {
      const text = await readFile(file, 'utf8');
      reads.push({ file, read: { kind: 'read', view: codexView(text) } });
    } catch (error) {
      reads.push({ file, read: { kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' } });
    }
  } else if (client === 'opencode') {
    for (const name of ['opencode.jsonc', 'opencode.json']) {
      await inspect({ file: path.join(baseDir, '.config', 'opencode', name), serverPath: ['mcp'] }, true);
    }
  } else {
    for (const target of await clientConfigTargets(client, baseDir, options)) {
      await inspect(target);
    }
  }

  const views = reads
    .map(({ read }) => (read.kind === 'read' ? read.view : null))
    .filter((view): view is EntryView => view !== null && (view.url !== undefined || view.token !== undefined));
  const state: ClientConnectionState = views.length
    ? stateOfViews(views, endpoint, token)
    : reads.some(({ read }) => read.kind === 'read') ? 'absent'
      : reads.some(({ read }) => read.kind === 'unreadable') ? 'unreadable'
        : 'no-config';
  return { client, state, paths: reads.map(({ file }) => displayClientPath(baseDir, file)) };
}

export async function readExternalClientStatus(
  endpoint: string,
  token: string,
  options: ClientConnectOptions = {},
): Promise<ClientConnectionStatus[]> {
  const baseDir = options.baseDir ?? homedir();
  const statuses: ClientConnectionStatus[] = [];
  for (const client of DETECTABLE_CLIENTS) {
    statuses.push(await statusFor(client, endpoint, token, baseDir, options));
  }
  return statuses;
}
