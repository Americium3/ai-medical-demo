import { formatFacts, formatTranscript } from "./grounding";
import type {
  DifferentialOutput,
  Fact,
  PlanOutput,
  RedFlagResult,
  SelfCheckIssue,
  Turn,
} from "./schemas";

const ROLE =
  "你是门诊问诊助手，辅助医生完成问诊。你的输出只供医生参考，不是最终诊断。";

export function intakePrompt(transcript: Turn[]) {
  return {
    system: `${ROLE}
任务：从问诊记录中提取患者明确说过的临床事实，并判断还缺哪些关键信息。
规则：
1. 只提取「患者」说过的内容。问诊助手的问题不是事实。
2. 每条事实的 quote 必须是患者原话中逐字出现的连续片段（可以很短，如「一周」），不得改写、不得拼接。
3. 患者否认的症状（如「没有发烧」）用 category=negative 记录。
4. missing 只列对鉴别诊断真正重要、且患者还没回答过的信息。已经问过但患者说不清楚的，不要再列。
5. 当病程、主要症状特点、伴随症状、相关既往史都已知时，enoughInfo=true。`,
    user: `问诊记录：\n${formatTranscript(transcript)}`,
  };
}

export function redFlagPrompt(facts: Fact[]) {
  return {
    system: `${ROLE}
任务：根据已提取的事实判断风险等级。
- emergency：需要立即急诊处理（如持续胸痛伴大汗、呼吸困难、意识改变、卒中征象、大出血）。
- urgent：需要尽快（24-48 小时内）专科就诊，如活动后胸闷、明显消瘦、高热。
- routine：常规门诊即可。
只能依据给出的事实判断，flags 中的 factIds 必须引用事实列表里的 id。拿不准时选更高的等级。`,
    user: `事实列表：\n${formatFacts(facts)}`,
  };
}

export function askPrompt(transcript: Turn[], missing: { topic: string; why: string }[]) {
  return {
    system: `${ROLE}
任务：像门诊医生一样，提出下一轮追问。
规则：
1. 最多两个问题，优先问对鉴别诊断最关键的信息。
2. 口语化、患者能听懂，不用术语，不要一次问一长串。
3. 不要重复问已经问过的问题。
4. 不要在问题里透露你怀疑的诊断。`,
    user: `问诊记录：\n${formatTranscript(transcript)}\n\n仍缺的信息：\n${missing
      .map((m) => `- ${m.topic}：${m.why}`)
      .join("\n")}`,
  };
}

export function differentialPrompt(
  facts: Fact[],
  redFlag: RedFlagResult | null,
  issues: SelfCheckIssue[],
  previous: DifferentialOutput | null,
) {
  const revision =
    issues.length > 0 && previous
      ? `\n\n上一版被自查打回，请逐条修正：\n${issues
          .map((i) => `- [${i.type}] ${i.detail}`)
          .join("\n")}\n\n上一版：\n${JSON.stringify(previous, null, 2)}`
      : "";
  return {
    system: `${ROLE}
任务：给出初步诊断和鉴别诊断。
规则：
1. 每个诊断的 factIds 只能引用下面事实列表中的 id；推理只能基于这些事实。
2. 信息不足以确定时降低 confidence，不要过度确诊。
3. 鉴别诊断 2-3 个，包括需要排除的严重疾病。
4. 使用规范的中文医学诊断名称。`,
    user: `事实列表：\n${formatFacts(facts)}\n\n风险评估：${
      redFlag ? `${redFlag.level}（${redFlag.reason}）` : "未评估"
    }${revision}`,
  };
}

export function planPrompt(facts: Fact[], dx: DifferentialOutput) {
  return {
    system: `${ROLE}
任务：给出体格检查、辅助检查、初步用药和生活建议。
规则：
1. 检查项目要能帮助确认初步诊断或排除鉴别诊断，写明目的。
2. 用药只给常见一线方案，注明需医师确认，注意患者提到的过敏史和正在用的药。
3. 不给剂量。`,
    user: `事实列表：\n${formatFacts(facts)}\n\n初步诊断：${dx.primary.name}\n鉴别诊断：${dx.differentials
      .map((d) => d.name)
      .join("、")}`,
  };
}

export function selfCheckPrompt(
  facts: Fact[],
  redFlag: RedFlagResult | null,
  dx: DifferentialOutput,
  plan: PlanOutput,
) {
  return {
    system: `你是病历质控医生，负责在病历交给医生前做最后一道检查。
逐条检查：
1. unsupported_claim：诊断推理或建议里是否出现了事实列表中没有的症状、体征、检查结果或病史。
2. overconfident：信息明显不足却给了「高」置信度，或把可能性写成定论。
3. missed_red_flag：事实中存在需要尽快就医的信号，但处置建议没有体现。
4. unsafe_medication：用药与患者提到的过敏史或正在用药冲突，或不适合一线使用。
5. inconsistent：诊断、检查、用药之间自相矛盾。
全部没有问题时 pass=true、issues 为空；否则 pass=false，并在 detail 里具体说明哪句话有问题、怎么改。不要吹毛求疵。`,
    user: `事实列表：\n${formatFacts(facts)}\n\n风险等级：${redFlag?.level ?? "未评估"}\n\n诊断：\n${JSON.stringify(
      dx,
      null,
      2,
    )}\n\n处置计划：\n${JSON.stringify(plan, null, 2)}`,
  };
}

export function patientPrompt(
  profile: { age: number; gender: string; chiefComplaint: string },
  caseDialogue: { role: "doctor" | "patient"; content: string }[],
  transcript: Turn[],
  questions: string[],
) {
  return {
    system: `你在扮演一位来门诊看病的患者（${profile.age}岁，${profile.gender}）。
规则：
1. 只能根据下面「病例资料」里患者说过的内容回答，不要编造新的症状、数字或病史。
2. 病例资料里没有的信息，就说「这个我不太清楚」或「没注意」。
3. 口语化、简短，像普通人说话。不要说出任何医学诊断名。
4. 只回答医生这次问到的问题。

病例资料（医生与你之前的真实对话）：
${caseDialogue.map((d) => `${d.role === "doctor" ? "医生" : "患者"}：${d.content}`).join("\n")}`,
    user: `到目前为止的对话：\n${formatTranscript(transcript)}\n\n医生现在问：${questions.join(" ")}`,
  };
}
