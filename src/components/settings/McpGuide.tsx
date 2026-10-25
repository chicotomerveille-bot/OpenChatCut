// Trusted editor guide for the authenticated Streamable HTTP endpoint.
// Most clients connect through the one-click server-side writer; clients that keep
// custom MCP servers in their own store get a JSON snippet to paste instead.
// The panel also reads back which clients already carry this endpoint, so a
// completed setup shows as configured instead of offering Connect forever.
import { useEffect, useState, type ReactElement } from 'react';
import { editorBootstrapInfo } from '../../agent/editor-credential';
import { theme, themeAlpha } from '../../theme';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';
import { openCodeConnectJson, qwenWorkConnectJson } from './mcpClientConfig';
import claudeSvg from '../../../assets/vendor-icons/claude-color.svg?raw';
import codexPng from '../../../assets/vendor-icons/codex-color.png';
import cursorPng from '../../../assets/vendor-icons/cursor-color.png';
import antigravityPng from '../../../assets/vendor-icons/antigravity-color.png';
import qwenSvg from '../../../assets/vendor-icons/qwen-color.svg?raw';

/** Mirrors ClientConnectionState on the server; the dialog only distinguishes
 *  the two states worth a badge. */
type ClientConnectionState = 'configured' | 'stale-token' | 'other-endpoint' | 'absent' | 'no-config' | 'unreadable';

interface ClientSnippet {
  client:
    | 'claude' | 'codex' | 'cursor' | 'antigravity' | 'qoder' | 'qwenwork'
    | 'opencode' | 'gemini' | 'vscode' | 'cline' | 'openclaw';
  logo: ReactElement;
  name: string;
  desc: string;
  /** 'connect' = OpenChatCut writes the config file for you; 'paste' = the client
   *  keeps custom MCP servers in its own store (or in JSONC we must not
   *  re-serialize), so there is no file to write and the snippet is copied. */
  mode: 'connect' | 'paste';
}

function clientSnippets(): ClientSnippet[] {
  return [
    {
      client: 'claude',
      logo: <span aria-hidden className="cc-vendor-icon" style={{ color: '#d97757', width: 26, height: 26, fontSize: 26, display: 'inline-flex' }} dangerouslySetInnerHTML={{ __html: claudeSvg }} />,
      name: 'Claude Code',
      desc: 'Anthropic 官方 CLI，Claude 订阅用户直连。',
      mode: 'connect',
    },
    {
      client: 'codex',
      logo: <ClientLogo src={codexPng} alt="Codex" />,
      name: 'Codex',
      desc: 'OpenAI CLI，通过环境变量携带令牌。',
      mode: 'connect',
    },
    {
      client: 'cursor',
      logo: <ClientLogo src={cursorPng} alt="Cursor" />,
      name: 'Cursor',
      desc: '写入 ~/.cursor/mcp.json 的全局配置。',
      mode: 'connect',
    },
    {
      client: 'opencode',
      logo: <ClientMonogram letter="OC" ariaLabel="OpenCode" />,
      name: 'OpenCode',
      desc: '配置写在 ~/.config/opencode/opencode.jsonc，复制 JSON 后粘贴到 mcp 字段。',
      mode: 'paste',
    },
    {
      client: 'gemini',
      logo: <ClientMonogram letter="G" ariaLabel="Gemini CLI" />,
      name: 'Gemini CLI',
      desc: '写入 ~/.gemini/settings.json；首次在项目中使用需执行 /trust。',
      mode: 'connect',
    },
    {
      client: 'cline',
      logo: <ClientMonogram letter="CL" ariaLabel="Cline" />,
      name: 'Cline',
      desc: '写入 Cline 的 cline_mcp_settings.json，CLI 与 VS Code 扩展都覆盖。',
      mode: 'connect',
    },
    {
      client: 'openclaw',
      logo: <ClientMonogram letter="OA" ariaLabel="OpenClaw" />,
      name: 'OpenClaw',
      desc: '写入 ~/.openclaw/openclaw.json 的 mcp.servers。',
      mode: 'connect',
    },
    {
      client: 'vscode',
      logo: <ClientMonogram letter="VS" ariaLabel="VS Code" />,
      name: 'VS Code',
      desc: '写入 VS Code 用户目录的 mcp.json，供 Copilot Chat 使用。',
      mode: 'connect',
    },
    {
      client: 'antigravity',
      logo: <ClientLogo src={antigravityPng} alt="Antigravity" />,
      name: 'Antigravity',
      desc: '写入 ~/.gemini/antigravity/mcp_config.json。',
      mode: 'connect',
    },
    {
      client: 'qoder',
      logo: <ClientMonogram letter="Q" ariaLabel="Qoder" />,
      name: 'Qoder',
      desc: '写入 ~/.qoder/settings.json，国内版同时写 ~/.qoder-cn。',
      mode: 'connect',
    },
    {
      client: 'qwenwork',
      logo: <span aria-hidden className="cc-vendor-icon" style={{ width: 26, height: 26, fontSize: 26, display: 'inline-flex' }} dangerouslySetInnerHTML={{ __html: qwenSvg }} />,
      name: '千问办公',
      desc: '自定义 MCP 只存在应用内，复制 JSON 后在连接器里粘贴。',
      mode: 'paste',
    },
  ];
}

