from __future__ import annotations

import json
import shutil
import sys
import threading
import warnings
from pathlib import Path

import dataset
import main


_lock = threading.Lock()
_jobs: dict[str, dict] = {}
_threads: dict[str, threading.Thread] = {}
_model = None

DEFAULT_PARAMS = {
    "conf": 0.25,
    "autoConf": 0.6,
    "minFace": 64.0,
    "blurThreshold": 50.0,
    "faceRatio": 0.45,
    "valRatio": 0.1,
    "longRatio": 16 / 9,
    "seamSensitivity": 1.5,
    "duplicateDistance": 8,
    "device": "auto",
}


def bind_model(model: object) -> None:
    global _model
    _model = model


def normalize_params(params: dict | None) -> dict:
    source = {**DEFAULT_PARAMS, **(params or {})}
    conf = min(1.0, max(0.0, float(source["conf"])))
    auto_conf = min(1.0, max(0.0, float(source["autoConf"])))
    min_face = max(1.0, float(source["minFace"]))
    blur_threshold = max(0.0, float(source["blurThreshold"]))
    face_ratio = min(0.95, max(0.05, float(source["faceRatio"])))
    val_ratio = min(1.0, max(0.0, float(source["valRatio"])))
    long_ratio = max(0.1, float(source["longRatio"]))
    seam = max(0.1, float(source["seamSensitivity"]))
    distance = max(0, int(source["duplicateDistance"]))
    device = str(source.get("device") or "auto")
    return {
        "conf": conf,
        "autoConf": auto_conf,
        "minFace": min_face,
        "blurThreshold": blur_threshold,
        "faceRatio": face_ratio,
        "valRatio": val_ratio,
        "longRatio": long_ratio,
        "seamSensitivity": seam,
        "duplicateDistance": distance,
        "device": device,
    }


def summarize(state: dict) -> dict:
    samples = state.get("samples") or []
    review = [sample for sample in samples if sample.get("status") == "review"]
    reasons = {reason: 0 for reason in dataset.REASON_ORDER}
    for sample in review:
        for reason in sample.get("reasons") or []:
            if reason in reasons:
                reasons[reason] += 1
    ingested = sum(sample.get("status") == "ingested" for sample in samples)
    total = len(samples)
    return {
        "total": total,
        "ingested": ingested,
        "review": len(review),
        "excluded": sum(sample.get("status") == "excluded" for sample in samples),
        "skipped": sum(sample.get("status") == "skipped" for sample in samples),
        "noFace": len(state.get("noFace") or []),
        "errors": len(state.get("errors") or []),
        "reasons": reasons,
        "train": sum(sample.get("status") == "ingested" and sample.get("split") == "train" for sample in samples),
        "val": sum(sample.get("status") == "ingested" and sample.get("split") == "val" for sample in samples),
        "completion": int(round(100 * ingested / total)) if total else 0,
    }


def _snapshot(state: dict) -> dict:
    payload = json.loads(json.dumps(state, ensure_ascii=False))
    payload["summary"] = summarize(state)
    return payload


def _save(state: dict) -> None:
    output = Path(state["outputPath"])
    output.mkdir(parents=True, exist_ok=True)
    temporary = output / "job.json.tmp"
    temporary.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    temporary.replace(output / "job.json")


def _key(output_path: Path) -> str:
    return str(output_path.resolve())


def _worker_alive(key: str) -> bool:
    worker = _threads.get(key)
    return bool(worker and worker.is_alive())


def _finish_worker(key: str) -> None:
    # Pop only this thread. A newer worker may already own the slot.
    current = _threads.get(key)
    if current is threading.current_thread():
        _threads.pop(key, None)


def _spawn(key: str, target) -> bool:
    if _worker_alive(key):
        return False
    worker = threading.Thread(target=target, daemon=True)
    _threads[key] = worker
    worker.start()
    return True


def _load_image(path: Path):
    from PIL import Image, ImageOps

    with Image.open(path) as opened:
        return ImageOps.exif_transpose(opened).copy()


def _save_preview(image, path: Path, max_edge: int = 1280) -> None:
    preview = image.copy()
    preview.thumbnail((max_edge, max_edge))
    main.save_image(preview, path)


def _resolve_device(requested: str) -> str:
    if requested in {"auto", "cuda"}:
        return main.resolve_device("cuda")
    return requested or "cpu"


def _detect(model, image, conf: float, runtime: dict):
    requested = runtime.get("device") or "cpu"
    try:
        return main.detect_faces(model, image, conf, device=requested)
    except Exception as error:
        if str(requested).startswith("cuda"):
            warnings.warn(f"CUDA inference failed, falling back to CPU: {error}")
            runtime["device"] = "cpu"
            return main.detect_faces(model, image, conf, device="cpu")
        raise


def load_piece_image(piece: dict, output_dir: Path):
    if piece.get("imageStored"):
        return _load_image(output_dir / piece["imagePath"])
    return _load_image(Path(piece["imagePath"]))


def _bump(state: dict, record: dict) -> None:
    state["revision"] = int(state.get("revision") or 0) + 1
    record["revision"] = state["revision"]


