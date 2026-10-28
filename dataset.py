from __future__ import annotations

import hashlib
import math
import re
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image


REASON_ORDER = (
    "multi_face",
    "low_confidence",
    "out_of_frame",
    "small_face",
    "padded",
    "blur",
    "duplicate",
)

_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_stem(value: str) -> str:
    text = _ILLEGAL.sub("_", value or "")
    text = text.replace(" ", "_")
    text = re.sub(r"_+", "_", text).strip(" ._")
    return text or "image"


def file_part(value: str) -> str:
    text = _ILLEGAL.sub("_", value or "")
    text = re.sub(r"_+", "_", text).strip(" ._")
    return text or "image"


def original_parts(relative_source: str) -> tuple[str, str]:
    path = Path(relative_source or "")
    suffix = path.suffix if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"} else ".jpg"
    parts = [file_part(part) for part in path.parts[:-1] if part not in ("", ".", "..")]
    parts.append(file_part(path.stem))
    return "/".join(parts), suffix


def claim_original_name(stem: str, source_key: str, used: dict[str, str]) -> str:
    base = (stem or "").strip("/") or "image"
    owner = used.get(base)
    if owner is None or owner == source_key:
        used[base] = source_key
        return base

    folder, leaf = base.rsplit("/", 1) if "/" in base else ("", base)
    index = 2
    while True:
        name = f"{leaf}_{index}"
        candidate = f"{folder}/{name}" if folder else name
        owner = used.get(candidate)
        if owner is None or owner == source_key:
            used[candidate] = source_key
            return candidate
        index += 1


def sample_extension(sample: dict) -> str:
    suffix = str(sample.get("extension") or ".jpg")
    if suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
        return ".jpg"
    return suffix


def fit_stem(stem: str, limit: int = 80) -> str:
    cleaned = safe_stem(stem)
    if len(cleaned.encode("utf-8")) <= limit:
        return cleaned
    digest = hashlib.sha1(cleaned.encode("utf-8")).hexdigest()[:8]
    tail = safe_stem(cleaned[-24:])
    return f"{digest}_{tail}"


def claim_stem(stem: str, source_key: str, used: dict[str, str]) -> str:
    base = fit_stem(stem)
    owner = used.get(base)
    if owner is None or owner == source_key:
        used[base] = source_key
        return base

    digest = hashlib.sha1(source_key.encode("utf-8")).hexdigest()[:6]
    candidate = fit_stem(f"{base}_{digest}")
    if used.get(candidate) not in {None, source_key}:
        candidate = fit_stem(f"{base}_{digest}_{len(used)}")
    used[candidate] = source_key
    return candidate


def clean_float(value: float) -> float:
    number = float(value)
    if math.isnan(number) or math.isinf(number):
        return 0.0
    return number


def box_tuple(box: dict | tuple | list) -> tuple[float, float, float, float]:
    if isinstance(box, dict):
        return (float(box["x1"]), float(box["y1"]), float(box["x2"]), float(box["y2"]))
    return (float(box[0]), float(box[1]), float(box[2]), float(box[3]))


def box_dict(box: dict | tuple | list) -> dict[str, float]:
    x1, y1, x2, y2 = box_tuple(box)
    return {"x1": x1, "y1": y1, "x2": x2, "y2": y2}


def crop_box_from_face(box: dict | tuple | list, face_ratio: float) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = box_tuple(box)
    face_width = max(x2 - x1, 1.0)
    face_height = max(y2 - y1, 1.0)
    crop_side = max(max(face_width, face_height) / face_ratio, 1.0)
    center_x = (x1 + x2) / 2
    center_y = (y1 + y2) / 2
    left = int(math.floor(center_x - crop_side / 2))
    top = int(math.floor(center_y - crop_side / 2))
    right = int(math.ceil(center_x + crop_side / 2))
    bottom = int(math.ceil(center_y + crop_side / 2))
    return left, top, right, bottom


def is_padded(crop_box: dict | tuple | list, width: int, height: int) -> bool:
    left, top, right, bottom = box_tuple(crop_box)
    return left < 0 or top < 0 or right > width or bottom > height


