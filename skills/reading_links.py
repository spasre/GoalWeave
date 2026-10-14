"""按关键词推荐延伸阅读，用的是任务板内置的那份公开文档目录。"""

import re

SKILL = {
    "name": "reading.links",
    "title": "推荐阅读",
    "description": "按关键词从内置文档目录里挑几条延伸阅读，命中标签越多排得越前。",
    "tags": ["资料", "任务"],
    "params": {"keyword": "关键词或任务标题", "limit": "可选，返回条数，默认 3"},
    "requiresModel": False,
}

SOURCES = [
    ("LLVM Language Reference：IR 语法与指令参考", "https://llvm.org/docs/LangRef.html",
     ["llvm", "ir", "ssa", "指令", "语言参考", "汇编"]),
    ("LLVM IR：未定义值 undef 与 poison", "https://llvm.org/docs/LangRef.html#undefined-values",
     ["ub", "未定义行为", "undef", "poison", "undefined", "未定义值"]),
    ("LLVM IR：指针别名与 provenance 溯源", "https://llvm.org/docs/LangRef.html#pointeraliasing",
     ["provenance", "溯源", "指针", "别名", "alias", "getelementptr"]),
    ("LLVM IR：调用约定（Calling Conventions）", "https://llvm.org/docs/LangRef.html#calling-conventions",
     ["abi", "调用约定", "calling", "约定", "传参"]),
    ("LLVM Programmer's Manual：源码结构与常用 API", "https://llvm.org/docs/ProgrammersManual.html",
     ["llvm", "源码", "数据结构", "api", "阅读源码"]),
    ("Writing an LLVM Pass：写一个 Pass", "https://llvm.org/docs/WritingAnLLVMPass.html",
     ["pass", "pass manager", "优化", "分层"]),
    ("LLVM Analysis and Transform Passes：Pass 清单", "https://llvm.org/docs/Passes.html",
     ["pass", "优化", "清单", "列表", "分析"]),
    ("Alias Analysis Infrastructure：别名分析", "https://llvm.org/docs/AliasAnalysis.html",
     ["别名分析", "alias analysis", "指针", "优化"]),
    ("The LLVM Target-Independent Code Generator：后端与指令选择", "https://llvm.org/docs/CodeGenerator.html",
     ["代码生成", "寄存器分配", "指令选择", "后端", "合法化", "legalization"]),
    ("MIR Language Reference：机器层中间表示", "https://llvm.org/docs/MIRLangRef.html",
     ["mir", "机器指令", "指令选择", "寄存器", "machineir"]),
    ("LLVM Testing Infrastructure Guide：lit 与测试用例写法", "https://llvm.org/docs/TestingGuide.html",
     ["测试", "lit", "测试用例", "dts", "用例"]),
    ("LLVM Release Notes：版本变化与迁移说明", "https://llvm.org/docs/ReleaseNotes.html",
     ["版本升级", "升级", "迁移", "release", "release notes", "版本"]),
    ("Clang Diagnostics Reference：告警诊断参考", "https://clang.llvm.org/docs/DiagnosticsReference.html",
     ["clang", "告警", "诊断", "warning", "diagnostic", "werror", "告警对齐"]),
    ("Clang Internals Manual：诊断与前端实现", "https://clang.llvm.org/docs/InternalsManual.html",
     ["clang", "诊断", "diagnostic", "实现", "源码", "前端"]),
    ("LLVM Command Guide：opt 命令", "https://llvm.org/docs/CommandGuide/opt.html",
     ["opt", "o2", "优化", "命令行", "指令折叠", "折叠"]),
    ("LLVM Command Guide：FileCheck", "https://llvm.org/docs/CommandGuide/FileCheck.html",
     ["filecheck", "测试", "用例", "断言", "匹配"]),
    ("Getting Started with the LLVM System：编译与目录结构", "https://llvm.org/docs/GettingStarted.html",
     ["构建", "入门", "build", "cmake", "编译"]),
    ("How to Update Debug Info：调试信息的修改", "https://llvm.org/docs/HowToUpdateDebugInfo.html",
     ["调试信息", "debug", "dwarf", "调试"]),
    ("GDB 官方文档：断点、观察点与调试脚本", "https://www.gnu.org/software/gdb/documentation/",
     ["gdb", "调试", "断点", "观察点", "watchpoint", "调试器"]),
    ("cppreference：C++ 未定义行为", "https://en.cppreference.com/w/cpp/language/ub",
     ["ub", "未定义行为", "c++", "行为"]),
    ("MDN：JavaScript 参考", "https://developer.mozilla.org/zh-CN/docs/Web/JavaScript",
     ["javascript", "js", "前端", "网页", "脚本"]),
    ("Jekyll 文档：静态站点与文章", "https://jekyllrb.com/docs/",
     ["jekyll", "博客", "静态站点", "文章", "站点"]),
    ("Markdown 基本语法", "https://www.markdownguide.org/basic-syntax/",
     ["markdown", "写作", "排版", "语法"]),
    ("Git 官方文档", "https://git-scm.com/docs",
     ["git", "版本控制", "提交", "分支"]),
]


def _tokens(text):
    lowered = str(text or "").lower()
    words = set(re.findall(r"[a-z0-9]+", lowered))
    words.update(piece for piece in re.split(r"[\s,，。;；/、]+", lowered) if piece)
    return words


def run(params, ctx):
    keyword = str(params.get("keyword", "") or "").strip()
    limit = params.get("limit", 3)
    try:
        limit = max(1, int(limit))
    except (TypeError, ValueError):
        limit = 3
    if not keyword:
        return {"keyword": "", "links": []}

    tokens = _tokens(keyword)
    scored = []
    for title, url, tags in SOURCES:
        score = 0
        for tag in tags:
            tag_lower = tag.lower()
            if tag_lower in tokens or any(tag_lower in token or token in tag_lower for token in tokens if len(token) >= 2):
                score += 1
        if score:
            scored.append((score, title, url))
    scored.sort(key=lambda item: (-item[0], item[1]))
    links = [{"title": title, "url": url, "score": score} for score, title, url in scored[:limit]]
    return {"keyword": keyword, "links": links}
