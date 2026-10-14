/* 兴趣标签怎么推、怎么让用户挑：设置页和「新用户引导」共用这一份。
   推荐优先走后端技能 interest.suggest（配了模型就是模型给，它会顺着你选的标签往外扩），
   后端不在或者没配模型就退回下面这份宽泛词库，保证界面不会空着。

   对外就三件事：
     spasreInterestLib.broad(limit)          —— 随机给几批宽泛方向（不参考已有标签，给新用户用）
     spasreInterestLib.related(tag, limit)   —— 一个方向周围的邻近方向（本地兜底）
     spasreInterestLib.suggest(mode, tags, limit) —— async，先问后端技能，不行再本地
     spasreInterestLib.picker({...})         —— 「挑标签」界面（返回 { el, chosen() }）
*/

(function () {
  "use strict";

  // 一开始给的宽泛方向：不参考已有兴趣，每次随机挑几个，不至于每个新用户看到的都一样
  const BROAD = [
    "编程基础", "算法与数据结构", "操作系统", "计算机网络", "数据库",
    "分布式系统", "编译原理与编程语言", "前端开发", "后端服务", "云计算与运维",
    "网络安全", "密码学", "人工智能", "机器学习", "深度学习",
    "大模型应用", "数据分析与可视化", "图形学与游戏", "嵌入式与单片机", "移动开发",
    "自动化测试", "工程质量与重构", "数学与统计", "英语与写作", "效率与工具",
    "开源与协作", "产品与交互设计", "搜索引擎与检索", "音视频处理", "金融科技"
  ];

  // 每个方向周围的邻近方向：related 兜底，也是随机模式里「自动记几个方向」的来源
  const CLUSTERS = [
    ["编程基础", "算法与数据结构", "代码整洁之道", "调试技巧", "版本控制", "设计模式"],
    ["操作系统", "并发与锁", "虚拟内存", "文件系统", "进程调度", "C/C++ 系统编程"],
    ["计算机网络", "HTTP 与 TLS", "TCP/IP", "抓包与排障", "代理与隧道", "QUIC"],
    ["数据库", "查询优化", "索引结构", "事务隔离", "存储引擎", "数据建模"],
    ["分布式系统", "一致性协议", "消息队列", "服务网格", "容错与重试", "可观测性"],
    ["编译原理与编程语言", "程序分析", "类型系统", "代码生成", "虚拟机与 JIT", "静态分析"],
    ["人工智能", "机器学习", "深度学习", "强化学习", "模型部署", "向量检索"],
    ["大模型应用", "提示工程", "RAG 检索增强", "Agent 与工具调用", "模型微调", "推理加速"],
    ["前端开发", "浏览器渲染", "构建工具链", "TypeScript", "可访问性", "Web 性能"],
    ["云计算与运维", "容器与 Kubernetes", "CI/CD", "基础设施即代码", "监控与告警", "成本优化"],
    ["网络安全", "认证与授权", "漏洞利用与防御", "零信任", "安全编码"],
    ["数据分析与可视化", "SQL 进阶", "指标体系", "统计推断", "数据清洗", "仪表盘设计"],
    ["图形学与游戏", "渲染管线", "着色器", "物理模拟", "游戏引擎"],
    ["嵌入式与单片机", "RTOS", "驱动开发", "传感器与总线", "低功耗设计"],
    ["移动开发", "iOS 与 Swift", "Android 与 Kotlin", "跨端框架", "移动性能"],
    ["工程质量与重构", "自动化测试", "单元测试", "代码评审", "技术债管理"],
    ["数学与统计", "线性代数", "概率论", "数值计算", "信息论"],
    ["音视频处理", "编解码", "实时通信", "降噪与增强", "流媒体协议"],
    ["搜索引擎与检索", "倒排索引", "相关性排序", "中文分词", "向量搜索"],
    ["后端服务", "API 设计", "鉴权与限流", "缓存设计", "任务队列", "服务拆分"],
    ["英语与写作", "技术写作", "文献阅读", "口语与听力", "结构化表达", "记笔记"],
    ["效率与工具", "命令行与脚本", "编辑器与快捷键", "笔记系统", "时间管理", "自动化流程"],
    ["开源与协作", "Git 工作流", "代码评审", "社区协作", "许可证与合规", "文档写作"],
    ["产品与交互设计", "需求分析", "信息架构", "交互原型", "可用性测试", "视觉基础"],
    ["金融科技", "支付与清算", "风控与反欺诈", "量化基础", "区块链与合约", "账务模型"]
  ];

  function shuffle(list) {
    const out = list.slice();
    for (let index = out.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      const keep = out[index];
      out[index] = out[swap];
      out[swap] = keep;
    }
    return out;
  }

  function broad(limit) {
    return shuffle(BROAD).slice(0, Math.max(1, limit || 8));
  }

  function related(tag, limit) {
    const name = String(tag || "").trim();
    const out = [];
    CLUSTERS.forEach((cluster) => {
      if (!cluster.some((item) => item.includes(name) || name.includes(item))) return;
      cluster.forEach((item) => {
        if (item !== name && out.indexOf(item) < 0) out.push(item);
      });
    });
    if (out.length === 0) {
      shuffle(BROAD).forEach((item) => {
        if (item !== name && out.indexOf(item) < 0) out.push(item);
      });
    }
    return out.slice(0, Math.max(1, limit || 6));
  }

  function bridge() {
    return window.spasreBackend && typeof window.spasreBackend.run === "function" ? window.spasreBackend : null;
  }

  async function suggest(mode, tags, limit) {
    const known = (tags || []).map((item) => String(item || "").trim()).filter(Boolean);
    const size = Math.max(1, limit || 6);
    const runner = bridge();
    if (runner) {
      try {
        const payload = await runner.run("interest.suggest", { mode: mode, tags: known, limit: size });
        const info = (payload && payload.result) || {};
        if (info.ok && Array.isArray(info.tags) && info.tags.length > 0) {
          const fresh = info.tags.filter((item) => known.indexOf(item) < 0);
          if (fresh.length > 0) return { tags: fresh, source: info.source || "model" };
        }
      } catch (error) {
        // 后端不在：下面兜底
      }
    }
    const fallback = mode === "related" && known.length > 0 ? related(known[known.length - 1], size) : broad(size);
    return { tags: fallback.filter((item) => known.indexOf(item) < 0), source: "local" };
  }

  /* ---------- 「挑标签」界面 ---------- */

  // options: { min, initial, hint, broadLimit, onDone(list), onSkip() }
  function picker(options) {
    const opts = options || {};
    const min = Math.max(1, opts.min || 1);
    const chosen = [];
    (opts.initial || []).forEach((tag) => {
      const name = String(tag || "").trim();
      if (name && chosen.indexOf(name) < 0) chosen.push(name);
    });

    const box = document.createElement("div");
    box.className = "ipick";

    const cloud = document.createElement("div");
    cloud.className = "ipick-cloud";
    box.append(cloud);

    const foot = document.createElement("div");
    foot.className = "ipick-foot";
    const note = document.createElement("span");
    note.className = "ipick-note";
    const again = document.createElement("button");
    again.type = "button";
    again.className = "task-action";
    again.textContent = "换一批";
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "task-action";
    skip.textContent = "跳过";
    skip.hidden = typeof opts.onSkip !== "function";
    const done = document.createElement("button");
    done.type = "button";
    done.className = "task-action sched-save";
    done.textContent = "完成";
    foot.append(note, again, skip, done);
    box.append(foot);

    if (opts.hint) {
      const hint = document.createElement("p");
      hint.className = "task-hint ipick-hint";
      hint.textContent = opts.hint;
      box.insertBefore(hint, cloud);
    }

    // 自己想到的方向也能直接写：跟挑出来的一样算一个，也会顺着它把邻近方向铺出来
    const add = document.createElement("div");
    add.className = "interest-add";
    const input = document.createElement("input");
    input.className = "task-input";
    input.type = "text";
    input.placeholder = "也可以自己输入一个方向，回车加上";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "自己输入一个兴趣方向");
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "task-action";
    addButton.textContent = "添加";
    add.append(input, addButton);
    box.insertBefore(add, cloud);

    function addMine() {
      const name = input.value.trim();
      if (!name) return;
      input.value = "";
      const existing = cloud.querySelector('[data-tag="' + name.replace(/"/g, '\\"') + '"]');
      if (existing) {
        if (chosen.indexOf(name) < 0) {
          chosen.push(name);
          existing.classList.add("is-on");
          refresh();
        }
        return;
      }
      chosen.push(name);
      const button = chip(name, false);
      cloud.prepend(button);
      refresh();
      expand(name, button);
    }

    addButton.addEventListener("click", addMine);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return; // 中文输入法组字时的回车不算
      event.preventDefault();
      addMine();
    });

    function refresh() {
      note.textContent = "已选 " + chosen.length + " 个" + (chosen.length < min ? "（至少 " + min + " 个）" : "");
      done.disabled = chosen.length < min;
    }

    function chip(name, loose) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "interest-tag ipick-chip" + (loose ? " is-loose" : "");
      button.textContent = name;
      button.dataset.tag = name;
      button.addEventListener("click", () => {
        const at = chosen.indexOf(name);
        if (at >= 0) {
          chosen.splice(at, 1);
          button.classList.remove("is-on");
          refresh();
          return;
        }
        chosen.push(name);
        button.classList.add("is-on");
        refresh();
        expand(name, button);
      });
      if (chosen.indexOf(name) >= 0) button.classList.add("is-on");
      return button;
    }

    // 选了一个方向，就把它的邻近方向插在它后面（「在外围继续加入相关的」）
    async function expand(name, anchor) {
      const result = await suggest("related", [name], 6);
      let last = anchor;
      result.tags.forEach((tag) => {
        if (cloud.querySelector('[data-tag="' + tag.replace(/"/g, '\\"') + '"]')) return;
        const next = chip(tag, true);
        last.after(next);
        last = next;
      });
    }

    function fillBroad() {
      const used = Array.from(cloud.querySelectorAll(".ipick-chip")).map((item) => item.dataset.tag);
      broad(opts.broadLimit || 8).forEach((tag) => {
        if (used.indexOf(tag) >= 0) return;
        used.push(tag);
        cloud.append(chip(tag, false));
      });
    }

    fillBroad();
    // 上次挑的、AI 记的、自己写的那几个也摆出来 —— 否则「已选 N 个」看不出选的是哪几个
    const mine = [];
    (opts.initial || []).forEach((tag) => {
      const name = String(tag || "").trim();
      if (!name || cloud.querySelector('[data-tag="' + name.replace(/"/g, '\\"') + '"]')) return;
      mine.push(chip(name, false));
    });
    if (mine.length > 0) cloud.prepend(...mine);
    refresh();

    again.addEventListener("click", fillBroad);
    done.addEventListener("click", () => {
      if (chosen.length < min) return;
      if (typeof opts.onDone === "function") opts.onDone(chosen.slice());
    });
    skip.addEventListener("click", () => {
      if (typeof opts.onSkip === "function") opts.onSkip(chosen.slice());
    });

    return {
      el: box,
      chosen: function () {
        return chosen.slice();
      }
    };
  }

  window.spasreInterestLib = {
    all: function () {
      return BROAD.slice();
    },
    broad: broad,
    related: related,
    suggest: suggest,
    picker: picker
  };
})();
