import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The web-search skill calls these vendor MCP servers from codemode scripts,
// which filter large results before they reach the conversation. Each server is
// hidden except for the one tool the skill uses, so tools a vendor adds later
// stay unreachable, including Perplexity's per-token Agent API tools.
export default function webSearch(pi: ExtensionAPI): void {
  pi.registerMcpServer("perplexity", {
    url: "https://api.perplexity.ai/mcp",
    // Pi resolves ${NAME} header values from the environment when it connects.
    headers: { Authorization: "Bearer ${PERPLEXITY_API_KEY}" },
    description: "Web search through the Perplexity Search API",
    exposure: "hidden",
    toolExposure: { perplexity_search: "codemode" },
  });

  pi.registerMcpServer("exa", {
    url: "https://mcp.exa.ai/mcp",
    headers: { "x-api-key": "${EXA_API_KEY}" },
    description: "Read known URLs as Markdown through Exa",
    exposure: "hidden",
    toolExposure: { web_fetch_exa: "codemode" },
  });
}
