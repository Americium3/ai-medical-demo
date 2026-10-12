import type { RecordTable } from "./record";
import type { NoteOutput } from "./schemas";
import { slotsFor, type Slot, type Template } from "./templates";

const ROLE = "你是门诊预问诊助手，在患者见医生之前帮助收集病史。你的输出只给医生参考，不作诊断结论。";

function recordText(template: Template, record: RecordTable): string {
  return slotsFor(template)
    .map((s) => {
      const e = record[s.id];
      const state = e.status === "answered" ? `已回答：${e.value}（原话「${e.quote}」）` : e.status === "unknown" ? "患者不清楚" : "未问";
      return `${s.id} ${s.label}：${state}`;
    })
    .join("\n");
}

export function extractPrompt(template: Template, record: RecordTable, asked: Slot[], questionText: string, answer: string) {
  return {
    system: `${ROLE}
任务：根据患者这一次的回答，更新问诊记录表。
规则：
1. 只处理患者这一次的回答，不要改动与这次回答无关的要点。
2. 这次问到的要点：${asked.map((s) => `${s.id}（${s.label}）`).join("、")}。患者回答了就标 answered，说不清楚就标 unknown。
3. 患者顺带提到了其他未问的要点，也可以标 answered。
4. quote 必须是患者这次回答中逐字出现的连续片段，不得改写或拼接。
5. 患者没提到的要点不要输出。`,
    user: `当前记录表：\n${recordText(template, record)}\n\n刚才的问题：${questionText}\n患者的回答：${answer}`,
  };
}

export function triagePrompt(template: Template, record: RecordTable, latest: string) {
  return {
    system: `${ROLE}
任务：按急诊预检分诊四级标准判断患者当前的病情等级。
1 濒危：正在或即将发生生命威胁，需立即抢救；
2 危重：病情危重或迅速恶化，不立即处理会危及生命；
3 急症：有潜在生命威胁，需尽快就诊；
4 非急症：病情一般，没有急性发作的危险表现。
只能依据记录表和患者说过的话判断。拿不准时选更紧急的等级。
追问由系统的其他步骤负责，你不要提问。信息很少时也必须按现有信息给出一个等级，并在 reason 里说明信息不足。`,
    user: `记录表：\n${recordText(template, record)}\n\n患者最近说的话：${latest}`,
  };
}

export function phrasePrompt(slots: Slot[], previous: string[]) {
  return {
    system: `${ROLE}
任务：把下面的问诊要点改写成患者听得懂的口语问题，每个要点一个问题，顺序不变。
规则：语气自然、简短，不用医学术语，不要透露你怀疑的疾病，不要和已经问过的问题重复。`,
    user: `要点：\n${slots.map((s) => `- ${s.label}（参考问法：${s.question}）`).join("\n")}\n\n已经问过的问题：\n${previous.join("\n") || "（无）"}`,
  };
}

export function notePrompt(template: Template, record: RecordTable, issues: string[], previous: NoteOutput | null) {
  const revision = issues.length && previous
    ? `\n\n上一版病历草稿未通过检查，请逐条修正：\n${issues.map((i) => `- ${i}`).join("\n")}\n上一版：${JSON.stringify(previous)}`
    : "";
  return {
    system: `${ROLE}
任务：根据问诊记录表，按《病历书写基本规范》写门诊病历草稿中的主诉、现病史和既往史，并给医生列出可能的原因和建议检查。
规则：
1. 每句话都要列出所依据的记录表要点编号（slotIds），只能引用状态为“已回答”的要点。
2. 主诉写主要症状和持续时间，一句话。
3. 不写体格检查、诊断结论和用药，这些由医生完成。
4. 可能的原因只给医生参考，信息不足时要说明。`,
    user: `记录表：\n${recordText(template, record)}${revision}`,
  };
}

export function reviewPrompt(template: Template, record: RecordTable, note: NoteOutput) {
  return {
    system: `你是病历质控医生。检查下面的病历草稿：
1. 主诉、现病史、既往史是否写入了记录表中没有的内容（forDoctor 里的可能原因和建议检查是给医生的推断，按要求必须有，不算此项问题）；
2. 是否把可能性写成了定论；
3. 是否遗漏了需要尽快就医的提示。
全部没有问题时 pass=true、issues 为空。`,
    user: `记录表：\n${recordText(template, record)}\n\n病历草稿：\n${JSON.stringify(note, null, 2)}`,
  };
}
