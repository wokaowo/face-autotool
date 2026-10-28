import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import dataset
import pipeline


class DatasetTests(unittest.TestCase):
    def test_redraw_mask_marks_padding_and_face(self):
        image = Image.new("RGB", (40, 30), (20, 40, 60))
        base, mask, padded = dataset.redraw_pair(image, (-10, -8, 50, 42), [(8, 6, 18, 20)])
        self.assertTrue(padded)
        self.assertEqual(base.size, (1024, 1024))
        self.assertEqual(mask.size, (1024, 1024))
        self.assertEqual(mask.getpixel((0, 0)), 255)
        self.assertEqual(mask.getpixel((512, 512)), 0)
        _, pad_only, _ = dataset.redraw_pair(image, (-10, -8, 50, 42))
        self.assertGreater(mask.histogram()[255], pad_only.histogram()[255])
        plain, plain_mask, plain_padded = dataset.redraw_pair(image, (2, 2, 28, 28))
        self.assertFalse(plain_padded)
        self.assertEqual(plain_mask.getpixel((10, 10)), 0)

    def test_original_filename(self):
        stem, ext = dataset.original_parts("相册/张三.JPG")
        self.assertEqual(stem, "相册/张三")
        self.assertEqual(ext, ".JPG")
        spaced, png = dataset.original_parts("my photo.png")
        self.assertEqual(spaced, "my photo")
        self.assertEqual(png, ".png")
        used = {"train": {}}
        first = dataset.claim_original_name(stem, "face-a", used["train"])
        second = dataset.claim_original_name(stem, "face-b", used["train"])
        self.assertEqual(first, "相册/张三")
        self.assertEqual(second, "相册/张三_2")
        self.assertEqual(dataset.sample_extension({"extension": ".JPG"}), ".JPG")

    def test_safe_stem_keeps_chinese(self):
        self.assertEqual(dataset.safe_stem("相册/照片 01"), "相册_照片_01")
        self.assertEqual(dataset.identity_folder(""), "unknown")
        self.assertEqual(dataset.identity_folder("张三"), "张三")
        self.assertEqual(dataset.identity_folder("a/b"), "a_b")
        self.assertEqual(dataset.identity_folder("image"), "image")
        self.assertEqual(dataset.identity_folder("///"), "unknown")

    def test_claim_stem_adds_hash_on_collision(self):
        used = {}
        first = dataset.claim_stem("张三", "source-a", used)
        second = dataset.claim_stem("张三", "source-b", used)
        self.assertEqual(first, "张三")
        self.assertNotEqual(first, second)
        self.assertTrue(second.startswith("张三_"))

    def test_quality_gates_and_order(self):
        clear = dataset.quality_reasons(
            face_count=1,
            confidence=0.91,
            out_of_frame=False,
            short_side=120,
            min_face=64,
            padded=False,
            blur=80,
            blur_threshold=50,
            duplicate=False,
            auto_conf=0.6,
        )
        self.assertEqual(clear, [])
        flagged = dataset.quality_reasons(
            face_count=2,
            confidence=0.2,
            out_of_frame=True,
            short_side=20,
            min_face=64,
            padded=True,
            blur=10,
            blur_threshold=50,
            duplicate=True,
            auto_conf=0.6,
        )
        self.assertEqual(list(flagged), list(dataset.REASON_ORDER))

    def test_split_is_stable_for_one_source(self):
        self.assertEqual(dataset.split_for_source("相册/a.jpg", 0.1), dataset.split_for_source("相册/a.jpg", 0.1))
        self.assertEqual(dataset.split_for_source("相册/a.jpg", 0), "train")
        self.assertEqual(dataset.split_for_source("相册/a.jpg", 1), "val")

    def test_crop_padding_and_blur(self):
        crop = dataset.crop_box_from_face((0, 0, 20, 20), 0.45)
        self.assertTrue(dataset.is_padded(crop, 40, 40))
        self.assertTrue(dataset.is_out_of_frame((-2, 1, 10, 10), 40, 40))
        self.assertFalse(dataset.is_out_of_frame((1, 1, 10, 10), 40, 40))
        flat = Image.new("RGB", (32, 32), (120, 120, 120))
        self.assertLess(dataset.laplacian_variance(flat), 1)
        noisy = Image.fromarray(np.random.default_rng(0).integers(0, 255, (48, 48), dtype=np.uint8), mode="L")
        self.assertGreater(dataset.laplacian_variance(noisy), 50)

    def test_duplicate_distance(self):
        image = Image.new("L", (64, 64), 0)
        pixels = image.load()
        for y in range(8, 40):
            for x in range(8, 28):
                pixels[x, y] = 255
        digest = dataset.average_hash(image)
        self.assertTrue(dataset.is_duplicate(digest, [digest], 8))
        flipped = "".join("0" if bit == "1" else "1" for bit in digest)
        self.assertFalse(dataset.is_duplicate(flipped, [digest], 8))

    def test_sidecar_and_yolo_line(self):
        sample = {
            "id": "张三-f1",
            "relativeSource": "相册/张三.jpg",
            "pieceIndex": 0,
            "confidence": 0.9,
            "box": {"x1": 10, "y1": 20, "x2": 30, "y2": 50},
            "cropBox": {"x1": 0, "y1": 0, "x2": 40, "y2": 40},
            "padded": False,
            "resized": True,
            "blur": 80,
            "faceShortSide": 20,
            "outOfFrame": False,
            "reasons": [],
            "identity": "",
            "split": "train",
            "phash": "0" * 64,
            "manual": False,
        }
        side = dataset.sidecar(sample)
        self.assertEqual(side["source"], "相册/张三.jpg")
        self.assertEqual(side["identity"], "")
        line = dataset.yolo_line(sample["box"], 100, 100)
        self.assertTrue(line.startswith("0 "))
        numbers = [float(part) for part in line.split()[1:]]
        self.assertTrue(all(0 <= number <= 1 for number in numbers))


