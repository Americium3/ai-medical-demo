/**
 * HTTP API for the consultation backend.
 *
 *   POST /v1/consultations                 { "complaint": "..." }  → start
 *   POST /v1/consultations/:id/answers     { "text": "..." }       → answer the pending question
 *   POST /v1/consultations/:id/retry                                → resume a failed consultation
 *   GET  /v1/consultations/:id                                      → current state
 *   GET  /healthz                                                    → liveness (no auth)
 *   GET  /readyz                                                     → readiness: database and Redis reachable, not shutting down (no auth)
 *   GET  /                                                           → demo chat page (no auth; its API calls need a key)
 *
 * A model failure (Bedrock still failing after its retries) answers
 * 502 { error, retryable: true, id }: the consultation is saved as "failed"
 * and POST …/retry resumes it from the failed step.
 *
 * Every /v1 call needs `Authorization: Bearer <API key>`. A consultation is
 * visible only to the key that created it. Patient text is never logged.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { DEMO_PAGE } from "./page";
import { ConflictError, ModelFailureError, NotFoundError, type ConsultationService } from "./service";
import { ApiKeyAuth, InMemoryRateLimiter, type RateLimiter } from "./security";

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
  /** Shared (Redis) limiters for several instances; in-memory ones by default. */
  limiters?: { perMinute: RateLimiter; daily: RateLimiter };
  /** Throws if a dependency (database, Redis) is unreachable; backs /readyz. */
  ready?: () => Promise<void>;
}

/** Servers that are shutting down: /readyz answers 503 so the load balancer stops sending traffic. */
const draining = new WeakSet<Server>();

/**
 * Graceful shutdown: report not-ready, stop accepting connections, let
 * in-flight requests finish, and force-close whatever is left after `timeoutMs`.
 */
export function drain(server: Server, timeoutMs: number): Promise<void> {
  draining.add(server);
  return new Promise((resolve) => {
    const force = setTimeout(() => server.closeAllConnections(), timeoutMs);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
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
  const limiter = opts.limiters?.perMinute ?? new InMemoryRateLimiter(opts.ratePerMinute, 60_000, opts.now);
  const daily = opts.limiters?.daily ?? new InMemoryRateLimiter(opts.dailyConsultations, 24 * 3600_000, opts.now);
  const log = opts.log ?? ((line: string) => console.log(line));

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    let status = 500;
    // A client that disconnects before its response is sent cancels the run (#7).
    const cancel = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) cancel.abort(new Error("client disconnected"));
    });
    // While shutting down, close each connection once its response is sent.
    if (draining.has(server)) res.setHeader("connection", "close");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        status = 200;
        return send(res, 200, { ok: true, model: opts.service.modelKind });
      }
      if (req.method === "GET" && url.pathname === "/readyz") {
        let ready = !draining.has(server);
        if (ready && opts.ready) {
          try {
            await opts.ready();
          } catch (err) {
            ready = false;
            log(`not ready: ${(err as Error).message}`);
          }
        }
        status = ready ? 200 : 503;
        return send(res, status, { ready });
      }
      if (req.method === "GET" && url.pathname === "/") {
        // The demo page is static; it calls the API below with the caller's key.
        status = 200;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(DEMO_PAGE);
      }
      const caller = auth.verify(req.headers.authorization);
      if (!caller) throw new HttpError(401, "Missing or invalid API key");
      if (!(await limiter.allow(caller))) throw new HttpError(429, "Too many requests, slow down");

      const m = /^\/v1\/consultations(?:\/([0-9a-f-]{36})(?:\/(answers|retry))?)?$/.exec(url.pathname);
      if (!m) throw new HttpError(404, "Not found");
      const [, id, action] = m;
      const answers = action === "answers";

      if (req.method === "POST" && !id) {
        const { complaint } = parse(startSchema, await readJson(req));
        if (!(await daily.allow(caller))) throw new HttpError(429, "Daily consultation limit reached for this key");
        const created = await opts.service.start(complaint, caller, cancel.signal);
        status = 201;
        return send(res, 201, created);
      }
      if (req.method === "POST" && id && answers) {
        const { text } = parse(answerSchema, await readJson(req));
        const answered = await opts.service.answer(id, text, caller, cancel.signal);
        status = 200;
        return send(res, 200, answered);
      }
      if (req.method === "POST" && id && action === "retry") {
        const retried = await opts.service.retry(id, caller, cancel.signal);
        status = 200;
        return send(res, 200, retried);
      }
      if (req.method === "GET" && id && !action) {
        const found = await opts.service.get(id, caller);
        status = 200;
        return send(res, 200, found);
      }
      throw new HttpError(405, "Method not allowed");
    } catch (err) {
      if (err instanceof ModelFailureError) {
        status = 502;
        log(`model failure ${err.cause.task}`);
        return send(res, 502, {
          error: `Model call failed at step "${err.cause.task}". The consultation is saved; POST /v1/consultations/${err.id}/retry to resume.`,
          retryable: true,
          id: err.id,
        });
      }
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
  return server;
}
