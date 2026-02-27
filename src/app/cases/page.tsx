import type { Metadata } from "next";
import { MEDICAL_CASES } from "@/data/cases";
import { CaseCard } from "@/components/CaseCard";

export const metadata: Metadata = {
  title: "案例病例",
};

export default function CasesPage() {
  const departments = [...new Set(MEDICAL_CASES.map((c) => c.department))];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold sm:text-3xl">案例病例库</h1>
        <p className="mt-2 text-muted">
          覆盖多个科室的典型病例，可直接加载进行 AI 诊断和模型对比
        </p>
      </div>

      {/* Department filter pills */}
      <div className="mb-6 flex flex-wrap gap-2">
        <span className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-white">
          全部（{MEDICAL_CASES.length}）
        </span>
        {departments.map((dept) => (
          <span
            key={dept}
            className="rounded-full bg-gray-100 px-4 py-1.5 text-sm font-medium text-muted"
          >
            {dept}（{MEDICAL_CASES.filter((c) => c.department === dept).length}）
          </span>
        ))}
      </div>

      {/* Case grid */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {MEDICAL_CASES.map((c) => (
          <CaseCard key={c.id} medicalCase={c} />
        ))}
      </div>
    </div>
  );
}
