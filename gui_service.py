from __future__ import annotations

import argparse
import base64
import io
import json
import shutil
import sys
from pathlib import Path
import warnings

from PIL import Image, ImageOps
from ultralytics import YOLO

import main
import pipeline


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="JSON bridge for the web GUI.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    detect_parser = subparsers.add_parser("detect", help="Detect all faces in one image.")
    detect_parser.add_argument("--image", default=Path("./input"), type=Path)
    detect_parser.add_argument("--model", required=True, type=Path)
    detect_parser.add_argument("--conf", default=0.25, type=float)
    detect_parser.add_argument("--device", default="auto")

    process_parser = subparsers.add_parser("process", help="Process one selected face.")
    process_parser.add_argument("--image", required=True, type=Path)
    process_parser.add_argument("--keep-box-json")
    process_parser.add_argument("--crop-box-json")
    process_parser.add_argument("--erase-boxes-json")
    process_parser.add_argument("--face-ratio", default=0.45, type=float)

    serve_parser = subparsers.add_parser("serve", help="Persistent stdin/stdout JSON server.")

    return parser.parse_args()


def load_image(path: Path) -> Image.Image:
    with Image.open(path) as opened:
        return ImageOps.exif_transpose(opened).copy()


def image_to_data_url(image: Image.Image, format_name: str = "PNG") -> str:
    if format_name.upper() == "JPEG" and image.mode not in {"RGB", "L"}:
        image = image.convert("RGB")

    buffer = io.BytesIO()
    image.save(buffer, format=format_name)
    mime = "image/jpeg" if format_name.upper() == "JPEG" else "image/png"
    payload = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:{mime};base64,{payload}"


def parse_box(box_json: str) -> tuple[float, float, float, float]:
    box = json.loads(box_json)
    return float(box["x1"]), float(box["y1"]), float(box["x2"]), float(box["y2"])


def parse_boxes(boxes_json: str | None) -> list[tuple[float, float, float, float]]:
    if not boxes_json:
        return []

    boxes = json.loads(boxes_json)
    parsed: list[tuple[float, float, float, float]] = []
    for box in boxes:
        parsed.append(
            (
                float(box["x1"]),
                float(box["y1"]),
                float(box["x2"]),
                float(box["y2"]),
            )
        )
    return parsed


def parse_crop_box(crop_box_json: str | None) -> tuple[float, float, float, float] | None:
    if not crop_box_json:
        return None

    box = json.loads(crop_box_json)
    return float(box["x1"]), float(box["y1"]), float(box["x2"]), float(box["y2"])


def resolve_detect_device(device: str) -> str:
    if device != "auto":
        return device

    try:
        import torch
    except ImportError:
        return "cpu"

    if not torch.cuda.is_available():
        return "cpu"

    return "cuda:0"


def run_detect(args: argparse.Namespace, model: YOLO | None = None) -> None:
    image = load_image(args.image)
    if model is None:
        model = YOLO(str(args.model))
    requested_device = resolve_detect_device(args.device)

    try:
        detections = main.detect_faces(model, image, args.conf, device=requested_device)
        used_device = requested_device
    except Exception as error:
        if requested_device.startswith("cuda"):
            warnings.warn(f"CUDA inference failed, falling back to CPU: {error}")
            detections = main.detect_faces(model, image, args.conf, device="cpu")
            used_device = "cpu"
        else:
            raise

    payload = {
        "image": {
            "width": image.size[0],
            "height": image.size[1],
            "dataUrl": image_to_data_url(image),
            "name": args.image.name,
        },
        "runtime": {
            "device": used_device,
        },
        "faces": [
            {
                "index": detection.index,
                "confidence": detection.confidence,
                "box": {
                    "x1": detection.box[0],
                    "y1": detection.box[1],
                    "x2": detection.box[2],
                    "y2": detection.box[3],
                },
                "previewDataUrl": image_to_data_url(main.face_preview(image, detection.box)),
            }
            for detection in detections
        ],
    }
    print(json.dumps(payload, ensure_ascii=False))


