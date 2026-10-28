"use client";

import { useEffect, useRef, useState } from "react";

import { fitStageLayout } from "lib/stage-layout.mjs";
import {
  Ban,
  FolderOpen,
  ImagePlus,
  LoaderCircle,
  RotateCcw,
  Save,
  ScanFace,
  Settings,
  SkipForward,
  X
} from "lucide-react";

const STORAGE_KEY = "face-studio-output";
const REASON_ORDER = ["multi_face", "low_confidence", "out_of_frame", "small_face", "padded", "blur", "duplicate"];
const REASON_LABELS = {
  multi_face: "多张脸",
  low_confidence: "置信度不足",
  out_of_frame: "超出画面",
  small_face: "人脸过小",
  padded: "需要补边",
  blur: "画面模糊",
  duplicate: "重复样本"
};
const STATUS_LABELS = {
  ingested: "已入库",
  review: "待复核",
  excluded: "已排除",
  skipped: "已跳过"
};
const STATUS_TONE = {
  ingested: "success",
  review: "accent",
  excluded: "danger",
  skipped: "muted"
};
const DEFAULT_PARAMS = {
  conf: 0.25,
  autoConf: 0.6,
  minFace: 64,
  blurThreshold: 50,
  faceRatio: 0.45,
  valRatio: 0.1,
  longRatio: 16 / 9,
  seamSensitivity: 1.5,
  duplicateDistance: 8,
  device: "auto"
};
const EMPTY_REASONS = Object.fromEntries(REASON_ORDER.map((reason) => [reason, 0]));
const REDRAW_PROMPTS = {
  pad: "补全涂抹掉的画面边缘，延续原来的背景、光线和人物边缘，不要新增人脸。",
  remove: "去掉涂抹区域里的人脸，按周围背景自然补上，不要留下五官。"
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reasonLabel(reason) {
  return REASON_LABELS[reason] || reason;
}

function formatConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `${Math.round(number * 1000) / 10}%`;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "请求失败。");
  }
  return data;
}

function mediaUrl(root, file, revision) {
  if (!root || !file) return "";
  const params = new URLSearchParams({ root, file });
  if (revision) params.set("v", String(revision));
  return `/api/media?${params.toString()}`;
}

function preferredSample(samples, pieceId) {
  const faces = (samples || [])
    .filter((sample) => sample.pieceId === pieceId)
    .sort((left, right) => left.order - right.order);
  return faces.find((sample) => sample.status === "review") || faces[0] || null;
}

function pieceMatches(piece, samples, filter) {
  if (!filter) return true;
  const faces = (samples || []).filter((sample) => sample.pieceId === piece.id);
  if (filter === "no_face") return piece.status === "no_face" || faces.length === 0;
  if (filter === "error") return piece.status === "error";
  if (filter === "redraw") {
    return faces.some((sample) => sample.padded || sample.status === "excluded" || sample.redraw?.kind);
  }
  return faces.some((sample) => sample.status === "review" && (sample.reasons || []).includes(filter));
}

function visiblePieces(pieces, samples, filter) {
  return (pieces || []).filter((piece) => pieceMatches(piece, samples, filter));
}

function nextReview(samples, pieces, sampleId) {
  const ordered = [];
  for (const piece of pieces || []) {
    const faces = (samples || [])
      .filter((sample) => sample.pieceId === piece.id)
      .sort((left, right) => left.order - right.order);
    ordered.push(...faces);
  }
  const index = ordered.findIndex((sample) => sample.id === sampleId);
  return (
    ordered.slice(index + 1).find((sample) => sample.status === "review") ||
    ordered.slice(0, Math.max(index, 0)).find((sample) => sample.status === "review") ||
    null
  );
}

function blockReason(piece, samples) {
  if (!piece) return "还没有打开图片。选择输入目录后开始检测。";
  if (piece.status === "error") return `这张图片读取失败：${piece.error || "未知错误"}`;
  if (!samples.length) return "这张图没有检测到人脸，无法入库。";
  return "还没有选中人脸。按 1 到 9 选择后再按 S 入库。";
}

function normalizeCrop(cropBox, piece) {
  if (!cropBox || !piece?.width || !piece?.height) return cropBox;
  const side = Math.max(cropBox.x2 - cropBox.x1, cropBox.y2 - cropBox.y1);
  const maxSide = Math.max(piece.width, piece.height) * 1.8;
  const normalizedSide = Math.min(Math.max(side, 32), maxSide);
  const centerX = (cropBox.x1 + cropBox.x2) / 2;
  const centerY = (cropBox.y1 + cropBox.y2) / 2;
  return {
    x1: centerX - normalizedSide / 2,
    y1: centerY - normalizedSide / 2,
    x2: centerX + normalizedSide / 2,
    y2: centerY + normalizedSide / 2
  };
}

function sameCrop(left, right) {
  if (!left || !right) return false;
  return ["x1", "y1", "x2", "y2"].every((key) => Math.abs(left[key] - right[key]) < 0.05);
}

function scaleLayout(layout, zoom) {
  if (!layout) return null;
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (factor === 1) return layout;
  const next = { ...layout, scale: layout.scale * factor };
  for (const key of [
    "boardWidth",
    "boardHeight",
    "imageLeft",
    "imageTop",
    "imageWidth",
    "imageHeight",
    "cropLeft",
    "cropTop",
    "cropWidth",
    "cropHeight"
  ]) {
    next[key] = layout[key] * factor;
  }
  return next;
}

function percentBox(box, piece) {
  const width = piece.width || 1;
  const height = piece.height || 1;
  return {
    left: `${(box.x1 / width) * 100}%`,
    top: `${(box.y1 / height) * 100}%`,
    width: `${((box.x2 - box.x1) / width) * 100}%`,
    height: `${((box.y2 - box.y1) / height) * 100}%`
  };
}

function pieceTone(piece, samples) {
  if (piece.status === "error") return "danger";
  const faces = (samples || []).filter((sample) => sample.pieceId === piece.id);
  if (!faces.length || piece.status === "no_face") return "muted";
  if (faces.some((sample) => sample.status === "review")) return "accent";
  if (faces.every((sample) => sample.status === "ingested")) return "success";
  return "muted";
}

