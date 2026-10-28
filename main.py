from __future__ import annotations

import argparse
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
CROP_SIZE = 1024


@dataclass(frozen=True)
class ImageTask:
    image: Image.Image
    output_stem: str
    source_path: Path
    extension: str


@dataclass(frozen=True)
class FaceDetection:
    index: int
    confidence: float
    box: tuple[float, float, float, float]


@dataclass(frozen=True)
class Stats:
    scanned: int = 0
    split_sources: int = 0
    split_images: int = 0
    processed: int = 0
    complete: int = 0
    incomplete: int = 0
    padded: int = 0
    resized: int = 0
    skipped_no_face: int = 0
    skipped_error: int = 0

    def add(self, **changes: int) -> "Stats":
        values = self.__dict__.copy()
        for key, delta in changes.items():
            values[key] += delta
        return Stats(**values)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Split long images, detect every face, and write 1024 generation samples."
    )
    parser.add_argument("--input", default=Path("./input"), type=Path, help="Input image directory.")
    parser.add_argument("--model", required=True, type=Path, help="Path to face_yolov8s.pt or a compatible YOLO model.")
    parser.add_argument("--output", default=Path("./output"), type=Path, help="Output root directory.")
    parser.add_argument("--ratio", default=16 / 9, type=float, help="Long-image threshold, evaluated as H/W.")
    parser.add_argument("--conf", default=0.25, type=float, help="YOLO confidence threshold.")
    parser.add_argument("--auto-conf", default=0.6, type=float, help="Minimum confidence for automatic ingest.")
    parser.add_argument("--min-face", default=64, type=float, help="Minimum face short side, in pixels, for automatic ingest.")
    parser.add_argument("--blur-threshold", default=50, type=float, help="Minimum Laplacian variance for automatic ingest.")
    parser.add_argument(
        "--face-ratio",
        default=0.45,
        type=float,
        help="Target face size as a fraction of output side length, using the larger face-box dimension.",
    )
    parser.add_argument("--val-ratio", default=0.1, type=float, help="Validation share. Faces from one source stay together.")
    parser.add_argument(
        "--seam-sensitivity",
        default=1.5,
        type=float,
        help="Higher values require stronger seam peaks; lower values split more aggressively.",
    )
    parser.add_argument(
        "--pad-incomplete",
        action="store_true",
        help="Kept for older commands. Crops that leave the image are always edge-padded to 1024.",
    )
    parser.add_argument(
        "--no-save-split",
        action="store_true",
        help="Kept for older commands. Split pieces are stored in the job directory.",
    )
    parser.add_argument("--device", default="auto", type=str, help="YOLO device: auto, cuda, cpu, or 0.")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if not args.input.is_dir():
        raise SystemExit(f"[ERROR] input directory does not exist: {args.input}")
    if not args.model.is_file():
        raise SystemExit(f"[ERROR] model file does not exist: {args.model}")
    if args.ratio <= 0:
        raise SystemExit("[ERROR] --ratio must be greater than 0")
    if not 0 <= args.conf <= 1:
        raise SystemExit("[ERROR] --conf must be between 0 and 1")
    if not 0 <= args.auto_conf <= 1:
        raise SystemExit("[ERROR] --auto-conf must be between 0 and 1")
    if args.min_face <= 0:
        raise SystemExit("[ERROR] --min-face must be greater than 0")
    if args.blur_threshold < 0:
        raise SystemExit("[ERROR] --blur-threshold must be 0 or greater")
    if not 0 < args.face_ratio < 1:
        raise SystemExit("[ERROR] --face-ratio must be between 0 and 1")
    if not 0 <= args.val_ratio <= 1:
        raise SystemExit("[ERROR] --val-ratio must be between 0 and 1")
    if args.seam_sensitivity <= 0:
        raise SystemExit("[ERROR] --seam-sensitivity must be greater than 0")


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def iter_images(input_dir: Path, excluded_dir: Path | None = None) -> Iterable[Path]:
    excluded_resolved = excluded_dir.resolve() if excluded_dir else None
    for path in sorted(input_dir.rglob("*")):
        if excluded_resolved and is_relative_to(path.resolve(), excluded_resolved):
            continue
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
            yield path


