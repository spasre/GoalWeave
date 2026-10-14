"""把一句话拆成任务：配了模型就交给模型，没配就用内置规则。"""

import datetime
import json
import re

SKILL = {
    "name": "plan.tasks",
    "title": "拆任务",
    "description": "把一段话拆成可执行任务（标题/分类/紧急程度/日期），配了模型走模型，否则用内置规则。",
    "tags": ["规划", "任务"],
    "params": {
        "prompt": "要拆的话，例如「复习 IR；周三整理周报」",
        "categories": "可选，允许的分类列表",
        "defaultCategory": "可选，拿不准时用的分类",
        "today": "可选，今天日期 YYYY-MM-DD",
    },
    "requiresModel": False,
}

URGENCY_KEYS = ["urgent", "high", "normal", "low"]
WEEKDAYS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7}

SYSTEM_PROMPT = (
    "你是一个任务规划助手，把用户说的话拆成可执行的任务。\n"
    "只输出一个 JSON 对象，不要解释、不要 markdown 代码块，格式是：\n"
    '{"reply": "给用户看的一两句话", "tasks": [{"title": "任务标题", "category": "分类", '
    '"urgency": "urgent|high|normal|low", "date": "YYYY-MM-DD 或空"}]}\n'
    "没有新任务时 tasks 就是空数组。"
)


def _today(params):
    value = str(params.get("today", "") or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return value
    return datetime.date.today().isoformat()


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


def _normalize(items, categories, default_category):
    out = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("name") or "").strip()
        if not title:
            continue
        category = item.get("category") if item.get("category") in categories else default_category
        urgency = item.get("urgency") if item.get("urgency") in URGENCY_KEYS else "normal"
        date = str(item.get("date") or "").strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            date = ""
        out.append({"title": title, "category": category, "urgency": urgency, "date": date})
    return out


def _local_plan(text, categories, default_category, today):
    parts = [piece.strip(" \t-*·。") for piece in re.split(r"[\n;；。]+|\d+[.、)]", text)]
    tasks = []
    base = datetime.date.fromisoformat(today)
    for piece in parts:
        piece = piece.strip()
        if len(piece) < 2:
            continue
        date = ""
        if "今天" in piece:
            date = today
        elif "明天" in piece:
            date = (base + datetime.timedelta(days=1)).isoformat()
        elif "后天" in piece:
            date = (base + datetime.timedelta(days=2)).isoformat()
        else:
            weekday = re.search(r"周([一二三四五六日天])", piece)
            if weekday:
                target = WEEKDAYS[weekday.group(1)]
                delta = (target - base.isoweekday()) % 7 or 7
                date = (base + datetime.timedelta(days=delta)).isoformat()
            else:
                exact = re.search(r"\d{4}-\d{2}-\d{2}", piece)
                if exact:
                    date = exact.group(0)
        urgency = "normal"
        if re.search(r"紧急|马上|立刻", piece):
            urgency = "urgent"
        elif re.search(r"重要|尽快", piece):
            urgency = "high"
        elif re.search(r"不急|有空|随便", piece):
            urgency = "low"
        tasks.append({
            "title": piece,
            "category": default_category,
            "urgency": urgency,
            "date": date,
        })
    return tasks


def run(params, ctx):
    text = str(params.get("prompt", "") or "").strip()
    if not text:
        raise ValueError("prompt 不能为空")

    raw_categories = params.get("categories")
    categories = [str(item).strip() for item in raw_categories if str(item).strip()] \
        if isinstance(raw_categories, list) else []
    default_category = str(params.get("defaultCategory", "") or "").strip() or (categories[0] if categories else "默认")
    today = _today(params)

    if not ctx.model_ready():
        tasks = _local_plan(text, categories, default_category, today)
        reply = "内置规划拆出 " + str(len(tasks)) + " 个任务。"
        return {"source": "local", "reply": reply, "tasks": tasks}

    system = SYSTEM_PROMPT + "\n今天是 " + today + "。"
    if categories:
        system += "\ncategory 只能从这些里选：" + "、".join(categories) + "；拿不准就用 " + default_category + "。"
    content = ctx.chat(
        [{"role": "system", "content": system}, {"role": "user", "content": text}],
        temperature=0.2,
    )
    parsed = _extract_json(content)
    items = parsed.get("tasks") if isinstance(parsed, dict) else parsed
    tasks = _normalize(items, categories, default_category)
    reply = ""
    if isinstance(parsed, dict):
        reply = str(parsed.get("reply", "") or "").strip()
    if not reply:
        reply = "模型拆出 " + str(len(tasks)) + " 个任务。"
    return {"source": "api", "reply": reply, "tasks": tasks}
