# 开发与实现细节

README 讲「能干什么」，这份讲「怎么实现的」：后端接口、技能怎么写、前端怎么调、控制台接口、配色与目录结构。

## 后端（`server.py`）

原来任务板是纯前端的：接口地址、模型名、密钥都只在浏览器里，调模型也是网页直连（跨域不通就只能自己搭代理）。`server.py` 是个零依赖（只用标准库）的小后端，补上两件事：

1. **存配置**：把前端填的接口地址 / 模型名 / 密钥 / 自定义接口落到本机 `.env`（老版本的 `config/agent.json` 会在启动时自动搬过去、旧文件删掉）。浏览器里有配置就推上来；浏览器里没有（换了浏览器、清过站点数据）就从后端拉回来用，所以配一次就够了。**空值不会覆盖存着的密钥**，要清得显式带 `clearKey`。
2. **跑技能**：`skills/` 里每个 `.py` 就是一个技能；配好模型后技能可以借后端的模型客户端干活，绕开浏览器的跨域限制。

它同时还是静态服务器（默认和 `serve.ps1` 一个端口），所以前端 / API / 技能是同一个 origin。

**后端在页面上不露脸**：它是「看不见的管道」，状态只在设置页的「助手」卡片上带一句「本机后端在线」。技能是给功能用的，不是给人点的——哪个功能需要什么能力，就在那个功能里调对应的技能（见下面的「技能怎么被用上」）。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务状态，前端用它判断后端在不在 |
| GET | `/api/config` | 读配置（默认隐藏密钥，`?reveal=1` 才带明文） |
| POST/PUT | `/api/config` | 写配置，给哪些字段就改哪些 |
| DELETE | `/api/config` | 清空配置 |
| GET | `/api/config/env` | 导出 `.env` 文本 |
| POST | `/api/config/env` | 从 `.env` 文本导入（body `{ "text": "..." }`） |
| POST | `/api/config/test` | 测一下模型接口通不通 |
| POST | `/api/chat` | 转发一次 OpenAI 兼容的对话请求，body `{ prompt }` 或 `{ messages }` |
| POST | `/api/ask` | 把一段话拆成任务（配了模型走模型，否则内置规则） |
| GET | `/api/skills` | 技能清单 |
| POST | `/api/skills/<name>` | 跑技能，body 就是它的参数 |
| GET | `/api/data` | 读看板数据，返回 `{ ok, rev, updatedAt, store }`（`store` 为 `null` 表示后端还没存过） |
| PUT | `/api/data` | 整份覆盖写，body `{ "store": {...} }`，成功后 `rev` 加一 |
| POST | `/api/data` | 同 PUT（前端用 PUT） |
| DELETE | `/api/data` | 清空看板数据 |

`/api/*` 只对本机 + 热点网段开放（见上面的「手机 / 局域网打开」），其它来源返回 `403`。明文密钥只在从本机请求时才会返回。

`/api/chat`、`/api/ask`、`/api/skills/<name>` 的 body 里都可以带上 `baseUrl` / `model` / `apiKey` / `endpoint` 临时覆盖存好的配置；`/api/skills/<name>` 用 `__config__` 对象传。

### 技能

技能就是 `skills/` 目录下的模块，丢一个 `.py` 进去就会自动被发现，不用改注册表。改完已经加载过的 `.py` 也**不用重启后端**：每次取技能时会看文件时间戳，变了就重载那一个（改坏了就继续用旧的）。

```python
SKILL = {
    "name": "echo",
    "title": "回声",
    "description": "把 text 原样返回。",
    "tags": ["调试"],
    "params": {"text": "要回显的文本"},
    "requiresModel": False,
}

def run(params, ctx):
    ctx.log("被调用了")
    return {"text": params.get("text", "")}
```

`ctx` 由后端注入，能给技能这些：`ctx.chat(messages)` 调模型、`ctx.model_ready()` 看配置好没有、`ctx.config` 当前配置、`ctx.root` 站点目录、`ctx.http_get(url)` 抓网页（`raw=True` 保留 HTML 标签，用来抽标题结构；默认去掉标签只留正文。`limit` 只管**返回**多少字符，下载量另有 `max_bytes`，默认够用）、`ctx.log(...)` 写日志。

自带的技能：

