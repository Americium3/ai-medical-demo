import type { State } from "./graph";
import { slotsFor, type Template } from "./templates";
import { LEVEL_NAME } from "./triage";

const DISCLAIMER = "以上为AI预问诊生成的病历草稿，体格检查、诊断和处置须由接诊医生完成并签名。";

function quotes(s: State, ids: string[]): string {
  const q = ids
    .map((id) => s.record[id]?.quote)
    .filter(Boolean)
    .map((x) => `“${x}”`);
  return q.length ? `（患者原话：${q.join("；")}）` : "";
}

/** The draft record for the doctor, rendered by code from validated structures. */
export function renderNote(template: Template, s: State): string {
  const n = s.note!;
  const lines = (items: { text: string; slotIds: string[] }[]) =>
    items.length ? items.map((i) => `  - ${i.text}${quotes(s, i.slotIds)}`).join("\n") : "  - 未获得";
  const unknown = slotsFor(template)
    .filter((x) => s.record[x.id].status === "unknown")
    .map((x) => x.label);
  const review =
    s.issues.length === 0
      ? s.reviewFailures > 0
        ? `通过（修改${s.reviewFailures}次后）`
        : "通过"
      : `未完全通过，请医生重点复核：\n${s.issues.map((i) => `  - ${i}`).join("\n")}`;

  return [
    "【门诊病历草稿】",
    `主诉：${n.chiefComplaint.text}`,
    "现病史：",
    lines(n.presentIllness),
    "既往史：",
    lines(n.pastHistory),
    `患者表示不清楚的项目：${unknown.join("、") || "无"}`,
    "",
    "【仅供医生参考】",
    `病情分级：${LEVEL_NAME[s.level]}。${s.levelReason}`,
    "可能的原因：",
    ...n.forDoctor.possibleCauses.map((c) => `  - ${c.name}：${c.reasoning}`),
    "建议检查：",
    ...(n.forDoctor.suggestedTests.length ? n.forDoctor.suggestedTests.map((t) => `  - ${t.name}（${t.purpose}）`) : ["  - 无"]),
    `自查结果：${review}`,
    "",
    DISCLAIMER,
  ].join("\n");
}

export function renderEmergency(s: State): string {
  const signs = s.ruleHits.map((h) => `${h.rule}（“${h.quote}”）`);
  return [
    `【危险提示】病情分级：${LEVEL_NAME[s.level]}`,
    "请立即前往最近医院的急诊科，或拨打120。预问诊已停止。",
    `依据：${s.levelReason}${signs.length ? `；命中规则：${signs.join("、")}` : ""}`,
  ].join("\n");
}
