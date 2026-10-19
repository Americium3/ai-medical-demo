import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCheckpointer } from "../backend/src/config";
import type { LLM } from "../backend/src/llm";
import { createMockLLM } from "../backend/src/mock-llm";
import { createApiServer } from "../backend/src/server";
import { ConsultationService } from "../backend/src/service";

// #7: /api/agent and /api/agent/patient get a per-IP rate limit (off unless configured)
// and stop the backend's work when the browser disconnects.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slow(inner: LLM, ms = 80): LLM {
  return {
    kind: inner.kind,
    usage: inner.usage,
    async invoke(call) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        call.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
      return inner.invoke(call);
    },
  };
}

async function withBackend<T>(fn: (service: ConsultationService) => Promise<T>): Promise<T> {
  const service = new ConsultationService(slow(createMockLLM()), createCheckpointer(path.join(mkdtempSync(path.join(tmpdir(), "route-")), "db.sqlite")));
  const backend = createApiServer({ service, apiKeys: ["server-key"], ratePerMinute: 1000, dailyConsultations: 1000, log: () => {} });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  process.env.BACKEND_URL = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  process.env.BACKEND_API_KEY = "server-key";
  try {
    return await fn(service);
  } finally {
    delete process.env.BACKEND_URL;
    delete process.env.BACKEND_API_KEY;
    delete process.env.AGENT_RATE_LIMIT_PER_MINUTE;
    backend.close();
  }
}

const json = (url: string, body: unknown, ip: string, signal?: AbortSignal) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` }, body: JSON.stringify(body), signal });

test("the rate limit is off by default", async () => {
  const { POST } = await import("../src/app/api/agent/patient/route");
  for (let i = 0; i < 12; i++) {
    const res = await POST(json("http://app/api/agent/patient", { caseId: "cardio-001", transcript: [], questions: ["胸闷多久了？"] }, "198.51.100.1"));
    assert.equal(res.status, 200);
  }
});

test("with AGENT_RATE_LIMIT_PER_MINUTE set, each IP gets that many calls a minute across both routes", async () => {
  await withBackend(async () => {
    process.env.AGENT_RATE_LIMIT_PER_MINUTE = "3";
    const agent = await import("../src/app/api/agent/route");
    const patient = await import("../src/app/api/agent/patient/route");
    const ip = "203.0.113.7";
    const statuses = [
      (await agent.POST(json("http://app/api/agent", { action: "start", complaint: "我头痛一周了" }, ip))).status,
      (await patient.POST(json("http://app/api/agent/patient", { caseId: "cardio-001", transcript: [], questions: ["胸闷多久了？"] }, ip))).status,
      (await agent.POST(json("http://app/api/agent", { action: "start", complaint: "我头痛一周了" }, ip))).status,
      (await agent.POST(json("http://app/api/agent", { action: "start", complaint: "我头痛一周了" }, ip))).status,
    ];
    assert.deepEqual(statuses, [201, 200, 201, 429]);
    const other = await agent.POST(json("http://app/api/agent", { action: "start", complaint: "我头痛一周了" }, "203.0.113.8"));
    assert.equal(other.status, 201, "another IP has its own budget");
  });
});

test("a browser that disconnects mid-answer stops the backend's model calls", async () => {
  await withBackend(async (service) => {
    const { GET, POST } = await import("../src/app/api/agent/route");
    const started = await (await POST(json("http://app/api/agent", { action: "start", complaint: "我胸闷两周了" }, "192.0.2.1"))).json();
    const calls = () => service.usage.filter((u) => u.consultationId === started.id).length;

    const ctrl = new AbortController();
    const res = POST(json("http://app/api/agent", { action: "answer", id: started.id, text: "没有出汗。" }, "192.0.2.1", ctrl.signal));
    await sleep(120);
    ctrl.abort();
    await res.catch(() => undefined);
    await sleep(80);
    const atAbort = calls();
    await sleep(400);
    assert.equal(calls(), atAbort, "no model call after the browser went away");
    const after = await (await GET(new Request(`http://app/api/agent?id=${started.id}`))).json();
    assert.equal(after.status, "failed", "the cut-short round can be retried");
  });
});
