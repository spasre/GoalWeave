"""diagram.roadmap —— 把知识点及其依赖关系画成一张可以缩放查看的路线图。

底层用 vendored 的 Archify（``skills/vendor/archify``，MIT，v3.0.1），它会把图校验
一遍再吐一张自带明暗主题、可导出的独立 HTML，所以「边会不会拧在一起」「字会不会
挤爆节点」这类问题由它来回报告，不用我们瞎猜。

输入两种写法：

1. ``nodes`` + ``edges``：应用内部的知识点格式
   ``[{id, title, short, deps: [id], level, links: [{title, url}]}, ...]``
2. ``candidate``：直接把一份完整的 Archify architecture IR 丢进来（高级用法）

输出落在 ``<站点根>/diagrams/<名字>.html``，同一份 candidate 也留在旁边，
方便以后重画或手工调。
"""

import hashlib
import json
import math
import re
import shutil
import subprocess
import time
import unicodedata
from pathlib import Path

ARCHIFY_DIR = Path(__file__).resolve().parent / "vendor" / "archify"
ARCHIFY_CLI = ARCHIFY_DIR / "bin" / "archify.mjs"
OUT_DIR_NAME = "diagrams"

# 节点排在网格里，格子大小要留得住标签：Archify 会量「标签宽 ≤ 节点宽」，
# 所以这几个数字是按中文字符宽度（约 13px）反推出来的，改小会被它打回。
CELL_W = 192
CELL_H = 90
GAP_X = 32
GAP_Y = 44
NODE_W = 176
NODE_H = 68
PAD = 44
ASCII_PX = 6.5
WIDE_PX = 13.0
# Archify 的「桌面可读性」这条：1440 宽的窗口里图占 930px，节点里最小的那行字投影下来
# 不能低于 6px，反推画布宽度得 ≤ 1395px，超一两个像素也会被它打回。所以画布宽度按这个
# 预算来配：先缩格子，格子缩到底还排不下就少排几列（一层太宽就折成几行）。
CANVAS_W_BUDGET = 1395
CELL_W_MIN = NODE_W + 8
GAP_X_MIN = 16
# Archify 的 schema 底线：画布宽度不能小于这个（一列到底的直线图会算得更窄）
MIN_VIEW_W = 320
# 每层换一个组件类型，靠颜色把「第几步」区分开
LEVEL_TYPES = ["frontend", "backend", "messagebus", "database", "cloud", "security", "external"]

# 一条长链会被铺成一根细柱子（又窄又高，嵌在页面里根本看不清），
# 所以层数多、又窄的时候折成蛇形几列；折完再排，箭头依然是一条线走下来的。
WRAP_AFTER = 6          # 至少这么多层才值得折
THIN_RATIO = 3.0        # 高 > 宽 × 这个倍数，才算「细柱子」
WRAP_COLUMNS = 3        # 折成几列
# 节点文字统一放大一点：Archify 按 1.2em 量中文宽（真实字宽 1em），留了 20% 余量
FONT_SCALE = 1.2
TEXT_CSS = """<style id="roadmap-text-scale">
  /* 学习路线图：把节点文字整体放大一点（Archify 量宽时按 1.2em/汉字，这里正好用掉那份余量） */
  svg [data-node-label] { font-size: %(label).1fpx !important; }
  svg [data-detail="context"] { font-size: %(sub).1fpx !important; }
  svg [data-detail="fine"] { font-size: %(tag).1fpx !important; }
  .cards .card h3 { font-size: %(cardtitle).1fpx !important; }
  .cards .card li { font-size: %(carditem).1fpx !important; }
</style>"""

