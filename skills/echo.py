"""回声：把输入原样返回，用来验证后端和技能链是通的。"""

SKILL = {
    "name": "echo",
    "title": "回声",
    "description": "把 text 原样返回，顺带报一下字符数。用来验证后端通不通。",
    "tags": ["调试"],
    "params": {"text": "要回显的文本"},
    "requiresModel": False,
}


def run(params, ctx):
    text = str(params.get("text", "") or "")
    ctx.log("echo " + str(len(text)) + " 字符")
    return {"text": text, "length": len(text)}