def safe_stem(path: Path, input_dir: Path) -> str:
    relative = path.relative_to(input_dir).with_suffix("")
    return re.sub(r"[^A-Za-z0-9._-]+", "_", relative.as_posix()).strip("_") or path.stem


def is_long_image(image: Image.Image, ratio: float) -> bool:
    width, height = image.size
    return width > 0 and height / width > ratio


def seam_boundaries(image: Image.Image, ratio: float, sensitivity: float) -> list[int]:
    try:
        import numpy as np
        from scipy.ndimage import gaussian_filter1d
        from scipy.signal import find_peaks
    except ImportError as exc:
        raise SystemExit("[ERROR] missing dependency for seam detection. Run: pip install -r requirements.txt") from exc

    width, height = image.size
    target_height = max(1, int(round(width * ratio)))
    min_gap = max(1, int(round(target_height * 0.4)))

    arr = np.asarray(image.convert("RGB"), dtype=np.int16)
    row_diff = np.abs(arr[:-1] - arr[1:]).mean(axis=(1, 2))
    smoothed = gaussian_filter1d(row_diff.astype(np.float32), sigma=5)
    prominence = max(float(np.std(smoothed) * sensitivity), 1e-6)

    peaks, _ = find_peaks(smoothed, distance=min_gap, prominence=prominence)
    boundaries = [int(peak) + 1 for peak in peaks]
    boundaries = filter_usable_boundaries(boundaries, height, min_gap)
    if boundaries:
        return boundaries

    pieces = max(2, int(math.ceil(height / target_height)))
    return [round(height * i / pieces) for i in range(1, pieces)]


def filter_usable_boundaries(boundaries: list[int], height: int, min_segment_height: int) -> list[int]:
    usable: list[int] = []
    previous = 0
    for boundary in sorted(set(boundaries)):
        if boundary - previous < min_segment_height:
            continue
        if height - boundary < min_segment_height:
            continue
        usable.append(boundary)
        previous = boundary
    return usable


def split_image(image: Image.Image, boundaries: list[int]) -> list[Image.Image]:
    width, height = image.size
    cuts = [0, *boundaries, height]
    return [image.crop((0, cuts[i], width, cuts[i + 1])) for i in range(len(cuts) - 1)]


