"""plan.outline —— 「大纲」的两种用法：按一句话改一版，或者把别处的规划读成知识点。

mode="revise"：手上已经有一份大纲，用户说一句要改什么，模型改一版回来（别的条目尽量别动）。
mode="import"：用户在别处（另一个 AI、教程、课程表）聊出来一份规划，整段贴进来，读成知识点；
               原文里的时间范围顺手推一个完成时间。

返回里 nodes 的 deps 写的是**标题**，前端 normalizeModelNodes 会换成 id。
两种都要模型；没配模型时 import 退回「按行拆」（编号、符号去掉），revise 直接说清改不了。
"""

import datetime
import json
import re

SKILL = {
    "name": "plan.outline",
    "title": "大纲（改 / 读）",
    "description": "mode=revise 按一句话改一版大纲；mode=import 把别处聊好的规划整段读成知识点。",
    "tags": ["规划", "目标"],
    "params": {
        "mode": "revise 或 import",
        "goal": "目标名（当上下文用）",
        "nodes": "现在的大纲（revise）：[{title, brief, deps, section, hours}]",
        "message": "用户要改什么（revise）",
        "text": "贴进来的规划原文（import）",
        "weekly": "每周投入小时数（可选）",
    },
    "requiresModel": True,
}

MAX_NODES = 40
MAX_TEXT = 12000
DEFAULT_HOURS = 1.5

SCHEMA = (
    "只输出一个 JSON 对象："
    '{"reply": "一句话说清你改了什么 / 读到了什么", '
    '"title": "目标名", '
    '"detail": "一句补充说明，可选", '
    '"deadline": "YYYY-MM-DD，推不出给空字符串", '
    '"nodes": [{"title": "知识点", "brief": "一句说明", '
    '"deps": ["前置知识点的标题"], "section": "阶段名，可选", "hours": 1.5}]}'
)

SYSTEM = "你是把长期目标拆成学习计划的人。你只输出一个 JSON 对象，不要解释，也不要用代码块。"


def _prompt_revise(goal, nodes, message, weekly):
    lines = ["用户手上有一份学习大纲，现在要按他的一句话改一版。", ""]
    if goal:
        lines.append("目标：" + goal)
    if weekly:
        lines.append("每周投入：" + str(weekly) + " 小时")
    lines += ["", "现在的大纲："]
    for node in nodes:
        title = str(node.get("title") or "").strip()
        if not title:
            continue
        bits = []
        brief = str(node.get("brief") or "").strip()
        if brief:
            bits.append(brief[:60])
        deps = [str(dep) for dep in (node.get("deps") or []) if str(dep).strip()]
        if deps:
            bits.append("前置：" + "、".join(deps))
        lines.append("- " + title + ("（" + "；".join(bits) + "）" if bits else ""))
    lines += [
        "",
        "用户的要求：" + message,
        "",
        "要求：",
        "- 只动用户说的那部分，其它条目**标题原样保留**、顺序别乱。",
        "- 每条写具体到一个人能坐下动手做完的事，别写「学好 X」这种空话。",
        "- deps 写**前置知识点的标题**，必须在大纲里出现过，不能指向自己、不能成环。",
        "- 总数控制在 4–40 条，不要越改越多。",
        "- reply 一句话说清改了什么，别客套。",
        "- " + SCHEMA,
    ]
    return [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": "\n".join(lines)},
    ]


def _prompt_import(text, weekly):
    lines = [
        "用户从别处（另一个 AI、教程、课程安排）复制来一份学习规划，你把它读成「目标 + 知识点」。",
        "",
        "原文：",
        text,
        "",
    ]
    if weekly:
        lines.append("用户每周能投入 " + str(weekly) + " 小时。")
    lines += [
        "要求：",
        "- 知识点从原文里提，**不要另编一套**；原文分阶段就把阶段名放进 section。",
        "- 顺序照原文；原文写了先后关系（「先…再…」「第 2 周开始」）就写成 deps。",
        "- 原文给了时长 / 次数就按它估 hours，没给就估 1.5。",
        "- deadline 从原文的时间范围推（几月几号、第几周、几周内），推不出给空字符串。",
        "- title 用原文里的目标名，没写就按内容起一个，别超过 20 字。",
        "- reply 两句话：你读到了什么、哪处不确定要用户核对，别客套。",
        "- " + SCHEMA,
    ]
    return [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": "\n".join(lines)},
    ]


