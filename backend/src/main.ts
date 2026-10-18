/** Start the HTTP server: `npm run backend:server`. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createCheckpointer, createLLM, createTracer, loadConfig } from "./config";
import { createApiServer } from "./server";
import { ConsultationService } from "./service";

const cfg = loadConfig();
if (cfg.apiKeys.length === 0) {
  console.error("Set API_KEYS (comma-separated) before starting the server.");
  process.exit(1);
}
mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
const tracer = createTracer(cfg);
const service = new ConsultationService(createLLM(cfg), createCheckpointer(cfg.dbPath), undefined, tracer, { phrasing: cfg.phrasing });
const server = createApiServer({
  service,
  apiKeys: cfg.apiKeys,
  ratePerMinute: cfg.ratePerMinute,
  dailyConsultations: cfg.dailyConsultations,
});
server.listen(cfg.port, () => {
  console.log(`consultation backend on http://localhost:${cfg.port} (model: ${cfg.llm}, db: ${cfg.dbPath})`);
});

// Send any batched Langfuse spans before exiting.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void (tracer?.shutdown() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
