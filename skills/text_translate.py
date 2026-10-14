"""翻译。"""

SKILL = {
    "name": "text.translate",
    "title": "翻译",
    "description": "让模型把 text 翻成目标语言。",
    "tags": ["模型", "文本"],
    "params": {"text": "要翻译的正文", "target": "目标语言，默认中文"},
    "requiresModel": True,
}


def run(params, ctx):
    text = str(params.get("text", "") or "").strip()
    if not text:
        raise ValueError("text 不能为空")
    target = str(params.get("target", "") or "").strip() or "中文"
    messages = [
        {"role": "system", "content": "你是翻译助手，把用户的内容翻成" + target + "，只输出译文。"},
        {"role": "user", "content": text},
    ]
    return {"text": ctx.chat(messages, temperature=0.1), "target": target}
