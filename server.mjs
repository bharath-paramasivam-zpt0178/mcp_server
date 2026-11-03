import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const VALIDATE_URL = "https://mvp-10106925075.development.catalystappsail.com/oas/validate";
const requestContext = new AsyncLocalStorage();

const PORT = Number(process.env.MCP_PORT || 4111);
const CATALOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "catalog");

function toZod(schema) {
  if (!schema || typeof schema !== "object") return z.any();
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((value) => typeof value === "string")) {
    return z.enum(schema.enum);
  }
  const type = schema.type;
  if (type === "string") return schema.description ? z.string().describe(schema.description) : z.string();
  if (type === "integer") return z.number().int();
  if (type === "number") return z.number();
  if (type === "boolean") return z.boolean();
  if (type === "array") return z.array(toZod(schema.items || {}));
  if (type === "object" || schema.properties) {
    const required = new Set(schema.required || []);
    const shape = {};
    for (const [key, property] of Object.entries(schema.properties || {})) {
      const field = toZod(property);
      shape[key] = required.has(key) ? field : field.optional();
    }
    return z.object(shape);
  }
  return z.any();
}

function loadCatalog() {
  const tools = [];
  for (const fileName of fs.readdirSync(CATALOG_DIR).filter((name) => name.endsWith(".json")).sort()) {
    const document = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, fileName), "utf8"));
    for (const [name, tool] of Object.entries(document)) {
      const spec = tool.tool_spec?.tool || {};
      tools.push({
        name,
        method: tool.method,
        path: tool.path,
        scope: tool.scope || [],
        inputSchema: spec.inputSchema || { type: "object", properties: {} }
      });
    }
  }
  return tools;
}

function editionFor(name) {
  if (name.endsWith("IN")) return "IN";
  if (name.endsWith("US")) return "US";
  return process.env.ZOHO_PAYMENTS_EDITION || "IN";
}

function baseUrl(edition) {
  if (process.env.ZOHO_PAYMENTS_BASE_URL) return process.env.ZOHO_PAYMENTS_BASE_URL;
  if (edition === "IN" && process.env.ZOHO_PAYMENTS_IN_BASE_URL) return process.env.ZOHO_PAYMENTS_IN_BASE_URL;
  if (edition === "US" && process.env.ZOHO_PAYMENTS_US_BASE_URL) return process.env.ZOHO_PAYMENTS_US_BASE_URL;
  if (process.env.ZOHO_PAYMENTS_DEV === "1") return "https://localhost.csez.zohocorpin.com:8443/api/v1";
  return edition === "IN" ? "https://localhost.csez.zohocorpin.com:8443/api/v1" : "https://pay.localzoho.com/api/v1";
}

function apiPath(toolPath, pathVariables) {
  const suffix = toolPath.replace(/^\/api\/v1/, "");
  return suffix.replace(/\{([^}]+)\}/g, (_, key) => {
    const value = pathVariables?.[key];
    if (value === undefined || value === null || value === "") {
      throw new Error(`path_variables.${key} is required`);
    }
    return encodeURIComponent(String(value));
  });
}

function tokenFromRequest(req) {
  const headerToken = req.headers["zoho_payments_token"] || req.headers["x-zoho-payments-token"];
  if (headerToken && String(headerToken).trim()) return String(headerToken).trim();
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^(?:Zoho-oauthtoken|Bearer)\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function currentToken() {
  return requestContext.getStore()?.token || process.env.ZOHO_PAYMENTS_TOKEN || "";
}

async function callPayments(tool, args) {
  const token = currentToken();
  const edition = editionFor(tool.name);
  const pathVariables = args.path_variables || {};
  const query = args.query_params || {};
  const requestPath = apiPath(tool.path, pathVariables);
  if (!token) {
    return {
      mode: "sample",
      message: "No Zoho Payments token is set. Add header ZOHO_PAYMENTS_TOKEN on the zoho-payments MCP connection, or start the server with ZOHO_PAYMENTS_TOKEN set.",
      tool: tool.name,
      method: tool.method,
      url: `${baseUrl(edition).replace(/\/$/, "")}${requestPath}`,
      scope: tool.scope,
      arguments: args
    };
  }

  const url = new URL(`${baseUrl(edition).replace(/\/$/, "")}${requestPath}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: tool.method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      ...(args.body ? { "Content-Type": "application/json" } : {})
    },
    body: args.body ? JSON.stringify(args.body) : undefined
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${body}`);
  return body ? JSON.parse(body) : { status: response.status };
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function createServer() {
  const server = new McpServer({ name: "zoho-payments", version: "1.0.0" });
  for (const tool of loadCatalog()) {
    const properties = tool.inputSchema.properties || {};
    const inputSchema = {};
    for (const [key, property] of Object.entries(properties)) {
      inputSchema[key] = toZod(property);
    }
    const description = `${tool.method} ${tool.path}. Scope: ${(tool.scope || []).join(", ") || "none"}.`;
    server.registerTool(tool.name, {
      description,
      inputSchema
    }, async (args) => textResult(await callPayments(tool, args)));
  }
  return server;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname !== "/mcp") {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "MCP endpoint is /mcp" }));
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    let parsedBody;
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      parsedBody = raw ? JSON.parse(raw) : undefined;
    }
    const token = tokenFromRequest(req);
    await requestContext.run({ token }, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    });
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: error.message || "Internal error" }));
    }
  }
});

async function validateOas() {
  const repoRoot = path.resolve(CATALOG_DIR, "../..");
  const folder = path.join(repoRoot, "ZohoPayments");
  if (!fs.existsSync(folder)) throw new Error(`OAS folder not found: ${folder}`);

  const zipPath = path.join(os.tmpdir(), "zohopayments-oas-validate.zip");
  fs.rmSync(zipPath, { force: true });
  await execFileAsync("zip", ["-r", "-X", zipPath, "ZohoPayments", "-x", "*.DS_Store"], { cwd: repoRoot });

  const form = new FormData();
  form.append("service_name", "ZohoPayments");
  form.append("file", new Blob([fs.readFileSync(zipPath)]), "archive.zip");

  const response = await fetch(VALIDATE_URL, { method: "POST", body: form });
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (!response.ok || parsed?.status !== "success") {
    throw new Error(parsed?.message || body || `OAS validation failed with HTTP ${response.status}`);
  }
  console.log(parsed.message);
  if (parsed.link || parsed.download_url || parsed.url) {
    console.log(parsed.link || parsed.download_url || parsed.url);
  }
}

const tools = loadCatalog();
validateOas().then(() => {
  httpServer.listen(PORT, "127.0.0.1", () => {
    console.log(`Zoho Payments MCP server listening at http://127.0.0.1:${PORT}/mcp (${tools.length} tools)`);
  });
}).catch((error) => {
  console.error(`OAS validation failed. MCP server was not started. ${error.message}`);
  process.exit(1);
});
