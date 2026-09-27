import type { AgentLLM, AgentTask, StructuredCall, UsageRecord } from "./llm";
import type {
  AskOutput,
  DifferentialOutput,
  Fact,
  FactCategory,
  IntakeOutput,
  MissingTopic,
  PlanOutput,
  RedFlagOutput,
  SelfCheckOutput,
  Turn,
} from "./schemas";

/**
 * Deterministic, offline stand-in for the LLM.
 *
 * It exists so the whole graph (routing, loops, grounding, streaming, UI) can
 * be tested and demoed without an API key. Its "medicine" is a keyword table
 * covering the demo cases; scores produced with it measure the pipeline, not
 * clinical quality.
 */

type Handler = (context: never, callIndex: number) => unknown;

const REQUIRED_TOPICS: MissingTopic[] = ["onset_duration", "trigger", "associated", "history", "allergy"];

const TOPIC_QUESTIONS: Record<MissingTopic, string> = {
  onset_duration: "这个情况大概持续多久了？",
  character: "能具体说说是什么样的感觉吗？",
  trigger: "有没有什么诱因，或者什么情况下会加重？",
  associated: "除了这些，还有没有别的不舒服？",
  history: "以前有没有什么病史，比如高血压、糖尿病？",
  medication: "现在有在吃什么药吗？",
  allergy: "有没有对什么药物过敏？",
  family_social: "家里人有类似的病吗？抽烟喝酒吗？",
};

const TOPIC_ASKED: Record<MissingTopic, RegExp> = {
  onset_duration: /多久|多长时间|什么时候/,
  character: /什么样的感觉|具体说说/,
  trigger: /诱因|加重/,
  associated: /别的不舒服|其他/,
  history: /病史/,
  medication: /吃什么药/,
  allergy: /过敏/,
  family_social: /家里人|抽烟/,
};

const TOPIC_CATEGORIES: Record<MissingTopic, FactCategory[]> = {
  onset_duration: ["onset_duration"],
  character: ["character"],
  trigger: ["trigger"],
  associated: ["associated", "negative"],
  history: ["history", "medication"],
  medication: ["medication"],
  allergy: ["allergy"],
  family_social: ["family_social"],
};

const DURATION = /([0-9]+|[一二两三四五六七八九十几半多]+)\s*(个)?(多)?(天|周|星期|月|年|小时)|最近|前天|上周/;

function categorize(clause: string, isFirst: boolean): FactCategory {
  if (/过敏/.test(clause)) return "allergy";
  if (/^(没有|没|无|不)/.test(clause) || /没有(发烧|发热|肿|被)/.test(clause)) return "negative";
  if (/父亲|母亲|家里|抽烟|喝酒|一天一包/.test(clause)) return "family_social";
  if (/降压药|吃着|吃了.*药/.test(clause)) return "medication";
  if (/病史|高血压|糖尿病|以前|之前有|血脂/.test(clause)) return "history";
  if (/吃了|淋了雨|搬|压力|劳累|上楼|走快|诱发|犯|打喷嚏/.test(clause)) return "trigger";
  if (isFirst) return "chief_complaint";
  if (DURATION.test(clause)) return "onset_duration";
  if (/跳着|闷|放射|延伸|位置|太阳穴|周围/.test(clause)) return "character";
  return "associated";
}

function splitClauses(text: string): string[] {
  return text
    .split(/[，。！？,.!?；;\n]/)
    .map((c) => c.replace(/^(医生)?(您好|你好)?/, "").trim())
    .filter((c) => c.length >= 2 && !/^(医生|您好|你好|嗯|对)$/.test(c));
}

function mockIntake(ctx: { transcript: Turn[] }): IntakeOutput {
  const facts: IntakeOutput["facts"] = [];
  const patientTurns = ctx.transcript.filter((t) => t.role === "patient");
  patientTurns.forEach((turn, ti) => {
    splitClauses(turn.content).forEach((clause, ci) => {
      if (/不太清楚|没注意|不知道/.test(clause)) return;
      facts.push({
        category: categorize(clause, ti === 0 && ci === 0),
        statement: clause,
        quote: clause,
      });
    });
  });

  const asked = ctx.transcript.filter((t) => t.role === "agent").map((t) => t.content).join(" ");
  const missing = REQUIRED_TOPICS.filter(
    (topic) =>
      !facts.some((f) => TOPIC_CATEGORIES[topic].includes(f.category)) &&
      !(topic === "onset_duration" && facts.some((f) => DURATION.test(f.quote))) &&
      !TOPIC_ASKED[topic].test(asked),
  ).map((topic) => ({ topic, why: "mock: 必问项尚未覆盖" }));

  return { facts, missing, enoughInfo: missing.length === 0 };
}

function mockAsk(ctx: { missing: IntakeOutput["missing"] }): AskOutput {
  const questions = ctx.missing.slice(0, 2).map((m) => TOPIC_QUESTIONS[m.topic]);
  return {
    questions: questions.length ? questions : ["还有什么想补充的吗？"],
    rationale: "mock: 按必问项顺序追问",
  };
}