def _extract(text):
    raw = str(text or "")
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        return {}
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _clean_nodes(raw):
    """只留能用的：标题必填、去重、丢掉指向不存在的前置、砍掉超长的。"""
    items = raw if isinstance(raw, list) else []
    nodes = []
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("name") or "").strip()
        if not title:
            continue
        title = re.sub(r"\s+", " ", title)[:80]
        if title in seen:
            continue
        seen.add(title)
        try:
            hours = float(item.get("hours"))
        except (TypeError, ValueError):
            hours = 0
        nodes.append({
            "title": title,
            "brief": re.sub(r"\s+", " ", str(item.get("brief") or item.get("acceptance") or "").strip())[:120],
            "deps": [str(dep).strip()[:80] for dep in (item.get("deps") or item.get("dependsOn") or [])
                     if str(dep).strip()],
            "section": str(item.get("section") or "").strip()[:40],
            "hours": round(hours * 2) / 2 if 0 < hours <= 12 else DEFAULT_HOURS,
        })
        if len(nodes) >= MAX_NODES:
            break
    known = set(node["title"] for node in nodes)
    for node in nodes:
        node["deps"] = [dep for dep in node["deps"] if dep in known and dep != node["title"]][:6]
    return nodes


BULLET = re.compile(r"^\s*(?:[-*•·—–]|\d+\s*[.、)）]|[（(]\s*\d+\s*[)）]|[一二三四五六七八九十]+\s*[、.)）])\s*")
# 「第 1 周」「2-4 周」「第三阶段」「Part 2」这类当小标题，不当知识点
SECTION = re.compile(
    r"^(?:第\s*)?[\d一二三四五六七八九十]+(?:\s*[-–~至]\s*[\d一二三四五六七八九十]+)?\s*"
    r"(?:周|个月|月|天|阶段|章|单元|部分|模块|环节|Step|Part)"
)
GOAL_LINE = re.compile(r"^\s*(?:学习)?目标\s*[:：]\s*(.+)$")
HOURS_TAIL = re.compile(r"[（(]\s*([\d.]+)\s*(?:小时|个小时|h|hours?)\s*[)）]")
DATE_FULL = re.compile(r"(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})")
DATE_SHORT = re.compile(r"(?<!\d)(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?")
DEADLINE_LINE = re.compile(r"^\s*(?:目标)?(?:预计|计划)?(?:完成|截止)\s*时间\s*[:：]")


def _is_section(line):
    if len(line) > 20:
        return False
    if line.endswith("：") or line.endswith(":"):
        return True
    return bool(SECTION.match(line))


def _take_hours(line):
    """「背 50 个词（1 小时）」→ 标题里去掉括号，时长当 hours。"""
    match = HOURS_TAIL.search(line)
    if not match:
        return line, 0
    try:
        hours = float(match.group(1))
    except ValueError:
        return line, 0
    return (line[:match.start()] + line[match.end():]).strip(), (round(hours * 2) / 2 if 0 < hours <= 12 else 0)


def _slice_line(line):
    """一行太长（多半是整段话）就按标点切开，别让一个知识点塞半屏。"""
    text = line.strip()
    if len(text) <= 44:
        return [text]
    parts = re.split(r"[；;。！!？?]\s*", text)
    out = []
    for part in parts:
        part = part.strip()
        while len(part) > 44:
            out.append(part[:44].strip())
            part = part[44:].strip()
        if part:
            out.append(part)
    return out


def _local_nodes(text):
    """没配模型时的兜底：按行（或按标点）拆，编号和符号去掉。"""
    nodes = []
    seen = set()
    section = ""
    title = ""
    for raw_line in str(text or "").splitlines():
        line = BULLET.sub("", raw_line).strip()
        if not line:
            continue
        goal = GOAL_LINE.match(line)
        if goal and not title:
            title = goal.group(1).strip()[:60]
            continue
        if DEADLINE_LINE.match(line):
            continue
        if _is_section(line):
            section = line.rstrip(":：")
            continue
        for piece in _slice_line(line):
            piece, hours = _take_hours(piece)
            if not piece or piece in seen:
                continue
            seen.add(piece)
            nodes.append({"title": piece, "brief": "", "deps": [], "section": section,
                          "hours": hours or DEFAULT_HOURS})
            if len(nodes) >= MAX_NODES:
                return nodes, title
    return nodes, title