| 名字 | 干什么 | 要模型 |
| --- | --- | --- |
| `echo` | 原样返回，验证链路 | 否 |
| `env.info` | Python / 系统 / 配置状态 | 否 |
| `plan.tasks` | 把一段话拆成任务 | 否（没配模型就用内置规则） |
| `reading.suggest` | 按标题 / 说明让模型找延伸阅读，并逐条验证 URL 真能打开（打不开的不返回） | 是 |
| `learn.curriculum` | 学习目标 → 分阶段知识点路径（硬核目标先去抓教程大纲） | 否（没配模型就用内置模板） |
| `web.fetch` | GET 一个网页，返回去标签的正文 | 否 |
| `model.chat` | 直接问配好的模型 | 是 |
| `text.summarize` | 让模型总结一段文本 | 是 |
| `text.translate` | 让模型翻译 | 是 |
| `interest.suggest` | 兴趣标签的参谋：`mode=preset` 给一批预设方向，`mode=related` 按现有标签推 5 个相关的 | 否（没配模型就用内置词库） |
| `diagram.roadmap` | 知识点 + 依赖关系 → 一张能缩放、能导出的学习路线图 HTML（`diagrams/`） | 否 |
| `plan.outline` | `mode=revise` 按一句话改一版大纲；`mode=import` 把别处聊好的规划整段读成知识点（没配模型时 import 退回按行拆） | 是 |

### 学习路线图（`diagram.roadmap` + Archify）

页面上不再手画 SVG：知识点写成**文本大纲**（存在 `goal.outline` 里），图只留后端 Archify 画的这一张**学习路线图**：

```powershell
python server.py --skill diagram.roadmap --params-file roadmap.json
```

`roadmap.json` 就三件事：标题、知识点数组、每层的名字。

```json
{
  "title": "学会写 LLVM 优化 pass：学习路线图",
  "level_labels": ["打基础", "看懂 pass", "分析能力", "动手改", "写自己的"],
  "nodes": [
    { "id": "ir", "title": "LLVM IR 与 SSA 形式", "short": "IR 与 SSA", "brief": "看懂 .ll 文件",
      "deps": [], "links": [{ "title": "LangRef", "url": "https://llvm.org/docs/LangRef.html" }] }
  ]
}
```

它做的事：按 `deps` 做最长路径分层 → 层内爬山排序把连线交叉压到最少 → 拼成 Archify 的 grid IR →
交给 `skills/vendor/archify` 校验并渲染。**同名重画会覆盖同一个文件**（上一轮的证据文件会先清掉，
否则 Archify 不肯覆盖）。

两处专门为「学习路线图」调过的地方：

- **细长链会折成蛇形几列**：一长串「一步接一步」的知识点（层数 > 6、每层又只有一两个）铺出来是根
  又窄又高的柱子，缩到页面上字就没了，所以折成 3 列的蛇形（读法是走完一列接着走下一列）。
  多层并列的图（比如某一层有 4 个知识点）保持原来的分层。
- **文字整体放大 1.2 倍**：成品的 `<head>` 里塞一段 `#roadmap-text-scale` 样式，把节点标题/副标题/
  角标和下面清单的字都放大。Archify 量「标签宽 ≤ 节点宽」时按 1.2em 算一个汉字（真实字宽 1em），
  正好留了这一份余量，所以不会压字。要更大可以传 `font_scale`（1.0~1.4）。
- **画布宽度卡在 1395px 以内**：Archify 有一条「桌面可读性」——1440 宽的窗口里图占 930px，节点里
  最小的那行字投影下来不能低于 6px，反推画布宽度得 ≤ 1395px，**超一两个像素也会被打回**
  （`composition/desktop-readability`）。所以格子宽度、格间距是按这个预算配的：先缩格子，缩到底
  还排不下就把太宽的那一层**折成几行**（一层十几个知识点横着铺开是撑不住的）。一层最多 6 个格子
  并排，多出来的往下一行放。
- 过不了校验时会**自己退档重试**：先按要求的 `cards` 来，不行退成只列标题，再不行把图例收起来
  （层数一多图例要好几排，会挤不下 `legend/vertical-overflow`）。

参数：

