import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openSession } from "./session.mjs";

const ASSETS = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.mjs": "app.mjs",
  "/styles.css": "styles.css",
};
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
async function body(req) {
  if (
    req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new HttpError(
      415,
      "unsupported-content-type",
      "Use application/json.",
    );
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384)
      throw new HttpError(
        413,
        "body-too-large",
        "Request body exceeds 16 KiB.",
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid-json", "Malformed JSON body.");
  }
}
export function createApp({
  session,
  assetsDirectory = fileURLToPath(new URL("../web/", import.meta.url)),
}) {
  return http.createServer(async (req, res) => {
    try {
      const route = req.url?.split("?")[0];
      if (
        !route ||
        route.includes("%") ||
        route.includes("\\") ||
        route.includes("..") ||
        route.startsWith("//")
      )
        throw new HttpError(404, "not-found", "Route not found.");
      const api = ["/api/board", "/api/refresh", "/api/actions"].includes(
          route,
        ),
        asset = Object.hasOwn(ASSETS, route);
      if (!api && !asset)
        throw new HttpError(404, "not-found", "Route not found.");
      const method = asset || route === "/api/board" ? "GET" : "POST";
      if (req.method !== method)
        throw new HttpError(405, "method-not-allowed", "Method not allowed.");
      if (method === "POST") {
        const local = `127.0.0.1:${req.socket.localPort}`;
        if (
          req.headers.host !== local ||
          (req.headers.origin !== undefined &&
            req.headers.origin !== `http://${local}`)
        )
          throw new HttpError(
            403,
            "foreign-origin",
            "Request origin is not this local application.",
          );
        const value = await body(req);
        if (route === "/api/refresh") {
          if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value)
          )
            throw new HttpError(
              422,
              "invalid-action",
              "Refresh body must be an object.",
            );
          session.refresh({ context: value.context === true });
          const board = session.getBoard();
          json(res, 202, {
            revision: board.revision,
            inFlight: board.connection.inFlight,
            retryAt: board.connection.retryAt,
          });
          return;
        }
        const board = await session.act(value);
        json(res, 200, board);
        return;
      }
      if (route === "/api/board") {
        json(res, 200, session.getBoard());
        return;
      }
      let bytes;
      try {
        bytes = await readFile(path.join(assetsDirectory, ASSETS[route]));
      } catch {
        throw new HttpError(404, "not-found", "Asset not found.");
      }
      res.writeHead(200, {
        "content-type": TYPES[path.extname(ASSETS[route])],
        "cache-control": "no-store",
      });
      res.end(bytes);
    } catch (error) {
      const known =
        Number.isInteger(error.status) &&
        [400, 403, 404, 405, 409, 413, 415, 422, 500].includes(error.status);
      json(res, known ? error.status : 500, {
        error: {
          code: known ? error.code : "internal-error",
          message: known
            ? error.message
            : "The request could not be completed.",
        },
        revision: session.getBoard().revision,
      });
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: { "data-dir": { type: "string" }, port: { type: "string" } },
  });
  const port = values.port === undefined ? 3000 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port.");
  const session = await openSession({ dataDir: values["data-dir"] });
  const app = createApp({ session });
  app.once("error", async () => {
    await session.close();
    process.exitCode = 1;
  });
  app.listen(port, "127.0.0.1", () =>
    console.log(`Draft assistant: http://127.0.0.1:${app.address().port}`),
  );
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    await session.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
