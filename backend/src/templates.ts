/**
 * History-taking templates (DESIGN.md §7.1).
 *
 * Every consultation uses the general symptom points (onset, character,
 * triggers, associated symptoms, history...) plus the points of the template
 * that matches the chief complaint. Slot kinds drive the planner's order:
 * red-flag screening first, then fields the record requires, then questions
 * that separate likely causes, then optional detail.
 */

export type SlotKind = "redflag" | "required" | "discriminating" | "optional";

export interface Slot {
  id: string;
  /** Short name used in the record table and the note. */
  label: string;
  /** Default wording, used when the model is not asked to rephrase. */
  question: string;
  kind: SlotKind;
  /** Words that suggest an answer touches this slot (used by the offline mock). */
  keywords: RegExp;
}

export interface Template {
  id: string;
  name: string;
  /** Matched against the chief complaint. */
  match: RegExp;
  slots: Slot[];
}

const GENERAL: Slot[] = [
  { id: "onset", label: "起病时间与病程", question: "这个情况是什么时候开始的？持续多久了？", kind: "required", keywords: /天|周|星期|月|年|小时|最近|开始/ },
  { id: "character", label: "症状性质与程度", question: "能具体说说是什么样的感觉吗？严重到什么程度？", kind: "required", keywords: /疼|痛|闷|胀|酸|麻|晕|厉害|轻|重/ },
  { id: "triggers", label: "诱因与加重因素", question: "有没有什么诱因？什么情况下会加重？", kind: "discriminating", keywords: /诱因|加重|吃了|受凉|淋雨|劳累|上楼|走快|压力|搬/ },
  { id: "relief", label: "缓解因素", question: "做什么能让它好一些？", kind: "optional", keywords: /缓解|好一些|好点|休息/ },
  { id: "associated", label: "伴随症状", question: "除了这些，还有没有别的不舒服？", kind: "required", keywords: /还有|伴|同时|另外|恶心|发烧|发热|头晕/ },
  { id: "pmh", label: "既往病史", question: "以前有没有什么病，比如高血压、糖尿病？", kind: "required", keywords: /病史|高血压|糖尿病|以前|之前|血脂|手术/ },
  { id: "meds", label: "正在用的药", question: "现在有在吃什么药吗？", kind: "optional", keywords: /药/ },
  { id: "allergy", label: "过敏史", question: "有没有对什么药物或食物过敏？", kind: "required", keywords: /过敏/ },
];

export const TEMPLATES: Template[] = [
  {
    id: "chest",
    name: "胸痛/胸闷/心悸",
    match: /胸|心悸|心慌|心跳/,
    slots: [
      { id: "rf_chest_sweat", label: "是否伴大汗或呼吸困难", question: "胸口不舒服的时候，有没有出大汗，或者喘不上气？", kind: "redflag", keywords: /汗|喘|呼吸困难/ },
      { id: "rf_chest_rest", label: "休息时是否持续不缓解", question: "休息的时候会不会也一直痛，二十分钟以上都不缓解？", kind: "redflag", keywords: /休息|不缓解|一直/ },
      { id: "exertion", label: "与活动的关系", question: "是不是上楼、走快了的时候更明显？", kind: "discriminating", keywords: /上楼|走快|活动|运动/ },
      { id: "cv_risk", label: "心血管危险因素", question: "有没有高血压、高血脂、糖尿病？抽烟吗？", kind: "discriminating", keywords: /高血压|血脂|糖尿病|抽烟|吸烟/ },
      { id: "family_cv", label: "心脏病家族史", question: "家里人有没有得过心脏病？", kind: "optional", keywords: /父亲|母亲|家里|家族/ },
    ],
  },
  {
    id: "abdomen",
    name: "腹痛/腹泻/恶心",
    match: /腹|肚子|拉肚|腹泻|呕|恶心/,
    slots: [
      { id: "rf_gi_bleed", label: "是否呕血或黑便", question: "有没有吐血，或者大便发黑？", kind: "redflag", keywords: /血|黑/ },
      { id: "rf_abd_severe", label: "是否剧烈腹痛持续不缓解", question: "肚子疼得厉害吗？有没有疼得一直缓解不了？", kind: "redflag", keywords: /厉害|剧烈|缓解/ },
      { id: "diet", label: "饮食情况", question: "发病前吃过什么不太干净或者特别的东西吗？", kind: "discriminating", keywords: /吃|喝|烧烤|海鲜|生/ },
      { id: "stool", label: "大便次数与性状", question: "一天拉几次？大便是什么样的？", kind: "discriminating", keywords: /次|水样|稀|粘液|大便/ },
      { id: "fever", label: "是否发热", question: "有没有发烧？", kind: "discriminating", keywords: /烧|热|度/ },
    ],
  },
  {
    id: "head",
    name: "头痛/头晕",
    match: /头/,
    slots: [
      { id: "rf_head_worst", label: "是否突发最剧烈头痛", question: "这次头痛是不是突然发作、这辈子最厉害的一次？", kind: "redflag", keywords: /突然|最厉害|从来没有/ },
      { id: "rf_neuro", label: "是否有口角歪斜、肢体无力或说话不清", question: "有没有嘴歪、一边手脚没力气，或者说话不清楚？", kind: "redflag", keywords: /嘴|无力|说话|麻/ },
      { id: "head_site", label: "头痛部位", question: "主要是头的哪个位置疼？", kind: "discriminating", keywords: /太阳穴|后脑|额头|一侧|整个/ },
      { id: "photophobia", label: "是否怕光怕声", question: "疼的时候怕不怕光、怕不怕吵？", kind: "discriminating", keywords: /光|声|吵/ },
    ],
  },
  {
    id: "respiratory",
    name: "咳嗽/发热",
    match: /咳|发热|发烧|咽|喉|痰/,
    slots: [
      { id: "rf_dyspnea", label: "是否呼吸困难", question: "有没有喘不上气、呼吸困难的感觉？", kind: "redflag", keywords: /喘|呼吸困难|憋/ },
      { id: "fever_max", label: "最高体温", question: "发烧最高到多少度？", kind: "discriminating", keywords: /度|℃/ },
      { id: "sputum", label: "痰的情况", question: "有痰吗？是什么颜色的？", kind: "discriminating", keywords: /痰|黄|白|绿/ },
      { id: "exposure", label: "受凉或接触史", question: "最近有没有受凉，或者接触过感冒的人？", kind: "optional", keywords: /受凉|淋雨|接触|感冒/ },
    ],
  },
];

const FALLBACK: Template = { id: "general", name: "通用", match: /.*/, slots: [] };

/** Pick the first template whose pattern matches the complaint. */
export function chooseTemplate(complaint: string): Template {
  return TEMPLATES.find((t) => t.match.test(complaint)) ?? FALLBACK;
}

/** The full slot list for a consultation: template slots first, then general ones. */
export function slotsFor(template: Template): Slot[] {
  return [...template.slots, ...GENERAL];
}

export function templateById(id: string): Template {
  return TEMPLATES.find((t) => t.id === id) ?? FALLBACK;
}

export function findSlot(template: Template, id: string): Slot | undefined {
  return slotsFor(template).find((s) => s.id === id);
}
