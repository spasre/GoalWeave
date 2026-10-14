"""学习路径拆解：先判断目标复杂度，硬核目标先检索权威资料，再拆知识点。

对应 SKILL 规格 ``learning-curriculum-decomposer``，这里是它在任务板里的实现：

1. 判断目标属于「通用简单」还是「专业硬核」（编译器 / 硬件 / 竞赛 / 框架开发…）。
2. 硬核目标先走资料获取阶段：拿权威教程 / 大纲 / 考纲，**只提取章节与先后顺序**，不搬原文。
3. 再用这份结构去拆知识点：分阶段、标类型【概念/实操/刷题】、写验收标准、维护前置依赖。
4. 检索不到权威资料时降级为模型原生拆分，并在结果开头挂提示，建议人工复核。
"""

import html as html_lib
import json
import re
import urllib.parse

SKILL = {
    "name": "learn.curriculum",
    "title": "学习路径拆解",
    "description": (
        "输入学习目标，产出分阶段的知识点路径（类型【概念/实操/刷题】+ 验收标准 + 前置依赖）。"
        "硬核目标会先检索权威资料，按资料结构再拆；检索不到就降级为模型知识拆分并提示复核。"
    ),
    "tags": ["学习", "规划", "资料"],
    "params": {
        "goal": "学习目标，例如「系统学 LLVM 后端」",
        "level": "可选，当前基础，例如「会写 C++，没碰过编译器」",
        "mode": "可选，auto（默认）/ direct 只拆不检索 / research 强制先检索",
        "hoursPerUnit": "可选，单个知识点目标时长（小时），默认 2，会收进 1~3",
        "maxUnits": "可选，知识点数量上限，默认 24",
        "sources": "可选，自己给参考资料：链接列表，或一行一个的文本",
        "weeklyHours": "可选，每周能投入的小时数，用来估算每个阶段要几周",
    },
    "requiresModel": False,
}

UNIT_TYPES = ("概念", "实操", "刷题")
DEFAULT_HOURS = 2
DEFAULT_MAX_UNITS = 24
MAX_SOURCES = 3
OUTLINE_CHARS = 6000

NO_SOURCE_NOTICE = "未检索到权威教程，本次基于模型知识拆分，建议人工复核。"
MODEL_FAIL_NOTICE = "模型调用失败，本次改用内置模板拆分，建议人工复核。"

# --------------------------------------------------------------------------- #
# 领域知识库：关键词 → 权威资料 → 阶段模板
# --------------------------------------------------------------------------- #

