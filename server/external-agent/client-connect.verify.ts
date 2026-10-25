// One-click client connect: JSON config merges are idempotent and never
// clobber existing servers; broken JSON is refused; the Codex path drives the
// CLI and keeps the token where Codex reads it: the shell export on macOS/Linux,
// the Windows user environment on win32 (#161). Runs entirely inside a temp
// HOME; the Windows cases record commands through an injected runner, so no
// PowerShell, registry or real Codex CLI is ever touched.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectExternalClient, type ConnectCommand, type ConnectCommandRunner } from './client-connect';

const ENDPOINT = 'http://localhost:5199/api/external-mcp/mcp';
const TOKEN = 'tok_AbC123-_xyz';
const CODEX_ARGS = ['mcp', 'add', 'openchatcut', '--url', ENDPOINT, '--bearer-token-env-var', 'OPENCHATCUT_MCP_TOKEN'];

/** Records every command; `reply` decides each exit code (default: success). */
function recordingRunner(
  reply: (command: ConnectCommand) => { code: number | null; stderr: string } = () => ({ code: 0, stderr: '' }),
): { calls: ConnectCommand[]; run: ConnectCommandRunner } {
  const calls: ConnectCommand[] = [];
  return { calls, run: async (command) => { calls.push(command); return reply(command); } };
}

async function assertMissing(file: string, message: string): Promise<void> {
  await assert.rejects(stat(file), { code: 'ENOENT' }, message);
}

