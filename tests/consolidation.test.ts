import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { RED_FLAG_RULES } from "../shared/safety/red-flags";
import { RULES } from "../backend/src/triage";
import { createCheckpointer } from "../backend/src/config";
import { createMockLLM } from "../backend/src/mock-llm";
import { createApiServer } from "../backend/src/server";
import { ConsultationService } from "../backend/src/service";

// #13: one agent implementation (backend/), one rule table, docs that match the code.

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p, ext) : ext.test(p) ? [p] : [];
  });
}

test("the backend uses the one shared red-flag table", () => {
  assert.equal(RULES, RED_FLAG_RULES);
  assert.deepEqual([...new Set(RED_FLAG_RULES.map((r) => r.level))].sort(), [1, 2, 3]);
});

test("no production code under src/ imports the prototype agent", () => {
  assert.ok(!existsSync("src/lib/agent"), "src/lib/agent should be gone (moved to experiments/next-agent)");
  const offenders = filesUnder("src", /\.(ts|tsx)$/).filter((f) => /lib\/agent|experiments\//.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

test("every 'DESIGN.md §x' in backend/src and shared/ resolves to a section of docs/agent/DESIGN.md", () => {
  const design = readFileSync("docs/agent/DESIGN.md", "utf8");
  const headings = new Set([...design.matchAll(/^#+\s*§([\d.]+)/gm)].map((m) => m[1]));
  const missing: string[] = [];
  const sources = [...filesUnder("backend/src", /\.ts$/), ...filesUnder("shared", /\.ts$/)];
  assert.ok(!sources.some((f) => readFileSync(f, "utf8").includes("design doc")), "references name the file");
  for (const f of sources) {
    for (const m of readFileSync(f, "utf8").matchAll(/DESIGN\.md §([\d.]+)(?:[–-]§?([\d.]+))?(?:, §([\d.]+))?/g)) {
      for (const sec of [m[1], m[2], m[3]].filter(Boolean)) if (!headings.has(sec)) missing.push(`${f}: §${sec}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("/api/agent forwards start, answer and status to the backend with the server-side key", async () => {
  const service = new ConsultationService(createMockLLM(), createCheckpointer(path.join(mkdtempSync(path.join(tmpdir(), "proxy-")), "db.sqlite")));
  const backend = createApiServer({ service, apiKeys: ["server-key"], ratePerMinute: 100, dailyConsultations: 100, log: () => {} });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  process.env.BACKEND_URL = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  process.env.BACKEND_API_KEY = "server-key";
  try {
    const { GET, POST } = await import("../src/app/api/agent/route");
    const post = (body: unknown) =>
      POST(new Request("http://app/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

    const started = await post({ action: "start", complaint: "我胸闷两周了，上楼更明显" });
    assert.equal(started.status, 201);
    const v = await started.json();
    assert.equal(v.status, "awaiting_answer");
    assert.ok(v.question);

    const answered = await post({ action: "answer", id: v.id, text: "没有出汗。" });
    assert.equal(answered.status, 200);
    assert.equal((await answered.json()).rounds, 2);

    const got = await GET(new Request(`http://app/api/agent?id=${v.id}`));
    assert.equal(got.status, 200);
    assert.equal((await got.json()).id, v.id);

    assert.equal((await post({ action: "answer", id: "not-a-uuid", text: "x" })).status, 400);
  } finally {
    delete process.env.BACKEND_URL;
    delete process.env.BACKEND_API_KEY;
    backend.close();
  }
});

test("/api/agent says so when no backend is configured", async () => {
  const { POST } = await import("../src/app/api/agent/route");
  const res = await POST(
    new Request("http://app/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", complaint: "我头痛一周了" }) }),
  );
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /BACKEND_URL/);
});
