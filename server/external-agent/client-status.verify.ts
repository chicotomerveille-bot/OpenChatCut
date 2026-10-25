// Detection has to answer one question per client: does this client's own config
// already carry this endpoint and this token? It reads exactly the files the
// writer touches, understands the three JSON shapes plus Codex's TOML and
// OpenCode's JSONC, and never returns the token itself. Runs in a temp HOME.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectExternalClient, type ClientConnectOptions } from './client-connect';
import { DETECTABLE_CLIENTS, readExternalClientStatus, stripJsonc } from './client-status';

const ENDPOINT = 'http://localhost:5199/api/external-mcp/mcp';
const TOKEN = 'tok_status_AbC123-_xyz';

async function statusOf(
  home: string,
  client: string,
  options: ClientConnectOptions = {},
  endpoint = ENDPOINT,
  token = TOKEN,
): Promise<string> {
  const statuses = await readExternalClientStatus(endpoint, token, { baseDir: home, ...options });
  const found = statuses.find((entry) => entry.client === client);
  assert.ok(found, `status for ${client}`);
  return found.state;
}

async function main(): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'occ-status-'));
  try {
    // 1. Nothing installed: every client reports no-config and the payload
    //    carries no token.
    const empty = await readExternalClientStatus(ENDPOINT, TOKEN, { baseDir: home });
    assert.deepEqual(empty.map((entry) => entry.client), [...DETECTABLE_CLIENTS]);
    assert.ok(empty.every((entry) => entry.state === 'no-config'), 'a fresh home has nothing configured');
    assert.ok(!JSON.stringify(empty).includes(TOKEN), 'the token never reaches the browser');
    assert.ok(!JSON.stringify(empty).includes('tok_'), 'no token fragment in the payload');

    // 2. What the writer wrote is what the reader reports.
    await connectExternalClient('cursor', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(await statusOf(home, 'cursor'), 'configured');
    assert.equal(await statusOf(home, 'cursor', {}, ENDPOINT, 'tok_ROTATED'), 'stale-token');
    assert.equal(await statusOf(home, 'cursor', {}, 'http://localhost:5200/api/external-mcp/mcp'), 'other-endpoint');
    // localhost and 127.0.0.1 are the same local server.
    assert.equal(await statusOf(home, 'cursor', {}, 'http://127.0.0.1:5199/api/external-mcp/mcp'), 'configured');

    // 3. OpenCode: JSONC with comments and trailing commas, and the entry under
    //    `mcp` rather than `mcpServers`.
    const opencodeDir = path.join(home, '.config', 'opencode');
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(path.join(opencodeDir, 'opencode.jsonc'), `{
  // my editors
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "openchatcut": {
      "type": "remote",
      "url": "${ENDPOINT}",
      "headers": { "Authorization": "Bearer ${TOKEN}" },
    },
  },
}
`);
    assert.equal(await statusOf(home, 'opencode'), 'configured');
    assert.equal(await statusOf(home, 'opencode', {}, ENDPOINT, 'tok_OLD'), 'stale-token');
    // A JSONC file the token is not in stays parseable, not "unreadable".
    await writeFile(path.join(opencodeDir, 'opencode.jsonc'), '{ /* nothing */ "mcp": {} }');
    assert.equal(await statusOf(home, 'opencode'), 'absent');
    await writeFile(path.join(opencodeDir, 'opencode.jsonc'), '{ "mcp": ');
    assert.equal(await statusOf(home, 'opencode'), 'unreadable');

    // 4. Stripping comments must not touch string contents.
    assert.equal(stripJsonc('{"a":"// not a comment","b":"/* nor this */",}'), '{"a":"// not a comment","b":"/* nor this */"}');

    // 5. Codex: TOML section, token by environment variable (nothing to compare).
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex', 'config.toml'), [
      'model = "gpt-5"',
      '[mcp_servers.openchatcut]',
      `url = "${ENDPOINT}"`,
      'bearer_token_env_var = "OPENCHATCUT_MCP_TOKEN"',
      '',
      '[mcp_servers.other]',
      'url = "http://example.test/mcp"',
      '',
    ].join('\n'));
    assert.equal(await statusOf(home, 'codex'), 'configured');
    assert.equal(await statusOf(home, 'codex', {}, ENDPOINT, 'tok_ROTATED'), 'configured', 'env token cannot go stale on disk');

    // 6. VS Code: the `servers` root, under the platform's app-data tree.
    await connectExternalClient('vscode', ENDPOINT, TOKEN, { baseDir: home, platform: 'linux' });
    assert.equal(await statusOf(home, 'vscode', { platform: 'linux' }), 'configured');

    // 7. Cline: the entry nests its transport.
    await connectExternalClient('cline', ENDPOINT, TOKEN, { baseDir: home, platform: 'linux' });
    assert.equal(await statusOf(home, 'cline', { platform: 'linux' }), 'configured');

    // 8. OpenClaw: nested mcp.servers; an entry pointing elsewhere is reported
    //    as another instance, not as configured.
    await mkdir(path.join(home, '.openclaw'), { recursive: true });
    await writeFile(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({
      gateway: { mode: 'local' },
      mcp: { servers: { openchatcut: { url: 'http://localhost:5199/api/external-mcp/mcp/', transport: 'streamable-http', headers: { Authorization: 'Bearer tok_OTHER' } } } },
    }));
    assert.equal(await statusOf(home, 'openclaw'), 'stale-token');
    await connectExternalClient('openclaw', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(await statusOf(home, 'openclaw'), 'configured');

    // 9. A config file that exists but is not JSON is unreadable, not absent.
    await writeFile(path.join(home, '.claude.json'), '{broken');
    assert.equal(await statusOf(home, 'claude'), 'unreadable');

    // 10. A file that exists without the entry is absent, not unreadable.
    await mkdir(path.join(home, '.gemini'), { recursive: true });
    await writeFile(path.join(home, '.gemini', 'settings.json'), '{ "mcpServers": { "other": { "command": "x" } } }');
    assert.equal(await statusOf(home, 'gemini'), 'absent');

    // 11. Codex also accepts the bearer token as a literal header on an inline
    //     table — what `codex mcp add --header` writes. That token counts: a
    //     working setup must not read as stale.
    await writeFile(path.join(home, '.codex', 'config.toml'), [
      '[mcp_servers.openchatcut]',
      `url = "${ENDPOINT}"`,
      `http_headers = { "Authorization" = "Bearer ${TOKEN}", "x-openchatcut-mcp-client" = "codex" }`,
      '',
    ].join('\n'));
    assert.equal(await statusOf(home, 'codex'), 'configured');
    assert.equal(await statusOf(home, 'codex', {}, ENDPOINT, 'tok_ROTATED'), 'stale-token', 'a literal header token is compared');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  console.log('✓ client-status: endpoint + token detection per client, token never leaves the server');
}

void main();