SKILL = {
    "name": "diagram.roadmap",
    "title": "学习路线图",
    "description": "把知识点和它们的依赖关系画成一张学习路线图 HTML（能缩放、能导出），输出到 diagrams/ 目录。",
    "tags": ["绘图", "知识点", "路线图"],
    "params": {
        "title": "图标题",
        "nodes": "知识点数组：[{id, title, short, deps, level, links, done}]（done 的节点会标成绿的「已完成」）",
        "cards": "图下面的清单：links（标题+教程链接）/ titles（只列标题）/ none（不放）",
        "level_labels": "每一层的名字，比如 ['基础', '核心', '进阶']",
        "name": "输出文件名（不含扩展名），默认按标题生成",
        "quality": "showcase（默认，卡得更严）/ standard",
        "candidate": "也可以直接给一份完整的 Archify architecture JSON",
    },
    "requiresModel": False,
}


def text_width(text):
    """粗估一行文字占多宽：ASCII 一个单位，中日韩字符算两个。"""
    total = 0.0
    for char in str(text):
        total += WIDE_PX if unicodedata.east_asian_width(char) in ("W", "F", "A") else ASCII_PX
    return total


def fit_label(text, limit):
    """裁到不超宽为止，尾巴留个省略号。"""
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if text_width(text) <= limit:
        return text
    kept = ""
    for char in text:
        if text_width(kept + char + "…") > limit:
            break
        kept += char
    return (kept or text[:1]) + "…"


def slugify(text, fallback="roadmap"):
    """文件名尽量只用 ASCII：中文名在 URL / 静态服务里容易出幺蛾子。"""
    slug = re.sub(r"[^0-9a-zA-Z]+", "-", str(text or "")).strip("-")
    slug = re.sub(r"-{2,}", "-", slug).lower()
    if slug:
        return slug[:48]
    digest = hashlib.sha1(str(text or "").encode("utf-8")).hexdigest()[:8]
    return fallback + "-" + digest


def normalize(nodes):
    """把外面给的知识点补成统一形状，顺手把 id 规整成 Archify 认的格式。"""
    clean = []
    seen = {}
    for index, raw in enumerate(nodes or []):
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or raw.get("label") or "").strip()
        if not title:
            continue
        ident = re.sub(r"[^0-9a-zA-Z_-]", "", str(raw.get("id") or "")) or "n" + str(index + 1)
        while ident in seen:
            ident += "x"
        seen[ident] = True
        clean.append({
            "id": ident,
            "title": title,
            "short": str(raw.get("short") or "").strip(),
            "deps": [re.sub(r"[^0-9a-zA-Z_-]", "", str(dep)) for dep in (raw.get("deps") or [])],
            "level": raw.get("level"),
            "links": [link for link in (raw.get("links") or []) if isinstance(link, dict) and link.get("url")],
            "brief": str(raw.get("brief") or "").strip(),
            "done": bool(raw.get("done")),
        })
    known = {item["id"] for item in clean}
    for item in clean:
        item["deps"] = [dep for dep in item["deps"] if dep in known and dep != item["id"]]
    return clean


def layer_of(nodes):
    """最长路径分层：一条链上的知识点一定是从上往下一层层铺开的。"""
    by_id = {item["id"]: item for item in nodes}
    levels = {}

    def resolve(ident, path):
        if ident in levels:
            return levels[ident]
        if ident in path:  # 环：别再往上找了
            return 0
        item = by_id.get(ident)
        if item is None:
            return 0
        depth = 0
        for dep in item["deps"]:
            depth = max(depth, resolve(dep, path | {ident}) + 1)
        levels[ident] = depth
        return depth

    for item in nodes:
        resolve(item["id"], set())
    return levels


def column_offset(count, width):
    """层内居中的列偏移，必须是整数：小数取整会让两个节点挤进同一个格子。"""
    return (width - count) // 2


