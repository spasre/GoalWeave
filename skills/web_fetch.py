"""拉一个网页，把正文（HTML 已粗略去标签）取回来。"""

SKILL = {
    "name": "web.fetch",
    "title": "抓网页",
    "description": "GET 一个 http/https 地址，返回纯文本（已去掉标签，默认截断到 20 万字符）。",
    "tags": ["网络"],
    "params": {"url": "要抓的地址", "limit": "可选，最多返回多少字符"},
    "requiresModel": False,
}


def run(params, ctx):
    url = str(params.get("url", "") or "").strip()
    if not url:
        raise ValueError("url 不能为空")
    limit = params.get("limit", 200000)
    try:
        limit = max(1, int(limit))
    except (TypeError, ValueError):
        limit = 200000
    text = ctx.http_get(url, limit=limit)
    return {"url": url, "length": len(text), "text": text}
