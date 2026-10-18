/**
 * Node-level tracing with Langfuse (issue #9), shared by the backend service
 * and the Next.js /api/agent route.
 *
 * Off unless LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL are
 * all set. Patient text is sensitive, so self-hosting is the default story
 * (see backend/README.md) and every exported span goes through a mask:
 * - phone and ID-card numbers are always redacted;
 * - when the base URL is not localhost / a private address (and
 *   LANGFUSE_SELF_HOSTED is not "true"), every string value is redacted, so a
 *   hosted Langfuse sees graph structure, timings and token counts only.
 */
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export interface TracingOptions {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  /** Redact every string, not just phone/ID numbers. Defaults to true unless the base URL is self-hosted. */
  maskAllText: boolean;
  /** "immediate" for serverless (Vercel), "batched" for the long-running backend. */
  exportMode?: "immediate" | "batched";
  /** Injected in tests to capture spans instead of sending them. */
  exporter?: SpanExporter;
}

export interface Tracing {
  readonly maskAllText: boolean;
  /** A LangChain callback handler that tags every span of one run with `sessionId`. */
  handler(sessionId: string, metadata?: Record<string, unknown>): CallbackHandler;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const ID_CARD = /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g;

export function redactIdentifiers(text: string): string {
  return text.replace(ID_CARD, "[身份证号]").replace(PHONE, "[手机号]");
}

/** Mask applied to span input, output and metadata before export. */
export function maskData(data: unknown, maskAllText: boolean): unknown {
  if (typeof data === "string") {
    // Span payloads often arrive as serialized JSON; mask inside them too.
    if (maskAllText && /^\s*[[{]/.test(data)) {
      try {
        return JSON.stringify(maskData(JSON.parse(data), true));
      } catch {
        // not JSON: fall through
      }
    }
    return maskAllText ? `[已隐藏 ${data.length} 字]` : redactIdentifiers(data);
  }
  if (Array.isArray(data)) return data.map((d) => maskData(d, maskAllText));
  if (data && typeof data === "object") {
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, maskData(v, maskAllText)]));
  }
  return data;
}

/** localhost, private addresses and *.local / *.internal hosts count as self-hosted. */
export function isSelfHostedUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /\.(local|internal)$/.test(host)
  );
}

/** Read the LANGFUSE_* variables; null when tracing is not configured. */
export function tracingOptionsFromEnv(env: Record<string, string | undefined> = process.env): TracingOptions | null {
  const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: baseUrl } = env;
  if (!publicKey || !secretKey || !baseUrl) return null;
  const selfHosted = env.LANGFUSE_SELF_HOSTED === "true" || isSelfHostedUrl(baseUrl);
  return { publicKey, secretKey, baseUrl, maskAllText: !selfHosted };
}

export function createTracing(opts: TracingOptions): Tracing {
  const processor = new LangfuseSpanProcessor({
    publicKey: opts.publicKey,
    secretKey: opts.secretKey,
    baseUrl: opts.baseUrl,
    exportMode: opts.exportMode ?? "batched",
    exporter: opts.exporter,
    mask: ({ data }) => maskData(data, opts.maskAllText),
  });
  // The handler puts the session id on spans through OpenTelemetry context, which needs a context
  // manager. Register one only if nothing else has (setGlobalContextManager is a no-op then).
  const manager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(manager)) manager.disable();
  // An isolated provider: Langfuse spans do not mix with any global OpenTelemetry setup (Next has its own).
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  return {
    maskAllText: opts.maskAllText,
    handler: (sessionId, metadata = {}) =>
      new CallbackHandler({ sessionId, traceMetadata: { ...metadata, sessionId } }),
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
