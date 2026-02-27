export interface ScoreDimension {
  key: string;
  label: string;
  weight: number;
  description: string;
}

export const SCORE_DIMENSIONS: ScoreDimension[] = [
  {
    key: "accuracy",
    label: "诊断准确性",
    weight: 0.3,
    description: "主要诊断和鉴别诊断是否准确",
  },
  {
    key: "completeness",
    label: "病历完整性",
    weight: 0.25,
    description: "病历各项内容是否完整",
  },
  {
    key: "speed",
    label: "响应速度",
    weight: 0.15,
    description: "生成诊断结果的速度",
  },
  {
    key: "standardization",
    label: "医学规范性",
    weight: 0.2,
    description: "是否符合医学术语和诊疗规范",
  },
  {
    key: "recommendation",
    label: "建议合理性",
    weight: 0.1,
    description: "检查和用药建议是否合理",
  },
];

export interface ModelScore {
  modelId: string;
  scores: Record<string, number>;
  totalScore: number;
  responseTime: number;
}

export function calculateTotalScore(
  scores: Record<string, number>
): number {
  let total = 0;
  for (const dim of SCORE_DIMENSIONS) {
    total += (scores[dim.key] || 0) * dim.weight;
  }
  return Math.round(total * 10) / 10;
}
