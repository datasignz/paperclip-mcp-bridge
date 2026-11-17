import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3000);
const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN || "";
const NEURALNEXT_API_URL = (process.env.NEURALNEXT_API_URL || "").replace(/\/$/, "");
const APPROVAL_SUBMIT_KEY = process.env.APPROVAL_SUBMIT_KEY || "";

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function authorized(req) {
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  return MCP_ACCESS_TOKEN && safeEqual(supplied, MCP_ACCESS_TOKEN);
}

function createMcpServer() {
  const server = new McpServer({
    name: "neuralnext-approval-bridge",
    version: "1.0.0"
  });

  server.registerTool(
    "submit_content_for_human_approval",
    {
      title: "Submit content for human approval",
      description: "Submit social content metadata and public HTTPS media URLs to the existing NeuralNext approval queue. This tool never publishes content and cannot approve or bypass human review.",
      inputSchema: {
        client_name: z.enum(["Datasignz CreativeMinds", "De Sportwekker", "CleviaStudios"]).default("Datasignz CreativeMinds"),
        user: z.string().min(1).max(200),
        platforms: z.array(z.string().min(1)).min(1),
        caption: z.string().max(5000).default(""),
        media_urls: z.array(z.string().url()).max(20).optional(),
        video_url: z.string().url().optional(),
        scheduled_date: z.string().optional(),
        timezone: z.string().default("America/Paramaribo"),
        extra_fields: z.record(z.unknown()).optional(),
        request_id: z.string().max(200).optional()
      }
    },
    async (input) => {
      if (!NEURALNEXT_API_URL || !APPROVAL_SUBMIT_KEY) {
        throw new Error("Bridge is not configured: missing NeuralNext API URL or approval submit key.");
      }
      const hasPhotos = Array.isArray(input.media_urls) && input.media_urls.length > 0;
      const hasVideo = Boolean(input.video_url);
      if (hasPhotos === hasVideo) {
        throw new Error("Provide either media_urls (photos) or video_url (video), but not both.");
      }
      if (input.platforms.some(p => p.toLowerCase() === "youtube") && !hasVideo) {
        throw new Error("YouTube submissions require video_url.");
      }
      if (input.platforms.some(p => p.toLowerCase() === "youtube") && !input.caption.trim()) {
        throw new Error("YouTube submissions require a non-empty title/caption.");
      }

      const response = await fetch(`${NEURALNEXT_API_URL}/api/approval/submit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${APPROVAL_SUBMIT_KEY}`
        },
        body: JSON.stringify({
          client_name: input.client_name,
          user: input.user,
          platforms: input.platforms,
          caption: input.caption,
          media_urls: input.media_urls || [],
          video_url: input.video_url || null,
          scheduled_date: input.scheduled_date || null,
          timezone: input.timezone,
          extra_fields: input.extra_fields || {},
          request_id: input.request_id || randomUUID()
        })
      });

      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = { response: raw.slice(0, 1000) }; }
      if (!response.ok) {
        throw new Error(`NeuralNext API returned HTTP ${response.status}: ${data.error || "Submission failed"}`);
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            submitted: true,
            human_approval_required: true,
            published: false,
            result: data
          }, null, 2)
        }]
      };
    }
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  let pathname = (req.url || "/").split("?")[0];
  while (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  if ((pathname === "/" || pathname === "/health") && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "neuralnext-paperclip-mcp-bridge" }));
    return;
  }

  if (pathname !== "/mcp") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (!authorized(req)) {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end("Method not allowed");
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  let parsed;
  try { parsed = body ? JSON.parse(body) : {}; }
  catch {
    res.writeHead(400);
    res.end("Invalid JSON");
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  const server = createMcpServer();

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "MCP request failed" }));
    }
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`NeuralNext MCP bridge listening on ${PORT}`);
});