function ClientLogo({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      aria-hidden
      style={{ width: 26, height: 26, borderRadius: 6, objectFit: 'contain', flex: '0 0 auto', background: theme.panel, border: `0.5px solid ${theme.borderLight}` }}
    />
  );
}

function ClientMonogram({ letter, ariaLabel }: { letter: string; ariaLabel: string }) {
  return (
    <span
      aria-label={ariaLabel}
      style={{
        width: 26, height: 26, borderRadius: 6, flex: '0 0 auto',
        background: theme.inset, border: `0.5px solid ${theme.borderLight}`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        color: theme.textMuted, fontSize: 12, fontWeight: 700,
      }}
    >
      {letter}
    </span>
  );
}

/** One read-only probe per dialog open; the server reports state names and the
 *  paths it inspected, never the token. */
async function fetchClientStatus(): Promise<Record<string, ClientConnectionState>> {
  try {
    const response = await fetch('/api/external-agent/client-status');
    if (!response.ok) return {};
    const data = (await response.json()) as { clients?: { client: string; state: ClientConnectionState }[] };
    const map: Record<string, ClientConnectionState> = {};
    for (const entry of data.clients ?? []) map[entry.client] = entry.state;
    return map;
  } catch {
    return {};
  }
}

function connectErrorMessage(t: ReturnType<typeof useT>, error: string): string {
  if (error === 'config-parse-error') return t('目标配置文件不是有效 JSON，为避免覆盖未写入。');
  if (error === 'config-write-error') return t('写入配置文件失败。');
  if (error === 'codex-cli-failed') return t('执行 codex mcp add 失败。');
  if (error === 'token-env-write-error') return t('已在 Codex 注册，但令牌未能保存为 Windows 用户环境变量，连接未完成。');
  return t('连接失败');
}

/** Green when the client already points here; amber when the app re-keyed under
 *  it, so "Connect" is the fix rather than a mystery. */
function ConnectionBadge({ state }: { state?: ClientConnectionState }) {
  const t = useT();
  if (state !== 'configured' && state !== 'stale-token') return null;
  const ok = state === 'configured';
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
        padding: '2px 8px', borderRadius: 999,
        background: theme.inset, border: `0.5px solid ${ok ? theme.success : theme.gold}`,
        color: ok ? theme.success : theme.gold, fontSize: 10.5, fontWeight: 600,
      }}
    >
      <Icon name={ok ? 'check' : 'plug'} size={10} />
      {ok ? t('已配置') : t('令牌已失效，请重新连接')}
    </span>
  );
}

