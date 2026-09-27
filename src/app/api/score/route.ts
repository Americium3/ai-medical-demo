import { gateway } from "@ai-sdk/gateway";
import { scoreDiagnosis, ScoringError } from "@/lib/scoring";

export async function POST(req: Request) {
  const { aiResponse, expectedDiagnosis, chiefComplaint } = await req.json();

  if (
    typeof aiResponse !== "string" ||
    typeof chiefComplaint !== "string" ||
    !expectedDiagnosis?.mainDiagnosis
  ) {
    return Response.json(
      { error: "Missing aiResponse, chiefComplaint or expectedDiagnosis." },
      { status: 400 },
    );
  }

  if (!process.env.AI_GATEWAY_API_KEY) {
    return Response.json(
      {
        error:
          "Missing AI_GATEWAY_API_KEY. Please configure it in local .env.local or Vercel Environment Variables.",
      },
      { status: 500 },
    );
  }

  try {
    const scores = await scoreDiagnosis(
      { chiefComplaint, expectedDiagnosis },
      aiResponse,
      gateway("openai/gpt-4o-mini"),
    );
    return Response.json(scores);
  } catch (err) {
    // Previously this returned a fixed set of default scores, which made a
    // failed judge indistinguishable from a real 70-ish result.
    const message = err instanceof ScoringError ? err.message : "评分失败";
    return Response.json({ error: message }, { status: 502 });
  }
}
