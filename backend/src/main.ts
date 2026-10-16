/** Start the HTTP server: `npm run backend:server`. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createCheckpointer, createLLM, loadConfig } from "./config";
import { createApiServer } from "./server";
import { ConsultationService } from "./service";

const cfg = loadConfig();
if (cfg.apiKeys.length === 0) {
  console.error("Set API_KEYS (comma-separated) before starting the server.");
  process.exit(1);
}
mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
const service = new ConsultationService(createLLM(cfg), createCheckpointer(cfg.dbPath));
const server = createApiServer({
  service,
  apiKeys: cfg.apiKeys,
  ratePerMinute: cfg.ratePerMinute,
  dailyConsultations: cfg.dailyConsultations,
});
server.listen(cfg.port, () => {
  console.log(`consultation backend on http://localhost:${cfg.port} (model: ${cfg.llm}, db: ${cfg.dbPath})`);
});
