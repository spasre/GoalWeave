/* 新用户引导：第一次打开（本地和后端都没有数据）才弹出来。
   ① 要不要每日推荐 → ② 挑几个兴趣方向（至少 3 个，能跳过）→ ③ 配一下模型（能跳过，密码先不填）→ 回首页。

   有数据的老用户（比如已经用了一阵的本机）不会看到，进来自动标一下 onboarded 就不再打扰。
   判断要等后端探活完成之后再做：本地是空的、后端有数据时不能当成新用户。 */

(function () {
  "use strict";

  const api = window.spasreTasks;
  const lib = window.spasreInterestLib;
  if (!api || !lib) return;

  const HOME = "index.html";
  let asked = false;

  function freshEnough() {
    if (api.onboarded()) return false;
    // 自动生成的每日推荐任务不算「用过」，否则新装第一眼就被当成老用户
    const tasks = api.list({ includeTrash: true }).filter((task) => task.source !== "daily").length;
    const interests = api.interests().length;
    const goals = window.spasreGoals && typeof window.spasreGoals.goals === "function" ? window.spasreGoals.goals().length : 0;
    return tasks === 0 && interests === 0 && goals === 0;
  }

  function maybeStart() {
    if (asked) return;
    asked = true;
    if (!freshEnough()) {
      if (!api.onboarded()) api.markOnboarded(); // 老用户：悄悄标一下，以后不再问
      return;
    }
    start();
  }

  function start() {
    const sheet = api.openSheet("先花一分钟搭一下");
    const picks = { daily: true, interests: [], skipped: false, key: "", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" };
    let step = 1;

    function hint(text) {
      const p = document.createElement("p");
      p.className = "task-hint";
      p.textContent = text;
      return p;
    }

    function button(text, cls, onClick) {
      const node = document.createElement("button");
      node.type = "button";
      node.className = cls || "task-action";
      node.textContent = text;
      node.addEventListener("click", onClick);
      return node;
    }

    function foot(buttons) {
      const box = document.createElement("div");
      box.className = "sheet-foot";
      buttons.forEach((item) => box.append(item));
      return box;
    }

    function field(label, value, placeholder, onInput) {
      const wrap = document.createElement("label");
      wrap.className = "task-field";
      const name = document.createElement("span");
      name.textContent = label;
      const input = document.createElement("input");
      input.className = "task-input";
      input.type = "text";
      input.value = value || "";
      input.placeholder = placeholder || "";
      input.autocomplete = "off";
      input.addEventListener("input", () => onInput(input.value));
      wrap.append(name, input);
      return wrap;
    }

    function render() {
      sheet.body.replaceChildren();
      if (step === 1) {
        sheet.body.append(hint("要不要每天给你加一条知识点？（「每日推荐」）"));
        sheet.body.append(hint("它会按你的兴趣方向挑一个具体、能上手的小点，不想要随时能在设置页关掉。"));
        sheet.body.append(
          foot([
            button("要，每天推", "task-action sched-save", () => {
              picks.daily = true;
              step = 2;
              render();
            }),
            button("先不用", "task-action", () => {
              picks.daily = false;
              step = 3;
              render();
            }),
            button("跳过引导", "task-action", () => finish())
          ])
        );
        return;
      }
      if (step === 2) {
        sheet.body.append(hint("挑几个你想关注的方向（至少 3 个，也可以跳过）。点一个，它周围的相关方向会跟着铺出来；自己想到的也能直接输入。"));
        const view = lib.picker({
          min: 3,
          broadLimit: 10,
          onDone: (list) => {
            picks.interests = list;
            picks.skipped = false;
            step = 3;
            render();
          },
          onSkip: () => {
            picks.skipped = true;
            step = 3;
            render();
          }
        });
        sheet.body.append(view.el);
        return;
      }
      sheet.body.append(hint("要不要现在接一个模型？（可以跳过，之后在设置页里配也行；密码这次不用设）"));
      sheet.body.append(hint("走 OpenAI 兼容格式，DeepSeek / Moonshot / Groq / 本地 Ollama 都能用。"));
      sheet.body.append(field("接口地址", picks.baseUrl, "https://api.deepseek.com/v1", (value) => { picks.baseUrl = value; }));
      sheet.body.append(field("模型名", picks.model, "deepseek-chat", (value) => { picks.model = value; }));
      sheet.body.append(field("密钥", picks.key, "sk-…（本机后端会帮你保管）", (value) => { picks.key = value; }));
      sheet.body.append(
        foot([
          button("保存并开始用", "task-action sched-save", () => {
            saveAgent();
            finish();
          }),
          button("先跳过", "task-action", () => finish())
        ])
      );
    }

    function saveAgent() {
      const baseUrl = String(picks.baseUrl || "").trim();
      const model = String(picks.model || "").trim();
      const key = String(picks.key || "").trim();
      if (!baseUrl && !model && !key) return;
      api.setAgent({ baseUrl: baseUrl, model: model, apiKey: key, setupDone: Boolean(baseUrl && model) });
    }

    async function finish() {
      // 选了就存；跳过就什么都不填 —— 之后按「学完的每日任务」慢慢推方向，换掉的不算
      if (picks.daily && picks.interests.length > 0) api.setInterests(picks.interests, []);
      api.updateSettings({ dailyRecommendation: Boolean(picks.daily), onboarded: true });
      // 说不要就别留那条自动生成的推荐任务
      if (!picks.daily && api.dropTodayDaily) api.dropTodayDaily();
      sheet.close();
      // 先把这次改动推到后端再跳走，否则新页面会按后端那份（旧的）走
      if (typeof api.flush === "function") await api.flush();
      window.location.href = HOME;
    }

    render();
  }

  // 后端探活完成再判断；纯静态（没后端）就等一下本地那份
  document.addEventListener("spasre:backend", () => maybeStart());
  window.setTimeout(() => maybeStart(), 1200);
})();