DOMAINS = [
    {
        "name": "编译器与程序语言",
        "keywords": [
            "编译器", "编译原理", "编译期", "编译器后端", "编译器优化", "llvm", "clang", "gcc",
            "词法分析", "语法分析", "parser", "解析器", "代码生成", "解释器", "虚拟机", "jit",
            "ast", "类型系统", "类型推导", "汇编", "汇编语言", "链接器", "linker", "静态分析",
            "程序语言", "编程语言理论", "垃圾回收", "gc 算法",
        ],
        "sources": [
            ("Crafting Interpreters（手写解释器教程）", "https://craftinginterpreters.com/contents.html"),
            ("LLVM Language Reference（IR 参考）", "https://llvm.org/docs/LangRef.html"),
            ("Stanford CS143 编译器课程大纲", "https://web.stanford.edu/class/cs143/"),
            ("CPython 开发者指南", "https://devguide.python.org/"),
        ],
        "stages": [
            ("词法与语法", [
                ("词法分析：把源码切成 token", "概念"),
                ("手写一个 tokenizer 并覆盖边界用例", "实操"),
                ("语法分析：递归下降与 AST 结构", "概念"),
                ("为一个小语言写出 parser", "实操"),
            ]),
            ("语义与中间表示", [
                ("作用域、符号表与类型检查", "概念"),
                ("SSA 与三地址码", "概念"),
                ("为小语言生成一份可读的 IR", "实操"),
                ("IR 读写小练习：手写与改写指令", "刷题"),
            ]),
            ("优化与后端", [
                ("基本块、支配树与数据流分析", "概念"),
                ("常量折叠、死代码消除等经典优化", "概念"),
                ("写一个 Pass 并补上 lit 测试", "实操"),
                ("指令选择与寄存器分配", "概念"),
            ]),
            ("综合与实战", [
                ("通读一个真实编译器的源码结构", "实操"),
                ("给真实项目提交一个小 patch", "实操"),
                ("综合练习：端到端编译一个小语言", "刷题"),
            ]),
        ],
    },
    {
        "name": "硬件与体系结构",
        "keywords": [
            "硬件", "cpu", "risc-v", "riscv", "x86", "arm", "fpga", "verilog", "vhdl", "芯片",
            "处理器", "体系结构", "微架构", "流水线", "数字电路", "模拟电路", "电路", "嵌入式",
            "单片机", "stm32", "rtos", "驱动", "驱动开发", "缓存一致性", "内存模型", "gpu",
            "图形处理器", "显存",
        ],
        "sources": [
            ("RISC-V 官方规范", "https://riscv.org/technical/specifications/"),
            ("nand2tetris（从门电路到计算机）", "https://www.nand2tetris.org/"),
            ("OSTEP：操作系统导论", "https://pages.cs.wisc.edu/~remzi/OSTEP/"),
            ("ARM 架构参考手册", "https://developer.arm.com/documentation/ddi0487/latest/"),
        ],
        "stages": [
            ("数字电路基础", [
                ("组合逻辑：门、加法器、多路选择器", "概念"),
                ("时序逻辑：触发器、寄存器、时钟", "概念"),
                ("用 Verilog 实现一个 ALU", "实操"),
                ("电路小练习：真值表与化简", "刷题"),
            ]),
            ("处理器与流水线", [
                ("指令集与寻址方式", "概念"),
                ("单周期数据通路", "概念"),
                ("五级流水线与冒险处理", "概念"),
                ("实现一个简化流水线 CPU", "实操"),
            ]),
            ("存储层次与总线", [
                ("缓存结构与命中率计算", "概念"),
                ("虚拟内存与 TLB", "概念"),
                ("缓存命中率计算练习", "刷题"),
            ]),
            ("系统与实战", [
                ("中断、异常与设备驱动模型", "概念"),
                ("在 FPGA 或模拟器上跑通完整设计", "实操"),
                ("阅读一款真实芯片的参考手册", "实操"),
            ]),
        ],
    },
    {
        "name": "竞赛算法",
        "keywords": [
            "竞赛", "acm", "icpc", "oi", "noi", "算法竞赛", "集训队", "省选", "codeforces",
            "洛谷", "刷题", "算法题", "数据结构", "动态规划", "图论", "数论", "组合数学",
            "线段树", "网络流", "计算几何", "字符串算法",
        ],
        "sources": [
            ("OI Wiki（中文竞赛知识大纲）", "https://oi-wiki.org/"),
            ("CP-Algorithms（算法实现目录）", "https://cp-algorithms.com/"),
            ("USACO Guide（分级训练路径）", "https://usaco.guide/"),
            ("洛谷题单广场", "https://www.luogu.com.cn/training/list"),
        ],
        "stages": [
            ("基础与复杂度", [
                ("复杂度分析与常见估算技巧", "概念"),
                ("排序、二分与双指针", "概念"),
                ("基础题单：排序/二分/双指针各若干题", "刷题"),
            ]),
            ("数据结构", [
                ("栈、队列、堆与并查集", "概念"),
                ("前缀和、差分与树状数组", "概念"),
                ("线段树与懒标记", "概念"),
                ("数据结构专项题单", "刷题"),
            ]),
            ("算法范式", [
                ("贪心的正确性证明思路", "概念"),
                ("动态规划：状态设计与转移", "概念"),
                ("图论：最短路、最小生成树、拓扑", "概念"),
                ("DP 与图论专项题单", "刷题"),
            ]),
            ("实战与复盘", [
                ("按时间压力打一场虚拟赛", "实操"),
                ("整理错题本与模板库", "实操"),
                ("综合真题训练", "刷题"),
            ]),
        ],
    },
    {
        "name": "框架与系统开发",
        "keywords": [
            "框架开发", "框架", "内核", "kernel", "操作系统", "os 开发", "分布式", "分布式系统",
            "数据库内核", "存储引擎", "运行时", "runtime", "网络协议", "tcp/ip", "协议栈",
            "容器", "kubernetes", "k8s", "docker", "微服务", "中间件", "消息队列", "react 源码",
            "vue 源码", "浏览器内核", "渲染引擎", "并发编程", "协程",
        ],
        "sources": [
            ("Kubernetes 官方文档", "https://kubernetes.io/zh-cn/docs/home/"),
            ("Linux 内核文档", "https://www.kernel.org/doc/html/latest/"),
            ("PostgreSQL 官方文档", "https://www.postgresql.org/docs/"),
            ("MDN Web 开发文档", "https://developer.mozilla.org/zh-CN/"),
        ],
        "stages": [
            ("先把系统跑起来", [
                ("搞清这个框架/系统解决的核心问题与边界", "概念"),
                ("装好环境，跑通官方最小示例", "实操"),
                ("读一遍官方架构总览并画结构图", "概念"),
            ]),
            ("核心机制", [
                ("关键数据结构与生命周期", "概念"),
                ("请求/任务是怎么流转的", "概念"),
                ("并发、一致性与容错设计", "概念"),
                ("写一个最小可用的插件或扩展", "实操"),
            ]),
            ("深入与调优", [
                ("性能瓶颈与常用调优手段", "概念"),
                ("排查一次真实的错误或慢请求", "实操"),
                ("对照源码验证一个机制细节", "实操"),
            ]),
            ("综合与实战", [
                ("搭一个完整的小项目并部署", "实操"),
                ("阅读并复现一篇相关设计文档", "实操"),
                ("综合练习：定位并修复一个真实问题", "刷题"),
            ]),
        ],
    },
    {
        "name": "机器学习与理论",
        "keywords": [
            "机器学习", "深度学习", "神经网络", "强化学习", "transformer", "训练框架", "cuda",
            "gpu 编程", "分布式训练", "数值优化", "形式化验证", "定理证明", "密码学", "密码算法",
            "大模型", "llm", "扩散模型", "概率图模型", "凸优化", "泛函分析", "抽象代数",
        ],
        "sources": [
            ("动手学深度学习（中文）", "https://zh.d2l.ai/"),
            ("PyTorch 官方教程", "https://pytorch.org/tutorials/"),
            ("Stanford CS229 课程主页", "https://cs229.stanford.edu/"),
            ("CUDA C++ 编程指南", "https://docs.nvidia.com/cuda/cuda-c-programming-guide/"),
        ],
        "stages": [
            ("数学与工具", [
                ("线性代数与概率论的最小必要集", "概念"),
                ("自动求导与计算图", "概念"),
                ("用张量库手写一遍梯度下降", "实操"),
            ]),
            ("经典模型", [
                ("线性/逻辑回归与正则化", "概念"),
                ("反向传播的推导", "概念"),
                ("在小数据集上训一个分类器并调参", "实操"),
                ("推导与手算练习", "刷题"),
            ]),
            ("深度与前沿", [
                ("CNN / RNN 到 Transformer 的演进", "概念"),
                ("训练技巧：初始化、归一化、学习率", "概念"),
                ("复现一个开源模型的训练或推理", "实操"),
            ]),
            ("实战与复盘", [
                ("跑通一个完整项目并写实验报告", "实操"),
                ("读一篇经典论文并复现关键实验", "实操"),
                ("综合练习：端到端解决一个任务", "刷题"),
            ]),
        ],
    },
]

