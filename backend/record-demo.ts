/** Records real runs of the backend (offline mock model) to JSON for the demo page. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCheckpointer } from "./src/config";
import { createMockLLM } from "./src/mock-llm";
import { createApiServer } from "./src/server";
import { ConsultationService, type ConsultationView } from "./src/service";
import { slotsFor, TEMPLATES } from "./src/templates";

const dir = mkdtempSync(path.join(tmpdir(), "demo-"));
const db = path.join(dir, "c.sqlite");
const svc = () => new ConsultationService(createMockLLM(), createCheckpointer(db));

async function snapshot(s: ConsultationService, id: string) {
  const st = await s.state(id);
  const t = TEMPLATES.find((x) => x.id === st.templateId)!;
  return {
    level: st.level,
    record: slotsFor(t).map((x) => ({ id: x.id, label: x.label, kind: x.kind, status: st.record[x.id].status, quote: st.record[x.id].quote ?? null })),
    lastSlots: st.asked.at(-1)?.slotIds ?? [],
  };
}

async function run(name: string, opening: string, answers: Record<string, string>, restartAfterRound?: number) {
  let s = svc();
  const turns: unknown[] = [];
  let v: ConsultationView = await s.start(opening, "demo");
  turns.push({ patient: opening, view: v, snap: await snapshot(s, v.id) });
  let round = 0;
  while (v.status === "awaiting_answer") {
    round++;
    const slots = (await snapshot(s, v.id)).lastSlots;
    const reply = slots.map((id) => answers[id] ?? "这个我不太清楚。").join("");
    if (restartAfterRound && round === restartAfterRound + 1) {
      s = svc(); // new process, same database
      turns.push({ restart: true, view: await s.get(v.id, "demo") });
    }
    v = await s.answer(v.id, reply, "demo");
    turns.push({ patient: reply, view: v, snap: await snapshot(s, v.id) });
  }
  return { name, turns };
}

async function api() {
  const out: { label: string; request: string; status: number; body: unknown }[] = [];
  const server = createApiServer({ service: svc(), apiKeys: ["key-alice", "key-bob"], ratePerMinute: 6, dailyConsultations: 200, log: () => {} });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (label: string, method: string, url: string, key?: string, body?: string) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
      body,
    });
    const data = await res.json();
    out.push({ label, request: `${method} ${url}${key ? `  (key: ${key})` : "  (no key)"}`, status: res.status, body: data });
    return data;
  };
  await call("No API key", "POST", "/v1/consultations", undefined, JSON.stringify({ complaint: "我胸闷两周了" }));
  await call("Wrong API key", "POST", "/v1/consultations", "key-mallory", JSON.stringify({ complaint: "我胸闷两周了" }));
  const c = await call("Valid key starts a consultation", "POST", "/v1/consultations", "key-alice", JSON.stringify({ complaint: "我胸闷两周了" }));
  await call("Another key cannot read it", "GET", `/v1/consultations/${c.id}`, "key-bob");
  await call("Input over 500 characters", "POST", `/v1/consultations/${c.id}/answers`, "key-alice", JSON.stringify({ text: "闷".repeat(501) }));
  await call("Request body over 8 KB", "POST", "/v1/consultations", "key-alice", JSON.stringify({ complaint: "x".repeat(9000) }));
  await call("Same key reads its own consultation", "GET", `/v1/consultations/${c.id}`, "key-alice");
  for (let i = 0; i < 10 && out.at(-1)!.status !== 429; i++) {
    out.pop();
    await call("Too many requests (limit is 6 per minute in this demo)", "GET", `/v1/consultations/${c.id}`, "key-alice");
  }
  server.close();
  return out;
}

const chest = {
  rf_chest_sweat: "没有出汗，也没有喘不上气。",
  rf_chest_rest: "休息一会儿就好了，不会一直痛。",
  character: "就是闷闷的，不算很疼。",
  associated: "另外偶尔有点头晕。",
  pmh: "以前查出过高血压。",
  allergy: "对青霉素过敏。",
  cv_risk: "高血压五年了，抽烟十几年。",
  family_cv: "我父亲有冠心病。",
  relief: "休息一下会好点。",
  meds: "在吃降压药。",
};

async function main() {
const result = {
  generatedAt: new Date().toISOString(),
  runs: [
    await run("chest", "医生您好，我最近两周老是胸闷，上楼的时候更明显。", chest),
    await run("emergency", "我胸口痛了一个小时。", { rf_chest_sweat: "现在全身出大汗，胸口痛得厉害，像被压着。", rf_chest_rest: "躺着也一直痛，没有好转。" }),
    await run("resume", "医生您好，我最近两周老是胸闷，上楼的时候更明显。", chest, 1),
  ],
  api: await api(),
};
writeFileSync(process.argv[2], JSON.stringify(result, null, 1));
console.log("ok", result.runs.map((r) => `${r.name}:${r.turns.length}`).join(" "), result.api.map((a) => a.status).join(","));
}
main();
