#!/usr/bin/env python3
"""任务板后端。

原来任务板是纯前端的：设置里的接口地址、模型名、密钥全存在浏览器 localStorage，
调模型也是网页直连（CORS 不通就只能自己搭代理）。这个后端补上两块：

1. **存配置**：把前端填的接口地址 / 模型名 / 密钥 / 自定义接口落到本地
   ``config/agent.json``，网页关掉再开也还在，别的机器上的前端也能复用。
2. **跑技能**：``skills/`` 目录下每个 ``.py`` 就是一个技能，后端统一
   ``GET /api/skills`` 列出来、``POST /api/skills/<name>`` 跑起来。配好模型后，
   技能可以借后端的模型客户端干活，绕开浏览器的跨域限制。

顺带它还直接当静态服务器用（默认 8777，和原来的 serve.ps1 一个端口），
所以前端、API、技能是同一个 origin，不用再管 CORS。

跑起来::

    python server.py                # 起服务，默认 http://127.0.0.1:8777/
    python server.py --port 9000
    python server.py --data config/data.fresh.json   # 换一份看板数据（试新用户流程用）
    python server.py --lan          # 顺便让同一 WiFi / 手机热点的设备也能打开
    python server.py --list-skills  # 只列技能
    python server.py --skill echo --params "{\\"text\\":\\"hi\\"}"   # 命令行跑一个技能

HTTP 接口::

    GET    /api/health              服务状态
    GET    /api/config              读配置（默认隐藏密钥，?reveal=1 才带明文）
    POST   /api/config              写配置（部分字段即可）
    DELETE /api/config              清空配置
    GET    /api/config/env          导出 .env 文本
    POST   /api/config/env          从 .env 文本导入
    POST   /api/config/test         测一下模型接口通不通
    POST   /api/chat                转发一次 OpenAI 兼容的对话请求
    POST   /api/ask                 把一段话拆成任务（模型优先，回退内置规则）
    GET    /api/skills              列技能
    POST   /api/skills/<name>       跑技能，body 就是它的 params
    GET    /api/data                读看板数据（任务 / 目标 / 设置，带 rev 版本号）
    PUT    /api/data                整份覆盖写（body ``{"store": {...}}``，rev 自增）
    DELETE /api/data                清空
"""

import argparse
import datetime
import http.server
import ipaddress
import json
import os
import re
import socket
import socketserver
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import skills

ROOT = Path(__file__).resolve().parent
CONFIG_DIR = ROOT / "config"
CONFIG_FILE = ROOT / ".env"            # 助手配置（含 api key）就存这里
LEGACY_CONFIG_FILE = CONFIG_DIR / "agent.json"   # 老版本存的位置，读到就搬走
DATA_FILE = CONFIG_DIR / "data.json"
DIAGRAM_DIR = ROOT / "diagrams"
SERVICE_NAME = "spasre-taskboard-backend"
VERSION = "1.0.0"
DEFAULT_TIMEOUT = 60
MAX_BODY = 4 * 1024 * 1024

CONFIG_FIELDS = ("baseUrl", "model", "apiKey", "endpoint", "rememberKey")
ENV_KEYS = {
    "baseUrl": "SPASRE_AGENT_BASE_URL",
    "model": "SPASRE_AGENT_MODEL",
    "apiKey": "SPASRE_AGENT_API_KEY",
    "rememberKey": "SPASRE_AGENT_REMEMBER_KEY",
    "endpoint": "SPASRE_AGENT_ENDPOINT",
}


# --------------------------------------------------------------------------- #
# 配置存取
# --------------------------------------------------------------------------- #

def _blank_config():
    return {"baseUrl": "", "model": "", "apiKey": "", "endpoint": "", "rememberKey": True,
            "updatedAt": ""}


def load_config():
    config = _blank_config()
    if CONFIG_FILE.exists():
        config.update(_config_from_env(CONFIG_FILE.read_text(encoding="utf-8-sig", errors="replace")))
        return config
    return _migrate_legacy_config(config)