def is_out_of_frame(box: dict | tuple | list, width: int, height: int, tolerance: float = 1.0) -> bool:
    x1, y1, x2, y2 = box_tuple(box)
    return x1 < -tolerance or y1 < -tolerance or x2 > width + tolerance or y2 > height + tolerance


def face_short_side(box: dict | tuple | list) -> float:
    x1, y1, x2, y2 = box_tuple(box)
    return min(max(x2 - x1, 0.0), max(y2 - y1, 0.0))


def laplacian_variance(image: Image.Image) -> float:
    gray = np.asarray(image.convert("L"), dtype=np.float32)
    if gray.shape[0] < 3 or gray.shape[1] < 3:
        return 0.0
    if max(gray.shape) > 480:
        step = int(max(gray.shape) // 480) + 1
        gray = gray[::step, ::step]
        if gray.shape[0] < 3 or gray.shape[1] < 3:
            return 0.0
    center = gray[1:-1, 1:-1]
    lap = gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:] - 4.0 * center
    return clean_float(lap.var())


def face_blur(image: Image.Image, box: dict | tuple | list) -> float:
    x1, y1, x2, y2 = [int(round(value)) for value in box_tuple(box)]
    x1 = max(0, min(image.width, x1))
    x2 = max(0, min(image.width, x2))
    y1 = max(0, min(image.height, y1))
    y2 = max(0, min(image.height, y2))
    if x2 - x1 < 3 or y2 - y1 < 3:
        return 0.0
    return laplacian_variance(image.crop((x1, y1, x2, y2)))


def average_hash(image: Image.Image, size: int = 8) -> str:
    small = np.asarray(image.convert("L").resize((size, size)), dtype=np.float32)
    mean = float(small.mean())
    return "".join("1" if bit else "0" for bit in small.flatten() > mean)


def hamming(left: str, right: str) -> int:
    if len(left) != len(right) or not left:
        return 64
    return sum(bit_a != bit_b for bit_a, bit_b in zip(left, right))


def is_duplicate(phash: str, seen: Iterable[str], distance: int) -> bool:
    return any(hamming(phash, other) <= distance for other in seen)


def quality_reasons(
    *,
    face_count: int,
    confidence: float,
    out_of_frame: bool,
    short_side: float,
    min_face: float,
    padded: bool,
    blur: float,
    blur_threshold: float,
    duplicate: bool,
    auto_conf: float,
) -> list[str]:
    found = set()
    if face_count != 1:
        found.add("multi_face")
    if confidence < auto_conf:
        found.add("low_confidence")
    if out_of_frame:
        found.add("out_of_frame")
    if short_side < min_face:
        found.add("small_face")
    if padded:
        found.add("padded")
    if blur < blur_threshold:
        found.add("blur")
    if duplicate:
        found.add("duplicate")
    return [reason for reason in REASON_ORDER if reason in found]


def set_reason(reasons: list[str], reason: str, present: bool) -> list[str]:
    found = set(reasons)
    if present:
        found.add(reason)
    else:
        found.discard(reason)
    return [item for item in REASON_ORDER if item in found]


def split_for_source(source_key: str, val_ratio: float) -> str:
    if val_ratio <= 0:
        return "train"
    if val_ratio >= 1:
        return "val"
    digest = hashlib.sha1(source_key.encode("utf-8")).digest()
    bucket = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF
    return "val" if bucket < val_ratio else "train"


def box_iou(left: dict | tuple | list, right: dict | tuple | list) -> float:
    ax1, ay1, ax2, ay2 = box_tuple(left)
    bx1, by1, bx2, by2 = box_tuple(right)
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    if union <= 0:
        return 0.0
    return inter / union


def take_iou_match(candidates: list[dict], box: dict | tuple | list, threshold: float = 0.5) -> dict | None:
    best_index = -1
    best_score = threshold
    for index, candidate in enumerate(candidates):
        score = box_iou(candidate["box"], box)
        if score >= best_score:
            best_score = score
            best_index = index
    if best_index < 0:
        return None
    return candidates.pop(best_index)


