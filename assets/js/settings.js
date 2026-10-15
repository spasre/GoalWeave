/* 设置页：兴趣标签让 AI 来推——先给一批预设，选了/输了之后接着推 5 个相关的。
   标签本身还是存在 store.settings.interests 里（tasks.js 管），这里只管推荐和交互。 */

(function () {
  "use strict";

  const api = window.spasreTasks;
  if (!api) {
    console.warn("设置页需要 tasks.js 先加载。");
    return;
  }

  // 后端不在、或模型没配好时的兜底：够用就行，别让这块空着
  const LOCAL_PRESET = [
    "编译器与 LLVM", "操作系统", "分布式系统", "数据库原理", "机器学习",
    "前端工程", "网络协议", "算法与数据结构", "密码学", "图形学"
  ];
  const LOCAL_CLUSTERS = [
    ["编译器与 LLVM", "程序分析", "类型系统", "代码生成", "虚拟机与 JIT", "垃圾回收"],
    ["操作系统", "并发与锁", "虚拟内存", "文件系统", "进程调度", "内核开发"],
    ["分布式系统", "一致性协议", "消息队列", "服务网格", "容错与重试", "CAP 理论"],
    ["数据库原理", "查询优化", "索引结构", "事务隔离", "存储引擎", "列式存储"],
    ["机器学习", "深度学习", "强化学习", "模型部署", "数据工程", "向量检索"],
    ["前端工程", "浏览器渲染", "构建工具链", "TypeScript", "无障碍", "性能优化"]
  ];

  const state = { busy: false };
  let lastTagsKey = "";
  let lastSource = "";

  function field(id) {
    return document.getElementById(id);
  }

  function setHint(text) {
    const hint = field("interest-suggest-hint");
    if (hint) hint.textContent = String(text || "");
  }

  function currentTags() {
    const settings = api.settings();
    return Array.isArray(settings.interests) ? settings.interests.slice() : [];
  }

  function localSuggest(mode, tags) {
    const known = new Set(tags);
    const pool = [];
    if (mode === "related" && tags.length > 0) {
      LOCAL_CLUSTERS.forEach((cluster) => {
        if (cluster.some((item) => tags.some((tag) => item.includes(tag) || tag.includes(item)))) {
          cluster.forEach((item) => pool.push(item));
        }
      });
    }
    if (pool.length === 0) LOCAL_PRESET.forEach((item) => pool.push(item));
    const picked = [];
    pool.forEach((item) => {
      if (picked.length >= 5 || known.has(item) || picked.includes(item)) return;
      picked.push(item);
    });
    return picked;
  }

  function backendBridge() {
    return window.spasreBackend && typeof window.spasreBackend.run === "function" ? window.spasreBackend : null;
  }

  async function suggest(mode) {
    if (state.busy) return;
    state.busy = true;
    const refresh = field("interest-refresh");
    if (refresh) refresh.disabled = true;
    setHint(mode === "related" ? "AI 正在找相关的标签…" : "AI 正在推荐标签…");
    const tags = currentTags();

    let result = null;
    const bridge = backendBridge();
    if (bridge) {
      try {
        const payload = await bridge.run("interest.suggest", { mode: mode, tags: tags, limit: 5 });
        const info = (payload && payload.result) || {};
        if (info.ok && Array.isArray(info.tags) && info.tags.length > 0) result = info;
      } catch (error) {
        result = null; // 后端不通就退回本地那份
      }
    }
    if (!result) result = { tags: localSuggest(mode, tags), source: "local" };
    lastSource = result.source;
    renderSuggestions(result.tags, result.source, mode);
    state.busy = false;
    if (refresh) refresh.disabled = false;
  }

  function renderSuggestions(tags, source, mode) {
    const box = field("interest-suggest-tags");
    if (!box) return;
    box.replaceChildren();
    const known = new Set(currentTags());
    const fresh = (tags || []).filter((tag) => !known.has(tag));
    if (fresh.length === 0) {
      setHint("没有新的可推了，点「换一批」或者自己加一个。");
      return;
    }
    fresh.forEach((tag) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "interest-tag is-suggest";
      button.textContent = "+ " + tag;
      button.title = "加进兴趣标签";
      button.addEventListener("click", () => {
        addTag(tag);
      });
      box.append(button);
    });
    setHint("猜你感兴趣");
    const head = field("interest-suggest-hint");
    if (head) head.title = source === "model" ? "AI 推荐" : "本地词库兜底";
  }

  function addTag(tag) {
    const name = String(tag || "").trim();
    if (!name) return;
    const list = currentTags();
    if (list.includes(name)) return;
    api.updateSettings({ interests: list.concat([name]) });
  }

  function refreshOnTagsChanged() {
    // 标签真变了才重推；renderAll 会频繁广播，靠这个 key 挡住重复请求
    const key = currentTags().join("|");
    if (key === lastTagsKey) return;
    lastTagsKey = key;
    suggest(key ? "related" : "preset");
  }

  const refreshButton = field("interest-refresh");
  if (refreshButton) {
    refreshButton.addEventListener("click", () => {
      const tags = currentTags();
      suggest(tags.length > 0 ? "related" : "preset");
    });
  }

  document.addEventListener("spasre:change", refreshOnTagsChanged);

  // 页面常常比后端先起来：那一次只能退回本地词库，后端探活了就再问一遍模型
  document.addEventListener("spasre:backend", (event) => {
    if (!event || !event.detail || !event.detail.online) return;
    if (lastSource === "model") return;
    suggest(currentTags().length > 0 ? "related" : "preset");
  });

  lastTagsKey = currentTags().join("|");
  suggest(lastTagsKey ? "related" : "preset");

  /* ---------- 清空数据：把「确认清空数据」打一遍才放行，清完回首页走引导 ---------- */

  const WIPE_WORD = "确认清空数据";

  function note(text) {
    const p = document.createElement("p");
    p.className = "task-hint";
    p.textContent = text;
    return p;
  }

  function actionButton(text, cls, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = cls || "task-action";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function openWipeSheet() {
    const sheet = api.openSheet("清空数据");
    sheet.body.append(
      note("会把任务、回收站、长期目标与知识点、日程、聊天记录、兴趣标签、每日推荐全部删掉，后端那份也一起清 —— 这一步没法撤销。"),
      note("助手里的接口地址和密钥（本机 .env）会留着，那是配置不是数据。清完会重新走一遍新用户引导。"),
      note("想继续，就把这句话原样打一遍：" + WIPE_WORD)
    );

    const field = document.createElement("label");
    field.className = "task-field";
    const caption = document.createElement("span");
    caption.textContent = "确认文字";
    const input = document.createElement("input");
    input.className = "task-input";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = WIPE_WORD;
    field.append(caption, input);
    sheet.body.append(field);

    const status = document.createElement("p");
    status.className = "task-hint";
    status.setAttribute("role", "status");

    const confirm = actionButton("清空数据", "task-action task-action-danger", wipe);
    confirm.disabled = true;
    const foot = document.createElement("div");
    foot.className = "task-actions-cell";
    foot.append(actionButton("取消", "task-action", () => sheet.close()), confirm);
    sheet.body.append(status, foot);

    input.addEventListener("input", () => {
      confirm.disabled = input.value.trim() !== WIPE_WORD;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return; // 中文输入法组字时的回车不算
      event.preventDefault();
      if (!confirm.disabled) wipe();
    });
    input.focus();

    async function wipe() {
      confirm.disabled = true;
      confirm.textContent = "正在清空…";
      status.textContent = "清空之后会跳到首页，重新走一遍新用户引导。";
      try {
        await api.resetData();
      } catch (error) {
        status.textContent = "清空没成功，再试一次：" + (error && error.message ? error.message : error);
        confirm.textContent = "清空数据";
        confirm.disabled = input.value.trim() !== WIPE_WORD;
        return;
      }
      // 清空已经推给后端了（resetData 里 flush 过），可以直接跳
      window.location.href = "index.html";
    }
  }

  const wipeButton = field("wipe-data");
  if (wipeButton) wipeButton.addEventListener("click", openWipeSheet);

})();
