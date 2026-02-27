"use client";

import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { SCORE_DIMENSIONS } from "@/data/scoring";
import { AI_MODELS } from "@/data/models";

interface ModelResult {
  modelId: string;
  scores: Record<string, number> | null;
  totalScore: number | null;
}

interface ScoreRadarChartProps {
  results: ModelResult[];
}

export function ScoreRadarChart({ results }: ScoreRadarChartProps) {
  const data = SCORE_DIMENSIONS.map((dim) => {
    const entry: Record<string, string | number> = {
      dimension: dim.label,
    };
    for (const r of results) {
      entry[r.modelId] = r.scores?.[dim.key] ?? 0;
    }
    return entry;
  });

  return (
    <ResponsiveContainer width="100%" height={350}>
      <RadarChart data={data} cx="50%" cy="50%" outerRadius="75%">
        <PolarGrid />
        <PolarAngleAxis
          dataKey="dimension"
          tick={{ fontSize: 12, fill: "#64748b" }}
        />
        <PolarRadiusAxis
          angle={90}
          domain={[0, 100]}
          tick={{ fontSize: 10, fill: "#94a3b8" }}
        />
        {results.map((r) => {
          const model = AI_MODELS.find((m) => m.id === r.modelId);
          return (
            <Radar
              key={r.modelId}
              name={model?.name ?? r.modelId}
              dataKey={r.modelId}
              stroke={model?.color ?? "#888"}
              fill={model?.color ?? "#888"}
              fillOpacity={0.15}
              strokeWidth={2}
            />
          );
        })}
        <Legend
          wrapperStyle={{ fontSize: 12 }}
        />
      </RadarChart>
    </ResponsiveContainer>
  );
}
