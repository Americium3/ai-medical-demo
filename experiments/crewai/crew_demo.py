"""
Phase 1 demo 3 — CrewAI: two role-played agents working one case in sequence.

  问诊医生 (Attending) drafts a structured record from the dialogue.
  审核医生 (Reviewer) removes anything the patient never said, then returns the final record.

With AI_GATEWAY_API_KEY set this calls a real model through Vercel AI Gateway's
OpenAI-compatible endpoint. Without it, a scripted offline LLM stands in so the
crew mechanics (roles, tasks, context passing) can be run anywhere.

  python experiments/crewai/crew_demo.py [case-id]
"""

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

from crewai import LLM, Agent, BaseLLM, Crew, Process, Task  # noqa: E402

CASES = json.loads((Path(__file__).parent / "cases.json").read_text(encoding="utf-8"))


class ScriptedLLM(BaseLLM):
    """Offline stand-in: answers each agent with a fixed, role-appropriate reply."""

    def __init__(self) -> None:
        super().__init__(model="scripted-offline")

    def call(self, messages, tools=None, callbacks=None, available_functions=None,
             from_task=None, from_agent=None, response_model=None, **kwargs):
        text = messages if isinstance(messages, str) else "\n".join(
            str(m.get("content", "")) for m in messages
        )
        if "审核" in text and "草稿" in text:
            answer = ("**审核意见：** 删除了患者未提及的「体温 39.5℃」。\n\n"
                      "**主诉：** 咳嗽、发热一周，伴黄痰\n**初步诊断：** 社区获得性肺炎（待胸片证实）")
        else:
            answer = ("**主诉：** 咳嗽、发热一周，伴黄痰，体温 39.5℃\n"
                      "**初步诊断：** 社区获得性肺炎\n**鉴别诊断：** 急性支气管炎")
        return f"Thought: 我已完成任务。\nFinal Answer: {answer}"

    def supports_function_calling(self) -> bool:
        return False


def make_llm():
    key = os.environ.get("AI_GATEWAY_API_KEY")
    if not key:
        print("(no AI_GATEWAY_API_KEY: using ScriptedLLM)\n")
        return ScriptedLLM()
    # "openai/" selects CrewAI's OpenAI-compatible client; the rest is the
    # Gateway model id. Not verified against the live Gateway from this sandbox.
    return LLM(model="openai/openai/gpt-4o-mini", base_url="https://ai-gateway.vercel.sh/v1",
               api_key=key, temperature=0.2)


def build_crew(case: dict, llm) -> Crew:
    dialogue = "\n".join(
        f"{'医生' if t['role'] == 'doctor' else '患者'}：{t['content']}" for t in case["dialogueHistory"]
    )

    attending = Agent(
        role="问诊医生",
        goal="根据医患对话写出结构化门诊病历和初步诊断",
        backstory="你是经验丰富的全科门诊医生，写病历简洁规范。",
        llm=llm, allow_delegation=False, verbose=False,
    )
    reviewer = Agent(
        role="审核医生",
        goal="确保病历中每一条信息都能在患者原话中找到依据",
        backstory="你是医务处的病历质控医生，对编造和过度诊断零容忍。",
        llm=llm, allow_delegation=False, verbose=False,
    )

    draft = Task(
        description=f"阅读以下医患对话，写出病历草稿（主诉、现病史、初步诊断、鉴别诊断、检查建议）。\n\n{dialogue}",
        expected_output="Markdown 格式的病历草稿",
        agent=attending,
    )
    review = Task(
        description=f"审核上一步的病历草稿。对照原始对话删除患者没有说过的内容，并给出最终病历。\n\n原始对话：\n{dialogue}",
        expected_output="审核意见 + 最终病历（Markdown）",
        agent=reviewer,
        context=[draft],  # the reviewer sees the attending's output
    )
    return Crew(agents=[attending, reviewer], tasks=[draft, review],
                process=Process.sequential, verbose=False)


def main() -> None:
    case_id = sys.argv[1] if len(sys.argv) > 1 else "resp-001"
    case = next(c for c in CASES if c["id"] == case_id)
    crew = build_crew(case, make_llm())
    result = crew.kickoff()
    for i, out in enumerate(result.tasks_output, 1):
        print(f"--- task {i}: {out.agent} ---\n{out.raw}\n")


if __name__ == "__main__":
    main()