SIMPLE_KEYWORDS = [
    "git", "github", "markdown", "excel", "word", "ppt", "英语", "口语", "单词", "摄影",
    "做饭", "python 基础", "python基础", "sql 入门", "sql入门", "打字", "剪视频", "画图",
    "正则", "vim", "linux 命令", "linux命令", "shell 脚本", "shell脚本", "博客", "hugo",
    "jekyll", "docker 入门", "docker入门", "入门", "基础", "零基础",
]

SIMPLE_STAGES = [
    ("入门：先跑起来", [
        ("搞清楚它解决什么问题、典型使用场景", "概念"),
        ("装好环境，跑通第一个最小例子", "实操"),
    ]),
    ("上手：常用能力", [
        ("掌握 3~5 个最常用的操作与概念", "概念"),
        ("照着官方教程完整走一遍流程", "实操"),
        ("把流程重复一遍，不看教程", "实操"),
    ]),
    ("巩固：练习与查漏", [
        ("做 3 个递进练习并记录踩坑", "刷题"),
        ("整理一份自己的速查笔记", "实操"),
    ]),
]

GENERIC_STAGES = [
    ("打基础：术语与地图", [
        ("理清这个领域在解决什么问题、和相邻领域的关系", "概念"),
        ("过一遍权威资料的总目录，画出知识地图", "概念"),
        ("跑通一个最小示例，建立手感", "实操"),
    ]),
    ("核心机制", [
        ("掌握最核心的概念与模型", "概念"),
        ("理解关键的内部机制与流程", "概念"),
        ("动手实现一个最小可用版本", "实操"),
        ("核心概念练习", "刷题"),
    ]),
    ("深入与调优", [
        ("性能 / 质量 / 正确性上的常见坑", "概念"),
        ("按资料做一次完整的实践并记录问题", "实操"),
        ("对照权威文档核验细节", "实操"),
    ]),
    ("综合与实战", [
        ("做一个完整的小项目", "实操"),
        ("读一份真实实现或设计文档并复述", "实操"),
        ("综合练习：独立解决一个真实问题", "刷题"),
    ]),
]

# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #

CONCEPT_HINTS = ("原理", "概念", "是什么", "为什么", "概述", "介绍", "理论", "机制", "模型",
                 "架构", "语法", "规范", "术语", "分类", "流程", "基础", "关系", "地图",
                 "推导", "设计", "结构", "总览", "对比", "区别", "演进", "思路")
PRACTICE_HINTS = ("实现", "写一个", "搭建", "配置", "安装", "调试", "部署", "重构", "改造",
                  "集成", "跑通", "实践", "动手", "做一遍", "接入", "迁移", "复现", "排查",
                  "读一遍", "通读", "阅读", "提交", "扩展", "写")
DRILL_HINTS = ("练习", "刷题", "题目", "题解", "题单", "竞赛", "真题", "习题", "周赛",
               "leetcode", "acm", "综合题")


def _clamp(value, low, high, fallback):
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def _clean_text(value, limit=200):
    text = html_lib.unescape(str(value or ""))
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def _clean_heading(value, limit=120):
    """去掉标题两端的锚点装饰（``Identifiers #``、``❧ Frontmatter`` 之类）。"""
    text = _clean_text(value, limit)
    text = re.sub(r"[\s#¶§❧»«‹›]+$", "", text)
    text = re.sub(r"^[\s#¶§❧»«‹›]+", "", text)
    return re.sub(r"\s+", " ", text).strip(" -–—:：.。、,")


