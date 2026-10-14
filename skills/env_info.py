"""环境信息：看看后端跑在什么机器上、配置有没有到位。"""

import datetime
import platform
import sys

SKILL = {
    "name": "env.info",
    "title": "环境信息",
    "description": "返回 Python 版本、系统、站点目录，以及助手配置是否就绪。",
    "tags": ["调试", "系统"],
    "params": {},
    "requiresModel": False,
}


def run(params, ctx):
    config = ctx.config or {}
    return {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "system": platform.platform(),
        "root": str(ctx.root),
        "time": datetime.datetime.now().isoformat(timespec="seconds"),
        "config": {
            "baseUrl": config.get("baseUrl", ""),
            "model": config.get("model", ""),
            "endpoint": config.get("endpoint", ""),
            "hasKey": bool(config.get("apiKey")),
            "configured": bool((config.get("baseUrl") and config.get("model")) or config.get("endpoint")),
        },
    }
