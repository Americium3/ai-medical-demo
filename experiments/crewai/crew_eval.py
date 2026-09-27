"""
Phase 5 — the same consultation task written the CrewAI way, scored with the
same judge prompt as scripts/eval-agent.ts, so the two frameworks can be compared.

Two crews:
  crew_full       问诊医生 writes a record from the full dialogue, 审核医生 reviews it.
                  (CrewAI counterpart of condition A, plus a review step.)
  crew_interview  问诊医生 only gets the chief complaint and must interview a
                  「患者」 agent through CrewAI's built-in delegation tool
                  ("Ask question to coworker"); 审核医生 then reviews.
                  (CrewAI counterpart of condition C, the LangGraph agent.)

  python experiments/crewai/crew_eval.py --offline          # scripted LLM, checks the wiring
  AI_GATEWAY_API_KEY=... python experiments/crewai/crew_eval.py --runs 3

Results go to docs/agent/eval/crewai-<tag>.json and a markdown summary.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
from pathlib import Path

os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

from crewai import LLM, Agent, BaseLLM, Crew, Process, Task  # noqa: E402

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
CASES = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
PROMPTS = json.loads((HERE / "prompts.json").read_text(encoding="utf-8"))
GATEWAY = "https://ai-gateway.vercel.sh/v1"
MAX_QUESTIONS = 5


def dialogue_text(case: dict) -> str:
    return "\n".join(
        f"{'医生' if t['role'] == 'doctor' else '患者'}：{t['content']}" for t in case["dialogueHistory"]
    )


def opening_line(case: dict) -> str:
    return f"医生您好，我{case['chiefComplaint']}。"


# ---------------------------------------------------------------- offline LLM

class ScriptedLLM(BaseLLM):
    """
    Offline stand-in that speaks CrewAI's ReAct text protocol. The doctor asks
    the patient agent once through the delegation tool, then answers; the
    patient replies from the case dialogue; the reviewer passes the draft on.
    Checks that the crew wiring (roles, delegation, context) works — no medicine.
    """

    case: dict = {}

    def __init__(self, case: dict) -> None:
        super().__init__(model="scripted-offline")
        self.case = case

    def call(self, messages, tools=None, callbacks=None, available_functions=None,
             from_task=None, from_agent=None, response_model=None, **kwargs):
        text = messages if isinstance(messages, str) else "\n".join(
            str(m.get("content", "")) for m in messages
        )
        role = getattr(from_agent, "role", "")
        if role == "患者":
            answers = [t["content"] for t in self.case["dialogueHistory"] if t["role"] == "patient"]
            return f"Thought: 我按实际情况回答。\nFinal Answer: {answers[1] if len(answers) > 1 else '不太清楚'}"
        # "Observation:" is part of CrewAI's own format instructions, so look for
        # our own earlier thought to know whether the question was already asked.
        if role == "问诊医生" and "Ask question to coworker" in text and "我需要先问患者" not in text:
            action_input = json.dumps(
                {"question": "这个情况多久了？还有别的不舒服吗？", "context": "门诊问诊", "coworker": "患者"},
                ensure_ascii=False,
            )
            return f"Thought: 我需要先问患者。\nAction: Ask question to coworker\nAction Input: {action_input}"
        if role == "审核医生":
            return "Thought: 草稿无编造内容。\nFinal Answer: **审核意见：** 通过。\n\n**初步诊断：** 待明确"
        return ("Thought: 我已收集到足够信息。\nFinal Answer: **主诉：** "
                f"{self.case['chiefComplaint']}\n**初步诊断：** 待明确\n**鉴别诊断：** —")

    def supports_function_calling(self) -> bool:
        return False


def make_llm(offline: bool, case: dict, model: str):
    if offline:
        return ScriptedLLM(case)
    # "openai/" picks CrewAI's OpenAI-compatible client; the rest is the gateway model id.
    return LLM(model=f"openai/{model}", base_url=GATEWAY,
               api_key=os.environ["AI_GATEWAY_API_KEY"], temperature=0.2)


# ---------------------------------------------------------------- crews

def build_crew(case: dict, llm, interview: bool, on_step=None) -> Crew:
    attending = Agent(
        role="问诊医生",
        goal="收集足够的病史信息，写出结构化门诊病历和初步诊断",
        backstory="你是经验丰富的全科门诊医生，问诊有条理，病历简洁规范。",
        llm=llm, allow_delegation=interview, max_iter=MAX_QUESTIONS + 3, verbose=False,
    )
    reviewer = Agent(
        role="审核医生",
        goal="确保病历中每一条信息都能在患者原话中找到依据，诊断不过度",
        backstory="你是医务处的病历质控医生，对编造和过度诊断零容忍。",
        llm=llm, allow_delegation=False, verbose=False,
    )
    agents = [attending, reviewer]

    fmt = PROMPTS["consultation"]
    if interview:
        patient = Agent(
            role="患者",
            goal="如实回答医生的问题",
            backstory=(
                f"你是来看门诊的患者（{case['patientInfo']['age']}岁，{case['patientInfo']['gender']}）。"
                "只能根据下面的真实对话回答，里面没有的信息就说「不太清楚」，不要说出任何诊断名，口语化、简短。\n\n"
                f"你之前和医生的真实对话：\n{dialogue_text(case)}"
            ),
            llm=llm, allow_delegation=False, verbose=False,
        )
        agents.append(patient)
        source = (
            f"患者刚进诊室，只说了一句：「{opening_line(case)}」\n"
            f"你需要使用 Ask question to coworker 工具向同事「患者」提问来收集病史，每次问 1-2 个问题，"
            f"最多问 {MAX_QUESTIONS} 次。信息足够后，写出病历。"
        )
        review_source = "问诊医生的问诊过程和病历草稿（见上下文）"
    else:
        source = f"医患对话：\n{dialogue_text(case)}"
        review_source = f"原始对话：\n{dialogue_text(case)}"

    draft = Task(
        description=f"{source}\n\n病历格式要求：\n{fmt}",
        expected_output="Markdown 格式的结构化病历",
        agent=attending,
    )
    review = Task(
        description=(
            f"审核病历草稿，删除患者没有说过的内容、降低过度自信的诊断，然后输出最终病历（保持原格式）。\n\n{review_source}"
        ),
        expected_output="最终病历（Markdown，保持主诉/现病史/…/处置建议的格式）",
        agent=reviewer,
        context=[draft],
    )
    return Crew(agents=agents, tasks=[draft, review], process=Process.sequential, verbose=False,
                step_callback=on_step)


# ---------------------------------------------------------------- judge

def mock_judge(case: dict, text: str) -> dict:
    e = case["expectedDiagnosis"]
    has = lambda s: re.sub(r"（.*?）", "", s) in text  # noqa: E731
    frac = lambda xs: (sum(map(has, xs)) / len(xs)) if xs else 0  # noqa: E731
    headings = ["主诉", "现病史", "既往史", "辅助检查", "初步诊断", "鉴别诊断", "处置建议"]
    return {
        "accuracy": round((70 if has(e["mainDiagnosis"]) else 20) + 30 * frac(e["differentialDiagnosis"])),
        "completeness": round(100 * sum(h in text for h in headings) / len(headings)),
        "standardization": 70,
        "recommendation": round(100 * (frac(e["recommendedTests"]) + frac(e["recommendedMedications"])) / 2),
        "comments": "mock judge",
    }


def llm_judge(case: dict, text: str, judge_model: str) -> dict:
    e = case["expectedDiagnosis"]
    prompt = (
        f"{PROMPTS['scoring']}\n\n--- 标准答案 ---\n主诉：{case['chiefComplaint']}\n"
        f"正确诊断：{e['mainDiagnosis']}\n鉴别诊断：{'、'.join(e['differentialDiagnosis'])}\n"
        f"推荐检查：{'、'.join(e['recommendedTests'])}\n推荐用药：{'、'.join(e['recommendedMedications'])}\n\n"
        f"--- AI生成的诊断结果 ---\n{text}\n\n请对AI的诊断结果进行评分。"
    )
    judge = LLM(model=f"openai/{judge_model}", base_url=GATEWAY,
                api_key=os.environ["AI_GATEWAY_API_KEY"], temperature=0)
    raw = judge.call([{"role": "user", "content": prompt}])
    match = re.search(r"\{[\s\S]*\}", str(raw))
    if not match:
        raise ValueError(f"judge returned no JSON: {raw!r}")
    return json.loads(match.group(0))  # fail loudly, like src/lib/scoring.ts


def judge_total(s: dict) -> float:
    return round((s["accuracy"] * 0.3 + s["completeness"] * 0.25 + s["standardization"] * 0.2
                  + s["recommendation"] * 0.1) / 0.85, 1)


# ---------------------------------------------------------------- run

def run_one(case: dict, run: int, interview: bool, args) -> dict:
    condition = "crew_interview" if interview else "crew_full"
    started = time.time()
    try:
        asked = []

        def on_step(step) -> None:
            if getattr(step, "tool", "") == "Ask question to coworker":
                asked.append(getattr(step, "tool_input", ""))

        crew = build_crew(case, make_llm(args.offline, case, args.model), interview, on_step)
        out = crew.kickoff()
        final = out.tasks_output[-1].raw
        questions = len(asked)
        scores = mock_judge(case, final) if args.offline else llm_judge(case, final, args.judge)
        usage = out.token_usage
        return {
            "caseId": case["id"], "run": run, "condition": condition, "ok": True,
            "scores": scores, "total": judge_total(scores), "ms": round((time.time() - started) * 1000),
            "tokens": getattr(usage, "total_tokens", 0), "calls": getattr(usage, "successful_requests", 0),
            "questions": questions, "askedInputs": asked, "output": final,
        }
    except Exception as err:  # noqa: BLE001 — record and keep going
        return {"caseId": case["id"], "run": run, "condition": condition, "ok": False,
                "error": repr(err), "ms": round((time.time() - started) * 1000)}


def mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else float("nan")


def summarize(results: list, cases: list) -> str:
    label = {"crew_full": "CrewAI·完整对话+审核", "crew_interview": "CrewAI·委派问诊+审核"}
    lines = ["| 条件 | 成功/总数 | 总分 | 准确性 | 完整性 | 规范性 | 建议 | 平均耗时 | 平均请求数 | 平均 tokens |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for cond in label:
        all_ = [r for r in results if r["condition"] == cond]
        ok = [r for r in all_ if r["ok"]]
        s = lambda k: f"{mean(r['scores'][k] for r in ok):.1f}"  # noqa: E731
        lines.append(
            f"| {label[cond]} | {len(ok)}/{len(all_)} | **{mean(r['total'] for r in ok):.1f}** | {s('accuracy')} | "
            f"{s('completeness')} | {s('standardization')} | {s('recommendation')} | "
            f"{mean(r['ms'] for r in ok) / 1000:.1f}s | {mean(r['calls'] for r in ok):.1f} | {mean(r['tokens'] for r in ok):.0f} |"
        )
    lines += ["", "| 病例 | 完整对话 | 委派问诊 | 委派提问次数 |", "|---|---|---|---|"]
    for c in cases:
        f = [r for r in results if r["ok"] and r["caseId"] == c["id"] and r["condition"] == "crew_full"]
        i = [r for r in results if r["ok"] and r["caseId"] == c["id"] and r["condition"] == "crew_interview"]
        lines.append(f"| {c['id']} {c['title']} | {mean(r['total'] for r in f):.1f} | "
                     f"{mean(r['total'] for r in i):.1f} | {mean(r['questions'] for r in i):.1f} |")
    failures = [r for r in results if not r["ok"]]
    if failures:
        lines += ["", "失败：", ""] + [f"- {r['caseId']} run{r['run']} {r['condition']}: {r['error']}" for r in failures]
    return "\n".join(lines)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--offline", action="store_true")
    p.add_argument("--model", default="openai/gpt-4o-mini")
    p.add_argument("--judge", default="openai/gpt-4o-mini")
    p.add_argument("--runs", type=int, default=1)
    p.add_argument("--cases", default="")
    p.add_argument("--out", default=str(ROOT / "docs/agent/eval"))
    args = p.parse_args()
    if not args.offline and not os.environ.get("AI_GATEWAY_API_KEY"):
        sys.exit("AI_GATEWAY_API_KEY is not set. Pass --offline to check the wiring.")

    cases = [c for c in CASES if not args.cases or c["id"] in args.cases.split(",")]
    results = []
    for run in range(1, args.runs + 1):
        for c in cases:
            for interview in (False, True):
                r = run_one(c, run, interview, args)
                print(("✓" if r["ok"] else "✗"), c["id"], f"run{run}", r["condition"], r.get("total", r.get("error")))
                results.append(r)

    tag = f"{'offline' if args.offline else args.model.replace('/', '_')}-{dt.date.today().isoformat()}"
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    meta = {"date": dt.datetime.now().isoformat(), "mode": "offline" if args.offline else "gateway",
            "model": "scripted" if args.offline else args.model, "judge": "mock" if args.offline else args.judge,
            "runs": args.runs}
    (out / f"crewai-{tag}.json").write_text(json.dumps({"meta": meta, "results": results}, ensure_ascii=False, indent=2) + "\n",
                                           encoding="utf-8")
    warn = ("> ⚠️ 离线运行：LLM 与裁判都是脚本替身，只验证 crew 的角色、委派和上下文传递能跑通，分数没有意义。\n\n"
            if args.offline else "")
    summary = f"# CrewAI eval {tag}\n\n{warn}- 模型：{meta['model']}\n- 裁判：{meta['judge']}\n\n{summarize(results, cases)}\n"
    (out / f"crewai-summary-{tag}.md").write_text(summary, encoding="utf-8")
    print("\n" + summary)


if __name__ == "__main__":
    main()