# 导航/装饰性标题：是页面的零件，不是知识点
BOILERPLATE_HEADINGS = {
    "tableofcontents", "contents", "toc", "目录", "内容", "moreinformation", "handouts",
    "assignments", "frontmatter", "backmatter", "preface", "前言", "序言", "introductiontothe",
    "acknowledgements", "acknowledgments", "致谢", "license", "版权", "copyright", "index",
    "索引", "appendix", "附录", "references", "参考", "参考文献", "navigation", "menu", "菜单",
    "导航", "search", "搜索", "welcome", "欢迎", "about", "关于", "contact", "联系我们",
    "skipnavigation", "跳转", "next", "previous", "上一页", "下一页", "expand", "collapse",
    "展开", "收起", "lightmode", "darkmode", "theme", "主题", "home", "首页", "blog", "news",
    "新闻", "events", "活动", "donate", "sponsor", "赞助", "gettinghelp", "帮助", "faq",
    "常见问题", "sidebar", "footer", "header", "breadcrumb", "share", "分享",
}


def _is_boilerplate(text):
    key = _norm_key(text)
    if not key:
        return True
    if key in BOILERPLATE_HEADINGS:
        return True
    # "I. Welcome" / "1.2 目录" 这类带编号的，去掉编号再看
    stripped = re.sub(r"^(?:[ivxlcdm]+|\d+)(?:[.\-、)]\d*)*", "", key)
    return bool(stripped) and stripped in BOILERPLATE_HEADINGS


def _norm_key(text):
    return re.sub(r"[\s\-_·:：,，。.、/\\()（）\[\]【】]+", "", str(text or "")).lower()


def _dedupe(items):
    seen = set()
    out = []
    for item in items:
        key = _norm_key(item)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


# --------------------------------------------------------------------------- #
# 步骤一：判断目标复杂度
# --------------------------------------------------------------------------- #

def _classify_local(goal):
    text = goal.lower()
    hits = []
    for domain in DOMAINS:
        matched = [word for word in domain["keywords"] if word.lower() in text]
        if matched:
            # 按命中的关键词总长度打分：越具体的词（「体系结构」）越能压过泛词（「cuda」）
            score = sum(len(word) for word in matched)
            hits.append((score, len(matched), domain))
    if hits:
        hits.sort(key=lambda item: (-item[0], -item[1], item[2]["name"]))
        best = hits[0][2]
        return {
            "hardcore": True,
            "domain": best["name"],
            "reason": "命中「" + best["name"] + "」领域关键词",
            "unsure": False,
        }
    simple = [word for word in SIMPLE_KEYWORDS if word in text]
    if simple:
        return {
            "hardcore": False,
            "domain": "通用",
            "reason": "命中常见入门目标关键词：" + "、".join(simple[:3]),
            "unsure": False,
        }
    return {
        "hardcore": False,
        "domain": "通用",
        "reason": "没有命中硬核领域关键词",
        "unsure": True,
    }


CLASSIFY_SYSTEM = (
    "你是一个学习目标分类器。判断目标属于哪一类，只输出 JSON，不要解释、不要代码块：\n"
    '{"hardcore": true|false, "domain": "领域名或通用", "reason": "一句话理由"}\n'
    "hardcore 为 true 的标准：编译器/程序语言、硬件与体系结构、竞赛算法、框架与系统开发、"
    "机器学习与理论这类需要啃权威资料的专业硬核方向。\n"
    "像「学会 Git 基础」「Excel 函数」这种通用简单目标就是 false。"
)


def _classify_model(goal, ctx):
    try:
        content = ctx.chat(
            [{"role": "system", "content": CLASSIFY_SYSTEM}, {"role": "user", "content": goal}],
            temperature=0,
            max_tokens=200,
        )
    except Exception as error:  # noqa: BLE001 - 判不准就退回本地判断
        ctx.log("模型判断复杂度失败，用本地规则：" + str(error))
        return None
    parsed = _extract_json(content)
    if not isinstance(parsed, dict):
        return None
    return {
        "hardcore": bool(parsed.get("hardcore")),
        "domain": _clean_text(parsed.get("domain"), 40) or "通用",
        "reason": _clean_text(parsed.get("reason"), 120) or "模型判断",
        "unsure": False,
    }


def _extract_json(text):
    raw = str(text or "").strip()
    if not raw:
        return None
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.I)
    body = fenced.group(1).strip() if fenced else raw
    try:
        return json.loads(body)
    except ValueError:
        pass
    for opener, closer in (("{", "}"), ("[", "]")):
        start = body.find(opener)
        end = body.rfind(closer)
        if start == -1 or end <= start:
            continue
        try:
            return json.loads(body[start:end + 1])
        except ValueError:
            continue
    return None


# --------------------------------------------------------------------------- #
# 步骤二：资料获取（只取结构，不搬原文）
# --------------------------------------------------------------------------- #

def _domain_of(name):
    for domain in DOMAINS:
        if domain["name"] == name:
            return domain
    return None


def _normalize_sources(raw):
    if isinstance(raw, str):
        chunks = re.split(r"[\r\n]+", raw)
    elif isinstance(raw, list):
        chunks = raw
    else:
        return []
    out = []
    for chunk in chunks:
        if isinstance(chunk, dict):
            url = str(chunk.get("url") or "").strip()
            title = _clean_text(chunk.get("title"), 120) or url
        else:
            text = str(chunk or "").strip()
            if not text:
                continue
            found = re.search(r"https?://\S+", text)
            if not found:
                continue
            url = found.group(0).rstrip(".,;、）)】>")
            title = _clean_text(text.replace(found.group(0), "").strip(" |·-—:："), 120) or url
        if url and url not in [item["url"] for item in out]:
            out.append({"title": title, "url": url})
    return out


