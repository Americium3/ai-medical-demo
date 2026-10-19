import type { ConsultationStateT } from "./graph";

/** Display metadata for each graph node, shared by the UI and docs. */
export const NODE_INFO: Record<string, { label: string; icon: string }> = {
  intake: { label: "信息提取", icon: "📥" },
  red_flag: { label: "危险信号", icon: "🚩" },
  ask: { label: "追问", icon: "❓" },
  patient: { label: "模拟患者", icon: "🧑" },
  diagnose: { label: "鉴别诊断", icon: "🩺" },
  care_plan: { label: "处置计划", icon: "💊" },
  self_check: { label: "自查", icon: "🔍" },
  write_report: { label: "生成病历", icon: "📋" },
};

const LEVEL_LABEL = { routine: "常规", urgent: "尽快就诊", emergency: "急诊" } as const;

/** One human-readable line describing what a node just did. */
export function summarizeUpdate(node: string, u: Partial<ConsultationStateT>): string {
  switch (node) {
    case "intake": {
      const facts = u.facts?.length ?? 0;
      const dropped = u.droppedFacts?.length ?? 0;
      const missing = u.missing?.map((m) => m.topic).join("、");
      return [
        `提取 ${facts} 条有原话依据的事实`,
        dropped ? `丢弃 ${dropped} 条找不到原话的` : "",
        u.enoughInfo ? "信息已足够" : `仍缺：${missing || "—"}`,
      ]
        .filter(Boolean)
        .join("；");
    }
    case "red_flag": {
      const r = u.redFlag;
      if (!r) return "";
      const flags = [...r.flags.map((f) => f.name), ...r.ruleHits.map((h) => `规则:${h.rule}`)];
      return `风险：${LEVEL_LABEL[r.level]}${flags.length ? `（${flags.join("、")}）` : ""}`;
    }
    case "ask":
      return `问：${u.pendingQuestions?.join(" / ") ?? ""}`;
    case "patient":
      return `答：${u.transcript?.at(-1)?.content ?? ""}`;
    case "diagnose": {
      const d = u.differential;
      if (!d) return "";
      return `初步：${d.primary.name}（${d.primary.confidence}）；鉴别：${d.differentials
        .map((x) => x.name)
        .join("、")}`;
    }
    case "care_plan":
      return `检查 ${u.plan?.tests.length ?? 0} 项，用药 ${u.plan?.medications.length ?? 0} 项`;
    case "self_check":
      return u.selfCheckPassed
        ? "✅ 通过"
        : `❌ 打回：${u.issues?.map((i) => `[${i.type}] ${i.detail}`).join("；") ?? ""}`;
    case "write_report":
      return u.status === "emergency" ? "🚨 急诊提示，问诊中止" : "病历已生成";
    default:
      return "";
  }
}
