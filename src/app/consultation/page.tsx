import type { Metadata } from "next";
import { Suspense } from "react";
import { ConsultationClient } from "./ConsultationClient";

export const metadata: Metadata = {
  title: "问诊模拟",
};

export default function ConsultationPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="text-muted">加载中...</div>
        </div>
      }
    >
      <ConsultationClient />
    </Suspense>
  );
}