def _deadline_from_text(text):
    """从原文里推完成时间：取最靠后的那个日期，没写就给空字符串。"""
    today = datetime.date.today()
    found = []
    raw = str(text or "")
    for year, month, day in DATE_FULL.findall(raw):
        try:
            found.append(datetime.date(int(year), int(month), int(day)))
        except ValueError:
            continue
    for month, day in DATE_SHORT.findall(raw):
        try:
            found.append(datetime.date(today.year, int(month), int(day)))
        except ValueError:
            continue
    if not found:
        return ""
    future = [item for item in found if item > today]
    return max(future or found).isoformat()


def _fallback_reply(mode, nodes):
    """模型偶尔不按格式给 reply：至少说清这版变成了几条。"""
    count = len(nodes)
    if mode == "import":
        return "读成 " + str(count) + " 个知识点，你核对一下；缺的、要合并的，下面说一句。"
    return "这版改成了 " + str(count) + " 个知识点，看看对不对；还要动就直接说。"


def _answer(data, mode, fallback_title, text, source):
    nodes = _clean_nodes(data.get("nodes"))
    if not nodes:
        return None
    deadline = str(data.get("deadline") or "").strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", deadline):
        deadline = _deadline_from_text(text) if mode == "import" else ""
    return {
        "ok": True,
        "mode": mode,
        "source": source,
        "reply": str(data.get("reply") or "").strip()[:300] or _fallback_reply(mode, nodes),
        "title": str(data.get("title") or fallback_title or "").strip()[:60],
        "detail": str(data.get("detail") or "").strip()[:200],
        "deadline": deadline,
        "nodes": nodes,
    }


def _run_revise(options, ctx):
    message = str(options.get("message") or "").strip()
    if not message:
        return {"ok": False, "error": "先说一句要改什么。"}
    nodes = options.get("nodes") if isinstance(options.get("nodes"), list) else []
    if not nodes:
        return {"ok": False, "error": "手上还没有大纲，改不了。"}
    if not ctx.model_ready():
        return {"ok": False, "error": "改大纲得靠助手 —— 先在设置页把模型配上，或者直接在下面手动改。"}
    try:
        reply = ctx.chat(
            _prompt_revise(str(options.get("goal") or "").strip(), nodes, message, options.get("weekly")),
            temperature=0.3,
            max_tokens=2400,
        )
    except Exception as error:  # noqa: BLE001 - 模型那边的问题原样回给前端
        return {"ok": False, "error": "模型没答上来：" + str(error)[:160]}
    answer = _answer(_extract(reply), "revise", options.get("goal"), "", "model")
    if answer is None:
        return {"ok": False, "error": "这版没给出能用的知识点，再说一句试试。"}
    ctx.log("改成 " + str(len(answer["nodes"])) + " 个知识点")
    return answer


def _run_import(options, ctx):
    text = str(options.get("text") or "").strip()[:MAX_TEXT]
    if not text:
        return {"ok": False, "error": "先把那份规划贴进来。"}
    goal = str(options.get("goal") or "").strip()
    if ctx.model_ready():
        try:
            reply = ctx.chat(_prompt_import(text, options.get("weekly")), temperature=0.3, max_tokens=2600)
            answer = _answer(_extract(reply), "import", goal, text, "model")
            if answer is not None:
                ctx.log("读成 " + str(len(answer["nodes"])) + " 个知识点")
                return answer
        except Exception as error:  # noqa: BLE001 - 读不出来就退回按行拆
            ctx.log("模型读不动，退回按行拆：" + str(error)[:120])
    nodes, title = _local_nodes(text)
    if not nodes:
        return {"ok": False, "error": "这段文字里没找到能当知识点的行。"}
    return {
        "ok": True,
        "mode": "import",
        "source": "local",
        "reply": "没配模型，我按行拆的：编号和符号去掉了，前后关系没推 —— 你核对一下，缺的上面对面说一句。",
        "title": goal or title,
        "detail": "",
        "deadline": _deadline_from_text(text),
        "nodes": nodes,
    }


def run(params, ctx):
    options = params or {}
    mode = str(options.get("mode") or "revise").strip().lower()
    if mode == "import":
        return _run_import(options, ctx)
    if mode == "revise":
        return _run_revise(options, ctx)
    return {"ok": False, "error": "mode 只能是 revise 或 import。"}