class PipelineStateTests(unittest.TestCase):
    def test_normalize_and_summary(self):
        params = pipeline.normalize_params({"conf": 2, "faceRatio": 0.01, "valRatio": 1, "autoConf": 0.6})
        self.assertEqual(params["conf"], 1)
        self.assertEqual(params["faceRatio"], 0.05)
        self.assertEqual(params["valRatio"], 1)
        summary = pipeline.summarize(
            {
                "samples": [
                    {"status": "ingested", "split": "train", "reasons": []},
                    {"status": "review", "split": "val", "reasons": ["blur", "padded"]},
                ],
                "noFace": [{}],
                "errors": [{}],
            }
        )
        self.assertEqual(summary["ingested"], 1)
        self.assertEqual(summary["review"], 1)
        self.assertEqual(summary["reasons"]["blur"], 1)
        self.assertEqual(summary["completion"], 50)
        self.assertEqual(summary["noFace"], 1)

    def test_missing_job_and_model_guard(self):
        missing = pipeline.job_status(tempfile.mkdtemp())
        self.assertTrue(missing["missing"])
        blocked = pipeline.start_job("/tmp", "/tmp/auto-job-should-not-run")
        self.assertIn("模型", blocked["error"])

    def test_status_reads_job_file(self):
        output = Path(tempfile.mkdtemp())
        state = {
            "outputPath": str(output.resolve()),
            "status": "done",
            "samples": [],
            "pieces": [],
            "noFace": [],
            "errors": [],
            "revision": 2,
        }
        (output / "job.json").write_text(json.dumps(state), encoding="utf-8")
        loaded = pipeline.job_status(str(output))
        self.assertEqual(loaded["status"], "done")
        self.assertEqual(loaded["summary"]["total"], 0)
        self.assertFalse(loaded.get("missing"))

    def test_start_rejects_missing_input_after_model_bind(self):
        pipeline.bind_model(object())
        try:
            result = pipeline.start_job("/no/such/auto-input", tempfile.mkdtemp())
            self.assertIn("不存在", result["error"])
        finally:
            pipeline.bind_model(None)

    def test_cli_help_lists_dataset_flags(self):
        completed = subprocess.run(
            [sys.executable, "main.py", "--help"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("--auto-conf", completed.stdout)
        self.assertIn("--min-face", completed.stdout)
        self.assertIn("--blur-threshold", completed.stdout)
        self.assertIn("--val-ratio", completed.stdout)


if __name__ == "__main__":
    unittest.main()