def _catalog_sources(domain_name):
    domain = _domain_of(domain_name)
    if not domain:
        return []
    return [{"title": title, "url": url} for title, url in domain["sources"]]


def _unwrap_ddg(href):
    if not href:
        return ""
    href = html_lib.unescape(href)
    if href.startswith("//"):
        href = "https:" + href
    if not href.startswith("http"):
        return ""
    parsed = urllib.parse.urlparse(href)
    if "duckduckgo.com" in parsed.netloc:
        target = (urllib.parse.parse_qs(parsed.query).get("uddg") or [""])[0]
        if target:
            return target
        return ""
    return href


SKIP_HOSTS = ("youtube.com", "facebook.com", "twitter.com", "x.com", "pinterest.",
              "instagram.com", "zhihu.com/search", "baidu.com/link")


def _search_sources(goal, ctx, limit=MAX_SOURCES):
    query = goal + " 官方文档 教程 大纲"
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    try:
        page = ctx.http_get(url, timeout=12, limit=300000, raw=True)
    except Exception as error:  # noqa: BLE001 - 搜不到就交给上层降级
        ctx.log("检索失败：" + str(error))
        return []
    found = []
    for match in re.finditer(r"(?is)<a\b([^>]*)>(.*?)</a>", page):
        attrs, inner = match.group(1), match.group(2)
        if "result__a" not in attrs:
            continue
        href_match = re.search(r'href="([^"]+)"', attrs)
        target = _unwrap_ddg(href_match.group(1) if href_match else "")
        if not target or any(host in target for host in SKIP_HOSTS):
            continue
        if target in [item["url"] for item in found]:
            continue
        title = _clean_text(inner, 120) or target
        found.append({"title": title, "url": target})
        if len(found) >= limit:
            break
    if not found:
        ctx.log("检索没有拿到可用结果")
    return found


def _extract_outline(page, limit=80):
    """从原始 HTML 里只取标题层级，绝不保留正文。"""
    body = re.sub(r"(?is)<(script|style|nav|footer)\b.*?</\1>", " ", page or "")
    title = ""
    title_match = re.search(r"(?is)<title[^>]*>(.*?)</title>", body)
    if title_match:
        title = _clean_text(title_match.group(1), 120)
    outline = []
    for match in re.finditer(r"(?is)<h([1-4])\b[^>]*>(.*?)</h\1>", body):
        text = _clean_heading(match.group(2))
        if not (2 <= len(text) <= 120) or _is_boilerplate(text):
            continue
        if not re.search(r"[A-Za-z\u4e00-\u9fff]", text):
            continue
        outline.append((int(match.group(1)), text))
    return title, outline


def _collect_outline(sources, goal, ctx):
    """逐个抓资料，失败不算错，返回 (可用资料, 失败原因列表)。"""
    usable = []
    failures = []
    for item in sources[:MAX_SOURCES]:
        try:
            page = ctx.http_get(item["url"], timeout=15, limit=600000, raw=True)
        except Exception as error:  # noqa: BLE001 - 单份资料拿不到不该中断
            failures.append(item["title"] + "：" + str(error))
            ctx.log("抓不到资料 " + item["url"] + "：" + str(error))
            continue
        title, outline = _extract_outline(page)
        if not outline:
            failures.append(item["title"] + "：没提取到章节标题")
            ctx.log("资料没有章节结构：" + item["url"])
            continue
        usable.append({
            "title": item["title"],
            "url": item["url"],
            "pageTitle": title,
            "headings": outline,
        })
        ctx.log("取到结构：" + item["title"] + "（" + str(len(outline)) + " 个标题）")
    return usable, failures


def _outline_text(usable, limit=OUTLINE_CHARS):
    blocks = []
    for item in usable:
        lines = [item["title"] + "（" + item["url"] + "）"]
        for level, text in item["headings"][:40]:
            lines.append("  " * (level - 1) + "- " + text)
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)[:limit]


# --------------------------------------------------------------------------- #
# 步骤三：知识点拆解
# --------------------------------------------------------------------------- #

def _infer_type(name):
    lowered = name.lower()
    if any(word in lowered for word in DRILL_HINTS):
        return "刷题"
    if any(word in lowered for word in PRACTICE_HINTS):
        return "实操"
    if any(word in lowered for word in CONCEPT_HINTS):
        return "概念"
    return "概念"


def _acceptance(name, unit_type, hours):
    if unit_type == "实操":
        return "独立完成「" + name + "」的最小可运行版本，能跑通并说清关键步骤（约 " + str(hours) + " 小时）"
    if unit_type == "刷题":
        return "完成 3~5 道「" + name + "」相关练习，记录错因并达到可独立复现（约 " + str(hours) + " 小时）"
    return "能用自己的话讲清「" + name + "」，写出 3 条要点或画出一张结构图（约 " + str(hours) + " 小时）"


def _build_units(names, hours):
    units = []
    for name in names:
        unit_type = _infer_type(name)
        units.append({
            "name": name,
            "type": unit_type,
            "hours": hours,
            "acceptance": _acceptance(name, unit_type, hours),
        })
    return units


