import Link from "next/link";
import type { MedicalCase } from "@/data/cases";

interface CaseCardProps {
  medicalCase: MedicalCase;
  showAction?: boolean;
}

export function CaseCard({ medicalCase: c, showAction = true }: CaseCardProps) {
  return (
    <div className="rounded-2xl border border-border bg-white p-5 transition-all hover:shadow-lg">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{c.departmentIcon}</span>
          <span className="text-sm font-medium text-muted">{c.department}</span>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${c.difficultyColor}`}
        >
          {c.difficulty}
        </span>
      </div>
      <h3 className="mb-2 text-lg font-bold">{c.title}</h3>
      <p className="mb-3 text-sm text-muted">
        {c.patientInfo.name}，{c.patientInfo.age}岁，
        {c.patientInfo.gender}
      </p>
      <p className="mb-4 text-sm leading-relaxed text-muted">
        主诉：{c.chiefComplaint}
      </p>
      {showAction && (
        <div className="flex gap-2">
          <Link
            href={`/cases/${c.id}`}
            className="flex-1 rounded-lg bg-primary/10 px-4 py-2 text-center text-sm font-medium text-primary transition-colors hover:bg-primary/20"
          >
            查看详情
          </Link>
          <Link
            href={`/consultation?case=${c.id}`}
            className="flex-1 rounded-lg bg-primary px-4 py-2 text-center text-sm font-medium text-white transition-colors hover:bg-primary-dark"
          >
            AI 诊断
          </Link>
        </div>
      )}
    </div>
  );
}
