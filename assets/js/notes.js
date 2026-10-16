/* 笔记页：左边分类、中间列表、右边编辑。
   数据挂在 window.spasreTasks 的那一份 store 上（跟其它页面共用，后端照样同步）。 */
(function () {
  "use strict";

  const api = window.spasreTasks;
  if (!api) {
    console.warn("笔记页需要 tasks.js 先加载。");
    return;
  }

  const NEW_CATEGORY = "__new__";
  const state = { category: "all", id: "", timer: 0 };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function chip(text, className) {
    return el("span", "task-chip " + (className || ""), text);
  }

  function setStatus(text) {
    const node = document.getElementById("notes-status");
    if (node) node.textContent = String(text || "");
  }

  function cut(text, length) {
    const value = String(text || "");
    return value.length > length ? value.slice(0, length) + "…" : value;
  }

  /* ---------- 数据 ---------- */

  function allTasks() {
    return api.list({ includeTrash: true });
  }

  function allGoals() {
    return typeof api.goals === "function" ? api.goals() : [];
  }

  // 这篇笔记挂在什么上面
  function linkedLabel(note) {
    if (note.taskId) {
      const task = allTasks().find((item) => item.id === note.taskId);
      return task ? "任务：" + cut(task.title, 16) : "任务已经删了";
    }
    if (note.nodeId) {
      const goal = allGoals().find((item) => item.id === note.goalId);
      const node = goal ? (goal.nodes || []).find((item) => item.id === note.nodeId) : null;
      if (node && goal) return cut(goal.title, 10) + "：" + node.title;
      return "知识点：" + note.nodeId;
    }
    return "";
  }

  function categoryKey(note) {
    return String((note && note.category) || "").trim() || "随手记";
  }

  function visibleNotes() {
    return api.notes().filter((note) => state.category === "all" || categoryKey(note) === state.category);
  }

  /* ---------- 左：分类 ---------- */

  function renderCats() {
    const box = document.getElementById("notes-cats");
    if (!box) return;
    box.replaceChildren();
    const notes = api.notes();
    const rows = [{ key: "all", name: "全部", count: notes.length }].concat(
      api.noteCategories().map((name) => ({ key: name, name: name, count: notes.filter((note) => categoryKey(note) === name).length }))
    );
    box.append(el("p", "notes-cats-title", "分类"));
    rows.forEach((row) => {
      const button = el("button", "notes-cat" + (row.key === state.category ? " is-on" : ""), row.name);
      button.type = "button";
      button.dataset.cat = row.key;
      button.append(el("span", "notes-cat-count", String(row.count)));
      box.append(button);
    });
  }

  /* ---------- 中：列表 ---------- */

  function renderList() {
    const box = document.getElementById("notes-list");
    if (!box) return;
    box.replaceChildren();
    const rows = visibleNotes();
    if (rows.length === 0) {
      box.append(el("p", "task-hint", state.category === "all" ? "还没有笔记，点右上角「新建笔记」。" : "这个分类下还没有笔记。"));
      return;
    }
    rows.forEach((note) => {
      const card = el("button", "note-card" + (note.id === state.id ? " is-on" : ""));
      card.type = "button";
      card.dataset.note = note.id;
      card.append(el("strong", "note-card-title", note.title || "无标题"));
      const meta = el("div", "note-card-meta");
      meta.append(chip(categoryKey(note), "chip-category cat-1"));
      const linked = linkedLabel(note);
      if (linked) meta.append(chip(linked, "chip-slot"));
      meta.append(chip(stampText(note.updatedAt) || "刚建的", "chip-date"));
      card.append(meta);      if (note.body) card.append(el("p", "note-card-body", cut(note.body.replace(/\s+/g, " "), 60)));
      box.append(card);
    });
  }

  /* ---------- 右：编辑 ---------- */

  // 防抖里攒着的改动：连着改好几个字段时得合起来一起存，别互相顶掉
  function saveSoon(patch) {
    if (!state.id) return;
    state.pending = Object.assign(state.pending || {}, patch);
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(flushPending, 600);
  }

  function flushPending() {
    if (state.timer) {
      window.clearTimeout(state.timer);
      state.timer = 0;
    }
    const pending = state.pending || null;
    state.pending = null;
    if (!pending || !state.id) return;
    api.updateNote(state.id, pending);
    renderCats();
    renderList();
  }

  // 存的是 ISO（UTC），显示按本机时间，免得差 8 小时
  function stampText(iso, withTime) {
    const date = new Date(String(iso || ""));
    if (isNaN(date.getTime())) return "";
    const pad = (value) => String(value).padStart(2, "0");
    const day = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
    return withTime ? day + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) : day;
  }

  function field(label, control) {
    const wrap = el("label", "task-field task-field-wide");
    wrap.append(el("span", null, label), control);
    return wrap;
  }

  function renderEditor() {
    const box = document.getElementById("notes-editor");
    if (!box) return;
    const note = state.id ? api.note(state.id) : null;
    box.replaceChildren();
    if (!note) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    const head = el("div", "notes-editor-head");
    const title = document.createElement("input");
    title.className = "task-input notes-title";
    title.type = "text";
    title.value = note.title || "";
    title.placeholder = "标题";
    title.addEventListener("input", () => {
      note.title = title.value;
      saveSoon({ title: title.value });
    });
    const remove = el("button", "task-action task-action-danger", "删除");
    remove.type = "button";
    remove.addEventListener("click", () => {
      if (!window.confirm("删掉这篇笔记？")) return;
      api.removeNote(state.id);
      state.id = "";
      setStatus("删掉了那篇笔记。");
      renderCats();
      renderList();
      renderEditor();
    });
    head.append(title, remove);
    box.append(head);

    const meta = el("div", "notes-editor-meta");
    meta.append(chip(categoryKey(note), "chip-category cat-1"));
    const linked = linkedLabel(note);
    if (linked) meta.append(chip(linked, "chip-slot"));
    meta.append(chip("改于 " + stampText(note.updatedAt, true), "chip-date"));
    box.append(meta);

    // 分类：下拉里是现有分类，最后一项是「新建分类」，选它就展开一个输入框
    const catSelect = document.createElement("select");
    catSelect.className = "task-select";
    api.noteCategories().forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      catSelect.append(option);
    });
    const newOption = document.createElement("option");
    newOption.value = NEW_CATEGORY;
    newOption.textContent = "＋ 新建分类…";
    catSelect.append(newOption);
    catSelect.value = api.noteCategories().indexOf(categoryKey(note)) >= 0 ? categoryKey(note) : NEW_CATEGORY;
    const catInput = document.createElement("input");
    catInput.className = "task-input";
    catInput.type = "text";
    catInput.placeholder = "新分类名";
    catInput.hidden = catSelect.value !== NEW_CATEGORY;
    catSelect.addEventListener("change", () => {
      if (catSelect.value === NEW_CATEGORY) {
        catField.hidden = false;
        catInput.focus();
        return;
      }
      catField.hidden = true;
      api.updateNote(state.id, { category: catSelect.value });
      renderCats();
      renderList();
      renderEditor();
    });
    catInput.addEventListener("change", () => {
      const name = api.addNoteCategory(catInput.value);
      if (!name) return;
      api.updateNote(state.id, { category: name });
      setStatus("分类「" + name + "」建好了。");
      renderCats();
      renderList();
      renderEditor();
    });

    // 关联任务：这条笔记挂到哪个任务上
    const taskSelect = document.createElement("select");
    taskSelect.className = "task-select";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "不关联任务";
    taskSelect.append(none);
    allTasks().forEach((task) => {
      const option = document.createElement("option");
      option.value = task.id;
      option.textContent = cut(task.title, 28);
      taskSelect.append(option);
    });
    taskSelect.value = note.taskId || "";
    taskSelect.addEventListener("change", () => {
      api.updateNote(state.id, { taskId: taskSelect.value });
      renderList();
      renderEditor();
    });

    const grid = el("div", "notes-editor-fields");
    const catField = field("新分类", catInput);
    catField.hidden = catSelect.value !== NEW_CATEGORY;
    grid.append(field("分类", catSelect), catField, field("关联任务", taskSelect));
    box.append(grid);

    const body = document.createElement("textarea");
    body.className = "task-textarea notes-body";
    body.rows = 12;
    body.placeholder = "随手写：卡在哪、结论是什么、下次从哪继续…";
    body.value = note.body || "";
    body.addEventListener("input", () => saveSoon({ body: body.value }));
    box.append(body);
  }

  /* ---------- 动作 ---------- */

  function newNote(seed) {
    const note = api.addNote(Object.assign({ title: "新笔记", category: state.category === "all" ? "随手记" : state.category }, seed || {}));
    state.id = note.id;
    setStatus("新建了一篇空白笔记。");
    renderCats();
    renderList();
    renderEditor();
    const title = document.querySelector(".notes-title");
    if (title) title.focus();
    return note;
  }

  function pickFromUrl() {
    const query = new URLSearchParams(window.location.search);
    const id = query.get("note") || "";
    if (id && api.note(id)) return id;
    // 从单独打开的路线图点「笔记」过来的：按知识点找，没有就新建一篇
    const nodeId = query.get("node") || "";
    if (nodeId) {
      const hit = api.notes().find((note) => note.nodeId === nodeId);
      if (hit) return hit.id;
      const title = query.get("title") || "新笔记";
      return api.addNote({ title: cut(title, 60), nodeId: nodeId, category: "随手记" }).id;
    }
    return "";
  }

  function wire() {
    const fab = document.getElementById("fab-new-note");
    if (fab) fab.addEventListener("click", () => newNote());
    const newButton = document.getElementById("note-new");
    if (newButton) newButton.addEventListener("click", () => newNote());
    const newCat = document.getElementById("note-new-cat");
    if (newCat) {
      newCat.addEventListener("click", () => {
        const name = window.prompt("新分类叫什么？");
        if (!name) return;
        const key = api.addNoteCategory(name);
        if (!key) return;
        state.category = key;
        setStatus("分类「" + key + "」建好了。");
        renderCats();
        renderList();
      });
    }
    const cats = document.getElementById("notes-cats");
    if (cats) {
      cats.addEventListener("click", (event) => {
        const button = event.target.closest("[data-cat]");
        if (!button) return;
        state.category = button.dataset.cat;
        renderCats();
        renderList();
      });
    }
    const list = document.getElementById("notes-list");
    if (list) {
      list.addEventListener("click", (event) => {
        const card = event.target.closest("[data-note]");
        if (!card) return;
        flushPending(); // 上一篇里还没落盘的改动先存掉
        state.id = card.dataset.note;
        renderList();
        renderEditor();
      });
    }
    window.addEventListener("beforeunload", () => {
      // 防抖里还压着一次改动：直接写进去，别等那 600ms
      flushPending();
      if (api.flush) api.flush();
    });
  }

  function boot() {
    wire();
    if (api.onboarded && !api.onboarded()) api.markOnboarded && api.markOnboarded();
    const picked = pickFromUrl();
    state.id = picked || (api.notes()[0] ? api.notes()[0].id : "");
    renderCats();
    renderList();
    renderEditor();
    document.addEventListener("spasre:change", () => {
      // 别处改了数据（比如轮询拉到新的一份）：列表跟着重画
      renderCats();
      renderList();
    });
  }

  boot();
})();
