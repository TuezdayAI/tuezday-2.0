import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

const API_URL = process.env.TUEZDAY_API_URL || "http://localhost:3000/api/v1";
const API_KEY = process.env.TUEZDAY_API_KEY;

if (!API_KEY) {
  console.error("TUEZDAY_API_KEY environment variable is required");
  process.exit(1);
}

const server = new Server(
  {
    name: "tuezday-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

async function fetchApi(path: string, options: RequestInit = {}) {
  const url = `${API_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API Error ${response.status}: ${text}`);
  }

  if (response.status === 204) return null;

  return response.json();
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "submit-idea",
        description: "Submit a new marketing idea/signal to Tuezday",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The marketing idea or signal content",
            },
            source: {
              type: "string",
              description: "Source of the idea (e.g., 'mcp', 'other')",
              default: "other",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "list-drafts",
        description: "List drafts pending review",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "approve-draft",
        description: "Approve a marketing draft",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The ID of the draft to approve",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "reject-draft",
        description: "Reject a marketing draft",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The ID of the draft to reject",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "launch-campaign",
        description: "Launch a campaign (requires campaign configuration)",
        inputSchema: {
          type: "object",
          properties: {
            campaignId: {
              type: "string",
              description: "The ID of the campaign to launch",
            },
          },
          required: ["campaignId"],
        },
      },
      {
        name: "fetch-insights",
        description: "Fetch workspace marketing insights",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  try {
    switch (request.params.name) {
      case "submit-idea": {
        const { content, source = "other" } = request.params.arguments as any;
        const result = await fetchApi("/ideas", {
          method: "POST",
          body: JSON.stringify({ content, source }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "list-drafts": {
        const result = await fetchApi("/drafts");
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "approve-draft": {
        const { id } = request.params.arguments as any;
        const result = await fetchApi(`/drafts/${id}/approve`, {
          method: "POST",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "reject-draft": {
        const { id } = request.params.arguments as any;
        const result = await fetchApi(`/drafts/${id}/reject`, {
          method: "POST",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "launch-campaign": {
        const args = request.params.arguments as any;
        const result = await fetchApi("/launches", {
          method: "POST",
          body: JSON.stringify(args),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "fetch-insights": {
        const result = await fetchApi("/insights");
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: err.message }],
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Tuezday MCP Server running on stdio");
}

run().catch(console.error);