function ConnectButton({
  client,
  configured,
  onStatus,
  onConnected,
}: {
  client: ClientSnippet['client'];
  configured: boolean;
  onStatus: (message: string, ok: boolean) => void;
  onConnected: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const busy = state === 'busy';
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setState('busy');
        onStatus('', true);
        void fetch('/api/external-agent/connect-client', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client }),
        })
          .then(async (response) => {
            const data: unknown = await response.json().catch(() => null);
            const result = data as { ok?: boolean; paths?: string[]; error?: string; notice?: string } | null;
            if (response.ok && result?.ok) {
              setState('done');
              const paths = (result.paths ?? []).join('、');
              // Only processes started after a Windows user variable is saved see it.
              const message = result.notice === 'restart-codex'
                ? t('已写入 {paths}。请完全退出并重新打开 Codex，令牌才会生效。', { paths })
                : t('已写入 {paths}', { paths });
              onStatus(message, true);
              onConnected();
              setTimeout(() => setState('idle'), 2500);
            } else {
              setState('error');
              onStatus(connectErrorMessage(t, result?.error ?? ''), false);
            }
          })
          .catch(() => {
            setState('error');
            onStatus(connectErrorMessage(t, ''), false);
          });
      }}
      style={{
        flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '4px 10px', border: '0.5px solid transparent', borderRadius: 5,
        background: state === 'error' ? theme.hover : `linear-gradient(135deg, ${theme.accent}, ${theme.accentDeep})`,
        boxShadow: state === 'error' ? 'none' : themeAlpha.shadow(0.25),
        color: state === 'error' ? theme.danger : theme.onAccent,
        fontSize: 11, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.7 : 1,
      }}
    >
      <Icon name={state === 'done' ? 'check' : 'plug'} size={11} />
      {busy
        ? t('连接中…')
        : state === 'done' ? t('已连接')
          : state === 'error' ? t('连接失败')
            : configured ? t('重新连接') : t('连接')}
    </button>
  );
}

function CopySnippetButton({ getSnippet, onStatus }: { getSnippet: () => string; onStatus: (message: string, ok: boolean) => void }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(getSnippet())
          .then(() => {
            setState('done');
            onStatus(t('配置已复制，粘贴到客户端的自定义 MCP 输入框。'), true);
            setTimeout(() => setState('idle'), 2500);
          })
          .catch(() => {
            setState('error');
            onStatus(t('复制失败，请手动选择配置文本。'), false);
          });
      }}
      style={{
        flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '4px 10px', border: '0.5px solid transparent', borderRadius: 5,
        background: state === 'error' ? theme.hover : `linear-gradient(135deg, ${theme.accent}, ${theme.accentDeep})`,
        boxShadow: state === 'error' ? 'none' : themeAlpha.shadow(0.25),
        color: state === 'error' ? theme.danger : theme.onAccent,
        fontSize: 11, fontWeight: 600, cursor: 'pointer',
      }}
    >
      <Icon name={state === 'done' ? 'check' : 'copy'} size={11} />
      {state === 'done' ? t('已复制') : t('复制配置')}
    </button>
  );
}

const cardStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  background: theme.panelAlt, border: `0.5px solid ${theme.borderLight}`,
  borderRadius: 8, padding: '10px 12px',
};

const endpointStyle: React.CSSProperties = {
  margin: 0, padding: '6px 9px', border: `0.5px solid ${theme.borderLight}`, borderRadius: 4,
  background: theme.inset, color: theme.textMuted, fontSize: 11.5, lineHeight: 1.5,
  fontFamily: 'Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'nowrap', overflowX: 'auto', userSelect: 'text',
};

/** Pretty-printed connect JSON: wraps instead of scrolling sideways. */
const snippetStyle: React.CSSProperties = {
  ...endpointStyle,
  margin: 0, whiteSpace: 'pre-wrap', overflowX: 'visible',
};

/** The paste-in config for the clients that keep no writable JSON file. */
function pasteSnippet(client: ClientSnippet['client'], endpoint: string, token: string): string {
  return client === 'opencode' ? openCodeConnectJson(endpoint, token) : qwenWorkConnectJson(endpoint, token);
}

