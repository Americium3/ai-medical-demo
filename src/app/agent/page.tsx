import type { Metadata } from "next";
import { AgentClient } from "./AgentClient";

export const metadata: Metadata = {
  title: "问诊 Agent",
};

export default function AgentPage() {
  return <AgentClient />;
}