def run_process(args: argparse.Namespace) -> None:
    image = load_image(args.image)
    keep_box_json = args.keep_box_json
    keep_box = parse_box(keep_box_json) if keep_box_json else None
    crop_box = parse_crop_box(args.crop_box_json)
    erase_boxes = parse_boxes(args.erase_boxes_json)

    if keep_box is None and not erase_boxes:
        raise SystemExit("At least one of --keep-box-json or --erase-boxes-json is required.")

    payload: dict[str, object] = {}

    if keep_box is not None:
        if crop_box is not None:
            cropped, complete, padded, resized = main.crop_square(image, crop_box)
        else:
            cropped, complete, padded, resized = main.crop_around_face(image, keep_box, args.face_ratio)
        payload["crop"] = {
            "dataUrl": image_to_data_url(cropped),
            "complete": complete,
            "padded": padded,
            "resized": resized,
            "size": {"width": cropped.size[0], "height": cropped.size[1]},
        }

    if erase_boxes:
        painted = main.paint_faces(image, erase_boxes)
        payload["painted"] = {
            "dataUrl": image_to_data_url(painted),
            "size": {"width": painted.size[0], "height": painted.size[1]},
        }

    print(json.dumps(payload, ensure_ascii=False))


def detect_payload(model: YOLO, image_path: str, conf: float, device: str) -> dict:
    image = load_image(Path(image_path))
    requested_device = resolve_detect_device(device)

    try:
        detections = main.detect_faces(model, image, conf, device=requested_device)
        used_device = requested_device
    except Exception as error:
        if requested_device.startswith("cuda"):
            warnings.warn(f"CUDA inference failed, falling back to CPU: {error}")
            detections = main.detect_faces(model, image, conf, device="cpu")
            used_device = "cpu"
        else:
            raise

    return {
        "image": {
            "width": image.size[0],
            "height": image.size[1],
            "dataUrl": image_to_data_url(image),
            "name": Path(image_path).name,
        },
        "runtime": {"device": used_device},
        "faces": [
            {
                "index": d.index,
                "confidence": d.confidence,
                "box": {"x1": d.box[0], "y1": d.box[1], "x2": d.box[2], "y2": d.box[3]},
                "previewDataUrl": image_to_data_url(main.face_preview(image, d.box)),
            }
            for d in detections
        ],
    }


def process_payload(image_path: str, keep_box: dict | None, crop_box: dict | None, erase_boxes: list, face_ratio: float) -> dict:
    image = load_image(Path(image_path))
    parsed_keep = parse_box(json.dumps(keep_box)) if keep_box else None
    parsed_crop = parse_crop_box(json.dumps(crop_box)) if crop_box else None
    parsed_erase = [parse_box(json.dumps(b)) for b in erase_boxes] if erase_boxes else []

    payload: dict[str, object] = {}

    if parsed_keep is not None:
        if parsed_crop is not None:
            cropped, complete, padded, resized = main.crop_square(image, parsed_crop)
        else:
            cropped, complete, padded, resized = main.crop_around_face(image, parsed_keep, face_ratio)
        payload["crop"] = {
            "dataUrl": image_to_data_url(cropped),
            "complete": complete,
            "padded": padded,
            "resized": resized,
            "size": {"width": cropped.size[0], "height": cropped.size[1]},
        }

    if parsed_erase:
        painted = main.paint_faces(image, parsed_erase)
        payload["painted"] = {
            "dataUrl": image_to_data_url(painted),
            "size": {"width": painted.size[0], "height": painted.size[1]},
        }

    return payload