| 参数 | 说明 |
| --- | --- |
| `nodes` | 知识点数组：`{id, title, short, brief, deps, links, level}`；`short` 是节点里显示的短标签，不给自己裁 |
| `level_labels` | 每层的名字，会当节点角标和图例（不写就是「第 N 步」） |
| `cards` | 图下面的清单：`titles`（默认，只列标题）/ `links`（标题 + 教程链接，长了会自动退回 `titles`）/ `none` |
| `font_scale` | 文字放大倍数，默认 `1.2`，范围 1.0~1.4 |
| `name` | 输出文件名，默认从标题里的 ASCII 部分取（中文标题会变成 `roadmap-<哈希>`） |
| `quality` | `showcase`（默认，卡得严）/ `standard` |
| `candidate` | 直接给一份完整的 Archify architecture JSON，跳过上面的生成（高级用法） |

返回 `{ ok, url, file, gates, diagnostics, crossings, cards, legend, font_scale, seconds }`。`gates` 是 Archify 的四道门
（validate / deliver / check / browser-check），**`ok: true` 就代表四道全过**，交叉、标签压字、
视口溢出这些问题都被它量过了；没过就在 `diagnostics` 里给可测的数字。实测 15 个知识点约 3 秒。

它需要 **Node.js ≥ 18**（Archify 是 Node 写的），没装 node 会直接报错。第三方代码在
`skills/vendor/archify`（MIT，v3.0.1），许可证原文在那一层里。

画完之后还会往成品 HTML 里补三段东西（`inject_extras`，在 Archify 校验**之后**做，所以不会把图弄
成不过校验）：

- **已完成的知识点**：`nodes[].done` 为真的节点，角标换成「✓ 已完成」，描边和标题点成青绿色。
- **节点面板减负**：Archify 自带的「种类 / id」chips、`N 条出向 · M 条入向`、`编写可达范围 上游/下游`
  三块对学习路线图是噪音，直接 CSS 藏掉，只留标题、说明和关系。
- **面板上加「笔记」按钮**：插在关系按钮前面。在应用里点它，按钮 `postMessage({source:"goalweave-roadmap", type:"note", nodeId, title})`
  给父页面，`goals.js` 收到后按 `goalId + nodeId` 打开或新建笔记；如果这张图是被单独打开的（没有父页
  面），就 `window.open` 到 `notes.html?node=…&title=…`。

### 技能怎么被用上

技能不是给人点的按钮，是**各功能内部调用的能力**。页面上没有「跑技能」的入口，接法是这样：

| 功能 | 技能 | 在哪接的 |
| --- | --- | --- |
| 目标页排学习计划 | `learn.curriculum` | `goals.js` 的 `skillPlan()`：模型没给出计划时调它，它也不行再退到内置模板 |
| 向导第三步出学习路线图 | `diagram.roadmap` | `goals.js` 的 `renderWizardDiagram()` / `drawCardDiagram()`：把当前知识点交给后端，回来后用 iframe 预览（卡上没图时那个「画一张路线图」也走它） |
| 设置页的兴趣标签 | `interest.suggest` | `settings.js`：进来推预设，选了标签再推 5 个相关的；后端不在就用本地词库 |
| 助手拆任务 / 问问题 | —（借后端的模型通道） | `tasks.js` 的 `bridgeChat()`：浏览器直连模型被跨域挡住时，改由后端代发 |
| 延伸阅读 | `reading.suggest` | `tasks.js` 的 `askReadingLinks()`：打开弹窗时自动问一次（每日推荐也用它补资料），回来的链接存在任务上 |
| 新建目标第三步改大纲 / 粘贴规划 | `plan.outline` | `goals.js` 的 `runOutlineSkill()`：`mode=revise` 把现有大纲 + 用户那句话交给它，`mode=import` 把贴进来的整段文字交给它；回来的 deps 写的是标题，走 `normalizeModelNodes` → `sanitizeNodes` 换成 id、去悬空依赖、断环 |
| 任务卡 / 路线图节点上的「笔记」 | —（共用一份 store） | 任务卡走 `tasks.js` 的 `openNote()`；路线图在 iframe 里，节点面板上的按钮 `postMessage` 给父页面，`goals.js` 收到后按 `goalId + nodeId` 打开或新建笔记 |

要加一个「能力型」功能，就在 `skills/` 里加个 `.py`，再到对应功能的代码里调它：

```js
const data = await window.spasreBackend.run("技能名", { 参数: "值" });
```

命令行也能直接跑，不占端口（调试技能用）：

