/* 任务板 ↔ 后端桥。

   后端（server.py）只做三件事：把助手配置存到本机（config/agent.json）、跑 skills/ 里的技能、
   替浏览器代发模型请求。它是「看不见的管道」，页面上不露脸——技能是给功能用的，不是给人点的：

     目标拆分    → goals.js 调 learn.curriculum（模型 → 技能 → 内置模板，逐级回退）
     任务拆分    → 模型直连被跨域挡住时，由这里代发
     推荐阅读    → 前端本地目录匹配（离线可用，不必绕后端）

   这个脚本负责：

   1. 探测后端在不在（GET /api/health），并广播 spasre:backend 事件，
      页面其它部分（助手卡片）靠它决定要不要显示「本机后端在线」。
   2. 把浏览器里存的助手配置推给后端存起来；页面开着时每几秒对一次，改了设置自动同步。
   3. 把后端能力暴露给各功能调用（run / chat / ask）。

   后端不在（例如 serve.ps1 -Static 起的纯静态服务）时全部静默降级，前端照旧能用。

   控制台接口挂在 window.spasreBackend 上：
     spasreBackend.online                 // 后端在不在
     await spasreBackend.available()       // 重新探一次
     await spasreBackend.sync()            // 把前端配置推到后端
     await spasreBackend.pull()            // 从后端拉配置回浏览器
     await spasreBackend.test()            // 测后端存的模型接口
     await spasreBackend.chat(null, { messages: [...] })   // 走后端调模型（绕开 CORS）
     await spasreBackend.ask("帮我排这周")   // 走后端拆任务
     await spasreBackend.skills()          // 技能清单
     await spasreBackend.run("learn.curriculum", { goal: "…" })   // 跑技能
*/
(function () {
  "use strict";

  const STORE_KEY = "spasre-tasks-v1";
  const AGENT_KEY_STORAGE = "spasre-agent-key";
  const POLL_MS = 4000;

  const state = { ready: false, skills: [], lastPushed: "", timer: 0 };

  function readStore() {
    try {
      return JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}") || {};
    } catch (error) {
      return {};
    }
  }

  function readSettings() {
    return readStore().settings || {};
  }

  function readAgentKey() {
    try {
      const session = window.sessionStorage.getItem(AGENT_KEY_STORAGE);
      if (session) return session;
    } catch (error) {
      /* 隐私模式下拿不到就算了 */
    }
    return String(readSettings().agentApiKey || "");
  }

  // 前端填了什么，就原样收上来
  function collectConfig() {
    const settings = readSettings();
    return {
      baseUrl: String(settings.agentBaseUrl || "").trim(),
      model: String(settings.agentModel || "").trim(),
      apiKey: readAgentKey(),
      endpoint: String(settings.agentEndpoint || "").trim(),
      rememberKey: settings.agentRememberKey !== false
    };
  }

  async function api(path, options) {
    const init = Object.assign({ headers: { "Content-Type": "application/json" } }, options || {});
    let response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      throw new Error("连不上后端（" + path + "）");
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error((data && (data.error || data.message)) || ("后端返回 " + response.status));
    }
    return data;
  }

  async function probe() {
    try {
      const data = await api("/api/health");
      state.ready = Boolean(data && data.ok);
    } catch (error) {
      state.ready = false;
    }
    return state.ready;
  }

  async function sync() {
    const config = collectConfig();
    const fingerprint = JSON.stringify(config);
    const data = await api("/api/config", { method: "POST", body: fingerprint });
    state.lastPushed = fingerprint;
    return data.config;
  }

  function applyConfig(config) {
    if (!window.spasreTasks || !config) return false;
    window.spasreTasks.updateSettings({
      agentBaseUrl: config.baseUrl || "",
      agentModel: config.model || "",
      agentEndpoint: config.endpoint || "",
      agentRememberKey: config.rememberKey !== false,
      agentSetupDone: Boolean((config.baseUrl && config.model) || config.endpoint)
    });
    if (config.apiKey) window.spasreTasks.setAgent({ apiKey: config.apiKey });
    return true;
  }

  async function pull() {
    let data = null;
    try {
      data = await api("/api/config?reveal=1");
    } catch (error) {
      // 明文那份没拿到（比如从手机打开，密钥不给外机）就用打码那份
      data = await api("/api/config");
    }
    applyConfig(data.config);
    return data.config;
  }

  async function test() {
    const config = collectConfig();
    const data = await api("/api/config/test", { method: "POST", body: JSON.stringify(config) });
    if (data && data.ok === false) throw new Error(data.error || "没通过");
    return data;
  }

  // prompt 或 messages 二选一：只给 messages 时不带 prompt 字段
  async function chat(prompt, options) {
    const config = collectConfig();
    const payload = Object.assign({}, options || {}, config);
    if (prompt) payload.prompt = prompt;
    const data = await api("/api/chat", { method: "POST", body: JSON.stringify(payload) });
    return data.reply;
  }

  async function ask(prompt, options) {
    const config = collectConfig();
    const data = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify(Object.assign({ prompt: prompt }, options || {}, config))
    });
    return data;
  }

  async function skills() {
    const data = await api("/api/skills");
    state.skills = (data && data.skills) || [];
    return state.skills;
  }

  async function run(name, params) {
    const config = collectConfig();
    return api("/api/skills/" + encodeURIComponent(name), {
      method: "POST",
      body: JSON.stringify(Object.assign({}, params || {}, { __config__: config }))
    });
  }

  /* ---------- 后端能力（给各功能调用，不往页面上摆） ---------- */

  // 技能清单：功能需要时自己查，页面上不展示。
  async function refreshSkills() {
    try {
      return await skills();
    } catch (error) {
      return [];
    }
  }

  function wire() {
    // 页面开着的时候盯着两件事：后端活没活、配置改没改
    state.timer = window.setInterval(async () => {
      if (!state.ready) {
        // 探活失败过一次不代表后端就没了（页面可能比后端先打开）——继续探，
        // 探通了再把配置补同步一遍，否则这个页面上的后端功能会一直用不了。
        if (!(await probe())) return;
        announce();
        try {
          await connect();
        } catch (error) {
          console.warn("后端配置同步失败：", error);
        }
        return;
      }
      const config = collectConfig();
      // 这个浏览器手里压根没配置就别推：空值会把后端存好的那份冲掉
      if (!isConfigured(config)) return;
      const fingerprint = JSON.stringify(config);
      if (fingerprint !== state.lastPushed) {
        sync().catch(() => {});
      }
    }, POLL_MS);
  }

  // 后端在不在，广播给页面（助手卡片据此显示「本机后端在线」）
  function announce() {
    document.dispatchEvent(new window.CustomEvent("spasre:backend", { detail: { online: state.ready } }));
  }

  // 浏览器里填了接口地址 + 模型名（或自定义接口）才算「配好了」
  function isConfigured(config) {
    if (!config) return false;
    const base = String(config.baseUrl || "").trim();
    const model = String(config.model || "").trim();
    const endpoint = String(config.endpoint || "").trim();
    return Boolean((base && model) || endpoint);
  }

  // 探活成功后的配置对齐：浏览器里有配置就推上去，没有就从后端拉回来
  async function connect() {
    const local = collectConfig();
    if (isConfigured(local)) {
      // 浏览器里有配置 → 推给后端存起来
      await sync();
    } else {
      // 这个浏览器还没配置、后端存着 → 拉回来直接用。
      // 注意顺序：先看后端再决定推不推，否则空配置会把后端存好的冲掉。
      const data = await api("/api/config");
      if (isConfigured(data.config)) {
        await pull();
        if (window.spasreTasks && typeof window.spasreTasks.refresh === "function") {
          window.spasreTasks.refresh();
        }
        announce();
      }
    }
    state.lastPushed = JSON.stringify(collectConfig());
  }

  async function boot() {
    wire();
    const alive = await probe();
    announce();
    if (!alive) return; // 探活失败就交给 wire() 里的定时重试
    try {
      await connect();
    } catch (error) {
      console.warn("后端配置同步失败：", error);
    }
  }

  window.spasreBackend = {
    version: 1,
    get online() {
      return state.ready;
    },
    available: probe,
    sync: sync,
    pull: pull,
    test: test,
    chat: chat,
    ask: ask,
    skills: skills,
    run: run,
    collectConfig: collectConfig,
    refreshSkills: refreshSkills
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
