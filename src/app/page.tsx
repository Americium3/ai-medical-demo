import Link from "next/link";

const stats = [
  { value: "32", label: "覆盖科室", suffix: "个" },
  { value: "400万", label: "医学知识图谱", suffix: "+" },
  { value: ">96%", label: "语音识别准确率", suffix: "" },
  { value: "<800ms", label: "病历生成响应", suffix: "" },
];

const features = [
  {
    icon: "🎙️",
    title: "智能问诊模拟",
    description: "模拟真实门诊场景，支持文字和语音输入，实时生成结构化电子病历",
    href: "/consultation",
    color: "from-cyan-500 to-blue-500",
  },
  {
    icon: "📋",
    title: "案例病例库",
    description: "覆盖呼吸、消化、心内、神经等多科室典型病例，支持 AI 诊断分析",
    href: "/cases",
    color: "from-emerald-500 to-teal-500",
  },
  {
    icon: "🤖",
    title: "多模型对比评分",
    description: "同一病例使用不同 AI 模型诊断，多维度评分对比，选择最优方案",
    href: "/comparison",
    color: "from-violet-500 to-purple-500",
  },
  {
    icon: "🧭",
    title: "问诊 Agent",
    description: "只给主诉，Agent 自主追问、识别危险信号、鉴别诊断并自查，全程可视化执行轨迹",
    href: "/agent",
    color: "from-amber-500 to-orange-500",
  },
];

const coreValues = [
  {
    icon: "🎯",
    title: "精准捕捉",
    description: "精准捕捉问诊关键信息，避免人工记录误差，确保病历完整性",
  },
  {
    icon: "📝",
    title: "自动生成病历",
    description: "通过AI自动生成符合医疗规范的病历初稿，减轻医生80%以上的文书负担",
  },
  {
    icon: "📊",
    title: "标准化数据",
    description: "标准化病历格式，为后续智能诊断、医保结算和科研分析提供高质量数据基础",
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-cyan-900 to-slate-900 px-4 py-20 text-white sm:px-6 sm:py-32">
        <div className="absolute inset-0 opacity-20">
          <div className="absolute top-20 left-10 h-72 w-72 rounded-full bg-cyan-400 blur-3xl" />
          <div className="absolute bottom-20 right-10 h-72 w-72 rounded-full bg-blue-400 blur-3xl" />
        </div>
        <div className="relative mx-auto max-w-5xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm backdrop-blur-sm">
            <span className="h-2 w-2 rounded-full bg-green-400" />
            基于大语言模型的智能医疗演示系统
          </div>
          <h1 className="mb-6 text-4xl font-bold leading-tight sm:text-5xl lg:text-6xl">
            AI 问诊助手
            <span className="block bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
              智能体演示系统
            </span>
          </h1>
          <p className="mx-auto mb-10 max-w-2xl text-lg text-cyan-100/80">
            通过智能语音识别和自然语言处理技术实时采集医患对话，
            自动生成结构化电子病历，大幅提升诊疗效率
          </p>
          <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/consultation"
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-white px-8 font-semibold text-slate-900 transition-all hover:bg-cyan-50 hover:shadow-lg"
            >
              开始问诊模拟
              <span>→</span>
            </Link>
            <Link
              href="/cases"
              className="inline-flex h-12 items-center gap-2 rounded-xl border border-white/30 px-8 font-semibold text-white backdrop-blur-sm transition-all hover:bg-white/10"
            >
              查看案例病例
            </Link>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="border-b border-border bg-white px-4 py-12 sm:px-6">
        <div className="mx-auto grid max-w-5xl grid-cols-2 gap-6 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-3xl font-bold text-primary sm:text-4xl">
                {stat.value}
                <span className="text-lg">{stat.suffix}</span>
              </div>
              <div className="mt-1 text-sm text-muted">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Feature Cards */}
      <section className="px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-4 text-center text-2xl font-bold sm:text-3xl">
            系统功能
          </h2>
          <p className="mb-12 text-center text-muted">
            四大核心模块，全面覆盖 AI 问诊演示场景
          </p>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((f) => (
              <Link
                key={f.title}
                href={f.href}
                className="group relative overflow-hidden rounded-2xl border border-border bg-white p-6 transition-all hover:-translate-y-1 hover:shadow-xl"
              >
                <div
                  className={`mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${f.color} text-2xl text-white shadow-lg`}
                >
                  {f.icon}
                </div>
                <h3 className="mb-2 text-lg font-bold">{f.title}</h3>
                <p className="text-sm leading-relaxed text-muted">
                  {f.description}
                </p>
                <div className="mt-4 text-sm font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                  进入体验 →
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Core Values */}
      <section className="bg-gradient-to-b from-cyan-50 to-white px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-4 text-center text-2xl font-bold sm:text-3xl">
            核心价值
          </h2>
          <p className="mb-12 text-center text-muted">
            AI 问诊助手作为 AI 医疗全流程的核心前置环节
          </p>
          <div className="grid gap-6 sm:grid-cols-3">
            {coreValues.map((v) => (
              <div
                key={v.title}
                className="rounded-2xl bg-white p-6 shadow-sm border border-border"
              >
                <div className="mb-3 text-3xl">{v.icon}</div>
                <h3 className="mb-2 font-bold">{v.title}</h3>
                <p className="text-sm leading-relaxed text-muted">
                  {v.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-white px-4 py-8 text-center text-sm text-muted sm:px-6">
        <p>AI 问诊助手演示系统 - 仅供演示用途，不构成医疗建议</p>
      </footer>
    </div>
  );
}
