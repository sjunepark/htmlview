import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const fixtureRoot = path.resolve(fileURLToPath(new URL("fixtures/root/", import.meta.url)));
export const entryPath = path.join(fixtureRoot, "pages", "report space ü.html");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
]);

export async function listenFixture({
  bindHost = "127.0.0.1",
  urlHost = bindHost,
  port = 0,
  label = "fixture",
} = {}) {
  const hits = new Map();
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
    hits.set(requestUrl.pathname, (hits.get(requestUrl.pathname) ?? 0) + 1);

    if (requestUrl.pathname === "/state.html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("<!doctype html><title>state fixture</title>");
      return;
    }

    if (requestUrl.pathname === "/cache.txt") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=3600",
      });
      response.end(label);
      return;
    }

    if (requestUrl.pathname === "/sw.js") {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "service-worker-allowed": "/",
      });
      response.end(`self.addEventListener("fetch", event => {
        if (new URL(event.request.url).pathname === "/sw-probe") {
          event.respondWith(new Response(${JSON.stringify(label)}, { headers: { "content-type": "text/plain" } }));
        }
      });`);
      return;
    }

    if (requestUrl.pathname === "/sw-probe") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(`network:${label}`);
      return;
    }

    let decoded;
    try {
      decoded = decodeURIComponent(requestUrl.pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const target = path.join(fixtureRoot, decoded);
    if (!target.startsWith(`${fixtureRoot}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }

    try {
      const body = await readFile(target);
      response.writeHead(200, {
        "content-type": contentTypes.get(path.extname(target)) ?? "application/octet-stream",
        "content-length": body.length,
        "cache-control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: bindHost, port }, resolve);
  });
  const address = server.address();
  return {
    bindHost,
    urlHost,
    port: address.port,
    origin: `http://${urlHost}:${address.port}`,
    hits,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

export function encodedEntryPath() {
  return "/pages/report%20space%20%C3%BC.html";
}