def filter_faces_payload(
    model: YOLO,
    input_path: str,
    output_path: str,
    conf: float,
    device: str,
) -> dict:
    input_dir = Path(input_path).expanduser().resolve()
    output_dir = Path(output_path).expanduser().resolve()

    if not input_dir.is_dir():
        raise ValueError(f"输入文件夹不存在：{input_dir}")
    if input_dir == output_dir:
        raise ValueError("输出路径不能和输入文件夹相同。")
    if not 0 <= conf <= 1:
        raise ValueError("检测置信度必须在 0 到 1 之间。")

    image_paths = list(main.iter_images(input_dir, output_dir))
    if not image_paths:
        raise ValueError("输入文件夹里没有可处理的图片。")

    output_dir.mkdir(parents=True, exist_ok=True)
    noneface_dir = output_dir / "noneface"
    requested_device = resolve_detect_device(device)
    used_device = requested_device
    face_count = 0
    noneface_count = 0
    error_count = 0
    errors: list[dict[str, str]] = []

    for image_path in image_paths:
        relative_path = image_path.relative_to(input_dir)
        try:
            image = load_image(image_path)
            try:
                detections = main.detect_faces(model, image, conf, device=used_device)
            except Exception as error:
                if used_device.startswith("cuda"):
                    warnings.warn(f"CUDA inference failed, falling back to CPU: {error}")
                    used_device = "cpu"
                    detections = main.detect_faces(model, image, conf, device=used_device)
                else:
                    raise

            target_path = (output_dir if detections else noneface_dir) / relative_path
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(image_path, target_path)
            if detections:
                face_count += 1
            else:
                noneface_count += 1
        except Exception as error:
            error_count += 1
            errors.append({"path": str(relative_path), "error": str(error)})

    return {
        "inputPath": str(input_dir),
        "outputPath": str(output_dir),
        "nonefacePath": str(noneface_dir),
        "scanned": len(image_paths),
        "withFace": face_count,
        "withoutFace": noneface_count,
        "errors": error_count,
        "errorDetails": errors[:20],
        "runtime": {"device": used_device},
    }


def _job_result(action: str, cmd: dict, model: YOLO) -> dict:
    if action == "detect":
        return detect_payload(
            model,
            cmd["image"],
            cmd.get("conf", 0.25),
            cmd.get("device", "auto"),
        )
    if action == "process":
        return process_payload(
            cmd["image"],
            cmd.get("keepBox"),
            cmd.get("cropBox"),
            cmd.get("eraseBoxes", []),
            cmd.get("faceRatio", 0.45),
        )
    if action == "filter_faces":
        return filter_faces_payload(
            model,
            cmd["inputPath"],
            cmd["outputPath"],
            cmd.get("conf", 0.25),
            cmd.get("device", "auto"),
        )
    output_path = str(cmd.get("outputPath") or "")
    if action == "job_start":
        params = cmd.get("params") if isinstance(cmd.get("params"), dict) else None
        return pipeline.start_job(str(cmd.get("inputPath") or ""), output_path, params, bool(cmd.get("rerun")))
    if action == "job_status":
        return pipeline.job_status(output_path)
    if action == "job_cancel":
        return pipeline.cancel_job(output_path)
    if action == "job_sample":
        crop_box = cmd.get("cropBox") if isinstance(cmd.get("cropBox"), dict) else None
        identity = cmd.get("identity") if "identity" in cmd else None
        redraw = cmd.get("redraw") if isinstance(cmd.get("redraw"), dict) else None
        return pipeline.update_sample(output_path, str(cmd.get("sampleId") or ""), str(cmd.get("op") or ""), crop_box, identity, redraw)
    if action == "job_params":
        params = cmd.get("params") if isinstance(cmd.get("params"), dict) else {}
        return pipeline.update_params(output_path, params)
    if action == "job_export":
        return pipeline.export_job(output_path, str(cmd.get("kind") or ""))
    if action == "job_cursor":
        return pipeline.set_cursor(output_path, str(cmd.get("pieceId") or ""), str(cmd.get("sampleId") or ""))
    return {"error": f"unknown command: {action}"}


def model_file() -> Path:
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return root / "face_yolov8s.pt"


def run_serve() -> None:
    model_path = str(model_file())
    model = YOLO(model_path)
    pipeline.bind_model(model)
    print(json.dumps({"status": "ready"}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"error": "invalid json"}), flush=True)
            continue

        action = cmd.get("cmd")
        request_id = cmd.get("_id")
        if action == "exit":
            break

        try:
            result = _job_result(action, cmd, model)
        except Exception as error:
            result = {"error": str(error)}

        if request_id:
            result["_id"] = request_id
        print(json.dumps(result, ensure_ascii=False), flush=True)


def main_cli() -> int:
    args = parse_args()
    if args.command == "detect":
        run_detect(args)
    elif args.command == "process":
        run_process(args)
    elif args.command == "serve":
        run_serve()
    else:
        raise SystemExit(f"unknown command: {args.command}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main_cli())
