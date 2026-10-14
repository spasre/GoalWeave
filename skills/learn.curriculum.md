# SKILL: learn.curriculum（learning-curriculum-decomposer）

输入学习目标，生成分层知识点学习路径。

自动判断目标复杂度：

1. 简单学习目标：直接拆解知识点集合、依赖、验收标准。
2. 专业 / 硬核学习目标：调用搜索工具，获取领域权威教程 / 大纲，基于文档结构再执行知识点拆分。

> 这份是技能说明书（`skills/` 只自动发现 `.py`，`.md` 只是文档）。实现见 `skills/learn_curriculum.py`。

## Rules

1. 识别是否属于专业硬核领域（编译器、硬件、竞赛、专业开发框架等），是则启动资料检索。
2. 检索仅提取章节、知识先后顺序、重难点，不加载全文。
3. 输出结构：总目标 → 多个学习阶段（知识点集合）→ 单个知识点【类型 + 名称 + 验收标准】，标注前置依赖。
4. 粒度：单个知识点 1~3 小时学习 + 练习。
5. 兜底：检索失败时，使用内置知识拆分，并增加警告提示。

## 两套方案怎么合到一起的

| 原方案 | 实现方式 |
| --- | --- |
| 方案 1 串行两步式（先资料、后拆解） | `mode=research`，或 `mode=auto` 且判为硬核目标时自动走两步 |
| 方案 2 双模式切换（简单目标直接拆、硬核目标先检索） | `mode=auto`（默认）：通用目标不联网，硬核目标自动触发检索 |

判断结果（`hardcore` / `domain`）和动作（`want_research`）是分开的：`mode=direct` 只表示「这次不联网」，命中硬核领域时仍然用该领域的教学顺序模板，不会把目标降级成通用目标。

## 约束落点

- **只用结构不用正文**：`_extract_outline()` 先删 `script/style/nav/header/footer/aside/form`，再只取 `<h1>~<h4>` 的标题文字；送进模型的 `_outline_text()` 截到 6000 字符；结果里的 `headingsSample` 给出前 12 个标题作为可核验证据。
- **去重**：`_normalize_curriculum()` 按归一化名字去重；阶段之间靠 `_group_by_level()` + 每份资料分块（`share = max(2, 6 // 资料数)`）轮流取，避免一份大文档吃光预算。
- **标注来源**：每个阶段带 `sources`，markdown 里渲染成「参考：…」。
- **兜底**：`NO_SOURCE_NOTICE`（没抓到资料）/ `MODEL_FAIL_NOTICE`（模型也没通），以 `> ⚠️` 写在 markdown 开头，同时在结果 `warnings` 里返回。
- **顺序**：已知领域优先用内置的教学顺序模板（参考手册的章节顺序不适合当学习顺序），检索到但模板没覆盖的主题折成「资料补充主题」阶段挂在最后；未知硬核领域才用检索到的章节顺序。

## 参数

| 参数 | 说明 |
| --- | --- |
| `goal` | 学习目标，必填 |
| `mode` | `auto`（默认）/ `direct`（只拆不检索）/ `research`（强制检索） |
| `level` | `auto` / `simple` / `hardcore` |
| `hoursPerUnit` | 1~3，默认 2 |
| `maxUnits` | 4~60，默认 24 |
| `weeklyHours` | 每周投入小时，用于算阶段周数 |
| `sources` | 指定资料网址，数组或换行文本；给了就优先抓这些 |

## 返回

`goal` / `mode`（实际走的：`research` 或 `direct`）/ `requestedMode` / `domain` / `hardcore` / `researchPlanned` / `reason` / `source`（`api` 或 `local`）/ `notice` / `warnings` / `sources[]`（含 `headingsSample`）/ `sourceFailures[]` / `stages[]`（`name`、`summary`、`weeks`、`sources`、`units[]`）/ `stats` / `markdown`。

## 调用

```powershell
python server.py --skill learn.curriculum --params-file goal.json
```

```http
POST /api/skills/learn.curriculum
{ "goal": "系统学 LLVM 编译器后端", "mode": "auto", "weeklyHours": 8 }
```
