"use client";

import { useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MEDICAL_CASES, getCaseById, type MedicalCase } from "@/data/cases";
import { AI_MODELS, type AIModel } from "@/data/models";
import { SCORE_DIMENSIONS, calculateTotalScore } from "@/data/scoring";
import { buildConsultationPrompt } from "@/lib/prompts";
import { readUIMessageText } from "@/lib/ui-stream";
import { ScoreRadarChart } from "@/components/ScoreRadarChart";

interface ModelResult {
  modelId: string;
  response: string;
  responseTime: number;
  scores: Record<string, number> | null;
  totalScore: number | null;
  status: "idle" | "loading" | "scoring" | "done" | "error";
  scoreError?: string;
}

export function ComparisonClient() {
  const searchParams = useSearchParams();
  const initialCaseId = searchParams.get("case") || MEDICAL_CASES[0].id;

  const [selectedCaseId, setSelectedCaseId] = useState(initialCaseId);
  const [selectedModels, setSelectedModels] = useState<string[]>([
    "gpt-4o-mini",
    "claude-sonnet",
  ]);
  const [results, setResults] = useState<Record<string, ModelResult>>({});
  const [isRunning, setIsRunning] = useState(false);

  const selectedCase = getCaseById(selectedCaseId)!;

  const toggleModel = (modelId: string) => {
    setSelectedModels((prev) =>
      prev.includes(modelId)
        ? prev.filter((id) => id !== modelId)
        : [...prev, modelId]
    );
  };

  const runDiagnosis = useCallback(
    async (modelId: string, caseData: MedicalCase) => {
      const prompt = buildConsultationPrompt(caseData.dialogueHistory);
      const startTime = Date.now();

      setResults((prev) => ({
        ...prev,
        [modelId]: {
          modelId,
          response: "",
          responseTime: 0,
          scores: null,
          totalScore: null,
          status: "loading",
        },
      }));

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: prompt }],
            model: modelId,
          }),
        });

        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => null);
          throw new Error(detail?.error || `HTTP ${res.status}`);
        }

        const fullResponse = await readUIMessageText(res.body, (text) => {
          setResults((prev) => ({
            ...prev,
            [modelId]: { ...prev[modelId], response: text },
          }));
        });

        const responseTime = Date.now() - startTime;

        setResults((prev) => ({
          ...prev,
          [modelId]: {
            ...prev[modelId],
            response: fullResponse,
            responseTime,
            status: "scoring",
          },
        }));

        // Get scoring
        try {
          const scoreRes = await fetch("/api/score", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              aiResponse: fullResponse,
              expectedDiagnosis: caseData.expectedDiagnosis,
              chiefComplaint: caseData.chiefComplaint,
            }),
          });
          const scoreData = await scoreRes.json();
          if (!scoreRes.ok) {
            throw new Error(scoreData?.error || `HTTP ${scoreRes.status}`);
          }

          // Calculate speed score based on response time
          const speedScore = Math.max(
            0,
            Math.min(100, 100 - (responseTime - 3000) / 100)
          );

          const scores = {
            accuracy: scoreData.accuracy || 0,
            completeness: scoreData.completeness || 0,
            speed: Math.round(speedScore),
            standardization: scoreData.standardization || 0,
            recommendation: scoreData.recommendation || 0,
          };

          setResults((prev) => ({
            ...prev,
            [modelId]: {
              ...prev[modelId],
              scores,
              totalScore: calculateTotalScore(scores),
              status: "done",
            },
          }));
        } catch (err) {
          setResults((prev) => ({
            ...prev,
            [modelId]: {
              ...prev[modelId],
              status: "done",
              scoreError: err instanceof Error ? err.message : "评分失败",
            },
          }));
        }
      } catch (err) {
        setResults((prev) => ({
          ...prev,
          [modelId]: {
            ...prev[modelId],
            status: "error",
            response: `请求失败，请检查 API 配置（${
              err instanceof Error ? err.message : "未知错误"
            }）`,
          },
        }));
      }
    },
    []
  );

  const handleRunComparison = async () => {
    if (selectedModels.length === 0) return;
    setIsRunning(true);
    setResults({});

    // Run all models in parallel
    await Promise.all(
      selectedModels.map((modelId) => runDiagnosis(modelId, selectedCase))
    );

    setIsRunning(false);
  };

  const completedResults = Object.values(results).filter(
    (r) => r.status === "done" && r.scores
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold sm:text-3xl">多模型对比评分</h1>
        <p className="mt-2 text-muted">
          选择病例和模型，并排对比不同 AI 模型的诊断结果与评分
        </p>
      </div>

      {/* Configuration */}
      <div className="mb-6 rounded-2xl border border-border bg-white p-6">
        {/* Case selector */}
        <div className="mb-4">
          <label className="mb-2 block text-sm font-medium">选择病例：</label>
          <div className="flex flex-wrap gap-2">
            {MEDICAL_CASES.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedCaseId(c.id)}
                className={`rounded-lg px-3 py-2 text-sm transition-colors ${
                  selectedCaseId === c.id
                    ? "bg-primary text-white"
                    : "bg-gray-100 text-muted hover:bg-gray-200"
                }`}
              >
                {c.departmentIcon} {c.title}
              </button>
            ))}
          </div>
        </div>

        {/* Case info */}
        <div className="mb-4 rounded-lg bg-gray-50 p-3 text-sm">
          <strong>{selectedCase.department}</strong> |{" "}
          {selectedCase.patientInfo.name}，{selectedCase.patientInfo.age}岁 |
          主诉：{selectedCase.chiefComplaint}
        </div>

        {/* Model selector */}
        <div className="mb-4">
          <label className="mb-2 block text-sm font-medium">
            选择对比模型（可多选）：
          </label>
          <div className="flex flex-wrap gap-3">
            {AI_MODELS.map((model: AIModel) => (
              <button
                key={model.id}
                onClick={() => toggleModel(model.id)}
                className={`flex items-center gap-2 rounded-lg border-2 px-4 py-2 text-sm transition-all ${
                  selectedModels.includes(model.id)
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-gray-300"
                }`}
              >
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: model.color }}
                />
                <span className="font-medium">{model.name}</span>
                <span className="text-xs text-muted">({model.provider})</span>
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={handleRunComparison}
          disabled={isRunning || selectedModels.length === 0}
          className="rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-primary-dark disabled:opacity-50"
        >
          {isRunning
            ? "对比进行中..."
            : `开始对比（${selectedModels.length} 个模型）`}
        </button>
      </div>

      {/* Scoring visualization */}
      {completedResults.length > 0 && (
        <div className="mb-6 rounded-2xl border border-border bg-white p-6">
          <h2 className="mb-4 text-lg font-bold">评分对比</h2>
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Radar chart */}
            <div className="flex items-center justify-center">
              <ScoreRadarChart results={completedResults} />
            </div>

            {/* Score table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 text-left font-medium text-muted">
                      评分维度
                    </th>
                    {completedResults.map((r) => {
                      const model = AI_MODELS.find((m) => m.id === r.modelId);
                      return (
                        <th
                          key={r.modelId}
                          className="py-2 text-center font-medium"
                          style={{ color: model?.color }}
                        >
                          {model?.name}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {SCORE_DIMENSIONS.map((dim) => (
                    <tr key={dim.key} className="border-b border-border/50">
                      <td className="py-2 text-muted">
                        {dim.label}
                        <span className="ml-1 text-xs text-gray-400">
                          ({Math.round(dim.weight * 100)}%)
                        </span>
                      </td>
                      {completedResults.map((r) => (
                        <td key={r.modelId} className="py-2 text-center font-medium">
                          {r.scores?.[dim.key] ?? "-"}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="py-2">加权总分</td>
                    {completedResults.map((r) => (
                      <td key={r.modelId} className="py-2 text-center text-primary">
                        {r.totalScore ?? "-"}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="py-2 text-muted">响应时间</td>
                    {completedResults.map((r) => (
                      <td
                        key={r.modelId}
                        className="py-2 text-center text-xs text-muted"
                      >
                        {(r.responseTime / 1000).toFixed(1)}秒
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Results side by side */}
      {Object.keys(results).length > 0 && (
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${selectedModels.length}, minmax(0, 1fr))` }}>
          {selectedModels.map((modelId) => {
            const result = results[modelId];
            const model = AI_MODELS.find((m) => m.id === modelId);
            if (!result) return null;

            return (
              <div
                key={modelId}
                className="rounded-2xl border border-border bg-white"
              >
                <div
                  className="flex items-center justify-between border-b px-4 py-3"
                  style={{ borderColor: model?.color + "40" }}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: model?.color }}
                    />
                    <span className="text-sm font-bold">{model?.name}</span>
                  </div>
                  {result.status === "loading" && (
                    <span className="text-xs text-muted">生成中...</span>
                  )}
                  {result.status === "scoring" && (
                    <span className="text-xs text-amber-600">评分中...</span>
                  )}
                  {result.status === "done" && result.totalScore && (
                    <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
                      {result.totalScore}分
                    </span>
                  )}
                  {result.status === "done" && result.scoreError && (
                    <span
                      className="text-xs text-red-600"
                      title={result.scoreError}
                    >
                      评分失败
                    </span>
                  )}
                </div>
                <div
                  className="overflow-y-auto p-4"
                  style={{ maxHeight: "400px" }}
                >
                  <div className="prose prose-sm max-w-none">
                    {result.status === "loading" && !result.response && (
                      <div className="flex items-center gap-2 text-sm text-muted">
                        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        生成诊断中...
                      </div>
                    )}
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {result.response}
                    </ReactMarkdown>
                    {(result.status === "loading" || result.status === "scoring") &&
                      result.response && (
                        <span className="inline-block h-4 w-1 animate-pulse bg-primary" />
                      )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
