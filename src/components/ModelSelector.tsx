"use client";

import { AI_MODELS, type AIModel } from "@/data/models";

interface ModelSelectorProps {
  selectedModel: string;
  onSelect: (modelId: string) => void;
  compact?: boolean;
}

export function ModelSelector({
  selectedModel,
  onSelect,
  compact = false,
}: ModelSelectorProps) {
  if (compact) {
    return (
      <select
        value={selectedModel}
        onChange={(e) => onSelect(e.target.value)}
        className="rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      >
        {AI_MODELS.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name} ({model.provider})
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {AI_MODELS.map((model: AIModel) => (
        <button
          key={model.id}
          onClick={() => onSelect(model.id)}
          className={`rounded-xl border-2 p-3 text-left transition-all ${
            selectedModel === model.id
              ? "border-primary bg-primary/5 shadow-sm"
              : "border-border hover:border-gray-300"
          }`}
        >
          <div className="flex items-center gap-2">
            <div
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: model.color }}
            />
            <span className="text-sm font-semibold">{model.name}</span>
          </div>
          <div className="mt-1 text-xs text-muted">{model.provider}</div>
          {!compact && (
            <div className="mt-1 text-xs text-muted line-clamp-1">
              {model.description}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
