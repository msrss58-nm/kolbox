// Platform Stage 5 - a tiny local stand-in for a Vercel deployment: serves a
// built surface (static files + SPA fallback) and routes /api/* through
// vercel.json's OWN rewrite table to the REAL bundled handlers. Used by the
// UI suite so the browser exercises the exact public paths
// (/api/multi-entity/session) the deployed app will call.
//
// Rewrite emulation: exact-source match, destination path + destination query,
// with the caller's own query parameters appended - the behaviour the
// existing production rewrites (owner-session, __pu_action) already rely on
// (handlers read the destination query from req.url).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rewrites = JSON.parse(fs.readFileSync(path.join(repoRoot, "vercel.json"), "utf8")).rewrites;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function applyRewrite(pathname, search) {
  for (const r of rewrites) {
    if (r.source === "/(.*)") continue;
    if (r.source === pathname) {
      const dest = new URL(r.destination, "http://x");
      const extra = new URLSearchParams(search);
      for (const [k, v] of extra) dest.searchParams.append(k, v);
      return `${dest.pathname}${dest.search}`;
    }
  }
  return `${pathname}${search}`;
}

/** handlers: { "/api/platform/session": fn, "/api/health": fn } */
export function startLocalServer({ distDir, handlers, port }) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname.startsWith("/api/")) {
      const rewritten = applyRewrite(u.pathname, u.search);
      const target = handlers[rewritten.split("?")[0]];
      if (!target) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "NOT_FOUND" }));
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const headers = {};
      const vres = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          headers[String(name).toLowerCase()] = value;
          return this;
        },
        json(obj) {
          res.writeHead(this.statusCode, { ...headers, "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        },
        end() {
          res.writeHead(this.statusCode, headers);
          res.end();
        },
      };
      try {
        await target({ method: req.method, url: rewritten, headers: req.headers, body, cookies: {} }, vres);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "HANDLER_THREW" }));
        }
      }
      return;
    }
    let file = path.join(distDir, decodeURIComponent(u.pathname));
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(distDir, "index.html");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