def save_image(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    save_img = image
    if path.suffix.lower() in {".jpg", ".jpeg"} and image.mode not in {"RGB", "L"}:
        save_img = image.convert("RGB")
    save_img.save(path)


def build_tasks(args: argparse.Namespace) -> tuple[list[ImageTask], Stats]:
    try:
        from PIL import Image, ImageOps, UnidentifiedImageError
    except ImportError as exc:
        raise SystemExit("[ERROR] missing Pillow. Run: pip install -r requirements.txt") from exc

    split_dir = args.output / "split"
    tasks: list[ImageTask] = []
    stats = Stats()

    for image_path in iter_images(args.input, args.output):
        stats = stats.add(scanned=1)
        try:
            with Image.open(image_path) as opened:
                image = ImageOps.exif_transpose(opened).copy()
        except (OSError, UnidentifiedImageError) as exc:
            print(f"[SKIP] cannot open {image_path}: {exc}")
            stats = stats.add(skipped_error=1)
            continue

        stem = safe_stem(image_path, args.input)
        extension = image_path.suffix.lower()

        if is_long_image(image, args.ratio):
            stats = stats.add(split_sources=1)
            boundaries = seam_boundaries(image, args.ratio, args.seam_sensitivity)
            pieces = split_image(image, boundaries)
            print(f"[SPLIT] {image_path} -> {len(pieces)} pieces at {boundaries}")
            for index, piece in enumerate(pieces, start=1):
                piece_stem = f"{stem}_{index}"
                if not args.no_save_split:
                    save_image(piece, split_dir / f"{piece_stem}{extension}")
                tasks.append(ImageTask(piece, piece_stem, image_path, extension))
            stats = stats.add(split_images=len(pieces))
            continue

        tasks.append(ImageTask(image, stem, image_path, extension))

    return tasks, stats


def detect_faces(model: object, image: Image.Image, conf: float, device: str = "cpu") -> list[FaceDetection]:
    results = model.predict(image, conf=conf, save=False, verbose=False, device=device)
    if not results:
        return []

    boxes = results[0].boxes
    if boxes is None or len(boxes) == 0:
        return []

    detections: list[FaceDetection] = []
    confidences = boxes.conf.tolist()
    xyxy_boxes = boxes.xyxy.tolist()
    for index, (confidence, xyxy) in enumerate(zip(confidences, xyxy_boxes)):
        detections.append(
            FaceDetection(
                index=index,
                confidence=float(confidence),
                box=(float(xyxy[0]), float(xyxy[1]), float(xyxy[2]), float(xyxy[3])),
            )
        )

    detections.sort(key=lambda item: item.confidence, reverse=True)
    return detections


def best_face_box(model: object, image: Image.Image, conf: float, device: str = "cpu") -> tuple[float, float, float, float] | None:
    detections = detect_faces(model, image, conf, device=device)
    if not detections:
        return None

    return detections[0].box


def crop_around_face(
    image: Image.Image,
    box: tuple[float, float, float, float],
    face_ratio: float,
) -> tuple[Image.Image, bool, bool, bool]:
    x1, y1, x2, y2 = box
    face_width = max(x2 - x1, 1.0)
    face_height = max(y2 - y1, 1.0)
    crop_side = max(face_width, face_height) / face_ratio
    crop_side = max(crop_side, 1.0)
    cx = (x1 + x2) / 2
    cy = (y1 + y2) / 2
    left = int(math.floor(cx - crop_side / 2))
    top = int(math.floor(cy - crop_side / 2))
    right = int(math.ceil(cx + crop_side / 2))
    bottom = int(math.ceil(cy + crop_side / 2))
    return crop_square(image, (left, top, right, bottom))


def crop_square(
    image: Image.Image,
    crop_box: tuple[float, float, float, float],
) -> tuple[Image.Image, bool, bool, bool]:
    from PIL import Image, ImageOps

    try:
        import numpy as np
    except ImportError as exc:
        raise SystemExit("[ERROR] missing numpy. Run: pip install -r requirements.txt") from exc

    width, height = image.size
    left, top, right, bottom = crop_box
    left = int(math.floor(left))
    top = int(math.floor(top))
    right = int(math.ceil(right))
    bottom = int(math.ceil(bottom))

    pad_left = max(0, -left)
    pad_top = max(0, -top)
    pad_right = max(0, right - width)
    pad_bottom = max(0, bottom - height)

    padded = any((pad_left, pad_top, pad_right, pad_bottom))
    if padded:
        arr = np.asarray(image)
        if arr.ndim == 2:
            arr = arr[:, :, None]
        arr = np.pad(
            arr,
            ((pad_top, pad_bottom), (pad_left, pad_right), (0, 0)),
            mode="edge",
        )
        if image.mode == "L":
            image = Image.fromarray(arr[:, :, 0], mode=image.mode)
        else:
            image = Image.fromarray(arr, mode=image.mode)
        left += pad_left
        right += pad_left
        top += pad_top
        bottom += pad_top

    cropped = image.crop((left, top, right, bottom))
    resized = cropped.size != (CROP_SIZE, CROP_SIZE)
    if resized:
        cropped = ImageOps.fit(cropped, (CROP_SIZE, CROP_SIZE), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    complete = cropped.size == (CROP_SIZE, CROP_SIZE)
    return cropped, complete, padded, resized


def face_preview(image: Image.Image, box: tuple[float, float, float, float], size: int = 256) -> Image.Image:
    from PIL import Image, ImageOps

    x1, y1, x2, y2 = box
    face_width = max(x2 - x1, 1.0)
    face_height = max(y2 - y1, 1.0)
    pad_x = face_width * 0.35
    pad_y = face_height * 0.35

    left = max(0, int(math.floor(x1 - pad_x)))
    top = max(0, int(math.floor(y1 - pad_y)))
    right = min(image.size[0], int(math.ceil(x2 + pad_x)))
    bottom = min(image.size[1], int(math.ceil(y2 + pad_y)))

    preview = image.crop((left, top, right, bottom))
    return ImageOps.fit(preview, (size, size), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))


def paint_face(
    image: Image.Image,
    box: tuple[float, float, float, float],
    expand: float = 1.7,
    color: tuple[int, int, int] = (24, 24, 24),
) -> Image.Image:
    from PIL import Image

    return paint_faces(image, [box], expand=expand, color=color)


def paint_faces(
    image: Image.Image,
    boxes: list[tuple[float, float, float, float]],
    expand: float = 1.7,
    color: tuple[int, int, int] = (24, 24, 24),
) -> Image.Image:
    from PIL import Image

    painted = image.copy().convert("RGB")
    if not boxes:
        return painted

    width, height = painted.size
    for box in boxes:
        x1, y1, x2, y2 = box
        face_width = max(x2 - x1, 1.0)
        face_height = max(y2 - y1, 1.0)
        half_w = face_width * expand / 2
        half_h = face_height * expand / 2
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2

        left = max(0, int(math.floor(cx - half_w)))
        top = max(0, int(math.floor(cy - half_h)))
        right = min(width, int(math.ceil(cx + half_w)))
        bottom = min(height, int(math.ceil(cy + half_h)))

        overlay = Image.new("RGB", (right - left, bottom - top), color)
        painted.paste(overlay, (left, top))

    return painted


def resolve_device(requested: str) -> str:
    if requested == "cuda":
        try:
            import torch
            if torch.cuda.is_available():
                return "cuda"
        except ImportError:
            pass
        print("[WARN] CUDA not available, falling back to CPU")
        return "cpu"
    return requested


def run_detection_and_crop(tasks: list[ImageTask], args: argparse.Namespace, stats: Stats) -> Stats:
    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise SystemExit("[ERROR] missing ultralytics. Run: pip install -r requirements.txt") from exc

    complete_dir = args.output / "complete"
    incomplete_dir = args.output / "incomplete"
    complete_dir.mkdir(parents=True, exist_ok=True)
    incomplete_dir.mkdir(parents=True, exist_ok=True)

    device = resolve_device(args.device)
    model = YOLO(str(args.model))

    for task in tasks:
        try:
            box = best_face_box(model, task.image, args.conf, device=device)
            if box is None:
                print(f"[SKIP] no face: {task.source_path} ({task.output_stem})")
                stats = stats.add(skipped_no_face=1)
                continue

            cropped, complete, padded, resized = crop_around_face(task.image, box, args.face_ratio)
            target_dir = complete_dir if complete else incomplete_dir
            save_image(cropped, target_dir / f"{task.output_stem}{task.extension}")
            adjusted = padded or resized
            label = "complete+adjusted" if adjusted else ("complete" if complete else "incomplete")
            print(f"[OK] {label}: {task.output_stem}{task.extension}")
            stats = stats.add(
                processed=1,
                complete=1 if complete else 0,
                incomplete=0 if complete else 1,
                padded=1 if padded else 0,
                resized=1 if resized else 0,
            )
        except Exception as exc:
            print(f"[SKIP] failed {task.source_path} ({task.output_stem}): {exc}")
            stats = stats.add(skipped_error=1)

    return stats


def print_summary(stats: Stats) -> None:
    print("\nSummary")
    print(f"  scanned:          {stats.scanned}")
    print(f"  long images:      {stats.split_sources}")
    print(f"  split pieces:     {stats.split_images}")
    print(f"  cropped:          {stats.processed}")
    print(f"  complete:         {stats.complete}")
    print(f"  incomplete:       {stats.incomplete}")
    print(f"  adjusted:         {stats.padded}")
    print(f"  resized:          {stats.resized}")
    print(f"  skipped no face:  {stats.skipped_no_face}")
    print(f"  skipped errors:   {stats.skipped_error}")


def main() -> int:
    args = parse_args()
    validate_args(args)
    import pipeline

    return pipeline.run_cli(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n[ERROR] interrupted", file=sys.stderr)
        raise SystemExit(130)