def _migrate_legacy_config(config):
    """老版本把配置写在 config/agent.json 里；搬进 .env 之后把旧文件删掉，密钥不留两份。"""
    if not LEGACY_CONFIG_FILE.exists():
        return config
    try:
        stored = json.loads(LEGACY_CONFIG_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        print("[config] 旧的 agent.json 读不动，忽略：" + str(error), file=sys.stderr)
        return config
    if not isinstance(stored, dict):
        return config
    for field in CONFIG_FIELDS:
        if field in stored:
            config[field] = stored[field]
    if not (model_ready(config) or config.get("apiKey")):
        return config
    save_config(config)
    try:
        LEGACY_CONFIG_FILE.unlink()
        print("[config] 已把 config/agent.json 搬进 .env，旧文件删掉了", flush=True)
    except OSError:
        pass
    return config


def _replace_with_retry(tmp, target, tries=5):
    """Windows 上 os.replace 偶尔会被别的东西（杀软 / 索引器 / 编辑器）短暂占住目标文件，
    报 WinError 5；等一下重试通常就过去了。真过不去就把异常抛出去。"""
    last = None
    for attempt in range(tries):
        try:
            os.replace(tmp, target)
            return
        except OSError as error:
            last = error
            time.sleep(0.05 * (attempt + 1))
    raise last


def save_config(config):
    config["updatedAt"] = datetime.datetime.now().isoformat(timespec="seconds")
    tmp = CONFIG_FILE.parent / (CONFIG_FILE.name + ".tmp")
    tmp.write_text(env_text(config), encoding="utf-8")
    _replace_with_retry(tmp, CONFIG_FILE)
    try:  # 密钥文件尽量只给自己看（Windows 上不一定生效，失败就算了）
        os.chmod(CONFIG_FILE, 0o600)
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# 看板数据（任务 / 目标 / 设置）：存在后端，所有浏览器拿到的是同一份
# --------------------------------------------------------------------------- #

def _blank_data():
    return {"rev": 0, "updatedAt": "", "store": None}


def load_data():
    """读看板数据；文件坏了就当作还没有数据，不把异常抛给调用方。"""
    data = _blank_data()
    if DATA_FILE.exists():
        try:
            stored = json.loads(DATA_FILE.read_text(encoding="utf-8-sig"))
            if isinstance(stored, dict):
                rev = stored.get("rev")
                if isinstance(rev, int) and rev >= 0:
                    data["rev"] = rev
                if isinstance(stored.get("store"), dict):
                    data["store"] = stored["store"]
                data["updatedAt"] = str(stored.get("updatedAt") or "")
        except (OSError, ValueError) as error:
            print("[data] data.json 读不动，当作空：" + str(error), file=sys.stderr)
    return data


def _write_data(rev, store, updated_at):
    payload = {"rev": rev, "updatedAt": updated_at, "store": store}
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
    _replace_with_retry(tmp, DATA_FILE)
    return rev


def save_data(store):
    """写看板数据；rev 自增后返回新的 rev（前端靠它判断要不要重新拉）。"""
    rev = load_data()["rev"] + 1
    return _write_data(rev, store if isinstance(store, dict) else None,
                       datetime.datetime.now().isoformat(timespec="seconds"))


def clear_data():
    rev = load_data()["rev"] + 1
    return _write_data(rev, None, datetime.datetime.now().isoformat(timespec="seconds"))


def _parse_env_text(text):
    found = {}
    for line in str(text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        found[key.strip()] = value
    return found


def _config_from_env(text):
    env = _parse_env_text(text)
    patch = {}
    for field, key in ENV_KEYS.items():
        if key not in env:
            continue
        if field == "rememberKey":
            patch[field] = env[key].strip().lower() != "false"
        else:
            patch[field] = env[key]
    return patch


def env_text(config):
    lines = [
        "# spasre 任务板 · 助手配置",
        "# 后端读写这个文件：api key 也在里面，别外传、别提交",
        ENV_KEYS["baseUrl"] + "=" + str(config.get("baseUrl", "") or ""),
        ENV_KEYS["model"] + "=" + str(config.get("model", "") or ""),
        ENV_KEYS["apiKey"] + "=" + str(config.get("apiKey", "") or ""),
        ENV_KEYS["rememberKey"] + "=" + ("true" if config.get("rememberKey", True) else "false"),
        ENV_KEYS["endpoint"] + "=" + str(config.get("endpoint", "") or ""),
    ]
    return "\n".join(lines) + "\n"


def mask_key(key):
    key = str(key or "")
    if not key:
        return ""
    if len(key) <= 8:
        return "•" * len(key)
    return key[:4] + "•" * 6 + key[-4:]


def public_config(config, reveal=False):
    return {
        "baseUrl": config.get("baseUrl", ""),
        "model": config.get("model", ""),
        "endpoint": config.get("endpoint", ""),
        "rememberKey": bool(config.get("rememberKey", True)),
        "hasKey": bool(config.get("apiKey")),
        "apiKey": str(config.get("apiKey", "") or "") if reveal else "",
        "apiKeyMasked": mask_key(config.get("apiKey")),
        "configured": model_ready(config),
        "updatedAt": config.get("updatedAt", ""),
        "configFile": str(CONFIG_FILE),
    }


# --------------------------------------------------------------------------- #
# 模型调用
# --------------------------------------------------------------------------- #

def model_ready(config):
    if not config:
        return False
    if str(config.get("baseUrl", "") or "").strip() and str(config.get("model", "") or "").strip():
        return True
    return bool(str(config.get("endpoint", "") or "").strip())


def chat_url(base):
    trimmed = str(base or "").strip().rstrip("/")
    if not trimmed:
        return ""
    if trimmed.endswith("/chat/completions"):
        return trimmed
    return trimmed + "/chat/completions"


def _http_error_message(status, detail):
    if status in (401, 403):
        return "密钥不对或者没权限（" + str(status) + "）" + detail
    if status == 404:
        return "接口地址不对（404），根路径一般要带 /v1" + detail
    if status == 429:
        return "请求太频繁，或者额度用完了（429）" + detail
    if status == 400:
        return "请求被接口拒绝（400）" + detail
    if status >= 500:
        return "接口自己出错了（" + str(status) + "）" + detail
    return "接口返回 " + str(status) + detail


def chat_completion(config, messages, temperature=0.2, max_tokens=None, timeout=DEFAULT_TIMEOUT):
    """调 OpenAI 兼容接口，返回正文文本。"""
    url = chat_url(config.get("baseUrl"))
    model = str(config.get("model", "") or "").strip()
    if not url:
        raise RuntimeError("还没配模型接口地址（baseUrl）。")
    if not model:
        raise RuntimeError("还没配模型名（model）。")

    body = {"model": model, "messages": messages, "temperature": temperature}
    if max_tokens:
        body["max_tokens"] = int(max_tokens)
    headers = {"Content-Type": "application/json"}
    key = str(config.get("apiKey", "") or "").strip()
    if key:
        headers["Authorization"] = "Bearer " + key

    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                     headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace") or "{}")
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            raw = error.read().decode("utf-8", errors="replace")
            parsed = json.loads(raw or "{}")
            detail = ": " + str((parsed.get("error") or {}).get("message") or "") if parsed else ""
        except Exception:  # noqa: BLE001
            detail = ""
        raise RuntimeError(_http_error_message(error.code, detail)) from error
    except urllib.error.URLError as error:
        raise RuntimeError("连不上接口：" + str(error.reason) + "（地址写错、网络不通，或者需要代理）") from error
    except (TimeoutError, socket.timeout) as error:
        raise RuntimeError("请求超时了，模型太慢或者地址不通。") from error

    choices = payload.get("choices") or []
    content = ""
    if choices and isinstance(choices[0], dict):
        content = str((choices[0].get("message") or {}).get("content") or "")
    if not content.strip():
        raise RuntimeError("模型没有返回内容。")
    return content


def ask_custom_endpoint(config, payload, timeout=DEFAULT_TIMEOUT):
    """自定义接口：{prompt, today, categories, tasks} -> {tasks|reply}。"""
    url = str(config.get("endpoint", "") or "").strip()
    if not url:
        raise RuntimeError("还没配自定义接口地址（endpoint）。")
    request = urllib.request.Request(
        url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", errors="replace") or "{}")
    except urllib.error.HTTPError as error:
        raise RuntimeError("自定义接口返回 " + str(error.code)) from error
    except urllib.error.URLError as error:
        raise RuntimeError("连不上自定义接口：" + str(error.reason)) from error


def overlay_config(config, patch):
    """把请求里临时带的配置叠到存好的那份上。

    空字符串一律当「没给」：前端（尤其是拿不到密钥的手机浏览器）会把空值一起发上来，
    别让它把后端存好的地址 / 模型 / 密钥冲掉。
    """
    if not isinstance(patch, dict):
        return config
    for field in CONFIG_FIELDS:
        if field not in patch:
            continue
        value = patch[field]
        if isinstance(value, str) and not value.strip():
            continue
        config[field] = value
    return config


MIN_FETCH_BYTES = 2000000


def http_get_text(url, timeout=20, limit=200000, raw=False, max_bytes=None):
    """抓一个网页。

    ``limit`` 是**返回**多少字符，``max_bytes`` 是**下载**多少字节——两件事分开。
    以前下载量直接取 ``limit * 4``，于是 ``limit=400`` 只读回 1600 字节（大概是 <head>），
    正文等于没抓到；现在下载量有个下限，小 ``limit`` 也能拿到真正的开头。
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("只支持 http/https 地址")
    if max_bytes is None:
        max_bytes = max(MIN_FETCH_BYTES, limit * 4)
    request = urllib.request.Request(url, headers={"User-Agent": "spasre-taskboard/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(max_bytes).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        raise RuntimeError("目标返回 " + str(error.code)) from error
    except urllib.error.URLError as error:
        raise RuntimeError("抓不到这个地址：" + str(error.reason)) from error
    if raw:
        # raw=True 时保留标签，给需要看标题层级的技能用（例如 learn.curriculum）
        return body[:limit]
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", body)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;?", " ", text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()[:limit]


# --------------------------------------------------------------------------- #
# 技能上下文
# --------------------------------------------------------------------------- #

class SkillContext:
    """注入给技能的公共能力。"""

    def __init__(self, config, root):
        self.config = config
        self.root = Path(root)
        self.logs = []

    def model_ready(self):
        return model_ready(self.config)

    def log(self, message):
        self.logs.append(str(message))

    def chat(self, messages, temperature=0.2, max_tokens=None):
        if str(self.config.get("baseUrl", "") or "").strip():
            return chat_completion(self.config, messages, temperature=temperature, max_tokens=max_tokens)
        if str(self.config.get("endpoint", "") or "").strip():
            prompt = "\n".join(str(item.get("content", "")) for item in messages if isinstance(item, dict))
            data = ask_custom_endpoint(self.config, {"prompt": prompt, "today": datetime.date.today().isoformat()})
            if isinstance(data, dict) and data.get("reply"):
                return str(data["reply"])
            if isinstance(data, dict) and data.get("tasks"):
                return json.dumps(data["tasks"], ensure_ascii=False)
            raise RuntimeError("自定义接口没有返回 reply。")
        raise RuntimeError("还没配模型接口，先 POST /api/config 存一下。")

    def http_get(self, url, timeout=20, limit=200000, raw=False, max_bytes=None):
        return http_get_text(url, timeout=timeout, limit=limit, raw=raw, max_bytes=max_bytes)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "SpasreTaskboard/" + VERSION

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # -- 小工具 ---------------------------------------------------------- #

    def log_message(self, fmt, *args):
        sys.stderr.write("[http] " + (fmt % args) + "\n")

    def end_headers(self):
        # 本地开发用：静态文件也不让浏览器缓存，改完刷新就能看到，不用手动清缓存
        if not getattr(self, "_no_store", False):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")

    def _is_local(self):
        """请求是不是从本机发出的（用来决定能不能吐明文密钥）。"""
        host = (self.client_address[0] if self.client_address else "") or ""
        return host.startswith("127.") or host in ("::1", "localhost")

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._no_store = True
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, status, text, content_type="text/plain; charset=utf-8"):
        body = str(text).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._no_store = True
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("请求体太大了")
        raw = self.rfile.read(length)
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError as error:
            raise ValueError("body 不是合法 JSON：" + str(error)) from error
        if not isinstance(data, dict):
            raise ValueError("body 得是一个 JSON 对象")
        return data

    # -- 路由 ------------------------------------------------------------ #

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            self._route("GET", path)
            return
        super().do_GET()

    def do_HEAD(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            self.send_response(200)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_HEAD()

    def do_POST(self):
        self._route("POST", urllib.parse.urlparse(self.path).path)

    def do_PUT(self):
        self._route("PUT", urllib.parse.urlparse(self.path).path)

    def do_DELETE(self):
        self._route("DELETE", urllib.parse.urlparse(self.path).path)

    def _route(self, method, path):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            if not ip_allowed(self.client_address[0] if self.client_address else ""):
                return self._send_json(403, {"ok": False, "error": "这个接口只对本机和热点网段开放（要放别的网段进来用 --allow）"})

            if path == "/api/health" and method == "GET":
                return self._send_json(200, {
                    "ok": True, "service": SERVICE_NAME, "version": VERSION,
                    "time": datetime.datetime.now().isoformat(timespec="seconds"),
                    "root": str(ROOT),
                })

            if path == "/api/config" and method in ("POST", "PUT"):
                return self._handle_config_save()
            if path == "/api/config" and method == "GET":
                reveal = query.get("reveal", ["0"])[0] not in ("0", "", "false")
                # 明文密钥只给本机看：跑了 --lan 之后，同一网络里的设备别想直接把密钥捞走
                return self._send_json(200, {"ok": True, "config": public_config(load_config(), reveal and self._is_local())})
            if path == "/api/config" and method == "DELETE":
                save_config(_blank_config())
                return self._send_json(200, {"ok": True, "config": public_config(load_config(), self._is_local())})

            if path == "/api/config/env" and method == "GET":
                if not self._is_local():
                    return self._send_json(403, {"ok": False, "error": "导出密钥只允许在本机操作"})
                return self._send_text(200, env_text(load_config()))
            if path == "/api/config/env" and method == "POST":
                body = self._read_json()
                text = body.get("text")
                if text is None:
                    text = body.get("env")
                if text is None:
                    raise ValueError("缺少 text 字段")
                patch = _config_from_env(text)
                if not patch:
                    raise ValueError("没解析到 SPASRE_AGENT_* 配置")
                return self._handle_config_save(patch)

            if path == "/api/config/test" and method == "POST":
                return self._handle_config_test()

            if path == "/api/data" and method == "GET":
                return self._handle_data_get()
            if path == "/api/data" and method in ("POST", "PUT"):
                return self._handle_data_save()
            if path == "/api/data" and method == "DELETE":
                return self._send_json(200, {"ok": True, "rev": clear_data()})

            if path == "/api/chat" and method == "POST":
                return self._handle_chat()
            if path in ("/api/ask", "/api/plan") and method == "POST":
                return self._handle_ask()

            if path == "/api/skills" and method == "GET":
                return self._send_json(200, {"ok": True, "skills": skills.list_skills()})
            if path.startswith("/api/skills/") and method == "POST":
                name = urllib.parse.unquote(path[len("/api/skills/"):]).strip("/")
                return self._handle_skill(name)

            return self._send_json(404, {"ok": False, "error": "没有这个接口：" + method + " " + path})
        except ValueError as error:
            self._send_json(400, {"ok": False, "error": str(error)})
        except KeyError as error:
            self._send_json(404, {"ok": False, "error": "没有这个技能：" + str(error).strip("'")})
        except RuntimeError as error:
            self._send_json(502, {"ok": False, "error": str(error)})
        except Exception as error:  # noqa: BLE001
            self.log_message("unhandled error: %s", error)
            self._send_json(500, {"ok": False, "error": "后端出错了：" + str(error)})

    # -- 各接口实现 ------------------------------------------------------ #

    def _handle_config_save(self, patch=None):
        body = patch if isinstance(patch, dict) else self._read_json()
        config = load_config()
        changed = []
        # 显式要求清空的字段；此外空值一律当「没填」，不能算清空
        clear_fields = set()
        if body.get("clearKey"):
            clear_fields.add("apiKey")
        if isinstance(body.get("clearFields"), list):
            clear_fields.update(str(item) for item in body["clearFields"])
        for field in CONFIG_FIELDS:
            if field not in body:
                continue
            value = body[field]
            if field == "rememberKey":
                config[field] = bool(value)
                changed.append(field)
                continue
            text = str(value or "").strip()
            # 空字符串不等于清空：换个没配过的浏览器（比如手机）打开时，
            # 它手里没配置，推上来的空值别把这台机器上配好的地址 / 模型 / 密钥冲掉。
            if not text and field not in clear_fields:
                continue
            config[field] = text
            changed.append(field)
        for field in clear_fields:
            if field in CONFIG_FIELDS and field not in body:
                config[field] = ""
                changed.append(field)
        if not changed:
            return self._send_json(200, {"ok": True, "config": public_config(config, self._is_local()), "changed": []})
        save_config(config)
        return self._send_json(200, {"ok": True, "config": public_config(config, self._is_local()), "changed": changed})

    def _handle_config_test(self):
        body = self._read_json()
        config = overlay_config(load_config(), body)  # 允许用 body 里的临时值覆盖
        model = str(config.get("model", "") or "").strip()
        if str(config.get("baseUrl", "") or "").strip():
            chat_completion(config, [{"role": "user", "content": "ping"}],
                            temperature=0, max_tokens=8, timeout=30)
            return self._send_json(200, {"ok": True, "message": "连接正常，" + model + " 可以用了。",
                                         "mode": "openai", "model": model})
        if str(config.get("endpoint", "") or "").strip():
            ask_custom_endpoint(config, {"prompt": "ping", "today": datetime.date.today().isoformat()}, timeout=30)
            return self._send_json(200, {"ok": True, "message": "自定义接口通了。", "mode": "custom", "model": ""})
        return self._send_json(200, {"ok": False, "error": "还没配接口地址，先 POST /api/config 存一下。"})

    def _handle_data_get(self):
        data = load_data()
        return self._send_json(200, {
            "ok": True,
            "rev": data["rev"],
            "updatedAt": data["updatedAt"],
            "store": data["store"],
            "file": str(DATA_FILE),
        })

    def _handle_data_save(self):
        body = self._read_json()
        store = body.get("store")
        if store is not None and not isinstance(store, dict):
            raise ValueError("store 得是一个对象")
        return self._send_json(200, {"ok": True, "rev": save_data(store)})

    def _handle_chat(self):
        body = self._read_json()
        config = overlay_config(load_config(), body)
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            prompt = str(body.get("prompt", "") or "").strip()
            if not prompt:
                raise ValueError("要么给 messages 数组，要么给 prompt")
            messages = []
            system = str(body.get("system", "") or "").strip()
            if system:
                messages.append({"role": "system", "content": system})
            messages.append({"role": "user", "content": prompt})
        temperature = body.get("temperature", 0.2)
        try:
            temperature = float(temperature)
        except (TypeError, ValueError):
            temperature = 0.2
        max_tokens = body.get("max_tokens")
        reply = chat_completion(config, messages, temperature=temperature, max_tokens=max_tokens)
        return self._send_json(200, {"ok": True, "reply": reply,
                                     "model": str(config.get("model", "") or "")})

    def _handle_ask(self):
        body = self._read_json()
        config = overlay_config(load_config(), body)
        prompt = str(body.get("prompt", "") or "").strip()
        if not prompt:
            raise ValueError("prompt 不能为空")
        params = {
            "prompt": prompt,
            "today": body.get("today"),
            "categories": body.get("categories"),
            "defaultCategory": body.get("defaultCategory"),
        }
        ctx = SkillContext(config, ROOT)
        result = skills.run_skill("plan.tasks", params, ctx)
        result["ok"] = True
        return self._send_json(200, result)

    def _handle_skill(self, name):
        if not name:
            raise ValueError("技能名不能为空")
        if skills.get_skill(name) is None:
            raise KeyError(name)
        params = self._read_json()
        # 允许 body 里带 config 覆盖，方便临时用一套接口跑技能
        config = overlay_config(load_config(), params.pop("__config__", None))
        ctx = SkillContext(config, ROOT)
        started = datetime.datetime.now()
        try:
            result = skills.run_skill(name, params, ctx)
        except Exception as error:  # noqa: BLE001 - 技能自己的错也要回给前端
            elapsed = (datetime.datetime.now() - started).total_seconds()
            self.log_message("skill %s failed: %s", name, error)
            return self._send_json(200, {"ok": False, "skill": name, "error": str(error),
                                         "logs": ctx.logs, "seconds": round(elapsed, 3)})
        elapsed = (datetime.datetime.now() - started).total_seconds()
        return self._send_json(200, {"ok": True, "skill": name, "result": result,
                                     "logs": ctx.logs, "seconds": round(elapsed, 3)})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# 空 = 不限制；用 --lan 时会限制成「本机 + 热点网段 + --allow 里加的网段」
ALLOWED_NETS = []


def parse_allowlist(values):
    nets = []
    for raw in values or []:
        for item in str(raw).split(","):
            item = item.strip()
            if not item:
                continue
            try:
                nets.append(ipaddress.ip_network(item, strict=False))
            except ValueError:
                print("跳过看不懂的网段：" + item, file=sys.stderr)
    return nets


def ip_allowed(host):
    if not ALLOWED_NETS:
        return True
    if host.startswith("127.") or host in ("::1", "localhost"):
        return True
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(addr in net for net in ALLOWED_NETS)


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #

def lan_addresses():
    """本机在局域网 / 热点里可以被其它设备访问的地址，Windows 手机热点网关排最前。"""
    found = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in found and not ip.startswith(("127.", "169.254.")):
                found.append(ip)
    except OSError:
        pass
    # 手机热点（Windows 移动热点）的网关固定是 192.168.137.1，手机要连的就是它
    found.sort(key=lambda ip: (not ip.startswith("192.168.137."), ip))
    return found


def serve(host, port, open_browser=False, allow=None):
    global ALLOWED_NETS
    if not (ROOT / "index.html").exists():
        print("警告：这个目录里没有 index.html，静态文件可能不对：" + str(ROOT), file=sys.stderr)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if host == "0.0.0.0":
        # 只放本机和手机热点网段进来：这台机器同时还在校园网里，别人扫到也读不到数据
        ALLOWED_NETS = [ipaddress.ip_network("192.168.137.0/24")] + parse_allowlist(allow)
    address = "http://localhost:" + str(port) + "/"
    config = load_config()
    print("任务板后端 " + VERSION + " —— " + address, flush=True)
    print("  站点目录：" + str(ROOT), flush=True)
    print("  配置文件：" + str(CONFIG_FILE) + ("（已存在）" if CONFIG_FILE.exists() else "（还没有，等前端来存）"), flush=True)
    is_side_store = DATA_FILE != (CONFIG_DIR / "data.json")
    print("  数据文件：" + str(DATA_FILE) + ("（已存在）" if DATA_FILE.exists() else "（还没有，等前端来存）")
          + ("   ← 分身库，正式数据没动" if is_side_store else ""), flush=True)
    print("  助手状态：" + ("已配置 " + str(config.get("model") or "自定义接口") if model_ready(config) else "还没配置"), flush=True)
    print("  技能数量：" + str(len([s for s in skills.list_skills() if s["ok"]])), flush=True)
    if host == "0.0.0.0":
        print("  已监听所有网卡，同一个 WiFi / 热点里的手机可以打开：", flush=True)
        for ip in lan_addresses():
            print("    http://" + ip + ":" + str(port) + "/", flush=True)
        print("  接口只放行本机和这些网段：" + "、".join(str(net) for net in ALLOWED_NETS), flush=True)
    print("  Ctrl-C 停止", flush=True)
    if open_browser:
        import webbrowser
        webbrowser.open(address)
    with Server((host, port), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")


def main(argv=None):
    parser = argparse.ArgumentParser(description="任务板后端：静态服务 + 配置存储 + 技能运行")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--lan", action="store_true", help="监听所有网卡，让同一 WiFi / 手机热点的设备也能打开")
    parser.add_argument("--allow", action="append", metavar="CIDR",
                        help="配合 --lan 追加允许访问接口的网段，可重复或逗号分隔（热点网段默认已放行）")
    parser.add_argument("--port", type=int, default=8777, help="端口，默认 8777")
    parser.add_argument("--data", metavar="PATH",
                        help="换一份看板数据文件（默认 config/data.json）；想体验新用户流程就指一个不存在的路径")
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    parser.add_argument("--list-skills", action="store_true", help="列出所有技能后退出")
    parser.add_argument("--skill", metavar="NAME", help="跑一个技能后退出")
    parser.add_argument("--params", default="{}", help="技能参数，JSON 字符串")
    parser.add_argument("--params-file", metavar="PATH", help="技能参数，从 JSON 文件读（中文更省事）")
    args = parser.parse_args(argv)

    global DATA_FILE
    if args.data:
        custom = Path(args.data).expanduser()
        DATA_FILE = custom if custom.is_absolute() else (ROOT / custom)

    if args.list_skills:
        for item in skills.list_skills():
            flag = "" if item["ok"] else "  [加载失败]"
            model = "  (需要模型)" if item["requiresModel"] else ""
            print(item["name"].ljust(16) + item["title"] + model + flag)
            if item["description"]:
                print(" " * 18 + item["description"])
        return 0

    if args.skill:
        raw = args.params
        if args.params_file:
            try:
                raw = Path(args.params_file).read_text(encoding="utf-8-sig")
            except OSError as error:
                print("读不了 --params-file：" + str(error), file=sys.stderr)
                return 2
        try:
            params = json.loads(raw)
        except ValueError as error:
            print("参数不是合法 JSON：" + str(error), file=sys.stderr)
            return 2
        if not isinstance(params, dict):
            print("--params 得是一个 JSON 对象", file=sys.stderr)
            return 2
        ctx = SkillContext(load_config(), ROOT)
        try:
            result = skills.run_skill(args.skill, params, ctx)
        except KeyError:
            print("没有这个技能：" + args.skill, file=sys.stderr)
            return 2
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"ok": False, "skill": args.skill, "error": str(error)},
                             ensure_ascii=False, indent=2))
            return 1
        print(json.dumps({"ok": True, "skill": args.skill, "result": result, "logs": ctx.logs},
                         ensure_ascii=False, indent=2))
        return 0

    serve("0.0.0.0" if args.lan else args.host, args.port, open_browser=args.open, allow=args.allow)
    return 0


if __name__ == "__main__":
    sys.exit(main())
