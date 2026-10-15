/* 长期目标页：把一条长期目标拆成文本大纲（内部是 DAG），再摊成每天的任务。
   数据存在 tasks.js 的同一个 store 里（localStorage + 后端），所以任务板上勾掉一条
   任务，对应知识点就算完成了。
   图只留一张——后端 Archify 画的「学习路线图」，页面上不再手画 SVG。 */
(function () {
  "use strict";

  const api = window.spasreTasks;
  if (!api) {
    console.warn("目标页需要 tasks.js 先加载。");
    return;
  }

  const TITLE_UNITS = 12;
  const TITLE_LINES = 2;
  const MAX_NODES = 40;
  const MAX_DEPS = 6;

  const state = { editingId: "", diagramClosed: [] };

  /* ---------- 小工具 ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function chip(text, className) {
    return el("span", "task-chip" + (className ? " " + className : ""), text);
  }

  function setStatus(text) {
    const node = document.getElementById("goal-status");
    if (node) node.textContent = String(text || "");
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function shiftDate(key, days) {
    const parts = String(key || "").split("-").map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return String(key || "");
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    date.setDate(date.getDate() + days);
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  /* ---------- DAG：清洗、拓扑序、分层 ---------- */

  // 只保留能用的节点：补 id、去重、丢掉不认识的前置、断掉环。
  function sanitizeNodes(list) {
    const raw = Array.isArray(list) ? list : [];
    const used = new Set();
    const nodes = [];
    raw.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const title = String(item.title || item.name || "").trim();
      if (!title) return;
      let id = String(item.id || "").trim();
      if (!id || used.has(id)) id = "n" + (nodes.length + 1);
      while (used.has(id)) id += "_";
      used.add(id);
      const date = String(item.date || "").trim();
      nodes.push({
        id: id,
        title: title,
        brief: String(item.brief || item.detail || "").trim(),
        rawDeps: Array.isArray(item.deps) ? item.deps : [],
        links: item.links,
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
        done: Boolean(item.done)
      });
    });

    const ids = new Set(nodes.map((node) => node.id));
    nodes.forEach((node) => {
      const seen = [];
      node.rawDeps.forEach((dep) => {
        const key = String(dep || "").trim();
        if (!key || key === node.id || !ids.has(key) || seen.includes(key)) return;
        seen.push(key);
      });
      node.deps = seen;
      delete node.rawDeps;
    });
    return breakCycles(nodes);
  }

  // DFS 断回边：保证结果一定是 DAG，不然分层会算不出来。
  function breakCycles(nodes) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const color = new Map();
    const visit = (node) => {
      color.set(node.id, 1);
      const kept = [];
      node.deps.forEach((dep) => {
        const parent = byId.get(dep);
        if (!parent) return;
        const mark = color.get(parent.id) || 0;
        if (mark === 1) return;
        if (mark === 0) visit(parent);
        kept.push(dep);
      });
      node.deps = kept;
      color.set(node.id, 2);
    };
    nodes.forEach((node) => {
      if ((color.get(node.id) || 0) === 0) visit(node);
    });
    return nodes;
  }

  // 层号 = 最长前置链的长度，等于「这一层最早能排到第几批」。
  function topoLayers(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    const byId = new Map(list.map((node) => [node.id, node]));
    const memo = new Map();
    const depth = (node) => {
      if (memo.has(node.id)) return memo.get(node.id);
      memo.set(node.id, 0);
      let value = 0;
      (node.deps || []).forEach((dep) => {
        const parent = byId.get(dep);
        if (parent && parent !== node) value = Math.max(value, depth(parent) + 1);
      });
      memo.set(node.id, value);
      return value;
    };
    let max = 0;
    list.forEach((node) => {
      max = Math.max(max, depth(node));
    });
    const layers = [];
    for (let index = 0; index <= max; index += 1) layers.push([]);
    list.forEach((node) => layers[depth(node)].push(node));
    return layers.filter((row) => row.length > 0);
  }

  function topoOrder(nodes) {
    return topoLayers(nodes).reduce((acc, row) => acc.concat(row), []);
  }

  // Kahn 算法：全部节点都能出队才说明没有环。
  function isAcyclic(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    const byId = new Map(list.map((node) => [node.id, node]));
    const indeg = new Map(list.map((node) => [node.id, 0]));
    list.forEach((node) => {
      (node.deps || []).forEach((dep) => {
        if (byId.has(dep) && dep !== node.id) indeg.set(node.id, indeg.get(node.id) + 1);
      });
    });
    const queue = list.filter((node) => indeg.get(node.id) === 0).map((node) => node.id);
    let seen = 0;
    while (queue.length > 0) {
      const id = queue.shift();
      seen += 1;
      list.forEach((node) => {
        if (!(node.deps || []).includes(id)) return;
        indeg.set(node.id, indeg.get(node.id) - 1);
        if (indeg.get(node.id) === 0) queue.push(node.id);
      });
    }
    return seen === list.length;
  }

  /* ---------- 大纲（纯文本） ---------- */
  // 知识点按层（阶段）写成缩进的文本。这份文本既是页面上显示的大纲，
  // 也是存进目标里的那份记录（goal.outline），复制出去就能当学习笔记用。
  function outlineText(title, nodes, meta) {
    const list = Array.isArray(nodes) ? nodes : [];
    if (list.length === 0) return "";
    const info = meta || {};
    const layers = topoLayers(list);
    const byId = new Map(list.map((node) => [node.id, node]));
    const lines = [];
    if (title) lines.push("# " + title);
    const sums = [list.length + " 个知识点"];
    if (layers.length > 1) sums.push(layers.length + " 个阶段");
    if (info.weekly) sums.push("每周 " + info.weekly + " 小时");
    if (info.pace && info.pace > 1) sums.push("每天 " + info.pace + " 个");
    if (info.start && info.deadline) sums.push(info.start + " → " + info.deadline);
    lines.push(sums.join(" · "));

    layers.forEach((row, index) => {
      lines.push("");
      lines.push((index + 1) + ". 阶段 " + (index + 1));
      row.forEach((node) => {
        const bits = [];
        const deps = (node.deps || [])
          .map((dep) => byId.get(dep))
          .filter(Boolean)
          .map((parent) => parent.title);
        if (deps.length > 0) bits.push("前置：" + deps.join("、"));
        if (node.brief) bits.push(node.brief);
        const link = (node.links || [])[0];
        if (link && link.url) bits.push(link.url);
        const when = node.date
          ? "（" + String(node.date).slice(5) + (node.slot ? " " + api.slotTime(node.slot, node.hours) : "") + "）"
          : "";
        lines.push("   - " + node.title + when + (bits.length > 0 ? " —— " + bits.join(" · ") : ""));
      });
    });
    return lines.join("\n");
  }

  // 大纲默认收起来 —— 卡片上先把图摆出来，想看文字自己点开
  function goalOutline(title, nodes, meta, options) {
    const box = el("div", "goal-outline-box");
    const text = outlineText(title, nodes, meta);
    if (!text) {
      box.append(el("p", "task-empty", "还没有大纲，点「重新生成计划」让助手排一份。"));
      return box;
    }
    const fold = document.createElement("details");
    fold.className = "goal-outline-fold";
    const summary = document.createElement("summary");
    summary.textContent = "文本大纲（" + (nodes || []).length + " 个知识点）";
    fold.append(summary);
    fold.append(el("pre", "goal-outline", text));
    if (!options || options.copy !== false) {
      const copy = el("button", "task-action goal-outline-copy", "复制大纲");
      copy.type = "button";
      copy.addEventListener("click", () => copyOutline(text, copy));
      fold.append(copy);
    }
    box.append(fold);
    return box;
  }

  async function copyOutline(text, button) {
    const restore = () => window.setTimeout(() => { button.textContent = "复制大纲"; }, 2000);
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "已复制";
    } catch (error) {
      // 剪贴板被浏览器挡着（非 https / localhost）时退一步：把大纲选中，让用户自己按 Ctrl+C
      const pre = button.parentElement ? button.parentElement.querySelector(".goal-outline") : null;
      if (pre && window.getSelection) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      button.textContent = "已选中，按 Ctrl+C";
    }
    restore();
  }

  /* ---------- 内置规划 ---------- */

  function topicOf(text) {
    const raw = String(text || "").trim();
    const stripped = raw
      .replace(/^(?:长期目标|目标|计划)\s*[：:，,、]?\s*/, "")
      .replace(/^(?:系统|好好|认真)?(?:学习|掌握|精通|入门|了解|熟悉|搞懂|研究|练习|提升|进阶|学)\s*/, "")
      .replace(/^[的：:，,、\s]+/, "")
      .trim();
    return stripped || raw || "这个方向";
  }

  // 每层一个数组，层内顺序就是横向顺序；依赖只连到上一层，天然是 DAG。
  function chainLayers(layers) {
    const nodes = [];
    const idsPerLayer = [];
    layers.forEach((row, rowIndex) => {
      const rowIds = row.map((node, colIndex) => {
        const id = "n" + (nodes.length + 1);
        node.id = id;
        node.deps = [];
        if (rowIndex > 0) {
          const prev = idsPerLayer[rowIndex - 1];
          if (prev.length === 1) {
            node.deps = prev.slice();
          } else if (row.length === 1) {
            node.deps = prev.slice();
          } else {
            const same = prev[Math.min(colIndex, prev.length - 1)];
            if (same) node.deps.push(same);
            const left = prev[colIndex - 1];
            if (left && left !== same) node.deps.push(left);
          }
        }
        nodes.push(node);
        return id;
      });
      idsPerLayer.push(rowIds);
    });
    return nodes;
  }

  function localGoalPlan(goal) {
    const topic = topicOf(goal.title);
    const refs = api.matchArticles(goal.title + " " + String(goal.detail || ""), 6);
    const make = (title, brief, links) => ({ title: title, brief: brief, deps: [], links: links || [], date: "", done: false });
    const doc = (ref) => make("读《" + ref.title + "》", ref.title, [ref]);

    const layers = [
      [make("搞清「" + topic + "」的核心概念与术语", "先建立整体印象，别急着抠细节")].concat(refs.slice(0, 2).map(doc)),
      [
        make("跟着资料跑一遍「" + topic + "」的最小例子", "跑通一遍比读十遍管用"),
        make("记下「" + topic + "」容易踩的坑", "把报错和弯路记成清单")
      ],
      [make("弄懂「" + topic + "」最关键的一个机制", "挑一个核心机制，读到能讲给别人听")].concat(refs.slice(2, 4).map(doc)),
      [
        make("用「" + topic + "」完成一个小项目", "范围定小一点，能跑起来就行"),
        make("拿「" + topic + "」解决一个真实问题", "最好是自己手头正烦的那件事")
      ],
      [make("写一篇「" + topic + "」的笔记", "讲清来龙去脉，写不出来的地方就是还没懂")]
    ];
    return chainLayers(layers);
  }

  /* ---------- 交给模型规划 ---------- */

  function parseJson(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1].trim() : raw;
    try {
      return JSON.parse(body);
    } catch (error) {
      /* 模型爱在 JSON 前后加话，下面按括号截取 */
    }
    const pairs = [
      [body.indexOf("{"), body.lastIndexOf("}")],
      [body.indexOf("["), body.lastIndexOf("]")]
    ];
    for (const pair of pairs) {
      if (pair[0] === -1 || pair[1] <= pair[0]) continue;
      try {
        return JSON.parse(body.slice(pair[0], pair[1] + 1));
      } catch (error) {
        /* 试下一种 */
      }
    }
    return null;
  }

  function goalSystemPrompt() {
    const catalog = api.articleSources().map((entry) => "- " + entry.title + "  " + entry.url).join("\n");
    return [
      "你在帮用户把一条长期目标拆成一张学习计划的知识点图（DAG）。",
      "今天是 " + api.today() + "。",
      "只输出一个 JSON 对象，不要写解释，也不要用 markdown 代码块。格式是：",
      '{"reply": "给用户看的一两句话", "nodes": [{"title": "知识点", "brief": "一句话说明", "deps": ["前置知识点的 title"], "links": [{"title": "资料名", "url": "https://..."}]}]}',
      "要求：",
      "1. 8-14 个节点，从打基础一路排到实践和总结。",
      "2. deps 里只能写这份计划里出现过的 title；最基础的节点 deps 给空数组。",
      "3. 学习顺序必须满足拓扑序：每个节点只能依赖排在它前面的节点，绝对不要出现环。",
      "4. links 只能从下面这份目录里挑 0-2 条，url 原样照抄，不要自己编：",
      catalog,
      "目录里没有对得上的就给空数组。"
    ].join("\n");
  }

  // 模型的 deps 可能写成 title，也可能写成 1 开始的序号，两种都认。
  function normalizeModelNodes(raw) {
    const list = (Array.isArray(raw) ? raw : [])
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const title = String(item.title || item.name || "").trim();
        if (!title) return null;
        const deps = Array.isArray(item.deps)
          ? item.deps
          : Array.isArray(item.dependsOn)
          ? item.dependsOn
          : Array.isArray(item.requires)
          ? item.requires
          : [];
        return {
          title: title,
          brief: String(item.brief || item.detail || item.summary || "").trim(),
          deps: deps,
          links: item.links
        };
      })
      .filter(Boolean)
      .slice(0, MAX_NODES);

    const byTitle = new Map();
    list.forEach((node, index) => {
      if (!byTitle.has(node.title)) byTitle.set(node.title, index);
      const lower = node.title.toLowerCase();
      if (!byTitle.has(lower)) byTitle.set(lower, index);
    });

    return list.map((node, index) => {
      const deps = [];
      node.deps.forEach((dep) => {
        let target = -1;
        if (typeof dep === "number" && Number.isFinite(dep)) {
          const guess = dep >= 1 && dep <= list.length ? dep - 1 : dep >= 0 && dep < list.length ? dep : -1;
          target = guess;
        } else {
          const text = String(dep || "").trim();
          if (!text) return;
          if (byTitle.has(text)) target = byTitle.get(text);
          else if (byTitle.has(text.toLowerCase())) target = byTitle.get(text.toLowerCase());
        }
        if (target < 0 || target === index) return;
        const id = "m" + (target + 1);
        if (!deps.includes(id)) deps.push(id);
      });
      return {
        id: "m" + (index + 1),
        title: node.title,
        brief: node.brief,
        deps: deps.slice(0, MAX_DEPS),
        links: node.links,
        section: node.section,
        date: "",
        done: false
      };
    });
  }

  async function modelGoalPlan(goal) {
    const content = await api.agentChat(
      [
        { role: "system", content: goalSystemPrompt() },
        {
          role: "user",
          content:
            "长期目标：" +
            goal.title +
            (goal.detail ? "\n补充说明：" + goal.detail : "") +
            "\n请把它拆成一张学习计划的知识点图。"
        }
      ],
      { temperature: 0.3, maxTokens: 2400 }
    );
    const parsed = parseJson(content);
    const raw = parsed && Array.isArray(parsed.nodes) ? parsed.nodes : Array.isArray(parsed) ? parsed : [];
    const nodes = sanitizeNodes(normalizeModelNodes(raw));
    if (nodes.length === 0) throw new Error("模型没给出可用的知识点");
    const note = parsed && typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    return { nodes: nodes, note: note };
  }

  /* ---------- 交给后端技能规划（learn.curriculum） ---------- */

  function skillBridge() {
    return window.spasreBackend && typeof window.spasreBackend.run === "function" ? window.spasreBackend : null;
  }

  // 技能吐的是「阶段 → 知识点」，这里摊平成一份大纲；前置写成 title，交给 normalizeModelNodes 换 id。
  function nodesFromCurriculum(result) {
    const titled = new Map();
    (result.sources || []).forEach((item) => {
      if (item && item.url) titled.set(item.url, item.title || item.url);
    });
    const nodes = [];
    (result.stages || []).forEach((stage) => {
      const links = (stage.sources || []).map((url) => ({ title: titled.get(url) || url, url: url }));
      (stage.units || []).forEach((unit) => {
        const title = String(unit.name || "").trim();
        if (!title) return;
        const type = String(unit.type || "").trim();
        const acceptance = String(unit.acceptance || "").trim();
        nodes.push({
          title: title,
          brief: (type ? "【" + type + "】" : "") + acceptance,
          deps: Array.isArray(unit.dependsOn) ? unit.dependsOn : [],
          links: links,
          section: String(stage.name || "").trim(),
          date: "",
          done: false
        });
      });
    });
    return nodes.slice(0, MAX_NODES);
  }

  async function skillGoalPlan(goal) {
    const bridge = skillBridge();
    if (!bridge || !(await bridge.available())) throw new Error("后端不在");
    const params = { goal: goal.title + (goal.detail ? "\n补充说明：" + goal.detail : "") };
    const weekly = Number(goal.weekly);
    const pace = Number(goal.pace);
    if (Number.isFinite(weekly) && weekly > 0) {
      params.weeklyHours = Math.min(60, Math.max(1, Math.round(weekly)));
    } else if (Number.isFinite(pace) && pace > 0) {
      params.weeklyHours = Math.min(60, Math.max(1, Math.round(pace * 14)));
    }
    const data = await bridge.run("learn.curriculum", params);
    if (!data || data.ok === false) throw new Error((data && data.error) || "技能没跑通");
    const result = data.result || {};
    const nodes = sanitizeNodes(normalizeModelNodes(nodesFromCurriculum(result)));
    if (nodes.length === 0) throw new Error("技能没给出可用的知识点");
    const stats = result.stats || {};
    const note = [
      "由后端技能 learn.curriculum 拆的：" +
        (stats.stages || 0) +
        " 个阶段 / " +
        (stats.units || nodes.length) +
        " 个知识点（" +
        (result.mode === "research" ? "先查资料再拆" : "直接拆") +
        "）。",
      String(result.notice || "").trim()
    ]
      .filter(Boolean)
      .join(" ");
    return { nodes: nodes, note: note };
  }

  /* ---------- 排计划 ---------- */

  // 模型 → 后端技能 → 内置模板，逐级回退。向导和「重新规划」共用这一条。
  async function generateNodes(goal) {
    let nodes = null;
    let note = "";
    let source = "local";

    if (api.agentConfigured()) {
      try {
        const result = await modelGoalPlan(goal);
        nodes = result.nodes;
        note = result.note;
        source = "api";
      } catch (error) {
        note = "模型这次没给出计划（" + (error && error.message ? error.message : "未知错误") + "）。";
      }
    }

    // 没配模型（或模型没给出计划）时，试一下后端的 learn.curriculum 技能
    if (!nodes || nodes.length === 0) {
      try {
        const result = await skillGoalPlan(goal);
        nodes = result.nodes;
        note = result.note;
        source = "skill";
      } catch (error) {
        /* 后端不在或者技能没跑通，落到内置模板 */
      }
    }

    if (!nodes || nodes.length === 0) {
      nodes = localGoalPlan(goal);
      source = "local";
      if (!note) note = "内置模板：打基础 → 上手练习 → 深入原理 → 综合实践 → 输出总结。";
    }

    return { nodes: nodes, note: note, source: source };
  }

  async function planGoal(goalId) {
    const goal = api.goal(goalId);
    if (!goal) return null;
    setStatus("正在排「" + goal.title + "」的学习计划…");
    const result = await generateNodes(goal);
    // 知识点换了，旧图作废：顺手重新画一张
    const drawing = await drawRoadmap(goal.title, result.nodes);
    const saved = api.updateGoal(goalId, {
      nodes: result.nodes,
      planSource: result.source,
      planNote: result.note,
      diagram: drawing.ok ? drawing.url : ""
    });
    // 换了知识点也先不排期：想让它进日程表就点「同步」
    setStatus("计划生成好了：" + result.nodes.length + " 个知识点。点「同步」把它们排进日程表。");
    return saved;
  }

  /* ---------- 文字换行（SVG 里得自己折行） ---------- */

  function textUnits(text) {
    let width = 0;
    Array.from(String(text || "")).forEach((char) => {
      width += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(char) ? 1 : 0.56;
    });
    return width;
  }

  function wrapText(text, maxUnits, maxLines) {
    const chars = Array.from(String(text || "").trim());
    const lines = [];
    let current = "";
    let truncated = false;
    for (const char of chars) {
      if (current && textUnits(current + char) > maxUnits) {
        if (lines.length === maxLines - 1) {
          truncated = true;
          break;
        }
        lines.push(current);
        current = "";
      }
      current += char;
    }
    if (truncated) {
      let last = current;
      while (last && textUnits(last + "…") > maxUnits) last = last.slice(0, -1);
      lines.push(last + "…");
    } else if (current) {
      lines.push(current);
    }
    if (lines.length === 0) lines.push("");
    return lines.slice(0, maxLines);
  }

  /* ---------- 渲染 ---------- */


  function goalCard(goal, reusedBox) {
    const nodes = goal.nodes || [];
    const done = nodes.filter((node) => node.done).length;
    const card = el("article", "goal-card");
    card.dataset.id = goal.id;

    const head = el("div", "goal-head");
    const heading = el("div", "goal-heading");
    heading.append(el("h3", "goal-title", goal.title));
    const meta = el("div", "goal-meta");
    meta.append(chip(goal.category, "chip-category"));
    meta.append(chip("开始 " + goal.startDate, "chip-date"));
    if (goal.deadline) meta.append(chip("到 " + goal.deadline, "chip-date"));
    if (goal.weekly) meta.append(chip("每周 " + goal.weekly + " 小时"));
    meta.append(chip(done + " / " + nodes.length + " 完成", done > 0 && done === nodes.length ? "chip-done" : ""));
    if (goal.planSource === "api") meta.append(chip("模型规划", "chip-agent"));
    else if (goal.planSource === "skill") meta.append(chip("技能规划", "chip-agent"));
    else if (goal.planSource === "local") meta.append(chip("内置规划", ""));
    heading.append(meta);
    head.append(heading);

    const actions = el("div", "task-actions");
    // 「同步」是这张卡的主要动作：把还没排期的知识点排进日程表（第一次会先请你把时间段定一下）
    const sync = el("button", "task-action sched-save", "同步");
    sync.type = "button";
    sync.dataset.action = "goal-sync";
    sync.dataset.id = goal.id;
    sync.title = "把还没排期的知识点排进日程表，并补上对应的任务";
    actions.append(sync);
    if (goal.diagram) {
      const folded = state.diagramClosed.indexOf(goal.id) >= 0;
      const diagram = el("button", "task-action", folded ? "展开路线图" : "收起路线图");
      diagram.type = "button";
      diagram.dataset.action = "goal-diagram";
      diagram.dataset.id = goal.id;
      diagram.setAttribute("aria-expanded", String(!folded));
      actions.append(diagram);
    }
    [
      ["goal-plan", "重新生成计划", false],
      ["goal-edit", "编辑", false],
      ["goal-remove", "删除", true]
    ].forEach((entry) => {
      const button = el("button", "task-action" + (entry[2] ? " task-action-danger" : ""), entry[1]);
      button.type = "button";
      button.dataset.action = entry[0];
      button.dataset.id = goal.id;
      actions.append(button);
    });
    head.append(actions);
    card.append(head);

    if (goal.detail) card.append(el("p", "goal-detail", goal.detail));

    const bar = el("div", "goal-progress");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(nodes.length));
    bar.setAttribute("aria-valuenow", String(done));
    bar.setAttribute("aria-label", goal.title + " 的完成进度");
    const fill = el("span", "goal-progress-fill");
    fill.style.width = nodes.length > 0 ? Math.round((done / nodes.length) * 100) + "%" : "0%";
    bar.append(fill);
    card.append(bar);

    // 现在该做哪个：摆在图的上头，一眼看到完成情况
    const next = nextNodeOf(goal);
    if (next) card.append(goalNextBox(goal, next));

    if (goal.diagram) card.append(goalDiagramBox(goal, reusedBox));
    card.append(goalOutline(goal.title, nodes, metaOf(goal)));
    if (goal.planNote) card.append(el("p", "goal-note", goal.planNote));
    return card;
  }

  // 现在该做哪一个：没做完的里头挑「前置都做完了」的那些，按排期先后取最早的一个
  // （还没排期的排在最后，按拓扑顺序兜底）
  function nextNodeOf(goal) {
    const nodes = goal.nodes || [];
    const left = nodes.filter((node) => !node.done);
    if (left.length === 0) return null;
    const ids = new Set(nodes.map((node) => node.id));
    const doneIds = new Set(nodes.filter((node) => node.done).map((node) => node.id));
    const ready = left.filter((node) => (node.deps || []).every((dep) => !ids.has(dep) || doneIds.has(dep)));
    const pool = ready.length > 0 ? ready : left;
    const rank = topoOrder(nodes);
    const startOf = (node) => {
      const seg = node.slot ? api.segment(node.slot) : null;
      return seg ? api.clockMinutes(seg.start) : 24 * 60 + 1;
    };
    return pool
      .slice()
      .sort((a, b) => {
        const da = a.date || "9999-99-99";
        const db = b.date || "9999-99-99";
        if (da !== db) return da < db ? -1 : 1;
        const sa = startOf(a);
        const sb = startOf(b);
        if (sa !== sb) return sa - sb;
        return rank.indexOf(a) - rank.indexOf(b);
      })[0];
  }

  function goalNextBox(goal, node) {
    const nodes = goal.nodes || [];
    const done = nodes.filter((item) => item.done).length;
    const box = el("div", "goal-next");
    box.append(el("span", "goal-next-label", "下一个"));
    box.append(el("strong", "goal-next-title", node.title));
    const when = node.date
      ? (node.date === api.today() ? "今天" : node.date) + (node.slot ? " · " + api.slotTime(node.slot, node.hours) : "") +
        (node.hours ? " · " + node.hours + " 小时" : "")
      : "还没排期 —— 点「同步」把它排进日程表";
    box.append(el("span", "goal-next-when", when));
    box.append(el("span", "goal-next-progress", done + " / " + nodes.length + " 完成"));
    if (node.brief) box.append(el("span", "goal-next-brief", node.brief));
    return box;
  }

  // 学习路线图直接放卡片里跑：默认就摊开着，点一下可以收起来
  function goalDiagramBox(goal, reused) {
    const folded = state.diagramClosed.indexOf(goal.id) >= 0;
    // 重画卡片时把原来那个 iframe 接过来用：不然每次数据一变，图都要重新加载一遍
    if (reused && reused.dataset.url === goal.diagram) {
      reused.hidden = folded;
      return reused;
    }
    const box = el("div", "goal-diagram-box");
    box.dataset.id = goal.id;
    box.dataset.url = goal.diagram;
    if (!folded) box.append(goalDiagramFrame(goal));
    box.hidden = folded;
    return box;
  }

  function goalDiagramFrame(goal) {
    const frame = document.createElement("iframe");
    frame.className = "diagram-frame";
    frame.src = goal.diagram;
    frame.title = goal.title + "：学习路线图";
    frame.loading = "lazy";
    return frame;
  }

  function toggleGoalDiagram(button) {
    const card = button.closest(".goal-card");
    const goal = api.goal(button.dataset.id);
    const box = card ? card.querySelector(".goal-diagram-box") : null;
    if (!goal || !goal.diagram || !box) return;
    const opening = box.hidden;
    if (opening && box.childElementCount === 0) box.append(goalDiagramFrame(goal));
    box.hidden = !opening;
    state.diagramClosed = state.diagramClosed.filter((id) => id !== goal.id);
    if (!opening) state.diagramClosed.push(goal.id);
    button.textContent = opening ? "收起路线图" : "展开路线图";
    button.setAttribute("aria-expanded", String(opening));
  }

  function renderGoals() {
    const root = document.getElementById("goal-list");
    if (!root) return;
    renderCategoryOptions();
    const list = api.goals();
    const summary = document.getElementById("goal-summary");
    // 已经摊开的那几张图接过来接着用，别每次都重新加载
    const kept = new Map();
    root.querySelectorAll(".goal-diagram-box").forEach((box) => kept.set(box.dataset.id, box));
    root.replaceChildren();

    if (list.length === 0) {
      root.append(el("p", "task-empty", "还没有目标，点右下角 ＋ 新建一个。"));
      if (summary) summary.textContent = "";
      return;
    }
    if (summary) {
      const nodes = list.reduce((sum, goal) => sum + (goal.nodes || []).length, 0);
      const done = list.reduce((sum, goal) => sum + (goal.nodes || []).filter((node) => node.done).length, 0);
      summary.textContent = list.length + " 个目标 · " + nodes + " 个知识点 · 已完成 " + done + " 个";
    }
    list.forEach((goal) => root.append(goalCard(goal, kept.get(goal.id))));
  }

  function renderCategoryOptions() {
    const list = document.getElementById("goal-category-options");
    if (!list) return;
    list.replaceChildren();
    api.categories().forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      list.append(option);
    });
  }

  /* ---------- 新建目标向导 ---------- */

  const wizard = { step: 1, goalId: "", nodes: [], note: "", source: "", diagram: "" };

  function wzField(id) {
    return document.getElementById(id);
  }

  function wzValue(id) {
    const node = wzField(id);
    return node ? String(node.value || "").trim() : "";
  }

  function setWzStatus(text) {
    const node = wzField("wz-status");
    if (node) node.textContent = String(text || "");
  }

  function sourceLabel(source) {
    if (source === "api") return "模型生成";
    if (source === "skill") return "技能生成";
    return "内置模板";
  }

  function daysBetween(fromKey, toKey) {
    const from = new Date(String(fromKey) + "T00:00:00");
    const to = new Date(String(toKey) + "T00:00:00");
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return 0;
    return Math.round((to - from) / 86400000);
  }

  function paceFor(units, startKey, deadlineKey) {
    if (!units) return 1;
    const days = Math.max(1, daysBetween(startKey, deadlineKey) + 1);
    return Math.max(1, Math.min(8, Math.ceil(units / days)));
  }

  /* ---------- 日程表：一天切几段，按每周投入把知识点填进去 ---------- */

  // 段的定义在 tasks.js（DAY_SEGMENTS），这里只做「哪天、哪一段、多长时间」的分配
  function segmentsWithMinutes() {
    return api.segments().map((seg) => Object.assign({}, seg, { minutes: api.segmentMinutes(seg.key) }));
  }

  // 这段目标能用的日子：从今天（或目标的开始日，取晚的那个）到预期完成日
  function planDays(startKey, deadlineKey) {
    const today = api.today();
    const start = String(startKey || "") > today ? String(startKey) : today;
    if (!deadlineKey || String(deadlineKey) < start) return [start];
    const days = [];
    for (let date = start; date <= String(deadlineKey); date = shiftDate(date, 1)) {
      days.push(date);
      if (days.length >= 400) break;
    }
    return days;
  }

  // 一个知识点分到多久：每周投入 ÷ 这一周要做的个数（个数 = 知识点数 ÷ 总周数）
  function hoursPerNode(goal, nodeCount, dayCount) {
    const weekly = Math.max(1, Number(goal.weekly) || 7);
    const hours = (weekly * Math.max(1, dayCount)) / (7 * Math.max(1, nodeCount));
    return Math.max(0.5, Math.round(hours * 2) / 2);
  }

  function goalStamp(date, slot) {
    return String(date || "") + ":" + String(slot || "");
  }

  // 统一排期：已经排好的（含别的目标）当一个一个占住的段，缺时间的填进空段里。
  //   dry     只算不写（向导预览 / 试算用）
  //   only    只给这一个目标找空位（卡片上点「同步」就是它）；别的目标手上排好的照样占着位
  //   replan  重新规划：没做完的都腾出来重新找位置，做完的和已经过去的保持不动
  function planSchedule(options) {
    const config = options || {};
    const dry = Boolean(config.dry);
    const replan = Boolean(config.replan);
    const segments = segmentsWithMinutes();
    const order = api.segmentOrder().map((index) => segments[index]).filter(Boolean);
    const taken = new Map();

    const goals = dry ? api.goals().concat([config.goal]) : api.goals();
    const planned = new Set();
    const keepDay = new Map();
    const details = [];
    const stats = { placed: 0, pending: 0, hours: 0, days: 0, missed: 0 };

    // 1. 先让手上排好的占位：老目标的时间尽量保持不变。
    //    只有日期、没有时段的老数据（加时段之前排的）也把日期留着，只补一个段。
    goals.forEach((goal) => {
      (goal.nodes || []).forEach((node) => {
        if (!node.date || node.date < api.today()) return;
        if (replan && !node.done) return; // 重新规划：没做完的（含今天往后排好的）都重新找位置
        const held = goalStamp(node.date, node.slot);
        if (node.slot && api.segment(node.slot) && !taken.has(held)) {
          taken.set(held, { goalId: goal.id, nodeId: node.id });
          planned.add(goal.id + "/" + node.id);
          return;
        }
        // 没时段、或者挂在一个已经删掉的段上：日期留着，只补一个段
        keepDay.set(goal.id + "/" + node.id, node.date);
      });
    });

    // 2. 再给还没排的节点找空段（only 时只动这一个目标）
    goals.forEach((goal) => {
      if (config.only && goal.id !== config.only) return;
      const nodes = goal.nodes || [];
      if (nodes.length === 0) return;
      const waiting = nodes.filter((node) => !planned.has(goal.id + "/" + node.id));
      if (waiting.length === 0) return;
      const days = planDays(goal.startDate, goal.deadline);
      const hours = hoursPerNode(goal, nodes.length, days.length);
      const rank = topoOrder(nodes);

      const freeSegment = (date) => {
        const open = order.filter((seg) => {
          const stamp = goalStamp(date, seg.key);
          if (taken.has(stamp)) return false;
          if (api.slotBusy(date, seg.key)) return false; // 非空闲（默认每周一致）
          // 今天已经过去的那几段不算空位
          return !api.slotPassed(date, seg.key);
        });
        if (open.length === 0) return null;
        // 装得下的里头按偏好挑（晚上 → 下午 → 上午 → 早上）：同一个目标的时间点才稳定
        const fitting = open.filter((seg) => seg.minutes / 60 >= hours - 0.001);
        if (fitting.length > 0) return fitting[0];
        // 都装不下就用最长的那段，时长按段长砍
        return open.reduce((best, seg) => (seg.minutes > best.minutes ? seg : best), open[0]);
      };

      waiting
        .slice()
        .sort((a, b) => rank.indexOf(a) - rank.indexOf(b))
        .forEach((node, index) => {
          const held = keepDay.get(goal.id + "/" + node.id);
          const heldIndex = held ? days.indexOf(held) : -1;
          const target = heldIndex >= 0 ? heldIndex : Math.floor(((index + 0.5) * days.length) / waiting.length);
          let settled = false;
          for (let step = 0; step < 12 && !settled; step += 1) {
            const tries = step === 0 ? [target] : [target + step, target - step];
            for (const dayIndex of tries) {
              if (dayIndex < 0 || dayIndex >= days.length) continue;
              const seg = freeSegment(days[dayIndex]);
              if (!seg) continue;
              node.date = days[dayIndex];
              node.slot = seg.key;
              node.hours = Math.min(hours, Math.round((seg.minutes / 60) * 2) / 2);
              taken.set(goalStamp(node.date, node.slot), { goalId: goal.id, nodeId: node.id });
              details.push({ goalId: goal.id, nodeId: node.id, title: node.title, date: node.date, slot: node.slot, hours: node.hours });
              stats.placed += 1;
              settled = true;
              break;
            }
          }
          if (!settled) {
            // 这整段日子里都没有空位了：先空着，等用户放开一些段再说
            node.date = "";
            node.slot = "";
            node.hours = 0;
            stats.missed += 1;
          }
        });

      stats.pending += waiting.length;
      stats.hours = hours;
      stats.days = days.length;
      if (!dry) {
        api.updateGoal(goal.id, {
          nodes: nodes,
          outline: outlineText(goal.title, nodes, metaOf(goal))
        });
        api.syncGoalTasks(goal.id);
      }
    });

    return { placed: stats.placed, pending: stats.pending, hours: stats.hours, days: stats.days, missed: stats.missed, details: details };
  }

  function metaOf(goal) {
    return { pace: goal.pace, weekly: goal.weekly, start: goal.startDate, deadline: goal.deadline };
  }

  /* ---------- 日程表：页面上那张网格 ---------- */

  const sched = {
    weekStart: "", pick: null, drag: null, seg: "", task: "", note: "", draft: null, warn: "",
    view: "week",   // week | day | month
    day: "",
    month: "",
    missing: "",    // 从别的页跳过来要找的那条任务
    preview: false
  };
  // 多个目标共用一个网格，按顺序给每个目标一个颜色
  const SCHED_RGB = ["84, 118, 172", "231, 155, 176", "72, 143, 138", "126, 96, 168", "240, 195, 154"];

  function segRange(seg) {
    return seg.start + "–" + seg.end;
  }

  // 正在改、还没保存的那份时间段存在本地，刷新/换页都不丢
  const SCHED_DRAFT_KEY = "spasre-sched-draft";

  function saveDraft() {
    try {
      if (sched.draft) window.localStorage.setItem(SCHED_DRAFT_KEY, JSON.stringify(sched.draft));
      else window.localStorage.removeItem(SCHED_DRAFT_KEY);
    } catch (error) {
      // 隐私模式之类存不了就算了
    }
  }

  function loadDraft() {
    let list = null;
    try {
      list = JSON.parse(window.localStorage.getItem(SCHED_DRAFT_KEY) || "null");
    } catch (error) {
      list = null;
    }
    if (!Array.isArray(list) || list.length === 0) return null;
    const rows = list
      .map((seg) => (seg && typeof seg === "object" ? { key: String(seg.key || ""), start: String(seg.start || ""), end: String(seg.end || "") } : null))
      .filter((seg) => seg && seg.key);
    if (rows.length === 0) return null;
    const now = api.segments();
    const same = rows.length === now.length &&
      rows.every((seg, index) => seg.key === now[index].key && seg.start === now[index].start && seg.end === now[index].end);
    return same ? null : rows;
  }

  // 网格按哪份时段画：正在改但还没落盘的那份（draft）优先，否则就是存下来的那份。
  // 冲突时先留着让用户看，所以草稿可能是不合法的 —— 排期、写盘都只认 api.segments()。
  function schedRows() {
    return sched.draft ? sched.draft : api.segments();
  }

  // 正在看的是哪一周也存在本地，刷新之后还是那一周
  const SCHED_WEEK_KEY = "spasre-sched-week";

  function saveWeek() {
    try {
      window.localStorage.setItem(SCHED_WEEK_KEY, String(sched.weekStart || ""));
    } catch (error) {
      // 存不了就算了
    }
  }

  function loadWeek() {
    try {
      const saved = String(window.localStorage.getItem(SCHED_WEEK_KEY) || "");
      return /^\d{4}-\d{2}-\d{2}$/.test(saved) ? saved : "";
    } catch (error) {
      return "";
    }
  }

  // 这一段过去了没：按网格上正在显示的那份时间算（草稿态下不能拿存着的那份去比）
  function rowPassed(date, seg) {
    const end = api.clockMinutes(seg.end);
    if (end < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return false;
    const stamp = new Date(String(date) + "T" + api.clockText(end) + ":00");
    if (isNaN(stamp.getTime())) return false;
    return stamp.getTime() <= Date.now();
  }

  // 手输时间：2130 / 930 / 9 / 21:30 / 21：30 → HH:MM，认不出来就原样留着让校验去提示
  function normalizeClock(text) {
    const raw = String(text || "").trim().replace(/[：.．。]/g, ":");
    const digits = raw.replace(/[^\d]/g, "");
    const hasColon = raw.indexOf(":") >= 0;
    if (!hasColon && (digits.length === 3 || digits.length === 4)) {
      const hours = Number(digits.slice(0, digits.length - 2));
      const minutes = Number(digits.slice(-2));
      if (hours <= 23 && minutes <= 59) return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0");
      return raw;
    }
    const match = /^(\d{1,2}):(\d{1,2})$/.exec(raw);
    if (match) {
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      if (hours <= 23 && minutes <= 59) return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0");
      return raw;
    }
    if (!hasColon && /^\d{1,2}$/.test(raw)) return String(Number(raw)).padStart(2, "0") + ":00";
    return raw;
  }

  function weekStartOf(dateKey) {
    const date = new Date(String(dateKey) + "T00:00:00");
    if (isNaN(date.getTime())) return api.today();
    return shiftDate(String(dateKey), -((date.getDay() + 6) % 7));
  }

  function weekdayLabel(dateKey) {
    const date = new Date(String(dateKey) + "T00:00:00");
    const index = isNaN(date.getTime()) ? 1 : date.getDay() === 0 ? 7 : date.getDay();
    return "周" + "一二三四五六日"[index - 1];
  }

  // 每个「日期 + 段」上压着哪些东西：目标知识点 + 自己排进来的任务（比如每日推荐）
  function scheduleMap() {
    const map = new Map();
    const push = (stamp, entry) => {
      if (!map.has(stamp)) map.set(stamp, []);
      map.get(stamp).push(entry);
    };
    api.goals().forEach((goal, index) => {
      (goal.nodes || []).forEach((node) => {
        if (!node.date || !node.slot || !api.segment(node.slot)) return;
        push(goalStamp(node.date, node.slot), { goal: goal, node: node, rgb: SCHED_RGB[index % SCHED_RGB.length] });
      });
    });
    api.list().forEach((task, index) => {
      // 目标节点铺出来的任务跟着节点显示，别在这儿再来一块（不然一格两份）
      if (task.goalId && task.nodeId) return;
      if (!task.date || !task.slot || !api.segment(task.slot)) return;
      push(goalStamp(task.date, task.slot), { task: task, rgb: SCHED_RGB[(index + 3) % SCHED_RGB.length] });
    });
    return map;
  }

  function scheduleCell(date, seg, entries, isBusy, isPast, isClash, inDay) {
    const preview = Boolean(sched.preview);
    const cell = el("div", "sched-cell" + (inDay ? " is-inline" : ""));
    if (isClash) cell.classList.add("is-clash");
    if (isPast) cell.classList.add("is-past");
    else if (entries.length === 0 && isBusy) cell.classList.add("is-busy");
    if (!isPast && entries.length === 0 && !isBusy) cell.classList.add("is-free");
    cell.dataset.date = date;
    cell.dataset.slot = seg.key;
    cell.dataset.chips = String(Math.min(entries.length, 3));
    // 首页那份预览：块儿只是看看，不拖也不点
    const staticChip = (chip) => {
      if (!preview) return chip;
      delete chip.dataset.action;
      chip.draggable = false;
      chip.classList.add("is-static");
      return chip;
    };
    if (entries.length === 0) {
      const button = el("button", "sched-empty", !isPast && isBusy ? "非空闲" : "");
      button.type = "button";
      button.disabled = isPast || preview;
      if (!preview) {
        button.dataset.action = "sched-busy";
        button.dataset.date = date;
        button.dataset.slot = seg.key;
      }
      button.title = isPast ? "这段时间已经过去了" : isBusy ? "恢复成空闲" : "把每周这个时间的这一段都设为非空闲";
      button.setAttribute("aria-label", button.title);
      if (isPast) button.textContent = "";
      cell.append(button);
      return cell;
    }
    const overdue = api.overdue();
    const locked = api.locked();
    entries.forEach((entry) => {
      // 自己排进来的任务（每日推荐、任务板上「加入日程表」的）：点一下改时间，也能拖走
      if (entry.task) {
        const task = entry.task;
        const hours = api.slotHours(seg.key, task.hours);
        const chip = el("button", "sched-chip is-task" + (isPast ? " is-done" : ""));
        chip.type = "button";
        chip.dataset.action = isPast ? "" : "sched-task";
        chip.dataset.task = task.id;
        chip.draggable = !isPast;
        chip.title = task.title + "：" + api.slotTime(seg.key, hours) + " · " + hours + " 小时 —— 点一下改时间，也可以拖到别的空格子";
        chip.style.setProperty("--sched-rgb", entry.rgb);
        chip.append(el("span", "sched-chip-title", task.title));
        chip.append(el("span", "sched-time", (isPast ? "已过去 · " : "") + api.slotTime(seg.key, hours)));
        if (sched.task === task.id) chip.classList.add("is-picked");
        cell.append(staticChip(chip));
        return;
      }
      const key = api.nodeKey(entry.goal.id, entry.node.id);
      const done = Boolean(entry.node.done);
      const late = !done && overdue.indexOf(key) >= 0;
      const blocked = !done && !late && locked.indexOf(key) >= 0;
      // 过去的格子：做完了显示「已完成」，没做就变成一个「重排」按钮
      if (isPast && done) {
        const chip = el("div", "sched-chip is-done");
        chip.append(el("span", "sched-chip-title", entry.node.title));
        chip.append(el("span", "sched-time", "已完成 · " + api.slotTime(seg.key, entry.node.hours)));
        chip.title = "【" + entry.goal.title + "】" + entry.node.title + "：已完成";
        cell.append(chip);
        return;
      }
      if (late) {
        const button = el("button", "sched-chip is-late");
        button.type = "button";
        button.dataset.action = "sched-overdue";
        button.dataset.id = entry.goal.id;
        button.dataset.node = entry.node.id;
        button.title = "「" + entry.node.title + "」过期没做：点一下排到后面的空位里（会排在它后面的任务前面）";
        button.append(el("span", "sched-chip-title", entry.node.title));
        button.append(el("span", "sched-time", "过期没做 · 点这里重排"));
        cell.append(button);
        return;
      }
      const chip = el("button", "sched-chip" + (blocked ? " is-locked" : ""));
      chip.type = "button";
      chip.dataset.action = blocked ? "sched-locked" : "sched-pick";
      chip.dataset.id = entry.goal.id;
      chip.dataset.node = entry.node.id;
      chip.draggable = !blocked;
      chip.title = blocked
        ? "「" + entry.node.title + "」的前置还没做：先把前面过期那个重排一下"
        : "【" + entry.goal.title + "】" + entry.node.title + "：" + api.slotTime(seg.key, entry.node.hours) +
          " · " + api.slotHours(seg.key, entry.node.hours) + " 小时 —— 拖到空闲的格子，或点一下改时间";
      chip.style.setProperty("--sched-rgb", entry.rgb);
      const hours = api.slotHours(seg.key, entry.node.hours);
      chip.append(el("span", "sched-chip-title", entry.node.title));
      // 行里只写时间：列窄，「· N 小时」放悬停提示里，免得被省略号截掉
      chip.append(el("span", "sched-time", blocked ? "锁定 · " + api.slotTime(seg.key, hours) : api.slotTime(seg.key, hours)));
      if (sched.pick && sched.pick.goalId === entry.goal.id && sched.pick.nodeId === entry.node.id) {
        chip.classList.add("is-picked");
      }
      cell.append(staticChip(chip));
    });
    return cell;
  }

  // 任务（比如每日推荐 / 任务板上排进来的）占的格子：点一下就在这儿改时间
  function renderTaskEdit(box) {
    const task = api.list().find((item) => item.id === sched.task);
    if (!task || !task.slot) {
      sched.task = "";
      if (!sched.pick) {
        box.hidden = true;
        box.replaceChildren();
      }
      return;
    }
    box.hidden = false;
    box.replaceChildren();
    box.append(el("span", "sched-edit-title", task.title));

    // 改完立刻写回；这一格放不下就退回并说明还剩多少
    function changeTaskSlot(patch) {
      const next = {
        date: patch.date !== undefined ? patch.date : task.date,
        slot: patch.slot !== undefined ? patch.slot : task.slot,
        hours: patch.hours !== undefined ? patch.hours : task.hours
      };
      if (!api.placeTask(task.id, next)) {
        setSchedStatus(cellFullNote(next.date, next.slot, { taskId: task.id }));
        renderSchedule();
      }
    }

    const dateField = el("label", "task-field");
    dateField.append(el("span", null, "日期"));
    const dateInput = document.createElement("input");
    dateInput.className = "task-input";
    dateInput.type = "date";
    dateInput.value = task.date || api.today();
    dateInput.addEventListener("change", () => changeTaskSlot({ date: dateInput.value }));
    dateField.append(dateInput);
    box.append(dateField);

    const slotField = el("label", "task-field");
    slotField.append(el("span", null, "时段"));
    const slotSelect = document.createElement("select");
    slotSelect.className = "task-select";
    schedRows().forEach((seg) => {
      const option = document.createElement("option");
      option.value = seg.key;
      option.textContent = segRange(seg);
      slotSelect.append(option);
    });
    slotSelect.value = task.slot;
    slotSelect.addEventListener("change", () => changeTaskSlot({ slot: slotSelect.value }));
    slotField.append(slotSelect);
    box.append(slotField);

    const hoursField = el("label", "task-field");
    hoursField.append(el("span", null, "时长（小时）"));
    const hoursInput = document.createElement("input");
    hoursInput.className = "task-input";
    hoursInput.type = "number";
    hoursInput.min = "0.5";
    hoursInput.step = "0.5";
    hoursInput.max = String(api.segmentMinutes(task.slot) / 60);
    hoursInput.value = String(api.slotHours(task.slot, task.hours));
    hoursInput.addEventListener("change", () => changeTaskSlot({ hours: Number(hoursInput.value) }));
    hoursField.append(hoursInput);
    box.append(hoursField);

    const clear = el("button", "task-action task-action-danger", "取消安排");
    clear.type = "button";
    clear.dataset.action = "sched-task-clear";
    box.append(clear);

    const close = el("button", "task-action", "收起");
    close.type = "button";
    close.dataset.action = "sched-task-close";
    box.append(close);
  }

  /* ---------- 同步 / 重新规划 / 撤销 ---------- */

  const PLAN_UNDO_KEY = "spasre-plan-undo";

  // 第一次排期之前先把时间定一下：把时间段摆出来改，顺手提示去划非空闲
  function openPlanSetup(onReady) {
    const sheet = api.openSheet("排期之前，先把时间定一下");
    sheet.body.append(
      el("p", "task-hint", "一天切成几段，知识点只会往这些段里塞。下面是现在的分段，按自己的作息改就行（一段接一段，前一段的结束不能晚于后一段的开始）。")
    );

    const rows = api.segments().map((seg) => ({ start: seg.start, end: seg.end }));
    const list = el("div", "segment-setup");
    const warn = el("p", "task-hint sched-edit-note");
    const start = el("button", "task-action sched-save", "保存并开始排期");
    start.type = "button";

    function problem() {
      return api.checkSegments(rows);
    }

    function validate() {
      const bad = problem();
      warn.textContent = bad ? "时间段有问题：" + bad + "（改好再开始排期）" : "";
      start.disabled = Boolean(bad);
      return !bad;
    }

    function renderRows() {
      list.replaceChildren();
      rows.forEach((row, index) => {
        const line = el("div", "segment-setup-row");
        [["start", "开始"], ["end", "结束"]].forEach((side) => {
          const input = document.createElement("input");
          input.className = "task-input";
          input.type = "text";
          input.value = row[side[0]];
          input.placeholder = side[1] + "（如 " + (side[0] === "start" ? "09:00" : "12:00") + "）";
          input.setAttribute("aria-label", "第 " + (index + 1) + " 段" + side[1]);
          input.addEventListener("change", () => {
            row[side[0]] = normalizeClock(input.value);
            input.value = row[side[0]];
            validate();
          });
          line.append(input);
        });
        const remove = el("button", "task-action task-action-danger", "删掉");
        remove.type = "button";
        remove.disabled = rows.length <= 1;
        remove.addEventListener("click", () => {
          rows.splice(index, 1);
          renderRows();
          validate();
        });
        line.append(remove);
        list.append(line);
      });
    }

    const add = el("button", "task-action", "＋ 加一段");
    add.type = "button";
    add.addEventListener("click", () => {
      const last = rows[rows.length - 1];
      const from = last ? api.clockMinutes(last.end) : 19 * 60;
      rows.push({ start: api.clockText(from), end: api.clockText(Math.min(23 * 60 + 30, from + 60)) });
      renderRows();
      validate();
    });

    renderRows();
    sheet.body.append(list, add, warn);
    sheet.body.append(
      el("p", "task-hint", "有课、上班、睡觉这些固定忙的时段：去日程表上点那些空格子就行，会划成「非空闲」（默认每周这一天都算忙），排期自动绕开它们。")
    );

    const foot = el("div", "task-actions-cell");
    const later = el("button", "task-action", "先不排期");
    later.type = "button";
    later.addEventListener("click", () => sheet.close());
    const goto = el("button", "task-action", "去日程表划非空闲");
    goto.type = "button";
    goto.addEventListener("click", () => {
      if (!validate()) return;
      api.setSegments(rows);
      api.markPlanSetup();
      sheet.close();
      window.location.href = "index.html";
    });
    foot.append(later, goto, start);
    sheet.body.append(foot);

    start.addEventListener("click", () => {
      if (!validate()) return;
      api.setSegments(rows);
      api.markPlanSetup();
      sheet.close();
      if (typeof onReady === "function") onReady();
    });

    validate();
  }

  // 点卡片上的「同步」：把还没排期的知识点排进日程表（第一次先请用户把时间段定一下）
  function syncGoal(goalId) {
    const goal = api.goal(goalId);
    if (!goal) return;
    const run = () => {
      const plan = planSchedule({ only: goalId });
      const queued = api.goalTasks(goalId).length;
      setStatus(
        "「" + goal.title + "」同步好了：" +
          (plan.placed > 0 ? "新排了 " + plan.placed + " 个时间段" : "没有需要新排的") +
          (queued > 0 ? "，任务 " + queued + " 条" : "") +
          (plan.missed > 0 ? "；有 " + plan.missed + " 个这几天没空位，放开一些时间再同步" : "") +
          "。"
      );
    };
    if (!api.planSetupDone()) {
      openPlanSetup(run);
      return;
    }
    run();
  }

  // 重新规划：没做完的都腾出来重新找位置（做完的、已经过去的保持不动），可以撤销
  function snapshotPlan() {
    const shots = [];
    api.goals().forEach((goal) => {
      (goal.nodes || []).forEach((node) => {
        shots.push({ goalId: goal.id, nodeId: node.id, date: node.date || "", slot: node.slot || "", hours: node.hours || 0 });
      });
    });
    return shots;
  }

  function savePlanUndo(shots) {
    try {
      window.localStorage.setItem(PLAN_UNDO_KEY, JSON.stringify(shots));
    } catch (error) {
      // 存不下也没关系，撤销就这次有效
    }
  }

  function loadPlanUndo() {
    try {
      const raw = window.localStorage.getItem(PLAN_UNDO_KEY);
      const list = raw ? JSON.parse(raw) : null;
      return Array.isArray(list) && list.length > 0 ? list : null;
    } catch (error) {
      return null;
    }
  }

  function clearPlanUndo() {
    try {
      window.localStorage.removeItem(PLAN_UNDO_KEY);
    } catch (error) {
      // 忽略
    }
  }

  function replanAll() {
    const shots = snapshotPlan();
    const plan = planSchedule({ replan: true });
    savePlanUndo(shots);
    if (plan.placed === 0 && plan.missed === 0) {
      setSchedStatus("没有需要重新排的知识点。");
    } else {
      setSchedStatus(
        "重新规划好了：动了 " + plan.placed + " 个知识点" +
          (plan.missed > 0 ? "，有 " + plan.missed + " 个没找到空位" : "") +
          "。不满意可以点右边的「撤销规划」改回去。"
      );
    }
    renderSchedule();
  }

  function undoPlan() {
    const shots = loadPlanUndo();
    if (!shots) return;
    const byGoal = new Map();
    shots.forEach((shot) => {
      if (!byGoal.has(shot.goalId)) byGoal.set(shot.goalId, new Map());
      byGoal.get(shot.goalId).set(shot.nodeId, shot);
    });
    byGoal.forEach((map, goalId) => {
      const goal = api.goal(goalId);
      if (!goal) return;
      const nodes = (goal.nodes || []).map((node) => {
        const shot = map.get(node.id);
        if (!shot) return node;
        return Object.assign({}, node, { date: shot.date, slot: shot.slot, hours: shot.hours });
      });
      api.updateGoal(goalId, { nodes: nodes, outline: outlineText(goal.title, nodes, metaOf(goal)) });
      api.syncGoalTasks(goalId);
    });
    clearPlanUndo();
    setSchedStatus("已经改回重新规划之前的样子了。");
    renderSchedule();
    renderGoals();
  }

  // 「撤销规划」按钮挂在日程表顶部那行（有时间段问题时不抢位置，问题优先显示）
  function renderScheduleUndo() {
    const node = document.getElementById("sched-undo");
    if (!node) return;
    const shots = loadPlanUndo();
    node.hidden = !shots;
    node.replaceChildren();
    if (!shots) return;
    node.append(el("span", "sched-warn-text", "这份排期是「重新规划」出来的。"));
    const undo = el("button", "task-action", "撤销规划");
    undo.type = "button";
    undo.dataset.action = "sched-undo";
    node.append(undo);
  }

  

  /* ---------- 拖拽改期：把任务块拖到空闲的格子上 ---------- */

  // 一格里的总时长不能超过这一段的长度：超了就不动，并说清还剩多少
  function cellFits(date, slot, hours, exclude) {
    if (!api.segment(slot)) return false;
    const room = api.segmentMinutes(slot) / 60;
    return api.usedHours(date, slot, exclude || {}) + (Number(hours) || 0) <= room + 0.001;
  }

  function leftHours(date, slot, exclude) {
    const room = api.segmentMinutes(slot) / 60;
    return Math.max(0, Math.round((room - api.usedHours(date, slot, exclude || {})) * 2) / 2);
  }

  function cellFullNote(date, slot, exclude) {
    const seg = api.segment(slot);
    return "这一格（" + (seg ? seg.start + "–" + seg.end : slot) + "）只剩 " + leftHours(date, slot, exclude) +
      " 小时，放不下了 —— 这次改动没生效。要腾地方就把这一格里别的块挪走、或者把时间段改长一点。";
  }

  function dragInfo() {
    const drag = sched.drag;
    if (!drag) return null;
    if (drag.taskId) {
      const task = api.list().find((item) => item.id === drag.taskId);
      if (!task) return null;
      return { hours: Number(task.hours) || 1, exclude: { taskId: task.id } };
    }
    const goal = api.goal(drag.goalId);
    const node = goal ? (goal.nodes || []).find((item) => item.id === drag.nodeId) : null;
    if (!node) return null;
    return { hours: Number(node.hours) || 1, exclude: { goalId: drag.goalId, nodeId: drag.nodeId } };
  }

  // 能接住拖拽的格子：没过去、不是非空闲、而且放下之后总时长还不超
  function dropCellOf(target) {
    if (!sched.drag || !target || typeof target.closest !== "function") return null;
    const cell = target.closest(".sched-cell");
    if (!cell || cell.classList.contains("is-past") || cell.classList.contains("is-busy")) return null;
    const slot = cell.dataset.slot;
    const info = dragInfo();
    if (!info) return null;
    const limit = Math.round((api.segmentMinutes(slot) / 60) * 2) / 2;
    const hours = Math.max(0.5, Math.min(info.hours, limit));
    return cellFits(cell.dataset.date, slot, hours, info.exclude) ? cell : null;
  }

  function moveNodeTo(goalId, nodeId, date, slot) {
    const goal = api.goal(goalId);
    if (!goal || !api.segment(slot) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return false;
    // 挪到短一点的段里就把时长按段长砍，免得显示成「19:30–22:30 · 3 小时」
    const limit = Math.round((api.segmentMinutes(slot) / 60) * 2) / 2;
    const node = (goal.nodes || []).find((item) => item.id === nodeId);
    if (!node) return false;
    // 没排过期的节点默认占 1 小时（排过的保持自己的时长），超过段长的按段长收
    const hours = Math.max(0.5, Math.min(Number(node.hours) || Math.min(1, limit), limit));
    if (!cellFits(date, slot, hours, { goalId: goalId, nodeId: nodeId })) {
      setSchedStatus(cellFullNote(date, slot, { goalId: goalId, nodeId: nodeId }));
      renderSchedule();
      return false;
    }
    const nodes = (goal.nodes || []).map((item) =>
      item.id === nodeId ? Object.assign({}, item, { date: date, slot: slot, hours: hours }) : item
    );
    api.updateGoal(goal.id, { nodes: nodes, outline: outlineText(goal.title, nodes, metaOf(goal)) });
    api.syncGoalTasks(goal.id);
    return true;
  }

  function wireScheduleDrag(wrap) {
    if (wrap.dataset.dragWired) return;
    wrap.dataset.dragWired = "1";

    wrap.addEventListener("dragstart", (event) => {
      const chip = event.target.closest(".sched-chip");
      if (!chip) return;
      sched.drag = { goalId: chip.dataset.id, nodeId: chip.dataset.node, taskId: chip.dataset.task || "" };
      chip.classList.add("is-dragging");
      wrap.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", chip.dataset.task || chip.dataset.id + "/" + chip.dataset.node);
      }
    });

    wrap.addEventListener("dragover", (event) => {
      const cell = dropCellOf(event.target);
      if (!cell) return;
      event.preventDefault(); // 不拦下来就不会触发 drop
      cell.classList.add("is-drop");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });

    wrap.addEventListener("dragleave", (event) => {
      const cell = dropCellOf(event.target);
      if (cell) cell.classList.remove("is-drop");
    });

    wrap.addEventListener("drop", (event) => {
      const cell = dropCellOf(event.target);
      const drag = sched.drag;
      if (!cell) {
        // 放不下：说清还剩多少，然后什么都不做（等于撤销这次操作）
        const near = event.target.closest ? event.target.closest(".sched-cell") : null;
        const info = dragInfo();
        if (near && info) setSchedStatus(cellFullNote(near.dataset.date, near.dataset.slot, info.exclude));
        sched.drag = null;
        wrap.classList.remove("is-dragging");
        return;
      }
      event.preventDefault();
      sched.drag = null;
      wrap.classList.remove("is-dragging");
      wrap.querySelectorAll(".is-drop").forEach((node) => node.classList.remove("is-drop"));
      if (drag.taskId) {
        if (api.placeTask(drag.taskId, { date: cell.dataset.date, slot: cell.dataset.slot })) {
          const segment = api.segment(cell.dataset.slot);
          setSchedStatus("挪到 " + cell.dataset.date.slice(5) + " 的 " + (segment ? segment.start + "–" + segment.end : "") + " 了。");
        } else {
          setSchedStatus("这一格放不下这条任务，没动它。");
          renderSchedule();
        }
        return;
      }
      moveNodeTo(drag.goalId, drag.nodeId, cell.dataset.date, cell.dataset.slot);
    });

    wrap.addEventListener("dragend", () => {
      sched.drag = null;
      wrap.classList.remove("is-dragging");
      wrap.querySelectorAll(".is-drop").forEach((cell) => cell.classList.remove("is-drop"));
      wrap.querySelectorAll(".is-dragging").forEach((chip) => chip.classList.remove("is-dragging"));
    });
  }

  // 待安排：还没排进日程表的知识点，以及在任务页点了「加入日程表」的任务。
  // 拖到格子上就排好了（也可以点一下让它高亮、在下面的面板里挑时间）；任务还能整个从这儿拿掉。
  function renderScheduleTray() {
    const box = document.getElementById("sched-tray");
    if (!box) return;
    const nodes = [];
    api.goals().forEach((goal) => {
      (goal.nodes || []).forEach((node) => {
        if (node.done) return;
        if (node.date && node.slot && api.segment(node.slot)) return;
        nodes.push({ goal: goal, node: node });
      });
    });
    const tasks = api.list().filter((task) => task.planRequested && !(task.goalId && task.nodeId));
    const total = nodes.length + tasks.length;
    box.hidden = total === 0;
    box.replaceChildren();
    if (box.hidden) return;

    const head = el("div", "sched-tray-head");
    head.append(el("strong", "sched-tray-title", "待安排 " + total));
    head.append(el("span", "task-hint", "拖到格子上就排好了；点一下能在下面挑日期 / 时段 / 时长。"));
    box.append(head);

    const list = el("div", "sched-tray-list");
    nodes.forEach((entry) => {
      const chip = el("div", "sched-chip is-tray" + (sched.missing === entry.node.id ? " is-focus" : ""));
      chip.draggable = true;
      chip.dataset.id = entry.goal.id;
      chip.dataset.node = entry.node.id;
      chip.title = "【" + entry.goal.title + "】" + entry.node.title + "：还没排时间，拖到格子上或点一下挑时间";
      const main = el("button", "sched-chip-main");
      main.type = "button";
      main.dataset.action = "sched-pick";
      main.dataset.id = entry.goal.id;
      main.dataset.node = entry.node.id;
      main.append(el("span", "sched-chip-title", entry.node.title));
      main.append(el("span", "sched-time", "未排期"));
      chip.append(main);
      list.append(chip);
    });
    tasks.forEach((task) => {
      const chip = el("div", "sched-chip is-tray is-task" + (sched.missing === task.id ? " is-focus" : ""));
      chip.draggable = true;
      chip.dataset.task = task.id;
      chip.title = task.title + "：还没排时间，拖到格子上或点一下挑时间";
      const main = el("button", "sched-chip-main");
      main.type = "button";
      main.dataset.action = "sched-task";
      main.dataset.task = task.id;
      main.append(el("span", "sched-chip-title", task.title));
      main.append(el("span", "sched-time", "未排期"));
      chip.append(main);
      const drop = el("button", "sched-chip-drop", "✕");
      drop.type = "button";
      drop.dataset.action = "tray-drop";
      drop.dataset.task = task.id;
      drop.title = "从待安排里拿掉";
      drop.setAttribute("aria-label", "把「" + task.title + "」从待安排里拿掉");
      chip.append(drop);
      list.append(chip);
    });
    box.append(list);
  }

  const SCHED_VIEW_KEY = "spasre-sched-view";

  function saveView() {
    try {
      window.localStorage.setItem(SCHED_VIEW_KEY, sched.view);
    } catch (error) {
      // 存不下也没关系
    }
  }

  function loadView() {
    try {
      const value = window.localStorage.getItem(SCHED_VIEW_KEY);
      return value === "day" || value === "month" ? value : "week";
    } catch (error) {
      return "week";
    }
  }

  // 首页那份只是这一周的概览（不出现待安排 / 编辑面板），日程表页才是干活的地方
  function isSchedulePage() {
    return Boolean(document.getElementById("sched-tray"));
  }

  function schedWeekDays() {
    if (!sched.weekStart) sched.weekStart = loadWeek() || weekStartOf(api.today());
    const days = [];
    for (let step = 0; step < 7; step += 1) days.push(shiftDate(sched.weekStart, step));
    return days;
  }

  function dayShift(key, delta) {
    const parts = String(key).split("-").map(Number);
    const time = new Date(parts[0], parts[1] - 1, parts[2] + delta);
    return time.getFullYear() + "-" + pad2(time.getMonth() + 1) + "-" + pad2(time.getDate());
  }

  function monthShift(key, delta) {
    const parts = String(key).split("-").map(Number);
    const time = new Date(parts[0], parts[1] - 1 + delta, 1);
    return time.getFullYear() + "-" + pad2(time.getMonth() + 1);
  }

  function renderSchedHead() {
    const labels = sched.view === "day" ? ["前一天", "后一天", "今天"] : sched.view === "month" ? ["上个月", "下个月", "本月"] : ["上一周", "下一周", "本周"];
    const prev = document.getElementById("sched-prev-btn");
    const next = document.getElementById("sched-next-btn");
    const today = document.getElementById("sched-today-btn");
    if (prev) prev.textContent = labels[0];
    if (next) next.textContent = labels[1];
    if (today) today.textContent = labels[2];
    const range = document.getElementById("sched-range");
    if (range) {
      if (sched.view === "day") {
        const date = sched.day || api.today();
        range.textContent = date + " " + weekdayLabel(date) + (date === api.today() ? "（今天）" : "");
      } else if (sched.view === "month") {
        const month = sched.month || api.today().slice(0, 7);
        range.textContent = month.slice(0, 4) + " 年 " + Number(month.slice(5, 7)) + " 月";
      } else {
        const days = schedWeekDays();
        range.textContent = days[0].slice(5) + " → " + days[6].slice(5);
      }
    }
    document.querySelectorAll(".sched-view-btn").forEach((button) => {
      const on = button.dataset.view === sched.view;
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", String(on));
    });
  }

  /* ---------- 日视图：24 小时一条时间轴，任务按自己的时段挂上去 ---------- */

  const DAY_HOUR = 56;

  function renderDayView(box) {
    const date = sched.day || api.today();
    box.replaceChildren();
    const entries = scheduleMap();
    const minsToPx = (minutes) => Math.round((minutes / 60) * DAY_HOUR);

    const hours = el("div", "day-hours");
    for (let hour = 0; hour < 24; hour += 1) {
      const row = el("div", "day-hour");
      row.style.height = DAY_HOUR + "px";
      row.append(el("span", "day-hour-label", pad2(hour) + ":00"));
      hours.append(row);
    }

    const track = el("div", "day-track");
    track.style.height = 24 * DAY_HOUR + "px";
    hours.style.height = 24 * DAY_HOUR + "px";

    // 现在几点：一条横线（只在看今天时出现）
    if (date === api.today()) {
      const now = new Date();
      const line = el("div", "day-now");
      line.style.top = minsToPx(now.getHours() * 60 + now.getMinutes()) + "px";
      line.append(el("span", "day-now-label", pad2(now.getHours()) + ":" + pad2(now.getMinutes())));
      track.append(line);
    }

    schedRows().forEach((seg) => {
      const start = api.clockMinutes(seg.start);
      const end = api.clockMinutes(seg.end);
      if (start < 0 || end <= start) return;
      const cell = entries.get(goalStamp(date, seg.key)) || [];
      const busy = api.slotBusy(date, seg.key);
      const past = rowPassed(date, seg);
      const block = el("div", "day-seg");
      block.style.top = minsToPx(start) + "px";
      block.style.height = Math.max(30, minsToPx(end - start)) + "px";
      if (busy) block.classList.add("is-busy");
      if (past) block.classList.add("is-past");
      if (cell.length > 0) block.classList.add("has-items");

      const head = el("div", "day-seg-head");
      head.append(el("span", "day-seg-time", segRange(seg)));
      const used = api.usedHours(date, seg.key);
      head.append(el("span", "day-seg-room", used > 0 ? "已排 " + used + " / " + segmentHoursText(seg) + " 小时" : "空着"));
      block.append(head);

      if (cell.length > 0) {
        block.append(scheduleCell(date, seg, cell, busy, past, false, true));
      } else {
        const empty = el("button", "day-seg-empty", busy ? "非空闲（点一下放开）" : "空着 —— 从上面的待安排拖进来");
        empty.type = "button";
        empty.dataset.action = "sched-busy";
        empty.dataset.date = date;
        empty.dataset.slot = seg.key;
        empty.disabled = past;
        if (past) empty.textContent = "这段时间已经过去了";
        block.append(empty);
        if (busy && !past) {
          const free = el("button", "task-action day-seg-free", "恢复成空闲");
          free.type = "button";
          free.dataset.action = "sched-busy";
          free.dataset.date = date;
          free.dataset.slot = seg.key;
          block.append(free);
        }
      }
      track.append(block);
    });

    const wrap = el("div", "day-grid");
    wrap.append(hours, track);
    box.append(wrap);
  }

  function segmentHoursText(seg) {
    const minutes = api.segmentMinutes(seg.key);
    const hours = Math.round((minutes / 60) * 2) / 2;
    return String(hours);
  }

  /* ---------- 月视图：一天一格，点颜色看完成情况，悬停看当天有什么 ---------- */

  function daySummary(date) {
    const entries = scheduleMap();
    const titles = [];
    let total = 0;
    let done = 0;
    let late = 0;
    schedRows().forEach((seg) => {
      (entries.get(goalStamp(date, seg.key)) || []).forEach((entry) => {
        total += 1;
        if (entry.task) {
          titles.push("· " + entry.task.title + "（任务）");
          return;
        }
        const isDone = Boolean(entry.node.done);
        if (isDone) done += 1;
        const key = api.nodeKey(entry.goal.id, entry.node.id);
        const overdue = !isDone && api.overdue().indexOf(key) >= 0;
        if (overdue) late += 1;
        titles.push((isDone ? "✓ " : overdue ? "! " : "· ") + entry.node.title);
      });
    });
    let tone = "idle";
    if (late > 0) tone = "late";
    else if (total > 0 && done === total) tone = "done";
    else if (total > 0) tone = date < api.today() ? "late" : "planned";
    return { titles: titles, total: total, done: done, late: late, tone: tone };
  }

  function renderMonthView(box) {
    const monthKey = sched.month || api.today().slice(0, 7);
    const year = Number(monthKey.slice(0, 4));
    const month = Number(monthKey.slice(5, 7));
    const first = new Date(year, month - 1, 1);
    const lead = (first.getDay() + 6) % 7; // 周一开头
    const days = new Date(year, month, 0).getDate();
    box.replaceChildren();

    const week = el("div", "month-week");
    ["一", "二", "三", "四", "五", "六", "日"].forEach((name) => week.append(el("span", "month-weekday", "周" + name)));
    const grid = el("div", "month-grid");
    for (let pad = 0; pad < lead; pad += 1) grid.append(el("div", "month-day is-blank"));
    for (let day = 1; day <= days; day += 1) {
      const date = monthKey + "-" + pad2(day);
      const info = daySummary(date);
      const cell = el("button", "month-day");
      cell.type = "button";
      cell.dataset.action = "sched-day";
      cell.dataset.date = date;
      if (date === api.today()) cell.classList.add("is-today");
      if (date < api.today()) cell.classList.add("is-past");
      cell.append(el("span", "month-day-num", String(day)));
      const dot = el("span", "month-dot");
      dot.dataset.tone = info.tone;
      cell.append(dot);
      if (info.total > 0) cell.append(el("span", "month-count", info.done + "/" + info.total));
      cell.title = date + " " + weekdayLabel(date) + "\n" + (info.titles.length > 0 ? info.titles.join("\n") : "没有安排");
      grid.append(cell);
    }
    box.append(week, grid);
  }

  // 从别的页跳过来带的信息：?task=xxx 定位到它那周 / 那天（还没排期的就靠待安排里那个高亮）
  function applySchedFocus() {
    if (typeof window.URLSearchParams !== "function") return;
    const params = new window.URLSearchParams(window.location.search);
    const taskId = params.get("task");
    const date = params.get("date");
    const view = params.get("view");
    if (view === "day" || view === "month" || view === "week") sched.view = view;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sched.day = date;
      sched.weekStart = weekStartOf(date);
      sched.month = date.slice(0, 7);
      saveWeek();
    }
    if (taskId) {
      sched.missing = taskId;
      const task = api.list().find((item) => item.id === taskId);
      if (task && task.date) {
        sched.weekStart = weekStartOf(task.date);
        sched.day = task.date;
        sched.month = task.date.slice(0, 7);
        saveWeek();
        if (task.slot) {
          sched.view = view === "day" ? "day" : "week";  // 排好的任务：直接给到它那一周（那天也带上）
          sched.task = task.id;                          // 并把它那块的面板打开
        }
      }
    }
    if (sched.view === "day" && !sched.day) sched.day = api.today();
    if (sched.view === "month" && !sched.month) sched.month = api.today().slice(0, 7);
    if (taskId || date || view) {
      try {
        window.history.replaceState(null, "", "schedule.html");
      } catch (error) {
        // 换不了就算了，不影响用
      }
    }
  }

  function renderSchedule() {
    const wrap = document.getElementById("sched-wrap");
    const dayBox = document.getElementById("sched-day");
    const monthBox = document.getElementById("sched-month");
    sched.preview = !isSchedulePage();
    // 首页：只画这一周的概览
    if (sched.preview) {
      if (wrap) wrap.hidden = false;
      renderScheduleTable();
      return;
    }
    renderScheduleWarn();
    renderScheduleUndo();
    renderScheduleTray();
    renderSchedHead();
    const view = sched.view || "week";
    if (wrap) wrap.hidden = view !== "week";
    if (dayBox) dayBox.hidden = view !== "day";
    if (monthBox) monthBox.hidden = view !== "month";
    if (view === "day" && dayBox) renderDayView(dayBox);
    else if (view === "month" && monthBox) renderMonthView(monthBox);
    else renderScheduleTable();
    renderScheduleEdit();
  }

  // 时间段的问题一律挂在日程表顶部（跟上一段叠了、时间没填完、只剩一段），
  // 没问题就把这一行收起来。有问题时右边给一个「按时间排序」——它只把行按开始时间排好，
  // 一个字的时间都不改。sched.warn 放的是「这次没保存」这类一次性说明。
  function renderScheduleWarn() {
    const node = document.getElementById("sched-warn");
    if (!node) return;
    const problem = api.checkSegments(schedRows());
    // 改了还没存：也在这行说一句，免得刷新之后忘了
    const info = sched.draft && !problem ? "时间段有改动还没保存 —— 点行首的时间标签，按「保存」存下来。" : "";
    const text = problem || sched.warn || info;
    node.hidden = !text;
    node.classList.toggle("is-info", !problem);
    node.replaceChildren();
    if (!text) return;
    node.append(el("span", "sched-warn-text", text));
  }

  // 每分钟看一眼：时间往前走，有些段就变成「已经过去了」
  let schedTick = 0;

  function startScheduleClock() {
    if (schedTick) return;
    schedTick = window.setInterval(() => {
      if (sched.drag) return; // 正在拖就先别动 DOM
      if (document.getElementById("sched-wrap")) renderScheduleTable();
    }, 60000);
  }

  // 进入某一周时把「今天」那一列拉到最左边：窄屏下七列放不下，
  // 停在周一的话一进来就是半屏灰格子（过去的日子），今天反而在屏幕外
  let schedAlignedWeek = null;

  function renderScheduleTable() {
    const wrap = document.getElementById("sched-wrap");
    if (!wrap) return;
    renderScheduleWarn();
    // 拖拽挂在日程表这块的外层：待安排那一排（在 #sched-wrap 外面）也能拖进来
    wireScheduleDrag(document.getElementById("goal-schedule") || wrap);
    startScheduleClock();
    if (!sched.weekStart) sched.weekStart = loadWeek() || weekStartOf(api.today());
    const today = api.today();
    const map = scheduleMap();
    const days = [];
    for (let step = 0; step < 7; step += 1) days.push(shiftDate(sched.weekStart, step));
    const range = document.getElementById("sched-range");
    if (range) range.textContent = days[0].slice(5) + " → " + days[6].slice(5);

    const table = el("table", "sched-table");
    const head = el("thead");
    const headRow = el("tr");
    headRow.append(el("th", "sched-slot", ""));
    days.forEach((date) => {
      headRow.append(el("th", date === today ? "is-today" : "", weekdayLabel(date) + " " + date.slice(5)));
    });
    head.append(headRow);
    table.append(head);

    const body = el("tbody");
    const clash = new Set(api.clashKeys(schedRows()));
    schedRows().forEach((seg) => {
      const row = el("tr");
      const head = el("th", "sched-slot");
      // 点时间标签就能改这一段（开始 / 结束 / 保存 / 删掉）
      const label = el(
        "button",
        "sched-seg" + (sched.seg === seg.key ? " is-picked" : "") + (clash.has(seg.key) ? " is-clash" : ""),
        segRange(seg)
      );
      label.type = "button";
      label.dataset.action = "sched-seg";
      label.dataset.key = seg.key;
      label.title = clash.has(seg.key) ? "这段时间跟别的段叠了" : "改这一段的时间";
      head.append(label);
      row.append(head);
      days.forEach((date) => {
        const stamp = goalStamp(date, seg.key);
        const cell = el("td");
        cell.append(scheduleCell(date, seg, map.get(stamp) || [], api.slotBusy(date, seg.key), rowPassed(date, seg), clash.has(seg.key)));
        row.append(cell);
      });
      body.append(row);
    });
    table.append(body);
    const keepLeft = wrap.scrollLeft;          // 重画别把用户自己滚到的地方弹回去
    const weekChanged = schedAlignedWeek !== sched.weekStart;
    wrap.replaceChildren(table);
    let left = keepLeft;
    if (weekChanged) {
      // 今天是几号就把它贴到最左边（靠左那列时间标签是 sticky 的，会一直露着）
      const slot = table.querySelector("th.sched-slot");
      const todayHead = table.querySelector("th.is-today");
      const slotWidth = slot ? slot.getBoundingClientRect().width : 0;
      left = 0;
      if (todayHead) {
        const gap = todayHead.getBoundingClientRect().left - wrap.getBoundingClientRect().left;
        left = wrap.scrollLeft + gap - slotWidth;
      }
      schedAlignedWeek = sched.weekStart;
    }
    const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    wrap.scrollLeft = Math.max(0, Math.min(left, maxLeft));
  }

  function pickedNode() {
    if (!sched.pick) return null;
    const goal = api.goal(sched.pick.goalId);
    if (!goal) return null;
    const node = (goal.nodes || []).find((item) => item.id === sched.pick.nodeId);
    return node ? { goal: goal, node: node } : null;
  }

  function renderScheduleEdit() {
    const box = document.getElementById("sched-edit");
    if (!box) return;
    if (sched.seg) {
      renderSegmentEdit(box);
      return;
    }
    if (sched.task) {
      renderTaskEdit(box);
      return;
    }
    const picked = pickedNode();
    if (!picked) {
      sched.pick = null;
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    box.replaceChildren();
    box.append(el("span", "sched-edit-title", "【" + picked.goal.title + "】" + picked.node.title));

    const dateField = el("label", "task-field");
    dateField.append(el("span", null, "日期"));
    const dateInput = document.createElement("input");
    dateInput.className = "task-input";
    dateInput.type = "date";
    dateInput.min = api.today();
    dateInput.value = picked.node.date || api.today();
    dateInput.addEventListener("change", () => movePicked(dateInput.value, "", 0));
    dateField.append(dateInput);
    box.append(dateField);

    const slotField = el("label", "task-field");
    slotField.append(el("span", null, "时段"));
    const slotSelect = document.createElement("select");
    slotSelect.className = "task-select";
    schedRows().forEach((seg) => {
      const option = document.createElement("option");
      option.value = seg.key;
      option.textContent = segRange(seg);
      slotSelect.append(option);
    });
    slotSelect.value = picked.node.slot || schedRows()[0].key;
    slotSelect.addEventListener("change", () => movePicked("", slotSelect.value, 0));
    slotField.append(slotSelect);
    box.append(slotField);

    const hoursField = el("label", "task-field");
    hoursField.append(el("span", null, "时长（小时）"));
    const hoursInput = document.createElement("input");
    hoursInput.className = "task-input";
    hoursInput.type = "number";
    hoursInput.min = "0.5";
    hoursInput.max = "8";
    hoursInput.step = "0.5";
    const hourLimit = api.slotHours(slotSelect.value, picked.node.hours);
    hoursInput.value = String(hourLimit);
    hoursInput.max = String(api.segmentMinutes(slotSelect.value) / 60);
    hoursInput.addEventListener("change", () => movePicked("", "", Number(hoursInput.value)));
    hoursField.append(hoursInput);
    box.append(hoursField);

    const clear = el("button", "task-action task-action-danger", "取消安排");
    clear.type = "button";
    clear.dataset.action = "sched-clear";
    box.append(clear);

    if (sched.note) box.append(el("p", "task-hint sched-edit-note", sched.note));
  }

  // 改日期 / 时段 / 时长：改完立刻写回，页面自己会重画；放不下就原样退回
  function movePicked(date, slot, hours) {
    const picked = pickedNode();
    if (!picked) return;
    const limitSlot = slot || picked.node.slot;
    const limit = Math.round((api.segmentMinutes(limitSlot) / 60) * 2) / 2;
    const next = {
      date: date || picked.node.date,
      slot: limitSlot,
      hours: Math.max(0.5, Math.min(hours ? Math.max(0.5, hours) : Number(picked.node.hours) || limit, limit))
    };
    if (!cellFits(next.date, next.slot, next.hours, { goalId: picked.goal.id, nodeId: picked.node.id })) {
      setSchedStatus(cellFullNote(next.date, next.slot, { goalId: picked.goal.id, nodeId: picked.node.id }));
      renderSchedule();
      return;
    }
    if (api.slotPassed(next.date, next.slot)) {
      sched.note = "这段时间已经过去了，换一段吧。";
      renderSchedule();
      return;
    }
    sched.note = "";
    const nodes = (picked.goal.nodes || []).map((node) =>
      node.id === picked.node.id ? Object.assign({}, node, next) : node
    );
    api.updateGoal(picked.goal.id, { nodes: nodes, outline: outlineText(picked.goal.title, nodes, metaOf(picked.goal)) });
    api.syncGoalTasks(picked.goal.id);
  }

  function clearPicked() {
    const picked = pickedNode();
    if (!picked) return;
    const nodes = (picked.goal.nodes || []).map((node) =>
      node.id === picked.node.id ? Object.assign({}, node, { date: "", slot: "", hours: 0 }) : node
    );
    sched.pick = null;
    api.updateGoal(picked.goal.id, { nodes: nodes, outline: outlineText(picked.goal.title, nodes, metaOf(picked.goal)) });
    api.syncGoalTasks(picked.goal.id);
  }

  // 点一下就是「每周这个时间的这一段都算忙」（默认口径），再点一下放开
  function toggleBusy(date, slot) {
    if (!date || !api.segment(slot)) return;
    api.setBusyWeekly(date, slot, !api.slotBusy(date, slot));
    setSchedStatus(api.slotBusy(date, slot) ? "每周" + weekdayLabel(date) + "的这个时段算非空闲了，排期会绕开它。" : "这一段又空出来了。");
  }

  /* ---------- 过期没做的任务：重排 + 下游锁定 ---------- */

  function setSchedStatus(text) {
    sched.note = "";
    const node = document.getElementById("sched-status");
    if (node) node.textContent = String(text || "");
  }

  function slotStartTs(date, key) {
    const seg = api.segment(key);
    if (!seg) return NaN;
    const start = new Date(String(date) + "T" + seg.start + ":00");
    return isNaN(start.getTime()) ? NaN : start.getTime();
  }

  function slotEndTs(date, key) {
    const seg = api.segment(key);
    if (!seg) return NaN;
    const end = new Date(String(date) + "T" + seg.end + ":00");
    return isNaN(end.getTime()) ? NaN : end.getTime();
  }

  // 一个知识点的下流（所有直接/间接依赖它的），按拓扑序排好。
  // 传进来的必须是准备写回的那份 nodes：这里返回的就是同一批对象，改它们才写得回去。
  function downstreamOf(nodes, nodeId) {
    const list = Array.isArray(nodes) ? nodes : [];
    const found = new Set([nodeId]);
    let grew = true;
    while (grew) {
      grew = false;
      list.forEach((node) => {
        if (found.has(node.id)) return;
        if ((node.deps || []).some((dep) => found.has(dep))) {
          found.add(node.id);
          grew = true;
        }
      });
    }
    found.delete(nodeId);
    const rank = topoOrder(list);
    return list.filter((node) => found.has(node.id)).sort((a, b) => rank.indexOf(a) - rank.indexOf(b));
  }

  // 挡住这个节点的、最近的一个「过期没做」的前置
  function blockerOf(goal, nodeId) {
    const nodes = goal.nodes || [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const overdue = api.overdue();
    const queue = [(byId.get(nodeId) || {}).deps || []];
    const seen = new Set([nodeId]);
    while (queue.length > 0) {
      const deps = queue.shift();
      for (const dep of deps) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        if (overdue.indexOf(api.nodeKey(goal.id, dep)) >= 0) return byId.get(dep) || null;
        const parent = byId.get(dep);
        if (parent) queue.push(parent.deps || []);
      }
    }
    return null;
  }

  // 把一个过期没做的知识点排到后面的空位：先保证在它下流任务之前，排不下就把下流一起往后让
  function rescheduleOverdue(goalId, nodeId) {
    const goal = api.goal(goalId);
    if (!goal) return;
    const nodes = (goal.nodes || []).map((node) => Object.assign({}, node));
    const target = nodes.find((node) => node.id === nodeId);
    if (!target) return;

    const chain = [target].concat(downstreamOf(nodes, nodeId));
    const busy = new Set(api.busy());
    const taken = new Set();
    nodes.forEach((node) => {
      if (chain.some((item) => item.id === node.id)) return;
      if (node.date && node.slot) taken.add(goalStamp(node.date, node.slot));
    });

    const segments = api.segments().map((seg) => Object.assign({}, seg, { minutes: api.segmentMinutes(seg.key) }));
    const days = planDays(api.today(), goal.deadline || shiftDate(api.today(), 45));

    const findSlot = (after) => {
      for (const date of days) {
        for (const seg of segments) {
          const stamp = goalStamp(date, seg.key);
          if (busy.has(stamp) || taken.has(stamp)) continue;
          if (api.slotPassed(date, seg.key)) continue;
          const start = new Date(date + "T" + seg.start + ":00").getTime();
          if (!(start >= after)) continue;
          return { date: date, seg: seg, start: start };
        }
      }
      return null;
    };

    let floor = Date.now();
    let moved = 0;
    let failed = false;
    chain.forEach((node) => {
      const start = slotStartTs(node.date, node.slot);
      const usable = !isNaN(start) && start >= floor && slotEndTs(node.date, node.slot) > Date.now();
      if (usable) {
        floor = start;
        return;
      }
      const slot = findSlot(floor);
      if (!slot) {
        failed = true;
        return;
      }
      node.date = slot.date;
      node.slot = slot.seg.key;
      node.hours = Math.min(node.hours || slot.seg.minutes / 60, slot.seg.minutes / 60);
      taken.add(goalStamp(slot.date, slot.seg.key));
      floor = slot.start;
      moved += 1;
    });

    if (failed) {
      setSchedStatus("这几天没空位了：先把日程表里的一些段留出来，或者把完成时间往后挪。");
      return;
    }

    const placed = nodes.find((node) => node.id === nodeId);
    api.updateGoal(goal.id, {
      nodes: nodes,
      outline: outlineText(goal.title, nodes, metaOf(goal))
    });
    api.syncGoalTasks(goal.id);
    setSchedStatus(
      "「" + target.title + "」排到了 " + placed.date.slice(5) + " " + api.slotTime(placed.slot, placed.hours) +
        (moved > 1 ? "，后面的 " + (moved - 1) + " 个也跟着往后挪了。" : "。")
    );
  }

  /* ---------- 日程表上的时间段：点时间标签就地改 ---------- */

  function renderSegmentEdit(box) {
    const segments = schedRows();
    const index = segments.findIndex((seg) => seg.key === sched.seg);
    if (index < 0) {
      // 这一段在别处被删了
      sched.seg = "";
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const seg = segments[index];
    box.hidden = false;
    box.replaceChildren();

    const field = (title, type, value, onSave, extra) => {
      const wrap = el("label", "task-field");
      wrap.append(el("span", null, title));
      const input = document.createElement("input");
      input.className = "task-input";
      input.type = type;
      input.value = value;
      Object.keys(extra || {}).forEach((name) => input.setAttribute(name, extra[name]));
      input.addEventListener("change", () => onSave(input.value));
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onSave(input.value);
      });
      wrap.append(input);
      box.append(wrap);
      return input;
    };

    const clockField = { inputmode: "numeric", placeholder: "HH:MM", autocomplete: "off", spellcheck: "false" };
    field("开始", "text", seg.start, (value) => stageSegment(seg.key, { start: normalizeClock(value) }), clockField);
    field("结束", "text", seg.end, (value) => stageSegment(seg.key, { end: normalizeClock(value) }), clockField);

    const save = el("button", "task-action sched-save", "保存");
    save.type = "button";
    save.dataset.action = "segment-save";
    save.title = "存下这段时间的时间：顺手按开始时间排好，有重叠会标红提醒";
    box.append(save);

    const remove = el("button", "task-action task-action-danger", "删掉这段");
    remove.type = "button";
    remove.dataset.action = "segment-remove";
    remove.dataset.key = seg.key;
    remove.disabled = segments.length <= 1;
    remove.title = segments.length <= 1 ? "至少要留一段" : "这一段不要了";
    box.append(remove);

    if (segments.length <= 1) box.append(el("p", "task-hint sched-edit-note", "至少要留一段。"));
  }

  // 改时间：先生效在草稿里（存本地，刷新也不丢），按「保存」才写进数据
  function stageSegment(key, patch) {
    const segments = schedRows();
    const index = segments.findIndex((seg) => seg.key === key);
    if (index < 0) return;
    const next = segments.map((seg, position) => (position === index ? Object.assign({}, seg, patch) : seg));
    sched.seg = key;
    sched.draft = next;
    sched.warn = "";
    saveDraft();
    renderSchedule();
  }

  // 保存：按开始时间排好再存；有重叠就不存，只把冲突的段标红、顶部说一句「时间段有冲突」
  function saveSegments() {
    const rows = schedRows()
      .map((seg) => Object.assign({}, seg))
      .sort((a, b) => api.clockMinutes(a.start) - api.clockMinutes(b.start));
    const problem = api.checkSegments(rows);
    sched.warn = "";
    if (problem) {
      sched.draft = rows;
      saveDraft();
      renderSchedule();
      return problem;
    }
    sched.draft = null;
    saveDraft();
    api.setSegments(rows);
    sched.seg = ""; // 存好了就把下面那块设置收起来
    renderSchedule();
    return "";
  }

  // 一次改动的去处（加段 / 删段用）：合法就落盘，不合法就留在草稿里
  function applySegments(next, keepKey) {
    if (keepKey !== undefined && keepKey !== null) sched.seg = keepKey;
    const problem = api.checkSegments(next);
    sched.warn = "";
    if (!problem) {
      sched.draft = null;
      saveDraft();
      api.setSegments(next);
      renderScheduleTable(); // 只重画网格（顶层提示跟着更新），输入框里的光标留着
      return "";
    }
    sched.draft = next;
    saveDraft();
    renderSchedule();
    return problem;
  }

  // 这次编辑作废：丢掉草稿（本地那份也删掉），回到存着的时间段
  function dropDraft() {
    if (!sched.draft) return false;
    sched.draft = null;
    saveDraft();
    sched.warn = "这段时间的改动没保存 —— 已经退回上一次的时间段。";
    renderSchedule();
    return true;
  }

  function addSegment() {
    const rows = schedRows();
    const last = rows.reduce(
      (tip, seg) => (tip && api.clockMinutes(seg.end) <= api.clockMinutes(tip.end) ? tip : seg),
      null
    );
    const start = last ? api.clockMinutes(last.end) : 8 * 60;
    if (!last || start >= 23 * 60 + 59) {
      sched.seg = last ? last.key : "";
      sched.warn = "一天已经排到 23:59 了，先改掉最后一段的结束时间。";
      renderSchedule();
      return;
    }
    const end = Math.min(start + 60, 23 * 60 + 59);
    const fresh = { key: "seg" + Date.now().toString(36), start: api.clockText(start), end: api.clockText(end) };
    applySegments(rows.concat([fresh]), fresh.key);
  }

  function removeSegment(key) {
    const rows = schedRows().filter((seg) => seg.key !== key);
    applySegments(rows, rows.length > 0 ? rows[rows.length - 1].key : "");
  }

  function openWizard(goalId) {
    const sheet = wzField("goal-sheet");
    if (!sheet) return;
    const goal = goalId ? api.goal(goalId) : null;
    wizard.goalId = goal ? goal.id : "";
    wizard.nodes = goal ? (goal.nodes || []).map((node) => Object.assign({}, node)) : [];
    wizard.note = goal ? goal.planNote || "" : "";
    wizard.source = goal ? goal.planSource || "" : "";
    wizard.diagram = goal ? goal.diagram || "" : "";

    const title = wzField("wz-title");
    if (title) title.value = goal ? goal.title : "";
    const detail = wzField("wz-detail");
    if (detail) detail.value = goal ? goal.detail || "" : "";
    const deadline = wzField("wz-deadline");
    if (deadline) deadline.value = (goal && goal.deadline) || shiftDate(api.today(), 28);
    const weekly = wzField("wz-weekly");
    if (weekly) weekly.value = String((goal && goal.weekly) || 7);
    const heading = wzField("goal-sheet-title");
    if (heading) heading.textContent = goal ? "编辑目标" : "新建目标";

    setWzStatus("");
    renderWizardNodes();
    gotoStep(1);
    sheet.hidden = false;
    if (title) title.focus();
  }

  function closeWizard() {
    const sheet = wzField("goal-sheet");
    if (sheet) sheet.hidden = true;
  }

  function gotoStep(step) {
    wizard.step = Math.max(1, Math.min(4, step));
    document.querySelectorAll("#goal-sheet .wizard-step").forEach((section) => {
      section.hidden = Number(section.dataset.step) !== wizard.step;
    });
    document.querySelectorAll("#wz-steps li").forEach((item) => {
      const index = Number(item.dataset.step);
      item.classList.toggle("is-active", index === wizard.step);
      item.classList.toggle("is-done", index < wizard.step);
    });
    const back = wzField("wz-back");
    if (back) back.hidden = wizard.step === 1;
    const next = wzField("wz-next");
    if (next) next.textContent = wizard.step < 4 ? "下一步" : wizard.goalId ? "保存" : "创建";
    if (wizard.step === 4) renderWizardSummary();
  }

  async function wizardNext() {
    if (wizard.step === 1) {
      if (!wzValue("wz-title")) {
        setWzStatus("先写一个学习目标。");
        const title = wzField("wz-title");
        if (title) title.focus();
        return;
      }
      setWzStatus("");
      gotoStep(2);
      return;
    }
    if (wizard.step === 2) {
      const deadline = wzValue("wz-deadline");
      if (!deadline || deadline <= api.today()) {
        setWzStatus("预期完成时间要在今天之后。");
        return;
      }
      setWzStatus("");
      gotoStep(3);
      await ensureWizardPlan();
      return;
    }
    if (wizard.step === 3) {
      if (wizard.nodes.length === 0) {
        setWzStatus("还没有知识点，等大纲生成出来再往下走。");
        return;
      }
      // 一个目标的知识点数不能超过它这段日子——多了就排不开
      const days = planDays(api.today(), wzValue("wz-deadline"));
      if (wizard.nodes.length > days.length) {
        setWzStatus(
          wizard.nodes.length + " 个知识点，可用只有 " + days.length + " 天（" + api.today() + " → " +
            wzValue("wz-deadline") + "）：把完成时间往后挪，或者删掉几个知识点。"
        );
        return;
      }
      setWzStatus("");
      gotoStep(4);
      return;
    }
    finishWizard();
  }

  // 进第三步该有的都补齐：知识点 → 大纲 → 学习路线图，一次做完
  async function ensureWizardPlan() {
    if (wizard.nodes.length === 0) {
      await generateWizardNodes();
      if (wizard.nodes.length === 0) return; // 生成失败时状态行里已经有原因
    } else {
      renderWizardNodes();
    }
    if (wizard.diagram) {
      showDiagram(wizard.diagram); // 这张图还在，直接摆出来（不重跑）
      setWzStatus(planStatus(""));
    } else {
      await renderWizardDiagram();
    }
  }

  async function generateWizardNodes() {
    const goal = {
      title: wzValue("wz-title"),
      detail: wzValue("wz-detail"),
      startDate: api.today(),
      weekly: Number(wzValue("wz-weekly")) || 7
    };
    setWzStatus("正在生成大纲…");
    const result = await generateNodes(goal);
    wizard.nodes = result.nodes;
    wizard.note = result.note;
    wizard.source = result.source;
    wizard.diagram = ""; // 知识点换了，之前那张路线图就对不上了
    renderWizardNodes();
    setWzStatus(planStatus(""));
  }

  // 只重画大纲那一块：节点列表里有正在编辑的输入框，整块重画会把光标弄丢
  function refreshWizardOutline() {
    const box = wzField("wz-outline");
    if (!box) return;
    box.replaceChildren();
    if (wizard.nodes.length === 0) return;
    box.append(goalOutline(wzValue("wz-title") || "学习大纲", wizard.nodes, {
      weekly: Number(wzValue("wz-weekly")) || 7,
      start: api.today(),
      deadline: wzValue("wz-deadline")
    }));
  }

  let outlineTimer = 0;

  function queueOutlineRefresh() {
    if (outlineTimer) window.clearTimeout(outlineTimer);
    outlineTimer = window.setTimeout(() => {
      outlineTimer = 0;
      refreshWizardOutline();
    }, 400);
  }

  function renderWizardNodes() {
    refreshWizardOutline();

    // 大纲变了，上一张学习路线图就过期了，先收起来
    const diagramBox = wzField("wz-diagram-box");
    if (diagramBox) {
      diagramBox.replaceChildren();
      diagramBox.hidden = true;
    }

    const list = wzField("wz-nodes");
    if (!list) return;
    list.replaceChildren();
    wizard.nodes.forEach((node) => {
      const row = el("li", "node-row");

      const title = document.createElement("input");
      title.className = "task-input";
      title.value = node.title;
      title.placeholder = "知识点";
      title.addEventListener("input", () => {
        node.title = title.value;
        markDiagramStale();
        queueOutlineRefresh();
      });
      row.append(title);

      const url = document.createElement("input");
      url.className = "task-input node-url";
      const link = (node.links || [])[0];
      url.value = link ? link.url : "";
      url.placeholder = "教程链接";
      url.addEventListener("input", () => {
        const value = url.value.trim();
        node.links = value ? [{ title: (link && link.title) || value, url: value }] : [];
        markDiagramStale();
        queueOutlineRefresh();
      });
      row.append(url);

      if (node.section) row.append(el("span", "node-hint", node.section));

      const remove = el("button", "task-action task-action-danger", "删");
      remove.type = "button";
      remove.addEventListener("click", () => {
        wizard.nodes = wizard.nodes.filter((item) => item !== node);
        renderWizardNodes();
        markDiagramStale();
      });
      row.append(remove);
      list.append(row);
    });
  }

  function renderWizardSummary() {
    const box = wzField("wz-summary");
    if (!box) return;
    const start = api.today();
    const deadline = wzValue("wz-deadline") || shiftDate(start, 28);
    const weekly = Number(wzValue("wz-weekly")) || 7;
    const units = wizard.nodes.length;
    const days = Math.max(1, daysBetween(start, deadline) + 1);
    box.textContent =
      units + " 个知识点 · 每周 " + weekly + " 小时 · 每次约 " + hoursPerNode({ weekly: weekly }, units, days) +
      " 小时 · " + start + " → " + deadline + "（" + days + " 天）";

    const preview = wzField("wz-preview");
    if (!preview) return;
    preview.replaceChildren();
    if (units === 0) return;
    const plan = planSchedule({
      dry: true,
      goal: {
        id: "wizard",
        title: wzValue("wz-title"),
        startDate: start,
        deadline: deadline,
        weekly: weekly,
        nodes: JSON.parse(JSON.stringify(wizard.nodes))
      }
    });
    const list = el("ul", "sched-preview");
    plan.details.slice(0, 10).forEach((item) => {
      const row = el("li");
      row.append(el("span", "sched-when", String(item.date).slice(5) + " " + api.slotTime(item.slot, item.hours)));
      row.append(el("span", null, item.title));
      list.append(row);
    });
    preview.append(list);
    if (plan.details.length > 10) {
      preview.append(el("p", "task-hint", "还有 " + (plan.details.length - 10) + " 条排在后面的日子。"));
    }
    if (plan.missed > 0) {
      preview.append(el("p", "task-hint", "有 " + plan.missed + " 个知识点这几天没空位了。"));
    }
  }

  function finishWizard() {
    const title = wzValue("wz-title");
    if (!title) {
      gotoStep(1);
      return;
    }
    const start = api.today();
    const deadline = wzValue("wz-deadline");
    const values = {
      title: title,
      detail: wzValue("wz-detail"),
      startDate: start,
      pace: paceFor(wizard.nodes.length, start, deadline),
      deadline: deadline,
      weekly: Number(wzValue("wz-weekly")) || 7
    };
    const goal = wizard.goalId ? api.updateGoal(wizard.goalId, values) : api.addGoal(values);
    if (!goal) {
      setStatus("没保存成功。");
      return;
    }
    api.updateGoal(goal.id, {
      nodes: wizard.nodes,
      planSource: wizard.source,
      planNote: wizard.note,
      diagram: wizard.diagram
    });
    // 先不排期：什么时候进日程表，由卡片右上角那个「同步」说了算
    closeWizard();
    setStatus("「" + goal.title + "」：" + wizard.nodes.length + " 个知识点。点这张卡右上角的「同步」，把它们排进日程表。");
  }

  // 把一张画好的学习路线图摆进向导（不重新生成）
  function showDiagram(url) {
    const box = wzField("wz-diagram-box");
    if (!box) return;
    const frame = document.createElement("iframe");
    frame.className = "diagram-frame";
    frame.src = url;
    frame.title = "学习路线图";
    box.replaceChildren(frame);
    box.hidden = false;
  }

  // 只在出错或图过期时给一个按钮——平时不摆按钮，但该有路走的时候得有
  function showDiagramRetry(message, action, label) {
    const box = wzField("wz-diagram-box");
    setWzStatus(message);
    if (!box) return;
    const retry = el("button", "task-action", label || "重试");
    retry.type = "button";
    retry.addEventListener("click", () => {
      box.replaceChildren();
      box.hidden = true;
      action();
    });
    box.replaceChildren(retry);
    box.hidden = false;
  }

  // 知识点改过了，挂着的那张图就不作数了：清掉地址，并给一个「重新画」的入口
  function markDiagramStale() {
    if (!wizard.diagram) return;
    wizard.diagram = "";
    showDiagramRetry("大纲改过了，这张学习路线图是旧的。", renderWizardDiagram, "重新画一张");
  }

  // 让后端用 Archify 技能出一张学习路线图（能缩放、能导出的独立 HTML）
  async function drawRoadmap(title, nodes) {
    const bridge = skillBridge();
    if (!bridge) return { ok: false, error: "后端没在跑，出不了图。" };
    try {
      const payload = await bridge.run("diagram.roadmap", {
        title: title + "：学习路线图",
        subtitle: "共 " + nodes.length + " 个知识点",
        nodes: nodes.map((node) => ({
          id: node.id,
          title: node.title,
          brief: node.brief || "",
          deps: node.deps || [],
          links: node.links || []
        }))
      });
      return (payload && payload.result) || { ok: false, error: "后端没回话。" };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }

  async function renderWizardDiagram() {
    if (wizard.nodes.length === 0) {
      setWzStatus("还没有知识点，先把大纲生成出来。");
      return;
    }
    setWzStatus("正在画学习路线图…");
    const info = await drawRoadmap(wzValue("wz-title"), wizard.nodes);
    if (!info.ok) {
      showDiagramRetry("没画成：" + (info.error || "看后端日志"), renderWizardDiagram);
      return;
    }
    showDiagram(info.url);
    wizard.diagram = info.url;
    setWzStatus(planStatus("学习路线图 " + info.seconds + " 秒"));
  }

  // 第三步的状态行：知识点数 · 怎么来的 ·（画好了就是）路线图用了多久
  function planStatus(tail) {
    const parts = [wizard.nodes.length + " 个知识点"];
    const source = sourceLabel(wizard.source);
    if (source) parts.push(source);
    if (tail) parts.push(tail);
    return parts.join(" · ");
  }

  function wireWizard() {
    const sheet = wzField("goal-sheet");
    if (!sheet) return;
    const fab = wzField("fab-new-goal");
    if (fab) fab.addEventListener("click", () => openWizard(""));
    const next = wzField("wz-next");
    if (next) next.addEventListener("click", wizardNext);
    const back = wzField("wz-back");
    if (back) back.addEventListener("click", () => gotoStep(wizard.step - 1));
    sheet.addEventListener("click", (event) => {
      if (event.target === sheet || event.target.closest("[data-sheet-close]")) closeWizard();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !sheet.hidden) closeWizard();
    });
  }

  /* ---------- 事件 ---------- */

  function handleAction(event) {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    const action = trigger.dataset.action;
    const id = trigger.dataset.id;

    if (action === "sched-prev" || action === "sched-next") {
      const step = action === "sched-prev" ? -1 : 1;
      if (sched.view === "day") {
        sched.day = dayShift(sched.day || api.today(), step);
        sched.weekStart = weekStartOf(sched.day);
        sched.month = sched.day.slice(0, 7);
      } else if (sched.view === "month") {
        sched.month = monthShift(sched.month || api.today().slice(0, 7), step);
      } else {
        const base = sched.weekStart || weekStartOf(api.today());
        sched.weekStart = shiftDate(base, step * 7);
      }
      saveWeek();
      renderSchedule();
      return;
    }

    if (action === "sched-today") {
      sched.weekStart = weekStartOf(api.today());
      sched.day = api.today();
      sched.month = api.today().slice(0, 7);
      saveWeek();
      renderSchedule();
      return;
    }

    if (action === "sched-view") {
      const view = trigger.dataset.view;
      if (view !== "week" && view !== "day" && view !== "month") return;
      sched.view = view;
      if (view === "day" && !sched.day) sched.day = api.today();
      if (view === "month" && !sched.month) sched.month = api.today().slice(0, 7);
      saveView();
      renderSchedule();
      return;
    }

    // 月视图点某一天 → 钻到那一天的日视图
    if (action === "sched-day") {
      sched.day = trigger.dataset.date || api.today();
      sched.weekStart = weekStartOf(sched.day);
      sched.month = sched.day.slice(0, 7);
      sched.view = "day";
      saveView();
      saveWeek();
      renderSchedule();
      return;
    }

    if (action === "tray-drop") {
      api.planTask(trigger.dataset.task, false);
      setSchedStatus("从待安排里拿掉了（它原来的时间安排不受影响）。");
      renderSchedule();
      return;
    }

    if (action === "sched-overdue") {
      rescheduleOverdue(trigger.dataset.id, trigger.dataset.node);
      return;
    }

    if (action === "sched-locked") {
      const goal = api.goal(trigger.dataset.id);
      const blocker = goal ? blockerOf(goal, trigger.dataset.node) : null;
      setSchedStatus(
        blocker
          ? "先重排「" + blocker.title + "」：它过期了还没做，点它的「重排」再往下走。"
          : "前面的任务还没做完，先把它排到后面的时间。"
      );
      renderSchedule();
      return;
    }

    if (action === "sched-seg") {
      sched.seg = trigger.dataset.key || "";
      sched.pick = null;
      sched.note = "";
      sched.warn = "";
      renderSchedule();
      return;
    }

    if (action === "segment-add") {
      addSegment();
      return;
    }

    if (action === "segment-save") {
      saveSegments();
      return;
    }

    if (action === "segment-remove") {
      removeSegment(trigger.dataset.key || sched.seg);
      return;
    }

    if (action === "sched-busy") {
      toggleBusy(trigger.dataset.date, trigger.dataset.slot);
      return;
    }

    if (action === "sched-pick") {
      dropDraft(); // 离开时段面板 = 这次编辑结束，还叠着就不保存
      sched.pick = { goalId: id, nodeId: trigger.dataset.node };
      sched.seg = "";
      sched.note = "";
      renderSchedule();
      return;
    }

    if (action === "sched-clear") {
      clearPicked();
      return;
    }

    if (action === "goal-diagram") {
      toggleGoalDiagram(trigger);
      return;
    }

    if (action === "goal-plan") {
      planGoal(id);
      return;
    }

    if (action === "goal-sync") {
      syncGoal(id);
      return;
    }

    if (action === "sched-replan") {
      if (!api.planSetupDone()) {
        openPlanSetup(replanAll);
        return;
      }
      replanAll();
      return;
    }

    if (action === "sched-undo") {
      undoPlan();
      return;
    }

    if (action === "sched-task") {
      dropDraft();
      sched.task = trigger.dataset.task || "";
      sched.pick = null;
      sched.seg = "";
      sched.note = "";
      renderSchedule();
      return;
    }

    if (action === "sched-task-clear") {
      api.placeTask(sched.task, {});
      sched.task = "";
      setSchedStatus("取消安排了，这条任务不再占日程表的位置。");
      renderSchedule();
      return;
    }

    if (action === "sched-task-close") {
      sched.task = "";
      renderSchedule();
      return;
    }

    if (action === "goal-edit") {
      openWizard(id);
      return;
    }

    if (action === "goal-remove") {
      const goal = api.goal(id);
      if (!goal) return;
      if (!window.confirm("删除目标「" + goal.title + "」？它的任务会一起删掉。")) return;
      api.removeGoal(id, { withTasks: true });
      setStatus("删掉了。");
    }
  }

  function wireGoals() {
    // 日程表和目标列表挂在同一个根上，一次委托就够
    const root = document.getElementById("top") || document.getElementById("goal-board");
    if (root) {
      root.addEventListener("click", handleAction);
      root.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const trigger = event.target.closest("[data-action]");
        if (!trigger) return;
        event.preventDefault();
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }
    wireWizard();
    // Esc 关掉时段面板；这次编辑结束，还叠着就不保存
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !sched.seg) return;
      const sheet = document.getElementById("goal-sheet");
      if (sheet && !sheet.hidden) return; // 向导开着的时候 Esc 归向导
      sched.seg = "";
      if (!dropDraft()) {
        sched.note = "";
        renderSchedule();
      }
    });
    document.addEventListener("spasre:change", function () {
      // 只有草稿里的段被别处删了才丢：点「非空闲」、改任务这些不该动它
      if (sched.draft && sched.draft.some((seg) => !api.segment(seg.key))) {
        sched.draft = null;
        saveDraft();
      }
      renderGoals();
      renderSchedule();
    });
  }

  /* ---------- boot ---------- */

  // 之前排好的节点只有日期、没有时段（那时候一天一段），或者挂在一个已经删掉的段上：
  // 补一次，日程表才是对的。后端的存储可能在页面加载后才被采纳（bootRemote 是异步的），
  // 所以后端上线、数据变化时都再看一眼。
  function ensureScheduled() {
    const loose = api.goals().some((goal) =>
      (goal.nodes || []).some((node) => node.date && !api.segment(node.slot))
    );
    if (loose) planSchedule();
  }

  wireGoals();
  // 上次改了还没保存的那份时间段（存在本地）接着用
  sched.draft = loadDraft();
  sched.view = loadView();
  applySchedFocus();
  ensureScheduled();
  renderGoals();
  renderSchedule();
  document.addEventListener("spasre:change", () => {
    // 目标页改了东西（同步、勾完、编辑目标）这边立刻跟上，不用等轮询
    ensureScheduled();
    renderSchedule();
  });
  document.addEventListener("spasre:backend", (event) => {
    if (event && event.detail && event.detail.online) ensureScheduled();
  });

  window.spasreGoals = {
    version: 1,
    goals: api.goals,
    goal: api.goal,
    plan: localGoalPlan,
    planGoal: planGoal,
    generateNodes: generateNodes,
    outline: outlineText,
    openWizard: openWizard,
    modelPlan: modelGoalPlan,
    skillPlan: skillGoalPlan,
    sanitize: sanitizeNodes,
    layers: topoLayers,
    order: topoOrder,
    acyclic: isAcyclic,
    wrapText: wrapText,
    schedule: planSchedule,
    renderSchedule: renderSchedule,
    render: function () {
      renderGoals();
      renderSchedule();
    },
    status: setStatus,
    editing: function () {
      return state.editingId;
    }
  };
})();