export function McpGuideDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const endpoint = `${window.location.origin}/api/external-mcp/mcp`;
  const [mcpToken, setMcpToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState(false);
  const [connectStatus, setConnectStatus] = useState<Record<string, { message: string; ok: boolean }>>({});
  const [clientState, setClientState] = useState<Record<string, ClientConnectionState>>({});
  useEffect(() => {
    let active = true;
    void editorBootstrapInfo().then(
      (info) => { if (active) setMcpToken(info.mcpToken); },
      () => { if (active) setTokenError(true); },
    );
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    void fetchClientStatus().then((map) => { if (active) setClientState(map); });
    return () => { active = false; };
  }, []);
  const refreshClientState = (): void => {
    void fetchClientStatus().then(setClientState);
  };
  return (
    <div className="cc-modal-backdrop" onPointerDown={onClose}>
      <div
        className="cc-modal"
        style={{ width: 600, gap: 12, maxHeight: 'calc(100vh - 64px)', overflowY: 'auto' }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            aria-hidden
            style={{
              width: 36, height: 36, borderRadius: 10, flex: '0 0 auto',
              background: `linear-gradient(135deg, ${theme.accent}, ${theme.accentDeep})`,
              boxShadow: themeAlpha.shadow(0.35),
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: theme.onAccent,
            }}
          >
            <Icon name="plug" size={18} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <strong style={{ fontSize: 14 }}>{t('外部 Agent 接入 (MCP)')}</strong>
            <span style={{ color: theme.textMuted, fontSize: 11.5 }}>
              {t('Streamable HTTP · 与内置 Agent 共享编辑工具')}
            </span>
          </div>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', padding: '3px 9px' }}>{t('关闭')}</button>
        </div>

        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{t('端点地址')}</span>
            <span style={{ color: theme.textMuted, fontSize: 11.5 }}>{t('所有客户端共用一个端点')}</span>
          </div>
          <pre style={endpointStyle}>{endpoint}</pre>
        </div>

        {mcpToken ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {clientSnippets().map((snippet) => {
              const state = clientState[snippet.client];
              const configured = state === 'configured';
              return (
                <div key={snippet.name} style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {snippet.logo}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{t(snippet.name)}</span>
                      <span style={{ color: theme.textMuted, fontSize: 11.5 }}>{t(snippet.desc)}</span>
                    </div>
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ConnectionBadge state={state} />
                      {snippet.mode === 'connect' ? (
                        <ConnectButton
                          client={snippet.client}
                          configured={configured}
                          onStatus={(message, ok) => setConnectStatus((prev) => ({ ...prev, [snippet.client]: { message, ok } }))}
                          onConnected={refreshClientState}
                        />
                      ) : (
                        <CopySnippetButton
                          getSnippet={() => pasteSnippet(snippet.client, endpoint, mcpToken)}
                          onStatus={(message, ok) => setConnectStatus((prev) => ({ ...prev, [snippet.client]: { message, ok } }))}
                        />
                      )}
                    </div>
                  </div>
                  {snippet.mode === 'paste' ? <pre style={snippetStyle}>{pasteSnippet(snippet.client, endpoint, mcpToken)}</pre> : null}
                  {connectStatus[snippet.client]?.message ? (
                    <div style={{ color: connectStatus[snippet.client].ok ? theme.accent : theme.danger, fontSize: 11 }}>
                      {connectStatus[snippet.client].message}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <div style={{ color: theme.textDim, fontSize: 11 }}>
              {t('连接后重启对应客户端生效；Codex 需新开终端使环境变量生效。')}
            </div>
          </div>
        ) : (
          <div style={{ color: tokenError ? theme.danger : theme.textMuted, fontSize: 12 }}>
            {tokenError ? t('无法读取 MCP 连接令牌，请从受信任的编辑器窗口重试。') : t('正在读取 MCP 连接令牌…')}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={cardStyle}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{t('内置 Agent 与外部 MCP')}</span>
            <div style={{ color: theme.textMuted, fontSize: 12, lineHeight: 1.55 }}>
              {t('内置 Agent 会先生成可预览的修改提案，由你应用或拒绝；外部 MCP 使用独立编辑会话，manual 模式等待审核，auto 模式在 review 时直接应用。两者都只通过 EditorCore 命令修改工程。')}
            </div>
          </div>
          <div style={cardStyle}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{t('连接本地模型')}</span>
            <div style={{ color: theme.textMuted, fontSize: 12, lineHeight: 1.55 }}>
              {t('打开 设置 → Agent 模型 → Agent 大脑 → OpenAI，填写本地或兼容服务的 API URL 和模型；按服务选择 Responses API 或 Chat Completions API，再点“测试并读取模型”。仅在服务要求时填写 API Key。')}
            </div>
          </div>
        </div>

        <div style={{ color: theme.textDim, fontSize: 11.5, lineHeight: 1.55, borderTop: `0.5px solid ${theme.borderLight}`, paddingTop: 8 }}>
          {t('MCP 端点始终要求 Bearer 令牌。令牌在首次启动时生成并保存在本机，重启后保持不变，配置一次即可持续使用；OPENCHATCUT_MCP_TOKEN 环境变量可覆盖。令牌只在当前受信任编辑器会话中显示，不写入工程、聊天或浏览器存储。')}
        </div>
      </div>
    </div>
  );
}
