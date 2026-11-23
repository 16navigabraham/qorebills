import fs from "node:fs";
import http from "node:http";

const PAGES = {
  approve: fs.readFileSync(new URL("../public/approve.html", import.meta.url), "utf8"),
  setup: fs.readFileSync(new URL("../public/setup.html", import.meta.url), "utf8"),
};
const SCRIPT = fs.readFileSync(new URL("../public/qorex.js", import.meta.url), "utf8");
const ID = /^[0-9a-f]{32}$/;
const MAX_BODY = 64 * 1024; // an ML-DSA-87 signature is about 6 KB in base64

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    // Past the limit, keep draining without storing so the client still gets the 413.
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
      else if (size > 16 * MAX_BODY) req.destroy(); // far too big: stop reading
    });
    req.on("end", () => {
      if (size > MAX_BODY) reject(Object.assign(new Error("Body too large"), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJson(req, res) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    json(res, 415, { error: "Send JSON." });
    return null;
  }
  try {
    return JSON.parse(await readBody(req));
  } catch (error) {
    json(res, error.status || 400, { error: error.status ? "Too large." : "Invalid JSON." });
    return null;
  }
}

const reply = (res, result) =>
  json(res, result.ok ? 200 : result.status, result.ok ? { ...result, ok: true } : { error: result.error });

/** The signing pages and their API. Request ids are random 128-bit values. */
export function createWebServer({ agent, log = console }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/qorex.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
        return res.end(SCRIPT);
      }
      if (req.method === "GET" && PAGES[parts[0]] && ID.test(parts[1] || "") && parts.length === 2) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
        });
        return res.end(PAGES[parts[0]]);
      }
      if (parts[0] === "api" && parts[1] === "requests" && ID.test(parts[2] || "")) {
        const id = parts[2];
        if (req.method === "GET" && parts.length === 3) {
          const request = agent.getRequest(id);
          return request ? json(res, 200, request) : json(res, 404, { error: "Unknown request." });
        }
        if (req.method === "POST" && parts.length === 4 && parts[3] === "draft") {
          const body = await readJson(req, res);
          return body && reply(res, await agent.draftSetup(id, body));
        }
        if (req.method === "POST" && parts.length === 4 && parts[3] === "sign") {
          const body = await readJson(req, res);
          return body && reply(res, await agent.submitSignature(id, body.signature));
        }
      }
      json(res, 404, { error: "Not found." });
    } catch (error) {
      log.error?.("[web] failed:", error.message);
      if (!res.headersSent) json(res, 500, { error: "Server error." });
    }
  });
}
