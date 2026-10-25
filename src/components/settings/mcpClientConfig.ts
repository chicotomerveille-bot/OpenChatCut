// MCP config snippets for clients OpenChatCut cannot safely write to disk.
// 千问办公 keeps custom servers only in its own connector store (added by pasting
// JSON in the app), so this is the one shape its import accepts. OpenCode keeps
// its config in JSONC, where a JSON round-trip would delete the user's comments,
// so it gets a snippet to merge into the `mcp` object instead.
const QWEN_WORK_SERVER_TYPE = 'streamable-http';

export function qwenWorkMcpConfig(endpoint: string, token: string): { mcpServers: Record<string, Record<string, unknown>> } {
  return {
    mcpServers: {
      openchatcut: {
        type: QWEN_WORK_SERVER_TYPE,
        url: endpoint,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

export function qwenWorkConnectJson(endpoint: string, token: string): string {
  return JSON.stringify(qwenWorkMcpConfig(endpoint, token), null, 2);
}

/** The `mcp.openchatcut` entry OpenCode expects, wrapped so it can be pasted
 *  into an existing `mcp` object verbatim. */
export function openCodeMcpConfig(endpoint: string, token: string): { mcp: { openchatcut: Record<string, unknown> } } {
  return {
    mcp: {
      openchatcut: {
        type: 'remote',
        url: endpoint,
        headers: { Authorization: `Bearer ${token}` },
        enabled: true,
      },
    },
  };
}

export function openCodeConnectJson(endpoint: string, token: string): string {
  return JSON.stringify(openCodeMcpConfig(endpoint, token), null, 2);
}
