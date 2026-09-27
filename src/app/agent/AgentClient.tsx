"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ModelSelector } from "@/components/ModelSelector";
import { MEDICAL_CASES, getCaseById } from "@/data/cases";
import { DEFAULT_MODEL_ID } from "@/data/models";
import type { ConsultationStateT } from "@/lib/agent/graph";
import type { AgentEvent } from "@/lib/agent/run";
import type { Turn } from "@/lib/agent/schemas";
import { NODE_INFO, summarizeUpdate } from "@/lib/agent/trace";
import { readSSEJson } from "@/lib/sse";

type NodeEvent = Extract<AgentEvent, { type: "node" }>;

interface Run {
  id: number;
  events: NodeEvent[];
  status: "running" | "done" | "error";
  error?: string;
  ms?: number;
  calls?: number;
  tokens?: number;
}

interface Scores {
  accuracy: number;
  completeness: number;
  standardization: number;
  recommendation: number;
  comments: string;
}

const MAX_AUTO_ROUNDS = 6;

function openingFor(caseId: string): string {
  const c = getCaseById(caseId)!;
  return `医生您好，我${c.chiefComplaint}。`;
}

export function AgentClient() {
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [finalState, setFinalState] = useState<ConsultationStateT | null>(null);
  const [llmKind, setLlmKind] = useState<"mock" | "gateway" | null>(null);
  const [busy, setBusy] = useState<"agent" | "patient" | "auto" | "score" | null>(null);
  const [error, setError] = useState("");
  const [scores, setScores] = useState<Scores | null>(null);
  const [scoreError, setScoreError] = useState("");

  const chatEnd = useRef<HTMLDivElement>(null);
  const traceEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [transcript]);
  useEffect(() => {
    traceEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [runs]);

  const status = finalState?.status;
  const finished = status === "complete" || status === "emergency";
  const awaiting = status === "awaiting_patient";

  function reset(nextCaseId: string | null) {
    setCaseId(nextCaseId);
    setTranscript(nextCaseId ? [{ role: "patient", content: openingFor(nextCaseId) }] : []);
    setRuns([]);
    setFinalState(null);
    setError("");
    setScores(null);
    setScoreError("");
  }

  /** One request to /api/agent. Streams node events into the trace. */
  async function runTurn(t: Turn[]): Promise<ConsultationStateT | null> {
    const runId = Date.now();
    setRuns((prev) => [...prev, { id: runId, events: [], status: "running" }]);
    setError("");
    const patchRun = (patch: Partial<Run> | ((r: Run) => Partial<Run>)) =>
      setRuns((prev) =>
        prev.map((r) => (r.id === runId ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r)),
      );

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: t, model: modelId }),
      });
      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error || `HTTP ${res.status}`);
      }

      const box: { state: ConsultationStateT | null } = { state: null };
      await readSSEJson<AgentEvent>(res.body, (e) => {
        if (e.type === "start") setLlmKind(e.llm);
        else if (e.type === "node") patchRun((r) => ({ events: [...r.events, e] }));
        else if (e.type === "done") {
          box.state = e.state;
          patchRun({
            status: "done",
            ms: e.ms,
            calls: e.usage.length,
            tokens: e.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0),
          });
        } else if (e.type === "error") {
          throw new Error(e.message);
        }
      });
      const s = box.state;
      if (!s) throw new Error("没有收到最终状态");
      setFinalState(s);
      setTranscript(s.transcript);
      return s;
    } catch (err) {
      const message = err instanceof Error ? err.message : "请求失败";
      patchRun({ status: "error", error: message });
      setError(message);
      return null;
    }
  }

  async function simulatedAnswer(s: ConsultationStateT): Promise<string | null> {
    try {
      const res = await fetch("/api/agent/patient", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          transcript: s.transcript,
          questions: s.pendingQuestions,
          model: modelId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data.answer as string;
    } catch (err) {
      setError(err instanceof Error ? err.message : "模拟患者请求失败");
      return null;
    }
  }

  async function send(content: string) {
    const text = content.trim();
    if (!text || busy) return;
    const next: Turn[] = [...transcript, { role: "patient", content: text }];
    setTranscript(next);
    setInput("");
    setScores(null);
    setBusy("agent");
    await runTurn(next);
    setBusy(null);
  }

  async function start() {
    if (busy || transcript.length === 0) return;
    setBusy("agent");
    await runTurn(transcript);
    setBusy(null);
  }

  async function answerWithSimulatedPatient() {
    if (!finalState || busy) return;
    setBusy("patient");
    const answer = await simulatedAnswer(finalState);
    setBusy(null);
    if (answer) await send(answer);
  }

  /** Let the agent and the simulated patient talk until the agent finishes. */
  async function autoRun() {
    if (busy || !caseId) return;
    setBusy("auto");
    let t = transcript.at(-1)?.role === "patient" ? transcript : [{ role: "patient" as const, content: openingFor(caseId) }];
    for (let i = 0; i < MAX_AUTO_ROUNDS; i++) {
      const s = await runTurn(t);
      if (!s || s.status !== "awaiting_patient") break;
      const answer = await simulatedAnswer(s);
      if (!answer) break;
      t = [...s.transcript, { role: "patient", content: answer }];
      setTranscript(t);
    }
    setBusy(null);
  }

  async function score() {
    const c = caseId ? getCaseById(caseId) : null;
    if (!c || !finalState?.report || busy) return;
    setBusy("score");
    setScoreError("");
    try {
      const res = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aiResponse: finalState.report,
          expectedDiagnosis: c.expectedDiagnosis,
          chiefComplaint: c.chiefComplaint,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setScores(data);
    } catch (err) {
      setScoreError(err instanceof Error ? err.message : "评分失败");
    }
    setBusy(null);
  }

  const selectedCase = caseId ? getCaseById(caseId) : null;
  const visited = new Set(runs.flatMap((r) => r.events.map((e) => e.node)));
  const lastNode = runs.at(-1)?.events.at(-1)?.node;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Title + model */}
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            问诊 Agent <span className="text-base font-normal text-muted">LangGraph</span>
          </h1>
          <p className="text-sm text-muted">
            只给主诉，由 Agent 自己追问、识别危险信号、鉴别诊断并自查；右侧实时显示图的执行轨迹
          </p>
        </div>
        <div className="flex items-center gap-3">
          {llmKind === "mock" && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
              离线模拟模式（非真实模型）
            </span>
          )}
          <span className="text-sm text-muted">模型：</span>
          <ModelSelector selectedModel={modelId} onSelect={setModelId} compact />
        </div>
      </div>

      {/* Case picker */}
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

      {/* Graph map */}
      <div className="mb-4 flex flex-wrap items-center gap-1 rounded-xl border border-border bg-white px-4 py-3 text-xs">
        {["intake", "red_flag", "ask", "diagnose", "care_plan", "self_check", "write_report"].map((n, i, arr) => (
          <span key={n} className="flex items-center gap-1">
            <span
              data-testid={`map-${n}`}
              className={`rounded-md px-2 py-1 ${
                lastNode === n && busy
                  ? "animate-pulse bg-primary text-white"
                  : visited.has(n)
                    ? "bg-primary/10 text-primary"
                    : "bg-gray-100 text-muted"
              }`}
            >
              {NODE_INFO[n].icon} {NODE_INFO[n].label}
            </span>
            {i < arr.length - 1 && <span className="text-muted">→</span>}
          </span>
        ))}
        <span className="ml-2 text-muted">（追问 ↺ 最多 4 轮；自查不通过 ↺ 最多重写 2 次；急诊直接出结论）</span>
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        {/* Chat */}
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
              <div className="flex h-full items-center justify-center text-sm text-muted">
                选一个病例，或以患者身份描述你的不适
              </div>
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
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm leading-relaxed ${
                      t.role === "agent" ? "bg-blue-50" : "bg-green-50"
                    }`}
                  >
                    {t.content}
                  </div>
                </div>
              ))
            )}
            {busy === "agent" || busy === "auto" ? (
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                Agent 思考中…
              </div>
            ) : null}
            <div ref={chatEnd} />
          </div>

          {error && (
            <div className="mx-4 mb-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>
          )}

          <div className="space-y-2 border-t border-border p-4">
            {caseId && !finished && (
              <div className="flex flex-wrap gap-2">
                {runs.length === 0 && (
                  <button
                    onClick={start}
                    disabled={!!busy}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
                  >
                    开始问诊
                  </button>
                )}
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
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && send(input)}
                disabled={finished || !!busy}
                placeholder={finished ? "本次问诊已结束，选择病例重新开始" : "以患者身份输入…"}
                className="flex-1 rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:bg-gray-50"
              />
              <button
                onClick={() => send(input)}
                disabled={!input.trim() || finished || !!busy}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
              >
                发送
              </button>
            </div>
          </div>
        </section>

        {/* Trace */}
        <section className="flex flex-col rounded-2xl border border-border bg-white shadow-sm lg:col-span-5">
          <div className="border-b border-border px-5 py-3">
            <h2 className="font-bold text-primary">执行轨迹</h2>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-4" style={{ minHeight: 320, maxHeight: 560 }}>
            {runs.length === 0 && <div className="text-sm text-muted">每次请求会在这里按节点展开</div>}
            {runs.map((run, ri) => (
              <div key={run.id} data-testid="trace-run">
                <div className="mb-2 flex items-center justify-between text-xs text-muted">
                  <span className="font-semibold text-foreground">第 {ri + 1} 次请求</span>
                  {run.status === "done" && (
                    <span>
                      {(run.ms! / 1000).toFixed(1)}s · {run.calls} 次模型调用
                      {run.tokens ? ` · ${run.tokens} tokens` : ""}
                    </span>
                  )}
                  {run.status === "error" && <span className="text-red-600">失败</span>}
                </div>
                <ol className="space-y-1.5 border-l-2 border-primary/20 pl-3">
                  {run.events.map((e, i) => (
                    <li key={i} className="text-xs" data-testid={`trace-${e.node}`}>
                      <details>
                        <summary className="cursor-pointer">
                          <span className="font-medium">
                            {NODE_INFO[e.node]?.icon} {NODE_INFO[e.node]?.label ?? e.node}
                          </span>
                          <span className="ml-1 text-muted">{e.node}</span>
                          <div className="ml-4 text-slate-600">{summarizeUpdate(e.node, e.update)}</div>
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-50 p-2 text-[10px] leading-snug">
                          {JSON.stringify(e.update, null, 2)}
                        </pre>
                      </details>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
            <div ref={traceEnd} />
          </div>
        </section>
      </div>

      {/* Record */}
      {finished && finalState?.report && (
        <section
          data-testid="report"
          className={`mt-6 rounded-2xl border bg-white shadow-sm ${
            status === "emergency" ? "border-red-300" : "border-border"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
            <h2 className={`font-bold ${status === "emergency" ? "text-red-600" : "text-primary"}`}>
              {status === "emergency" ? "急诊提示" : "结构化病历"}
            </h2>
            {selectedCase && status === "complete" && (
              <button
                onClick={score}
                disabled={!!busy}
                className="rounded-lg border border-primary px-3 py-1 text-xs font-medium text-primary hover:bg-primary/5 disabled:opacity-50"
              >
                {busy === "score" ? "评分中…" : "用评分裁判打分"}
              </button>
            )}
          </div>
          <div className="grid gap-6 p-5 lg:grid-cols-3">
            <div className="prose prose-sm max-w-none text-sm lg:col-span-2 [&_li]:my-0.5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{finalState.report}</ReactMarkdown>
            </div>
            <aside className="space-y-3 text-xs">
              {scores && (
                <div className="rounded-lg bg-primary/5 p-3">
                  <div className="mb-1 font-semibold">裁判评分</div>
                  <div>诊断准确性 {scores.accuracy}</div>
                  <div>病历完整性 {scores.completeness}</div>
                  <div>医学规范性 {scores.standardization}</div>
                  <div>建议合理性 {scores.recommendation}</div>
                  <div className="mt-1 text-muted">{scores.comments}</div>
                </div>
              )}
              {scoreError && <div className="rounded-lg bg-red-50 p-3 text-red-700">评分失败：{scoreError}</div>}
              {selectedCase && (
                <details className="rounded-lg bg-amber-50 p-3">
                  <summary className="cursor-pointer font-medium">标准答案（Agent 看不到）</summary>
                  <p className="mt-2">主要诊断：{selectedCase.expectedDiagnosis.mainDiagnosis}</p>
                  <p>鉴别：{selectedCase.expectedDiagnosis.differentialDiagnosis.join("、")}</p>
                  <p>检查：{selectedCase.expectedDiagnosis.recommendedTests.join("、")}</p>
                </details>
              )}
              {finalState.droppedFacts.length > 0 && (
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="font-medium">被丢弃的「事实」（找不到患者原话）</div>
                  <ul className="mt-1 list-disc pl-4">
                    {finalState.droppedFacts.map((f, i) => (
                      <li key={i}>{f.statement}</li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
          </div>
        </section>
      )}

      <p className="mt-6 text-center text-xs text-muted">
        技术演示，不构成医疗建议。如有胸痛、呼吸困难、意识改变等急症，请立即就医或拨打 120。
      </p>
    </div>
  );
}