async function main(): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'occ-connect-'));
  try {
    // 1. Cursor: file created from scratch with the http entry.
    const cursor = await connectExternalClient('cursor', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(cursor.ok, true);
    assert.deepEqual(cursor.paths, ['~/.cursor/mcp.json']);
    const cursorConfig = JSON.parse(await readFile(path.join(home, '.cursor/mcp.json'), 'utf8'));
    assert.equal(cursorConfig.mcpServers.openchatcut.type, 'http');
    assert.equal(cursorConfig.mcpServers.openchatcut.url, ENDPOINT);
    assert.equal(cursorConfig.mcpServers.openchatcut.headers.Authorization, `Bearer ${TOKEN}`);

    // 2. Idempotent reconnect and existing-server preservation.
    await writeFile(
      path.join(home, '.cursor/mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2),
    );
    const again = await connectExternalClient('cursor', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(again.ok, true);
    const merged = JSON.parse(await readFile(path.join(home, '.cursor/mcp.json'), 'utf8'));
    assert.equal(merged.mcpServers.other.command, 'other', 'existing server preserved');
    assert.equal(merged.mcpServers.openchatcut.url, ENDPOINT, 'openchatcut rewritten');

    // 3. Invalid JSON is refused without touching the file.
    await writeFile(path.join(home, '.cursor/mcp.json'), '{broken');
    const broken = await connectExternalClient('cursor', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(broken.ok, false);
    if (!broken.ok) assert.equal(broken.error, 'config-parse-error');
    assert.equal(await readFile(path.join(home, '.cursor/mcp.json'), 'utf8'), '{broken');

    // 4. Antigravity: httpUrl shape merged into an existing config.
    await mkdir(path.join(home, '.gemini/antigravity'), { recursive: true });
    await writeFile(
      path.join(home, '.gemini/antigravity/mcp_config.json'),
      JSON.stringify({ mcpServers: { keep: { httpUrl: 'http://x' } } }, null, 2),
    );
    const ag = await connectExternalClient('antigravity', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(ag.ok, true);
    const agConfig = JSON.parse(await readFile(path.join(home, '.gemini/antigravity/mcp_config.json'), 'utf8'));
    assert.equal(agConfig.mcpServers.keep.httpUrl, 'http://x');
    assert.equal(agConfig.mcpServers.openchatcut.httpUrl, ENDPOINT);
    assert.equal(agConfig.mcpServers.openchatcut.headers.Authorization, `Bearer ${TOKEN}`);

    // 5. Claude: creates ~/.claude.json with a user-scope mcpServers entry.
    const claude = await connectExternalClient('claude', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(claude.ok, true);
    const claudeConfig = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(claudeConfig.mcpServers.openchatcut.type, 'http');
    assert.equal(claudeConfig.mcpServers.openchatcut.url, ENDPOINT);

    // 6. Qoder: neither build home exists yet, so the documented ~/.qoder wins.
    const qoderFirst = await connectExternalClient('qoder', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(qoderFirst.ok, true);
    if (qoderFirst.ok) assert.deepEqual(qoderFirst.paths, ['~/.qoder/settings.json']);
    const qoderConfig = JSON.parse(await readFile(path.join(home, '.qoder/settings.json'), 'utf8'));
    assert.equal(qoderConfig.mcpServers.openchatcut.type, 'http');
    assert.equal(qoderConfig.mcpServers.openchatcut.url, ENDPOINT);
    assert.equal(qoderConfig.mcpServers.openchatcut.headers.Authorization, `Bearer ${TOKEN}`);
    // An unrelated entry survives the merge. Qoder's settings.json is the app's
    // whole settings file rather than a dedicated MCP config, so keys outside
    // mcpServers must survive too.
    qoderConfig.mcpServers.keeps = { command: 'keep-me' };
    qoderConfig.theme = 'dark';
    await writeFile(path.join(home, '.qoder/settings.json'), JSON.stringify(qoderConfig, null, 2));
    // Once a China build home is installed too, both settings files get the entry.
    await mkdir(path.join(home, '.qoder-cn'), { recursive: true });
    const qoderBoth = await connectExternalClient('qoder', ENDPOINT, 'tok_QOD2', { baseDir: home });
    assert.equal(qoderBoth.ok, true);
    if (qoderBoth.ok) assert.deepEqual(qoderBoth.paths, ['~/.qoder/settings.json', '~/.qoder-cn/settings.json']);
    const qoderInternational = JSON.parse(await readFile(path.join(home, '.qoder/settings.json'), 'utf8'));
    assert.deepEqual(qoderInternational.mcpServers.keeps, { command: 'keep-me' }, 'unrelated server preserved');
    assert.equal(qoderInternational.theme, 'dark', 'unrelated settings preserved');
    for (const file of ['.qoder/settings.json', '.qoder-cn/settings.json']) {
      const config = JSON.parse(await readFile(path.join(home, file), 'utf8'));
      assert.equal(config.mcpServers.openchatcut.url, ENDPOINT, `${file} points at OpenChatCut`);
      assert.equal(config.mcpServers.openchatcut.headers.Authorization, 'Bearer tok_QOD2', `${file} refreshed`);
    }

    // 7. Codex: stub CLI must receive the right args; .zshrc export is added,
    //    then updated (not duplicated) when the token changes.
    const stubDir = path.join(home, 'bin');
    await mkdir(stubDir, { recursive: true });
    await mkdir(path.join(home, '.codex'), { recursive: true });
    const stub = path.join(stubDir, 'codex-stub');
    await writeFile(stub, '#!/bin/sh\necho "$@" >> "$CODEX_HOME/stub-args"\nexit 0\n');
    await chmod(stub, 0o755);
    const codex = await connectExternalClient('codex', ENDPOINT, TOKEN, { baseDir: home, codexBin: stub });
    assert.equal(codex.ok, true);
    if (codex.ok) assert.deepEqual(codex.paths, ['~/.codex/config.toml', '~/.zshrc']);
    const stubArgs = (await readFile(path.join(home, '.codex/stub-args'), 'utf8')).trim();
    assert.equal(
      stubArgs,
      `mcp add openchatcut --url ${ENDPOINT} --bearer-token-env-var OPENCHATCUT_MCP_TOKEN`,
    );
    const zshrcFirst = await readFile(path.join(home, '.zshrc'), 'utf8');
    assert.match(zshrcFirst, /# OpenChatCut MCP token \(added by OpenChatCut\)\nexport OPENCHATCUT_MCP_TOKEN='tok_AbC123-_xyz'\n$/);
    const rotated = await connectExternalClient('codex', ENDPOINT, 'tok_NEW456', { baseDir: home, codexBin: stub });
    assert.equal(rotated.ok, true);
    const zshrcSecond = await readFile(path.join(home, '.zshrc'), 'utf8');
    assert.match(zshrcSecond, /export OPENCHATCUT_MCP_TOKEN='tok_NEW456'/);
    assert.equal((zshrcSecond.match(/OPENCHATCUT_MCP_TOKEN=/g) ?? []).length, 1, 'no duplicate export');

    // 8. Codex CLI failure surfaces as codex-cli-failed.
    const failStub = path.join(stubDir, 'codex-fail');
    await writeFile(failStub, '#!/bin/sh\necho boom >&2\nexit 3\n');
    await chmod(failStub, 0o755);
    const codexFail = await connectExternalClient('codex', ENDPOINT, TOKEN, { baseDir: home, codexBin: failStub });
    assert.equal(codexFail.ok, false);
    if (!codexFail.ok) {
      assert.equal(codexFail.error, 'codex-cli-failed');
      assert.match(codexFail.detail ?? '', /boom/);
    }

    // 9. macOS/Linux lookup: bare `codex`, then ~/.local/bin, then the CLI in
    //    the ChatGPT app, each run with the plain argv, and the token lands in
    //    ~/.zshrc with nothing Windows-specific run.
    const unixHome = path.join(home, 'unix');
    const unix = recordingRunner((command) => (
      command.executable === '/Applications/ChatGPT.app/Contents/Resources/codex'
        ? { code: 0, stderr: '' }
        : { code: null, stderr: 'spawn failed' }
    ));
    const unixCodex = await connectExternalClient('codex', ENDPOINT, TOKEN, { baseDir: unixHome, platform: 'darwin', runCommand: unix.run });
    assert.deepEqual(unixCodex, { ok: true, paths: ['~/.codex/config.toml', '~/.zshrc'] });
    assert.deepEqual(unix.calls.map((call) => call.executable), [
      'codex',
      path.join(unixHome, '.local/bin/codex'),
      '/Applications/ChatGPT.app/Contents/Resources/codex',
    ]);
    for (const call of unix.calls) {
      assert.deepEqual(call.args, CODEX_ARGS);
      assert.equal(call.windowsVerbatimArguments, undefined);
      assert.equal(call.env.CODEX_HOME, path.join(unixHome, '.codex'));
    }
    assert.match(await readFile(path.join(unixHome, '.zshrc'), 'utf8'), /^export OPENCHATCUT_MCP_TOKEN='tok_AbC123-_xyz'$/m);

    // 10. Windows: the CLI comes from the shared lookup, an npm `codex.cmd`
    //     shim runs through cmd.exe, and the token becomes a user environment
    //     variable via PowerShell. It travels only in that child's environment,
    //     never on a command line, and ~/.zshrc is not written.
    const envBefore = process.env.OPENCHATCUT_MCP_TOKEN;
    const winHome = path.join(home, 'win');
    const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd';
    const win = recordingRunner();
    const winCodex = await connectExternalClient('codex', ENDPOINT, TOKEN, {
      baseDir: winHome,
      platform: 'win32',
      runCommand: win.run,
      resolveCodexBin: async () => shim,
    });
    assert.deepEqual(winCodex, {
      ok: true,
      paths: ['~/.codex/config.toml', 'HKCU\\Environment\\OPENCHATCUT_MCP_TOKEN'],
      notice: 'restart-codex',
    });
    assert.equal(win.calls.length, 2, 'codex mcp add, then the user environment write');
    const [winAdd, winSave] = win.calls;
    assert.match(winAdd.executable, /cmd\.exe$/i, 'a .cmd shim needs cmd.exe');
    assert.equal(winAdd.windowsVerbatimArguments, true);
    assert.match(winAdd.args[3], /codex\.cmd \^"mcp\^" \^"add\^" \^"openchatcut\^"/);
    assert.match(winAdd.args[3], /\^"--bearer-token-env-var\^" \^"OPENCHATCUT_MCP_TOKEN\^"/);
    assert.equal(winAdd.env.CODEX_HOME, path.join(winHome, '.codex'));
    assert.match(winSave.executable, /^[A-Z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i,
      'Windows PowerShell by absolute path, not whatever PATH offers');
    assert.deepEqual(winSave.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    const script = winSave.args[3] ?? '';
    assert.match(script, /\[Environment\]::SetEnvironmentVariable\('OPENCHATCUT_MCP_TOKEN', \$token, 'User'\)/);
    assert.match(script, /GetEnvironmentVariable\('OPENCHATCUT_MCP_TOKEN', 'User'\) -cne \$token\) \{ exit 3 \}/,
      'the saved value is read back before reporting success');
    assert.equal(winSave.env.OPENCHATCUT_MCP_TOKEN, TOKEN, 'the token is handed over through the environment');
    for (const call of win.calls) {
      assert.ok(call.args.every((arg) => !arg.includes(TOKEN)), `${call.executable} never gets the token as an argument`);
    }
    assert.equal(process.env.OPENCHATCUT_MCP_TOKEN, envBefore, 'the server process environment is left alone');
    await assertMissing(path.join(winHome, '.zshrc'), 'no ~/.zshrc on Windows');

    // 11. Windows: a failed save (PowerShell error) or an unverified one (the
    //     read-back exit 3) is an error, never "connected", and the token is
    //     scrubbed from the detail. A codex.exe runs directly, without cmd.exe.
    const exe = 'C:\\Users\\me\\.local\\bin\\codex.exe';
    for (const [saveReply, expectedDetail] of [
      [{ code: 1, stderr: `SetEnvironmentVariable failed for ${TOKEN}` }, 'SetEnvironmentVariable failed for <redacted>'],
      [{ code: 3, stderr: '' }, 'exit code 3'],
    ] as const) {
      const winFail = recordingRunner((command) => (command.executable === exe ? { code: 0, stderr: '' } : saveReply));
      const winSaveFailed = await connectExternalClient('codex', ENDPOINT, TOKEN, {
        baseDir: winHome,
        platform: 'win32',
        runCommand: winFail.run,
        resolveCodexBin: async () => exe,
      });
      assert.deepEqual(winSaveFailed, { ok: false, error: 'token-env-write-error', detail: expectedDetail });
      assert.equal(winFail.calls[0]?.executable, exe);
      assert.deepEqual(winFail.calls[0]?.args, CODEX_ARGS);
      assert.equal(winFail.calls.length, 2);
    }
    await assertMissing(path.join(winHome, '.zshrc'), 'no ~/.zshrc fallback when the save fails');

    // 12. Windows without a Codex CLI: nothing runs, nothing is written.
    const winNone = recordingRunner();
    const winMissing = await connectExternalClient('codex', ENDPOINT, TOKEN, {
      baseDir: winHome,
      platform: 'win32',
      runCommand: winNone.run,
      resolveCodexBin: async () => null,
    });
    assert.deepEqual(winMissing, { ok: false, error: 'codex-cli-failed', detail: 'codex CLI not found' });
    assert.equal(winNone.calls.length, 0);

    // 13. Validation: unknown client and malformed token are rejected.
    const badClient = await connectExternalClient('evil', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(badClient.ok, false);
    const badToken = await connectExternalClient('cursor', ENDPOINT, "'; rm -rf ~", { baseDir: home });
    assert.equal(badToken.ok, false);
    if (!badToken.ok) assert.equal(badToken.error, 'invalid-token');
    // 14. VS Code: user-scope mcp.json under the application-data tree, keyed by
    //     `servers` rather than `mcpServers`. Existing entries and unrelated
    //     settings survive a reconnect.
    const appData = path.join(home, 'AppData/Roaming');
    const vscode = await connectExternalClient('vscode', ENDPOINT, TOKEN, {
      baseDir: home, platform: 'win32', appDataDir: appData,
    });
    assert.equal(vscode.ok, true);
    if (vscode.ok) assert.deepEqual(vscode.paths, ['~/AppData/Roaming/Code/User/mcp.json']);
    const vscodeFile = path.join(appData, 'Code/User/mcp.json');
    const vscodeConfig = JSON.parse(await readFile(vscodeFile, 'utf8'));
    assert.equal(vscodeConfig.servers.openchatcut.type, 'http');
    assert.equal(vscodeConfig.servers.openchatcut.url, ENDPOINT);
    assert.equal(vscodeConfig.servers.openchatcut.headers.Authorization, `Bearer ${TOKEN}`);
    await writeFile(vscodeFile, JSON.stringify({ servers: { keep: { command: 'keep' } }, theme: 'dark' }, null, 2));
    const vscodeAgain = await connectExternalClient('vscode', ENDPOINT, TOKEN, {
      baseDir: home, platform: 'win32', appDataDir: appData,
    });
    assert.equal(vscodeAgain.ok, true);
    const vscodeMerged = JSON.parse(await readFile(vscodeFile, 'utf8'));
    assert.deepEqual(vscodeMerged.servers.keep, { command: 'keep' }, 'unrelated server preserved');
    assert.equal(vscodeMerged.theme, 'dark', 'unrelated settings preserved');

    // 15. Gemini CLI: ~/.gemini/settings.json keeps its http entry beside the
    //     servers already registered there.
    await mkdir(path.join(home, '.gemini'), { recursive: true });
    await writeFile(
      path.join(home, '.gemini/settings.json'),
      JSON.stringify({ mcpServers: { keep: { command: 'gemini-keep' } } }, null, 2),
    );
    const gemini = await connectExternalClient('gemini', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(gemini.ok, true);
    const geminiConfig = JSON.parse(await readFile(path.join(home, '.gemini/settings.json'), 'utf8'));
    assert.deepEqual(geminiConfig.mcpServers.keep, { command: 'gemini-keep' });
    assert.equal(geminiConfig.mcpServers.openchatcut.url, ENDPOINT);
    assert.equal(geminiConfig.mcpServers.openchatcut.type, 'http');

    // 16. Cline: the CLI settings file always; the VS Code extension copy only
    //     once the extension has created its globalStorage directory.
    const cline = await connectExternalClient('cline', ENDPOINT, TOKEN, { baseDir: home, platform: 'win32', appDataDir: appData });
    assert.equal(cline.ok, true);
    if (cline.ok) assert.deepEqual(cline.paths, ['~/.cline/data/settings/cline_mcp_settings.json']);
    const clineConfig = JSON.parse(await readFile(path.join(home, '.cline/data/settings/cline_mcp_settings.json'), 'utf8'));
    assert.deepEqual(clineConfig.mcpServers.openchatcut.transport, {
      type: 'streamableHttp',
      url: ENDPOINT,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const clineExtension = path.join(appData, 'Code/User/globalStorage/saoudrizwan.claude-dev/settings');
    await mkdir(clineExtension, { recursive: true });
    const clineBoth = await connectExternalClient('cline', ENDPOINT, TOKEN, { baseDir: home, platform: 'win32', appDataDir: appData });
    assert.equal(clineBoth.ok, true);
    if (clineBoth.ok) assert.equal(clineBoth.paths.length, 2, 'both installed Cline homes are written');
    const clineExtensionConfig = JSON.parse(await readFile(path.join(clineExtension, 'cline_mcp_settings.json'), 'utf8'));
    assert.equal(clineExtensionConfig.mcpServers.openchatcut.transport.url, ENDPOINT);

    // 17. OpenClaw: nested mcp.servers; everything else in the file survives.
    await mkdir(path.join(home, '.openclaw'), { recursive: true });
    await writeFile(path.join(home, '.openclaw/openclaw.json'), JSON.stringify({
      gateway: { mode: 'local' },
      mcp: { apps: { enabled: true }, servers: { filmcraft: { command: 'filmcraft' } } },
    }, null, 2));
    const openclaw = await connectExternalClient('openclaw', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(openclaw.ok, true);
    const openclawConfig = JSON.parse(await readFile(path.join(home, '.openclaw/openclaw.json'), 'utf8'));
    assert.equal(openclawConfig.gateway.mode, 'local');
    assert.equal(openclawConfig.mcp.apps.enabled, true);
    assert.deepEqual(openclawConfig.mcp.servers.filmcraft, { command: 'filmcraft' });
    assert.equal(openclawConfig.mcp.servers.openchatcut.transport, 'streamable-http');
    assert.equal(openclawConfig.mcp.servers.openchatcut.url, ENDPOINT);

    // 18. A nested server map that is not an object is refused instead of
    //     replaced, so a hand-edited file is never silently destroyed.
    await writeFile(path.join(home, '.openclaw/openclaw.json'), JSON.stringify({ mcp: { servers: [] } }));
    const openclawBroken = await connectExternalClient('openclaw', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(openclawBroken.ok, false);
    if (!openclawBroken.ok) assert.equal(openclawBroken.error, 'config-parse-error');
    assert.deepEqual(JSON.parse(await readFile(path.join(home, '.openclaw/openclaw.json'), 'utf8')), { mcp: { servers: [] } });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  console.log('✓ client-connect: merges idempotent, broken JSON refused, codex CLI + token saved per platform, five more client shapes');
}

void main();
