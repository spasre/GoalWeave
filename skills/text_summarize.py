"""把一段长文本压缩成几句话。"""

SKILL = {
    "name": "text.summarize",
    "title": "总结",
    "description": "让模型把 text 总结成几句话，可指定要点条数。",
    "tags": ["模型", "文本"],
    "params": {"text": "要总结的正文", "maxPoints": "可选，要点条数，默认 3"},
    "requiresModel": True,
}


def run(params, ctx):
    text = str(params.get("text", "") or "").strip()
    if not text:
        raise ValueError("text 不能为空")
    points = params.get("maxPoints", 3)
    try:
        points = int(points)
    except (TypeError, ValueError):
        points = 3
    messages = [
        {"role": "system", "content": "你是中文总结助手，只输出总结本身，最多 " + str(points) + " 条要点。"},
        {"role": "user", "content": text},
    ]
    return {"summary": ctx.chat(messages, temperature=0.2), "sourceLength": len(text)}