function mockRedFlag(): RedFlagOutput {
  return { level: "routine", flags: [], reason: "mock 模型不做风险判断，风险等级由规则兜底" };
}

const KNOWLEDGE: {
  keywords: RegExp;
  primary: string;
  differentials: string[];
  tests: string[];
  medications: string[];
}[] = [
  { keywords: /咳嗽|痰|发烧|发热|淋了雨/, primary: "社区获得性肺炎", differentials: ["急性支气管炎", "上呼吸道感染"], tests: ["血常规", "C反应蛋白", "胸部X线"], medications: ["阿莫西林克拉维酸钾", "氨溴索"] },
  { keywords: /拉肚子|腹泻|水样便|肚子疼|腹痛|生蚝/, primary: "急性胃肠炎", differentials: ["细菌性痢疾", "食物中毒"], tests: ["血常规", "大便常规+培养", "电解质"], medications: ["蒙脱石散", "口服补液盐"] },
  { keywords: /胸闷|心跳|心悸|闷痛|高血压|冠心病/, primary: "冠状动脉粥样硬化性心脏病", differentials: ["心律失常", "高血压性心脏病"], tests: ["心电图", "心脏超声", "血脂全套"], medications: ["阿司匹林", "阿托伐他汀"] },
  { keywords: /头疼|头痛|头晕|太阳穴|怕光|闪光/, primary: "偏头痛", differentials: ["紧张型头痛", "颅内占位"], tests: ["头颅MRI"], medications: ["布洛芬"] },
  { keywords: /腰疼|腰痛|腰背|腿|屁股|打喷嚏/, primary: "腰椎间盘突出症", differentials: ["腰肌劳损", "腰椎管狭窄"], tests: ["腰椎MRI", "腰椎X线"], medications: ["塞来昔布", "甲钴胺"] },
  { keywords: /多饮|多尿|体重下降|口渴|喝很多水|厕所|瘦了|饭量/, primary: "2型糖尿病", differentials: ["1型糖尿病", "甲状腺功能亢进"], tests: ["空腹血糖", "糖化血红蛋白", "OGTT"], medications: ["二甲双胍"] },
];

function bestEntry(facts: Fact[]) {
  const scored = KNOWLEDGE.map((k) => ({
    k,
    ids: facts.filter((f) => k.keywords.test(f.quote)).map((f) => f.id),
  })).sort((a, b) => b.ids.length - a.ids.length);
  return scored[0].ids.length > 0 ? scored[0] : null;
}

function mockDifferential(ctx: { facts: Fact[] }): DifferentialOutput {
  const best = bestEntry(ctx.facts);
  if (!best) {
    return {
      primary: { name: "待明确", confidence: "低", reasoning: "mock: 关键词表未覆盖", factIds: ctx.facts.slice(0, 1).map((f) => f.id) },
      differentials: [{ name: "需进一步问诊", reasoning: "mock", factIds: [] }],
    };
  }
  return {
    primary: { name: best.k.primary, confidence: "中", reasoning: "mock: 按关键词匹配", factIds: best.ids },
    differentials: best.k.differentials.map((name) => ({ name, reasoning: "mock: 需排除", factIds: best.ids.slice(0, 1) })),
  };
}

function mockPlan(ctx: { facts: Fact[] }): PlanOutput {
  const best = bestEntry(ctx.facts);
  return {
    physicalExam: ["生命体征", "专科查体"],
    tests: (best?.k.tests ?? ["血常规"]).map((name) => ({ name, purpose: "mock: 协助诊断" })),
    medications: (best?.k.medications ?? []).map((name) => ({ name, note: "需医师确认" })),
    advice: ["注意休息，如症状加重请及时就诊"],
  };
}

function mockSelfCheck(): SelfCheckOutput {
  return { pass: true, issues: [] };
}

const DEFAULT_HANDLERS: Partial<Record<AgentTask, Handler>> = {
  intake: mockIntake as Handler,
  red_flag: mockRedFlag as Handler,
  ask: mockAsk as Handler,
  differential: mockDifferential as Handler,
  plan: mockPlan as Handler,
  self_check: mockSelfCheck as Handler,
};

/**
 * @param overrides replace a task's behaviour, e.g. make self_check fail on
 *   its first call to exercise the revision loop. `callIndex` counts calls
 *   to that task, starting at 0.
 */
export function createMockLLM(
  overrides: Partial<Record<AgentTask, (context: never, callIndex: number) => unknown>> = {},
): AgentLLM {
  const usage: UsageRecord[] = [];
  const counts: Partial<Record<AgentTask, number>> = {};
  return {
    kind: "mock",
    model: "mock",
    usage,
    async invoke<T>(call: StructuredCall<T>): Promise<T> {
      const handler = overrides[call.task] ?? DEFAULT_HANDLERS[call.task];
      if (!handler) throw new Error(`mock LLM has no handler for ${call.task}`);
      const n = counts[call.task] ?? 0;
      counts[call.task] = n + 1;
      const out = handler(call.context as never, n);
      usage.push({ task: call.task, inputTokens: 0, outputTokens: 0, ms: 0 });
      // Validate like a real structured-output call would.
      return call.schema.parse(out);
    },
  };
}
