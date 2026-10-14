"""直接问一下配好的模型。"""

SKILL = {
    "name": "model.chat",
    "title": "问模型",
    "description": "把 prompt（或 messages）发给配置好的模型，返回它的正文。",
    "tags": ["模型"],
    "params": {
        "prompt": "要问的话",
        "system": "可选的系统提示词",
        "temperature": "可选，默认 0.2",
        "max_tokens": "可选，回复长度上限",
    },
    "requiresModel": True,
}


def run(params, ctx):
    messages = params.get("messages")
    if not isinstance(messages, list) or not messages:
        messages = []
        system = str(params.get("system", "") or "").strip()
        if system:
            messages.append({"role": "system", "content": system})
        prompt = str(params.get("prompt", "") or "").strip()
        if not prompt:
            raise ValueError("prompt 不能为空")
        messages.append({"role": "user", "content": prompt})

    temperature = params.get("temperature", 0.2)
    try:
        temperature = float(temperature)
    except (TypeError, ValueError):
        temperature = 0.2

    max_tokens = params.get("max_tokens")
    if max_tokens is not None:
        try:
            max_tokens = int(max_tokens)
        except (TypeError, ValueError):
            max_tokens = None

    reply = ctx.chat(messages, temperature=temperature, max_tokens=max_tokens)
    return {"reply": reply, "model": (ctx.config or {}).get("model", "")}
