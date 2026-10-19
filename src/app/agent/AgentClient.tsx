"use client";

import { useEffect, useRef, useState } from "react";
import { MEDICAL_CASES, getCaseById } from "@/data/cases";
import type { ConsultationView } from "../../../backend/src/service";

type Turn = { role: "patient" | "agent"; content: string };

interface Run {
  id: number;
  label: string;
  status: "running" | "done" | "error";
  steps: ConsultationView["trace"];
  ms?: number;
  error?: string;
}

const MAX_AUTO_ROUNDS = 8;

/** The backend's graph, in order (docs/agent/DESIGN.md §6). */
const NODES: { id: string; label: string }[] = [
  { id: "screen", label: "规则筛查" },
  { id: "understand", label: "更新记录表" },
  { id: "triage", label: "危险分级" },
  { id: "phrase", label: "改写追问" },
  { id: "ask", label: "追问" },
  { id: "retrieve", label: "检索指南" },
  { id: "draft", label: "写病历" },
  { id: "check", label: "自查" },
  { id: "finalize", label: "完成" },
];

/** Labels for trace steps, including the nodes the map leaves out. */
const LABEL: Record<string, string> = {
  ...Object.fromEntries(NODES.map((n) => [n.id, n.label])),
  setup: "选模板",
  wait: "收到回答",
  emergency: "急诊提示",
};

const STATUS_TEXT: Record<string, string> = { answered: "已回答", unknown: "不清楚", unasked: "未问" };

function openingFor(caseId: string): string {
  return `医生您好，我${getCaseById(caseId)!.chiefComplaint}。`;
}

/** The backend joins a round's questions with spaces; the simulated patient wants them one by one. */
function splitQuestions(q: string): string[] {
  return q.split(/(?<=[？?])\s*/).filter(Boolean);
}

