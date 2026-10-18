/**
 * Clinical guideline retrieval for the doctor-facing part of the note (#12).
 *
 * The corpus is a small set of passages, each a short paraphrase of one
 * recommendation from a published guideline, with the document it comes
 * from. They are demo material, not the guideline text: check the original
 * (and its current edition) before relying on any of them.
 *
 * Retrieval is BM25 over character bigrams, which works for Chinese without a
 * tokenizer and runs in-process with no network call. An embedding index
 * (e.g. Bedrock Titan embeddings) can replace `retrieve` behind the same shape.
 */
import { normalize } from "../../shared/safety/grounding";

export interface GuidelineSource {
  title: string;
  org: string;
  year: number;
  url?: string;
}

export interface GuidelinePassage {
  id: string;
  source: GuidelineSource;
  /** What the passage is about, also searched. */
  topic: string;
  text: string;
  /** A test this passage recommends; only the offline mock model reads it. */
  suggests?: { name: string; purpose: string };
}

const ACS: GuidelineSource = { title: "急性冠脉综合征急诊快速诊治指南（2019）", org: "中国医师协会急诊医师分会等", year: 2019 };
const NICE_CHEST: GuidelineSource = {
  title: "Recent-onset chest pain of suspected cardiac origin: assessment and diagnosis (CG95)",
  org: "NICE",
  year: 2016,
  url: "https://www.nice.org.uk/guidance/cg95",
};
const CKS_PALP: GuidelineSource = { title: "Palpitations (Clinical Knowledge Summaries)", org: "NICE", year: 2020, url: "https://cks.nice.org.uk/topics/palpitations/" };
const CV_PREVENTION: GuidelineSource = { title: "中国心血管病一级预防指南", org: "中华医学会心血管病学分会", year: 2020 };
const IBS: GuidelineSource = { title: "2020年中国肠易激综合征专家共识意见", org: "中华医学会消化病学分会胃肠功能性疾病协作组", year: 2020 };
const DIARRHEA: GuidelineSource = { title: "成人急性感染性腹泻诊疗专家共识", org: "中华医学会感染病学分会", year: 2013 };
const NICE_HEAD: GuidelineSource = { title: "Headaches in over 12s: diagnosis and management (CG150)", org: "NICE", year: 2021, url: "https://www.nice.org.uk/guidance/cg150" };
const VERTIGO: GuidelineSource = { title: "眩晕诊治多学科专家共识", org: "中华医学会神经病学分会等", year: 2017 };
const HTN: GuidelineSource = { title: "中国高血压防治指南（2018年修订版）", org: "中国高血压防治指南修订委员会", year: 2018 };
const CAP: GuidelineSource = { title: "中国成人社区获得性肺炎诊断和治疗指南（2016年版）", org: "中华医学会呼吸病学分会", year: 2016 };
const COUGH: GuidelineSource = { title: "咳嗽的诊断与治疗指南（2021）", org: "中华医学会呼吸病学分会哮喘学组", year: 2021 };
const NICE_BACK: GuidelineSource = { title: "Low back pain and sciatica in over 16s: assessment and management (NG59)", org: "NICE", year: 2020, url: "https://www.nice.org.uk/guidance/ng59" };
const T2DM: GuidelineSource = { title: "中国2型糖尿病防治指南（2020年版）", org: "中华医学会糖尿病学分会", year: 2020 };
const THYROID: GuidelineSource = { title: "中国甲状腺功能亢进症和其他原因所致甲状腺毒症诊治指南", org: "中华医学会内分泌学分会等", year: 2022 };