```powershell
python server.py --list-skills
python server.py --skill echo --params "{\"text\":\"hi\"}"
python server.py --skill plan.tasks --params-file params.json   # 中文参数写成文件更省事
python server.py --skill learn.curriculum --params-file goal.json
```

### 学习路径拆解（`learn.curriculum`）

把「学会 X」拆成分阶段的知识点路径。SKILL.md 里那两套方案合成了一套：**判断目标复杂度，再决定要不要先去找资料**。

- **判断**：命中编译器 / 硬件 / 竞赛算法 / 框架开发 / 机器学习等硬核领域关键词 → 判为专业目标；「学会 Git 基础」这类 → 通用目标。判断只看 `goal` 的文本，`level` 不参与判断（想强制先查资料就传 `mode: "research"`）。
- **通用目标**：直接用模型（没配模型就用内置模板）拆，不联网。
- **专业目标**：先去抓资料——调用方给的 `sources` → 内置领域书单 → DuckDuckGo 搜索，抓回来的页面**只取 `<h1>~<h4>` 标题**，正文一律不要（`headingsSample` 会带前 12 个标题出来，方便核验）。
- **拆解**：已知领域按内置的「教学顺序」模板走，检索到的、模板没覆盖的主题折成一个「资料补充主题」阶段挂在最后；未知领域才拿检索到的章节顺序来分组。多个教程合并去重，每个阶段标 `sources`。
- **兜底**：一份资料都没抓到 → 降级为模型原生拆解，输出开头写「未检索到权威教程，本次基于模型知识拆分，建议人工复核。」；模型也调不通 → 再降到内置模板，写「模型调用失败，本次改用内置模板拆分，建议人工复核。」。
- **粒度**：单个知识点 1~3 小时（`hoursPerUnit` 默认 2），带类型【概念 / 实操 / 刷题】、验收标准、前置依赖（前置指向不存在的知识点会被丢掉）。

参数（body 即参数）：

| 参数 | 说明 |
| --- | --- |
| `goal` | 学习目标，必填 |
| `mode` | `auto`（默认，硬核才检索）/ `direct`（只拆不检索）/ `research`（强制检索） |
| `level` | 当前基础，**自由文本**（例如「会写 C++，没碰过编译器」），会作为「当前基础」带进模型提示；它不是枚举，也不影响硬核判断 |
| `hoursPerUnit` | 单个知识点小时数，夹到 1~3，默认 2 |
| `maxUnits` | 知识点上限，夹到 4~60，默认 24 |
| `weeklyHours` | 每周投入小时，用来算阶段周数 |
| `sources` | 自己指定资料网址（数组或换行分隔的文本），给了就优先抓这些 |

返回里除了 `stages` / `stats` / `sources` / `warnings`，还带一份渲染好的 `markdown`，可以直接贴到目标页或记事本里。

### 前端怎么接的

`assets/js/backend.js`（挂在 `window.spasreBackend`）是前端 ↔ 后端的桥，页面上没有属于它的 UI：

- 探测后端（`/api/health`），并广播 `spasre:backend` 事件——助手卡片据此显示「本机后端在线」；
- 浏览器里有配置就推给后端；浏览器里没有、后端存着就拉回来（换浏览器、清过站点数据都不用重填）；页面开着时每几秒对一次，改了设置自动同步；
- 把后端能力交给功能调用：`run(技能)` / `chat(messages)` / `ask(text)`。

```js
await spasreBackend.available();          // 后端通不通
await spasreBackend.sync();               // 前端配置 → 后端
await spasreBackend.pull();               // 后端配置 → 浏览器
await spasreBackend.test();               // 测后端存的接口
await spasreBackend.chat("你好");          // 走后端调模型（绕开 CORS）
await spasreBackend.ask("帮我排这周");      // 走后端拆任务
await spasreBackend.skills();             // 技能清单
await spasreBackend.run("echo", { text: "hi" });
```

`.env` 里有明文密钥；`os.chmod` 在 Windows 上不一定生效，别把这个文件同步到公开的地方。

### 数据存在哪、切页和多标签怎么不打架

看板数据落两份：浏览器 `localStorage["spasre-tasks-v1"]`（后端不在时的兜底副本）和后端 `config/data.json`
（页面开着时以后端为准，每几秒拉一次 `rev`）。两处都写就有个「谁新听谁的」的问题，三条规矩：