export function AgentClient() {
  const [caseId, setCaseId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Turn[]>([]);
  const [view, setView] = useState<ConsultationView | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"agent" | "patient" | "auto" | null>(null);
  const [error, setError] = useState("");

  const chatEnd = useRef<HTMLDivElement>(null);
  const traceEnd = useRef<HTMLDivElement>(null);
  useEffect(() => chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), [transcript]);
  useEffect(() => traceEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), [runs]);

  const status = view?.status;
  const finished = status === "completed" || status === "emergency";
  const awaiting = status === "awaiting_answer";

  function reset(nextCaseId: string | null) {
    setCaseId(nextCaseId);
    setTranscript([]);
    setView(null);
    setRuns([]);
    setError("");
    setInput(nextCaseId ? openingFor(nextCaseId) : "");
  }

  /** One call through /api/agent. Returns the new view, or null on failure. */
  async function call(label: string, body: Record<string, string>): Promise<ConsultationView | null> {
    const runId = Date.now();
    const started = performance.now();
    setRuns((prev) => [...prev, { id: runId, label, status: "running", steps: [] }]);
    setError("");
    const patch = (p: Partial<Run>) => setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, ...p } : r)));
    try {
      const res = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        // A model failure is saved on the backend as "failed"; show it so the user can retry.
        if (res.status === 502 && data?.retryable && data.id) {
          const got = await fetch(`/api/agent?id=${data.id}`).then((r) => r.json());
          setView(got);
        }
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const v = data as ConsultationView;
      patch({ status: "done", steps: v.trace, ms: performance.now() - started });
      setView(v);
      if (v.question) setTranscript((t) => [...t, { role: "agent", content: v.question! }]);
      return v;
    } catch (err) {
      const message = err instanceof Error ? err.message : "请求失败";
      patch({ status: "error", error: message, ms: performance.now() - started });
      setError(message);
      return null;
    }
  }

  async function say(text: string, current: ConsultationView | null): Promise<ConsultationView | null> {
    setTranscript((t) => [...t, { role: "patient", content: text }]);
    return current ? call("回答", { action: "answer", id: current.id, text }) : call("开始问诊", { action: "start", complaint: text });
  }

  async function send(content: string) {
    const text = content.trim();
    if (!text || busy || finished) return;
    setInput("");
    setBusy("agent");
    await say(text, view);
    setBusy(null);
  }

  async function simulatedAnswer(v: ConsultationView, t: Turn[]): Promise<string | null> {
    try {
      const res = await fetch("/api/agent/patient", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, transcript: t, questions: splitQuestions(v.question ?? "") }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data.answer as string;
    } catch (err) {
      setError(err instanceof Error ? err.message : "模拟患者请求失败");
      return null;
    }
  }

  async function answerWithSimulatedPatient() {
    if (!view || !awaiting || busy) return;
    setBusy("patient");
    const answer = await simulatedAnswer(view, transcript);
    if (answer) await say(answer, view);
    setBusy(null);
  }

  /** Let the backend and the simulated patient talk until the consultation ends. */
  async function autoRun() {
    if (busy || !caseId) return;
    setBusy("auto");
    const opening = openingFor(caseId);
    let t: Turn[] = view ? transcript : [{ role: "patient", content: opening }];
    let v = view ?? (await say(opening, null));
    for (let i = 0; v?.status === "awaiting_answer" && i < MAX_AUTO_ROUNDS; i++) {
      t = [...t, { role: "agent", content: v.question! }];
      const answer = await simulatedAnswer(v, t);
      if (!answer) break;
      t = [...t, { role: "patient", content: answer }];
      v = await say(answer, v);
    }
    setInput("");
    setBusy(null);
  }

  async function retry() {
    if (!view || busy) return;
    setBusy("agent");
    await call("重试", { action: "retry", id: view.id });
    setBusy(null);
  }

  const selectedCase = caseId ? getCaseById(caseId) : null;
  const visited = new Set(runs.flatMap((r) => r.steps.map((s) => s.node)));

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">
          问诊 Agent <span className="text-base font-normal text-muted">LangGraph · backend</span>
        </h1>
        <p className="text-sm text-muted">
          预问诊：只给主诉，Agent 按模板追问、规则先查危险信号、最后写门诊病历草稿给医生（不下诊断）。右侧是记录表和每次请求经过的图节点。
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">从病例开始（只给主诉）：</span>
        {MEDICAL_CASES.map((c) => (
          <button
            key={c.id}
            onClick={() => reset(c.id)}
            disabled={!!busy}
            className={`rounded-full px-3 py-1 text-xs transition-colors disabled:opacity-50 ${
              caseId === c.id ? "bg-primary text-white" : "bg-gray-100 text-muted hover:bg-gray-200"
            }`}
          >
            {c.departmentIcon} {c.title}
          </button>
        ))}
        <button
          onClick={() => reset(null)}
          disabled={!!busy}
          className={`rounded-full px-3 py-1 text-xs transition-colors disabled:opacity-50 ${
            caseId === null ? "bg-slate-700 text-white" : "bg-gray-100 text-muted hover:bg-gray-200"
          }`}
        >
          ✍️ 自由问诊（我来当患者）
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1 rounded-xl border border-border bg-white px-4 py-3 text-xs">
        {NODES.map((n, i) => (
          <span key={n.id} className="flex items-center gap-1">
            <span data-testid={`map-${n.id}`} className={`rounded-md px-2 py-1 ${visited.has(n.id) ? "bg-primary/10 text-primary" : "bg-gray-100 text-muted"}`}>
              {n.label}
            </span>
            {i < NODES.length - 1 && <span className="text-muted">→</span>}
          </span>
        ))}
        <span className="ml-2 text-muted">（规则命中Ⅰ、Ⅱ级直接急诊；追问最多 4 轮；自查不通过最多重写 2 次）</span>
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <section className="flex flex-col rounded-2xl border border-border bg-white shadow-sm lg:col-span-7">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="font-bold text-primary">问诊对话</h2>
            {selectedCase && (
              <span className="text-xs text-muted">
                {selectedCase.department} · {selectedCase.patientInfo.age}岁{selectedCase.patientInfo.gender}
              </span>
            )}
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto p-4" style={{ minHeight: 320, maxHeight: 460 }}>
            {transcript.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted">选一个病例，或以患者身份描述你的不适</div>
            ) : (
              transcript.map((t, i) => (
                <div key={i} className={`flex gap-3 ${t.role === "agent" ? "" : "flex-row-reverse"}`}>
                  <div
                    className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
                      t.role === "agent" ? "bg-primary" : "bg-secondary"
                    }`}
                  >
                    {t.role === "agent" ? "AI" : "患"}
                  </div>
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm leading-relaxed ${t.role === "agent" ? "bg-blue-50" : "bg-green-50"}`}>
                    {t.content}
                  </div>
                </div>
              ))
            )}
            {busy && busy !== "patient" ? (
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                Agent 处理中…
              </div>
            ) : null}
            <div ref={chatEnd} />
          </div>

          {error && <div className="mx-4 mb-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>}

          <div className="space-y-2 border-t border-border p-4">
            <div className="flex flex-wrap gap-2">
              {caseId && !finished && status !== "failed" && (
                <>
                  {awaiting && (
                    <button
                      onClick={answerWithSimulatedPatient}
                      disabled={!!busy}
                      className="rounded-lg border border-secondary px-4 py-2 text-sm font-medium text-secondary hover:bg-secondary/10 disabled:opacity-50"
                    >
                      {busy === "patient" ? "模拟患者回答中…" : "🧑 让模拟患者回答"}
                    </button>
                  )}
                  <button
                    onClick={autoRun}
                    disabled={!!busy}
                    className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                  >
                    {busy === "auto" ? "自动问诊中…" : "⏩ 自动跑完整场问诊"}
                  </button>
                </>
              )}
              {status === "failed" && (
                <button
                  onClick={retry}
                  disabled={!!busy}
                  className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  从失败的步骤重试
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && send(input)}
                disabled={finished || status === "failed" || !!busy}
                placeholder={finished ? "本次问诊已结束，选择病例重新开始" : "以患者身份输入…"}
                className="flex-1 rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:bg-gray-50"
              />
              <button
                onClick={() => send(input)}
                disabled={!input.trim() || finished || status === "failed" || !!busy}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
              >
                发送
              </button>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-4 lg:col-span-5">
          <div className="rounded-2xl border border-border bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-bold text-primary">危险分级与记录表</h2>
              {view && (
                <span className={`rounded-full px-2 py-0.5 text-xs ${status === "emergency" ? "bg-red-100 text-red-700" : "bg-gray-100 text-muted"}`}>{view.level}</span>
              )}
            </div>
            {!view ? (
              <p className="text-xs text-muted">主诉发出后出现。每个已回答的要点都保留患者原话。</p>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {view.table.map((row) => (
                    <tr key={row.label} className="border-t border-border/60">
                      <td className="py-1 pr-2">{row.label}</td>
                      <td className={`py-1 ${row.status === "answered" ? "text-green-700" : "text-muted"}`}>
                        {STATUS_TEXT[row.status]}
                        {row.quote && <span className="ml-1 text-slate-600">“{row.quote}”</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="flex flex-col rounded-2xl border border-border bg-white shadow-sm">
            <div className="border-b border-border px-5 py-3">
              <h2 className="font-bold text-primary">执行轨迹</h2>
            </div>
            <div className="space-y-4 overflow-y-auto p-4" style={{ maxHeight: 360 }}>
              {runs.length === 0 && <div className="text-sm text-muted">每次请求会在这里按节点展开</div>}
              {runs.map((run, ri) => (
                <div key={run.id} data-testid="trace-run">
                  <div className="mb-1 flex items-center justify-between text-xs text-muted">
                    <span className="font-semibold text-foreground">
                      第 {ri + 1} 次请求 · {run.label}
                    </span>
                    {run.ms !== undefined && <span>{(run.ms / 1000).toFixed(1)}s</span>}
                  </div>
                  {run.status === "error" && <div className="text-xs text-red-600">失败：{run.error}</div>}
                  <ol className="space-y-1 border-l-2 border-primary/20 pl-3">
                    {run.steps.map((s, i) => (
                      <li key={i} className="text-xs" data-testid={`trace-${s.node}`}>
                        <span className="font-medium">{LABEL[s.node] ?? s.node}</span>
                        <span className="ml-1 text-slate-600">{s.summary}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
              <div ref={traceEnd} />
            </div>
          </div>
        </section>
      </div>

      {view?.output && (
        <section data-testid="report" className={`mt-6 rounded-2xl border bg-white shadow-sm ${status === "emergency" ? "border-red-300" : "border-border"}`}>
          <div className="border-b border-border px-5 py-3">
            <h2 className={`font-bold ${status === "emergency" ? "text-red-600" : "text-primary"}`}>{status === "emergency" ? "急诊提示" : "门诊病历草稿"}</h2>
          </div>
          <pre className="whitespace-pre-wrap p-5 font-sans text-sm leading-relaxed">{view.output}</pre>
        </section>
      )}

      <p className="mt-6 text-center text-xs text-muted">
        技术演示，不构成医疗建议。如有胸痛、呼吸困难、意识改变等急症，请立即就医或拨打 120。
      </p>
    </div>
  );
}
