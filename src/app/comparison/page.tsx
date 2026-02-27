import type { Metadata } from "next";
import { Suspense } from "react";
import { ComparisonClient } from "./ComparisonClient";

export const metadata: Metadata = {
  title: "模型对比",
};

export default function ComparisonPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="text-muted">加载中...</div>
        </div>
      }
    >
      <ComparisonClient />
    </Suspense>
  );
}