export default function FaceWorkbench() {
  const [outputPath, setOutputPath] = useState("");
  const [inputPath, setInputPath] = useState("");
  const [job, setJob] = useState(null);
  const [selection, setSelection] = useState({ pieceId: "", sampleId: "" });
  const [notice, setNotice] = useState(null);
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [browser, setBrowser] = useState(null);
  const [browserPath, setBrowserPath] = useState("");
  const [exportKind, setExportKind] = useState("generation");
  const [exporting, setExporting] = useState(false);
  const [filter, setFilter] = useState("");
  const [zoom, setZoom] = useState(1);
  const [scrubTip, setScrubTip] = useState(null);
  const [wanx, setWanx] = useState({ saved: false, keyHint: "", workspaceId: "" });
  const [wanxKey, setWanxKey] = useState("");
  const [wanxWorkspace, setWanxWorkspace] = useState("");
  const [redrawPrompt, setRedrawPrompt] = useState(REDRAW_PROMPTS.pad);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [cropDraft, setCropDraft] = useState(null);
  const [identity, setIdentity] = useState("");
  const [busy, setBusy] = useState("");

  const outputRef = useRef("");
  const jobRef = useRef(null);
  const selectionRef = useRef(selection);
  const filterRef = useRef(filter);
  const paramsLock = useRef(false);
  const stageCanvasRef = useRef(null);
  const imageRef = useRef(null);
  const dragStateRef = useRef(null);
  const cropTimer = useRef(0);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const wheelRef = useRef({});
  const commitRef = useRef(() => {});
  const actionRef = useRef({});
  const outputBound = useRef("");
  const filmRef = useRef(null);
  const scrubRef = useRef(null);
  const shownRef = useRef([]);
  const fromScrollRef = useRef(false);
  const centeringRef = useRef(false);
  const scrubbingRef = useRef(false);
  const cursorTimer = useRef(0);

  outputRef.current = outputPath;
  jobRef.current = job;
  selectionRef.current = selection;
  filterRef.current = filter;

  function applyJob(next) {
    if (!next || next.missing) {
      if (next?.missing) {
        jobRef.current = null;
        setJob(null);
      }
      return;
    }
    const current = jobRef.current;
    if (current && current.outputPath === next.outputPath && (current.revision || 0) > (next.revision || 0)) {
      return;
    }
    jobRef.current = next;
    setJob(next);
  }

  async function refresh(output = outputRef.current) {
    if (!output) return null;
    try {
      const data = await postJson("/api/job", { action: "status", outputPath: output });
      if (data.missing) {
        applyJob({ missing: true });
        return data;
      }
      applyJob(data);
      return data;
    } catch (error) {
      setNotice({ tone: "", text: error.message });
      return null;
    }
  }

  function rememberCursor(pieceId, sampleId) {
    window.clearTimeout(cursorTimer.current);
    setSelection({ pieceId, sampleId: sampleId || "" });
    const output = outputRef.current;
    if (!output) return;
    postJson("/api/job", {
      action: "cursor",
      outputPath: output,
      pieceId,
      sampleId: sampleId || ""
    })
      .then((data) => applyJob(data))
      .catch(() => {});
  }

  async function commitCrop(sampleId, cropBox) {
    const output = outputRef.current;
    if (!output || !sampleId || !cropBox) return;
    try {
      const data = await postJson("/api/job", {
        action: "sample",
        outputPath: output,
        sampleId,
        op: "crop",
        cropBox
      });
      applyJob(data);
      setCropDraft((current) => (current && current.sampleId === sampleId && sameCrop(current.cropBox, cropBox) ? null : current));
      if (data.error) setNotice({ tone: "", text: data.error });
    } catch (error) {
      setNotice({ tone: "", text: error.message });
    }
  }

  commitRef.current = commitCrop;

  useEffect(() => {
    void fetch("/api/redraw")
      .then((response) => response.json())
      .then((data) => {
        setWanx(data);
        setWanxWorkspace(data.workspaceId || "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY) || "";
    if (!saved) return;
    setOutputPath(saved);
    void refresh(saved);
  }, []);

  useEffect(() => {
    if (!outputPath) return undefined;
    const active = job?.status === "running" || Boolean(job?.activity);
    if (!active) return undefined;
    const timer = setInterval(() => {
      void refresh(outputPath);
    }, 800);
    return () => clearInterval(timer);
  }, [outputPath, job?.status, job?.activity]);

  useEffect(() => {
    if (!job?.pieces?.length) return;
    setSelection((current) => {
      const pieceOk = job.pieces.some((piece) => piece.id === current.pieceId);
      const sampleOk =
        !current.sampleId ||
        job.samples.some((sample) => sample.id === current.sampleId && sample.pieceId === current.pieceId);
      if (pieceOk && sampleOk) return current;
      const piece = job.pieces.find((item) => item.id === (pieceOk ? current.pieceId : job.activePieceId)) || job.pieces[0];
      const sample =
        job.samples.find((item) => item.id === job.activeSampleId && item.pieceId === piece.id) ||
        preferredSample(job.samples, piece.id);
      return { pieceId: piece.id, sampleId: sample?.id || "" };
    });
  }, [job]);

  useEffect(() => {
    if (!job?.inputPath || outputBound.current === job.outputPath) return;
    outputBound.current = job.outputPath;
    setInputPath(job.inputPath);
  }, [job]);

  useEffect(() => {
    if (!job?.params || paramsLock.current) return;
    setParams({ ...DEFAULT_PARAMS, ...job.params });
  }, [job]);

  useEffect(() => {
    setCropDraft(null);
    dragStateRef.current = null;
  }, [selection.pieceId, selection.sampleId]);

  useEffect(() => {
    if (!selection.pieceId) return undefined;
    if (fromScrollRef.current) {
      fromScrollRef.current = false;
      return undefined;
    }
    const node = filmRef.current?.querySelector(`[data-piece="${CSS.escape(selection.pieceId)}"]`);
    if (!node) return undefined;
    centeringRef.current = true;
    node.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: scrubbingRef.current ? "auto" : "smooth"
    });
    const timer = window.setTimeout(() => {
      centeringRef.current = false;
    }, 420);
    return () => window.clearTimeout(timer);
  }, [selection.pieceId]);

  const summary = job?.summary || {
    total: 0,
    ingested: 0,
    review: 0,
    excluded: 0,
    skipped: 0,
    noFace: 0,
    errors: 0,
    reasons: EMPTY_REASONS,
    train: 0,
    val: 0,
    completion: 0
  };
  const pieces = job?.pieces || [];
  const samples = job?.samples || [];
  const shownPieces = visiblePieces(pieces, samples, filter);
  shownRef.current = shownPieces;
  const activeIndex = shownPieces.findIndex((piece) => piece.id === selection.pieceId);
  const activePiece = pieces.find((piece) => piece.id === selection.pieceId) || null;
  const pieceSamples = samples
    .filter((sample) => sample.pieceId === activePiece?.id)
    .sort((left, right) => left.order - right.order);
  const activeSample = pieceSamples.find((sample) => sample.id === selection.sampleId) || null;
  const shownCrop =
    cropDraft && cropDraft.sampleId === activeSample?.id ? cropDraft.cropBox : activeSample?.cropBox || null;
  const fitted = fitStageLayout({
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    imageWidth: activePiece?.width || 0,
    imageHeight: activePiece?.height || 0,
    cropBox: shownCrop
  });
  const stageLayout = scaleLayout(fitted, zoom);
  const running = job?.status === "running" || Boolean(job?.activity);
  const progress = job?.progress || { done: 0, total: 0, phase: "idle", current: "" };
  const progressPct = progress.total ? Math.min(100, Math.round((100 * progress.done) / progress.total)) : 0;

  useEffect(() => {
    setIdentity(activeSample?.identity || "");
  }, [activeSample?.id, activeSample?.identity]);

  const redrawKind = activeSample?.redraw?.kind || (activeSample?.status === "excluded" ? "remove" : activeSample?.padded ? "pad" : "");

  useEffect(() => {
    setRedrawPrompt(redrawKind === "remove" ? REDRAW_PROMPTS.remove : REDRAW_PROMPTS.pad);
  }, [activeSample?.id, redrawKind]);

  wheelRef.current = { piece: activePiece, sample: activeSample, crop: shownCrop };

  useEffect(() => {
    const node = stageCanvasRef.current;
    if (!node) return undefined;
    const measure = () => {
      const next = { width: node.clientWidth, height: node.clientHeight };
      setViewport((current) => (current.width === next.width && current.height === next.height ? current : next));
    };
    const onWheel = (event) => {
      event.preventDefault();
      const view = wheelRef.current;
      if (event.altKey && view.sample && view.crop && view.piece) {
        const rect = imageRef.current?.getBoundingClientRect();
        if (!rect?.width || !rect?.height) return;
        const scaleX = view.piece.width / rect.width;
        const scaleY = view.piece.height / rect.height;
        const anchorX = (event.clientX - rect.left) * scaleX;
        const anchorY = (event.clientY - rect.top) * scaleY;
        const factor = event.deltaY < 0 ? 0.92 : 1.08;
        const next = normalizeCrop(
          {
            x1: anchorX + (view.crop.x1 - anchorX) * factor,
            y1: anchorY + (view.crop.y1 - anchorY) * factor,
            x2: anchorX + (view.crop.x2 - anchorX) * factor,
            y2: anchorY + (view.crop.y2 - anchorY) * factor
          },
          view.piece
        );
        setCropDraft({ sampleId: view.sample.id, cropBox: next });
        window.clearTimeout(cropTimer.current);
        cropTimer.current = window.setTimeout(() => commitRef.current(view.sample.id, next), 180);
        return;
      }
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom((current) => Math.min(6, Math.max(0.4, current * factor)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      node.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    function onMove(event) {
      const drag = dragStateRef.current;
      if (!drag) return;
      const scaleX = drag.piece.width / drag.rect.width;
      const scaleY = drag.piece.height / drag.rect.height;
      const deltaX = (event.clientX - drag.startClientX) * scaleX;
      const deltaY = (event.clientY - drag.startClientY) * scaleY;
      let next;
      if (drag.mode === "move") {
        next = {
          x1: drag.startCrop.x1 + deltaX,
          y1: drag.startCrop.y1 + deltaY,
          x2: drag.startCrop.x2 + deltaX,
          y2: drag.startCrop.y2 + deltaY
        };
      } else {
        const startSide = drag.startCrop.x2 - drag.startCrop.x1;
        const centerX = (drag.startCrop.x1 + drag.startCrop.x2) / 2;
        const centerY = (drag.startCrop.y1 + drag.startCrop.y2) / 2;
        let side = startSide;
        if (drag.mode === "resize-east") side = startSide + deltaX * 2;
        else if (drag.mode === "resize-west") side = startSide - deltaX * 2;
        else if (drag.mode === "resize-south") side = startSide + deltaY * 2;
        else if (drag.mode === "resize-north") side = startSide - deltaY * 2;
        next = {
          x1: centerX - side / 2,
          y1: centerY - side / 2,
          x2: centerX + side / 2,
          y2: centerY + side / 2
        };
      }
      next = normalizeCrop(next, drag.piece);
      drag.latestCrop = next;
      setCropDraft({ sampleId: drag.sampleId, cropBox: next });
    }
    function onUp() {
      const drag = dragStateRef.current;
      dragStateRef.current = null;
      if (!drag?.latestCrop) return;
      window.clearTimeout(cropTimer.current);
      commitRef.current(drag.sampleId, drag.latestCrop);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  useEffect(() => {
    function onKey(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = event.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target?.isContentEditable) return;
      const currentJob = jobRef.current;
      if (!currentJob) return;
      const current = selectionRef.current;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        const list = visiblePieces(currentJob.pieces || [], currentJob.samples || [], filterRef.current);
        if (!list.length) return;
        event.preventDefault();
        const index = Math.max(0, list.findIndex((piece) => piece.id === current.pieceId));
        const next = list[index + (event.key === "ArrowRight" ? 1 : -1)];
        if (!next) return;
        const sample = preferredSample(currentJob.samples, next.id);
        actionRef.current.remember(next.id, sample?.id || "");
        return;
      }
      if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        actionRef.current.accept();
        return;
      }
      if (event.key === "x" || event.key === "X") {
        event.preventDefault();
        actionRef.current.skip();
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const faces = (currentJob.samples || [])
          .filter((sample) => sample.pieceId === current.pieceId)
          .sort((left, right) => left.order - right.order);
        const sample = faces[Number(event.key) - 1];
        if (!sample) return;
        event.preventDefault();
        actionRef.current.remember(current.pieceId, sample.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function startJob(input, output, rerun) {
    if (!input || !output) {
      setNotice({ tone: "", text: "输入目录和输出目录都要填写。" });
      return;
    }
    setBusy(rerun ? "rerun" : "start");
    try {
      const data = await postJson("/api/job", {
        action: "start",
        inputPath: input,
        outputPath: output,
        params,
        rerun
      });
      window.localStorage.setItem(STORAGE_KEY, output);
      applyJob(data);
      if (data.message) setNotice({ tone: "", text: data.message });
    } catch (error) {
      setNotice({ tone: "", text: error.message });
    } finally {
      setBusy("");
    }
  }

  async function uploadFiles(fileList) {
    if (!outputPath) {
      setNotice({ tone: "", text: "先填写输出目录。上传的图片会放进该目录下的 incoming。" });
      return;
    }
    const form = new FormData();
    form.append("outputPath", outputPath);
    for (const file of fileList) {
      form.append("files", file, file.webkitRelativePath || file.name);
    }
    setBusy("upload");
    try {
      const response = await fetch("/api/job/upload", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "上传失败。");
      setInputPath(data.inputPath);
      const skipped = (data.skipped || [])
        .slice(0, 5)
        .map((item) => `${item.name}（${item.reason}）`)
        .join("、");
      setNotice({
        tone: data.skipped?.length ? "warn" : "success",
        text: `已放入 ${data.saved.length} 张。${skipped ? `跳过 ${data.skipped.length} 个：${skipped}` : ""}`
      });
      await startJob(data.inputPath, outputPath, false);
    } catch (error) {
      setNotice({ tone: "", text: error.message });
    } finally {
      setBusy("");
    }
  }

  async function sendSample(op, extra) {
    if (!activeSample || !outputPath) {
      setNotice({ tone: "", text: blockReason(activePiece, pieceSamples) });
      return null;
    }
    setBusy(op);
    try {
      const data = await postJson("/api/job", {
        action: "sample",
        outputPath,
        sampleId: activeSample.id,
        op,
        ...extra
      });
      applyJob(data);
      setCropDraft(null);
      if (data.error) {
        setNotice({ tone: "", text: data.error });
        return null;
      }
      return data;
    } catch (error) {
      setNotice({ tone: "", text: error.message });
      return null;
    } finally {
      setBusy("");
    }
  }

  async function acceptCurrent() {
    const sample = activeSample;
    if (!sample) {
      setNotice({ tone: "", text: blockReason(activePiece, pieceSamples) });
      return;
    }
    const labels = (sample.reasons || []).map(reasonLabel).filter(Boolean);
    const data = await sendSample("accept", { cropBox: shownCrop, identity });
    if (!data) return;
    const rest = (data.samples || []).filter(
      (item) => item.pieceId === sample.pieceId && item.id !== sample.id && item.status === "review"
    ).length;
    const updated = (data.samples || []).find((item) => item.id === sample.id);
    if (updated?.redraw?.kind === "pad" && updated.status !== "ingested") {
      setNotice({ tone: "success", text: "底图和蒙版已放到 dataset/redraw/pad。重绘结果点保存后才会进入数据集。" });
      return;
    }
    const parts = ["已写入生成集。"];
    if (labels.length) parts.push(`复核原因：${labels.join("、")}。`);
    if (rest) parts.push(`这张图还有 ${rest} 张脸待复核。`);
    setNotice({ tone: "success", text: parts.join("") });
    const next = nextReview(data.samples || [], data.pieces || [], sample.id);
    if (next) rememberCursor(next.pieceId, next.id);
  }

  async function skipCurrent() {
    const sample = activeSample;
    const data = await sendSample("skip");
    if (!data || !sample) return;
    setNotice({ tone: "success", text: "已跳过。这张脸不进入训练集。" });
    const next = nextReview(data.samples || [], data.pieces || [], sample.id);
    if (next) rememberCursor(next.pieceId, next.id);
  }

  async function excludeCurrent() {
    const sample = activeSample;
    const data = await sendSample("exclude");
    if (!data || !sample) return;
    setNotice({ tone: "success", text: "已排除。底图和蒙版在 dataset/redraw/remove，训练图里还没有这张脸。" });
    const next = nextReview(data.samples || [], data.pieces || [], sample.id);
    if (next) rememberCursor(next.pieceId, next.id);
  }

  async function saveWanx() {
    setBusy("wanx");
    try {
      const data = await postJson("/api/redraw", {
        action: "config",
        apiKey: wanxKey,
        workspaceId: wanxWorkspace
      });
      setWanx(data);
      setWanxKey("");
      setWanxWorkspace(data.workspaceId || "");
      setNotice({ tone: "success", text: "万相密钥已记在本机，不会写进数据集。" });
    } catch (error) {
      setNotice({ tone: "", text: error.message });
    } finally {
      setBusy("");
    }
  }

  async function runRedraw() {
    if (!activeSample) return;
    setBusy("redraw");
    try {
      const data = await postJson("/api/redraw", {
        action: "run",
        outputPath,
        sampleId: activeSample.id,
        prompt: redrawPrompt
      });
      applyJob(data);
      setNotice({ tone: "success", text: "重绘结果已返回。确认画面后点保存，才会写入数据集。" });
    } catch (error) {
      setNotice({ tone: "", text: error.message });
    } finally {
      setBusy("");
    }
  }

  async function saveRedraw() {
    if (!activeSample) return;
    setBusy("redraw-save");
    try {
      const data = await postJson("/api/redraw", {
        action: "save",
        outputPath,
        sampleId: activeSample.id
      });
      applyJob(data);
      setNotice({ tone: "success", text: "已保存到数据集，蒙版放在同一张图旁边。" });
    } catch (error) {
      setNotice({ tone: "", text: error.message });
    } finally {
      setBusy("");
    }
  }

  async function saveIdentity() {
    const data = await sendSample("identity", { identity });
    if (!data) return;
    setNotice({ tone: "success", text: "身份已记下。空名字在按人导出时归入 unknown。" });
  }

  actionRef.current = {
    accept: () => void acceptCurrent(),
    skip: () => void skipCurrent(),
    remember: rememberCursor
  };

  async function commitParams(next) {
    paramsLock.current = true;
    setParams(next);
    if (!outputRef.current || !jobRef.current) {
      paramsLock.current = false;
      return;
    }
    try {
      const data = await postJson("/api/job", {
        action: "params",
        outputPath: outputRef.current,
        params: next
      });
      applyJob(data);
      if (data.params) setParams({ ...DEFAULT_PARAMS, ...data.params });
      if (data.error) setNotice({ tone: "", text: data.error });
    } catch (error) {
      setNotice({ tone: "", text: error.message });
    } finally {
      paramsLock.current = false;
    }
  }

  async function loadBrowser(path) {
    const response = await fetch(`/api/browse?path=${encodeURIComponent(path || "")}`);
    const data = await response.json();
    if (!response.ok) {
      setBrowser((current) => ({ ...(current || { target: "input" }), error: data.error || "无法打开目录。", directories: [] }));
      return;
    }
    setBrowser((current) => ({ ...(current || { target: "input" }), ...data, error: "" }));
    setBrowserPath(data.path || "");
  }

  async function exportNow() {
    if (!outputPath || !job) {
      setNotice({ tone: "", text: "还没有任务可以导出。" });
      return;
    }
    setExporting(true);
    const before = JSON.stringify(job.lastExport || null);
    const beforeError = job.error || "";
    try {
      await postJson("/api/job", { action: "export", outputPath, kind: exportKind });
      const deadline = Date.now() + 120000;
      let latest = null;
      while (Date.now() < deadline) {
        await wait(700);
        latest = await postJson("/api/job", { action: "status", outputPath });
        if (latest.missing) break;
        applyJob(latest);
        const stamp = JSON.stringify(latest.lastExport || null);
        if (latest.activity !== "export" && (stamp !== before || (latest.error || "") !== beforeError)) break;
      }
      if (latest?.lastExport && JSON.stringify(latest.lastExport) !== before) {
        setNotice({
          tone: "success",
          text: `导出完成，写入 ${latest.lastExport.written ?? 0} 个。目录：${latest.lastExport.root || ""}`
        });
      } else if (latest?.error) {
        setNotice({ tone: "", text: latest.error });
      } else {
        setNotice({ tone: "", text: "导出没有完成。" });
      }
    } catch (error) {
      setNotice({ tone: "", text: error.message });
    } finally {
      setExporting(false);
    }
  }

  function scrubIndex(event) {
    const node = scrubRef.current;
    const list = shownRef.current;
    if (!node || !list.length) return -1;
    const rect = node.getBoundingClientRect();
    const ratio = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    const clamped = Math.min(1, Math.max(0, ratio));
    return Math.min(list.length - 1, Math.max(0, Math.round(clamped * (list.length - 1))));
  }

  function moveToScrub(event, persist) {
    const index = scrubIndex(event);
    const piece = shownRef.current[index];
    const node = scrubRef.current;
    if (!piece || !node || index < 0) return;
    const rect = node.getBoundingClientRect();
    setScrubTip({
      left: Math.min(rect.width - 8, Math.max(8, event.clientX - rect.left)),
      text: `${index + 1} / ${shownRef.current.length}  ${piece.relativeSource || piece.id}`
    });
    const sample = preferredSample(jobRef.current?.samples || [], piece.id);
    const sampleId = sample?.id || "";
    setSelection((current) => (current.pieceId === piece.id && current.sampleId === sampleId ? current : { pieceId: piece.id, sampleId }));
    if (persist) rememberCursor(piece.id, sampleId);
  }

  function onScrubDown(event) {
    scrubbingRef.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events cannot capture the pointer.
    }
    moveToScrub(event, false);
  }

  function onScrubMove(event) {
    if (!scrubbingRef.current) return;
    moveToScrub(event, false);
  }

  function onScrubUp(event) {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    moveToScrub(event, true);
    setScrubTip(null);
  }

  function onFilmScroll() {
    if (centeringRef.current || scrubbingRef.current) return;
    const rail = filmRef.current;
    if (!rail) return;
    const mid = rail.scrollLeft + rail.clientWidth / 2;
    let best = null;
    let bestDistance = Infinity;
    rail.querySelectorAll("[data-piece]").forEach((card) => {
      const center = card.offsetLeft + card.offsetWidth / 2;
      const distance = Math.abs(center - mid);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = card;
      }
    });
    if (!best) return;
    const piece = shownRef.current.find((item) => item.id === best.dataset.piece);
    if (!piece || piece.id === selectionRef.current.pieceId) return;
    fromScrollRef.current = true;
    const sample = preferredSample(jobRef.current?.samples || [], piece.id);
    const sampleId = sample?.id || "";
    setSelection({ pieceId: piece.id, sampleId });
    window.clearTimeout(cursorTimer.current);
    cursorTimer.current = window.setTimeout(() => rememberCursor(piece.id, sampleId), 280);
  }

  function beginCropInteraction(modeName, event) {
    if (!activeSample || !shownCrop || !activePiece) return;
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) return;
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      mode: modeName,
      sampleId: activeSample.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCrop: shownCrop,
      latestCrop: shownCrop,
      rect,
      piece: { width: activePiece.width, height: activePiece.height }
    };
  }

  function useOutput(next) {
    setOutputPath(next);
    if (!next) return;
    window.localStorage.setItem(STORAGE_KEY, next);
    outputBound.current = "";
    void refresh(next);
  }

  const previewUrl = mediaUrl(job?.outputPath, activePiece?.previewPath, activePiece?.revision);
  const activityLabel = job?.cancel && running
    ? "正在取消"
    : job?.activity === "detect"
      ? "检测中"
      : job?.activity === "rebalance"
        ? "重算裁剪"
        : job?.activity === "export" || exporting
          ? "导出中"
          : job?.status === "interrupted"
            ? "已中断"
            : job?.status === "error"
              ? "出错"
              : "";

  return (
    <main className="mailApp">
      <header className="topbar datasetTopbar">
        <div className="brandBlock">
          <div className="brandGlyph" aria-hidden="true">
            <ScanFace size={21} strokeWidth={2.25} />
          </div>
          <div>
            <h1>Face Studio</h1>
            <p className="brandEyebrow">数据集产线</p>
          </div>
        </div>
        <div className="summaryStrip" aria-label="任务概览">
          <div className="summaryItem">
            <strong>{summary.ingested}</strong>
            <span>已入库</span>
          </div>
          <div className="summaryDivider" />
          <div className="summaryItem">
            <strong>{summary.review}</strong>
            <span>待复核</span>
          </div>
          <div className="summaryDivider" />
          <div className="summaryItem">
            <strong>{summary.train}/{summary.val}</strong>
            <span>训练/验证</span>
          </div>
          <div className="completionRing" aria-label={`完成度 ${summary.completion}%`} style={{ "--completion": `${summary.completion}%` }}>
            <span>{summary.completion}</span>
          </div>
        </div>
        <div className="headerTools">
          <select aria-label="导出格式" className="textInput exportSelect" value={exportKind} onChange={(event) => setExportKind(event.target.value)}>
            <option value="generation">生成集</option>
            <option value="yolo">YOLO</option>
            <option value="identity">按人分夹</option>
          </select>
          <button className="actionButton" disabled={exporting || running} onClick={() => void exportNow()} type="button">
            {exporting ? <LoaderCircle className="spin" size={16} /> : null}
            导出
          </button>
          <button
            className="actionButton subtle"
            onClick={() => {
              paramsLock.current = true;
              setSettingsOpen(true);
            }}
            type="button"
          >
            <Settings size={16} />
            参数
          </button>
          {running ? (
            <button
              className="actionButton subtle"
              onClick={() => void postJson("/api/job", { action: "cancel", outputPath }).then(applyJob).catch((error) => setNotice({ tone: "", text: error.message }))}
              type="button"
            >
              取消
            </button>
          ) : null}
          <div className={activityLabel ? "headerActivity active" : "headerActivity"}>
            {running ? <LoaderCircle className="spin" size={16} /> : null}
            <span>{activityLabel}</span>
          </div>
        </div>
      </header>

      <div className="reasonRow" aria-label="复核原因">
        {REASON_ORDER.map((reason) => {
          const count = summary.reasons?.[reason] || 0;
          return (
            <button
              className={`reasonChip${count ? "" : " dim"}${filter === reason ? " selected" : ""}`}
              key={reason}
              onClick={() => setFilter((current) => (current === reason ? "" : reason))}
              type="button"
            >
              {REASON_LABELS[reason]} <b>{count}</b>
            </button>
          );
        })}
        <button className={`reasonChip${summary.noFace ? "" : " dim"}${filter === "no_face" ? " selected" : ""}`} onClick={() => setFilter((current) => (current === "no_face" ? "" : "no_face"))} type="button">
          无人脸 <b>{summary.noFace || 0}</b>
        </button>
        <button className={`reasonChip${summary.errors ? "" : " dim"}${filter === "error" ? " selected" : ""}`} onClick={() => setFilter((current) => (current === "error" ? "" : "error"))} type="button">
          失败 <b>{summary.errors || 0}</b>
        </button>
        <button className={`reasonChip${filter === "redraw" ? " selected" : ""}`} onClick={() => setFilter((current) => (current === "redraw" ? "" : "redraw"))} type="button">
          待重绘 <b>{samples.filter((sample) => sample.padded || sample.status === "excluded" || sample.redraw?.kind).length}</b>
        </button>
      </div>

      {notice ? (
        <div className={`globalNotice ${notice.tone || ""}`}>
          <span>{notice.text}</span>
          <button aria-label="关闭" onClick={() => setNotice(null)} type="button">
            <X size={16} />
          </button>
        </div>
      ) : null}

      <section className="workbenchShell datasetShell">
        <section className="canvasPane">
          <div className="pathBar">
            <label className="pathField">
              <span className="pathPrefix">输入</span>
              <input className="textInput" onChange={(event) => setInputPath(event.target.value)} value={inputPath} />
              <button aria-label="浏览输入目录" className="actionButton subtle" onClick={() => { setBrowser({ target: "input", directories: [], imageCount: 0, error: "" }); void loadBrowser(inputPath); }} type="button">
                <FolderOpen size={16} />
              </button>
            </label>
            <label className="pathField">
              <span className="pathPrefix">输出</span>
              <input
                className="textInput"
                onBlur={() => useOutput(outputPath)}
                onChange={(event) => setOutputPath(event.target.value)}
                value={outputPath}
              />
              <button aria-label="浏览输出目录" className="actionButton subtle" onClick={() => { setBrowser({ target: "output", directories: [], imageCount: 0, error: "" }); void loadBrowser(outputPath); }} type="button">
                <FolderOpen size={16} />
              </button>
            </label>
            <div className="pathActions">
              <button className="actionButton primary" disabled={Boolean(busy) || running} onClick={() => void startJob(inputPath, outputPath, false)} type="button">
                {busy === "start" || (running && job?.activity === "detect") ? <LoaderCircle className="spin" size={16} /> : <ScanFace size={16} />}
                {job && ["interrupted", "cancelled", "error"].includes(job.status) ? "继续检测" : job?.status === "done" ? "检查新图片" : "开始检测"}
              </button>
              <button className="actionButton" disabled={Boolean(busy)} onClick={() => fileInputRef.current?.click()} type="button">
                <ImagePlus size={16} />
                上传图片
              </button>
              <button className="actionButton" disabled={Boolean(busy)} onClick={() => folderInputRef.current?.click()} type="button">
                上传文件夹
              </button>
              <button
                className="actionButton subtle"
                disabled={!job || Boolean(busy) || running}
                onClick={() => {
                  if (!window.confirm("重新检测会清掉已生成的样本文件，并保留手动确认、排除和改过的裁剪。")) return;
                  void startJob(inputPath, outputPath, true);
                }}
                type="button"
              >
                <RotateCcw size={16} />
                重新检测
              </button>
            </div>
            <input
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              hidden
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = "";
                if (files.length) void uploadFiles(files);
              }}
              ref={fileInputRef}
              type="file"
            />
            <input
              hidden
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = "";
                if (files.length) void uploadFiles(files);
              }}
              ref={folderInputRef}
              type="file"
              webkitdirectory=""
            />
          </div>

          {running ? (
            <div className="jobProgress" role="status">
              <div className="jobTrack">
                <span style={{ width: `${progressPct}%` }} />
              </div>
              <p>
                {progress.phase === "rebalance" ? "重算裁剪" : progress.phase === "export" ? "导出" : "检测"} {progress.done}/{progress.total} {progress.current}
              </p>
            </div>
          ) : null}
          {job?.message ? <p className="jobMessage">{job.message}</p> : null}

          <div className="stagePanel">
            <div className="stageCanvas" ref={stageCanvasRef}>
              {stageLayout && activePiece ? (
                <div className="stageBoard" style={{ width: stageLayout.boardWidth, height: stageLayout.boardHeight }}>
                  {previewUrl ? (
                    <img
                      alt={activePiece.relativeSource || activePiece.id}
                      className="stageImage"
                      draggable={false}
                      key={activePiece.id}
                      ref={imageRef}
                      src={previewUrl}
                      style={{
                        left: stageLayout.imageLeft,
                        top: stageLayout.imageTop,
                        width: stageLayout.imageWidth,
                        height: stageLayout.imageHeight
                      }}
                    />
                  ) : null}
                  {shownCrop ? (
                    <div
                      className="cropBox"
                      onPointerDown={(event) => beginCropInteraction("move", event)}
                      style={{
                        left: stageLayout.cropLeft,
                        top: stageLayout.cropTop,
                        width: stageLayout.cropWidth,
                        height: stageLayout.cropHeight
                      }}
                    >
                      <div className="cropBoxBadge">{stageLayout.overflows ? "超出画面" : "裁剪范围"}</div>
                      <div className="cropResizeHandle east" onPointerDown={(event) => beginCropInteraction("resize-east", event)} />
                      <div className="cropResizeHandle west" onPointerDown={(event) => beginCropInteraction("resize-west", event)} />
                      <div className="cropResizeHandle north" onPointerDown={(event) => beginCropInteraction("resize-north", event)} />
                      <div className="cropResizeHandle south" onPointerDown={(event) => beginCropInteraction("resize-south", event)} />
                    </div>
                  ) : null}
                  {pieceSamples.map((sample) => (
                    <button
                      className={
                        sample.id === activeSample?.id
                          ? "faceBox keepSelected"
                          : sample.status === "excluded"
                            ? "faceBox excluded"
                            : "faceBox"
                      }
                      key={sample.id}
                      onClick={() => rememberCursor(activePiece.id, sample.id)}
                      style={{
                        left: stageLayout.imageLeft + (sample.box.x1 / activePiece.width) * stageLayout.imageWidth,
                        top: stageLayout.imageTop + (sample.box.y1 / activePiece.height) * stageLayout.imageHeight,
                        width: ((sample.box.x2 - sample.box.x1) / activePiece.width) * stageLayout.imageWidth,
                        height: ((sample.box.y2 - sample.box.y1) / activePiece.height) * stageLayout.imageHeight
                      }}
                      type="button"
                    >
                      <span>
                        {sample.order} {formatConfidence(sample.confidence)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="stageEmpty">
                  <ScanFace size={28} />
                  <p>{activePiece?.status === "error" ? activePiece.error || "这张图片读取失败。" : "格子画布已就绪。填写输入和输出目录后开始检测。"}</p>
                </div>
              )}
            </div>
            <div className="stageToolbar" title="滚轮缩放，Alt+滚轮改裁剪。方向键换图，1-9 选脸，S 入库，X 跳过。">
              <button className="actionButton subtle" onClick={() => setZoom(1)} type="button">
                适配 {Math.round(zoom * 100)}%
              </button>
              <label className="ratioControl">
                人脸比例
                <input
                  max="0.85"
                  min="0.15"
                  onChange={(event) => {
                    paramsLock.current = true;
                    setParams((current) => ({ ...current, faceRatio: Number(event.target.value) }));
                  }}
                  onPointerUp={(event) => void commitParams({ ...params, faceRatio: Number(event.currentTarget.value) })}
                  onKeyUp={(event) => void commitParams({ ...params, faceRatio: Number(event.currentTarget.value) })}
                  step="0.01"
                  type="range"
                  value={params.faceRatio}
                />
                <span>{Number(params.faceRatio).toFixed(2)}</span>
              </label>
              <button className="actionButton primary" disabled={Boolean(busy)} onClick={() => void acceptCurrent()} type="button">
                {busy === "accept" ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
                入库
              </button>
              <button className="actionButton" disabled={Boolean(busy)} onClick={() => void skipCurrent()} type="button">
                <SkipForward size={16} />
                跳过
              </button>
              <button className="actionButton" disabled={Boolean(busy)} onClick={() => void excludeCurrent()} type="button">
                <Ban size={16} />
                排除这张脸
              </button>
            </div>
          </div>

          <div className="scrubDock">
            <div className="scrubHead">
              <span>{shownPieces.length ? `${Math.max(activeIndex, 0) + 1} / ${shownPieces.length}` : "0 / 0"}</span>
              <strong>{activePiece?.relativeSource || (filter ? "这个筛选下没有图片" : "还没有图片")}</strong>
              <span>{summary.ingested}/{summary.total || 0} 已入库</span>
            </div>
            {shownPieces.length ? (
              <div
                aria-label="整体进度"
                aria-valuemax={shownPieces.length}
                aria-valuemin={1}
                aria-valuenow={Math.max(activeIndex, 0) + 1}
                className="scrubTrack"
                onPointerDown={onScrubDown}
                onPointerMove={onScrubMove}
                onPointerUp={onScrubUp}
                ref={scrubRef}
                role="slider"
              >
                {shownPieces.map((piece) => (
                  <span className={`scrubSeg ${pieceTone(piece, samples)} ${piece.id === activePiece?.id ? "active" : ""}`} key={piece.id} />
                ))}
                {activeIndex >= 0 ? (
                  <span className="scrubKnob" style={{ left: `${((activeIndex + 0.5) / shownPieces.length) * 100}%` }} />
                ) : null}
                {scrubTip ? <span className="scrubBubble" style={{ left: scrubTip.left }}>{scrubTip.text}</span> : null}
              </div>
            ) : null}
            <div aria-label="缩略图" className="filmstrip" onScroll={onFilmScroll} ref={filmRef}>
              {shownPieces.length ? (
                shownPieces.map((piece) => {
                  const faces = samples.filter((sample) => sample.pieceId === piece.id);
                  const crop = piece.id === activePiece?.id ? shownCrop : faces[0]?.cropBox;
                  return (
                    <button
                      className={piece.id === activePiece?.id ? "filmCard active" : "filmCard"}
                      data-piece={piece.id}
                      key={piece.id}
                      onClick={() => {
                        const sample = preferredSample(samples, piece.id);
                        rememberCursor(piece.id, sample?.id || "");
                      }}
                      type="button"
                    >
                      <div className="filmFrame">
                        {piece.previewPath ? <img alt="" src={mediaUrl(job.outputPath, piece.previewPath, piece.revision)} /> : <span className="filmMissing">无预览</span>}
                        {crop && piece.width ? <span className="filmCrop" style={percentBox(crop, piece)} /> : null}
                        {faces.map((sample) => (
                          <span className={sample.id === activeSample?.id ? "filmFace selected" : "filmFace"} key={sample.id} style={percentBox(sample.box, piece)} />
                        ))}
                        <span className={`filmPip ${pieceTone(piece, samples)}`} />
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="filmEmpty">{filter ? "当前筛选下没有图片。" : "检测完成后，缩略图会出现在这里。"}</div>
              )}
            </div>
          </div>
        </section>

        <aside className="inspectorPane">
          <div className="railPanel">
            <div className="listPanelHeader">
              <div>
                <p className="sectionEyebrow">当前</p>
                <h2>{activePiece?.relativeSource || "未选择"}</h2>
              </div>
              {activeSample ? <span className={`statusBadge ${STATUS_TONE[activeSample.status] || "muted"}`}>{STATUS_LABELS[activeSample.status] || activeSample.status}</span> : null}
            </div>
            {activeSample ? (
              <div className="sampleFacts">
                <div className="metricGrid">
                  <div><span>置信度</span><strong>{formatConfidence(activeSample.confidence)}</strong></div>
                  <div><span>短边</span><strong>{Math.round(activeSample.faceShortSide || 0)}</strong></div>
                  <div><span>模糊</span><strong>{Math.round(activeSample.blur || 0)}</strong></div>
                  <div><span>划分</span><strong>{activeSample.split === "val" ? "验证" : "训练"}</strong></div>
                  <div><span>补边</span><strong>{activeSample.padded ? "是" : "否"}</strong></div>
                  <div><span>手调</span><strong>{activeSample.cropBoxEdited ? "是" : "否"}</strong></div>
                </div>
                <div className="reasonRow compact">
                  {(activeSample.reasons || []).length
                    ? activeSample.reasons.map((reason) => (
                        <span className="reasonChip static" key={reason}>{reasonLabel(reason)}</span>
                      ))
                    : <span className="reasonChip static">没有复核原因</span>}
                </div>
                <label className="fieldLabel" htmlFor="identity-name">身份</label>
                <div className="identityRow">
                  <input
                    className="textInput"
                    id="identity-name"
                    onChange={(event) => setIdentity(event.target.value)}
                    placeholder="空则归入 unknown"
                    value={identity}
                  />
                  <button className="actionButton subtle" onClick={() => void saveIdentity()} type="button">记下</button>
                </div>
              </div>
            ) : (
              <p className="miniEmpty">{blockReason(activePiece, pieceSamples)}</p>
            )}
            {redrawKind ? (
              <div className="redrawBox">
                <div className="listPanelHeader">
                  <div>
                    <p className="sectionEyebrow">局部重绘</p>
                    <h2>{redrawKind === "remove" ? "去掉这张脸" : "补画面边缘"}</h2>
                  </div>
                </div>
                <p className="modalNote">白色区域会重绘，黑色区域保留。</p>
                <div className="redrawPair">
                  <figure>
                    {activeSample?.redraw?.basePath ? <img alt="底图" src={mediaUrl(job.outputPath, activeSample.redraw.basePath, activeSample.revision)} /> : <span>待生成</span>}
                    <figcaption>底图</figcaption>
                  </figure>
                  <figure>
                    {activeSample?.redraw?.maskPath ? <img alt="蒙版" src={mediaUrl(job.outputPath, activeSample.redraw.maskPath, activeSample.revision)} /> : <span>待生成</span>}
                    <figcaption>蒙版</figcaption>
                  </figure>
                </div>
                {activeSample?.redraw?.resultPath ? (
                  <img alt="重绘结果" className="redrawResult" src={mediaUrl(job.outputPath, activeSample.redraw.resultPath, activeSample.revision)} />
                ) : null}
                <label className="fieldLabel" htmlFor="redraw-prompt">提示词</label>
                <textarea className="textInput redrawPrompt" id="redraw-prompt" onChange={(event) => setRedrawPrompt(event.target.value)} value={redrawPrompt} />
                <div className="identityRow">
                  <button className="actionButton primary" disabled={Boolean(busy) || !wanx.saved} onClick={() => void runRedraw()} type="button">
                    {busy === "redraw" ? <LoaderCircle className="spin" size={16} /> : null}
                    重绘这张
                  </button>
                  <button className="actionButton" disabled={Boolean(busy) || !activeSample?.redraw?.resultPath} onClick={() => void saveRedraw()} type="button">
                    保存到数据集
                  </button>
                </div>
                {wanx.saved ? null : <p className="modalNote">先在参数里保存万相 API Key。</p>}
              </div>
            ) : null}
            <div className="faceList">
              {pieceSamples.map((sample) => (
                <button
                  className={sample.id === activeSample?.id ? "faceListCard keepSelected" : sample.status === "excluded" ? "faceListCard excluded" : "faceListCard"}
                  key={sample.id}
                  onClick={() => rememberCursor(activePiece.id, sample.id)}
                  type="button"
                >
                  {sample.facePreviewPath ? <img alt="" src={mediaUrl(job.outputPath, sample.facePreviewPath, sample.revision)} /> : <span />}
                  <span>
                    <strong>{sample.order}. {STATUS_LABELS[sample.status] || sample.status}</strong>
                    <span>{formatConfidence(sample.confidence)} {(sample.reasons || []).map(reasonLabel).join("、")}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="railPanel">
            <div className="listPanelHeader">
              <div>
                <p className="sectionEyebrow">失败</p>
                <h2>{summary.errors || 0} 条</h2>
              </div>
            </div>
            {(job?.errors || []).length ? (
              <ul className="detailList">
                {job.errors.map((item, index) => (
                  <li key={`${item.path}-${index}`}><strong>{item.path}</strong>{item.error}</li>
                ))}
              </ul>
            ) : (
              <p className="miniEmpty">没有失败记录。</p>
            )}
            <div className="listPanelHeader">
              <div>
                <p className="sectionEyebrow">无人脸</p>
                <h2>{summary.noFace || 0} 张</h2>
              </div>
            </div>
            {(job?.noFace || []).length ? (
              <ul className="detailList">
                {job.noFace.map((item, index) => (
                  <li key={`${item.path}-${item.pieceIndex}-${index}`}>{item.path}{item.pieceIndex ? ` #${item.pieceIndex}` : ""}</li>
                ))}
              </ul>
            ) : (
              <p className="miniEmpty">没有无人脸的图片。</p>
            )}
            {job?.error ? <p className="inlineError">{job.error}</p> : null}
          </div>
        </aside>
      </section>

      {settingsOpen ? (
        <div className="modalBackdrop" onClick={() => { paramsLock.current = false; setSettingsOpen(false); }}>
          <div className="modalCard" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="检测参数">
            <div className="listPanelHeader">
              <div>
                <p className="sectionEyebrow">参数</p>
                <h2>入库条件</h2>
              </div>
              <button aria-label="关闭" className="tileIconButton" onClick={() => { paramsLock.current = false; setSettingsOpen(false); }} type="button"><X size={16} /></button>
            </div>
            <p className="modalNote">万相密钥只留在这台机器的 .wanx.json。业务空间 ID 用于华北2北京地域；留空则走通用 DashScope 地址。</p>
            <div className="settingsGrid">
              <label>API Key<input className="textInput" autoComplete="off" onChange={(event) => setWanxKey(event.target.value)} placeholder={wanx.keyHint || "sk-"} type="password" value={wanxKey} /></label>
              <label>业务空间 ID<input className="textInput" onChange={(event) => setWanxWorkspace(event.target.value)} placeholder="WorkspaceId" value={wanxWorkspace} /></label>
            </div>
            <div className="modalActions">
              <button className="actionButton" disabled={Boolean(busy)} onClick={() => void saveWanx()} type="button">{wanx.saved ? `更新密钥（${wanx.keyHint}）` : "记住密钥"}</button>
            </div>
            <p className="modalNote">人脸比例会立刻重算还没手调过的裁剪。其余参数在继续检测或重新检测时生效。</p>
            <div className="settingsGrid">
              <label>检测阈值<input className="textInput" max="1" min="0" onChange={(event) => setParams((current) => ({ ...current, conf: Number(event.target.value) }))} step="0.01" type="number" value={params.conf} /></label>
              <label>自动入库阈值<input className="textInput" max="1" min="0" onChange={(event) => setParams((current) => ({ ...current, autoConf: Number(event.target.value) }))} step="0.01" type="number" value={params.autoConf} /></label>
              <label>最小短边<input className="textInput" min="1" onChange={(event) => setParams((current) => ({ ...current, minFace: Number(event.target.value) }))} step="1" type="number" value={params.minFace} /></label>
              <label>模糊阈值<input className="textInput" min="0" onChange={(event) => setParams((current) => ({ ...current, blurThreshold: Number(event.target.value) }))} step="1" type="number" value={params.blurThreshold} /></label>
              <label>重复距离<input className="textInput" min="0" onChange={(event) => setParams((current) => ({ ...current, duplicateDistance: Number(event.target.value) }))} step="1" type="number" value={params.duplicateDistance} /></label>
              <label>验证比例<input className="textInput" max="1" min="0" onChange={(event) => setParams((current) => ({ ...current, valRatio: Number(event.target.value) }))} step="0.01" type="number" value={params.valRatio} /></label>
              <label>长图高宽比<input className="textInput" min="0.1" onChange={(event) => setParams((current) => ({ ...current, longRatio: Number(event.target.value) }))} step="0.1" type="number" value={params.longRatio} /></label>
              <label>缝隙灵敏度<input className="textInput" min="0.1" onChange={(event) => setParams((current) => ({ ...current, seamSensitivity: Number(event.target.value) }))} step="0.1" type="number" value={params.seamSensitivity} /></label>
            </div>
            <div className="modalActions">
              <button className="actionButton primary" onClick={() => { void commitParams(params).finally(() => setSettingsOpen(false)); }} type="button">应用</button>
            </div>
          </div>
        </div>
      ) : null}

      {browser ? (
        <div className="modalBackdrop" onClick={() => setBrowser(null)}>
          <div className="modalCard" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="选择目录">
            <div className="listPanelHeader">
              <div>
                <p className="sectionEyebrow">{browser.target === "output" ? "输出目录" : "输入目录"}</p>
                <h2>选择文件夹</h2>
              </div>
              <button aria-label="关闭" className="tileIconButton" onClick={() => setBrowser(null)} type="button"><X size={16} /></button>
            </div>
            <div className="browserJump">
              <input className="textInput" onChange={(event) => setBrowserPath(event.target.value)} value={browserPath} />
              <button className="actionButton subtle" onClick={() => void loadBrowser(browserPath)} type="button">打开</button>
              <button className="actionButton subtle" disabled={!browser.parent} onClick={() => void loadBrowser(browser.parent)} type="button">上一级</button>
            </div>
            {browser.error ? <p className="inlineError">{browser.error}</p> : null}
            <p className="modalNote">这个文件夹里有 {browser.imageCount || 0} 张图片。</p>
            <div className="browserList">
              {(browser.directories || []).map((entry) => (
                <button key={entry.path} onClick={() => void loadBrowser(entry.path)} type="button">{entry.name}</button>
              ))}
            </div>
            <div className="modalActions">
              <button
                className="actionButton primary"
                onClick={() => {
                  if (browser.target === "output") useOutput(browser.path);
                  else setInputPath(browser.path);
                  setBrowser(null);
                }}
                type="button"
              >
                使用此目录
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
