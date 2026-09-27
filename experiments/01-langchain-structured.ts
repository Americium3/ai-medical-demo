/**
 * Phase 1 demo 1 — LangChain.js: prompt template → chat model → structured output.
 *
 * With AI_GATEWAY_API_KEY set it calls a real model through Vercel AI Gateway's
 * OpenAI-compatible endpoint. Without it, a FakeListChatModel returns a canned
 * reply so the pipeline still runs offline.
 *
 *   npx tsx experiments/01-langchain-structured.ts
 */
import { z } from "zod";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { ChatOpenAI } from "@langchain/openai";
import { MEDICAL_CASES } from "../src/data/cases";

// 1) The schema is the contract. LangChain turns it into a tool/JSON schema
//    for the model and validates the reply against it.
const Facts = z.object({
  chiefComplaint: z.string().describe("主诉，一句话"),
  duration: z.string().nullable().describe("病程，未提及则为 null"),
  symptoms: z.array(z.string()).describe("患者明确说过的症状"),
  allergies: z.string().nullable(),
});

// 2) Prompt template with variables, reusable across cases.
const prompt = ChatPromptTemplate.fromMessages([
  ["system", "你是问诊助手。只提取患者明确说过的信息，不要推测。"],
  ["human", "医患对话：\n{dialogue}"],
]);

function makeModel() {
  if (process.env.AI_GATEWAY_API_KEY) {
    return new ChatOpenAI({
      model: "openai/gpt-4o-mini",
      apiKey: process.env.AI_GATEWAY_API_KEY,
      configuration: { baseURL: "https://ai-gateway.vercel.sh/v1" },
      temperature: 0,
    });
  }
  console.log("(no AI_GATEWAY_API_KEY: using FakeListChatModel)\n");
  return new FakeListChatModel({
    responses: [
      JSON.stringify({
        chiefComplaint: "咳嗽发热一周",
        duration: "一周",
        symptoms: ["咳嗽", "发热", "黄痰", "胸闷"],
        allergies: "无",
      }),
    ],
  });
}

async function main() {
  const model = makeModel();
  // 3) withStructuredOutput: real models use tool calling; the fake model
  //    only emits text, so it uses JSON mode.
  const structured =
    model instanceof ChatOpenAI
      ? model.withStructuredOutput(Facts, { name: "extract_facts", method: "functionCalling" })
      : model.withStructuredOutput(Facts, { method: "jsonMode" });

  // 4) LCEL: pipe the prompt into the model. The chain is a Runnable,
  //    so it also supports .batch(), .stream(), retries and callbacks.
  const chain = prompt.pipe(structured);

  const c = MEDICAL_CASES[0];
  const dialogue = c.dialogueHistory
    .map((d) => `${d.role === "doctor" ? "医生" : "患者"}：${d.content}`)
    .join("\n");

  const facts = await chain.invoke({ dialogue });
  console.log("typed result:", facts);
  console.log("symptom count:", facts.symptoms.length);
}

main();
