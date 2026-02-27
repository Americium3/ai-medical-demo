import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MEDICAL_CASES, getCaseById } from "@/data/cases";
import { CaseDetailClient } from "./CaseDetailClient";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const c = getCaseById(id);
  return { title: c ? `${c.title} - ${c.department}` : "病例详情" };
}

export function generateStaticParams() {
  return MEDICAL_CASES.map((c) => ({ id: c.id }));
}

export default async function CaseDetailPage({ params }: Props) {
  const { id } = await params;
  const medicalCase = getCaseById(id);

  if (!medicalCase) {
    notFound();
  }

  return <CaseDetailClient medicalCase={medicalCase} />;
}