- **本地改动打脏标记**：`save()` 除了写本地，还往 `localStorage["spasre-tasks-dirty"]` 记一个**本地时间、秒级、
  不带时区**的戳（和 Python 那边 `datetime.now().isoformat(timespec="seconds")` 同格式，直接字符串比大小
  就行；JS 的 `toISOString()` 是 UTC，不能用）。推送成功才 `markClean()` 清掉。
- **打开页面时先比戳**：`bootRemote` / `pollRemote` 拿到后端那份后，如果脏戳比它的 `updatedAt` 新，说明
  本地有没推上去的东西，反过来把本地推上去，而不是被旧的那份盖回来。
- **跳页前把攒着的推送出去**：推送有 400ms 防抖，`pagehide` / `beforeunload` 时用 `navigator.sendBeacon("/api/data", …)`
  兜一下（后端 `/api/data` 收 POST 和 PUT），点完任务立刻切页也不会丢。

## 控制台接口

挂在 `window.spasreTasks` 上：

```js
spasreTasks.list();                                  // 全部未完成任务
spasreTasks.add({ title: "写周报", category: "工作", urgency: "high", date: "2026-10-12" });
spasreTasks.addMany([{ title: "A" }, { title: "B" }]);
spasreTasks.complete(id);                            // 小狗叼走
spasreTasks.restore(id);                             // 从回收站恢复
spasreTasks.purge(id);                               // 永久清除
spasreTasks.updateSettings({ defaultCategory: "工作" });
spasreTasks.setAgent({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-…" });
await spasreTasks.testAgent();                       // 测一下模型接口通不通
await spasreTasks.unlockAgent("密码");                // 解开设置密码门（首次调用即设密码）
spasreTasks.agentEnvText();                          // 生成 .env 文本
spasreTasks.importAgentEnv(text);                    // 从 .env 文本读入配置
spasreTasks.plan("复习 IR；整理周报");                 // 只算计划，不落库
await spasreTasks.ask("帮我规划这周");                 // → { source, reply, added }，没配接口就用内置规划
await spasreTasks.answer("今天有什么任务");            // 读任务板回答
await spasreTasks.requestPlan("帮我排一下本周任务");    // 同上，但只返回新增的任务数组
spasreTasks.linksFor(id);                            // 这条任务的延伸阅读（助手找过的都存在任务上）
spasreTasks.openLinks(id);                           // 打开延伸阅读弹窗（没有现成的就自动问一次助手）
spasreTasks.openLinkList("标题", links, { taskId: id, auto: false }); // 用现成链接开弹窗

// 笔记
spasreTasks.notes();                                  // 全部笔记
spasreTasks.noteFor({ taskId: id });                  // 这条任务挂着的笔记（也接受 goalId/nodeId）
spasreTasks.openNote({ taskId: id });                 // 有笔记就打开它，没有就新建一条再打开
spasreTasks.createNote({ title: "…", category: "学习", taskId: id });
spasreTasks.updateNote(id, { body: "…" });            // 改标题 / 正文 / 分类 / 关联
spasreTasks.removeNote(id);
spasreTasks.noteCategories();                         // 分类列表
spasreTasks.addNoteCategory("读论文");                 // 加一个分类，重名会返回原来的

// 长期目标
spasreTasks.goals();                                 // 全部目标
spasreTasks.goal(id);                                // 单个目标
spasreTasks.addGoal({ title: "学会写 LLVM 优化 pass", detail: "补充说明", category: "学习", startDate: "2026-10-12", pace: 2 });
spasreTasks.updateGoal(id, { nodes: […], planSource: "api", planNote: "…" });
spasreTasks.removeGoal(id, { withTasks: true });      // 顺手删掉它的任务（含回收站）
spasreTasks.goalTasks(id);                           // 这个目标铺出来的任务
spasreTasks.syncGoalTasks(id);                       // 让任务跟上节点（新建缺的，同步标题/日期/资料）
spasreTasks.toggleGoalNode(id, "n3", true);          // 点亮/取消一个节点，同时同步任务
await spasreTasks.agentChat([{ role: "user", content: "…" }], { temperature: 0.2, maxTokens: 2400 });
                                                     // 直接跟配好的模型说一句，返回文本
```

目标页的逻辑挂在 `window.spasreGoals` 上，大纲和排计划都在 `assets/js/goals.js`：

