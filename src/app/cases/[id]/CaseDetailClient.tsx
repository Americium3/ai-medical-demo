"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ModelSelector } from "@/components/ModelSelector";
import type { MedicalCase } from "@/data/cases";
import { DEFAULT_MODEL_ID } from "@/data/models";
import { buildConsultationPrompt } from "@/lib/prompts";
import { getMessageText } from "@/lib/utils";

interface Props {
  medicalCase: MedicalCase;
}

export function CaseDetailClient({ medicalCase: c }: Props) {
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [diagnosis, setDiagnosis] = useState("");
  const [responseTime, setResponseTime] = useState<number | null>(null);
  const startTimeRef = { current: 0 };

  const { messages, status, sendMessage } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: { model: modelId },
    }),
  });

  const isLoading = status === "streaming" || status === "submitted";

  useEffect(() => {
    if (messages.length > 0) {
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      if (lastAssistant) {
        const content = getMessageText(lastAssistant);
        setDiagnosis(content);
        if (status === "ready" && startTimeRef.current > 0) {
          setResponseTime(Date.now() - startTimeRef.current);
          startTimeRef.current = 0;
        }
      }
    }
  }, [messages, status]);

  const handleDiagnose = () => {
    setDiagnosis("");
    setResponseTime(null);
    startTimeRef.current = Date.now();
    const prompt = buildConsultationPrompt(c.dialogueHistory);
    sendMessage({ text: prompt });
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Breadcrumb */}
      <div className="mb-6 flex items-center gap-2 text-sm text-muted">
        <Link href="/cases" className="hover:text-primary">
          案例病例
        </Link>
        <span>/</span>
        <span className="text-foreground">{c.title}</span>
      </div>

      {/* Case header */}
      <div className="mb-6 rounded-2xl border border-border bg-white p-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-3xl">{c.departmentIcon}</span>
          <div>
            <h1 className="text-2xl font-bold">{c.title}</h1>
            <p className="text-sm text-muted">
              {c.department} | {c.patientInfo.name}，{c.patientInfo.age}岁，
              {c.patientInfo.gender}
            </p>
          </div>
          <span
            className={`ml-auto rounded-full px-4 py-1 text-sm font-medium ${c.difficultyColor}`}
          >
            难度：{c.difficulty}
          </span>
        </div>
        <p className="mt-3 rounded-lg bg-gray-50 p-3 text-sm">
          <strong>主诉：</strong>
          {c.chiefComplaint}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Dialogue history */}
        <div className="rounded-2xl border border-border bg-white">
          <div className="border-b border-border px-5 py-3">
            <h2 className="font-bold">对话记录</h2>
          </div>
          <div className="max-h-[500px] space-y-3 overflow-y-auto p-4">
            {c.dialogueHistory.map((msg, i) => (
              <div
                key={i}
                className={`flex gap-3 ${
                  msg.role === "doctor" ? "" : "flex-row-reverse"
                }`}
              >
                <div
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
                    msg.role === "doctor" ? "bg-primary" : "bg-secondary"
                  }`}
                >
                  {msg.role === "doctor" ? "医" : "患"}
                </div>
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm leading-relaxed ${
                    msg.role === "doctor"
                      ? "bg-blue-50 text-slate-800"
                      : "bg-green-50 text-slate-800"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
          </div>

          {/* Expected diagnosis */}
          <div className="border-t border-border p-4">
            <h3 className="mb-2 text-sm font-bold text-amber-700">
              标准诊断参考
            </h3>
            <div className="space-y-1.5 rounded-lg bg-amber-50 p-3 text-xs">
              <p>
                <strong>主要诊断：</strong>
                {c.expectedDiagnosis.mainDiagnosis}
              </p>
              <p>
                <strong>鉴别诊断：</strong>
                {c.expectedDiagnosis.differentialDiagnosis.join("、")}
              </p>
              <p>
                <strong>建议检查：</strong>
                {c.expectedDiagnosis.recommendedTests.join("、")}
              </p>
              <p>
                <strong>建议用药：</strong>
                {c.expectedDiagnosis.recommendedMedications.join("、")}
              </p>
            </div>
          </div>
        </div>

        {/* Right: AI Diagnosis */}
        <div className="rounded-2xl border border-border bg-white">
          <div className="border-b border-border px-5 py-3">
            <h2 className="font-bold text-primary">AI 诊断结果</h2>
          </div>

          <div className="p-4">
            {/* Model selector */}
            <div className="mb-4">
              <p className="mb-2 text-sm font-medium text-muted">
                选择 AI 模型：
              </p>
              <ModelSelector selectedModel={modelId} onSelect={setModelId} />
            </div>

            <button
              onClick={handleDiagnose}
              disabled={isLoading}
              className="mb-4 w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-white transition-all hover:bg-primary-dark disabled:opacity-50"
            >
              {isLoading ? "诊断中..." : "开始 AI 诊断"}
            </button>

            {responseTime !== null && (
              <div className="mb-3 text-xs text-muted">
                响应时间：{(responseTime / 1000).toFixed(1)}秒
              </div>
            )}
          </div>

          <div
            className="overflow-y-auto px-5 pb-5"
            style={{ maxHeight: "400px" }}
          >
            {!diagnosis && !isLoading ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="text-4xl opacity-30">🤖</div>
                <p className="mt-3 text-sm text-muted">
                  选择模型后点击&ldquo;开始 AI 诊断&rdquo;
                </p>
              </div>
            ) : (
              <div className="prose prose-sm max-w-none">
                {isLoading && !diagnosis && (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    AI 正在分析对话并生成诊断...
                  </div>
                )}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {diagnosis}
                </ReactMarkdown>
                {isLoading && diagnosis && (
                  <span className="inline-block h-4 w-1 animate-pulse bg-primary" />
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href={`/consultation?case=${c.id}`}
          className="rounded-lg bg-primary/10 px-6 py-2 text-sm font-medium text-primary hover:bg-primary/20"
        >
          在问诊页面打开
        </Link>
        <Link
          href={`/comparison?case=${c.id}`}
          className="rounded-lg bg-violet-100 px-6 py-2 text-sm font-medium text-violet-700 hover:bg-violet-200"
        >
          多模型对比
        </Link>
        <Link
          href="/cases"
          className="rounded-lg bg-gray-100 px-6 py-2 text-sm font-medium text-muted hover:bg-gray-200"
        >
          返回列表
        </Link>
      </div>
    </div>
  );
}