def write_generation(output_dir: Path, image, sample: dict) -> None:
    cropped, _complete, padded, resized = main.crop_square(image, dataset.box_tuple(sample["cropBox"]))
    sample["padded"] = bool(padded)
    sample["resized"] = bool(resized)
    sample["reasons"] = dataset.set_reason(sample.get("reasons") or [], "padded", bool(padded))
    split = sample.get("split") or "train"
    extension = dataset.sample_extension(sample)
    crop_rel = f"dataset/generation/{split}/{sample['id']}{extension}"
    side_rel = f"dataset/generation/{split}/{sample['id']}.json"
    main.save_image(cropped, output_dir / crop_rel)
    (output_dir / side_rel).parent.mkdir(parents=True, exist_ok=True)
    (output_dir / side_rel).write_text(
        json.dumps(dataset.sidecar(sample), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    sample["cropPath"] = crop_rel
    sample["sidecarPath"] = side_rel


def delete_generation(output_dir: Path, sample: dict) -> None:
    for key in ("cropPath", "sidecarPath"):
        relative = sample.get(key) or ""
        if not relative:
            continue
        target = output_dir / relative
        if target.is_file():
            target.unlink()
        sample[key] = ""


def _piece_by_id(state: dict, piece_id: str) -> dict | None:
    return next((piece for piece in state.get("pieces") or [] if piece["id"] == piece_id), None)


def _sample_by_id(state: dict, sample_id: str) -> dict | None:
    return next((sample for sample in state.get("samples") or [] if sample["id"] == sample_id), None)


def _relative_source(image_path: Path, input_dir: Path) -> str:
    try:
        return image_path.resolve().relative_to(input_dir.resolve()).as_posix()
    except ValueError:
        return image_path.name


def _preserved_groups(items: list[dict]) -> dict[tuple[str, int], list[dict]]:
    groups: dict[tuple[str, int], list[dict]] = {}
    for item in items or []:
        key = (item["sourcePath"], int(item["pieceIndex"]))
        groups.setdefault(key, []).append(dict(item))
    return groups


def _apply_preserved(sample: dict, preserved: dict | None, width: int, height: int) -> None:
    if not preserved:
        return
    sample["identity"] = preserved.get("identity") or ""
    if preserved.get("cropBoxEdited") and preserved.get("cropBox"):
        sample["cropBox"] = dataset.box_dict(preserved["cropBox"])
        sample["cropBoxEdited"] = True
        sample["padded"] = dataset.is_padded(sample["cropBox"], width, height)
        sample["reasons"] = dataset.set_reason(sample.get("reasons") or [], "padded", sample["padded"])
    if preserved.get("manual") and preserved.get("status") in {"ingested", "excluded", "skipped"}:
        sample["manual"] = True
        sample["status"] = preserved["status"]


def write_redraw(output_dir: Path, image, sample: dict, kind: str) -> None:
    edit_boxes = [sample["box"]] if kind == "remove" else []
    base, mask, padded = dataset.redraw_pair(image, sample["cropBox"], edit_boxes)
    sample["padded"] = bool(padded) or bool(sample.get("padded"))
    split = sample.get("split") or "train"
    extension = dataset.sample_extension(sample)
    folder = f"dataset/redraw/{kind}/{split}"
    base_rel = f"{folder}/{sample['id']}{extension}"
    mask_rel = f"{folder}/{sample['id']}-mask.png"
    base_path = output_dir / base_rel
    mask_path = output_dir / mask_rel
    base_path.parent.mkdir(parents=True, exist_ok=True)
    main.save_image(base, base_path)
    mask.save(mask_path)
    previous = sample.get("redraw") or {}
    sample["redraw"] = {
        "kind": kind,
        "basePath": base_rel,
        "maskPath": mask_rel,
        "resultPath": previous.get("resultPath") or "",
        "prompt": previous.get("prompt") or "",
        "saved": False,
    }
    sample["maskPath"] = mask_rel


def _place_output(output_dir: Path, image, sample: dict) -> None:
    redraw = sample.get("redraw") or {}
    if redraw.get("saved") and sample.get("status") == "ingested":
        return
    if sample.get("status") == "excluded":
        write_redraw(output_dir, image, sample, "remove")
        delete_generation(output_dir, sample)
        return
    if sample.get("padded"):
        write_redraw(output_dir, image, sample, "pad")
        delete_generation(output_dir, sample)
        if sample.get("status") == "ingested":
            sample["status"] = "review"
        return
    if sample.get("status") == "ingested":
        write_generation(output_dir, image, sample)
        return
    delete_generation(output_dir, sample)


def _commit_status(output_dir: Path, image, sample: dict) -> None:
    _place_output(output_dir, image, sample)


def process_image(
    image_path: Path,
    input_dir: Path,
    output_dir: Path,
    params: dict,
    model,
    runtime: dict,
    used_stems: dict[str, str],
    seen_hashes: list[str],
    preserved_items: list[dict],
    used_names: dict[str, str] | None = None,
) -> dict:
    if used_names is None:
        used_names = {}
    relative = _relative_source(image_path, input_dir)
    resolved = str(image_path.resolve())
    try:
        image = _load_image(image_path)
    except Exception as error:
        piece_id = dataset.claim_stem(dataset.safe_stem(relative), resolved, used_stems)
        return {
            "pieces": [
                {
                    "id": piece_id,
                    "sourcePath": resolved,
                    "relativeSource": relative,
                    "pieceIndex": 0,
                    "imagePath": resolved,
                    "imageStored": False,
                    "previewPath": "",
                    "width": 0,
                    "height": 0,
                    "sampleIds": [],
                    "status": "error",
                    "error": str(error),
                    "revision": 1,
                }
            ],
            "samples": [],
            "noFace": [],
            "errors": [{"path": relative, "error": str(error)}],
            "usedStems": used_stems,
            "usedNames": used_names,
        }

    if main.is_long_image(image, params["longRatio"]):
        boundaries = main.seam_boundaries(image, params["longRatio"], params["seamSensitivity"])
        piece_images = list(enumerate(main.split_image(image, boundaries), start=1))
    else:
        piece_images = [(0, image)]

    groups = _preserved_groups(preserved_items)
    pieces = []
    samples = []
    no_face = []
    stem_base = dataset.safe_stem(Path(relative).with_suffix("").as_posix())

    for piece_index, piece_image in piece_images:
        source_key = f"{resolved}#{piece_index}"
        stem = stem_base if piece_index == 0 else f"{stem_base}_p{piece_index}"
        piece_id = dataset.claim_stem(stem, source_key, used_stems)
        image_stored = piece_index != 0
        if image_stored:
            image_rel = f"pieces/{piece_id}.jpg"
            main.save_image(piece_image, output_dir / image_rel)
            image_field = image_rel
        else:
            image_field = resolved

        preview_rel = f"previews/{piece_id}.jpg"
        _save_preview(piece_image, output_dir / preview_rel)
        width, height = piece_image.size
        detections = _detect(model, piece_image, params["conf"], runtime)
        split = dataset.split_for_source(resolved, params["valRatio"])
        piece = {
            "id": piece_id,
            "sourcePath": resolved,
            "relativeSource": relative,
            "pieceIndex": piece_index,
            "imagePath": image_field,
            "imageStored": image_stored,
            "previewPath": preview_rel,
            "width": width,
            "height": height,
            "sampleIds": [],
            "status": "ready",
            "error": "",
            "revision": 1,
            "split": split,
        }

        if not detections:
            piece["status"] = "no_face"
            pieces.append(piece)
            no_face.append({"path": relative, "pieceIndex": piece_index})
            continue

        remaining = [dict(item) for item in groups.get((resolved, piece_index), [])]
        face_count = len(detections)
        for order, detection in enumerate(detections, start=1):
            blur = dataset.face_blur(piece_image, detection.box)
            face_image = main.face_preview(piece_image, detection.box, size=160)
            phash = dataset.average_hash(face_image)
            duplicate = dataset.is_duplicate(phash, seen_hashes, int(params["duplicateDistance"]))
            seen_hashes.append(phash)
            crop = dataset.crop_box_from_face(detection.box, params["faceRatio"])
            padded = dataset.is_padded(crop, width, height)
            short_side = dataset.face_short_side(detection.box)
            out_of_frame = dataset.is_out_of_frame(detection.box, width, height)
            reasons = dataset.quality_reasons(
                face_count=face_count,
                confidence=detection.confidence,
                out_of_frame=out_of_frame,
                short_side=short_side,
                min_face=params["minFace"],
                padded=padded,
                blur=blur,
                blur_threshold=params["blurThreshold"],
                duplicate=duplicate,
                auto_conf=params["autoConf"],
            )
            sample_key = f"{source_key}#f{order}"
            stem_path, extension = dataset.original_parts(relative)
            sample_id = dataset.claim_original_name(stem_path, sample_key, used_names.setdefault(split, {}))
            face_rel = f"faces/{sample_id}{extension}"
            main.save_image(face_image, output_dir / face_rel)
            sample = {
                "id": sample_id,
                "pieceId": piece_id,
                "sourcePath": resolved,
                "relativeSource": relative,
                "pieceIndex": piece_index,
                "faceIndex": detection.index,
                "order": order,
                "faceCount": face_count,
                "confidence": dataset.clean_float(detection.confidence),
                "box": dataset.box_dict(detection.box),
                "cropBox": dataset.box_dict(crop),
                "cropBoxEdited": False,
                "padded": padded,
                "resized": True,
                "blur": dataset.clean_float(blur),
                "faceShortSide": dataset.clean_float(short_side),
                "outOfFrame": out_of_frame,
                "phash": phash,
                "extension": extension,
                "reasons": reasons,
                "status": "review" if reasons else "ingested",
                "manual": False,
                "identity": "",
                "split": split,
                "cropPath": "",
                "sidecarPath": "",
                "facePreviewPath": face_rel,
                "revision": 1,
            }
            _apply_preserved(sample, dataset.take_iou_match(remaining, detection.box), width, height)
            if sample["status"] == "ingested" or (not sample["manual"] and not sample["reasons"]):
                sample["status"] = "ingested"
            elif sample["status"] not in {"excluded", "skipped"}:
                sample["status"] = "review"
            _commit_status(output_dir, piece_image, sample)
            samples.append(sample)
            piece["sampleIds"].append(sample_id)

        pieces.append(piece)

    return {
        "pieces": pieces,
        "samples": samples,
        "noFace": no_face,
        "errors": [],
        "usedStems": used_stems,
        "usedNames": used_names,
    }


def _clean_artifacts(output_dir: Path) -> None:
    for name in ("dataset", "previews", "faces", "pieces"):
        target = output_dir / name
        if target.exists():
            shutil.rmtree(target)


def _collect_preserved(state: dict) -> list[dict]:
    preserved = []
    for sample in state.get("samples") or []:
        if not (sample.get("manual") or sample.get("cropBoxEdited") or sample.get("identity")):
            continue
        preserved.append(
            {
                "sourcePath": sample["sourcePath"],
                "pieceIndex": sample["pieceIndex"],
                "box": sample["box"],
                "identity": sample.get("identity") or "",
                "cropBox": sample.get("cropBox"),
                "cropBoxEdited": bool(sample.get("cropBoxEdited")),
                "manual": bool(sample.get("manual")),
                "status": sample.get("status"),
            }
        )
    return preserved


def _blank_lists(state: dict) -> None:
    state["pieces"] = []
    state["samples"] = []
    state["errors"] = []
    state["noFace"] = []
    state["processedSources"] = []
    state["usedStems"] = {}
    state["usedNames"] = {}
    state["message"] = ""
    state["error"] = ""
    state["cancel"] = False
    state["lastExport"] = None


def ingest(state: dict, model) -> str:
    key = state["outputPath"]
    input_dir = Path(state["inputPath"])
    output_dir = Path(state["outputPath"])
    params = state["params"]
    images = list(main.iter_images(input_dir, output_dir if _is_relative_to(output_dir, input_dir) else None))
    done = set(state.get("processedSources") or [])
    with _lock:
        state["activity"] = "detect"
        state["status"] = "running"
        state["cancel"] = False
        state["progress"] = {"phase": "detect", "done": sum(1 for image in images if str(image.resolve()) in done), "total": len(images), "current": ""}
        state["runtime"] = {"device": _resolve_device(params.get("device") or "auto")}
        _save(state)

    if not images:
        with _lock:
            state["status"] = "done"
            state["activity"] = None
            state["message"] = "没有可处理的图片。"
            _save(state)
        return "done"

    runtime = dict(state["runtime"])
    for image_path in images:
        resolved = str(image_path.resolve())
        with _lock:
            if state.get("cancel"):
                state["status"] = "cancelled"
                state["activity"] = None
                state["runtime"] = runtime
                _save(state)
                return "cancelled"
            if resolved in set(state.get("processedSources") or []):
                continue
            state["progress"]["current"] = _relative_source(image_path, input_dir)
            _save(state)
            params = dict(state["params"])
            used = dict(state.get("usedStems") or {})
            raw_names = state.get("usedNames") or {}
            used_names = {
                split: dict(names)
                for split, names in raw_names.items()
                if isinstance(names, dict)
            }
            seen = [sample["phash"] for sample in state.get("samples") or [] if sample.get("phash")]
            preserved = list(state.get("preservedDecisions") or [])

        try:
            result = process_image(
                image_path,
                input_dir,
                output_dir,
                params,
                model,
                runtime,
                used,
                seen,
                preserved,
                used_names,
            )
        except Exception as error:
            result = {
                "pieces": [],
                "samples": [],
                "noFace": [],
                "errors": [{"path": _relative_source(image_path, input_dir), "error": str(error)}],
                "usedStems": used,
                "usedNames": used_names,
            }
            print(f"[job] failed {image_path}: {error}", file=sys.stderr)

        with _lock:
            if state.get("cancel"):
                state["status"] = "cancelled"
                state["activity"] = None
                state["runtime"] = runtime
                _save(state)
                return "cancelled"
            state["pieces"].extend(result["pieces"])
            state["samples"].extend(result["samples"])
            state["noFace"].extend(result["noFace"])
            state["errors"].extend(result["errors"])
            state["usedStems"] = result["usedStems"]
            state["usedNames"] = result.get("usedNames") or {}
            state["processedSources"].append(resolved)
            state["progress"]["done"] = sum(1 for image in images if str(image.resolve()) in set(state["processedSources"]))
            state["runtime"] = runtime
            _save(state)

    with _lock:
        state["runtime"] = runtime
        state["progress"]["current"] = ""
        _save(state)
    return "done"


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _rebalance_sample(output_dir: Path, sample: dict, piece: dict, ratio: float) -> None:
    if sample.get("status") in {"excluded", "skipped"} or (sample.get("redraw") or {}).get("saved"):
        return
    if not sample.get("cropBoxEdited") and not sample.get("manual"):
        crop = dataset.crop_box_from_face(sample["box"], ratio)
        sample["cropBox"] = dataset.box_dict(crop)
    padded = dataset.is_padded(sample["cropBox"], piece["width"], piece["height"])
    sample["padded"] = padded
    sample["reasons"] = dataset.set_reason(sample.get("reasons") or [], "padded", padded)
    if sample.get("cropBoxEdited"):
        if padded:
            image = load_piece_image(piece, output_dir)
            write_redraw(output_dir, image, sample, "pad")
            if sample.get("status") == "ingested":
                delete_generation(output_dir, sample)
                sample["status"] = "review"
        return
    if sample.get("manual"):
        if sample.get("status") == "ingested":
            image = load_piece_image(piece, output_dir)
            _place_output(output_dir, image, sample)
        return
    if sample["reasons"]:
        if padded:
            image = load_piece_image(piece, output_dir)
            write_redraw(output_dir, image, sample, "pad")
        if sample.get("status") == "ingested":
            delete_generation(output_dir, sample)
        sample["status"] = "review"
        return
    image = load_piece_image(piece, output_dir)
    sample["status"] = "ingested"
    _place_output(output_dir, image, sample)


def rebalance(state: dict) -> None:
    output_dir = Path(state["outputPath"])
    while True:
        with _lock:
            if state.get("cancel") and state.get("activity") == "rebalance":
                state["cancel"] = False
                state["activity"] = None
                state["needsRebalance"] = False
                _save(state)
                return
            if not state.get("needsRebalance"):
                if state.get("activity") == "rebalance":
                    state["activity"] = None
                _save(state)
                return
            state["needsRebalance"] = False
            ratio = state["params"]["faceRatio"]
            work = []
            for sample in state.get("samples") or []:
                if sample.get("cropBoxEdited") or sample.get("status") in {"excluded", "skipped"}:
                    continue
                piece = _piece_by_id(state, sample["pieceId"])
                if piece is None:
                    continue
                work.append(sample["id"])
            state["activity"] = "rebalance"
            state["progress"] = {"phase": "rebalance", "done": 0, "total": len(work), "current": "重算裁切"}
            _save(state)

        for index, sample_id in enumerate(work, start=1):
            with _lock:
                if state.get("cancel") and state.get("activity") == "rebalance":
                    state["cancel"] = False
                    state["activity"] = None
                    _save(state)
                    return
                sample = _sample_by_id(state, sample_id)
                piece = _piece_by_id(state, sample["pieceId"]) if sample else None
            if sample is None or piece is None:
                continue
            try:
                _rebalance_sample(output_dir, sample, piece, ratio)
            except Exception as error:
                sample["status"] = "review"
                state_error = {"path": sample.get("relativeSource") or sample_id, "error": str(error)}
                with _lock:
                    state["errors"].append(state_error)
            with _lock:
                _bump(state, sample)
                state["progress"]["done"] = index
                _save(state)


def _sync_generation(state: dict) -> int:
    output_dir = Path(state["outputPath"])
    ingested = [sample for sample in state.get("samples") or [] if sample.get("status") == "ingested"]
    expected = set()
    for sample in ingested:
        for key in ("cropPath", "sidecarPath", "maskPath"):
            if sample.get(key):
                expected.add(sample[key])
    for split in ("train", "val"):
        folder = output_dir / "dataset" / "generation" / split
        if not folder.exists():
            continue
        for child in folder.rglob("*"):
            if not child.is_file():
                continue
            relative = child.relative_to(output_dir).as_posix()
            if relative not in expected:
                child.unlink()
    written = 0
    for sample in ingested:
        piece = _piece_by_id(state, sample["pieceId"])
        crop = output_dir / sample["cropPath"] if sample.get("cropPath") else None
        if piece is None:
            continue
        if crop is None or not crop.is_file():
            image = load_piece_image(piece, output_dir)
            write_generation(output_dir, image, sample)
        written += 1
    return written


def _export_yolo(state: dict) -> dict:
    output_dir = Path(state["outputPath"])
    yolo_root = output_dir / "dataset" / "yolo"
    if yolo_root.exists():
        shutil.rmtree(yolo_root)
    written = 0
    pieces = {piece["id"]: piece for piece in state.get("pieces") or []}
    grouped: dict[str, list[dict]] = {}
    for sample in state.get("samples") or []:
        if sample.get("status") != "ingested":
            continue
        grouped.setdefault(sample["pieceId"], []).append(sample)
    used_by_split: dict[str, dict[str, str]] = {}
    for piece_id, samples in grouped.items():
        piece = pieces.get(piece_id)
        if piece is None or not piece.get("width") or not piece.get("height"):
            continue
        split = samples[0].get("split") or "train"
        source = load_piece_image(piece, output_dir)
        stem, extension = dataset.original_parts(piece.get("relativeSource") or piece_id)
        name = dataset.claim_original_name(
            stem,
            f"{piece.get('sourcePath')}#{piece.get('pieceIndex')}",
            used_by_split.setdefault(split, {}),
        )
        image_rel = yolo_root / "images" / split / f"{name}{extension}"
        label_rel = yolo_root / "labels" / split / f"{name}.txt"
        main.save_image(source, image_rel)
        lines = [dataset.yolo_line(sample["box"], piece["width"], piece["height"]) for sample in samples]
        label_rel.parent.mkdir(parents=True, exist_ok=True)
        label_rel.write_text("\n".join(lines) + "\n", encoding="utf-8")
        written += 1
    yaml_path = yolo_root / "data.yaml"
    yaml_path.parent.mkdir(parents=True, exist_ok=True)
    yaml_path.write_text(
        "\n".join(
            [
                f"path: {yolo_root.as_posix()}",
                "train: images/train",
                "val: images/val",
                "names:",
                "  0: face",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return {"format": "yolo", "written": written, "root": str(yolo_root)}


def _export_identity(state: dict) -> dict:
    output_dir = Path(state["outputPath"])
    root = output_dir / "dataset" / "identity"
    if root.exists():
        shutil.rmtree(root)
    written = 0
    used_by_folder: dict[str, dict[str, str]] = {}
    for sample in state.get("samples") or []:
        if sample.get("status") != "ingested":
            continue
        piece = _piece_by_id(state, sample["pieceId"])
        if piece is None:
            continue
        if not sample.get("cropPath") or not (output_dir / sample["cropPath"]).is_file():
            image = load_piece_image(piece, output_dir)
            write_generation(output_dir, image, sample)
        folder = dataset.identity_folder(sample.get("identity") or "")
        extension = dataset.sample_extension(sample)
        split_name = sample.get("split") or "train"
        leaf = dataset.claim_original_name(
            Path(sample["id"]).name,
            sample["id"],
            used_by_folder.setdefault(f"{folder}/{split_name}", {}),
        )
        target = root / folder / split_name / f"{leaf}{extension}"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(output_dir / sample["cropPath"], target)
        side = target.with_suffix(".json")
        side.write_text(json.dumps(dataset.sidecar(sample), ensure_ascii=False, indent=2), encoding="utf-8")
        written += 1
    return {"format": "identity", "written": written, "root": str(root)}


def _review_payload(state: dict, result: dict) -> dict:
    review = [sample for sample in state.get("samples") or [] if sample.get("status") == "review"]
    reasons = {reason: 0 for reason in dataset.REASON_ORDER}
    for sample in review:
        for reason in sample.get("reasons") or []:
            if reason in reasons:
                reasons[reason] += 1
    result["reviewRemaining"] = len(review)
    result["reviewReasons"] = reasons
    return result


def export_dataset(state: dict, kind: str) -> dict:
    if kind == "yolo":
        result = _export_yolo(state)
    elif kind == "identity":
        result = _export_identity(state)
    elif kind == "generation":
        written = _sync_generation(state)
        result = {
            "format": "generation",
            "written": written,
            "root": str(Path(state["outputPath"]) / "dataset" / "generation"),
        }
    else:
        raise ValueError("导出格式必须是 generation、yolo 或 identity。")
    return _review_payload(state, result)


def _new_state(input_path: Path, output_path: Path, params: dict) -> dict:
    return {
        "version": 1,
        "inputPath": str(input_path),
        "outputPath": str(output_path),
        "status": "idle",
        "activity": None,
        "params": normalize_params(params),
        "progress": {"phase": "idle", "done": 0, "total": 0, "current": ""},
        "pieces": [],
        "samples": [],
        "errors": [],
        "noFace": [],
        "processedSources": [],
        "usedStems": {},
        "usedNames": {},
        "preservedDecisions": [],
        "activePieceId": "",
        "activeSampleId": "",
        "cancel": False,
        "needsRebalance": False,
        "error": "",
        "message": "",
        "lastExport": None,
        "runtime": {"device": ""},
        "revision": 0,
    }


def _read_disk(output_path: Path) -> dict | None:
    job_path = output_path / "job.json"
    if not job_path.is_file():
        return None
    return json.loads(job_path.read_text(encoding="utf-8"))


def _ensure_loaded(output_path: Path) -> dict:
    key = _key(output_path)
    if key in _jobs:
        return _jobs[key]
    state = _read_disk(output_path)
    if state is None:
        raise FileNotFoundError(str(output_path))
    _jobs[key] = state
    return state


def _mark_interrupted(state: dict, key: str) -> None:
    if state.get("status") == "running" and not _worker_alive(key):
        state["status"] = "interrupted"
        state["activity"] = None
        _save(state)


def job_status(output_path: str) -> dict:
    output = Path(output_path).expanduser().resolve()
    key = _key(output)
    with _lock:
        if key not in _jobs and not (output / "job.json").is_file():
            return {"missing": True, "outputPath": key}
        state = _ensure_loaded(output)
        _mark_interrupted(state, key)
        return _snapshot(state)


def _run_detect(key: str) -> None:
    try:
        with _lock:
            state = _jobs[key]
            model = _model
        if model is None:
            raise RuntimeError("检测模型还没有加载。")
        outcome = ingest(state, model)
        if outcome != "cancelled":
            with _lock:
                needs = bool(state.get("needsRebalance"))
            if needs:
                rebalance(state)
            with _lock:
                if state.get("status") == "running":
                    state["status"] = "done"
                    state["activity"] = None
                    state["progress"]["phase"] = "idle"
                    _save(state)
    except Exception as error:
        with _lock:
            state = _jobs.get(key)
            if state is not None:
                state["status"] = "error"
                state["activity"] = None
                state["error"] = str(error)
                _save(state)
        print(f"[job] error: {error}", file=sys.stderr)
    finally:
        with _lock:
            _finish_worker(key)


def start_job(input_path: str, output_path: str, params: dict | None = None, rerun: bool = False) -> dict:
    if _model is None:
        return {"error": "检测模型还没有加载。"}
    source = Path(input_path).expanduser().resolve()
    output = Path(output_path).expanduser().resolve()
    if not source.is_dir():
        return {"error": f"输入文件夹不存在：{source}"}
    if source == output:
        return {"error": "输出路径不能和输入文件夹相同。"}
    output.mkdir(parents=True, exist_ok=True)
    key = _key(output)
    with _lock:
        if _worker_alive(key):
            return {"error": "任务正在运行。"}
        existing = _jobs.get(key) or _read_disk(output)
        if existing is None:
            state = _new_state(source, output, params or {})
        else:
            state = existing
            state["inputPath"] = str(source)
            state["outputPath"] = key
            if params:
                state["params"] = normalize_params({**state.get("params", {}), **params})
            _mark_interrupted(state, key)
        if rerun:
            state["preservedDecisions"] = _collect_preserved(state)
            _blank_lists(state)
            _clean_artifacts(output)
            state["status"] = "running"
        elif state.get("status") in {"idle", "interrupted", "cancelled", "error", "done"}:
            state["status"] = "running"
            state["cancel"] = False
            state["error"] = ""
            state["message"] = ""
        state["activity"] = "detect"
        _jobs[key] = state
        _save(state)
        _spawn(key, lambda: _run_detect(key))
        return _snapshot(state)


def cancel_job(output_path: str) -> dict:
    output = Path(output_path).expanduser().resolve()
    with _lock:
        try:
            state = _ensure_loaded(output)
        except FileNotFoundError:
            return {"error": "没有可取消的任务。"}
        state["cancel"] = True
        _save(state)
        return _snapshot(state)


def _relative_under(output_dir: Path, relative: str, parent: str) -> Path:
    target = (output_dir / relative).resolve()
    root = (output_dir / parent).resolve()
    if target != root and not str(target).startswith(str(root) + "/"):
        raise ValueError("文件不在指定目录里。")
    return target


def _save_redraw_result(output_dir: Path, sample: dict) -> None:
    redraw = sample.get("redraw") or {}
    if redraw.get("kind") not in {"pad", "remove"} or not redraw.get("resultPath") or not redraw.get("maskPath"):
        raise ValueError("先完成局部重绘，再保存到数据集。")
    result_path = _relative_under(output_dir, redraw["resultPath"], "dataset/redraw")
    mask_path = _relative_under(output_dir, redraw["maskPath"], "dataset/redraw")
    if not result_path.is_file() or not mask_path.is_file():
        raise ValueError("重绘结果或蒙版不在了。")
    from PIL import Image

    split = sample.get("split") or "train"
    extension = dataset.sample_extension(sample)
    crop_rel = f"dataset/generation/{split}/{sample['id']}{extension}"
    mask_rel = f"dataset/generation/{split}/{sample['id']}-mask.png"
    side_rel = f"dataset/generation/{split}/{sample['id']}.json"
    crop_path = output_dir / crop_rel
    crop_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(result_path) as opened:
        main.save_image(opened.convert("RGB"), crop_path)
    shutil.copy2(mask_path, output_dir / mask_rel)
    sample["cropPath"] = crop_rel
    sample["maskPath"] = mask_rel
    sample["sidecarPath"] = side_rel
    sample["status"] = "ingested"
    sample["manual"] = True
    sample["resized"] = True
    redraw["saved"] = True
    sample["redraw"] = redraw
    (output_dir / side_rel).write_text(json.dumps(dataset.sidecar(sample), ensure_ascii=False, indent=2), encoding="utf-8")


def _mutate_files(output_dir: Path, sample: dict, piece: dict, op: str, redraw: dict | None = None) -> None:
    if op == "accept":
        sample["manual"] = True
        sample["status"] = "ingested"
        image = load_piece_image(piece, output_dir)
        _place_output(output_dir, image, sample)
        return
    if op == "exclude":
        sample["manual"] = True
        sample["status"] = "excluded"
        image = load_piece_image(piece, output_dir)
        _place_output(output_dir, image, sample)
        return
    if op == "skip":
        sample["manual"] = True
        sample["status"] = "skipped"
        delete_generation(output_dir, sample)
        return
    if op == "redraw_prepare":
        kind = "remove" if sample.get("status") == "excluded" else "pad"
        if kind == "pad" and not sample.get("padded"):
            raise ValueError("这张脸没有需要重绘的区域。")
        image = load_piece_image(piece, output_dir)
        write_redraw(output_dir, image, sample, kind)
        return
    if op == "redraw_store":
        relative = str((redraw or {}).get("resultPath") or "")
        _relative_under(output_dir, relative, "dataset/redraw")
        if not (output_dir / relative).is_file():
            raise ValueError("重绘结果还没有写入。")
        current = sample.get("redraw") or {}
        if current.get("kind") not in {"pad", "remove"}:
            raise ValueError("还没有这张脸的蒙版。")
        current["resultPath"] = relative
        current["prompt"] = str((redraw or {}).get("prompt") or current.get("prompt") or "")
        current["saved"] = False
        sample["redraw"] = current
        return
    if op == "redraw_save":
        _save_redraw_result(output_dir, sample)
        return
    if op == "crop":
        sample["cropBoxEdited"] = True
        sample["padded"] = dataset.is_padded(sample["cropBox"], piece["width"], piece["height"])
        sample["reasons"] = dataset.set_reason(sample.get("reasons") or [], "padded", sample["padded"])
        if sample.get("status") == "ingested" or sample.get("padded"):
            image = load_piece_image(piece, output_dir)
            _place_output(output_dir, image, sample)
        return
    if op == "identity" and sample.get("status") == "ingested" and sample.get("sidecarPath"):
        side = output_dir / sample["sidecarPath"]
        side.parent.mkdir(parents=True, exist_ok=True)
        side.write_text(json.dumps(dataset.sidecar(sample), ensure_ascii=False, indent=2), encoding="utf-8")


def update_sample(output_path: str, sample_id: str, op: str, crop_box: dict | None = None, identity: str | None = None, redraw: dict | None = None) -> dict:
    output = Path(output_path).expanduser().resolve()
    with _lock:
        try:
            state = _ensure_loaded(output)
        except FileNotFoundError:
            return {"error": "任务不存在。"}
        sample = _sample_by_id(state, sample_id)
        piece = _piece_by_id(state, sample["pieceId"]) if sample else None
        if sample is None or piece is None:
            return {"error": "找不到这张脸。"}
        if crop_box and op in {"crop", "accept"}:
            sample["cropBox"] = dataset.box_dict(crop_box)
        if identity is not None and op in {"identity", "accept"}:
            sample["identity"] = str(identity)
        output_dir = Path(state["outputPath"])
        try:
            _mutate_files(output_dir, sample, piece, op, redraw)
        except Exception as error:
            state["error"] = str(error)
            _save(state)
            return {"error": str(error), **_snapshot(state)}
        state["error"] = ""
        _bump(state, sample)
        state["activeSampleId"] = sample_id
        state["activePieceId"] = sample["pieceId"]
        _save(state)
        return _snapshot(state)


def update_params(output_path: str, params: dict) -> dict:
    output = Path(output_path).expanduser().resolve()
    key = _key(output)
    with _lock:
        try:
            state = _ensure_loaded(output)
        except FileNotFoundError:
            return {"error": "任务不存在。"}
        previous = state["params"]["faceRatio"]
        state["params"] = normalize_params({**state["params"], **(params or {})})
        state["error"] = ""
        face_changed = abs(state["params"]["faceRatio"] - previous) > 1e-6
        if face_changed:
            state["needsRebalance"] = True
        _save(state)
        if face_changed and not _worker_alive(key):
            state["activity"] = "rebalance"
            _save(state)
            _spawn(key, lambda: _run_rebalance(key))
        return _snapshot(state)


def _run_rebalance(key: str) -> None:
    try:
        with _lock:
            state = _jobs[key]
        rebalance(state)
    except Exception as error:
        with _lock:
            state = _jobs.get(key)
            if state is not None:
                state["activity"] = None
                state["error"] = str(error)
                _save(state)
        print(f"[job] rebalance error: {error}", file=sys.stderr)
    finally:
        with _lock:
            _finish_worker(key)


def _run_export(key: str, kind: str) -> None:
    try:
        with _lock:
            state = _jobs[key]
            state["error"] = ""
            state["activity"] = "export"
            state["progress"] = {"phase": "export", "done": 0, "total": 1, "current": kind}
            _save(state)
        result = export_dataset(state, kind)
        with _lock:
            state["lastExport"] = result
            state["activity"] = None
            state["progress"] = {"phase": "idle", "done": 1, "total": 1, "current": ""}
            _save(state)
    except Exception as error:
        with _lock:
            state = _jobs.get(key)
            if state is not None:
                state["activity"] = None
                state["error"] = str(error)
                _save(state)
        print(f"[job] export error: {error}", file=sys.stderr)
    finally:
        with _lock:
            _finish_worker(key)


def export_job(output_path: str, kind: str) -> dict:
    output = Path(output_path).expanduser().resolve()
    key = _key(output)
    with _lock:
        try:
            state = _ensure_loaded(output)
        except FileNotFoundError:
            return {"error": "任务不存在。"}
        if _worker_alive(key):
            return {"error": "任务还在运行，完成后再导出。"}
        if kind not in {"generation", "yolo", "identity"}:
            return {"error": "导出格式必须是 generation、yolo 或 identity。"}
        _spawn(key, lambda: _run_export(key, kind))
        return _snapshot(state)


def set_cursor(output_path: str, piece_id: str, sample_id: str) -> dict:
    output = Path(output_path).expanduser().resolve()
    with _lock:
        try:
            state = _ensure_loaded(output)
        except FileNotFoundError:
            return {"missing": True, "outputPath": str(output)}
        state["activePieceId"] = piece_id or ""
        state["activeSampleId"] = sample_id or ""
        _save(state)
        return _snapshot(state)


def run_cli(args) -> int:
    from ultralytics import YOLO

    params = normalize_params(
        {
            "conf": args.conf,
            "autoConf": args.auto_conf,
            "minFace": args.min_face,
            "blurThreshold": args.blur_threshold,
            "faceRatio": args.face_ratio,
            "valRatio": args.val_ratio,
            "longRatio": args.ratio,
            "seamSensitivity": args.seam_sensitivity,
            "device": args.device,
        }
    )
    source = args.input.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not source.is_dir():
        raise SystemExit(f"[ERROR] input directory does not exist: {source}")
    if not args.model.is_file():
        raise SystemExit(f"[ERROR] model file does not exist: {args.model}")
    if source == output:
        raise SystemExit("[ERROR] output directory must be different from input")
    output.mkdir(parents=True, exist_ok=True)
    state = _new_state(source, output, params)
    key = _key(output)
    with _lock:
        _jobs[key] = state
        _save(state)
    bind_model(YOLO(str(args.model)))
    outcome = ingest(state, _model)
    if outcome != "cancelled" and state.get("needsRebalance"):
        rebalance(state)
    with _lock:
        if state.get("status") == "running":
            state["status"] = "done" if outcome != "cancelled" else "cancelled"
            state["activity"] = None
            _save(state)
        summary = summarize(state)
    print("\nSummary")
    print(f"  images done:      {state['progress']['done']}/{state['progress']['total']}")
    print(f"  faces:            {summary['total']}")
    print(f"  ingested:         {summary['ingested']}")
    print(f"  review:           {summary['review']}")
    for reason, count in summary["reasons"].items():
        if count:
            print(f"    {reason}: {count}")
    print(f"  train/val:        {summary['train']}/{summary['val']}")
    print(f"  no face:          {summary['noFace']}")
    print(f"  errors:           {summary['errors']}")
    for item in state.get("errors") or []:
        print(f"    {item['path']}: {item['error']}")
    print(f"  job:              {output / 'job.json'}")
    print(f"  dataset:          {output / 'dataset' / 'generation'}")
    return 0