export const GUIDELINES: GuidelinePassage[] = [
  {
    id: "chest-acs-ecg",
    source: ACS,
    topic: "胸痛 胸闷 疑似急性冠脉综合征 心电图 肌钙蛋白",
    text: "疑似急性冠脉综合征的胸痛、胸闷患者，应在首次医疗接触后10分钟内完成12导联心电图，并尽快检测心肌肌钙蛋白（首选高敏肌钙蛋白），必要时复查。",
    suggests: { name: "12导联心电图和心肌肌钙蛋白", purpose: "排查急性冠脉综合征" },
  },
  {
    id: "chest-angina-ctca",
    source: NICE_CHEST,
    topic: "稳定性胸痛 胸闷 活动后加重 上楼 休息缓解 心绞痛 冠状动脉CT",
    text: "与活动相关、休息可缓解的胸痛或胸闷，疑似稳定型心绞痛时，首选冠状动脉CT血管成像（CTCA）作为无创检查。",
    suggests: { name: "冠状动脉CT血管成像", purpose: "评估活动相关胸闷是否为冠心病心绞痛" },
  },
  {
    id: "chest-palpitations-ecg",
    source: CKS_PALP,
    topic: "心悸 心慌 心跳快 心律失常 动态心电图",
    text: "心悸患者应做12导联心电图；症状间断发作、就诊时心电图正常者，可考虑动态心电图（Holter）等长程监测捕捉发作时的心律。",
    suggests: { name: "动态心电图（Holter）", purpose: "捕捉心悸发作时的心律" },
  },
  {
    id: "chest-risk-factors",
    source: CV_PREVENTION,
    topic: "心血管危险因素 高血压 高血脂 糖尿病 吸烟 血脂 血糖",
    text: "评估心血管风险应了解血压、血脂、血糖、吸烟和早发心血管病家族史，并检测血脂和血糖。",
    suggests: { name: "血脂和血糖", purpose: "评估心血管危险因素" },
  },
  {
    id: "abd-ibs-alarm",
    source: IBS,
    topic: "反复腹痛 腹泻 排便习惯改变 报警征象 便血 消瘦 结肠镜",
    text: "反复腹痛伴排便习惯改变者，若有报警征象（如便血、不明原因消瘦、贫血、发热、夜间症状、40岁以上新发症状、结直肠癌家族史），应行结肠镜等检查排除器质性疾病。",
    suggests: { name: "结肠镜", purpose: "有报警征象时排除器质性肠病" },
  },
  {
    id: "abd-diarrhea-stool",
    source: DIARRHEA,
    topic: "急性腹泻 水样便 发热 恶心 呕吐 不洁饮食 粪便常规 粪便培养",
    text: "急性腹泻患者应做粪便常规检查（白细胞、红细胞、潜血）；伴发热、血便或病情较重者，建议做粪便病原学检查（如培养）。",
    suggests: { name: "粪便常规", purpose: "判断腹泻是否为感染性" },
  },
  {
    id: "head-red-flags",
    source: NICE_HEAD,
    topic: "头痛 警示征象 突发剧烈头痛 神经系统体征 意识改变 发热 颈强直 头颅影像",
    text: "头痛伴警示征象（如突发剧烈头痛、局灶神经系统体征、意识改变、发热伴颈项强直、新发头痛伴肿瘤或免疫抑制病史）时需紧急评估，并根据情况做头颅CT或MRI。",
    suggests: { name: "头颅CT或MRI（有警示征象时）", purpose: "排查继发性头痛" },
  },
  {
    id: "head-diary",
    source: NICE_HEAD,
    topic: "反复头痛 偏头痛 紧张型头痛 头痛日记 影像学",
    text: "无警示征象的偏头痛或紧张型头痛，不要仅为让患者放心而做神经影像检查；建议患者记录头痛日记（发作频率、持续时间、诱因、用药）以协助诊断。",
    suggests: { name: "头痛日记", purpose: "记录发作规律和诱因，协助分型" },
  },
  {
    id: "head-vertigo-positional",
    source: VERTIGO,
    topic: "眩晕 头晕 位置性眩晕 转头 起床 变位试验",
    text: "与头位变化相关的短暂眩晕应考虑良性阵发性位置性眩晕，可通过Dix-Hallpike等变位试验协助诊断。",
    suggests: { name: "变位试验（Dix-Hallpike）", purpose: "判断是否为位置性眩晕" },
  },
  {
    id: "head-htn-bp",
    source: HTN,
    topic: "高血压 血压 头痛 头晕 诊室血压 动态血压",
    text: "诊室血压≥140/90 mmHg可诊断高血压，需非同日多次测量确认；必要时做24小时动态血压监测或家庭血压监测。",
    suggests: { name: "血压测量（必要时24小时动态血压）", purpose: "评估头痛头晕是否与血压升高有关" },
  },
  {
    id: "resp-cap-imaging",
    source: CAP,
    topic: "咳嗽 咳痰 黄痰 发热 社区获得性肺炎 胸部影像 血常规",
    text: "社区获得性肺炎的临床诊断依据包括新近出现的咳嗽、咳痰、发热、肺部湿啰音、外周血白细胞异常，以及胸部影像学显示新出现的浸润影；怀疑肺炎时应做胸部影像检查和血常规。",
    suggests: { name: "胸部X线或CT和血常规", purpose: "判断是否为肺炎" },
  },
  {
    id: "resp-cap-crp",
    source: CAP,
    topic: "发热 感染 C反应蛋白 降钙素原 细菌感染",
    text: "C反应蛋白和降钙素原有助于判断细菌感染的可能，并辅助决定是否使用抗菌药物。",
    suggests: { name: "C反应蛋白和降钙素原", purpose: "评估细菌感染可能" },
  },
  {
    id: "resp-cough-duration",
    source: COUGH,
    topic: "咳嗽 病程 急性咳嗽 亚急性咳嗽 慢性咳嗽 胸片",
    text: "咳嗽按病程分为急性（<3周）、亚急性（3～8周）和慢性（>8周）；慢性咳嗽应首先做胸部X线检查。",
    suggests: { name: "胸部X线", purpose: "慢性咳嗽的初始检查" },
  },
  {
    id: "back-imaging",
    source: NICE_BACK,
    topic: "腰痛 腰背痛 坐骨神经痛 下肢放射痛 影像学 MRI",
    text: "非专科机构不要常规为腰痛（伴或不伴坐骨神经痛）安排影像学检查；仅当影像结果可能改变处理方案时，才在专科评估中考虑影像检查。",
    suggests: { name: "暂不常规影像，专科评估后决定是否做MRI", purpose: "避免不必要的影像检查" },
  },
  {
    id: "back-red-flags",
    source: NICE_BACK,
    topic: "腰痛 警示征象 马尾综合征 大小便障碍 鞍区麻木 肿瘤 感染 骨折",
    text: "腰痛需排查严重病因的警示征象，如马尾综合征（大小便障碍、鞍区麻木、双下肢无力）、肿瘤、感染或骨折；疑似马尾综合征需紧急评估。",
    suggests: { name: "神经系统查体", purpose: "排查马尾综合征等严重病因" },
  },
  {
    id: "endo-dm-diagnosis",
    source: T2DM,
    topic: "多饮 多尿 多食 体重下降 消瘦 糖尿病 血糖 糖化血红蛋白",
    text: "有典型糖尿病症状（烦渴多饮、多尿、多食、不明原因体重下降），加随机血糖≥11.1 mmol/L，或空腹血糖≥7.0 mmol/L，或OGTT 2小时血糖≥11.1 mmol/L，或糖化血红蛋白≥6.5%，可诊断糖尿病。",
    suggests: { name: "空腹血糖和糖化血红蛋白", purpose: "判断是否为糖尿病" },
  },
  {
    id: "endo-ketones",
    source: T2DM,
    topic: "糖尿病 体重明显下降 酮症 尿酮体 血酮 1型糖尿病",
    text: "高血糖伴明显体重下降、乏力或恶心呕吐者，应检测尿酮体或血酮，排查糖尿病酮症。",
    suggests: { name: "尿酮体", purpose: "排查糖尿病酮症" },
  },
  {
    id: "endo-thyroid",
    source: THYROID,
    topic: "消瘦 体重下降 心悸 多汗 怕热 甲状腺功能亢进 甲状腺功能",
    text: "出现消瘦、心悸、多汗、怕热等甲状腺毒症表现时，应检测TSH、游离T4和游离T3以评估甲状腺功能。",
    suggests: { name: "甲状腺功能（TSH、FT4、FT3）", purpose: "排查甲亢引起的消瘦" },
  },
];

