"use client";

import { useState, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ModelSelector } from "@/components/ModelSelector";
import { VoiceInput } from "@/components/VoiceInput";
import { MEDICAL_CASES, getCaseById } from "@/data/cases";
import { DEFAULT_MODEL_ID } from "@/data/models";
import { buildConsultationPrompt } from "@/lib/prompts";
import { getMessageText } from "@/lib/utils";

export function ConsultationClient() {
  const searchParams = useSearchParams();
  const caseId = searchParams.get("case");
  const selectedCase = caseId ? getCaseById(caseId) : null;

  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [showRecord, setShowRecord] = useState(false);
  const [generatedRecord, setGeneratedRecord] = useState("");
  const [localMessages, setLocalMessages] = useState<
    { role: "doctor" | "patient"; content: string }[]
  >(selectedCase ? [...selectedCase.dialogueHistory] : []);
  const [inputRole, setInputRole] = useState<"doctor" | "patient">("patient");
  const [inputText, setInputText] = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dialogueEndRef = useRef<HTMLDivElement>(null);

  const { messages, status, sendMessage } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: { model: modelId },
    }),
  });

  const isLoading = status === "streaming" || status === "submitted";

  // Auto-scroll chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    dialogueEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [localMessages]);

  // Update generated record from AI response
  useEffect(() => {
    if (messages.length > 0) {
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      if (lastAssistant) {
        setGeneratedRecord(getMessageText(lastAssistant));
        setShowRecord(true);
      }
    }
  }, [messages]);

  const handleAddDialogue = () => {
    if (!inputText.trim()) return;
    setLocalMessages((prev) => [
      ...prev,
      { role: inputRole, content: inputText.trim() },
    ]);
    setInputText("");
    // Toggle role
    setInputRole((prev) => (prev === "doctor" ? "patient" : "doctor"));
  };

  const handleGenerateRecord = () => {
    if (localMessages.length === 0) return;
    const prompt = buildConsultationPrompt(localMessages);
    sendMessage({ text: prompt });
  };

  const handleLoadCase = (id: string) => {
    const c = getCaseById(id);
    if (c) {
      setLocalMessages([...c.dialogueHistory]);
      setGeneratedRecord("");
      setShowRecord(false);
    }
  };

  const handleVoiceTranscript = (text: string) => {
    setInputText((prev) => prev + text);
  };

  const handleClearDialogue = () => {
    setLocalMessages([]);
    setGeneratedRecord("");
    setShowRecord(false);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Top bar: Model Selector */}
      <div className="mb-6">
        <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">问诊模拟</h1>
            <p className="text-sm text-muted">
              模拟医患对话，AI 实时生成结构化病历
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted">选择模型：</span>
            <ModelSelector
              selectedModel={modelId}
              onSelect={setModelId}
              compact
            />
          </div>
        </div>

        {/* Quick case load */}
        <div className="flex flex-wrap gap-2">
          <span className="flex items-center text-xs text-muted">
            快速加载病例：
          </span>
          {MEDICAL_CASES.map((c) => (
            <button
              key={c.id}
              onClick={() => handleLoadCase(c.id)}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                selectedCase?.id === c.id
                  ? "bg-primary text-white"
                  : "bg-gray-100 text-muted hover:bg-gray-200"
              }`}
            >
              {c.departmentIcon} {c.title}
            </button>
          ))}
        </div>
      </div>

      {/* Main content: Two panels */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Dialogue Panel */}
        <div className="flex flex-col rounded-2xl border border-border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="font-bold text-primary">实录问答</h2>
            <button
              onClick={handleClearDialogue}
              className="text-xs text-muted hover:text-red-500"
            >
              清空对话
            </button>
          </div>

          {/* Dialogue messages */}
          <div className="flex-1 overflow-y-auto p-4" style={{ maxHeight: "500px" }}>
            {localMessages.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted">
                点击上方按钮加载病例，或手动输入对话
              </div>
            ) : (
              <div className="space-y-3">
                {localMessages.map((msg, i) => (
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
                <div ref={dialogueEndRef} />
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="border-t border-border p-4">
            <div className="mb-3 flex gap-2">
              <button
                onClick={() => setInputRole("doctor")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  inputRole === "doctor"
                    ? "bg-primary text-white"
                    : "bg-gray-100 text-muted"
                }`}
              >
                医生
              </button>
              <button
                onClick={() => setInputRole("patient")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  inputRole === "patient"
                    ? "bg-secondary text-white"
                    : "bg-gray-100 text-muted"
                }`}
              >
                患者
              </button>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddDialogue()}
                placeholder={`输入${inputRole === "doctor" ? "医生" : "患者"}对话...`}
                className="flex-1 rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <VoiceInput
                onTranscript={handleVoiceTranscript}
                disabled={isLoading}
              />
              <button
                onClick={handleAddDialogue}
                disabled={!inputText.trim()}
                className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-gray-200 disabled:opacity-50"
              >
                添加
              </button>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={handleGenerateRecord}
                disabled={localMessages.length === 0 || isLoading}
                className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-primary-dark disabled:opacity-50"
              >
                {isLoading ? "生成中..." : "生成病历"}
              </button>
            </div>
          </div>
        </div>

        {/* Right: Medical Record Panel */}
        <div className="flex flex-col rounded-2xl border border-border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="font-bold text-primary">参考病历</h2>
            {generatedRecord && (
              <button
                onClick={() => navigator.clipboard.writeText(generatedRecord)}
                className="text-xs text-muted hover:text-primary"
              >
                复制病历
              </button>
            )}
          </div>

          <div
            className="flex-1 overflow-y-auto p-5"
            style={{ maxHeight: "580px" }}
          >
            {!showRecord && !isLoading ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <div className="text-5xl opacity-30">📋</div>
                <div className="text-sm text-muted">
                  在左侧输入对话后，点击&ldquo;生成病历&rdquo;
                  <br />
                  AI 将自动生成结构化电子病历
                </div>
              </div>
            ) : (
              <div className="prose prose-sm max-w-none">
                {isLoading && !generatedRecord && (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    AI 正在分析对话并生成病历...
                  </div>
                )}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {generatedRecord}
                </ReactMarkdown>
                {isLoading && generatedRecord && (
                  <span className="inline-block h-4 w-1 animate-pulse bg-primary" />
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Expected diagnosis (when loading a case) */}
          {selectedCase && (
            <div className="border-t border-border p-4">
              <details className="text-sm">
                <summary className="cursor-pointer font-medium text-muted hover:text-foreground">
                  查看标准诊断参考
                </summary>
                <div className="mt-3 space-y-2 rounded-lg bg-amber-50 p-3 text-xs">
                  <p>
                    <strong>主要诊断：</strong>
                    {selectedCase.expectedDiagnosis.mainDiagnosis}
                  </p>
                  <p>
                    <strong>鉴别诊断：</strong>
                    {selectedCase.expectedDiagnosis.differentialDiagnosis.join(
                      "、"
                    )}
                  </p>
                  <p>
                    <strong>建议检查：</strong>
                    {selectedCase.expectedDiagnosis.recommendedTests.join("、")}
                  </p>
                  <p>
                    <strong>建议用药：</strong>
                    {selectedCase.expectedDiagnosis.recommendedMedications.join(
                      "、"
                    )}
                  </p>
                </div>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
