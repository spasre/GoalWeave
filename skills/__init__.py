"""技能（skill）注册表。

每个技能就是 ``skills/`` 目录下的一个模块，模块里给出一个 ``SKILL`` 元信息
字典和一个 ``run(params, ctx)`` 函数。``skills/`` 里丢一个 ``.py`` 进来就会
被自动发现，不用改这里。

模块契约::

    SKILL = {
        "name": "echo",            # 唯一名字，也是 HTTP / CLI 里的调用名
        "title": "回声",            # 给人看的中文名
        "description": "原样返回输入。",
        "tags": ["调试"],
        "params": {                # 参数说明，只用于展示，不做强校验
            "text": "要回显的文本",
        },
        "requiresModel": False,    # 需要配好模型接口才能跑
    }

    def run(params, ctx):
        return {"text": params.get("text", "")}

``ctx`` 由后端注入，技能可以拿到配置和公共能力::

    ctx.chat(messages, temperature=0.2, max_tokens=None)  # 调模型，返回文本
    ctx.config                                             # 当前助手配置（dict，含明文 key）
    ctx.root                                               # 站点根目录 Path
    ctx.http_get(url, timeout=20, limit=200000, raw=False) # 拉一个网页，返回文本
                                                           # limit 是返回多少字符，跟下载多少字节无关
    ctx.log(message)                                       # 写一行日志
"""

import importlib
import pkgutil
from pathlib import Path

_PKG_DIR = Path(__file__).resolve().parent
_CACHE = None
_STAMPS = {}


def _stamp_of(module):
    path = getattr(module, "__file__", None)
    if not path:
        return None
    try:
        return Path(path).stat().st_mtime_ns
    except OSError:
        return None


def _reload_changed(cache):
    """技能文件改过了就重载它：改一个技能不用重启后端。"""
    for name, module in list(cache.items()):
        if isinstance(module, Exception):
            continue
        stamp = _stamp_of(module)
        if stamp is None or _STAMPS.get(name) == stamp:
            continue
        try:
            fresh = importlib.reload(module)
        except Exception as error:  # noqa: BLE001 - 改坏了就先用旧的
            continue
        meta = getattr(fresh, "SKILL", None)
        runner = getattr(fresh, "run", None)
        if not isinstance(meta, dict) or not callable(runner):
            continue
        _STAMPS[name] = _stamp_of(fresh)
        cache[str(meta.get("name") or name).strip() or name] = fresh
    return cache


def _discover():
    names = []
    for module in pkgutil.iter_modules([str(_PKG_DIR)]):
        if module.name.startswith("_"):
            continue
        names.append(module.name)
    return sorted(names)


def load_skills(force=False):
    """扫描并返回 ``{name: module}``，结果会缓存（文件改过的会自己重载）。"""
    global _CACHE
    if _CACHE is not None and not force:
        return _reload_changed(_CACHE)

    found = {}
    for module_name in _discover():
        try:
            module = importlib.import_module("skills." + module_name)
        except Exception as error:  # noqa: BLE001 - 单个技能坏了不该拖垮整站
            found["__error__:" + module_name] = error
            continue
        meta = getattr(module, "SKILL", None)
        runner = getattr(module, "run", None)
        if not isinstance(meta, dict) or not callable(runner):
            continue
        name = str(meta.get("name") or module_name).strip()
        if not name:
            continue
        found[name] = module
        _STAMPS[name] = _stamp_of(module)

    _CACHE = found
    return _CACHE


def _meta_of(module):
    meta = dict(module.SKILL)
    meta.setdefault("name", "")
    meta.setdefault("title", meta["name"])
    meta.setdefault("description", "")
    meta.setdefault("tags", [])
    meta.setdefault("params", {})
    meta.setdefault("requiresModel", False)
    return meta


def list_skills():
    """给 API 用的技能清单（不含可执行对象）。"""
    skills = []
    for name, module in load_skills().items():
        if isinstance(module, Exception):
            broken = name.split(":", 1)[1]
            skills.append({
                "name": broken,
                "title": broken,
                "description": "这个技能加载失败：" + str(module),
                "tags": ["错误"],
                "params": {},
                "requiresModel": False,
                "ok": False,
            })
            continue
        meta = _meta_of(module)
        skills.append({
            "name": meta["name"],
            "title": meta["title"],
            "description": meta["description"],
            "tags": list(meta["tags"]),
            "params": dict(meta["params"]),
            "requiresModel": bool(meta["requiresModel"]),
            "ok": True,
        })
    skills.sort(key=lambda item: (not item["ok"], item["name"]))
    return skills


def get_skill(name):
    module = load_skills().get(name)
    return None if isinstance(module, Exception) else module


def run_skill(name, params, ctx):
    """跑一个技能，返回它的结果。找不到就抛 ``KeyError``。"""
    module = get_skill(name)
    if module is None:
        raise KeyError(name)
    return module.run(params or {}, ctx)
