(function () {
  "use strict";

  const STORE_KEY = "spasre-tasks-v1";
  // 本地改了还没写进后端的记号（值是那次改动的时间）
  const DIRTY_KEY = "spasre-tasks-dirty";
  const DAILY_CATEGORY = "每日推荐";
  const DEFAULT_CATEGORIES = ["学习", "工作", "生活", "每日推荐"];
  // 新建任务里「分类」下拉框的最后一项：选了它就展开一个输入框填新分类名
  const NEW_CATEGORY = "__new__";
  const URGENCY_KEYS = ["urgent", "high", "normal", "low"];
  const URGENCY_LABEL = { urgent: "紧急", high: "重要", normal: "普通", low: "不急" };
  const URGENCY_WEIGHT = { urgent: 0, high: 1, normal: 2, low: 3 };
  const BUCKETS = [
    ["overdue", "已逾期"],
    ["today", "今天"],
    ["tomorrow", "明天"],
    ["week", "本周内"],
    ["later", "以后"],
    ["someday", "未排期"]
  ];
  const DAILY_LIMIT = 200;
  const KNOWLEDGE_POINTS = [
    "复习 LLVM IR 的 SSA 形式与 phi 节点",
    "读一段 Clang 诊断（Diagnostic）实现，理清告警触发链路",
    "弄懂 provenance 指针溯源如何支撑更激进的优化",
    "复习 GDB 观察点（watchpoint）与条件断点用法",
    "整理 C++ 未定义行为（UB）的常见来源",
    "了解 LLVM Pass Manager 的分层与执行顺序",
    "读一个优化 pass 的源码（如 InstCombine）",
    "复习 ABI 与调用约定对代码生成的影响",
    "了解 -O2 下常见的指令折叠与合法化流程",
    "复习 DTS（Diagnostic Test Suite）用例的写法",
    "弄懂 -Werror 下版本升级的告警对齐思路",
    "复习寄存器分配与指令选择的基本流程"
  ];
  const LINK_LIMIT = 3;
  // 延伸阅读得靠后端调模型：后端没在跑时统一给这句，别让人对着「连不上后端（/api/…）」发呆
  const NO_BACKEND_NOTE = "本机后端没在跑 —— 延伸阅读要靠它调模型，起一下 serve.ps1 再点。";
  const CHAT_LIMIT = 40;
  const DAILY_SEEN_LIMIT = 40;
  const DEFAULT_SETTINGS = {
    defaultCategory: "学习",
    dailyRecommendation: true,
    // 每日推荐要不要统一排进日程表（默认不排：想让它占个时间段就勾上）
    dailyAutoSchedule: false,
    // 第一次排期之前那套「先定时间段、再划非空闲」的引导走完没走完
    planSetupDone: false,
    interests: [],
    // 「每日推荐」自己记下的方向（用户没挑够时用），界面里跟用户自己挑的颜色不一样
    autoInterests: [],
    // 随机推的时候推到哪个方向了（interests 为空时按这个轮换）
    dailyDirection: 0,
    // 新用户引导走完没走完
    onboarded: false,
    agentBaseUrl: "",
    agentModel: "",
    agentApiKey: "",
    agentRememberKey: true,
    agentEndpoint: "",
    agentSetupDone: false,
    agentVerifiedAt: "",
    agentPasswordHash: "",
    agentPasswordSalt: ""
  };
  // 一天分成的几段：默认四段，首页日程表上点行首标签就能改时间、加段（一段接一段、不能重叠）
  const DEFAULT_SEGMENTS = [
    { key: "morning", start: "07:00", end: "09:00" },
    { key: "forenoon", start: "09:00", end: "12:00" },
    { key: "afternoon", start: "14:00", end: "17:30" },
    { key: "evening", start: "19:30", end: "22:30" }
  ];
  const SEGMENT_LIMIT = 8;

  function clockMinutes(text) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
    if (!match) return -1;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return -1;
    return hours * 60 + minutes;
  }

  function clockText(minutes) {
    const value = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
    return String(Math.floor(value / 60)).padStart(2, "0") + ":" + String(value % 60).padStart(2, "0");
  }

  // 时间对不上、叠在一起的段直接丢掉；一个都不剩就用默认那四段
  function cleanSegments(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const valid = [];
    list.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const start = clockMinutes(item.start);
      const end = clockMinutes(item.end);
      if (start < 0 || end < 0 || end <= start) return;
      // 没给 key 的（新加的一段）编一个不撞车的：撞上了上面的查重会把这行整条丢掉
      let key = String(item.key || "").trim();
      if (!key) {
        let serial = index + 1;
        while (valid.some((seg) => seg.key === "seg" + serial)) serial += 1;
        key = "seg" + serial;
      }
      if (valid.some((seg) => seg.key === key)) return;
      valid.push({
        key: key,
        start: clockText(start),
        end: clockText(end)
      });
    });
    valid.sort((a, b) => clockMinutes(a.start) - clockMinutes(b.start));
    const kept = [];
    valid.forEach((seg) => {
      const last = kept[kept.length - 1];
      if (last && clockMinutes(seg.start) < clockMinutes(last.end)) return;
      kept.push(seg);
    });
    if (kept.length === 0) return DEFAULT_SEGMENTS.map((seg) => Object.assign({}, seg));
    return kept.slice(0, SEGMENT_LIMIT);
  }

  // 提示里怎么称呼一段：时间填全了就报时间，没填全才退回「第 N 段」
  function segmentName(item, index) {
    const start = clockMinutes(item && item.start);
    const end = clockMinutes(item && item.end);
    if (start >= 0 && end >= 0) return clockText(start) + "–" + clockText(end);
    return "第 " + (index + 1) + " 段";
  }

  // 存之前先挑毛病：时间要填完整、结束晚于开始、一段接一段不能叠。
  // 只挑毛病不动数据，前端拿它决定「这次改动能不能落盘」。
  function segmentProblem(list) {
    const rows = Array.isArray(list) ? list : [];
    if (rows.length === 0) return "至少要留一段。";
    for (let index = 0; index < rows.length; index += 1) {
      const item = rows[index] || {};
      const name = segmentName(item, index);
      const start = clockMinutes(item.start);
      const end = clockMinutes(item.end);
      if (start < 0 || end < 0) return name + "的时间没填完整。";
      if (end <= start) return name + "的结束要晚于开始。";
      const prev = rows[index - 1];
      if (prev) {
        const prevEnd = clockMinutes(prev.end);
        if (prevEnd < 0) continue;
        if (start < prevEnd) return "时间段有冲突";
      }
    }
    return "";
  }

  // 哪些段跟上一段叠了（两边都算），网格上拿它把那几行标红
  function clashKeys(list) {
    const rows = Array.isArray(list) ? list : [];
    const keys = [];
    for (let index = 1; index < rows.length; index += 1) {
      const prev = rows[index - 1] || {};
      const item = rows[index] || {};
      const prevEnd = clockMinutes(prev.end);
      const start = clockMinutes(item.start);
      if (prevEnd < 0 || start < 0) continue;
      if (start < prevEnd) {
        if (prev.key) keys.push(prev.key);
        if (item.key) keys.push(item.key);
      }
    }
    return keys;
  }

  const AGENT_KEY_STORAGE = "spasre-agent-key";
  const AGENT_TIMEOUT = 60000;
  const AGENT_PBKDF2_ROUNDS = 150000;
  const AGENT_ENV_FILE = "spasre-agent.env";
  const AGENT_PASSWORD_MIN = 4;

  const DOG_ICON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">' +
    '<path d="M6.6 3.7 4.1 6.4c-.4.5-.6 1.1-.4 1.7l1 2.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M17.4 3.7l2.5 2.7c.4.5.6 1.1.4 1.7l-1 2.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M12 4.6c3.5 0 6.3 2.6 6.3 6.2 0 3.8-2.8 6.8-6.3 6.8s-6.3-3-6.3-6.8c0-3.6 2.8-6.2 6.3-6.2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
    '<circle cx="9.7" cy="10.4" r="1" fill="currentColor"/>' +
    '<circle cx="14.3" cy="10.4" r="1" fill="currentColor"/>' +
    '<path d="M12 12.8c-.8 0-1.4.5-1.4 1.1 0 .6.6 1.1 1.4 1.1s1.4-.5 1.4-1.1c0-.6-.6-1.1-1.4-1.1Z" fill="currentColor"/>' +
    "</svg>";

  const state = {
    board: { view: "active", category: "all", urgency: "all", scope: "all", editingId: "" },
    agent: { unlocked: false, gate: "" },
    remote: { on: false, rev: 0 }
  };

  // 看板上的筛选（页签 / 分类 / 紧急度 / 时间范围）存在本地，刷新之后还是你挑的那样
  const BOARD_VIEW_KEY = "spasre-board-view";

  function saveBoardView() {
    try {
      window.localStorage.setItem(
        BOARD_VIEW_KEY,
        JSON.stringify({ view: state.board.view, category: state.board.category, urgency: state.board.urgency, scope: state.board.scope })
      );
    } catch (error) {
      // 隐私模式之类存不了就算了
    }
  }

  function loadBoardView() {
    let saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(BOARD_VIEW_KEY) || "null");
    } catch (error) {
      saved = null;
    }
    if (!saved || typeof saved !== "object") return;
    if (saved.view === "active" || saved.view === "trash") state.board.view = saved.view;
    if (typeof saved.category === "string") state.board.category = saved.category;
    if (typeof saved.urgency === "string") state.board.urgency = saved.urgency;
    if (typeof saved.scope === "string") state.board.scope = saved.scope;
  }

  let store = load();

  // 清空看板：任务 / 回收站 / 目标 / 日程 / 聊天 / 兴趣 / 设置全回到出厂状态，回到「新用户」，
  // 下次打开页面引导会重新弹（onboarded 又变回 false）。
  // 助手配置（本机 .env 里那份接口地址和密钥）不动 —— 那是配置不是数据，
  // 清完 backend.js 会把后端存着的配置拉回设置里。
  async function resetData() {
    [
      STORE_KEY,               // 本地兜底那份看板
      "spasre-sched-draft",    // 时间段改了没保存的草稿（goals.js）
      "spasre-sched-week",     // 日程表在看哪一周（goals.js）
      BOARD_VIEW_KEY           // 任务页的筛选（本文件）
    ].forEach((key) => {
      try {
        window.localStorage.removeItem(key);
      } catch (error) {
        // 存不进去就算了，别让清空失败
      }
    });
    store = emptyStore();
    state.board = { view: "active", category: "all", urgency: "all", scope: "all", editingId: "" };
    save();
    renderAll();
    await flushRemote();       // 后端那份也得清掉，否则刷新之后又拉回来了
    return true;
  }

  /* ---------- 后端存储：所有浏览器共用同一份 ---------- */

  let remoteSaveTimer = 0;

  function queueRemoteSave() {
    if (remoteSaveTimer) window.clearTimeout(remoteSaveTimer);
    remoteSaveTimer = window.setTimeout(() => {
      remoteSaveTimer = 0;
      pushRemote().catch(() => {});
    }, 400);
  }

  // 马上推一次（别等那 400ms 防抖）：要跳走 / 关页面之前用，否则这次改动可能还没到后端，
  // 新页面打开时又会按后端那份（旧的）走，等于白改。
  async function flushRemote() {
    if (remoteSaveTimer) {
      window.clearTimeout(remoteSaveTimer);
      remoteSaveTimer = 0;
    }
    if (!state.remote.on) return false;
    try {
      return await pushRemote();
    } catch (error) {
      return false;
    }
  }

  async function pushRemote(tries) {
    const response = await fetch("/api/data", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store: store })
    });
    const data = await response.json().catch(() => null);
    if (data && typeof data.rev === "number") {
      state.remote.rev = data.rev;
      markClean();
      return true;
    }
    // 后端偶尔写不进去（Windows 上文件被别的东西占住会报 WinError 5 / 13）：
    // 等一下再试两次；真不行就留着 dirty 记号，下次改动或下次开页面再补
    if ((tries || 0) < 2) {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      return pushRemote((tries || 0) + 1);
    }
    console.warn("数据没能存到后端，留着本地这份，下次开页面会再补。");
    return false;
  }

  async function fetchRemote() {
    const response = await fetch("/api/data");
    const data = await response.json().catch(() => null);
    return data && data.ok ? data : null;
  }

  // 后端在的时候数据以后端为准；本地那份还没推上去（或者比后端新）就以本地为准；后端还没有数据就推上去
  async function bootRemote() {
    let data = null;
    try {
      data = await fetchRemote();
    } catch (error) {
      return; // 后端不在（例如 -Static 起的纯静态服务），继续用本地那份
    }
    if (!data) return;
    state.remote.on = true;
    state.remote.rev = data.rev;
    if (data.store) {
      if (preferLocal(data)) {
        await pushRemote();
        return;
      }
      // 后端有数据就以它为准，本地那份兜底副本也跟着更新
      store = normalizeStore(data.store);
      writeLocal();
      if (dirtyStamp() && dirtyStamp() <= String(data.updatedAt || "")) markClean();
      renderAll();
      return;
    }
    if (store.tasks.length + store.trash.length + store.goals.length > 0) await pushRemote();
  }

  // 别的浏览器改了数据就跟着换，保证大家看到的是一样的
  async function pollRemote() {
    if (!state.remote.on) {
      // 第一次没连上就接着试（后端可能比页面晚起来）
      await bootRemote();
      return;
    }
    let data = null;
    try {
      data = await fetchRemote();
    } catch (error) {
      return;
    }
    if (!data || data.rev <= state.remote.rev) return;
    // 本地还有没写上去的改动、而且比后端那份新：先把本地推上去，别被旧的盖回来
    if (preferLocal(data)) {
      await pushRemote();
      return;
    }
    state.remote.rev = data.rev;
    store = normalizeStore(data.store);
    writeLocal();
    if (dirtyStamp() && dirtyStamp() <= String(data.updatedAt || "")) markClean();
    renderAll();
  }

  /* ---------- storage ---------- */

  function emptyStore() {
    return {
      tasks: [],
      trash: [],
      goals: [],
      notes: [],
      settings:Object.assign({}, DEFAULT_SETTINGS, { segments: cleanSegments(null) }),
      meta: { categories: [], noteCategories: [], dailyServedOn: "" },
      chat: [],
      dailySeen: [],
      daily: null,
      // busy 是「具体某天」的非空闲段（老数据），busyWeekly 是「每周这一天」的（默认口径），两者都算忙
      schedule: { busy: [], busyWeekly: [] }
    };
  }

  // 日程表：segments() 一天切成几段（存在设置里，设置页能改），busy 放用户划掉的「非空闲」段（"日期:段"）
  function segments() {
    return cleanSegments(store.settings && store.settings.segments);
  }

  function segmentOf(key) {
    return segments().find((item) => item.key === key) || null;
  }

  function segmentMinutesTotal(seg) {
    return clockMinutes(seg.end) - clockMinutes(seg.start);
  }

  function segmentMinutes(key) {
    const seg = segmentOf(key);
    return seg ? segmentMinutesTotal(seg) : 0;
  }

  // 排期偏好：从晚到早（晚上 → 下午 → 上午 → 早上），段是按时间排好序的，反过来就是
  function segmentOrder() {
    return segments().map((item, index) => index).reverse();
  }

  // 段被改短之后按段长显示；下次改期时存的值会跟着收紧
  function slotHours(key, hours) {
    const limit = Math.round((segmentMinutes(key) / 60) * 2) / 2;
    const value = Math.max(0.5, Number(hours) || 0.5);
    return limit > 0 ? Math.min(value, limit) : value;
  }

  // 这一段过去了没：拿「日期 + 段的结束时刻」跟现在比。
  // 判到结束而不是开始，正在上的这一段还能用。
  function slotPassed(date, key) {
    const seg = segmentOf(key);
    if (!seg || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return false;
    const end = new Date(String(date) + "T" + seg.end + ":00");
    if (isNaN(end.getTime())) return false;
    return end.getTime() <= Date.now();
  }

  // 过期没做的知识点：排过时间、时间过去了、但没勾完成。key 是 "目标id/节点id"
  function overdueNodes() {
    const keys = new Set();
    (store.goals || []).forEach((goal) => {
      (goal.nodes || []).forEach((node) => {
        if (node.done || !node.date || !node.slot) return;
        if (slotPassed(node.date, node.slot)) keys.add(nodeKey(goal.id, node.id));
      });
    });
    return keys;
  }

  // 被「过期没做」的前置挡住的节点：顺着依赖往下蔓延，这些先别做
  function lockedNodes() {
    const overdue = overdueNodes();
    const locked = new Set();
    (store.goals || []).forEach((goal) => {
      const nodes = goal.nodes || [];
      const blocked = new Set(nodes.filter((node) => overdue.has(nodeKey(goal.id, node.id))).map((node) => node.id));
      if (blocked.size === 0) return;
      let grew = true;
      while (grew) {
        grew = false;
        nodes.forEach((node) => {
          if (blocked.has(node.id)) return;
          if ((node.deps || []).some((dep) => blocked.has(dep))) {
            blocked.add(node.id);
            grew = true;
          }
        });
      }
      blocked.forEach((id) => {
        if (!overdue.has(nodeKey(goal.id, id))) locked.add(nodeKey(goal.id, id));
      });
    });
    return locked;
  }

  function nodeKey(goalId, nodeId) {
    return String(goalId || "") + "/" + String(nodeId || "");
  }

  // 只挑毛病，不动数据：前端先问一句「这份能存吗」
  function checkSegments(list) {
    return segmentProblem(list);
  }

  // 改时间段：挑出毛病就整份拒绝，返回那句提示；没问题就存下来并返回空字符串
  function setSegments(list) {
    const problem = segmentProblem(list);
    if (problem) return problem;
    const clean = cleanSegments(list);
    if (!store.schedule) store.schedule = { busy: [] };
    const keys = new Set(clean.map((seg) => seg.key));
    store.schedule.busy = busyList().filter((stamp) => keys.has(String(stamp).split(":")[1]));
    updateSettings({ segments: clean });
    return "";
  }

  function slotKey(date, key) {
    return String(date || "") + ":" + String(key || "");
  }

  function busyList() {
    return Array.isArray(store.schedule && store.schedule.busy) ? store.schedule.busy.slice() : [];
  }

  function setBusy(date, key, on) {
    const stamp = slotKey(date, key);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) || !segmentOf(key)) return false;
    const list = busyList().filter((item) => item !== stamp);
    if (on) list.push(stamp);
    if (!store.schedule) store.schedule = { busy: [] };
    store.schedule.busy = list.slice(-400);
    save();
    return true;
  }

  /* ---------- 非空闲：默认「每周一致」 ---------- */

  // 周一 = 1 … 周日 = 7
  function weekdayIndex(date) {
    const time = new Date(String(date) + "T00:00:00");
    if (isNaN(time.getTime())) return 0;
    return time.getDay() === 0 ? 7 : time.getDay();
  }

  function busyWeeklyList() {
    return Array.isArray(store.schedule && store.schedule.busyWeekly) ? store.schedule.busyWeekly.slice() : [];
  }

  function weeklyKey(date, key) {
    return weekdayIndex(date) + ":" + String(key || "");
  }

  // 这一段忙不忙：每周规则 + 具体某天的老数据，都算忙
  function slotBusy(date, key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) || !segmentOf(key)) return false;
    return busyWeeklyList().indexOf(weeklyKey(date, key)) >= 0 || busyList().indexOf(slotKey(date, key)) >= 0;
  }

  // 点一下就按「每周这一天」记/取消，顺手把这一天旧的「具体日期」标记清掉，免得一格两套数据
  function setBusyWeekly(date, key, on) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) || !segmentOf(key)) return false;
    if (!store.schedule) store.schedule = { busy: [], busyWeekly: [] };
    const stamp = weeklyKey(date, key);
    const list = busyWeeklyList().filter((item) => item !== stamp);
    if (on) list.push(stamp);
    store.schedule.busyWeekly = list.slice(-70);
    store.schedule.busy = busyList().filter((item) => item !== slotKey(date, key));
    save();
    return true;
  }

  /* ---------- 任务占一个时段 ---------- */

  // 某一天每段的状态：空不空、谁占着、还剩多少分钟、为什么不能排
  function slotStates(date, options) {
    const opts = options || {};
    const held = new Map();
    const add = (stamp, title, hours) => {
      const row = held.get(stamp) || { titles: [], used: 0 };
      row.titles.push(title);
      row.used += Number(hours) || 0;
      held.set(stamp, row);
    };
    (store.goals || []).forEach((goal) => {
      (goal.nodes || []).forEach((node) => {
        if (node.date !== date || !node.slot || node.done) return;
        add(slotKey(date, node.slot), (goal.title ? goal.title + "：" : "") + node.title, node.hours);
      });
    });
    store.tasks.forEach((task) => {
      // 目标节点铺出来的任务跟着节点算，别重复占时间
      if (task.id === opts.exclude || task.date !== date || !task.slot) return;
      if (task.goalId && task.nodeId) return;
      add(slotKey(date, task.slot), task.title, task.hours);
    });
    return segments().map((seg) => {
      const stamp = slotKey(date, seg.key);
      const row = held.get(stamp);
      const minutes = segmentMinutesTotal(seg);
      const room = Math.max(0, minutes - Math.round(((row ? row.used : 0) * 60)));
      let reason = "";
      if (slotPassed(date, seg.key)) reason = "已经过去了";
      else if (slotBusy(date, seg.key)) reason = "非空闲";
      else if (room <= 0) reason = "这一段排满了";
      return {
        key: seg.key,
        label: seg.start + "–" + seg.end,
        start: seg.start,
        end: seg.end,
        minutes: minutes,
        room: room,
        held: row ? row.titles.join(" / ") : "",
        reason: reason,
        free: !reason
      };
    });
  }

  // 把任务排进日程表（传 slot；不传 slot 就是取消安排）。放不下就原样不动，返回 false
  function placeTask(id, patch) {
    const task = store.tasks.find((item) => item.id === id);
    if (!task) return false;
    const source = patch || {};
    if (!source.slot) {
      delete task.slot;
      delete task.hours;
      save();
      renderAll();
      return true;
    }
    const seg = segmentOf(source.slot);
    if (!seg) return false;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(source.date || "")) ? String(source.date) : task.date || todayKey();
    const room = Math.max(0, segmentMinutesTotal(seg) / 60 - usedHours(date, seg.key, { taskId: task.id }));
    const want = Number(source.hours) > 0 ? Number(source.hours) : Math.min(1, room);
    if (want > room + 0.001) return false;         // 这一格剩下的时间不够，别硬塞
    task.date = date;
    task.slot = seg.key;
    task.hours = Math.max(0.5, Math.min(room, Math.round(want * 2) / 2));
    delete task.planRequested;                      // 排好了就不在「待安排」里了
    save();
    renderAll();
    return true;
  }

  // 这一段已经排了多少小时（不含 exclude 指的那个）
  function usedHours(date, key, exclude) {
    const opts = exclude || {};
    let used = 0;
    (store.goals || []).forEach((goal) => {
      (goal.nodes || []).forEach((node) => {
        if (node.done || node.date !== date || node.slot !== key) return;
        if (opts.goalId === goal.id && opts.nodeId === node.id) return;
        used += Number(node.hours) || 0;
      });
    });
    store.tasks.forEach((task) => {
      if (task.id === opts.taskId || task.date !== date || task.slot !== key) return;
      if (task.goalId && task.nodeId) return;       // 节点自己的镜像任务不算第二遍
      used += Number(task.hours) || 0;
    });
    return used;
  }

  // 「加入日程表」：先标记成待安排，再跳日程表页去挑时间
  function planTask(id, on) {
    const task = store.tasks.find((item) => item.id === id);
    if (!task) return false;
    if (on === false) {
      delete task.planRequested;
    } else {
      task.planRequested = true;
    }
    save();
    renderAll();
    return true;
  }

  // 每日推荐统一进日程表：挑今天还空着、装得下 1 小时的一段（偏好从晚到早，跟排知识点一个习惯）
  function autoPlaceTask(task, date) {
    const open = slotStates(date).filter((item) => item.free && item.room >= 60);
    if (open.length === 0) return false;
    const fitting = open.filter((item) => item.minutes >= 60);
    const pick = fitting.length > 0 ? fitting[fitting.length - 1] : open[open.length - 1];
    task.date = date;
    task.slot = pick.key;
    task.hours = Math.min(1, Math.round((pick.minutes / 60) * 2) / 2);
    return true;
  }

  // 开关：打开时顺手把今天已经生成的那条推荐也排进去（没空位就先不排）
  function setDailyAutoSchedule(on) {
    if (!on) {
      updateSettings({ dailyAutoSchedule: false });
      return false;
    }
    updateSettings({ dailyAutoSchedule: true });
    const today = todayKey();
    const task = store.tasks.find((item) => item.source === "daily" && item.date === today && !item.slot);
    if (task && autoPlaceTask(task, today)) {
      save();
      renderAll();
    }
    return true;
  }

  // 一段里放多久：给「时间点 + 时长」算出收尾时刻，排期和日程表都按这个显示
  function slotTime(key, hours) {
    const seg = segmentOf(key);
    if (!seg) return "";
    const start = String(seg.start);
    const toMinutes = (text) => {
      const parts = String(text || "").split(":");
      return (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0);
    };
    const span = Math.min(segmentMinutesTotal(seg), Math.max(0.5, Number(hours) || 1) * 60);
    const total = toMinutes(seg.start) + span;
    const hh = String(Math.floor(total / 60)).padStart(2, "0");
    const mm = String(Math.round(total % 60)).padStart(2, "0");
    return start + "–" + hh + ":" + mm;
  }

  // 把任意一份数据（本地缓存或后端来的）补成完整的 store
  function normalizeStore(parsed) {
    if (!parsed || typeof parsed !== "object") return emptyStore();
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      trash: Array.isArray(parsed.trash) ? parsed.trash : [],
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
      notes: (Array.isArray(parsed.notes) ? parsed.notes : []).map(cleanNote).filter(Boolean),
      settings: Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {}, {
        segments: cleanSegments(parsed.settings && parsed.settings.segments)
      }),
      meta: {
        categories: Array.isArray(parsed.meta && parsed.meta.categories) ? parsed.meta.categories : [],
        noteCategories: Array.isArray(parsed.meta && parsed.meta.noteCategories)
          ? parsed.meta.noteCategories.map((name) => String(name || "").trim()).filter(Boolean).slice(0, 40)
          : [],
        // 「今天这条每日推荐已经给出去了」的日期。丢了它，刷新一次就会把做完的推荐任务补回来
        dailyServedOn: /^\d{4}-\d{2}-\d{2}$/.test(String((parsed.meta && parsed.meta.dailyServedOn) || ""))
          ? String(parsed.meta.dailyServedOn)
          : ""
      },
      chat: Array.isArray(parsed.chat)
        ? parsed.chat.filter((item) => item && typeof item.text === "string").slice(-CHAT_LIMIT)
        : [],
      dailySeen: Array.isArray(parsed.dailySeen)
        ? parsed.dailySeen.map((item) => String(item || "").trim()).filter(Boolean).slice(-DAILY_SEEN_LIMIT)
        : [],
      daily: parsed.daily && typeof parsed.daily === "object" ? parsed.daily : null,
      schedule: {
        busy: Array.isArray(parsed.schedule && parsed.schedule.busy)
          ? parsed.schedule.busy.map((item) => String(item || "")).filter((item) => /^\d{4}-\d{2}-\d{2}:/.test(item)).slice(-400)
          : [],
        // 「每周这一天」的非空闲（默认口径，形如 "4:evening"）：漏了它，用户划掉的忙时下次打开就没了
        busyWeekly: Array.isArray(parsed.schedule && parsed.schedule.busyWeekly)
          ? parsed.schedule.busyWeekly.map((item) => String(item || "")).filter((item) => /^[1-7]:/.test(item)).slice(-70)
          : []
      }
    };
  }

  function load() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(STORE_KEY);
    } catch (error) {
      console.warn("无法读取本地任务数据，将使用临时数据。", error);
      return emptyStore();
    }
    if (!raw) return emptyStore();
    try {
      return normalizeStore(JSON.parse(raw));
    } catch (error) {
      console.error("任务数据解析失败，已重置。", error);
      return emptyStore();
    }
  }

  function writeLocal() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (error) {
      console.error("无法保存任务数据。", error);
    }
  }

  // 「本地这份还没写进后端」的记号（换页面 / 关标签页都不丢）。
  // 格式跟后端的 updatedAt 一样（本地时间、秒），好直接比大小。
  function nowStamp() {
    const pad = (value) => String(value).padStart(2, "0");
    const now = new Date();
    return (
      now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + "T" +
      pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds())
    );
  }

  function markDirty() {
    try {
      window.localStorage.setItem(DIRTY_KEY, nowStamp());
    } catch (error) {
      /* 隐私模式下写不了就算了 */
    }
  }

  function markClean() {
    try {
      window.localStorage.removeItem(DIRTY_KEY);
    } catch (error) {
      /* 同上 */
    }
  }

  function dirtyStamp() {
    try {
      return window.localStorage.getItem(DIRTY_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  // 后端那份要不要采纳：本地有没推上去的改动，而且比后端那份新 → 反过来把本地推上去。
  // 少了这一条，一次没推成功的改动（比如写盘被占了一下）会在下次开页面时被后端那份旧的盖掉。
  function preferLocal(data) {
    const dirty = dirtyStamp();
    if (!dirty) return false;
    return dirty > String((data && data.updatedAt) || "");
  }

  function save() {
    // 本地留一份兜底副本（后端不在时用得上），后端在跑时以下面这份为准
    writeLocal();
    markDirty();
    if (state.remote.on) queueRemoteSave();
  }

  // 页面要跳走 / 关掉之前：那 400ms 防抖里攒着的改动得赶紧送出去，
  // 不然新页面打开时又会按后端那份（旧的）走，等于白点。
  function flushOnLeave() {
    if (!state.remote.on || !dirtyStamp()) return;
    try {
      const body = JSON.stringify({ store: store });
      if (window.navigator && typeof window.navigator.sendBeacon === "function") {
        window.navigator.sendBeacon("/api/data", new Blob([body], { type: "application/json" }));
        return;
      }
      fetch("/api/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true
      }).catch(() => {});
    } catch (error) {
      /* 尽力而为，推不上去就靠 dirty 记号下次补 */
    }
  }

  /* ---------- agent key ---------- */

  // 勾了「记住密钥」才写进 localStorage；否则只放 sessionStorage，关掉标签页就没了。
  function readAgentKey() {
    try {
      const session = window.sessionStorage.getItem(AGENT_KEY_STORAGE);
      if (session) return session;
    } catch (error) {
      /* 隐私模式下 sessionStorage 可能不可用 */
    }
    return String(store.settings.agentApiKey || "");
  }

  function writeAgentKey(value) {
    const clean = String(value || "").trim();
    store.settings.agentApiKey = store.settings.agentRememberKey ? clean : "";
    save();
    try {
      if (store.settings.agentRememberKey) window.sessionStorage.removeItem(AGENT_KEY_STORAGE);
      else window.sessionStorage.setItem(AGENT_KEY_STORAGE, clean);
    } catch (error) {
      /* 同上 */
    }
  }

  /* ---------- agent password ---------- */

  function subtleCrypto() {
    return window.crypto && window.crypto.subtle ? window.crypto.subtle : null;
  }

  function base64FromBytes(bytes) {
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return window.btoa(binary);
  }

  function bytesFromBase64(text) {
    const binary = window.atob(String(text || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function newSalt() {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return base64FromBytes(bytes);
  }

  // 只存 PBKDF2-SHA256 的派生结果，原文不落盘。纯前端挡不住懂行的人，
  // 但能挡住随手改设置和旁观。
  async function hashPassword(password, saltBase64) {
    const subtle = subtleCrypto();
    if (!subtle) throw new Error("这个浏览器不给用加密接口（需要 https），没法安全地存密码。");
    const material = await subtle.importKey(
      "raw",
      new TextEncoder().encode(String(password)),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await subtle.deriveBits(
      { name: "PBKDF2", salt: bytesFromBase64(saltBase64), iterations: AGENT_PBKDF2_ROUNDS, hash: "SHA-256" },
      material,
      256
    );
    return base64FromBytes(new Uint8Array(bits));
  }

  function hasAgentPassword() {
    return Boolean(store.settings.agentPasswordHash && store.settings.agentPasswordSalt);
  }

  /* ---------- agent env file ---------- */

  function envValue(value) {
    return String(value === undefined || value === null ? "" : value).replace(/[\r\n]+/g, " ").trim();
  }

  function agentEnvText() {
    const settings = store.settings;
    return (
      [
        "# 任务板 · 助手配置",
        "# 里面有密钥，别提交到 git（仓库的 .gitignore 已经忽略 .env）",
        "SPASRE_AGENT_BASE_URL=" + envValue(settings.agentBaseUrl),
        "SPASRE_AGENT_MODEL=" + envValue(settings.agentModel),
        "SPASRE_AGENT_API_KEY=" + envValue(readAgentKey()),
        "SPASRE_AGENT_REMEMBER_KEY=" + (settings.agentRememberKey ? "true" : "false"),
        "SPASRE_AGENT_ENDPOINT=" + envValue(settings.agentEndpoint),
        "SPASRE_AGENT_PASSWORD_HASH=" + envValue(settings.agentPasswordHash),
        "SPASRE_AGENT_PASSWORD_SALT=" + envValue(settings.agentPasswordSalt)
      ].join("\n") + "\n"
    );
  }

  function parseAgentEnv(text) {
    const map = {};
    String(text || "")
      .split(/\r?\n/)
      .forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const at = trimmed.indexOf("=");
        if (at === -1) return;
        const key = trimmed.slice(0, at).trim();
        let value = trimmed.slice(at + 1).trim();
        const quoted =
          (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
        if (quoted && value.length >= 2) value = value.slice(1, -1);
        map[key] = value;
      });
    return map;
  }

  function applyAgentEnv(map) {
    const patch = {};
    if (map.SPASRE_AGENT_BASE_URL !== undefined) patch.agentBaseUrl = map.SPASRE_AGENT_BASE_URL;
    if (map.SPASRE_AGENT_MODEL !== undefined) patch.agentModel = map.SPASRE_AGENT_MODEL;
    if (map.SPASRE_AGENT_ENDPOINT !== undefined) patch.agentEndpoint = map.SPASRE_AGENT_ENDPOINT;
    if (map.SPASRE_AGENT_REMEMBER_KEY !== undefined) patch.agentRememberKey = map.SPASRE_AGENT_REMEMBER_KEY !== "false";
    if (map.SPASRE_AGENT_PASSWORD_HASH !== undefined) patch.agentPasswordHash = map.SPASRE_AGENT_PASSWORD_HASH;
    if (map.SPASRE_AGENT_PASSWORD_SALT !== undefined) patch.agentPasswordSalt = map.SPASRE_AGENT_PASSWORD_SALT;
    const complete = Boolean(patch.agentBaseUrl && patch.agentModel) || Boolean(patch.agentEndpoint);
    if (complete) patch.agentSetupDone = true;
    updateSettings(patch);
    if (map.SPASRE_AGENT_API_KEY !== undefined) writeAgentKey(map.SPASRE_AGENT_API_KEY);
    state.agent.unlocked = false;
    state.agent.gate = "";
    return complete;
  }

  function agentConfigured() {
    const settings = store.settings;
    if (!settings.agentSetupDone) return false;
    const hasModel = Boolean(String(settings.agentBaseUrl || "").trim() && String(settings.agentModel || "").trim());
    return hasModel || Boolean(String(settings.agentEndpoint || "").trim());
  }

  /* ---------- helpers ---------- */

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function todayKey(date) {
    const now = date || new Date();
    return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  }

  function parseDay(key) {
    const parts = String(key).split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function dayDiff(key) {
    return Math.round((parseDay(key) - parseDay(todayKey())) / 86400000);
  }

  function dayOfYear() {
    const now = new Date();
    return Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function categories() {
    const found = [];
    const push = (name) => {
      const clean = String(name || "").trim();
      if (clean && !found.includes(clean)) found.push(clean);
    };
    DEFAULT_CATEGORIES.forEach(push);
    store.meta.categories.forEach(push);
    store.tasks.concat(store.trash).forEach((task) => push(task.category));
    return found;
  }

  function registerCategory(name) {
    const clean = String(name || "").trim();
    if (!clean || DEFAULT_CATEGORIES.includes(clean) || store.meta.categories.includes(clean)) return clean;
    store.meta.categories.push(clean);
    return clean;
  }

  function bucketOf(task) {
    if (!task.date) return "someday";
    const diff = dayDiff(task.date);
    if (diff < 0) return "overdue";
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    if (diff <= 7) return "week";
    return "later";
  }

  function sortTasks(list) {
    return list.slice().sort((a, b) => {
      const bucketA = BUCKETS.findIndex((entry) => entry[0] === bucketOf(a));
      const bucketB = BUCKETS.findIndex((entry) => entry[0] === bucketOf(b));
      if (bucketA !== bucketB) return bucketA - bucketB;
      const weightA = URGENCY_WEIGHT[a.urgency] === undefined ? 2 : URGENCY_WEIGHT[a.urgency];
      const weightB = URGENCY_WEIGHT[b.urgency] === undefined ? 2 : URGENCY_WEIGHT[b.urgency];
      if (weightA !== weightB) return weightA - weightB;
      return String(a.title).localeCompare(String(b.title), "zh-CN");
    });
  }

  function activeTasks(category) {
    const list = store.tasks.filter((task) => !category || category === "all" || task.category === category);
    return sortTasks(list);
  }

  /* ---------- 推荐阅读 ---------- */

  function linkHost(url) {
    const match = String(url || "").match(/^https?:\/\/([^/?#]+)/i);
    return match ? match[1].replace(/^www\./i, "") : "";
  }

  // 英文 tag 按词边界匹配，免得 "ir" 命中 "first" 这种词里的片段；中文直接看包含。
  function tagHit(haystack, tag) {
    if (/^[a-z0-9+#.-]+$/.test(tag)) {
      const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp("(^|[^a-z0-9])" + escaped + "([^a-z0-9]|$)").test(haystack);
    }
    return haystack.includes(tag);
  }


  // 助手给的链接要过一遍：只收 http/https，去重，最多 3 条。
  function normalizeLinks(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((item) => {
      if (!item) return;
      const raw = typeof item === "string" ? { url: item } : item;
      const url = String(raw.url || raw.link || raw.href || "").trim();
      if (!/^https?:\/\/\S+$/i.test(url)) return;
      if (out.some((entry) => entry.url === url)) return;
      const title = String(raw.title || raw.name || "").trim() || linkHost(url) || url;
      out.push({ title: title.slice(0, 120), url: url, source: linkHost(url) });
    });
    return out.slice(0, LINK_LIMIT);
  }

  // 任务自己带链接（助手找的）就用它；没有就让调用方去问助手（见 openLinkDialog）。
  function linksForTask(task) {
    if (!task) return [];
    return normalizeLinks(task.links);
  }

  /* ---------- 延伸阅读：直接让助手找（reading.suggest） ---------- */

  // 让后端的模型找几条：它会顺手真去请求每个地址，打不开的不会回来，所以编的链接骗不过去。
  async function askReadingLinks(title, context) {
    const bridge = window.spasreBackend;
    if (!bridge || typeof bridge.run !== "function" || !bridge.online) {
      return { ok: false, error: NO_BACKEND_NOTE };
    }
    const info = context || {};
    try {
      const payload = await bridge.run("reading.suggest", {
        title: String(title || ""),
        brief: String(info.brief || ""),
        category: String(info.category || ""),
        limit: LINK_LIMIT
      });
      const result = (payload && payload.result) || null;
      if (!result) return { ok: false, error: "后端没回话。" };
      if (!result.ok) return { ok: false, error: String(result.error || "没找着。") };
      return { ok: true, links: normalizeLinks(result.links) };
    } catch (error) {
      // 请求到一半后端没了：再探一次，弹窗里的提示才说得准
      const alive = typeof bridge.available === "function" ? await bridge.available() : false;
      if (!alive) return { ok: false, error: NO_BACKEND_NOTE };
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }

  /* ---------- 推荐阅读弹窗 ---------- */

  let linkDialog = null;
  let linkDialogReturn = null;

  function ensureLinkDialog() {
    if (linkDialog) return linkDialog;

    const overlay = el("div", "task-link-overlay");
    overlay.id = "task-link-dialog";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "task-link-dialog-title");

    const panel = el("div", "task-link-panel");
    const head = el("div", "task-link-head");
    const heading = el("h2", "task-link-dialog-title");
    heading.id = "task-link-dialog-title";
    const close = el("button", "task-link-close", "×");
    close.type = "button";
    close.dataset.role = "link-close";
    close.setAttribute("aria-label", "关闭推荐阅读");
    head.append(heading, close);

    const note = el("p", "task-link-note");
    note.dataset.role = "link-note";
    const list = el("ul", "task-link-list");
    list.dataset.role = "link-list";

    const foot = el("div", "task-link-foot");
    const ask = el("button", "task-action", "让助手找延伸阅读");
    ask.type = "button";
    ask.dataset.role = "link-ask";
    foot.append(ask);

    panel.append(head, note, list, foot);
    overlay.append(panel);
    ask.addEventListener("click", () => askLinkList());
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target.closest("[data-role=link-close]")) closeLinkDialog();
    });

    document.body.append(overlay);
    linkDialog = overlay;
    return overlay;
  }

  // 后端在不在：延伸阅读全靠它调模型，提示得分清「后端没起」和「助手没配」
  function backendOffline() {
    return !(window.spasreBackend && window.spasreBackend.online);
  }

  // 弹窗顶上的状态行：没话说就整条收起来，不留一段空白
  function setLinkNote(text) {
    const note = linkDialog ? linkDialog.querySelector("[data-role=link-note]") : null;
    if (!note) return;
    note.textContent = text || "";
    note.hidden = !text;
  }

  function openLinkDialog(task) {
    if (!task) return false;
    const stored = linksForTask(task);
    // 还没找过资料：打开就问助手，不用用户再点一下
    return openLinkList(task.title, stored, {
      taskId: task.id,
      brief: task.brief,
      category: task.category,
      auto: stored.length === 0
    });
  }

  // 目标节点也复用这个弹窗，所以拆出「标题 + 链接数组」的版本。
  function openLinkList(title, links, options) {
    const config = options || {};
    const overlay = ensureLinkDialog();
    const heading = overlay.querySelector("#task-link-dialog-title");
    const list = overlay.querySelector("[data-role=link-list]");
    const ask = overlay.querySelector("[data-role=link-ask]");
    const items = normalizeLinks(links);
    const canAsk = Boolean(window.spasreBackend && window.spasreBackend.online) && agentConfigured();

    // 弹窗是复用的一个，所以这次问的是谁得记下来（异步回来时照着填）
    linkDialogContext = {
      title: String(title || ""),
      taskId: config.taskId || "",
      brief: config.brief || "",
      category: config.category || ""
    };
    linkAskToken += 1; // 上一次的异步结果作废

    if (heading) heading.textContent = String(title || "延伸阅读");
    if (ask) {
      ask.hidden = config.ask === false;
      ask.disabled = !canAsk;
      ask.textContent = items.length > 0 ? "换一批资料" : "让助手找延伸阅读";
      ask.title = canAsk
        ? "让助手按标题找几条资料（每条都会先验证能不能打开）"
        : "还没配上助手 —— 到设置页填一下模型接口和密钥";
    }
    let line = config.note || "";
    if (items.length === 0) {
      if (canAsk) line = "正在让助手找…";
      else if (backendOffline()) line = NO_BACKEND_NOTE;
      else line = config.empty || "还没有资料。到设置页把助手配上，就能让它按题目找资料（每条都会先验证能不能打开）。";
    }
    setLinkNote(line);
    fillLinkList(items);

    linkDialogReturn = document.activeElement;
    overlay.hidden = false;
    overlay.dataset.taskId = config.taskId || "";
    const focusTarget = overlay.querySelector(".task-link-close");
    if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus();
    if (config.auto && canAsk) askLinkList();
    return true;
  }

  // 「让助手找」：转圈期间按钮禁用；回来之后填列表，顺手存回这条任务上（下次直接就有）。
  let linkDialogContext = { title: "", taskId: "", brief: "", category: "" };
  let linkAskToken = 0;

  async function askLinkList() {
    const overlay = linkDialog;
    if (!overlay) return;
    const context = linkDialogContext;
    const token = (linkAskToken += 1);
    const ask = overlay.querySelector("[data-role=link-ask]");
    if (ask) ask.disabled = true;
    setLinkNote("正在让助手找 —— 它还会挨个验证链接能不能打开，可能要十几秒…");

    const answer = await askReadingLinks(context.title, context);
    if (token !== linkAskToken || overlay.hidden) return; // 又点了一次、或者已经关掉了：这次结果作废
    if (ask) ask.disabled = false;

    if (!answer.ok) {
      setLinkNote(answer.error);
      return;
    }
    if (answer.links.length === 0) {
      setLinkNote("助手没找到能打开的链接 —— 换个更具体的标题或补一句说明，再让它找一次。");
      return;
    }
    fillLinkList(answer.links);
    if (ask) ask.textContent = "换一批资料";
    setLinkNote(""); // 链接就在眼前，不用再说一句「验证过、新窗口打开」
    if (context.taskId) {
      const task = store.tasks.concat(store.trash).find((item) => item.id === context.taskId);
      if (task) {
        task.links = answer.links; // 存下来：下次打开直接显示，不再问模型
        save();
        renderAll();
      }
    }
  }

  function fillLinkList(items) {
    const list = linkDialog ? linkDialog.querySelector("[data-role=link-list]") : null;
    if (!list) return;
    list.replaceChildren();
    (Array.isArray(items) ? items : []).forEach((link) => {
      const item = el("li", "task-link-item");
      const anchor = el("a", "task-link", link.title);
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      item.append(anchor);
      const host = link.source || linkHost(link.url);
      if (host) item.append(el("span", "task-link-host", host));
      list.append(item);
    });
  }

  function closeLinkDialog() {
    if (!linkDialog || linkDialog.hidden) return false;
    linkDialog.hidden = true;
    linkDialog.dataset.taskId = "";
    const back = linkDialogReturn;
    linkDialogReturn = null;
    if (back && typeof back.focus === "function") back.focus();
    return true;
  }

  function linkDialogOpen() {
    return Boolean(linkDialog && !linkDialog.hidden);
  }

  /* ---------- 长期目标 ---------- */

  // 目标里每个节点：{ id, title, brief, deps[], links[], date, done }
  // deps 存的是同一目标内其它节点的 id，整张图必须是 DAG（有环会在 normalize 阶段断掉）。

  function cloneGoal(goal) {
    return JSON.parse(JSON.stringify(goal));
  }

  function findGoal(id) {
    return store.goals.find((goal) => goal.id === id) || null;
  }

  function cleanGoalNode(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || "").trim();
    const title = String(raw.title || "").trim();
    if (!id || !title) return null;
    const date = String(raw.date || "").trim();
    const slot = String(raw.slot || "").trim();
    const hours = Number(raw.hours);
    const node = {
      id: id,
      title: title,
      brief: String(raw.brief || "").trim(),
      deps: (Array.isArray(raw.deps) ? raw.deps : []).map((dep) => String(dep).trim()).filter(Boolean),
      links: normalizeLinks(raw.links),
      section: String(raw.section || "").trim(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
      slot: slot,
      hours: Number.isFinite(hours) && hours > 0 ? Math.round(hours * 2) / 2 : 0,
      done: Boolean(raw.done)
    };
    return node;
  }

  // 任务完成 / 恢复时把对应节点点亮或熄灭。
  function setGoalNodeDone(task, done) {
    if (!task || !task.goalId || !task.nodeId) return false;
    const goal = findGoal(task.goalId);
    if (!goal) return false;
    const node = (goal.nodes || []).find((item) => item.id === task.nodeId);
    if (!node) return false;
    node.done = Boolean(done);
    goal.updatedAt = new Date().toISOString();
    return true;
  }

  function createGoal(input) {
    const source = input || {};
    const title = String(source.title || "").trim();
    if (!title) return null;
    const category = registerCategory(source.category || store.settings.defaultCategory) || store.settings.defaultCategory;
    const pace = Number(source.pace);
    const goal = {
      id: newId(),
      title: title,
      detail: String(source.detail || "").trim(),
      category: category,
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(source.startDate || "")) ? String(source.startDate) : todayKey(),
      pace: Number.isFinite(pace) && pace >= 1 && pace <= 8 ? Math.round(pace) : 1,
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(source.deadline || "")) ? String(source.deadline) : "",
      weekly: Number.isFinite(Number(source.weekly)) && Number(source.weekly) >= 1 ? Math.round(Number(source.weekly)) : 7,
      nodes: [],
      planSource: "",
      planNote: "",
      outline: String(source.outline || ""),
      diagram: String(source.diagram || "").trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store.goals.unshift(goal);
    save();
    return goal;
  }

  function updateGoal(id, patch) {
    const goal = findGoal(id);
    if (!goal) return null;
    const source = patch || {};
    if (source.title !== undefined) {
      const title = String(source.title).trim();
      if (!title) return null;
      goal.title = title;
    }
    if (source.detail !== undefined) goal.detail = String(source.detail || "").trim();
    if (source.category !== undefined) goal.category = registerCategory(source.category) || goal.category;
    if (source.startDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(source.startDate))) goal.startDate = String(source.startDate);
    if (source.pace !== undefined) {
      const pace = Number(source.pace);
      if (Number.isFinite(pace) && pace >= 1 && pace <= 8) goal.pace = Math.round(pace);
    }
    if (source.deadline !== undefined) {
      const deadline = String(source.deadline || "");
      goal.deadline = /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : "";
    }
    if (source.weekly !== undefined) {
      const weekly = Number(source.weekly);
      if (Number.isFinite(weekly) && weekly >= 1 && weekly <= 60) goal.weekly = Math.round(weekly);
    }
    if (source.planNote !== undefined) goal.planNote = String(source.planNote || "").trim();
    if (source.planSource !== undefined) goal.planSource = String(source.planSource || "").trim();
    if (source.outline !== undefined) goal.outline = String(source.outline || "");
    if (source.diagram !== undefined) goal.diagram = String(source.diagram || "").trim();
    if (source.nodes !== undefined) {
      const nodes = (Array.isArray(source.nodes) ? source.nodes : []).map(cleanGoalNode).filter(Boolean);
      // 重规划时节点 id 会变，标题没变的沿用原来的完成状态
      const previous = new Map((goal.nodes || []).map((node) => [node.title, Boolean(node.done)]));
      goal.nodes = nodes.map((node) => Object.assign({}, node, { done: node.done || previous.get(node.title) === true }));
    }
    goal.updatedAt = new Date().toISOString();
    save();
    return goal;
  }

  function removeGoal(id, options) {
    const index = store.goals.findIndex((goal) => goal.id === id);
    if (index === -1) return false;
    store.goals.splice(index, 1);
    if (options && options.withTasks) {
      // 完成过的节点任务躺在回收站里，也得一起清掉
      store.tasks = store.tasks.filter((task) => task.goalId !== id);
      store.trash = store.trash.filter((task) => task.goalId !== id);
    }
    save();
    return true;
  }

  function goalTasks(goalId) {
    return store.tasks.filter((task) => task.goalId === goalId);
  }

  // 按节点补任务：已有对应节点任务的不动，节点没了的老任务清掉。
  function syncGoalTasks(goalId) {
    const goal = findGoal(goalId);
    if (!goal) return [];
    const ids = new Set((goal.nodes || []).map((node) => node.id));
    const stale = new Set(
      store.tasks.filter((task) => task.goalId === goalId && !ids.has(task.nodeId)).map((task) => task.id)
    );
    if (stale.size > 0) store.tasks = store.tasks.filter((task) => !stale.has(task.id));
    const existing = new Map(
      store.tasks.filter((task) => task.goalId === goalId).map((task) => [task.nodeId, task])
    );
    const created = [];
    (goal.nodes || []).forEach((node) => {
      // 已经做完的节点不再补任务（完成时任务进了回收站，别又把它拽回来）
      if (node.done) return;
      const task = existing.get(node.id);
      if (task) {
        // 节点改名、换日期、改时间或换了资料，对应的任务跟着走
        const title = "【" + goal.title + "】" + node.title;
        if (task.title !== title) task.title = title;
        if (task.date !== (node.date || "")) task.date = node.date || "";
        if (task.slot !== (node.slot || "")) task.slot = node.slot || "";
        if (task.hours !== (node.hours || 0)) task.hours = node.hours || 0;
        if (node.links && node.links.length > 0) task.links = normalizeLinks(node.links);
        return;
      }
      const fresh = createTask({
        title: "【" + goal.title + "】" + node.title,
        category: goal.category,
        urgency: "normal",
        date: node.date,
        slot: node.slot,
        hours: node.hours,
        links: node.links,
        source: "goal",
        goalId: goal.id,
        nodeId: node.id
      });
      if (fresh) created.push(fresh);
    });
    save();
    return created;
  }

  function toggleGoalNode(goalId, nodeId, done) {
    const goal = findGoal(goalId);
    if (!goal) return null;
    const node = (goal.nodes || []).find((item) => item.id === nodeId);
    if (!node) return null;
    node.done = done === undefined ? !node.done : Boolean(done);
    goal.updatedAt = new Date().toISOString();
    const task = store.tasks.concat(store.trash).find((item) => item.goalId === goalId && item.nodeId === nodeId);
    if (task) {
      if (node.done && !task.trashReason) completeTask(task.id, "done");
      else if (!node.done && task.trashReason) restoreTask(task.id);
    }
    save();
    return node.done;
  }

  /* ---------- 笔记 ---------- */

  // 一篇笔记：分类是自由字符串；能挂到任务（taskId）或目标的知识点（goalId + nodeId）上。
  // 页面上「有笔记就去那篇，没有就新建」都走 noteFor / openNote。
  const DEFAULT_NOTE_CATEGORIES = ["随手记", "复盘", "资料"];

  function cleanNote(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || "").trim();
    if (!id) return null;
    const stamp = new Date().toISOString();
    return {
      id: id,
      title: String(raw.title || "").trim().slice(0, 80) || "无标题",
      body: String(raw.body || ""),
      category: String(raw.category || "").trim().slice(0, 20) || DEFAULT_NOTE_CATEGORIES[0],
      taskId: String(raw.taskId || ""),
      goalId: String(raw.goalId || ""),
      nodeId: String(raw.nodeId || ""),
      createdAt: String(raw.createdAt || stamp),
      updatedAt: String(raw.updatedAt || raw.createdAt || stamp)
    };
  }

  function notes() {
    return store.notes
      .slice()
      .sort((a, b) => (String(a.updatedAt) < String(b.updatedAt) ? 1 : String(a.updatedAt) > String(b.updatedAt) ? -1 : 0));
  }

  function findNote(id) {
    return store.notes.find((note) => note.id === id) || null;
  }

  function createNote(patch) {
    const source = patch || {};
    const note = cleanNote({
      id: newId(),
      title: source.title || "新笔记",
      body: source.body || "",
      category: source.category || DEFAULT_NOTE_CATEGORIES[0],
      taskId: source.taskId || "",
      goalId: source.goalId || "",
      nodeId: source.nodeId || ""
    });
    store.notes.unshift(note);
    save();
    return note;
  }

  function updateNote(id, patch) {
    const note = findNote(id);
    if (!note) return null;
    const source = patch || {};
    ["title", "body", "category", "taskId", "goalId", "nodeId"].forEach((key) => {
      if (source[key] !== undefined) note[key] = String(source[key] || "");
    });
    note.title = String(note.title || "").trim().slice(0, 80) || "无标题";
    note.category = String(note.category || "").trim().slice(0, 20) || DEFAULT_NOTE_CATEGORIES[0];
    note.updatedAt = new Date().toISOString();
    save();
    return note;
  }

  function removeNote(id) {
    const index = store.notes.findIndex((note) => note.id === id);
    if (index === -1) return false;
    store.notes.splice(index, 1);
    save();
    return true;
  }

  // 分类 = 默认那三个 + 自己加的 + 已经在用的（笔记上写了什么就算什么）
  function noteCategories() {
    const used = store.notes.map((note) => String(note.category || "").trim()).filter(Boolean);
    const custom = Array.isArray(store.meta.noteCategories) ? store.meta.noteCategories : [];
    return DEFAULT_NOTE_CATEGORIES.concat(custom).concat(used).filter((name, index, all) => name && all.indexOf(name) === index);
  }

  function addNoteCategory(name) {
    const key = String(name || "").trim().slice(0, 20);
    if (!key) return "";
    if (DEFAULT_NOTE_CATEGORIES.indexOf(key) < 0 && store.meta.noteCategories.indexOf(key) < 0) {
      store.meta.noteCategories.push(key);
      save();
    }
    return key;
  }

  // 这篇东西挂在哪篇笔记上：先按任务、再按目标的知识点、最后只认节点（从图上点进来的那种）
  function noteFor(target) {
    const want = target || {};
    if (want.taskId) {
      const hit = store.notes.find((note) => note.taskId === want.taskId);
      if (hit) return hit;
    }
    if (want.goalId && want.nodeId) {
      const hit = store.notes.find((note) => note.goalId === want.goalId && note.nodeId === want.nodeId);
      if (hit) return hit;
    }
    if (want.nodeId) {
      const hit = store.notes.find((note) => note.nodeId === want.nodeId && (!want.goalId || note.goalId === want.goalId));
      if (hit) return hit;
    }
    return null;
  }

  // 有就直接切到那篇，没有就新建一篇再切过去
  function openNote(target) {
    const want = target || {};
    const existing = noteFor(want);
    if (existing) {
      window.location.href = "notes.html?note=" + encodeURIComponent(existing.id);
      return existing;
    }
    const note = createNote({
      title: want.title || "新笔记",
      category: want.category || DEFAULT_NOTE_CATEGORIES[0],
      taskId: want.taskId || "",
      goalId: want.goalId || "",
      nodeId: want.nodeId || ""
    });
    window.location.href = "notes.html?note=" + encodeURIComponent(note.id) + "&new=1";
    return note;
  }

  /* ---------- mutations ---------- */

  function createTask(input) {
    const title = String((input && input.title) || "").trim();
    if (!title) return null;
    const category = registerCategory((input && input.category) || store.settings.defaultCategory) || "未分类";
    const urgency = URGENCY_KEYS.includes(input && input.urgency) ? input.urgency : "normal";
    const hours = Number(input && input.hours);
    const task = {
      id: newId(),
      title,
      category,
      urgency,
      date: input && input.date ? String(input.date) : "",
      slot: segmentOf(input && input.slot) ? String(input.slot) : "",
      hours: Number.isFinite(hours) && hours > 0 ? Math.round(hours * 2) / 2 : 0,
      source: (input && input.source) || "manual",
      createdAt: new Date().toISOString()
    };
    const links = normalizeLinks(input && input.links);
    if (links.length > 0) task.links = links;
    // 目标节点生成的 task 会记住自己属于哪个目标的哪个节点，完成时好把节点点亮。
    if (input && input.goalId) {
      task.goalId = String(input.goalId);
      if (input.nodeId) task.nodeId = String(input.nodeId);
    }
    store.tasks.push(task);
    save();
    return task;
  }

  function completeTask(id, reason) {
    const index = store.tasks.findIndex((task) => task.id === id);
    if (index === -1) return false;
    const task = store.tasks.splice(index, 1)[0];
    task.trashedAt = new Date().toISOString();
    task.trashReason = reason === "removed" ? "removed" : "done";
    store.trash.unshift(task);
    if (store.trash.length > DAILY_LIMIT) store.trash.length = DAILY_LIMIT;
    if (task.trashReason === "done") setGoalNodeDone(task, true);
    // 今天这条推荐任务被做掉 / 删掉了：记上「今天已经给过」，刷新之后别再补一条回来
    if (task.source === "daily" && task.date === todayKey()) store.meta.dailyServedOn = todayKey();
    save();
    return true;
  }

  function restoreTask(id) {
    const index = store.trash.findIndex((task) => task.id === id);
    if (index === -1) return false;
    const task = store.trash.splice(index, 1)[0];
    delete task.trashedAt;
    delete task.trashReason;
    store.tasks.push(task);
    setGoalNodeDone(task, false);
    // 从回收站捞回来，等于今天这条又回到列表里了，记号保持今天（不该再补一条）
    if (task.source === "daily" && task.date === todayKey()) store.meta.dailyServedOn = todayKey();
    save();
    return true;
  }

  function purgeTask(id) {
    const before = store.trash.length;
    store.trash = store.trash.filter((task) => task.id !== id);
    if (store.trash.length === before) return false;
    save();
    return true;
  }

  function emptyTrash() {
    if (store.trash.length === 0) return 0;
    const count = store.trash.length;
    store.trash = [];
    save();
    return count;
  }

  function updateTask(id, patch) {
    const task = store.tasks.find((item) => item.id === id);
    if (!task) return false;
    if (patch.title !== undefined) {
      const title = String(patch.title).trim();
      if (!title) return false;
      task.title = title;
    }
    if (patch.category !== undefined) task.category = registerCategory(patch.category) || task.category;
    if (patch.urgency !== undefined && URGENCY_KEYS.includes(patch.urgency)) task.urgency = patch.urgency;
    if (patch.date !== undefined) task.date = patch.date ? String(patch.date) : "";
    if (patch.links !== undefined) {
      const links = normalizeLinks(patch.links);
      if (links.length > 0) task.links = links;
      else delete task.links;
    }
    save();
    return true;
  }

  function updateSettings(patch) {
    store.settings = Object.assign({}, store.settings, patch);
    save();
    // 设置是跨页共用的（任务页 + 设置页），改完广播一声，谁想跟着变谁自己听
    if (typeof document.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
      document.dispatchEvent(new window.CustomEvent("spasre:change"));
    }
  }

  // 本地兜底：从内置的知识点清单里挑一个（资料留给助手找，这儿不硬塞）。
  function localDaily(dateKey) {
    const mine = pickInterestList();
    // 没自己挑过兴趣就是「随机推」：按当前方向这一个宽泛方向挑
    const focus = mine.length > 0 ? mine.join(" ") : directionTheme();
    const title = KNOWLEDGE_POINTS[dayOfYear() % KNOWLEDGE_POINTS.length];
    return {
      date: dateKey,
      title: title,
      brief: "",
      links: [],
      source: "local",
      interest: mine.length > 0 ? mine.join("、") : focus
    };
  }

  // 今天这条自动生成的推荐任务删掉（引导里选「先不用」时用，不进回收站）
  function dropTodayDaily() {
    const today = todayKey();
    const kept = store.tasks.filter((task) => !(task.source === "daily" && task.date === today));
    if (kept.length === store.tasks.length) return false;
    store.tasks = kept;
    if (store.daily && store.daily.date === today) store.daily = null;
    // 这条是「不要」掉的，不算发出过 —— 之后再把每日推荐打开，今天还能拿到一条
    if (store.meta.dailyServedOn === today) store.meta.dailyServedOn = "";
    save();
    renderAll();
    return true;
  }

  // 引导还没答复之前不要自己动：新用户第一眼问的就是「要不要每日推荐」，
  // 答之前不能先塞一条任务、也不能先拿密钥去问模型
  function dailyReady() {
    return Boolean(store.settings.onboarded) && Boolean(store.settings.dailyRecommendation);
  }

  function ensureDailyRecommendation() {
    if (!dailyReady()) return false;
    const today = todayKey();
    if (!store.daily || store.daily.date !== today) store.daily = localDaily(today);
    const exists = store.tasks.some(
      (task) => task.category === DAILY_CATEGORY && task.date === today && task.source === "daily"
    );
    if (exists) {
      // 今天这条已经发出去了，记一笔：等下做完 / 删掉之后别再补一条回来
      if (store.meta.dailyServedOn !== today) {
        store.meta.dailyServedOn = today;
        save();
      }
      return false;
    }
    // 今天这条早给过了又不在列表里 —— 是用户做完（进了回收站）或不要了，别复活它
    if (store.meta.dailyServedOn === today) return false;
    const task = {
      id: newId(),
      title: "今日知识点：" + store.daily.title,
      category: DAILY_CATEGORY,
      urgency: "low",
      date: today,
      source: "daily",
      createdAt: new Date().toISOString()
    };
    const links = store.daily.links || [];
    if (links.length > 0) task.links = links;
    // 勾了「统一排进日程表」就顺手占一个今天的空段（没空位就先不排，别硬塞）
    if (store.settings.dailyAutoSchedule) autoPlaceTask(task, today);
    store.tasks.push(task);
    store.meta.dailyServedOn = today;
    save();
    return true;
  }

  function dailySystemPrompt(exclude) {
    const mine = pickInterestList();
    const theme = mine.length > 0 ? "" : directionTheme();
    const lines = [
      "你在给一个自学的人挑今天要了解的知识点。",
      "今天是 " + todayKey() + "。",
      mine.length > 0
        ? "他的兴趣点：" + mine.join("、")
        : "他还没定兴趣方向，这一轮想看看「" + theme + "」这一带的东西，别跑太远。",
      "挑一个具体、能动手、看完有收获的点，别挑太泛或没什么意义的大词。",
      "只输出一个 JSON 对象，不要解释，也不要用代码块：",
      '{"title": "知识点，12 字以内", "brief": "一句话说明它解决什么问题"}'
    ];
    const banned = Array.isArray(exclude) ? exclude.filter(Boolean) : [];
    if (banned.length > 0) {
      lines.splice(4, 0,
        "下面这些他已经学过、不想学或者觉得没意思，**一个都不要再提**（换了名字也不行）：",
        banned.map((item) => "- " + item).join("\n"));
    }
    return lines.join("\n");
  }

  // 配了模型就让它按兴趣点挑；生成成功就替换掉本地那条。
  let dailyUpgradeBusy = false;

  async function upgradeDailyWithAI() {
    if (!dailyReady() || !agentConfigured()) return false;
    const today = todayKey();
    if (store.daily && store.daily.date === today && store.daily.source === "ai") return false;
    if (dailyUpgradeBusy) return false; // 启动那一下和「后端刚连上」可能同时来，别重复问模型
    dailyUpgradeBusy = true;
    let content = "";
    try {
      content = await agentChat(
        [
          { role: "system", content: dailySystemPrompt(dailyExcludes({ withCurrent: false })) },
          { role: "user", content: "推荐今天的知识点。" }
        ],
        { temperature: 0.7, maxTokens: 600 }
      );
    } catch (error) {
      // 失败就先留着本地那条，但别不出声——不然「怎么一直是本地推荐」很难查
      console.warn("AI 每日推荐没生成成功，先留着本地这条：", error);
      return false;
    } finally {
      dailyUpgradeBusy = false;
    }
    const parsed = extractJson(content);
    const title = parsed && typeof parsed === "object" ? String(parsed.title || "").trim() : "";
    if (!title) return false;
    const brief = String(parsed.brief || "").trim();
    let links = normalizeLinks(parsed.links);
    // 目录里没有对得上的（新题目大多如此）：让 reading.suggest 到模型那儿找几条，它会验证链接
    if (links.length === 0) {
      const found = await askReadingLinks(title, { brief: brief, category: DAILY_CATEGORY });
      if (found.ok) links = found.links;
    }
    store.daily = {
      date: today,
      title: title,
      brief: brief,
      links: links,
      source: "ai",
      interest: (store.settings.interests || []).join("、")
    };
    const task = store.tasks.find((item) => item.source === "daily" && item.date === today);
    if (task) {
      task.title = "今日知识点：" + title;
      if (links.length > 0) task.links = links;
    }
    save();
    return true;
  }

  /* ---------- 每日推荐：换一个 ---------- */

  // 「换一个」时要避开的东西：换过的、学过的（勾掉进回收站的）、今天已经挂在板上的
  function dailyExcludes(options) {
    const opts = options || {};
    const seen = Array.isArray(store.dailySeen) ? store.dailySeen : [];
    const learned = (store.trash || [])
      .filter((task) => task.source === "daily" && task.trashReason === "done")
      .map((task) => String(task.title || "").replace(/^今日知识点：/, "").trim());
    const onBoard = (store.tasks || [])
      .filter((task) => task.source === "daily")
      .map((task) => String(task.title || "").replace(/^今日知识点：/, "").trim());
    const current = opts.withCurrent !== false && store.daily && store.daily.date === todayKey() ? [store.daily.title] : [];
    const all = seen.concat(learned).concat(onBoard).concat(current)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    return Array.from(new Set(all)).slice(-DAILY_SEEN_LIMIT);
  }

  function rememberDailySkip(title) {
    const name = String(title || "").trim();
    if (!name) return;
    const seen = (Array.isArray(store.dailySeen) ? store.dailySeen : []).filter((item) => item !== name);
    store.dailySeen = seen.concat([name]).slice(-DAILY_SEEN_LIMIT);
  }

  function localReroll(exclude) {
    const used = new Set(exclude);
    const pool = KNOWLEDGE_POINTS.filter((item) => !used.has(item));
    const title = pool.length > 0
      ? pool[Math.floor(Math.random() * pool.length)]
      : KNOWLEDGE_POINTS[dayOfYear() % KNOWLEDGE_POINTS.length];
    return { title: title, brief: "", links: [], source: "local" };
  }

  function setDailyStatus(text) {
    const box = document.querySelector(".daily-status");
    if (box) box.textContent = String(text || "");
  }

  // 换掉现在这条：学过的 / 不想学的 / 没意思的都会记下来，下次不再推
  async function rerollDaily() {
    const today = todayKey();
    const previous = store.daily && store.daily.date === today ? String(store.daily.title || "") : "";
    const exclude = dailyExcludes();
    // 随机模式（没自己挑过兴趣）：换一个 = 对这个方向没兴趣 → 换方向
    const randomMode = pickInterestList().length === 0;
    let note = "";
    if (randomMode) {
      const moved = switchRandomDirection();
      note = "换了个方向：这轮看「" + moved.theme + "」。";
      renderInterests();
    }
    setDailyStatus("正在换一个…");

    let next = null;
    if (agentConfigured()) {
      try {
        const content = await agentChat(
          [
            { role: "system", content: dailySystemPrompt(exclude) },
            { role: "user", content: "换一个：上面这些都不要，另挑一个今天值得了解的知识点。" }
          ],
          { temperature: 0.9, maxTokens: 600 }
        );
        const parsed = extractJson(content);
        const title = parsed && typeof parsed === "object" ? String(parsed.title || "").trim() : "";
        if (title && !exclude.includes(title)) {
          const brief = String(parsed.brief || "").trim();
          let links = normalizeLinks(parsed.links);
          // 目录里没有对得上的（新题目大多如此）：让 reading.suggest 到模型那儿找，它会验证链接
          if (links.length === 0) {
            const found = await askReadingLinks(title, { brief: brief, category: DAILY_CATEGORY });
            if (found.ok) links = found.links;
          }
          next = { title: title, brief: brief, links: links, source: "ai" };
        }
      } catch (error) {
        console.warn("换一个没成功，先从内置里挑：", error);
      }
    }
    if (!next) next = localReroll(exclude);

    rememberDailySkip(previous);
    dropAutoInterestsMatching(previous);
    store.daily = {
      date: today,
      title: next.title,
      brief: next.brief,
      links: next.links,
      source: next.source,
      interest: (pickInterestList().length > 0 ? pickInterestList().join("、") : directionTheme())
    };
    const task = store.tasks.find((item) => item.source === "daily" && item.date === today);
    if (task) {
      task.title = "今日知识点：" + next.title;
      if ((next.links || []).length > 0) task.links = next.links;
      else delete task.links;
    } else {
      // 换的是新的一条：今天那条（可能已经做完了）的记号清掉，让它能重新铺一条任务
      store.meta.dailyServedOn = "";
      ensureDailyRecommendation();
    }
    save();
    renderAll();
    setDailyStatus(note || (next.source === "ai" ? "换好了，不想学就再换一个。" : "模型没接上，先从内置里换了一个。"));
  }

  /* ---------- shared pieces ---------- */

  function dogButton(task, size) {
    const button = el("button", "task-dog" + (size === "small" ? " task-dog-sm" : ""));
    button.type = "button";
    button.dataset.action = "complete";
    button.dataset.id = task.id;
    button.title = "完成（小狗叼走）";
    button.setAttribute("aria-label", "完成任务：" + task.title);
    button.innerHTML = DOG_ICON;
    return button;
  }

  function chip(text, className) {
    return el("span", "task-chip " + (className || ""), text);
  }

  const CATEGORY_ACCENT = { 学习: 1, 工作: 2, 生活: 3, 每日推荐: 4 };

  // 分类配一个稳定的强调色（1-5，马卡龙色系），默认四个分类固定，其它按名字散列
  function accentOf(name) {
    const key = String(name || "").trim();
    if (CATEGORY_ACCENT[key]) return CATEGORY_ACCENT[key];
    let hash = 0;
    for (const char of key) hash = (hash * 31 + char.codePointAt(0)) % 997;
    return (hash % 5) + 1;
  }

  function taskMeta(task) {
    const meta = el("div", "task-meta");
    meta.append(chip(task.category, "chip-category cat-" + accentOf(task.category)));
    meta.append(chip(URGENCY_LABEL[task.urgency] || URGENCY_LABEL.normal, "chip-urgency urgency-" + (task.urgency || "normal")));
    if (task.date) {
      const diff = dayDiff(task.date);
      const suffix = diff < 0 ? "（逾期）" : diff === 0 ? "（今天）" : diff === 1 ? "（明天）" : "";
      meta.append(chip(task.date + suffix, "chip-date" + (diff < 0 ? " is-overdue" : "")));
    } else {
      meta.append(chip("未排期", "chip-date"));
    }
    // 排过时间的任务把时段也带上，今天要做什么、几点做一目了然
    if (task.date && task.slot) {
      const seg = segmentOf(task.slot);
      if (seg) meta.append(chip(slotTime(task.slot, task.hours), "chip-slot"));
    }
    if (task.source === "daily") meta.append(chip("每日推荐", "chip-daily"));
    if (task.source === "agent") meta.append(chip("助手添加", "chip-agent"));
    if (task.goalId && task.nodeId && lockedNodes().has(nodeKey(task.goalId, task.nodeId))) {
      meta.append(chip("等前置重排", "chip-locked"));
    }
    return meta;
  }

  // 「加入日程表」：任务先在本地标成待安排，然后跳到日程表页去挑时间
  function planTask(id, on) {
    const task = store.tasks.find((item) => item.id === id);
    if (!task) return false;
    if (on === false) {
      delete task.planRequested;
    } else {
      task.planRequested = true;
    }
    save();
    renderAll();
    return true;
  }

  function taskItem(task, options) {
    const item = el(
      "li",
      "task-item cat-" + accentOf(task.category) + (options && options.compact ? " task-item-compact" : "")
    );
    item.dataset.id = task.id;
    // 列表从上到下颜色逐渐变浅
    if (options && typeof options.depth === "number") {
      item.style.setProperty("--tint", String(Math.max(0.05, 0.26 - options.depth * 0.035).toFixed(3)));
    }

    if (!options || options.dog !== false) item.append(dogButton(task, options && options.compact ? "small" : ""));

    const body = el("div", "task-body");
    body.dataset.action = "open-links";
    body.dataset.id = task.id;
    const title = el("button", "task-title task-title-btn", task.title);
    title.type = "button";
    title.dataset.action = "open-links";
    title.dataset.id = task.id;
    title.title = "看推荐阅读";
    title.setAttribute("aria-label", "查看「" + task.title + "」的推荐阅读");
    body.append(title);
    body.append(taskMeta(task));
    item.append(body);

    if (!options || options.actions !== false) {
      const actions = el("div", "task-actions");
      // 任务也能占日程表的一格：每日推荐想固定到晚上那一段，就用这个
      const plan = el("button", "task-action", task.slot ? "改时段" : "加入日程表");
      plan.type = "button";
      plan.dataset.action = "task-slot";
      plan.dataset.id = task.id;
      plan.title = task.slot ? "改它的时段，或者取消安排" : "把这条排进日程表的某个空闲时段";
      const edit = el("button", "task-action", "编辑");
      edit.type = "button";
      edit.dataset.action = "edit";
      edit.dataset.id = task.id;
      const note = el("button", "task-action", "笔记");
      note.type = "button";
      note.dataset.action = "task-note";
      note.dataset.id = task.id;
      note.title = "这条的笔记：有就打开，没有就新建一篇";
      if (noteFor({ taskId: task.id })) note.classList.add("is-on");
      const remove = el("button", "task-action task-action-danger", "删除");
      remove.type = "button";
      remove.dataset.action = "remove";
      remove.dataset.id = task.id;
      actions.append(plan, note, edit, remove);
      item.append(actions);
    }
    return item;
  }

  function emptyNote(text) {
    return el("p", "task-empty", text);
  }

  /* ---------- 首页：今日任务 + 每日推荐 ---------- */

  function renderHome() {
    renderToday();
    renderDailyCard();
  }

  function renderToday() {
    const root = document.getElementById("home-today");
    if (!root) return;
    const list = activeTasks("").filter((task) => {
      const bucket = bucketOf(task);
      return bucket === "today" || bucket === "overdue";
    });
    root.replaceChildren();
    if (list.length === 0) {
      root.append(emptyNote("今天没有要做的任务。"));
      return;
    }
    const ul = el("ul", "task-list");
    sortTasks(list).forEach((task, index) => ul.append(taskItem(task, { compact: true, actions: false, depth: index })));
    root.append(ul);
  }

  function renderDailyCard() {
    const root = document.getElementById("home-daily");
    if (!root) return;
    root.replaceChildren();

    let daily = store.daily && store.daily.date === todayKey() ? store.daily : null;
    // 老数据里没有 store.daily，就从今天那条推荐任务还原
    if (!daily) {
      const task = store.tasks.find((item) => item.source === "daily" && item.date === todayKey());
      if (task) {
        daily = {
          date: todayKey(),
          title: String(task.title || "").replace(/^今日知识点：/, ""),
          brief: "",
          links: task.links || [],
          source: "local",
          interest: ""
        };
      }
    }

    const card = el("article", "daily-card");
    if (!daily) {
      card.append(el("p", "task-empty", "今天的推荐还没生成。"));
      root.append(card);
      return;
    }
    if (daily.source === "ai") card.classList.add("is-ai");

    const head = el("div", "daily-head");
    head.append(el("h3", "daily-title", daily.title));
    head.append(chip(daily.source === "ai" ? "AI 推荐" : "本地推荐", "chip-agent"));
    const tools = el("div", "daily-tools");
    const reroll = el("button", "task-action", "换一个");
    reroll.type = "button";
    reroll.dataset.action = "reroll-daily";
    reroll.title = "学过了 / 不想学 / 没意思 —— 换一个";
    tools.append(reroll);
    head.append(tools);
    card.append(head);
    if (daily.brief) card.append(el("p", "daily-brief", daily.brief));
    if (daily.interest) card.append(el("p", "daily-meta", "兴趣点：" + daily.interest));
    // 今天这条已经做掉 / 删掉了：说一声，不然卡片看着像还没做（任务也不会再补回来）
    if (store.meta.dailyServedOn === todayKey() && !store.tasks.some((item) => item.source === "daily" && item.date === todayKey())) {
      const done = store.trash.some(
        (item) => item.source === "daily" && item.date === todayKey() && item.trashReason === "done"
      );
      const line = el("p", "daily-meta", done ? "今天这条已经做完了。" : "今天这条已经拿掉了。");
      line.dataset.role = "daily-state";
      card.append(line);
    }

    const links = Array.isArray(daily.links) ? daily.links : [];
    if (links.length > 0) {
      const row = el("div", "daily-links");
      links.forEach((link) => {
        const a = el("a", "daily-link", link.title || link.url);
        a.href = link.url;
        a.target = "_blank";
        a.rel = "noopener";
        row.append(a);
      });
      card.append(row);
    }
    card.append(el("p", "task-hint daily-status", ""));
    root.append(card);
  }

  function tasksHref(params) {
    const base = document.body.dataset.tasksUrl || "tasks.html";
    if (!params || !params.category) return base;
    return base + "?category=" + encodeURIComponent(params.category);
  }

  /* ---------- board ---------- */

  function renderBoard() {
    const root = document.getElementById("task-board");
    if (!root) return;

    renderCategoryOptions();
    renderBoardTabs();
    renderBoardList();
    renderTrash();
  }

  function renderCategoryOptions() {
    const picker = document.getElementById("task-category");
    if (picker) {
      const previous = picker.value || store.settings.defaultCategory;
      picker.replaceChildren();
      categories().forEach((name) => {
        const option = el("option", null, name);
        option.value = name;
        picker.append(option);
      });
      const fresh = el("option", null, "＋ 新分类…");
      fresh.value = NEW_CATEGORY;
      picker.append(fresh);
      picker.value = previous === NEW_CATEGORY || categories().includes(previous) ? previous : categories()[0];
    }

    const filter = document.getElementById("task-filter-category");
    if (filter) {
      const previous = state.board.category || filter.value;
      filter.replaceChildren();
      const all = el("option", null, "全部分类");
      all.value = "all";
      filter.append(all);
      categories().forEach((name) => {
        const option = el("option", null, name);
        option.value = name;
        filter.append(option);
      });
      filter.value = categories().includes(previous) ? previous : "all";
      state.board.category = filter.value;
    }

    const urgency = document.getElementById("task-filter-urgency");
    if (urgency) urgency.value = state.board.urgency;
  }

  // 设置区（设置页的几块）单独渲染：这些东西两页都可能出现
  function renderSettingsAreas() {
    renderInterests();
  }

  /* ---------- 兴趣标签：自己挑的 + 自动记的 ---------- */

  function interestList() {
    return Array.isArray(store.settings.interests) ? store.settings.interests.slice() : [];
  }

  function autoInterestList() {
    return Array.isArray(store.settings.autoInterests) ? store.settings.autoInterests.slice() : [];
  }

  // 用户自己挑的（「自动记下」的那些不算）
  function pickInterestList() {
    const auto = autoInterestList();
    return interestList().filter((name) => auto.indexOf(name) < 0);
  }

  // 存两份：interests 是界面顺序，autoInterests 说明哪些是自动记的
  function setInterestLists(mine, auto) {
    const keepMine = [];
    (mine || []).forEach((name) => {
      const clean = String(name || "").trim();
      if (clean && keepMine.indexOf(clean) < 0) keepMine.push(clean);
    });
    const keepAuto = [];
    (auto || []).forEach((name) => {
      const clean = String(name || "").trim();
      if (clean && keepMine.indexOf(clean) < 0 && keepAuto.indexOf(clean) < 0) keepAuto.push(clean);
    });
    updateSettings({ interests: keepMine.concat(keepAuto), autoInterests: keepAuto });
  }

  function interestLib() {
    return window.spasreInterestLib || null;
  }

  // 没挑兴趣时「这一轮推哪个方向」：按 dailyDirection 在宽泛方向里轮换（这个列表顺序固定）
  function directionTheme() {
    const lib = interestLib();
    const all = lib && lib.all ? lib.all() : ["编程基础", "算法与数据结构", "操作系统", "数据库"];
    const index = Math.abs(Number(store.settings.dailyDirection) || 0) % all.length;
    return all[index];
  }

  /* ---------- 弹层（引导页和「挑兴趣」都用它） ---------- */

  // 返回 { sheet, panel, body, close }：body 里塞内容，close() 关掉
  function openSheet(title, options) {
    const opts = options || {};
    const sheet = el("div", "sheet");
    const panel = el("div", "sheet-panel" + (opts.wide ? " sheet-wide" : ""));
    const head = el("div", "sheet-head");
    head.append(el("h2", "sheet-title", title));
    const close = el("button", "sheet-close", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "关闭");
    head.append(close);
    panel.append(head);
    const body = el("div", "sheet-body");
    panel.append(body);
    sheet.append(panel);
    document.body.append(sheet);

    const shut = () => {
      sheet.remove();
      document.removeEventListener("keydown", onKey);
      if (typeof opts.onClose === "function") opts.onClose();
    };
    function onKey(event) {
      if (event.key === "Escape") shut();
    }
    close.addEventListener("click", shut);
    sheet.addEventListener("click", (event) => {
      if (event.target === sheet) shut();
    });
    document.addEventListener("keydown", onKey);
    return { sheet: sheet, panel: panel, body: body, close: shut };
  }

  /* ---------- 每日推荐：开关 / 随机推 ---------- */

  // 打开每日推荐：不够 3 个自己挑的兴趣就先弹「挑兴趣」，或者跳过（跳过就随机推）
  function openInterestPrompt() {
    const lib = interestLib();
    if (!lib) return;
    const sheet = openSheet("先挑几个方向吧", { onClose: renderDailySwitch });
    sheet.body.append(
      el("p", "task-hint", "每日推荐按这些方向挑知识点。挑 3 个以上更准，也能自己输入；不挑就随机推，点「换一个」会自动记下方向。")
    );
    const view = lib.picker({
      min: 3,
      initial: pickInterestList(),
      broadLimit: 10,
      onDone: (list) => {
        setInterestLists(list, autoInterestList().filter((name) => list.indexOf(name) < 0));
        updateSettings({ dailyRecommendation: true });
        sheet.close();
        afterDailyOn();
      },
      onSkip: () => {
        // 跳过就只是随机推：不主动填标签，之后会按学完的每日任务慢慢推
        updateSettings({ dailyRecommendation: true });
        sheet.close();
        afterDailyOn();
      }
    });
    sheet.body.append(view.el);
  }

  function afterDailyOn() {
    if (ensureDailyRecommendation()) renderAll();
    renderInterests();
    upgradeDailyWithAI()
      .then((changed) => {
        if (changed) renderAll();
      })
      .catch(() => {});
  }

  function setDailyRecommendation(on) {
    if (!on) {
      updateSettings({ dailyRecommendation: false });
      renderAll();
      return false;
    }
    if (pickInterestList().length < 3) {
      openInterestPrompt();
      return false;
    }
    updateSettings({ dailyRecommendation: true });
    afterDailyOn();
    return true;
  }

  // 随机推的时候「换一个」= 对这个方向不感兴趣 → 换下一个方向
  // （不主动填标签：兴趣是等「学完的每日任务」攒够了再推出来）
  function switchRandomDirection() {
    const next = (Math.abs(Number(store.settings.dailyDirection) || 0) + 1);
    updateSettings({ dailyDirection: next });
    return { theme: directionTheme() };
  }

  // 跳过兴趣标签之后**不主动填标签**：改成看「这几天学完的每日任务」慢慢推方向，
  // 换掉的那些当反例（不推、也不当兴趣）。至少学完 2 条才动手，一天最多推一次。
  const INTEREST_INFER_MIN = 2;

  function learnedDailyTitles() {
    const out = [];
    (store.trash || []).forEach((task) => {
      if (task.source !== "daily" || task.trashReason !== "done") return;
      const title = String(task.title || "").replace(/^今日知识点：/, "").trim();
      if (title && out.indexOf(title) < 0) out.push(title);
    });
    return out;
  }

  function avoidedDailyTitles() {
    return (Array.isArray(store.dailySeen) ? store.dailySeen : []).map((item) => String(item || "").trim()).filter(Boolean);
  }

  // 没配模型时的兜底：学完的标题里出现了哪个宽泛方向的名字，就算对哪个感兴趣
  function localInferInterests(titles) {
    const lib = interestLib();
    const pool = lib && lib.all ? lib.all() : [];
    const hits = [];
    pool.forEach((tag) => {
      if (titles.some((title) => title.indexOf(tag) >= 0)) hits.push(tag);
    });
    return hits.slice(0, 3);
  }

  let inferBusy = false;

  async function inferInterestsFromDaily() {
    if (inferBusy) return false;
    if (pickInterestList().length > 0) return false; // 自己挑过就不插手
    const today = todayKey();
    if (store.settings.interestInferredOn === today) return false; // 一天最多推一次
    const learned = learnedDailyTitles();
    if (learned.length < INTEREST_INFER_MIN) return false;
    const avoided = avoidedDailyTitles();

    inferBusy = true;
    let tags = [];
    if (agentConfigured()) {
      try {
        const content = await agentChat(
          [
            { role: "system", content: "你只输出一个 JSON 对象，不要解释，也不要用代码块。" },
            {
              role: "user",
              content:
                "这个人最近学完了这些知识点：" + learned.slice(0, 20).join("、") +
                (avoided.length > 0 ? "\n这些是他换掉、不想看的：" + avoided.slice(0, 10).join("、") : "") +
                '\n归纳出 1-3 个他可能感兴趣的技术方向（每个 4-12 个字），别碰上面不想看的那些。格式：{"tags": ["方向1"]}'
            }
          ],
          { temperature: 0.4, maxTokens: 200 }
        );
        const parsed = extractJson(content);
        const found = parsed && Array.isArray(parsed.tags) ? parsed.tags : [];
        tags = found.map((item) => String(item || "").trim()).filter(Boolean);
      } catch (error) {
        console.warn("兴趣方向没推出来，先用本地的：", error);
      }
    }
    if (tags.length === 0) tags = localInferInterests(learned);
    // 换掉过的不当兴趣
    tags = tags.filter((tag) => !avoided.some((bad) => bad.indexOf(tag) >= 0 || tag.indexOf(bad) >= 0));
    inferBusy = false;
    if (tags.length === 0) return false;
    setInterestLists([], tags.slice(0, 3));
    updateSettings({ interestInferredOn: today });
    renderInterests();
    return true;
  }

  // 换掉的那个方向不再当兴趣：自动记下的标签里沾边的去掉
  function dropAutoInterestsMatching(text) {
    const needle = String(text || "").trim();
    if (!needle) return false;
    const auto = autoInterestList();
    const kept = auto.filter((tag) => needle.indexOf(tag) < 0 && tag.indexOf(needle) < 0);
    if (kept.length === auto.length) return false;
    setInterestLists(pickInterestList(), kept);
    renderInterests();
    return true;
  }

  function renderInterests() {
    const box = document.getElementById("interest-tags");
    if (!box) return;
    box.replaceChildren();
    const list = interestList();
    if (list.length === 0) {
      box.append(el("span", "task-hint", "还没加。"));
      renderDailySwitch();
      return;
    }
    const auto = autoInterestList();
    list.forEach((name) => {
      const madeUp = auto.indexOf(name) >= 0;
      const tag = el("button", "interest-tag" + (madeUp ? " is-auto" : ""), name + " ✕");
      tag.type = "button";
      tag.title = madeUp ? "这个方向是自动记下来的（点一下去掉）" : "移除";
      tag.dataset.action = "remove-interest";
      tag.dataset.interest = name;
      box.append(tag);
    });
    renderDailySwitch();
  }

  // 每日推荐的开关就放在兴趣标签这块：开着要至少 3 个自己挑的兴趣，不够就让用户挑或者跳过
  function renderDailySwitch() {
    const toggle = document.getElementById("daily-recommend-toggle");
    if (toggle) toggle.checked = Boolean(store.settings.dailyRecommendation);
    const schedule = document.getElementById("daily-schedule-toggle");
    if (schedule) schedule.checked = Boolean(store.settings.dailyAutoSchedule);
    const hint = document.getElementById("daily-recommend-hint");
    if (!hint) return;
    if (!store.settings.dailyRecommendation) {
      hint.textContent = "现在关着。打开后每天给你加一条知识点，按兴趣标签来挑。";
      return;
    }
    const mine = pickInterestList().length;
    const auto = autoInterestList().length;
    if (mine === 0) {
      const learned = learnedDailyTitles().length;
      hint.textContent = learned > 0
        ? "开着（随机推）：学完的每日任务攒到 " + learned + " 条，就按这些推方向（" + (learned >= INTEREST_INFER_MIN ? "够数了，这两天就会推出来" : "还差 " + (INTEREST_INFER_MIN - learned) + " 条") + "）。"
        : "开着（随机推）：还没挑方向 —— 等你学完几条每日任务，就按那些推方向；换掉的不算。";
      return;
    }
    hint.textContent = mine < 3
      ? "开着：自己挑的方向才 " + mine + " 个，再加几个会更准。" + (auto > 0 ? "另外自动推了 " + auto + " 个。" : "")
      : "开着：按你挑的 " + mine + " 个方向来推。";
  }

  /* ---------- 助手的聊天记录 ---------- */

  function chatLog() {
    return Array.isArray(store.chat) ? store.chat : [];
  }

  function pushChat(role, text) {
    const body = String(text || "").trim();
    if (!body) return;
    store.chat = chatLog()
      .concat([{ role: role === "user" ? "user" : "agent", text: body, at: new Date().toISOString() }])
      .slice(-CHAT_LIMIT);
    save();
  }

  function clearChat() {
    store.chat = [];
    save();
    renderChat();
  }

  function setAgentStatus(text) {
    const status = document.getElementById("agent-status");
    if (status) status.textContent = String(text || "");
  }

  function renderChat() {
    const box = document.getElementById("agent-history");
    if (!box) return;
    const log = chatLog();
    box.replaceChildren();
    if (log.length === 0) {
      box.append(el("p", "task-hint", "还没有对话。问它一句试试，比如「帮我规划这周」。"));
      return;
    }
    log.forEach((entry) => {
      const bubble = el("div", "chat-msg " + (entry.role === "user" ? "is-user" : "is-agent"));
      bubble.append(el("p", "chat-text", entry.text));
      if (entry.at) bubble.append(el("span", "chat-time", String(entry.at).slice(5, 16).replace("T", " ")));
      box.append(bubble);
    });
    box.scrollTop = box.scrollHeight;
  }

  function renderAgentPanel() {
    const setup = document.getElementById("agent-setup");
    const summary = document.getElementById("agent-summary");
    const gate = document.getElementById("agent-gate");
    if (!setup && !summary) return;

    const configured = agentConfigured();
    const editing = state.agent.unlocked || !configured;

    const endpoint = document.getElementById("agent-endpoint");
    if (endpoint) endpoint.value = store.settings.agentEndpoint || "";

    const baseInput = document.getElementById("agent-base");
    if (baseInput) baseInput.value = store.settings.agentBaseUrl || "";

    const modelInput = document.getElementById("agent-model");
    if (modelInput) modelInput.value = store.settings.agentModel || "";

    const keyInput = document.getElementById("agent-key");
    if (keyInput && editing && !keyInput.value) keyInput.value = readAgentKey();

    const rememberBox = document.getElementById("agent-remember-key");
    if (rememberBox) rememberBox.checked = Boolean(store.settings.agentRememberKey);

    // 密码门开着的时候先把表单收起来，过了门再露出来
    if (setup) setup.hidden = !editing || Boolean(state.agent.gate);
    if (summary) summary.hidden = editing || Boolean(state.agent.gate);

    const summaryTitle = document.getElementById("agent-summary-title");
    const summaryDetail = document.getElementById("agent-summary-detail");
    // 连上了就亮个绿灯（没连上是灰的）——一眼能看出助手在不在
    const summaryDot = summary ? summary.querySelector(".task-agent-dot") : null;
    if (summaryDot) {
      summaryDot.classList.toggle("is-on", configured);
      summaryDot.setAttribute("aria-label", configured ? "助手已连接" : "助手还没配置");
    }
    if (summaryTitle) {
      const model = String(store.settings.agentModel || "").trim();
      summaryTitle.textContent = configured
        ? "已连接" + (model ? " · " + model : "")
        : "还没配置助手";
    }
    if (summaryDetail) {
      const pieces = [];
      const base = String(store.settings.agentBaseUrl || "").trim();
      const custom = String(store.settings.agentEndpoint || "").trim();
      if (base) pieces.push(base);
      if (custom) pieces.push("自定义接口 " + custom);
      pieces.push(readAgentKey() ? "密钥已保存" : "无密钥");
      if (hasAgentPassword()) pieces.push("已设密码");
      // 本机后端在跑的话，模型请求可以由它代发（绕开跨域），卡上顺带说一句
      if (window.spasreBackend && window.spasreBackend.online) pieces.push("本机后端在线");
      if (store.settings.agentVerifiedAt) pieces.push("验证于 " + String(store.settings.agentVerifiedAt).slice(0, 16).replace("T", " "));
      summaryDetail.textContent = pieces.join(" · ");
    }

    const collapseButton = document.getElementById("agent-collapse");
    if (collapseButton) collapseButton.hidden = !configured || !state.agent.unlocked;

    if (gate) gate.hidden = !state.agent.gate;
    const setting = state.agent.gate === "set";
    const confirmField = document.getElementById("agent-pw-confirm-field");
    if (confirmField) confirmField.hidden = !setting;
    if (!state.agent.gate) {
      // 门关着就把密码框清空，免得残留上一次的输入
      ["agent-password", "agent-password-confirm"].forEach((id) => {
        const input = document.getElementById(id);
        if (input) input.value = "";
      });
    }
    if (state.agent.gate) {
      const hint = document.getElementById("agent-gate-hint");
      const label = document.getElementById("agent-pw-label");
      const submit = document.getElementById("agent-gate-submit");
      if (hint) {
        hint.textContent = setting
          ? "第一次进设置，先定一个密码。以后改这些设置都要先输它，密码只在本机保存哈希值。"
          : "改这些设置要先输密码。";
      }
      if (label) label.textContent = setting ? "设置密码" : "密码";
      if (submit) submit.textContent = setting ? "保存密码并继续" : "解锁";
      const passwordInput = document.getElementById("agent-password");
      if (passwordInput && typeof passwordInput.focus === "function") passwordInput.focus();
    }
  }

  async function submitAgentGate() {
    const passwordInput = document.getElementById("agent-password");
    const confirmInput = document.getElementById("agent-password-confirm");
    const status = document.getElementById("agent-gate-status");
    const password = passwordInput ? passwordInput.value : "";
    const fail = (message) => {
      if (status) status.textContent = message;
      if (passwordInput) passwordInput.value = "";
    };

    if (status) status.textContent = "处理中…";
    try {
      if (!hasAgentPassword()) {
        if (password.length < AGENT_PASSWORD_MIN) {
          fail("密码至少 " + AGENT_PASSWORD_MIN + " 位。");
          return;
        }
        if (password !== (confirmInput ? confirmInput.value : "")) {
          fail("两次输入不一样。");
          return;
        }
        const salt = newSalt();
        const hash = await hashPassword(password, salt);
        updateSettings({ agentPasswordSalt: salt, agentPasswordHash: hash });
      } else {
        const hash = await hashPassword(password, store.settings.agentPasswordSalt);
        if (hash !== store.settings.agentPasswordHash) {
          fail("密码不对。");
          return;
        }
      }
      state.agent.unlocked = true;
      state.agent.gate = "";
      if (passwordInput) passwordInput.value = "";
      if (confirmInput) confirmInput.value = "";
      if (status) status.textContent = "";
      renderAll();
    } catch (error) {
      if (status) status.textContent = String(error.message || error);
    }
  }

  function downloadAgentEnv() {
    const blob = new Blob([agentEnvText()], { type: "text/plain;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = AGENT_ENV_FILE;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    return AGENT_ENV_FILE;
  }

  function renderBoardTabs() {
    const scopeBar = document.getElementById("task-scope");
    if (scopeBar) {
      scopeBar.replaceChildren();
      [["all", "全部"], ["today", "今天"], ["overdue", "逾期"]].forEach((entry) => {
        const tab = el("button", "task-tab", entry[1]);
        tab.type = "button";
        tab.dataset.action = "scope";
        tab.dataset.scope = entry[0];
        const active = state.board.scope === entry[0];
        tab.setAttribute("aria-pressed", String(active));
        if (active) tab.classList.add("is-active");
        scopeBar.append(tab);
      });
    }

    const viewBar = document.getElementById("task-view");
    if (viewBar) {
      viewBar.replaceChildren();
      [["active", "任务"], ["trash", "回收站"]].forEach((entry) => {
        const tab = el("button", "task-tab", entry[1]);
        tab.type = "button";
        tab.dataset.action = "view";
        tab.dataset.view = entry[0];
        const active = state.board.view === entry[0];
        tab.setAttribute("aria-pressed", String(active));
        if (active) tab.classList.add("is-active");
        if (entry[0] === "trash" && store.trash.length > 0) tab.textContent = "回收站（" + store.trash.length + "）";
        viewBar.append(tab);
      });
    }

    const activePanel = document.getElementById("task-active-panel");
    const trashPanel = document.getElementById("task-trash-panel");
    if (activePanel) activePanel.hidden = state.board.view !== "active";
    if (trashPanel) trashPanel.hidden = state.board.view !== "trash";
  }

  function renderBoardList() {
    const groups = document.getElementById("task-groups");
    if (!groups) return;
    groups.replaceChildren();

    const filterCategory = state.board.category;
    const filterUrgency = state.board.urgency;
    const scope = state.board.scope;

    let list = activeTasks(filterCategory);
    if (filterUrgency !== "all") list = list.filter((task) => task.urgency === filterUrgency);
    if (scope === "today") list = list.filter((task) => bucketOf(task) === "today");
    if (scope === "overdue") list = list.filter((task) => bucketOf(task) === "overdue");

    if (list.length === 0) {
      groups.append(emptyNote("这里还没有任务。用上面的表单添加一个，或者换个筛选条件看看。"));
      return;
    }

    const buckets = scope === "all" ? BUCKETS : BUCKETS.filter((entry) => entry[0] === scope);
    let depth = 0;
    buckets.forEach((entry) => {
      const bucketTasks = list.filter((task) => bucketOf(task) === entry[0]);
      if (bucketTasks.length === 0) return;
      const section = el("section", "task-group");
      const heading = el("h3", "task-group-title");
      heading.append(el("span", null, entry[1]), el("span", "task-group-count", String(bucketTasks.length)));
      section.append(heading);
      const items = el("ul", "task-list");
      bucketTasks.forEach((task) => {
        items.append(taskItem(task, { depth: depth }));
        depth += 1;
      });
      section.append(items);
      groups.append(section);
    });
  }

  function renderTrash() {
    const panel = document.getElementById("task-trash-panel");
    if (!panel) return;
    const list = document.getElementById("task-trash-list");
    const summary = document.getElementById("task-trash-summary");
    const clearButton = document.getElementById("task-trash-clear");

    if (summary) {
      summary.textContent =
        store.trash.length === 0
          ? "回收站是空的。点任务旁边的小狗，任务就会被叼到这里。"
          : "回收站里有 " + store.trash.length + " 个任务，可以恢复，也可以永久清除。";
    }
    if (clearButton) clearButton.disabled = store.trash.length === 0;
    if (!list) return;

    list.replaceChildren();
    if (store.trash.length === 0) return;

    store.trash.forEach((task) => {
      const item = el("li", "task-item task-item-trash");
      item.dataset.id = task.id;
      const body = el("div", "task-body");
      body.append(el("span", "task-title", task.title));
      body.append(taskMeta(task));
      body.append(
        task.trashReason === "removed" ? chip("已删除", "chip-removed") : chip("已完成", "chip-done")
      );
      item.append(body);

      const actions = el("div", "task-actions");
      const restore = el("button", "task-action", "恢复");
      restore.type = "button";
      restore.dataset.action = "restore";
      restore.dataset.id = task.id;
      const purge = el("button", "task-action task-action-danger", "永久清除");
      purge.type = "button";
      purge.dataset.action = "purge";
      purge.dataset.id = task.id;
      actions.append(restore, purge);
      item.append(actions);
      list.append(item);
    });
  }

  function fillForm(task) {
    const form = document.getElementById("task-add-form");
    if (!form) return;
    form.elements.title.value = task ? task.title : "";
    form.elements.category.value = task ? task.category : store.settings.defaultCategory;
    form.elements.urgency.value = task ? task.urgency : "normal";
    form.elements.date.value = task ? task.date || "" : todayKey();
    if (form.elements.categoryNew) form.elements.categoryNew.value = "";
    const freshField = document.getElementById("task-category-new-field");
    if (freshField) freshField.hidden = true;
    const submit = form.querySelector("[type=submit]");
    if (submit) submit.textContent = task ? "保存修改" : "添加任务";
    const cancel = document.getElementById("task-add-cancel");
    if (cancel) cancel.hidden = !task;
    state.board.editingId = task ? task.id : "";
  }

  /* ---------- 助手：内置规划 ---------- */

  const WEEKDAY_INDEX = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  const PLAN_LEAD = /^(?:请|麻烦|帮忙)?(?:帮我|帮忙|给我)?\s*(?:规划|安排|拆分|拆解|排一下|排个|列出|列一下)\s*(?:一下|下)?\s*[:：,，、]?\s*/;
  const DATE_LEAD = /^(?:大后天|后天|明天|明日|今天|今日|今晚|本周|这周|这星期|本星期|下周|下星期|下礼拜|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\d{4}\s*[-\/年.]\s*\d{1,2}\s*[-\/月.]\s*\d{1,2}|\d{1,2}\s*[-\/月]\s*\d{1,2}\s*[日号]?)\s*[，,、:：的]?\s*/;
  const URGENCY_LEAD = /^(?:紧急|很急|重要|不急|优先|尽快|马上|立刻)\s*[:：,，]\s*/;
  const QUESTION_HINT = /[?？]|吗|什么|哪些|多少|几个|怎么样|状态|进度|看看|看一下|列一下|列出|统计|有哪|有没有|有没|是否|情况|概览|总结|还剩|剩下|还有/;
  const PLAN_HINT = /规划|安排|拆解|拆分|添加|加进|新建|记一下|提醒我|排一下/;

  function shiftDay(base, offset) {
    return todayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset));
  }

  function resolveDate(text, base) {
    const now = base || new Date();
    let match = text.match(/(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/);
    if (match) return todayKey(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    match = text.match(/(\d{1,2})\s*[-\/月]\s*(\d{1,2})\s*[日号]?/);
    if (match) {
      const month = Number(match[1]);
      const day = Number(match[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return todayKey(new Date(now.getFullYear(), month - 1, day));
      }
    }
    if (/大后天/.test(text)) return shiftDay(now, 3);
    if (/后天/.test(text)) return shiftDay(now, 2);
    if (/明天|明日|明早|明晚/.test(text)) return shiftDay(now, 1);
    if (/今天|今日|今晚|当天/.test(text)) return todayKey(now);

    const nextWeek = /下(?:个)?(?:周|星期|礼拜)/.test(text);
    const thisWeek = /(?:本|这)(?:个)?(?:周|星期|礼拜)/.test(text);
    const weekday = text.match(/(?:下(?:个)?|本|这(?:个)?)?(?:周|星期|礼拜)\s*([一二三四五六日天])/);
    if (weekday) {
      let diff = (WEEKDAY_INDEX[weekday[1]] - now.getDay() + 7) % 7;
      if (nextWeek) diff = diff === 0 ? 7 : diff + 7;
      return shiftDay(now, diff);
    }
    if (nextWeek) return shiftDay(now, ((7 - now.getDay()) % 7) + 7);
    if (thisWeek) return shiftDay(now, (7 - now.getDay()) % 7);
    return "";
  }

  function resolveUrgency(text) {
    if (/不急|有空|随缘|闲了|之后再说/.test(text)) return "low";
    if (/紧急|很急|急用|马上|立刻|立即|尽快|赶紧|优先做/.test(text)) return "urgent";
    if (/重要|优先|务必|关键/.test(text)) return "high";
    return "normal";
  }

  function resolveCategory(text) {
    let best = "";
    categories().forEach((name) => {
      if (name !== DAILY_CATEGORY && name.length >= best.length && text.includes(name)) best = name;
    });
    return best;
  }

  function splitPlanItems(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[；;]/g, "\n")
      .replace(/(^|\s)\d{1,2}\s*[.、)）]\s+/g, "\n")
      .replace(/^\s*[-*•·—–]\s+/gm, "")
      .split(/\n|。|！|!/)
      .map((part) => {
        const cleaned = part
          .replace(PLAN_LEAD, "")
          .replace(/^[:：,，、]+/, "")
          .replace(/[:：,，、;；]+$/, "")
          .trim();
        const withoutDate = cleaned.replace(DATE_LEAD, "").replace(URGENCY_LEAD, "").trim();
        return { title: withoutDate.length >= 2 ? withoutDate : cleaned, raw: cleaned };
      })
      .filter((item) => item.title.length >= 2);
  }

  function localPlan(prompt) {
    const text = String(prompt || "").trim();
    const items = splitPlanItems(text);
    // 日期 / 紧急程度 / 分类写在开头（列表之前）时，当作整段共享的条件。
    const shell = text.split(/\n|；|;|。|！|!/)[0] || "";
    const sharedDate = resolveDate(shell);
    const sharedUrgency = resolveUrgency(shell);
    const sharedCategory = resolveCategory(shell);
    const seen = [];
    const plans = [];
    items.forEach((item) => {
      if (seen.includes(item.title)) return;
      seen.push(item.title);
      const urgency = resolveUrgency(item.raw);
      plans.push({
        title: item.title,
        category: resolveCategory(item.raw) || sharedCategory || store.settings.defaultCategory,
        urgency: urgency === "normal" ? sharedUrgency : urgency,
        date: resolveDate(item.raw) || sharedDate
      });
    });
    return plans;
  }

  function looksLikeQuestion(text) {
    return QUESTION_HINT.test(text) && !PLAN_HINT.test(text);
  }

  function describeTask(task) {
    const bits = [task.category, URGENCY_LABEL[task.urgency] || URGENCY_LABEL.normal];
    if (task.date) bits.push(task.date);
    return "・" + task.title + "（" + bits.join("・") + "）";
  }

  function describeList(list, limit) {
    const shown = list.slice(0, limit).map(describeTask);
    if (list.length > shown.length) shown.push("…还有 " + (list.length - shown.length) + " 条");
    return shown.join("\n");
  }

  function localAnswer(prompt) {
    const text = String(prompt || "");
    const active = sortTasks(store.tasks);
    const today = todayKey();
    const overdue = active.filter((task) => task.date && dayDiff(task.date) < 0);
    const todays = active.filter((task) => task.date === today);
    const tomorrows = active.filter((task) => task.date && dayDiff(task.date) === 1);
    const week = active.filter((task) => task.date && dayDiff(task.date) >= 0 && dayDiff(task.date) <= 7);

    if (/回收站|删掉|删除|已完成/.test(text)) {
      if (store.trash.length === 0) return "回收站是空的。";
      return "回收站里有 " + store.trash.length + " 条：\n" + describeList(store.trash, 6) + "\n可以恢复，也可以永久清除。";
    }
    if (/分类|几类|哪些类/.test(text)) {
      return "现有分类：" + categories().join("、") + "。";
    }
    if (/紧急|重要|优先/.test(text)) {
      const hot = active.filter((task) => task.urgency === "urgent" || task.urgency === "high");
      if (hot.length === 0) return "没有标记为紧急或重要的任务。";
      return "紧急或重要的有 " + hot.length + " 条：\n" + describeList(hot, 6);
    }
    if (/逾期|过期|超期|拖了/.test(text)) {
      if (overdue.length === 0) return "没有逾期的任务。";
      return "逾期 " + overdue.length + " 条：\n" + describeList(overdue, 6);
    }
    if (/明天|明日/.test(text)) {
      if (tomorrows.length === 0) return "明天没有排任务。";
      return "明天有 " + tomorrows.length + " 条：\n" + describeList(tomorrows, 6);
    }
    if (/今天|今日|当天/.test(text)) {
      if (todays.length === 0) return "今天没有排任务，未完成一共 " + active.length + " 条。";
      return "今天有 " + todays.length + " 条：\n" + describeList(todays, 6);
    }
    if (/本周|这周|这星期|一周|七天/.test(text)) {
      if (week.length === 0) return "本周内（含今天）没有排任务。";
      return "本周内有 " + week.length + " 条：\n" + describeList(week, 8);
    }
    if (/多少|几个|数量|统计/.test(text)) {
      return (
        "未完成 " + active.length + " 条，其中今天 " + todays.length + " 条、逾期 " + overdue.length +
        " 条、本周内 " + week.length + " 条；回收站 " + store.trash.length + " 条。"
      );
    }

    const lines = ["未完成 " + active.length + " 条，今天 " + todays.length + " 条，逾期 " + overdue.length + " 条。"];
    if (active.length === 0) {
      lines.push("任务板是空的。可以直接加一条，或者写一句话让我拆成几条。");
      return lines.join("\n");
    }
    if (overdue.length > 0) lines.push("逾期：\n" + describeList(overdue, 3));
    if (todays.length > 0) lines.push("今天：\n" + describeList(todays, 5));
    if (overdue.length === 0 && todays.length === 0) lines.push("接下来：\n" + describeList(active, 5));
    return lines.join("\n");
  }

  /* ---------- 助手：接口调用 ---------- */

  /* ---------- model api (openai compatible) ---------- */

  function agentChatUrl(base) {
    const trimmed = String(base || "").trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    if (/\/chat\/completions$/.test(trimmed)) return trimmed;
    return trimmed + "/chat/completions";
  }

  function agentSystemPrompt() {
    const today = todayKey();
    const weekday = "日一二三四五六"[new Date().getDay()];
    const names = categories();
    const existing = store.tasks.map((task) => task.title).slice(0, 60);
    return [
      "你是一个任务规划助手，把用户说的话拆成可执行的任务。",
      "今天是 " + today + "（星期" + weekday + "）。",
      "category 必须从这些里选一个：" + names.join("、") + "；拿不准就用 " + store.settings.defaultCategory + "。",
      "urgency 只能是 urgent / high / normal / low 之一，分别代表紧急 / 重要 / 普通 / 不急。",
      "date 用 YYYY-MM-DD，只在确实和日期有关时才给，今天就是 " + today + "；不确定就省略这个字段。",
      "已经有这些任务，不要重复添加：" + (existing.length > 0 ? existing.join("；") : "（还没有）"),
      "如果用户是在问问题（例如今天有什么任务、这周该怎么安排），就把回答写进 reply，不要凭空造任务。",
      "不要给资料链接：阅读资料由界面上的「延伸阅读」按标题现找（那边会验证链接能不能打开），links 一律给空数组。",
      '只输出一个 JSON 对象，不要写解释，也不要用 markdown 代码块。格式是：{"reply": "给用户看的一两句话", "tasks": [{"title": "任务标题", "category": "分类", "urgency": "normal", "date": "YYYY-MM-DD", "links": []}]}',
      "没有新任务时 tasks 就是空数组。"
    ].join("\n");
  }

  function extractJson(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1].trim() : raw;
    try {
      return JSON.parse(body);
    } catch (error) {
      /* 模型爱在 JSON 前后加话，下面按括号截取 */
    }
    const candidates = [
      [body.indexOf("{"), body.lastIndexOf("}")],
      [body.indexOf("["), body.lastIndexOf("]")]
    ];
    for (const pair of candidates) {
      if (pair[0] === -1 || pair[1] <= pair[0]) continue;
      try {
        return JSON.parse(body.slice(pair[0], pair[1] + 1));
      } catch (error) {
        /* 试下一种 */
      }
    }
    return null;
  }

  function normalizePlan(list) {
    const allowed = categories();
    return (Array.isArray(list) ? list : [])
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const title = String(item.title || item.name || "").trim();
        if (!title) return null;
        const date = String(item.date || "").trim();
        return {
          title: title,
          category: allowed.includes(item.category) ? item.category : store.settings.defaultCategory,
          urgency: URGENCY_KEYS.includes(item.urgency) ? item.urgency : "normal",
          date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
          links: normalizeLinks(item.links)
        };
      })
      .filter(Boolean);
  }

  function agentHttpMessage(status, detail) {
    const tail = detail ? "：" + detail : "";
    if (status === 401 || status === 403) return "密钥不对或者没权限（" + status + "）" + tail;
    if (status === 404) return "接口地址不对（404），根路径一般要带 /v1" + tail;
    if (status === 429) return "请求太频繁，或者额度用完了（429）" + tail;
    if (status === 400) return "请求被接口拒绝（400）" + tail;
    if (status >= 500) return "接口自己出错了（" + status + "）" + tail;
    return "接口返回 " + status + tail;
  }

  // 浏览器直连被跨域挡住时，让本机后端（server.py，跟页面同一个 origin）代发一次。
  // 后端不在就直接返回 null，交给原来的报错逻辑。
  async function bridgeChat(body) {
    const bridge = window.spasreBackend;
    if (!bridge || !bridge.online || typeof bridge.chat !== "function") return null;
    if (!Array.isArray(body.messages)) return null;
    try {
      const reply = await bridge.chat(null, {
        messages: body.messages,
        temperature: body.temperature,
        max_tokens: body.max_tokens
      });
      return typeof reply === "string" && reply.trim() ? reply : null;
    } catch (error) {
      return null;
    }
  }

  // 本机没存密钥时等后端就绪：页面往往比后端先跑起来（探活还没回来），
  // 这时候直接走直连就是拿空密钥撞远端接口，必然 401。
  function waitForBridge(timeoutMs) {
    const bridge = window.spasreBackend;
    if (!bridge) return Promise.resolve(null);
    if (bridge.online) return Promise.resolve(bridge);
    return new Promise((resolve) => {
      const deadline = Date.now() + (timeoutMs || 5000);
      const timer = window.setInterval(() => {
        if (bridge.online || Date.now() > deadline) {
          window.clearInterval(timer);
          resolve(bridge.online ? bridge : null);
        }
      }, 250);
    });
  }

  async function agentFetch(body) {
    const url = agentChatUrl(store.settings.agentBaseUrl);
    if (!url) throw new Error("先把模型接口地址填上。");
    const model = String(store.settings.agentModel || "").trim();
    if (!model) throw new Error("把模型名填上，比如 deepseek-chat。");

    const headers = { "Content-Type": "application/json" };
    const key = readAgentKey();
    if (key) headers.Authorization = "Bearer " + key;
    // 本机没存密钥（比如从手机打开，密钥只留在电脑上）就让后端代发：
    // 拿空密钥去撞远端接口只会撞回一个 401。
    if (!key) {
      await waitForBridge(5000);
      const bridged = await bridgeChat(body);
      if (bridged !== null) return bridged;
    }

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? window.setTimeout(() => controller.abort(), AGENT_TIMEOUT) : 0;
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: headers,
        signal: controller ? controller.signal : undefined,
        body: JSON.stringify(Object.assign({ model: model }, body))
      });
    } catch (error) {
      if (controller && error && error.name === "AbortError") throw new Error("请求超时了，模型太慢或者地址不通。");
      const bridged = await bridgeChat(body);
      if (bridged !== null) return bridged;
      throw new Error(
        "连不上接口：地址写错了、网络不通，或者这家接口不允许网页直连（跨域 CORS）。可以换本地 Ollama，或者把地址指向自己的代理。"
      );
    } finally {
      if (timer) window.clearTimeout(timer);
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload && payload.error ? payload.error.message || payload.error.type : "";
      throw new Error(agentHttpMessage(response.status, detail));
    }
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const content = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
    if (!content.trim()) throw new Error("模型没有返回内容。");
    return content;
  }

  async function askAgent(text) {
    const content = await agentFetch({
      temperature: 0.2,
      messages: [
        { role: "system", content: agentSystemPrompt() },
        { role: "user", content: text }
      ]
    });

    const parsed = extractJson(content);
    const plan = normalizePlan(parsed ? (Array.isArray(parsed) ? parsed : parsed.tasks) : null);
    const added = addPlanned(plan);
    const remoteReply = parsed && typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    let reply = remoteReply;
    if (!reply) reply = added.length > 0 ? "助手添加了 " + added.length + " 个任务。" : "助手没有返回新任务。";
    if (added.length > 0) reply += "\n" + describeList(added, 10);
    return { source: "api", reply, added };
  }

  async function testAgent() {
    const model = String(store.settings.agentModel || "").trim();
    await agentFetch({
      max_tokens: 8,
      temperature: 0,
      messages: [{ role: "user", content: "ping" }]
    });
    return "连接正常，" + model + " 可以用了。";
  }

  // 低层入口：自己拼 messages，拿回模型的正文。目标页规划计划时用它。
  async function agentChat(messages, options) {
    const config = options || {};
    const body = { temperature: config.temperature === undefined ? 0.2 : config.temperature, messages: messages };
    if (config.maxTokens) body.max_tokens = config.maxTokens;
    return agentFetch(body);
  }

  function addPlanned(list) {
    const added = [];
    const known = store.tasks.map((task) => String(task.title).trim());
    (list || []).forEach((item) => {
      if (!item || !item.title) return;
      if (known.includes(String(item.title).trim())) return;
      const task = createTask({
        title: item.title,
        category: item.category || store.settings.defaultCategory,
        urgency: item.urgency,
        date: item.date,
        links: item.links,
        source: "agent"
      });
      if (task) {
        added.push(task);
        known.push(String(task.title).trim());
      }
    });
    if (added.length > 0) renderAll();
    return added;
  }

  async function askRemote(text) {
    const response = await fetch(String(store.settings.agentEndpoint).trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        today: todayKey(),
        categories: categories(),
        tasks: store.tasks.map((task) => ({
          title: task.title,
          category: task.category,
          urgency: task.urgency,
          date: task.date
        }))
      })
    });
    if (!response.ok) throw new Error("接口返回 " + response.status);
    const data = await response.json();
    const incoming = Array.isArray(data) ? data : Array.isArray(data && data.tasks) ? data.tasks : [];
    const added = addPlanned(incoming);
    const remoteReply = data && typeof data.reply === "string" ? data.reply.trim() : "";
    let reply = remoteReply;
    if (!reply) reply = added.length > 0 ? "助手添加了 " + added.length + " 个任务。" : "助手没有返回新任务。";
    return { source: "remote", reply, added };
  }

  async function ask(prompt) {
    const text = String(prompt || "").trim();
    if (!text) throw new Error("先写点想做的事，或者想问的问题。");
    if (String(store.settings.agentBaseUrl || "").trim()) return askAgent(text);
    if (String(store.settings.agentEndpoint || "").trim()) return askRemote(text);

    if (looksLikeQuestion(text)) {
      return { source: "local", reply: localAnswer(text), added: [] };
    }
    const added = addPlanned(localPlan(text));
    if (added.length === 0) {
      return {
        source: "local",
        reply: "没看明白要做什么。一条一条写会更准：用换行、分号或「1. 2. 3.」分开。",
        added
      };
    }
    const dated = added.filter((task) => task.date).length;
    const reply =
      "内置规划加了 " + added.length + " 个任务" + (dated > 0 ? "，其中 " + dated + " 条带日期" : "") + "：\n" +
      describeList(added, 10) +
      "\n（想换成自己的模型，把接口地址填上就行。）";
    return { source: "local", reply, added };
  }

  async function requestPlan(prompt) {
    const result = await ask(prompt);
    return result.added;
  }

  /* ---------- 新建 / 编辑任务弹层 ---------- */

  function openTaskSheet(task) {
    const sheet = document.getElementById("task-sheet");
    if (!sheet) return;
    fillForm(task || null);
    const title = document.getElementById("task-sheet-title");
    if (title) title.textContent = task ? "编辑任务" : "新建任务";
    sheet.hidden = false;
    const form = document.getElementById("task-add-form");
    if (form && form.elements.title) form.elements.title.focus();
  }

  function closeTaskSheet() {
    const sheet = document.getElementById("task-sheet");
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    fillForm(null);
  }

  function wireTaskSheet() {
    const fab = document.getElementById("fab-new-task");
    if (fab) fab.addEventListener("click", () => openTaskSheet(null));
    const sheet = document.getElementById("task-sheet");
    if (!sheet) return;
    sheet.addEventListener("click", (event) => {
      if (event.target === sheet || event.target.closest("[data-sheet-close]")) closeTaskSheet();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !sheet.hidden) closeTaskSheet();
    });
  }

  /* ---------- wiring ---------- */

  function renderAll() {
    renderHome();
    renderBoard();
    renderSettingsAreas();
    renderAgentPanel();
    renderChat();
    // 目标页挂在同一个 store 上，改完数据广播一声让它自己重画。
    if (typeof document.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
      document.dispatchEvent(new window.CustomEvent("spasre:change"));
    }
  }

  function handleAction(event) {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    const action = trigger.dataset.action;
    const id = trigger.dataset.id;

    if (action === "task-slot") {
      // 去日程表页挑时间；已经排好的就定位到它所在的那一周 / 那一天
      const task = store.tasks.find((item) => item.id === id);
      planTask(id, !(task && task.slot));
      const url = "schedule.html?task=" + encodeURIComponent(id);
      const go = () => {
        window.location.href = url;
      };
      // 先推后端再跳，不然刚打的「加入日程表」标记还没发出去就被新页面那份旧数据盖掉
      if (window.spasreTasks && typeof window.spasreTasks.flush === "function") {
        Promise.resolve(window.spasreTasks.flush()).then(go, go);
      } else {
        go();
      }
      return;
    }

    if (action === "complete" && completeTask(id, "done")) {
      renderAll();
    } else if (action === "remove" && completeTask(id, "removed")) {
      renderAll();
    } else if (action === "restore" && restoreTask(id)) {
      renderAll();
    } else if (action === "purge" && purgeTask(id)) {
      renderAll();
    } else if (action === "edit") {
      const task = store.tasks.find((item) => item.id === id);
      if (task) openTaskSheet(task);
    } else if (action === "task-note") {
      const task = store.tasks.concat(store.trash).find((item) => item.id === id);
      // 跳走之前先把手上的改动推上去，不然新页面拉回旧的那份
      const go = () => openNote({ taskId: id, title: task ? task.title : "", category: "随手记" });
      if (typeof flushRemote === "function") Promise.resolve(flushRemote()).then(go, go);
      else go();
    } else if (action === "open-links") {
      const task = store.tasks.find((item) => item.id === id);
      if (task) openLinkDialog(task);
    } else if (action === "scope") {
      state.board.scope = trigger.dataset.scope;
      saveBoardView();
      renderBoard();
    } else if (action === "view") {
      state.board.view = trigger.dataset.view;
      saveBoardView();
      renderBoard();
    } else if (action === "remove-interest") {
      const name = trigger.dataset.interest;
      // 自动记下的那份也一起删掉，免得两边对不上
      updateSettings({
        interests: interestList().filter((item) => item !== name),
        autoInterests: autoInterestList().filter((item) => item !== name)
      });
      renderBoard();
      renderInterests();
    } else if (action === "clear-chat") {
      clearChat();
      setAgentStatus("聊天记录清掉了。");
    } else if (action === "reroll-daily") {
      rerollDaily().catch(() => {});
    }
  }

  function wireHome() {
    // 今日任务和每日推荐是两块，两边都可能有可点的按钮
    ["home-today", "home-daily"].forEach((id) => {
      const box = document.getElementById(id);
      if (box) box.addEventListener("click", handleAction);
    });
  }

  function wireBoard() {
    // 任务页绑在任务板容器上；设置页没有那个容器（设置区在那边），退回文档级委托。
    // 下面每个元素都是按 id 找、找不到就跳过，所以同一个函数两页都能用。
    const root = document.getElementById("task-board") || document;

    root.addEventListener("click", handleAction);

    const clearButton = document.getElementById("task-trash-clear");
    if (clearButton) {
      clearButton.addEventListener("click", () => {
        if (window.confirm("永久清除回收站里的全部任务？此操作不可恢复。")) {
          emptyTrash();
          renderAll();
        }
      });
    }

    const addForm = document.getElementById("task-add-form");
    if (addForm) {
      addForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const picked = addForm.elements.category.value;
        const typed = String((addForm.elements.categoryNew && addForm.elements.categoryNew.value) || "").trim();
        const values = {
          title: addForm.elements.title.value,
          category: picked === NEW_CATEGORY ? typed || store.settings.defaultCategory : picked,
          urgency: addForm.elements.urgency.value,
          date: addForm.elements.date.value
        };
        if (state.board.editingId) {
          updateTask(state.board.editingId, values);
        } else {
          createTask(values);
        }
        renderAll();
        closeTaskSheet();
      });
    }

    // 分类选了「＋ 新分类…」才露出输入框
    const categoryPicker = document.getElementById("task-category");
    if (categoryPicker) {
      categoryPicker.addEventListener("change", () => {
        const freshField = document.getElementById("task-category-new-field");
        const picking = categoryPicker.value === NEW_CATEGORY;
        if (freshField) freshField.hidden = !picking;
        const typed = document.getElementById("task-category-new");
        if (picking && typed) typed.focus();
      });
    }

    const cancel = document.getElementById("task-add-cancel");
    if (cancel) {
      cancel.addEventListener("click", closeTaskSheet);
    }

    wireTaskSheet();

    // 每日推荐的开关（放兴趣标签那块）
    const dailyToggle = document.getElementById("daily-recommend-toggle");
    if (dailyToggle) {
      dailyToggle.addEventListener("change", () => {
        setDailyRecommendation(dailyToggle.checked);
        renderDailySwitch();
      });
    }

    // 「把每日推荐排进日程表」：打开时顺手把今天已经生成的那条也排一下
    const dailySchedule = document.getElementById("daily-schedule-toggle");
    if (dailySchedule) {
      dailySchedule.addEventListener("change", () => {
        setDailyAutoSchedule(dailySchedule.checked);
        renderDailySwitch();
      });
    }

    const interestInput = document.getElementById("interest-input");
    const interestAdd = document.getElementById("interest-add");
    const addInterest = () => {
      const value = String((interestInput && interestInput.value) || "").trim();
      if (!value) return;
      const list = store.settings.interests || [];
      if (!list.includes(value)) updateSettings({ interests: list.concat([value]) });
      if (interestInput) interestInput.value = "";
      // 设置页没有 #task-board，renderBoard 进去就返回了：标签这块得自己重画
      renderInterests();
      renderBoard();
    };
    if (interestAdd) interestAdd.addEventListener("click", addInterest);
    if (interestInput) {
      interestInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addInterest();
        }
      });
    }

    const filterCategory = document.getElementById("task-filter-category");
    if (filterCategory) {
      filterCategory.addEventListener("change", () => {
        state.board.category = filterCategory.value;
        saveBoardView();
        renderBoardList();
      });
    }

    const filterUrgency = document.getElementById("task-filter-urgency");
    if (filterUrgency) {
      filterUrgency.addEventListener("change", () => {
        state.board.urgency = filterUrgency.value;
        saveBoardView();
        renderBoardList();
      });
    }

    const endpoint = document.getElementById("agent-endpoint");
    if (endpoint) {
      endpoint.addEventListener("change", () => {
        updateSettings({ agentEndpoint: endpoint.value.trim() });
        if (endpoint.value.trim()) updateSettings({ agentSetupDone: true });
        renderAll();
      });
    }

    const baseInput = document.getElementById("agent-base");
    if (baseInput) {
      baseInput.addEventListener("change", () => updateSettings({ agentBaseUrl: baseInput.value.trim() }));
    }

    const modelInput = document.getElementById("agent-model");
    if (modelInput) {
      modelInput.addEventListener("change", () => updateSettings({ agentModel: modelInput.value.trim() }));
    }

    const keyInput = document.getElementById("agent-key");
    if (keyInput) {
      keyInput.addEventListener("change", () => {
        store.settings.agentApiKey = store.settings.agentRememberKey ? keyInput.value.trim() : "";
        writeAgentKey(keyInput.value);
      });
    }

    const rememberBox = document.getElementById("agent-remember-key");
    if (rememberBox) {
      rememberBox.addEventListener("change", () => {
        updateSettings({ agentRememberKey: rememberBox.checked });
        writeAgentKey(keyInput ? keyInput.value : "");
      });
    }

    const testButton = document.getElementById("agent-test");
    if (testButton) {
      testButton.addEventListener("click", async () => {
        const status = document.getElementById("agent-status");
        if (baseInput) updateSettings({ agentBaseUrl: baseInput.value.trim() });
        if (modelInput) updateSettings({ agentModel: modelInput.value.trim() });
        writeAgentKey(keyInput ? keyInput.value : "");
        if (testButton.disabled) return;
        testButton.disabled = true;
        if (status) status.textContent = "正在测试连接…";
        try {
          const message = await testAgent();
          // 测试过了就把凭据收起来，避免一直摊在页面上
          updateSettings({ agentSetupDone: true, agentVerifiedAt: new Date().toISOString() });
          state.agent.unlocked = false;
          state.agent.gate = "";
          if (status) status.textContent = message + " 凭据已收好，要改点「设置」。";
          renderAll();
        } catch (error) {
          if (status) status.textContent = String(error.message || error);
        } finally {
          testButton.disabled = false;
        }
      });
    }

    const collapseButton = document.getElementById("agent-collapse");
    if (collapseButton) {
      collapseButton.addEventListener("click", () => {
        state.agent.unlocked = false;
        state.agent.gate = "";
        renderAll();
      });
    }

    const editButton = document.getElementById("agent-edit");
    if (editButton) {
      editButton.addEventListener("click", () => {
        state.agent.gate = hasAgentPassword() ? "enter" : "set";
        const status = document.getElementById("agent-gate-status");
        if (status) status.textContent = "";
        renderAgentPanel();
      });
    }

    const gateSubmit = document.getElementById("agent-gate-submit");
    if (gateSubmit) {
      gateSubmit.addEventListener("click", () => {
        submitAgentGate();
      });
    }

    const gateCancel = document.getElementById("agent-gate-cancel");
    if (gateCancel) {
      gateCancel.addEventListener("click", () => {
        state.agent.gate = "";
        const passwordInput = document.getElementById("agent-password");
        const confirmInput = document.getElementById("agent-password-confirm");
        if (passwordInput) passwordInput.value = "";
        if (confirmInput) confirmInput.value = "";
        renderAll();
      });
    }

    ["agent-password", "agent-password-confirm"].forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitAgentGate();
        }
      });
    });

    const exportButton = document.getElementById("agent-export");
    if (exportButton) {
      exportButton.addEventListener("click", () => {
        const status = document.getElementById("agent-status");
        const name = downloadAgentEnv();
        if (status) status.textContent = "已导出 " + name + "，存到本地后可以改名叫 .env（.gitignore 已经忽略，不会提交）。";
      });
    }

    const importButton = document.getElementById("agent-import");
    const importFile = document.getElementById("agent-import-file");
    if (importButton && importFile) {
      importButton.addEventListener("click", () => importFile.click());
      importFile.addEventListener("change", async () => {
        const status = document.getElementById("agent-status");
        const file = importFile.files && importFile.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const ok = applyAgentEnv(parseAgentEnv(text));
          if (status) status.textContent = ok ? "已从 " + file.name + " 读入配置。" : "读到了文件，但里面没有完整的接口地址和模型名。";
        } catch (error) {
          if (status) status.textContent = "读不了这个文件：" + String(error.message || error);
        } finally {
          importFile.value = "";
          renderAll();
        }
      });
    }

    const runButton = document.getElementById("agent-run");
    if (runButton) {
      runButton.addEventListener("click", async () => {
        const status = document.getElementById("agent-status");
        const prompt = document.getElementById("agent-prompt");
        updateSettings({ agentEndpoint: endpoint ? endpoint.value.trim() : "" });
        if (baseInput) updateSettings({ agentBaseUrl: baseInput.value.trim() });
        if (modelInput) updateSettings({ agentModel: modelInput.value.trim() });
        writeAgentKey(keyInput ? keyInput.value : "");
        if (runButton.disabled) return;
        const question = prompt ? String(prompt.value || "").trim() : "";
        if (!question) {
          if (status) status.textContent = "先写点什么再交给助手。";
          return;
        }
        // 问过的和答过的都进聊天记录，刷新页面也还在
        pushChat("user", question);
        if (prompt) prompt.value = "";
        renderChat();
        runButton.disabled = true;
        if (status) status.textContent = "正在处理…";
        try {
          const result = await ask(question);
          pushChat("agent", result.reply);
          renderChat();
          if (status) status.textContent = result.added && result.added.length > 0 ? "加了 " + result.added.length + " 条任务。" : "";
        } catch (error) {
          const message = String(error.message || error);
          pushChat("agent", "（没成功）" + message);
          renderChat();
          if (status) status.textContent = message;
        } finally {
          runButton.disabled = false;
        }
      });
    }
  }

  function wireLinkDialog() {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !linkDialogOpen()) return;
      event.preventDefault();
      closeLinkDialog();
    });
  }

  function applyInitialFilters() {
    loadBoardView(); // 上次挑的筛选先顶上，URL 带的参数最后说了算
    const params = new URLSearchParams(window.location.search);
    const category = params.get("category");
    if (category) state.board.category = category;
    const view = params.get("view");
    if (view === "trash" || view === "active") state.board.view = view;
  }

  /* ---------- boot ---------- */

  // 「后端那份数据比对完了」的信号。引导页要等它：探活（/api/health）比取数据先回来，
  // 本地还是空的时候会被误判成新用户，把三步引导弹在一个已经有数据的库上。
  let markRemoteSettled = function () {};
  const remoteSettled = new Promise((resolve) => {
    markRemoteSettled = resolve;
  });

  applyInitialFilters();
  ensureLinkDialog();
  wireHome();
  wireBoard();
  wireLinkDialog();
  // 后端探活完成后会广播一次：助手卡片要跟着显示「本机后端在线」，
  // 而且这时候才真的能借后端代发，所以顺带补一次 AI 每日推荐（页面往往比后端先就绪，
  // 早跑那一次多半是没密钥的直连，只能退回本地推荐）。
  document.addEventListener("spasre:backend", (event) => {
    renderAll();
    if (!event || !event.detail || !event.detail.online) return;
    upgradeDailyWithAI()
      .then((changed) => {
        if (changed) renderAll();
      })
      .catch(() => {});
  });
  renderAll(); // 先用本地那份画出来，后端数据到了再重画

  // 数据以后端为准：采用后端那份，然后补今天的推荐任务
  bootRemote()
    .catch(() => {})
    .then(() => {
      markRemoteSettled(); // 到这儿 store 已经是对的那一份了，引导可以下判断
      ensureDailyRecommendation();
      renderAll();
      return upgradeDailyWithAI();
    })
      .then(() => inferInterestsFromDaily())
    .then((changed) => {
      if (changed) renderAll();
    })
    .catch(() => {});

  // 别的浏览器改了数据，这边跟着刷新
  window.setInterval(pollRemote, 5000);
  // 换页面 / 关标签页之前，把还没推上去的改动送出去
  window.addEventListener("pagehide", flushOnLeave);
  window.addEventListener("beforeunload", flushOnLeave);

  window.spasreTasks = {
    version: 2,
    storageKey: STORE_KEY,
    today: todayKey,
    list: function (options) {
      const category = options && options.category;
      const includeTrash = options && options.includeTrash;
      return (includeTrash ? store.tasks.concat(store.trash) : store.tasks).filter(
        (task) => !category || category === "all" || task.category === category
      );
    },
    categories: categories,
    // 兴趣标签：自己挑的 / 自动记的 / 每日推荐开关 / 共用的弹层（引导页也用）
    interests: interestList,
    autoInterests: autoInterestList,
    pickInterests: pickInterestList,
    setInterests: setInterestLists,
    dailyRecommendation: function () {
      return Boolean(store.settings.dailyRecommendation);
    },
    setDailyRecommendation: setDailyRecommendation,
    openSheet: openSheet,
    onboarded: function () {
      return Boolean(store.settings.onboarded);
    },
    markOnboarded: function () {
      updateSettings({ onboarded: true });
    },
    // 后端那份比对完的 promise（引导页用；纯静态没后端时它也会 resolve，只是快）
    whenReady: function () {
      return remoteSettled;
    },
    dropTodayDaily: dropTodayDaily,
    flush: flushRemote,
    resetData: resetData,
    // 跳过兴趣标签之后，按「学完的每日任务」推方向（换掉的不算）
    inferInterests: inferInterestsFromDaily,
    learnedDaily: learnedDailyTitles,
    avoidedDaily: avoidedDailyTitles,
    add: function (task) {
      const created = createTask(task);
      renderAll();
      return created;
    },
    addMany: function (tasks) {
      const added = (tasks || []).map((task) => createTask(task)).filter(Boolean);
      renderAll();
      return added;
    },
    complete: function (id) {
      const ok = completeTask(id, "done");
      renderAll();
      return ok;
    },
    restore: function (id) {
      const ok = restoreTask(id);
      renderAll();
      return ok;
    },
    purge: function (id) {
      const ok = purgeTask(id);
      renderAll();
      return ok;
    },
    emptyTrash: function () {
      const count = emptyTrash();
      renderAll();
      return count;
    },
    settings: function () {
      const snapshot = Object.assign({}, store.settings);
      // 控制台里不直接吐明文密钥，避免顺手复制分享出去
      snapshot.agentApiKey = snapshot.agentApiKey ? "已设置" : "";
      return snapshot;
    },
    updateSettings: function (patch) {
      updateSettings(patch);
      renderAll();
      return Object.assign({}, store.settings);
    },
    setAgentEndpoint: function (url) {
      return this.updateSettings({ agentEndpoint: String(url || "").trim() });
    },
    setAgent: function (options) {
      const config = options || {};
      const patch = {};
      if (config.baseUrl !== undefined) patch.agentBaseUrl = String(config.baseUrl || "").trim();
      if (config.model !== undefined) patch.agentModel = String(config.model || "").trim();
      if (config.rememberKey !== undefined) patch.agentRememberKey = Boolean(config.rememberKey);
      if (config.setupDone !== undefined) patch.agentSetupDone = Boolean(config.setupDone);
      updateSettings(patch);
      if (config.apiKey !== undefined) writeAgentKey(config.apiKey);
      renderAll();
      return {
        baseUrl: store.settings.agentBaseUrl,
        model: store.settings.agentModel,
        rememberKey: store.settings.agentRememberKey,
        hasKey: Boolean(readAgentKey())
      };
    },
    testAgent: testAgent,
    agentConfigured: agentConfigured,
    hasAgentPassword: hasAgentPassword,
    agentEnvText: agentEnvText,
    importAgentEnv: function (text) {
      const ok = applyAgentEnv(parseAgentEnv(text));
      renderAll();
      return ok;
    },
    exportAgentEnv: downloadAgentEnv,
    unlockAgent: function (password) {
      return (async () => {
        if (!hasAgentPassword()) {
          const salt = newSalt();
          const hash = await hashPassword(password, salt);
          updateSettings({ agentPasswordSalt: salt, agentPasswordHash: hash });
        } else {
          const hash = await hashPassword(password, store.settings.agentPasswordSalt);
          if (hash !== store.settings.agentPasswordHash) return false;
        }
        state.agent.unlocked = true;
        state.agent.gate = "";
        renderAll();
        return true;
      })();
    },
    lockAgent: function () {
      state.agent.unlocked = false;
      state.agent.gate = "";
      renderAll();
    },
    requestPlan: requestPlan,
    ask: ask,
    plan: localPlan,
    answer: localAnswer,
    linksFor: function (id) {
      const task = store.tasks.concat(store.trash).find((item) => item.id === id);
      return task ? linksForTask(task) : [];
    },
    openLinks: function (id) {
      const task = store.tasks.concat(store.trash).find((item) => item.id === id);
      return openLinkDialog(task);
    },
    closeLinks: closeLinkDialog,
    linksOpen: linkDialogOpen,
    openLinkList: function (title, links, options) {
      return openLinkList(title, links, options);
    },
    refresh: renderAll,
    goals: function () {
      return store.goals.map(cloneGoal);
    },
    goal: function (id) {
      const goal = findGoal(id);
      return goal ? cloneGoal(goal) : null;
    },
    addGoal: function (input) {
      const goal = createGoal(input);
      renderAll();
      return goal ? cloneGoal(goal) : null;
    },
    updateGoal: function (id, patch) {
      const goal = updateGoal(id, patch);
      renderAll();
      return goal ? cloneGoal(goal) : null;
    },
    removeGoal: function (id, options) {
      const ok = removeGoal(id, options);
      renderAll();
      return ok;
    },
    goalTasks: function (goalId) {
      return goalTasks(goalId);
    },
    syncGoalTasks: function (goalId) {
      const created = syncGoalTasks(goalId);
      renderAll();
      return created;
    },
    // 日程表：一天切几段（首页日程表上点行首标签就能改）、哪些段被划成「非空闲」
    segments: segments,
    checkSegments: checkSegments,
    clashKeys: clashKeys,
    setSegments: function (list) {
      const problem = setSegments(list);
      if (!problem) renderAll();
      return problem;
    },
    slotHours: slotHours,
    slotPassed: slotPassed,
    overdue: function () {
      return Array.from(overdueNodes());
    },
    locked: function () {
      return Array.from(lockedNodes());
    },
    nodeKey: nodeKey,
    clockMinutes: clockMinutes,
    clockText: clockText,
    busy: busyList,
    setBusy: function (date, key, on) {
      const ok = setBusy(date, key, on);
      renderAll();
      return ok;
    },
    // 非空闲默认每周一致：网格点一下走的就是这个
    busyWeekly: busyWeeklyList,
    setBusyWeekly: function (date, key, on) {
      const ok = setBusyWeekly(date, key, on);
      renderAll();
      return ok;
    },
    slotBusy: slotBusy,
    // 任务占时段：哪几段空着 / 排进去 / 取消安排
    slotStates: slotStates,
    placeTask: placeTask,
    unplaceTask: function (id) {
      return placeTask(id, {});
    },
    // 这一段已经排了多少小时（传 exclude 排除自己）—— 一格放不下的检查靠它
    usedHours: usedHours,
    // 「加入日程表」= 标记成待安排（日程表页顶部那排），false 就是移出待安排
    planTask: planTask,
    // 每日推荐要不要统一排进日程表；第一次排期的引导走完没走完
    dailyAutoSchedule: function () {
      return Boolean(store.settings.dailyAutoSchedule);
    },
    setDailyAutoSchedule: setDailyAutoSchedule,
    planSetupDone: function () {
      return Boolean(store.settings.planSetupDone);
    },
    markPlanSetup: function () {
      updateSettings({ planSetupDone: true });
    },
    slotTime: slotTime,
    segment: function (key) {
      return segmentOf(key);
    },
    segmentOrder: function () {
      return segmentOrder();
    },
    segmentMinutes: function (key) {
      const seg = segmentOf(key);
      return seg ? segmentMinutesTotal(seg) : 0;
    },
    toggleGoalNode: function (goalId, nodeId, done) {
      const value = toggleGoalNode(goalId, nodeId, done);
      renderAll();
      return value;
    },
    // 笔记：新建 / 改 / 删 / 分类；openNote = 有就切过去、没有就新建
    notes: function () {
      return notes().map((note) => Object.assign({}, note));
    },
    note: function (id) {
      const note = findNote(id);
      return note ? Object.assign({}, note) : null;
    },
    addNote: function (patch) {
      return createNote(patch);
    },
    updateNote: function (id, patch) {
      const note = updateNote(id, patch);
      renderAll();
      return note ? Object.assign({}, note) : null;
    },
    removeNote: function (id) {
      const ok = removeNote(id);
      if (ok) renderAll();
      return ok;
    },
    noteCategories: noteCategories,
    addNoteCategory: addNoteCategory,
    noteFor: function (target) {
      const note = noteFor(target);
      return note ? Object.assign({}, note) : null;
    },
    openNote: openNote,
    agentChat: agentChat,
    upgradeDaily: upgradeDailyWithAI,
    rerollDaily: rerollDaily
  };
})();
