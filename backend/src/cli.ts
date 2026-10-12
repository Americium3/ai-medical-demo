/**
 * Command-line consultation.
 *
 *   npm run backend:cli                          # you play the patient, in-process
 *   npm run backend:cli -- --case cardio-001     # a simulated patient answers from a demo case
 *   npm run backend:cli -- --resume <id>         # continue a saved consultation
 *   npm run backend:cli -- --server http://localhost:8787 --key <API key>   # talk to the HTTP API
 *
 * In-session commands: /record shows the record table, /quit exits (progress is saved).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { MEDICAL_CASES } from "../../src/data/cases";
import { createCheckpointer, createLLM, loadConfig } from "./config";
import { ConsultationService, type ConsultationView } from "./service";
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
  record?(id: string): Promise<string>;
}

const OWNER = "cli";

function local(): Backend {
  const cfg = loadConfig();
  mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const service = new ConsultationService(createLLM(cfg), createCheckpointer(cfg.dbPath));
  console.log(`（本地运行，模型：${cfg.llm === "mock" ? "离线替身" : "AWS Bedrock"}，进度保存在 ${cfg.dbPath}）\n`);
  return {
    start: (c) => service.start(c, OWNER),
    answer: (id, t) => service.answer(id, t, OWNER),
    get: (id) => service.get(id, OWNER),
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

function remote(base: string, key: string): Backend {
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${data.error}`);
    return data as ConsultationView;
  };
  console.log(`（连接 ${base}）\n`);
  return {
    start: (complaint) => call("POST", "/v1/consultations", { complaint }),
    answer: (id, text) => call("POST", `/v1/consultations/${id}/answers`, { text }),
    get: (id) => call("GET", `/v1/consultations/${id}`),
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
    view = await backend.start(complaint);
    console.log(`问诊编号：${view.id}`);
  }
  show(view);

  while (view.status === "awaiting_answer") {
    const answer = patient ? patient.reply(view.question ?? "") : await ask("> ");
    if (patient) console.log(`患者：${answer}`);
    if (answer === "/quit") {
      console.log(`进度已保存。继续：npm run backend:cli -- --resume ${view.id}`);
      break;
    }
    if (answer === "/record") {
      console.log(backend.record ? await backend.record(view.id) : "（远程模式下不支持）");
      continue;
    }
    if (!answer) continue;
    view = await backend.answer(view.id, answer);
    show(view);
  }
  rl.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