def max_columns():
    """画布宽度预算下最多还能并排几个格子（按最小格子、最小间距算）。"""
    room = CANVAS_W_BUDGET - PAD * 2 + GAP_X_MIN
    return max(1, room // (CELL_W_MIN + GAP_X_MIN))


def fit_geometry(columns):
    """挑格子宽度与格间距：先尽量保住格子宽度，再拿剩下的空间补间距。"""
    if columns <= 1:
        return CELL_W, GAP_X
    for cell_w in range(CELL_W, CELL_W_MIN - 1, -4):
        room = CANVAS_W_BUDGET - PAD * 2 - columns * cell_w
        gap = min(GAP_X, room // (columns - 1))
        if gap >= GAP_X_MIN:
            return cell_w, gap
    return CELL_W_MIN, GAP_X_MIN


def pack_slots(slots, columns):
    """一层的知识点太多就折成几行：横着铺满画布会被 Archify 以「桌面可读性」打回。"""
    limit = max_columns()
    if columns <= limit:
        return slots, columns, len({row for row, _ in slots.values()})
    bands = {}
    for ident, (row, column) in slots.items():
        bands.setdefault(row, []).append((column, ident))
    plan = []
    width = 0
    for depth in sorted(bands):
        items = [ident for _, ident in sorted(bands[depth])]
        chunks = -(-len(items) // limit)             # 这一层要折成几行（向上取整）
        step = min(limit, -(-len(items) // chunks))  # 每行放几个：尽量匀，末行不落单
        plan.append((items, step))
        width = max(width, step)
    grid = {}
    row = 0
    for items, step in plan:
        for start in range(0, len(items), step):
            chunk = items[start:start + step]
            offset = column_offset(len(chunk), width)
            for index, ident in enumerate(chunk):
                grid[ident] = (row, index + offset)
            row += 1
    return grid, width, row


def edge_crossings(positions, edges):
    """数一下这些连线互相穿了几次（按层号做线性插值，两条线段在半高处的左右关系是否翻转）。"""
    def x_at(pos_a, pos_b, y):
        (ax, ay), (bx, by) = pos_a, pos_b
        if ay == by:
            return ax
        return ax + (y - ay) / (by - ay) * (bx - ax)

    total = 0
    lines = [((positions[a][0], positions[a][1]), (positions[b][0], positions[b][1])) for a, b in edges]
    for i in range(len(lines)):
        for j in range(i + 1, len(lines)):
            one, two = lines[i], lines[j]
            low = max(min(one[0][1], one[1][1]), min(two[0][1], two[1][1]))
            high = min(max(one[0][1], one[1][1]), max(two[0][1], two[1][1]))
            if low >= high:
                continue
            mid = (low + high) / 2.0
            before = x_at(one[0], one[1], mid) - x_at(two[0], two[1], mid)
            after = x_at(one[0], one[1], high) - x_at(two[0], two[1], high)
            if before * after < 0:
                total += 1
    return total


def reduce_crossings(rows, slots, nodes):
    """层内顺序做爬山：哪一层换个顺序能少几条交叉就换。"""
    by_id = {item["id"]: item for item in nodes}
    edges = [(dep, item["id"]) for item in nodes for dep in item["deps"]]
    order = {depth: list(bucket) for depth, bucket in rows.items()}

    def positions():
        out = {}
        width = max((len(bucket) for bucket in order.values()), default=1)
        for depth, bucket in order.items():
            offset = column_offset(len(bucket), width)
            for index, ident in enumerate(bucket):
                out[ident] = (index + offset, float(depth))
        return out

    best = edge_crossings(positions(), edges)
    improved = True
    while improved and best > 0:
        improved = False
        for depth in sorted(order):
            bucket = order[depth]
            for i in range(len(bucket) - 1):
                bucket[i], bucket[i + 1] = bucket[i + 1], bucket[i]
                score = edge_crossings(positions(), edges)
                if score < best:
                    best = score
                    improved = True
                else:
                    bucket[i], bucket[i + 1] = bucket[i + 1], bucket[i]

    width = max((len(bucket) for bucket in order.values()), default=1)
    for depth, bucket in order.items():
        offset = column_offset(len(bucket), width)
        for index, ident in enumerate(bucket):
            slots[ident] = (depth, index + offset)
    return best


def wrap_slots(rows, slots, columns):
    """长链会被铺成一根又窄又高的柱子，折成蛇形几列，读起来顺、字也看得清。"""
    layers = sorted(rows)
    if len(layers) <= WRAP_AFTER or columns > 2:
        return slots, columns, len(layers)
    if len(layers) * CELL_H <= THIN_RATIO * columns * CELL_W:
        return slots, columns, len(layers)
    width = min(WRAP_COLUMNS, len(layers))
    grid = {}
    row = 0
    for band_start in range(0, len(layers), width):
        band = layers[band_start:band_start + width]
        height = max(len(rows[depth]) for depth in band)
        for offset, depth in enumerate(band):
            col = offset if (band_start // width) % 2 == 0 else (len(band) - 1 - offset)
            for index, ident in enumerate(rows[depth]):
                grid[ident] = (row + index, col)
        row += height
    return grid, width, row


def levels_of(nodes):
    """每个节点落在第几层：默认按最长路径算，节点自己声明了 level 就听它的。"""
    levels = layer_of(nodes)
    for item in nodes:
        declared = item.get("level")
        if isinstance(declared, int) and declared >= 0:
            levels[item["id"]] = declared
    return levels


def arrange(nodes):
    """分层 → 层内按「上游的平均列号」排序 → 每层居中 → 再爬山减少交叉。"""
    levels = levels_of(nodes)
    by_id = {item["id"]: item for item in nodes}
    rows = {}
    for item in nodes:
        rows.setdefault(levels[item["id"]], []).append(item["id"])

    placed = {}
    for depth in sorted(rows):
        bucket = rows[depth]
        # sort 过程中 CPython 会把列表临时清空，所以位置得先存下来（不能在里面 index）
        origin = {ident: index for index, ident in enumerate(bucket)}

        def key(ident, origin=origin):
            deps = [dep for dep in by_id[ident]["deps"] if dep in placed]
            if not deps:
                return (0.0, origin[ident])
            return (sum(placed[dep] for dep in deps) / len(deps), origin[ident])

        bucket.sort(key=key)
        for column, ident in enumerate(bucket):
            placed[ident] = column

    width = max((len(bucket) for bucket in rows.values()), default=1)
    slots = {}
    for depth, bucket in rows.items():
        offset = column_offset(len(bucket), width)
        for column, ident in enumerate(bucket):
            slots[ident] = (depth, column + offset)
    # 交叉数还能再降就继续调层内顺序（Archify 那边也会重排走线，但顺序好了它才好走）
    left = reduce_crossings(rows, slots, nodes)
    return rows, slots, width, left


def build_candidate(title, nodes, options):
    """拼一份 Archify 的 architecture IR。"""
    rows, slots, columns, crossings = arrange(nodes)
    levels = levels_of(nodes)
    slots, columns, height = wrap_slots(rows, slots, columns)
    slots, columns, height = pack_slots(slots, columns)
    cell_w, gap_x = fit_geometry(columns)
    labels = [str(item) for item in (options.get("level_labels") or [])]
    subtitle = str(options.get("subtitle") or "").strip() or ("共 " + str(len(nodes)) + " 个知识点")

    content_w = columns * cell_w + (columns - 1) * gap_x
    # Archify 的 schema 要求画布宽度 ≥ 320：知识点少的直线图（一列）算出来会比这还窄，
    # 撑到最低宽度，多出来的空白平摊到两边，图不至于贴在左边。
    view_w = max(content_w + PAD * 2, MIN_VIEW_W)
    view_h = height * CELL_H + max(height - 1, 0) * GAP_Y + PAD * 2
    pad_x = round((view_w - content_w) / 2)

    # 图例本来是架构图那套词（前端 / 后端 / 消息总线），学习路线图里得换成自己的层名。
    # 层数一多，图例就要好几排，挤不下（legend/vertical-overflow）时干脆收起来。
    hide_legend = bool(options.get("hide_legend"))
    level_name = {}
    for depth in range(max(levels.values()) + 1 if levels else 0):
        level_name[LEVEL_TYPES[depth % len(LEVEL_TYPES)]] = (
            labels[depth] if depth < len(labels) else ("第 " + str(depth + 1) + " 步"))
    legend = {}
    for kind in LEVEL_TYPES:
        if not hide_legend and kind in level_name:
            legend[kind] = {"label": str(level_name[kind])[:80], "visible": True}
        else:
            legend[kind] = {"visible": False}

    components = []
    for item in nodes:
        row, column = slots[item["id"]]
        depth = levels[item["id"]]
        label = item["short"] or fit_label(item["title"], NODE_W - 20)
        tag = labels[depth] if depth < len(labels) else ("第 " + str(depth + 1) + " 步")
        # 做完的知识点标出来：小字那行换成「✓ 已完成」，颜色交给注入的 CSS 去点绿
        if item.get("done"):
            tag = "✓ 已完成"
        detail = item["brief"] or ("" if label == item["title"] else item["title"])
        components.append({
            "id": item["id"],
            "type": LEVEL_TYPES[depth % len(LEVEL_TYPES)],
            "label": label,
            "sublabel": fit_label(detail, NODE_W - 20) if detail else "",
            "tag": str(tag)[:24],
            "row": int(row),
            "col": int(column),
            "size": [NODE_W, NODE_H],
        })

    connections = []
    for item in nodes:
        for dep in item["deps"]:
            # 只给「谁连谁」：走线交给 Archify 自己规划，
            # 手动指定 fromSide/route 反而会撞上它的交叉 / 走廊检查。
            connections.append({"from": dep, "to": item["id"]})

    cards = []
    card_mode = str(options.get("cards") or "links").strip().lower()
    if card_mode not in ("none", "titles", "links"):
        card_mode = "links"
    for depth in sorted(rows):
        if card_mode == "none":
            break
        bucket = [next(item for item in nodes if item["id"] == ident) for ident in rows[depth]]
        items = []
        for item in bucket:
            line = item["title"]
            link = item["links"][0].get("url") if item["links"] else ""
            if card_mode == "links" and link:
                line += " —— " + str(link)
            elif item["brief"]:
                line += " —— " + item["brief"]
            items.append(line)
        cards.append({
            "dot": ["cyan", "emerald", "violet", "amber", "rose", "orange", "slate"][depth % 7],
            "title": (labels[depth] if depth < len(labels) else ("第 " + str(depth + 1) + " 步")) + "（" + str(len(bucket)) + "）",
            "items": items,
        })

    return {
        "schema_version": 1,
        "diagram_type": "architecture",
        "meta": {
            "title": title,
            "locale": "zh-CN",
            "subtitle": subtitle,
            "output": options.get("output") or "diagram.html",
            "animation": "trace" if options.get("animate") else "none",
            "visual_preset": options.get("preset") or "editorial",
            "quality_profile": options.get("quality") or "showcase",
            "legend": {"mode": "hidden" if hide_legend else "auto", "entries": legend},
            "viewBox": [round(view_w, 1), round(view_h, 1)],
        },
        "layout": {"mode": "grid", "cols": columns, "cellW": cell_w, "cellH": CELL_H,
                   "gapX": gap_x, "gapY": GAP_Y, "origin": [pad_x, PAD]},
        "components": components,
        "connections": connections,
        "cards": cards,
    }, crossings


DONE_CSS = """
  /* 做完的知识点：描边和文字走绿色，角上那个 ✓ 也强制露出来
     （Archify 的「阅读深度」默认只到 read，细注是藏着的，藏了就看不出做完了） */
  svg [data-node-id="%(id)s"] rect:not(.c-mask) { stroke: %(color)s !important; stroke-width: 2.5 !important; }
  svg [data-node-id="%(id)s"] text.t-primary,
  svg [data-node-id="%(id)s"] text[data-detail="fine"] { fill: %(color)s !important; opacity: 1 !important; }
"""

# 跟应用里 .month-dot[data-tone=done] 用的是同一个青绿（--teal）
DONE_COLOR = "#2f6b68"

"""Archify 那块节点面板是给架构图设计的，学习路线图只留标题和完整说明，
   底下放一个「笔记」按钮（在应用里打开时 goals.js 还会补上「去日程表看」并把
   图里截过的说明换成完整的）。右上角只剩关闭：语义护照这个标题、种类 / 架构组件 / id
   那一排、「N 条出向 · M 条入向」、「编写可达范围 上游/下游」、关系按钮和关系列表、
   已核验来源 —— 全收掉。

   注：这一段跟应用里 goals.js 的 DIAGRAM_PANEL_CSS 是一对，改一边记得改另一边。
   这里不用 % 格式化，CSS 里的 100% 会跟旧式格式化打架。"""
PANEL_CSS = """
  .relationship-lens-eyebrow,
  #focus-passport-meta,
  #focus-summary,
  #focus-evidence,
  #focus-reach,
  #btn-focus-relations,
  #relationship-lens-list { display: none !important; }
  #focus-chip { width: min(26rem, calc(100% - 2rem)) !important; }
  .relationship-lens-head { display: block !important; padding: .85rem .9rem .8rem !important; }
  .relationship-lens-actions { position: absolute !important; top: .45rem !important; right: .45rem !important; }
  /* 标题和说明都给足地方完整显示（原来都是单行省略号） */
  .relationship-lens-title { padding-right: 2.1rem !important; overflow: visible !important;
    white-space: normal !important; text-overflow: clip !important; }
  .semantic-passport-detail { padding-right: 2.1rem !important; overflow: visible !important;
    white-space: normal !important; text-overflow: clip !important; }
  .gw-node-actions { display: flex !important; gap: .5rem !important; margin-top: .8rem !important; }
  .gw-node-actions button { min-height: 2.2rem !important; padding: 0 .9rem !important;
    border-radius: .5rem !important; font-size: .72rem !important; font-weight: 600 !important;
    line-height: 1 !important; }
  #btn-node-note { flex: 1 1 auto !important; border: 0 !important; background: #2f6b68 !important;
    color: #fff !important; }
  #btn-node-note:hover, #btn-node-note:focus-visible { background: #265a57 !important; }
  #btn-node-schedule { flex: 0 0 auto !important; border: 1px solid currentColor !important;
    background: transparent !important; color: inherit !important; opacity: .8 !important; }
  #btn-node-schedule:hover, #btn-node-schedule:focus-visible { opacity: 1 !important; }
"""

EXTRAS_CSS_OPEN = '<style id="roadmap-app-extras">'
EXTRAS_CSS_CLOSE = "</style>"

NOTE_SCRIPT = """<script id="goalweave-note-button">
/* 面板底下那一排「笔记」：在应用里打开就告诉父窗口（它知道这是哪个目标，也知道怎么跳日程表），
   单独打开这张 HTML 时就自己开笔记页。 */
(() => {
  let focused = "";
  document.addEventListener("click", (event) => {
    const node = event.target && event.target.closest ? event.target.closest("g[data-node-id]") : null;
    if (node) focused = node.getAttribute("data-node-id") || "";
  }, true);
  function text(selector) {
    const node = document.querySelector(selector);
    return node ? String(node.textContent || "").trim() : "";
  }
  function decorate() {
    const panel = document.getElementById("focus-chip");
    if (!panel || panel.hidden) return;
    const copy = panel.querySelector(".relationship-lens-copy");
    if (!copy) return;
    let row = copy.querySelector(".gw-node-actions");
    if (!row) {
      row = document.createElement("div");
      row.className = "gw-node-actions";
      copy.append(row);
    }
    let button = row.querySelector("#btn-node-note") || document.getElementById("btn-node-note");
    if (!button) {
      button = document.createElement("button");
      button.id = "btn-node-note";
      button.type = "button";
      button.title = "给这个知识点记一笔：有笔记就打开，没有就新建";
      button.addEventListener("click", () => {
        const id = focused || text("#focus-id");
        const title = text("#focus-label");
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ source: "goalweave-roadmap", type: "note", nodeId: id, title: title }, "*");
          return;
        }
        window.open("../notes.html?node=" + encodeURIComponent(id) + "&title=" + encodeURIComponent(title), "_blank");
      });
    }
    if (button.parentElement !== row) row.append(button);
    // 这个函数挂在 MutationObserver 上：值一样就别写，写一次会再触发一次回调，自己喂自己就死循环了
    if (button.textContent !== "笔记") button.textContent = "笔记";
  }
  function start() {
    new MutationObserver(decorate).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"],
    });
    decorate();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
</script>"""


def inject_extras(out_file, scale, done_ids):
    """画好之后往成品里补两样东西（都在 Archify 的校验之后，动它不会让图不过）：

    1. 一点样式：做完的知识点点绿、节点面板收成「标题 + 完整说明 + 底下一个按钮」，节点文字
       顺手放大一点（Archify 按 1.2em/汉字量宽，真实字宽 1em，正好有这么多余量）。
    2. 底下那个「笔记」按钮（脚本很小，跟着 DOM 变化自己贴上去）。

    这两样只对「生成之后」的图生效；应用里打开旧图时，goals.js 会再注入一份同样的（同一个 origin，
    能直接改 iframe 里的 DOM），所以手上已经存着的老图也不用重画。
    """
    try:
        factor = float(scale) if scale not in (None, "") else FONT_SCALE
    except (TypeError, ValueError):
        factor = FONT_SCALE
    factor = max(1.0, min(1.4, factor))
    html = out_file.read_text(encoding="utf-8")
    if 'id="roadmap-app-extras"' not in html:
        css = TEXT_CSS % {
            "label": 11.0 * factor,
            "sub": 9.0 * factor,
            "tag": 7.0 * factor,
            "cardtitle": 15.0 * factor,
            "carditem": 13.0 * factor,
        } if factor > 1.001 else ""
        done_css = "".join(
            DONE_CSS % {"id": ident, "color": DONE_COLOR} for ident in sorted(set(done_ids or []))
        )
        css += EXTRAS_CSS_OPEN + PANEL_CSS + done_css + EXTRAS_CSS_CLOSE
        html = html.replace("</head>", css + "</head>", 1) if "</head>" in html else html + css
    if "goalweave-note-button" not in html:
        html = html.replace("</body>", NOTE_SCRIPT + "</body>", 1) if "</body>" in html else html + NOTE_SCRIPT
    out_file.write_text(html, encoding="utf-8")
    return round(factor, 2)


def run(params, ctx):
    options = params or {}
    title = str(options.get("title") or "学习路线图").strip()

    if not ARCHIFY_CLI.exists():
        return {"ok": False, "error": "没找到 Archify：" + str(ARCHIFY_CLI)}
    node_bin = shutil.which("node") or shutil.which("node.exe")
    if not node_bin:
        return {"ok": False, "error": "画图要用 Node.js（≥18），这台机器上没找到 node。"}

    name = slugify(options.get("name") or title)
    out_dir = Path(ctx.root) / OUT_DIR_NAME
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / (name + ".html")
    candidate_file = out_dir / (name + ".json")
    # Archify 的校验证据（browser-check 等）单独放，别和成品混在一起
    evidence_dir = out_dir / ".evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)

    provided = options.get("candidate")
    nodes = [] if isinstance(provided, dict) else normalize(options.get("nodes"))
    if not isinstance(provided, dict) and not nodes:
        return {"ok": False, "error": "nodes 是空的，没东西可画。"}

    # 卡片里塞教程链接最容易让成品高出视口，先按要求的来，过不了就退回只列标题；
    # 再不行就把图例收起来（层数一多，图例要好几排，挤不下）
    wanted = str(options.get("cards") or "titles").strip().lower()
    if wanted not in ("none", "titles", "links"):
        wanted = "titles"
    attempts = [(wanted, False)]
    if wanted == "links":
        attempts.append(("titles", False))
    attempts.append((wanted, True))
    attempts.append(("titles", True))

    result = None
    for mode, hide_legend in attempts:
        if isinstance(provided, dict):
            candidate, crossings = json.loads(json.dumps(provided)), None
        else:
            candidate, crossings = build_candidate(title, nodes, dict(options, cards=mode, hide_legend=hide_legend))

        # 同名重画时，上一轮的证据文件要先清掉：它认得出那是「别人的」证据，不肯覆盖
        for stale in list(evidence_dir.glob(name + ".*")) + list(out_dir.glob(name + ".*.json")):
            if stale.is_file():
                stale.unlink()
        candidate["meta"]["output"] = OUT_DIR_NAME + "/" + name + ".html"
        candidate_file.write_text(json.dumps(candidate, ensure_ascii=False, indent=2), encoding="utf-8")

        ctx.log("画图：" + str(len(candidate["components"])) + " 个节点，"
                + str(len(candidate.get("connections") or [])) + " 条连线（卡片 " + mode
                + (("，无图例") if hide_legend else "") + "）")
        started = time.time()
        try:
            proc = subprocess.run(
                [node_bin, str(ARCHIFY_CLI), "finalize", "architecture", str(candidate_file), str(out_file),
                 "--quality", str(options.get("quality") or "showcase"), "--json",
                 "--out-dir", str(evidence_dir)],
                cwd=str(out_dir), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=420,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "画图超时了（Archify 跑了 7 分钟还没结束）。"}

        seconds = round(time.time() - started, 1)
        try:
            receipt = json.loads((proc.stdout or "").strip() or "{}")
        except ValueError:
            receipt = {}

        result = {
            "ok": bool(receipt.get("ok")) and proc.returncode == 0,
            "file": str(out_file),
            "url": "/" + OUT_DIR_NAME + "/" + name + ".html",
            "title": candidate["meta"]["title"],
            "nodes": len(candidate["components"]),
            "connections": len(candidate.get("connections") or []),
            "crossings": crossings,
            "cards": mode,
            "legend": "hidden" if hide_legend else "auto",
            "seconds": seconds,
            "gates": receipt.get("gates") or [],
            "diagnostics": receipt.get("diagnostics") or [],
        }
        if result["ok"]:
            break
        # 说清是哪条校验没过：只说「看 diagnostics」等于没说
        first = (result.get("diagnostics") or [{}])[0]
        detail = str((first or {}).get("message") or "").strip()
        result["error"] = "Archify 没过校验：" + detail if detail else "Archify 没过校验，看 diagnostics。"
        result["stdout"] = (proc.stdout or "")[:4000]
        result["stderr"] = (proc.stderr or "")[:2000]

    if result["ok"]:
        result.pop("stdout", None)
        result.pop("error", None)
        scale = inject_extras(out_file, options.get("font_scale"),
                              [item["id"] for item in nodes if item.get("done")])
        result["font_scale"] = scale
        result["done"] = len([item for item in nodes if item.get("done")])
        ctx.log("画好了：" + result["url"] + "（" + str(result["seconds"]) + " 秒，文字 ×" + str(scale) + "）")
    else:
        ctx.log("没过校验：" + json.dumps(result.get("diagnostics") or [], ensure_ascii=False)[:400])
    return result
