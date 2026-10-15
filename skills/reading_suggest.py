"""reading.suggest —— 让模型给一个知识点找几条**真能打开**的延伸阅读。

内置目录（`reading.links` 和前端 `ARTICLE_SOURCES`）是手挑的，覆盖不到「RAG 的混合检索重排」
这种新题目。这个技能就是补这个空：模型按标题 + 一句说明想几条资料，后端再**逐条真去请求一次**，
连不上或 404 的直接丢掉 —— 不再把模型锁死在「只能从目录里挑」之后，最怕的就是它编 URL，
所以宁可少给两条，也不给打不开的。

前端在推荐阅读弹窗里点「让助手找」时会走它；每日推荐的标题在目录里没命中时也会顺手问一下。
"""

import concurrent.futures
import json
import re

SKILL = {
    "name": "reading.suggest",
    "title": "延伸阅读（助手找）",
    "description": "按标题 / 说明让模型找几条延伸阅读，并逐条验证 URL 真能打开，打不开的不返回。",
    "tags": ["资料", "任务"],
    "params": {
        "title": "知识点或任务的标题",
        "brief": "一句话说明（可选，给模型当上下文）",
        "category": "分类（可选）",
        "limit": "要几条，默认 3",
    },
    "requiresModel": True,
}

CHECK_TIMEOUT = 8.0
CHECK_BYTES = 4096
# 有些站不认 HEAD、或者直接挡机器人：能连上、只是不给我们看，就当它存在
ALIVE_CODES = (401, 403, 405, 406, 418, 429)


def _prompt(title, brief, category, limit):
    lines = ["这个人在自学，想给下面这个知识点找几条延伸阅读。", "", "标题：" + title]
    if brief:
        lines.append("说明：" + brief)
    if category:
        lines.append("分类：" + category)
    lines += [
        "",
        "要求：",
        "- 找 " + str(limit) + " 条，优先**官方文档 / 语言或规范原文 / 权威教程 / 论文的原始页面**"
        "（比如 llvm.org/docs、cppreference、MDN、RFC、arXiv、man7.org）。",
        "- **只给真实存在的地址**：宁可是一个稳定的入口页（例如 https://llvm.org/docs/），"
        "也不要编一个带锚点、带查询参数的深层链接。",
        "- 不要搜索引擎结果页，不要聚合 / 搬运站，不要需要登录才能看的。",
        "- 实在没有把握的就别凑数，少给两条比给错强。",
        '格式：{"links": [{"title": "资料名（中文，写清它是什么）", "url": "https://..."}]}',
    ]
    return [
        {"role": "system", "content": "你只输出一个 JSON 对象，不要解释，也不要用代码块。"},
        {"role": "user", "content": "\n".join(lines)},
    ]


def _extract_links(text, limit):
    raw = str(text or "")
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return []
    items = data.get("links") if isinstance(data, dict) else data
    out = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str):
            item = {"url": item}
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or item.get("link") or "").strip()
        if not re.match(r"^https?://\S+$", url, re.I):
            continue
        if any(entry["url"] == url for entry in out):
            continue
        title = str(item.get("title") or item.get("name") or "").strip()
        out.append({"title": title[:120] or url, "url": url})
        if len(out) >= limit * 2:  # 多留几条，验证挂掉的还在后面顶着
            break
    return out


def _alive(ctx, url):
    """真去请求一次：连得上、不是 404 就算存在。"""
    try:
        ctx.http_get(url, timeout=CHECK_TIMEOUT, limit=200, max_bytes=CHECK_BYTES)
        return True
    except Exception as error:  # noqa: BLE001 - 打不开就是打不开，原因不重要
        text = str(error)
        return any(" " + str(code) in text for code in ALIVE_CODES)


def run(params, ctx):
    options = params or {}
    title = str(options.get("title") or "").strip()
    brief = str(options.get("brief") or "").strip()
    category = str(options.get("category") or "").strip()
    try:
        limit = max(1, min(5, int(options.get("limit") or 3)))
    except (TypeError, ValueError):
        limit = 3
    if not title:
        return {"ok": False, "error": "没有标题，不知道要找什么。"}
    if not ctx.model_ready():
        return {"ok": False, "error": "还没配模型接口，先在设置页把助手配上。"}

    try:
        reply = ctx.chat(_prompt(title, brief, category, limit), temperature=0.3, max_tokens=700)
    except Exception as error:  # noqa: BLE001 - 模型那边的问题原样回给前端
        return {"ok": False, "error": "模型没答上来：" + str(error)[:160]}

    wanted = _extract_links(reply, limit)
    if not wanted:
        return {"ok": True, "links": [], "checked": 0, "dropped": 0, "source": "model"}

    kept = []
    dropped = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(5, len(wanted))) as pool:
        results = list(pool.map(lambda item: _alive(ctx, item["url"]), wanted))
    for item, ok in zip(wanted, results):
        if not ok:
            dropped += 1
            continue
        if len(kept) >= limit:
            continue
        kept.append(item)

    ctx.log("模型给了 " + str(len(wanted)) + " 条，验证后留下 " + str(len(kept)) + " 条（丢掉 " + str(dropped) + " 条）")
    return {"ok": True, "links": kept, "checked": len(wanted), "dropped": dropped, "source": "model"}
