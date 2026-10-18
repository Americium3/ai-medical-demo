/**
 * Command-line consultation.
 *
 *   npm run backend:cli                          # you play the patient, in-process
 *   npm run backend:cli -- --case cardio-001     # a simulated patient answers from a demo case
 *   npm run backend:cli -- --resume <id>         # continue a saved consultation
 *   npm run backend:cli -- --server http://localhost:8787 --key <API key>   # talk to the HTTP API
 *
 * In-session commands: /record shows the record table, /retry resumes after a
 * failed model call, /quit exits (progress is saved).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { MEDICAL_CASES } from "../../src/data/cases";
import { createCheckpointer, createLLM, createTracer, loadConfig } from "./config";
import { ConsultationService, ModelFailureError, type ConsultationView } from "./service";
import { slotsFor, TEMPLATES } from "./templates";

const { values: args } = parseArgs({
  options: {
    server: { type: "string" },
    key: { type: "string" },
    case: { type: "string" },
    resume: { type: "string" },
    trace: { type: "boolean", default: true },
  },
});

interface Backend {
  start(complaint: string): Promise<ConsultationView>;
  answer(id: string, text: string): Promise<ConsultationView>;
  get(id: string): Promise<ConsultationView>;
  retry(id: string): Promise<ConsultationView>;
  record?(id: string): Promise<string>;
  close?(): Promise<void>;
}

const OWNER = "cli";

function local(): Backend {
  const cfg = loadConfig();
  mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const tracer = createTracer(cfg);
  const service = new ConsultationService(createLLM(cfg), createCheckpointer(cfg.dbPath), undefined, tracer);
  console.log(`（本地运行，模型：${cfg.llm === "mock" ? "离线替身" : "AWS Bedrock"}，进度保存在 ${cfg.dbPath}）\n`);
  return {
    start: (c) => service.start(c, OWNER),
    answer: (id, t) => service.answer(id, t, OWNER),
    get: (id) => service.get(id, OWNER),
    retry: (id) => service.retry(id, OWNER),
    close: async () => tracer?.shutdown(),
    async record(id) {
      const s = await service.state(id);
      const t = TEMPLATES.find((x) => x.id === s.templateId);
      if (!t) return "（通用模板）";
      return slotsFor(t)
        .map((slot) => {
          const e = s.record[slot.id];
          const mark = e.status === "answered" ? `✔ ${e.value}` : e.status === "unknown" ? "？ 不清楚" : "· 未问";
          return `  ${slot.label}：${mark}`;
        })
        .join("\n");
    },
  };
}

class RetryableFailure extends Error {
  constructor(
    readonly id: string,
    message: string,
  ) {
    super(message);
  }
}

/** Run a step; on a model failure, return the saved (failed) consultation instead of throwing. */
async function orFailed(backend: Backend, step: Promise<ConsultationView>): Promise<ConsultationView> {
  try {
    return await step;
  } catch (err) {
    const id = err instanceof ModelFailureError || err instanceof RetryableFailure ? err.id : null;
    if (!id) throw err;
    return backend.get(id);
  }
}

function remote(base: string, key: string): Backend {
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (res.status === 502 && data.retryable) throw new RetryableFailure(data.id, data.error);
    if (!res.ok) throw new Error(`${res.status} ${data.error}`);
    return data as ConsultationView;
  };
  console.log(`（连接 ${base}）\n`);
  return {
    start: (complaint) => call("POST", "/v1/consultations", { complaint }),
    answer: (id, text) => call("POST", `/v1/consultations/${id}/answers`, { text }),
    get: (id) => call("GET", `/v1/consultations/${id}`),
    retry: (id) => call("POST", `/v1/consultations/${id}/retry`),
  };
}

/** Very small scripted patient: answers each question from the case dialogue, or says it is not sure. */
function scriptedPatient(caseId: string) {
  const c = MEDICAL_CASES.find((x) => x.id === caseId);
  if (!c) throw new Error(`Unknown case ${caseId}. Options: ${MEDICAL_CASES.map((x) => x.id).join(", ")}`);
  const pairs = c.dialogueHistory.flatMap((t, i) =>
    t.role === "doctor" && c.dialogueHistory[i + 1]?.role === "patient" ? [{ q: t.content, a: c.dialogueHistory[i + 1].content }] : [],
  );
  const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const FILLER = new Set(["有没", "没有", "什么", "医生", "请问", "一下", "情况", "时候", "的时", "吗？"]);
  const score = (a: string, b: string) => {
    const x = grams(a);
    let n = 0;
    for (const g of grams(b)) if (x.has(g) && !FILLER.has(g)) n++;
    return n;
  };
  return {
    opening: `医生您好，我${c.chiefComplaint}。`,
    reply(question: string): string {
      const parts = question.split(/(?<=[？?])/).map((s) => s.trim()).filter(Boolean);
      const answers = parts.map((p) => {
        const best = pairs.map((x) => ({ a: x.a, s: score(p, x.q) })).sort((a, b) => b.s - a.s)[0];
        return best && best.s >= 2 ? best.a : "这个我不太清楚。";
      });
      return [...new Set(answers)].join("");
    },
  };
}

function show(v: ConsultationView) {
  if (args.trace) for (const t of v.trace) console.log(`  · ${t.node}：${t.summary}`);
  if (v.question) console.log(`\n问诊助手：${v.question}`);
  if (v.output) console.log(`\n${v.output}\n`);
  if (v.status === "failed") console.log(`\n模型调用失败：${v.error}\n进度已保存。输入 /retry 重试，或 /quit 退出。`);
}

async function main() {
  const backend = args.server ? remote(args.server, args.key ?? process.env.API_KEY ?? "") : local();
  const patient = args.case ? scriptedPatient(args.case) : null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt: string) => (await rl.question(prompt)).trim();

  let view: ConsultationView;
  if (args.resume) {
    view = await backend.get(args.resume);
    console.log(`继续问诊 ${view.id}，已进行 ${view.rounds} 轮。`);
  } else {
    const complaint = patient ? patient.opening : await ask("患者：请说说哪里不舒服？\n> ");
    if (patient) console.log(`患者：${complaint}`);
    view = await orFailed(backend, backend.start(complaint));
    console.log(`问诊编号：${view.id}`);
  }
  show(view);

  let autoRetries = 0;
  while (view.status === "awaiting_answer" || view.status === "failed") {
    // A scripted patient retries a failed step by itself, but not forever.
    if (view.status === "failed" && patient && autoRetries++ >= 2) break;
    const answer = view.status === "failed" ? (patient ? "/retry" : await ask("> ")) : patient ? patient.reply(view.question ?? "") : await ask("> ");
    if (patient) console.log(`患者：${answer}`);
    if (answer === "/quit") {
      console.log(`进度已保存。继续：npm run backend:cli -- --resume ${view.id}`);
      break;
    }
    if (answer === "/record") {
      console.log(backend.record ? await backend.record(view.id) : "（远程模式下不支持）");
      continue;
    }
    if (answer === "/retry") {
      if (view.status !== "failed") console.log("（当前没有失败的步骤）");
      else {
        view = await orFailed(backend, backend.retry(view.id));
        show(view);
      }
      continue;
    }
    if (!answer || view.status === "failed") continue;
    view = await orFailed(backend, backend.answer(view.id, answer));
    show(view);
  }
  rl.close();
  await backend.close?.();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