def _group_by_level(outline, stage_level):
    """按给定层级切阶段；更深的标题当知识点，没有子标题就用标题本身当知识点。"""
    stages = []
    current = None
    for level, text in outline:
        if len(text) > 60:
            continue
        if level <= stage_level or current is None:
            current = {"name": text, "units": []}
            stages.append(current)
        else:
            current["units"].append(text)
    return [(stage["name"], stage["units"] or [stage["name"]]) for stage in stages]


def _chunk_sections(sections, max_stages=6):
    """章节太多时按顺序合并成最多 max_stages 段，阶段名用该段第一个章节名。"""
    if len(sections) <= max_stages:
        return sections
    size = -(-len(sections) // max_stages)
    chunks = []
    for start in range(0, len(sections), size):
        group = sections[start:start + size]
        units = []
        for _name, sub_units in group:
            units.extend(sub_units)
        chunks.append((group[0][0], _dedupe(units)))
    return chunks[:max_stages]


def _headings_to_stages(outline, max_stages=6):
    """把一份资料的标题层级折成阶段。

    不同文档层级习惯不一样（有的从 h1 起，有的直接从 h2 起），所以先找出能切出
    多个阶段的最浅层级；章节特别多的文档（例如 LLVM LangRef 有近百个 h2）再按顺序
    合并，避免一段把整个预算吃光。
    """
    if not outline:
        return []
    levels = sorted({level for level, _text in outline})
    sections = None
    for stage_level in levels:
        candidate = _group_by_level(outline, stage_level)
        if len(candidate) >= 2:
            sections = candidate
            break
    if sections is None:
        sections = _group_by_level(outline, levels[0])
    return _chunk_sections(sections, max_stages)


def _local_stages(goal, domain_name, hardcore, usable, max_units):
    # 内置库里认得这个领域时，优先用它那份教学顺序（参考手册的章节顺序不适合当学习顺序），
    # 再把检索到的大纲里没被覆盖的主题并成一个补充阶段 —— 对应「以资料结构为参考基准」。
    if hardcore:
        domain = _domain_of(domain_name)
        if domain:
            stages = [(name, [unit for unit, _kind in units]) for name, units in domain["stages"]]
            if usable:
                known = {_norm_key(unit) for _name, units in stages for unit in units}
                extra = []
                for item in usable:
                    for _level, text in item["headings"]:
                        key = _norm_key(text)
                        if not key or key in known:
                            continue
                        known.add(key)
                        extra.append(text)
                if extra:
                    stages.append(("资料补充主题（来自检索到的教程大纲）", extra))
            return stages

    if usable:
        # 多份资料轮流取阶段，保证每份资料都出现在结果里（而不是被第一份吃光）；
        # 阶段名额按资料份数均分，每份资料内部再把章节合并成那么多段。
        share = max(2, 6 // max(1, len(usable)))
        per_source = [_headings_to_stages(item["headings"], share) for item in usable]
        merged = []
        seen = set()
        depth = max((len(stages) for stages in per_source), default=0)
        for index in range(depth):
            for stages in per_source:
                if index >= len(stages):
                    continue
                name, units = stages[index]
                key = _norm_key(name)
                if not key or key in seen:
                    continue
                seen.add(key)
                merged.append((name, _dedupe(units)))
        if merged:
            return merged[:6]

    if hardcore:
        return [(name, [unit for unit, _kind in units]) for name, units in GENERIC_STAGES]
    return [(name, [unit for unit, _kind in units]) for name, units in SIMPLE_STAGES]


def _local_curriculum(goal, domain_name, hardcore, usable, hours, max_units, weekly):
    raw_stages = _local_stages(goal, domain_name, hardcore, usable, max_units)
    library = {}
    domain = _domain_of(domain_name)
    for name, units in (domain["stages"] if domain else (GENERIC_STAGES if hardcore else SIMPLE_STAGES)):
        for unit, kind in units:
            library[_norm_key(unit)] = kind

    # 把知识点预算均摊到各阶段，避免第一个阶段把 maxUnits 全占掉
    per_stage = max(3, max_units // max(1, len(raw_stages)))

    stages = []
    used = set()
    previous = ""
    for index, (stage_name, unit_names) in enumerate(raw_stages, start=1):
        units = []
        for unit_name in _dedupe(unit_names):
            key = _norm_key(unit_name)
            if not key or key in used:
                continue
            if len(units) >= per_stage or len(used) >= max_units:
                break
            used.add(key)
            unit_type = library.get(key) or _infer_type(unit_name)
            units.append({
                "name": unit_name,
                "type": unit_type,
                "hours": hours,
                "acceptance": _acceptance(unit_name, unit_type, hours),
                "dependsOn": [previous] if previous else [],
            })
            previous = unit_name
        if units:
            stage = {
                "name": stage_name,
                "summary": "本阶段 " + str(len(units)) + " 个知识点，约 " + str(len(units) * hours) + " 小时。",
                "units": units,
                "sources": [item["url"] for item in usable][:MAX_SOURCES],
            }
            if weekly:
                stage["weeks"] = max(1, round(len(units) * hours / weekly, 1))
            stages.append(stage)
        if len(used) >= max_units:
            break
    return stages


CURRICULUM_SYSTEM = (
    "你是学习路径拆解助手。把学习目标拆成「总目标 → 学习阶段 → 知识点」。\n"
    "硬性要求：\n"
    "1. 资料只用来确定章节与先后顺序，绝不要抄教程原文，也不要写大段解释。\n"
    "2. 多份资料的知识点要合并去重，剔除冗余。\n"
    "3. 每个知识点标注类型，只能是「概念」「实操」「刷题」三者之一。\n"
    "4. 每个知识点写一条可检验的验收标准，粒度 1~3 小时能学完+练完。\n"
    "5. 用 dependsOn 标出前置知识点（用知识点名字，必须出现在结果里）。\n"
    "6. 每个阶段用 sources 标出参考了哪些资料链接。\n"
    "只输出一个 JSON 对象，不要解释、不要 markdown 代码块，格式：\n"
    '{"goal": "总目标", "domain": "领域", "stages": [{"name": "阶段名", "summary": "一句话", '
    '"sources": ["url"], "units": [{"name": "知识点", "type": "概念|实操|刷题", '
    '"acceptance": "验收标准", "hours": 2, "dependsOn": ["前置知识点"]}]}]}'
)


def _normalize_curriculum(parsed, hours, max_units, fallback_sources):
    stages = []
    used = set()
    names = []
    raw_stages = parsed.get("stages") if isinstance(parsed, dict) else None
    for raw_stage in raw_stages or []:
        if not isinstance(raw_stage, dict):
            continue
        stage_name = _clean_text(raw_stage.get("name"), 80)
        if not stage_name:
            continue
        units = []
        for raw_unit in raw_stage.get("units") or []:
            if not isinstance(raw_unit, dict):
                continue
            name = _clean_text(raw_unit.get("name") or raw_unit.get("title"), 120)
            key = _norm_key(name)
            if not key or key in used or len(used) >= max_units:
                continue
            used.add(key)
            names.append(name)
            unit_type = _clean_text(raw_unit.get("type"), 10)
            if unit_type not in UNIT_TYPES:
                unit_type = _infer_type(name)
            unit_hours = _clamp(raw_unit.get("hours"), 1, 3, hours)
            acceptance = _clean_text(raw_unit.get("acceptance"), 240) or _acceptance(name, unit_type, unit_hours)
            depends = raw_unit.get("dependsOn")
            if isinstance(depends, str):
                depends = [depends]
            units.append({
                "name": name,
                "type": unit_type,
                "hours": unit_hours,
                "acceptance": acceptance,
                "dependsOn": [str(item).strip() for item in (depends or []) if str(item).strip()],
                "_key": key,
            })
        if not units:
            continue
        sources = raw_stage.get("sources")
        if isinstance(sources, str):
            sources = [sources]
        sources = [str(item).strip() for item in (sources or []) if str(item).strip()] or fallback_sources
        stages.append({
            "name": stage_name,
            "summary": _clean_text(raw_stage.get("summary"), 200),
            "sources": sources[:MAX_SOURCES],
            "units": units,
        })

    # dependsOn 只保留真实存在的知识点，防止模型编出不存在的前置
    known = {unit["_key"] for stage in stages for unit in stage["units"]}
    for stage in stages:
        for unit in stage["units"]:
            kept = []
            for dep in unit["dependsOn"]:
                if _norm_key(dep) in known and _norm_key(dep) != unit["_key"]:
                    kept.append(dep)
            unit["dependsOn"] = _dedupe(kept)[:3]
            unit.pop("_key", None)
    return stages


def _model_curriculum(goal, level, domain_name, hardcore, usable, hours, max_units, weekly, fallback_sources, ctx):
    parts = ["学习目标：" + goal]
    if level:
        parts.append("当前基础：" + level)
    parts.append("判断结果：" + ("专业硬核目标（需要啃权威资料）" if hardcore else "通用简单目标"))
    parts.append("领域：" + domain_name)
    if usable:
        parts.append("已检索到的资料结构（只当参考基准，别抄原文）：\n" + _outline_text(usable))
    else:
        parts.append("没有检索到资料，请完全基于你自己的知识拆分，不要编造资料链接。")
    parts.append("单个知识点目标时长：" + str(hours) + " 小时；知识点总数不超过 " + str(max_units) + " 个。")
    if weekly:
        parts.append("学习者每周能投入约 " + str(weekly) + " 小时。")
    content = ctx.chat(
        [{"role": "system", "content": CURRICULUM_SYSTEM}, {"role": "user", "content": "\n\n".join(parts)}],
        temperature=0.2,
    )
    parsed = _extract_json(content)
    if not isinstance(parsed, dict):
        raise ValueError("模型没有返回可解析的 JSON")
    return _normalize_curriculum(parsed, hours, max_units, fallback_sources)


# --------------------------------------------------------------------------- #
# 渲染
# --------------------------------------------------------------------------- #

def _to_markdown(result):
    lines = ["# 学习路径：" + result["goal"], ""]
    lines.append("> 模式：" + ("检索式（先资料后拆解）" if result["mode"] == "research" else "直接拆解")
                 + " · 领域：" + result["domain"]
                 + " · " + str(len(result["stages"])) + " 个阶段 / " + str(result["stats"]["units"]) + " 个知识点")
    if result.get("notice"):
        lines.append("> ⚠️ " + result["notice"])
    lines.append("")
    for index, stage in enumerate(result["stages"], start=1):
        suffix = "（约 " + str(stage["weeks"]) + " 周）" if stage.get("weeks") else ""
        lines.append("## 阶段 " + str(index) + "：" + stage["name"] + suffix)
        if stage.get("summary"):
            lines.append(stage["summary"])
        for unit in stage["units"]:
            lines.append("- **【" + unit["type"] + "】" + unit["name"] + "**（约 " + str(unit["hours"]) + " 小时）")
            lines.append("  - 验收：" + unit["acceptance"])
            if unit.get("dependsOn"):
                lines.append("  - 前置：" + "、".join(unit["dependsOn"]))
        if stage.get("sources"):
            lines.append("  - 参考：" + "、".join(stage["sources"]))
        lines.append("")
    return "\n".join(lines).strip()


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #

def run(params, ctx):
    goal = str(params.get("goal") or params.get("prompt") or params.get("target") or "").strip()
    if not goal:
        raise ValueError("goal 不能为空")

    mode = str(params.get("mode", "auto") or "auto").strip().lower()
    if mode not in ("auto", "direct", "research"):
        mode = "auto"
    hours = _clamp(params.get("hoursPerUnit"), 1, 3, DEFAULT_HOURS)
    max_units = _clamp(params.get("maxUnits"), 4, 60, DEFAULT_MAX_UNITS)
    weekly = _clamp(params.get("weeklyHours"), 1, 60, 0) or None
    level = _clean_text(params.get("level"), 200)

    warnings = []
    verdict = _classify_local(goal)
    hardcore = bool(verdict["hardcore"])
    if mode == "auto" and not hardcore and verdict.get("unsure") and ctx.model_ready():
        upgraded = _classify_model(goal, ctx)
        if upgraded:
            verdict = upgraded
            hardcore = bool(upgraded["hardcore"])
            if hardcore:
                ctx.log("模型把目标升级为硬核：" + upgraded["reason"])
    want_research = mode == "research" or (mode == "auto" and hardcore)
    ctx.log("判断：" + ("硬核" if hardcore else "通用") + " · " + verdict["reason"]
            + (" · " + ("先检索资料" if want_research else "直接拆解")))

    # 步骤一：资料获取（只有需要检索的目标才走）
    usable = []
    failures = []
    if want_research:
        wanted = _normalize_sources(params.get("sources"))
        if wanted:
            ctx.log("用调用方给的 " + str(len(wanted)) + " 份资料")
        else:
            wanted = _catalog_sources(verdict["domain"])
            if wanted:
                ctx.log("用内置资料目录：" + verdict["domain"])
            else:
                ctx.log("内置目录没有这个领域，转去检索")
                wanted = _search_sources(goal, ctx)
        usable, failures = _collect_outline(wanted, goal, ctx)
        if not usable:
            warnings.append(NO_SOURCE_NOTICE)
            ctx.log("没有拿到任何资料结构，降级为模型原生拆分")

    fallback_sources = [item["url"] for item in usable][:MAX_SOURCES]
    result_mode = "research" if usable else "direct"

    # 步骤二：知识点拆解
    source = "local"
    stages = []
    tried_model = ctx.model_ready()
    if tried_model:
        try:
            stages = _model_curriculum(goal, level, verdict["domain"], hardcore, usable,
                                       hours, max_units, weekly, fallback_sources, ctx)
            source = "api"
        except Exception as error:  # noqa: BLE001 - 模型不行就退回内置模板
            ctx.log("模型拆解失败：" + str(error))
            stages = []
    else:
        ctx.log("没配模型，直接用内置模板")

    if not stages:
        if tried_model:
            warnings.append(MODEL_FAIL_NOTICE)
        stages = _local_curriculum(goal, verdict["domain"], hardcore, usable,
                                   hours, max_units, weekly)
        source = "local"

    if not stages:
        raise RuntimeError("没能拆出任何知识点，换个更具体的 goal 再试。")

    unit_total = sum(len(stage["units"]) for stage in stages)
    notice = " ".join(dict.fromkeys(warnings))
    result = {
        "goal": goal,
        "level": level,
        "mode": result_mode,
        "requestedMode": mode,
        "domain": verdict["domain"],
        "hardcore": hardcore,
        "researchPlanned": want_research,
        "reason": verdict["reason"],
        "source": source,
        "hoursPerUnit": hours,
        "weeklyHours": weekly,
        "notice": notice,
        "warnings": warnings,
        "sources": [
            {
                "title": item["title"],
                "url": item["url"],
                "pageTitle": item["pageTitle"],
                "headings": len(item["headings"]),
                # 只留结构样本，便于核验「没有搬正文」
                "headingsSample": [text for _level, text in item["headings"][:12]],
                "used": "结构参考",
            }
            for item in usable
        ],
        "sourceFailures": failures,
        "stages": stages,
        "stats": {
            "stages": len(stages),
            "units": unit_total,
            "hours": unit_total * hours,
            "researched": bool(usable),
        },
    }
    result["markdown"] = _to_markdown(result)
    return result
