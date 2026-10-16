/**
 * HTTP API for the consultation backend.
 *
 *   POST /v1/consultations                 { "complaint": "..." }  → start
 *   POST /v1/consultations/:id/answers     { "text": "..." }       → answer the pending question
 *   GET  /v1/consultations/:id                                      → current state
 *   GET  /healthz                                                    → liveness (no auth)
 *   GET  /                                                           → demo chat page (no auth; its API calls need a key)
 *
 * Every /v1 call needs `Authorization: Bearer <API key>`. A consultation is
 * visible only to the key that created it. Patient text is never logged.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { DEMO_PAGE } from "./page";
import { ConflictError, NotFoundError, type ConsultationService } from "./service";
import { ApiKeyAuth, RateLimiter } from "./security";

const MAX_BODY_BYTES = 8 * 1024;
const startSchema = z.object({ complaint: z.string().trim().min(2).max(500) });
const answerSchema = z.object({ text: z.string().trim().min(1).max(500) });

export interface ServerOptions {
  service: ConsultationService;
  apiKeys: string[];
  ratePerMinute: number;
  dailyConsultations: number;
  log?: (line: string) => void;
  now?: () => number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? "Invalid body");
  return r.data;
}

export function createApiServer(opts: ServerOptions): Server {
  const auth = new ApiKeyAuth(opts.apiKeys);
  const limiter = new RateLimiter(opts.ratePerMinute, 60_000, opts.now);
  const daily = new RateLimiter(opts.dailyConsultations, 24 * 3600_000, opts.now);
  const log = opts.log ?? ((line: string) => console.log(line));

  return createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    let status = 500;
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        status = 200;
        return send(res, 200, { ok: true, model: opts.service.modelKind });
      }
      if (req.method === "GET" && url.pathname === "/") {
        // The demo page is static; it calls the API below with the caller's key.
        status = 200;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(DEMO_PAGE);
      }
      const caller = auth.verify(req.headers.authorization);
      if (!caller) throw new HttpError(401, "Missing or invalid API key");
      if (!limiter.allow(caller)) throw new HttpError(429, "Too many requests, slow down");

      const m = /^\/v1\/consultations(?:\/([0-9a-f-]{36})(\/answers)?)?$/.exec(url.pathname);
      if (!m) throw new HttpError(404, "Not found");
      const [, id, answers] = m;

      if (req.method === "POST" && !id) {
        const { complaint } = parse(startSchema, await readJson(req));
        if (!daily.allow(caller)) throw new HttpError(429, "Daily consultation limit reached for this key");
        const created = await opts.service.start(complaint, caller);
        status = 201;
        return send(res, 201, created);
      }
      if (req.method === "POST" && id && answers) {
        const { text } = parse(answerSchema, await readJson(req));
        const answered = await opts.service.answer(id, text, caller);
        status = 200;
        return send(res, 200, answered);
      }
      if (req.method === "GET" && id && !answers) {
        const found = await opts.service.get(id, caller);
        status = 200;
        return send(res, 200, found);
      }
      throw new HttpError(405, "Method not allowed");
    } catch (err) {
      if (err instanceof HttpError) status = err.status;
      else if (err instanceof NotFoundError) status = 404;
      else if (err instanceof ConflictError) status = 409;
      const message =
        status === 500 ? "Internal error" : status === 404 && err instanceof NotFoundError ? "Consultation not found" : (err as Error).message;
      if (status === 500) log(`error ${(err as Error).message}`);
      return send(res, status, { error: message });
    } finally {
      log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    }
  });
}