def yolo_line(box: dict | tuple | list, width: int, height: int) -> str:
    x1, y1, x2, y2 = box_tuple(box)
    safe_width = max(width, 1)
    safe_height = max(height, 1)
    x_center = min(1.0, max(0.0, ((x1 + x2) / 2) / safe_width))
    y_center = min(1.0, max(0.0, ((y1 + y2) / 2) / safe_height))
    box_width = min(1.0, max(0.0, (x2 - x1) / safe_width))
    box_height = min(1.0, max(0.0, (y2 - y1) / safe_height))
    return f"0 {x_center:.6f} {y_center:.6f} {box_width:.6f} {box_height:.6f}"


def redraw_pair(
    image: Image.Image,
    crop_box: dict | tuple | list,
    edit_boxes: Iterable | None = None,
    size: int = 1024,
) -> tuple[Image.Image, Image.Image, bool]:
    width, height = image.size
    left, top, right, bottom = [int(value) for value in (
        math.floor(box_tuple(crop_box)[0]),
        math.floor(box_tuple(crop_box)[1]),
        math.ceil(box_tuple(crop_box)[2]),
        math.ceil(box_tuple(crop_box)[3]),
    )]
    pad_left = max(0, -left)
    pad_top = max(0, -top)
    pad_right = max(0, right - width)
    pad_bottom = max(0, bottom - height)
    padded = any((pad_left, pad_top, pad_right, pad_bottom))
    source = np.asarray(image.convert("RGB"))
    if padded:
        source = np.pad(source, ((pad_top, pad_bottom), (pad_left, pad_right), (0, 0)), mode="edge")
    canvas_h, canvas_w = source.shape[:2]
    mask = Image.new("L", (canvas_w, canvas_h), 255 if padded else 0)
    if padded:
        mask.paste(Image.new("L", (width, height), 0), (pad_left, pad_top))
    for box in edit_boxes or []:
        x1, y1, x2, y2 = box_tuple(box)
        grow_x = max((x2 - x1) * 0.08, 1)
        grow_y = max((y2 - y1) * 0.08, 1)
        rect = (
            max(0, int(math.floor(x1 - grow_x)) + pad_left),
            max(0, int(math.floor(y1 - grow_y)) + pad_top),
            min(canvas_w, int(math.ceil(x2 + grow_x)) + pad_left),
            min(canvas_h, int(math.ceil(y2 + grow_y)) + pad_top),
        )
        if rect[2] > rect[0] and rect[3] > rect[1]:
            mask.paste(255, rect)
    crop = (left + pad_left, top + pad_top, right + pad_left, bottom + pad_top)
    base = Image.fromarray(source, mode="RGB").crop(crop)
    mask = mask.crop(crop)
    if base.size != (size, size):
        base = base.resize((size, size), Image.Resampling.LANCZOS)
        mask = mask.resize((size, size), Image.Resampling.NEAREST)
    return base, mask, padded


def sidecar(sample: dict) -> dict:
    box = box_tuple(sample["box"])
    crop = box_tuple(sample["cropBox"])
    return {
        "id": sample["id"],
        "source": sample["relativeSource"],
        "piece": sample["pieceIndex"],
        "confidence": round(clean_float(sample["confidence"]), 6),
        "box": list(box),
        "cropBox": list(crop),
        "padded": bool(sample["padded"]),
        "resized": bool(sample.get("resized", True)),
        "blur": round(clean_float(sample["blur"]), 3),
        "faceShortSide": round(clean_float(sample["faceShortSide"]), 2),
        "outOfFrame": bool(sample.get("outOfFrame")),
        "reasons": list(sample.get("reasons") or []),
        "identity": sample.get("identity") or "",
        "split": sample.get("split") or "train",
        "phash": sample.get("phash") or "",
        "manual": bool(sample.get("manual")),
        "redraw": (sample.get("redraw") or {}).get("kind") or "",
        "mask": sample.get("maskPath") or (sample.get("redraw") or {}).get("maskPath") or "",
    }


def identity_folder(name: str) -> str:
    raw = (name or "").strip()
    if not raw:
        return "unknown"
    cleaned = safe_stem(raw)
    if cleaned == "image" and raw != "image":
        return "unknown"
    return cleaned