```js
await spasreGoals.planGoal(id);        // 排计划：模型 → 后端技能 → 内置，逐级回退
spasreGoals.plan(goal);                // 内置规划，只算不落库
spasreGoals.skillPlan(goal);           // 只走后端 learn.curriculum，返回 { nodes, note }
spasreGoals.layers(nodes);             // 拓扑分层
spasreGoals.order(nodes);              // 拓扑序
spasreGoals.acyclic(nodes);            // 是不是 DAG
spasreGoals.schedule();                // 统一排期：给所有缺时间的知识点填进日程表的空段
spasreGoals.schedule({ dry: true, goal });  // 只算不写（问「排得下吗」的时候用）
spasreGoals.renderSchedule();          // 重画日程表那块
spasreGoals.outline(title, nodes, meta);   // 拼出文本大纲（页面上显示、也存进 goal.outline）
spasreGoals.render();                  // 重画目标页
```

任务那边配套的日程接口：

```js
spasreTasks.segments();                // 一天切成哪几段 [{key,start,end}]
spasreTasks.checkSegments(list);       // 只校验、不动数据：合法返回 ""，不合法返回一句提示（重叠时就是「时间段有冲突」）
spasreTasks.clashKeys(list);           // 哪几段跟邻居叠了（网格拿它把那几行标红）
spasreTasks.setSegments(list);         // 改时间段：不合法会返回一句提示，合法返回 ""（整份替换）
spasreTasks.segment("evening");        // 取一段
spasreTasks.segmentMinutes("evening"); // 这段多长（分钟）
spasreTasks.slotHours("evening", 3);   // 3 小时放不进这段 → 按段长收窄
spasreTasks.segmentOrder();            // 排期的偏好顺序（从晚到早）
spasreTasks.busy();                    // 被划成非空闲的段 ["2026-10-15:forenoon"]
spasreTasks.setBusy(date, key, true);  // 划掉 / 放开一段
spasreTasks.slotTime("evening", 2.5);  // 一段里放两小时半 → "19:30–22:00"
spasreTasks.slotPassed(date, "morning"); // 这一段（按结束时刻算）过去了没
spasreTasks.overdue();                 // 过期没做的知识点 ["目标id/节点id"]
spasreTasks.locked();                  // 被过期前置挡住、暂时不该做的节点
```

## 配色

底色是**冷调蓝白**，点缀是**蓝 + 粉**：蓝给主按钮和标题，粉给完成态、推荐开关和兴趣标签，
另加五种马卡龙强调色，顶栏那条线是**蓝 → 粉的双色渐变**。

| 变量 | 颜色 | 用在哪 |
| --- | --- | --- |
| `--brand` | **蓝** | 主按钮、正文标题 |
| `--leaf` | **粉** | 完成态、推荐开关、本地推荐卡片、飘落花瓣 |
| `--blue` | 马卡龙天蓝 | 「学习」分类、今日任务区块、向导当前步骤 |
| `--teal` | 马卡龙薄荷 | 「工作」分类、向导已完成步骤 |
| `--sakura` | **樱花粉** | 「生活」分类、推荐卡片、兴趣点标签、面板/弹层底色 |
| `--violet` | 马卡龙丁香紫 | 「每日推荐」分类、AI 推荐卡片、目标卡片 |
| `--peach` | 马卡龙蜜桃 | 其它分类（按名字散列）、「重要」紧急度 |
| `--grad-duo` | **蓝 → 粉双色渐变** | 顶栏下沿细线（半透明）、页面标题下划线、区块标题下划线、目标进度条 |
| `--paper` / `--ink` | 冷白 / 蓝灰 | 页面底色与正文 |
| `--danger` / `--ok` | 红 / 蓝 | 逾期、已完成 |

**按钮保持素净**：右下角加号和站点标记走 `--grad-brand`（蓝 → 粉），不参与双色渐变以外的花样。

**任务卡片**：左边框用分类色，卡片底色是同一颜色的淡染，而且**列表从上到下越来越浅**——`taskItem()` 按位置算出 `--tint`（第一条 0.26，每条减 0.035，最低 0.05），CSS 用 `rgba(var(--accent-rgb), var(--tint))` 铺一层渐变。

**日程表的任务块**：`--sched-rgb` 按目标顺序取五种强调色之一（同一目标同色），样式在 `.sched-chip`。

