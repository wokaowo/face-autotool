"""Single entry for the dataset tool.

No arguments starts the web app. --input runs the command line.
--python-service is used internally by the web process.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def bundle_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def want_cli(argv: list[str]) -> bool:
    for arg in argv[1:]:
        if arg in {"-h", "--help", "--input", "--model", "--output"} or arg.startswith("--input=") or arg.startswith("--model="):
            return True
    return False


def run_cli() -> int:
    bundled_model = bundle_root() / "face_yolov8s.pt"
    if "--model" not in sys.argv and not any(arg.startswith("--model=") for arg in sys.argv):
        if bundled_model.is_file():
            sys.argv.extend(["--model", str(bundled_model)])
    import main as cli

    return cli.main()


def serve_web() -> int:
    web = bundle_root() / "web"
    node = web / "node"
    server = web / "server.js"
    if not server.is_file() or not node.is_file():
        print("网页资源不在这个程序里。请在项目目录执行 npm run dev。", file=sys.stderr)
        return 1
    node.chmod(0o755)
    port = os.environ.get("PORT", "3000")
    os.environ["AUTO_IMG_BIN"] = sys.executable
    os.environ["AUTO_IMG_HOME"] = os.getcwd()
    os.environ["PORT"] = port
    os.environ["HOSTNAME"] = os.environ.get("HOSTNAME", "0.0.0.0")
    print(f"数据集产线 http://127.0.0.1:{port}")
    os.chdir(web)
    os.execv(str(node), [str(node), "server.js"])
    return 0


def main() -> int:
    if "--python-service" in sys.argv:
        import gui_service

        gui_service.run_serve()
        return 0
    if want_cli(sys.argv):
        return run_cli()
    return serve_web()


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
