"""interest.suggest —— 给兴趣标签当参谋。

设置页用它：进来先推一批预设方向，用户挑了一个之后再推 5 个相关的。
配了模型就让模型说（它知道各种技术方向的邻近关系），没配就退回内置的一份小词库，
保证设置页不会空着。
"""

import json
import re

SKILL = {
    "name": "interest.suggest",
    "title": "兴趣标签推荐",
    "description": "按当前兴趣标签推荐下一步可以关注的方向：mode=preset 给一批预设，mode=related 给 5 个相关的。",
    "tags": ["学习", "推荐"],
    "params": {
        "mode": "preset（预设一批）/ related（跟当前标签相关，默认）",
        "tags": "当前已有的兴趣标签数组",
        "limit": "要几个，默认 5",
    },
    "requiresModel": False,
}

# 兜底词库：按领域分小簇，related 时从命中簇里取
CLUSTERS = [
    ["编译器与 LLVM", "程序分析", "类型系统", "代码生成", "虚拟机与 JIT", "垃圾回收", "静态分析"],
    ["操作系统", "并发与锁", "虚拟内存", "文件系统", "进程调度", "内核", "C/C++ 系统编程"],
    ["分布式系统", "一致性协议", "消息队列", "服务网格", "容错与重试", "Cap 理论", "微服务"],
    ["数据库原理", "查询优化", "索引结构", "事务隔离", "存储引擎", "列式存储", "数据建模"],
    ["机器学习", "深度学习", "强化学习", "模型部署", "数据工程", "向量检索", "提示工程"],
    ["前端工程", "浏览器渲染", "构建工具链", "TypeScript", "无障碍", "Web 性能", "设计系统"],
    ["网络协议", "HTTP 与 TLS", "TCP/IP", "抓包与排障", "代理与隧道", "QUIC"],
    ["密码学", "网络安全", "认证与授权", "漏洞利用与防御", "零信任"],
    ["算法与数据结构", "动态规划", "图算法", "计算几何", "竞赛技巧", "复杂度分析"],
    ["图形学", "游戏引擎", "着色器", "渲染管线", "物理模拟"],
    ["后端服务", "API 设计", "鉴权与限流", "缓存设计", "任务队列", "服务拆分"],
    ["英语与写作", "技术写作", "文献阅读", "口语与听力", "结构化表达", "记笔记"],
    ["效率与工具", "命令行与脚本", "编辑器与快捷键", "笔记系统", "时间管理", "自动化流程"],
    ["开源与协作", "Git 工作流", "代码评审", "社区协作", "许可证与合规", "文档写作"],
    ["产品与交互设计", "需求分析", "信息架构", "交互原型", "可用性测试", "视觉基础"],
    ["金融科技", "支付与清算", "风控与反欺诈", "量化基础", "区块链与合约", "账务模型"],
]

PRESET = [
    "编译器与 LLVM", "操作系统", "分布式系统", "数据库原理", "机器学习",
    "前端工程", "网络协议", "算法与数据结构", "密码学", "图形学",
]


def _clean(tags, limit):
    picked = []
    for raw in tags or []:
        text = str(raw or "").strip()[:40]
        if text and text not in picked:
            picked.append(text)
    return picked[:limit]


def local_suggest(mode, tags, limit):
    known = {tag.lower() for tag in tags}
    pool = []
    if mode == "related" and tags:
        for cluster in CLUSTERS:
            if any(any(tag.lower() in item.lower() or item.lower() in tag.lower() for tag in tags) for item in cluster):
                pool.extend(cluster)
    if not pool:
        pool = list(PRESET)
    out = []
    for item in pool:
        if len(out) >= limit:
            break
        if item.lower() in known or item in out:
            continue
        out.append(item)
    return out


def _prompt(mode, tags, limit):
    if mode == "related":
        head = "这个人正在自学，现在的兴趣标签是：" + "、".join(tags)
        task = "推荐 " + str(limit) + " 个和这些标签相关、但还没列进去的技术方向（可以是它的下游、邻近领域或常用配套）。"
    else:
        head = "这个人想在自学任务板上挑几个方向关注。"
        task = "推荐 " + str(limit) + " 个互相不太重复、又都值得深入的技术方向。"
    return [
        {"role": "system", "content": "你只输出一个 JSON 对象，不要解释，也不要用代码块。"},
        {"role": "user", "content": head + "\n" + task
         + '\n格式：{"tags": ["方向1", "方向2"]}；每个 4-12 个字，具体一点（别写「编程」这种大词）。'},
    ]


def run(params, ctx):
    options = params or {}
    mode = str(options.get("mode") or "related").strip().lower()
    if mode not in ("related", "preset"):
        mode = "related"
    tags = _clean(options.get("tags"), 12)
    try:
        limit = max(1, min(8, int(options.get("limit") or 5)))
    except (TypeError, ValueError):
        limit = 5

    if mode == "related" and not tags:
        mode = "preset"

    if ctx.model_ready():
        try:
            reply = ctx.chat(_prompt(mode, tags, limit), temperature=0.6, max_tokens=300)
            found = _clean(_extract_tags(reply), limit)
            if found:
                ctx.log("模型给了 " + str(len(found)) + " 个标签")
                return {"ok": True, "mode": mode, "tags": found, "source": "model"}
        except Exception as error:  # noqa: BLE001 - 模型不行就退回本地词库
            ctx.log("模型没给成，用本地词库：" + str(error)[:120])

    return {"ok": True, "mode": mode, "tags": local_suggest(mode, tags, limit), "source": "local"}


def _extract_tags(text):
    raw = str(text or "")
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        # 模型可能只回了一行行标签，兜一下
        return re.findall(r"[\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9 +．./-]{2,20}", raw)[:10]
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return []
    if isinstance(data, dict):
        found = data.get("tags") or data.get("items") or []
    else:
        found = data if isinstance(data, list) else []
    return [str(item) for item in found if isinstance(item, (str, int, float))]
