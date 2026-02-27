export interface AIModel {
  id: string;
  name: string;
  provider: string;
  gatewayId: string;
  description: string;
  color: string;
}

export const AI_MODELS: AIModel[] = [
  {
    id: "gpt-4o",
    name: "华佗",
    provider: "神农阁",
    gatewayId: "openai/gpt-4o",
    description: "博学多才，擅长疑难杂症综合分析",
    color: "#10a37f",
  },
  {
    id: "gpt-4o-mini",
    name: "扁鹊",
    provider: "神农阁",
    gatewayId: "openai/gpt-4o-mini",
    description: "望闻问切，反应迅速，日常问诊首选",
    color: "#059669",
  },
  {
    id: "claude-sonnet",
    name: "李时珍",
    provider: "本草堂",
    gatewayId: "anthropic/claude-sonnet-4-20250514",
    description: "精于推理，善于从细微症状中辨证施治",
    color: "#d97706",
  },
  {
    id: "deepseek-chat",
    name: "张仲景",
    provider: "伤寒院",
    gatewayId: "deepseek/deepseek-chat",
    description: "深谙经方，对中文病历理解尤为精准",
    color: "#4f46e5",
  },
];

export const DEFAULT_MODEL_ID = "gpt-4o-mini";

export function getModelById(id: string): AIModel | undefined {
  return AI_MODELS.find((m) => m.id === id);
}
