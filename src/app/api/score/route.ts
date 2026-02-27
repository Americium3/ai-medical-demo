import { generateText } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { MEDICAL_SCORING_PROMPT } from "@/lib/prompts";

export async function POST(req: Request) {
  const { aiResponse, expectedDiagnosis, chiefComplaint } = await req.json();

  const scoringPrompt = `${MEDICAL_SCORING_PROMPT}

--- 标准答案 ---
主诉：${chiefComplaint}
正确诊断：${expectedDiagnosis.mainDiagnosis}
鉴别诊断：${expectedDiagnosis.differentialDiagnosis.join("、")}
推荐检查：${expectedDiagnosis.recommendedTests.join("、")}
推荐用药：${expectedDiagnosis.recommendedMedications.join("、")}

--- AI生成的诊断结果 ---
${aiResponse}

请对AI的诊断结果进行评分。`;

  const result = await generateText({
    model: gateway("openai/gpt-4o-mini"),
    prompt: scoringPrompt,
    maxOutputTokens: 500,
  });

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const scores = JSON.parse(jsonMatch[0]);
      return Response.json(scores);
    }
  } catch {
    // fallback
  }

  return Response.json({
    accuracy: 75,
    completeness: 70,
    standardization: 72,
    recommendation: 68,
    comments: "评分解析失败，返回默认分数",
  });
}
