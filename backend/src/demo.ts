/**
 * One-command local demo: `npm run demo`.
 *
 * Starts the backend on http://localhost:8787 with a fresh random API key and
 * opens the demo page in the browser. Uses AWS Bedrock when
 * BEDROCK_ACCESS_KEY_ID and BEDROCK_SECRET_ACCESS_KEY are set, or when they
 * are typed in at the prompt; press Enter at the prompt for offline mode.
 * Keys typed here are kept in memory only.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { createCheckpointer, createLLM, createTracer, loadConfig } from "./config";
import { createApiServer } from "./server";
import { ConsultationService } from "./service";

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Echo nothing while the secret is typed.
      const out = rl as unknown as { _writeToOutput: (s: string) => void };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stdout.write(s);
      };
    }
    rl.question(question, (answer) => {
      if (hidden) process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
  cmd.on("error", () => {});
  cmd.unref();
}

async function main() {
  const env = { ...process.env };
  if (!env.BEDROCK_ACCESS_KEY_ID || !env.BEDROCK_SECRET_ACCESS_KEY) {
    console.log("AWS Bedrock keys (from the company account). Press Enter to skip and use the offline stand-in model.");
    const id = await ask("  Access key ID: ");
    if (id) {
      env.BEDROCK_ACCESS_KEY_ID = id;
      env.BEDROCK_SECRET_ACCESS_KEY = await ask("  Secret access key (hidden): ", true);
    }
  }
  env.AGENT_LLM = env.BEDROCK_ACCESS_KEY_ID && env.BEDROCK_SECRET_ACCESS_KEY ? "bedrock" : "mock";
  const apiKey = randomBytes(18).toString("base64url");
  env.API_KEYS = apiKey;

  const cfg = loadConfig(env);
  mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const service = new ConsultationService(createLLM(cfg), createCheckpointer(cfg.dbPath), undefined, createTracer(cfg));
  const server = createApiServer({ service, apiKeys: cfg.apiKeys, ratePerMinute: cfg.ratePerMinute, dailyConsultations: cfg.dailyConsultations });

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "EADDRINUSE" ? `Port ${cfg.port} is busy. Close the other program or set PORT=8788.` : err.message);
    process.exit(1);
  });
  server.listen(cfg.port, "127.0.0.1", () => {
    const url = `http://localhost:${cfg.port}/#key=${apiKey}`;
    console.log("");
    console.log(`  Model:   ${cfg.llm === "bedrock" ? `AWS Bedrock (${cfg.region}: ${cfg.fastModelId}, ${cfg.smartModelId})` : "offline stand-in (keyword matching)"}`);
    console.log(`  Open:    ${url}`);
    console.log(`  API key: ${apiKey}  (new each start; only this machine can connect)`);
    console.log("  Stop:    Ctrl+C");
    console.log("");
    openBrowser(url);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