**飘落花瓣**：颜色在 `assets/js/site.js` 的 `palette` 里，八种（樱花粉 / 蜜桃 / 柠檬 / 薄荷 / 天蓝 / 丁香 / 深粉 / 湖蓝）。

- 每个强调色都有 `-soft`（淡底）、`-line`（描边）和 `-rgb`（给 `rgba()` 用的分量）三个衍生值，明暗主题各一套。
- 分类配色表在 `assets/js/tasks.js` 的 `CATEGORY_ACCENT`（学习=1、工作=2、生活=3、每日推荐=4），其它分类按名字散列到 1~5。
- **改颜色要三处同步**：`:root`、`:root[data-theme="dark"]`、`@media (prefers-color-scheme: dark)` 三块里都定义了同一套变量，漏一处明暗模式就会不一致。页面 `<head>` 里的 `theme-color` 和 `site.js` 里的取色是两份硬编码的 `#f6f7fb` / `#121620`，换底色时别忘了。

### 右下角按钮的位置

「回到顶部」和「＋」共用一组几何变量，**都是同宽 + 同一个 `right`**，所以圆心天然在同一竖线上（窄屏改 `--dock-size` / `--dock-right` 也一起变）：

```css
:root { --dock-size: 54px; --dock-right: 22px; --dock-bottom: 22px; --dock-gap: 14px; }
```

- 加号在下方 `--dock-bottom + --dock-size + --dock-gap` 处，正好排在「回到顶部」上方。
- 加号的图标是内联 SVG（不是全角 `＋` 字符），所以视觉中心严格居中。

## 目录结构

```
index.html                 首页（这一周日程表概览 + 今日任务 + 每日推荐）
schedule.html              日程表（周 / 日 / 月三种看法，拖时间改时段都在这）
settings.html              设置（外观 + 兴趣标签 + 助手配置）
tasks.html                 任务板（任务、回收站、助手对话）
goals.html                 目标（文本大纲 + 学习路线图 + 新建目标四步向导）
notes.html                 笔记（分类、列表、编辑；能挂到任务或知识点上）
serve.ps1                  本地起服务（默认走后端；-Static 退回纯静态）
server.py                  后端：静态服务 + 配置存储 + 技能运行（只用标准库）
skills/                    技能目录，丢一个 .py 进来就自动被发现（改过的会自己重载）
skills/diagram_roadmap.py  画学习路线图（调 skills/vendor/archify，输出到 diagrams/）
skills/plan_outline.py     改大纲 / 读一份贴进来的规划（plan.outline）
skills/vendor/archify/     vendored 的 Archify（MIT，v3.0.1，需 Node ≥18；仓库里不带它自带的 test/ 与 examples/）
diagrams/                  画出来的学习路线图 HTML（同名重画会覆盖；.evidence/ 是校验证据）
config/                    看板数据（config/data.json；用 --data 可以指到别处，试新用户流程就靠它）
.env                       助手配置（接口地址 / 模型 / api key），只给 server.py 读，不是终端的环境文件
.vscode/settings.json      不让 Python 扩展把这个 .env 注入集成终端
assets/css/style.css       全站样式（各页共用，主题变量都在这）
assets/js/site.js          主题切换、花瓣飘落、回到顶部、滚动动画
assets/js/tasks.js         任务板逻辑、时间段定义（存在设置里）、助手与 window.spasreTasks 接口（目标和聊天记录也在这里）
assets/js/interest-lib.js  兴趣方向库 + 一步挑多个方向的界面（引导和设置页共用）
assets/js/notes.js         笔记页：分类、列表、编辑（数据还是走 window.spasreTasks）
assets/js/settings.js      设置页：兴趣标签的推荐
assets/js/onboard.js       新用户引导：要不要每日推荐 → 挑方向 → 配模型
assets/js/goals.js         长期目标 + 日程表：拓扑排序、大纲、统一排期、日程表网格（首页和目标页都加载，找不到对应区块就跳过）
assets/js/backend.js       前端 ↔ 后端桥：探活、同步配置、给功能调用技能（页面上不露脸；探活失败会自己重试）
assets/images/mascot/      贴纸吉祥物
```

几句提醒：**这是给本机（或自己手机）用的小工具**，不要直接挂到公网上 —— 接口只按来源 IP 放行，没有登录态，
`.env` 里的密钥也是明文；样式、功能随便改，改坏了 `config/data.json` 还在，数据不会跟着丢。