export interface RetrievalHit {
  passage: GuidelinePassage;
  score: number;
}

function bigrams(text: string): string[] {
  const n = normalize(text);
  const out: string[] = [];
  for (let i = 0; i < n.length - 1; i++) out.push(n.slice(i, i + 2));
  return out;
}

const K1 = 1.2;
const B = 0.75;
const docs = GUIDELINES.map((p) => {
  const terms = bigrams(`${p.topic} ${p.text}`);
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { passage: p, tf, len: terms.length };
});
const avgLen = docs.reduce((n, d) => n + d.len, 0) / docs.length;
const df = new Map<string, number>();
for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);

/** Minimum BM25 score for a passage to count as relevant at all. */
export const MIN_SCORE = 2.5;

/** The top `k` passages for a query, best first. Passages under MIN_SCORE are left out. */
export function retrieve(query: string, k = 4): RetrievalHit[] {
  const terms = new Set(bigrams(query));
  const scored = docs.map((d) => {
    let score = 0;
    for (const t of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = df.get(t)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgLen));
    }
    return { passage: d.passage, score };
  });
  return scored
    .filter((h) => h.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function guidelineById(id: string): GuidelinePassage | undefined {
  return GUIDELINES.find((g) => g.id === id);
}

export function citeSource(s: GuidelineSource): string {
  return `《${s.title}》，${s.org}，${s.year}`;
}
