"use client";

import { useEffect, useRef, useState } from "react";

const IMAGE_FILE_PATTERN = /\.(jpg|jpeg|png|webp)$/i;
const PAGE_SIZE = 40;

const STATUS_META = {
  queued: { label: "待检测", tone: "neutral" },
  detecting: { label: "检测中", tone: "info" },
  ready: { label: "待确认", tone: "accent" },
  processing: { label: "处理中", tone: "info" },
  processed: { label: "已完成", tone: "success" },
  no_face: { label: "无人脸", tone: "muted" },
  skipped: { label: "已跳过", tone: "muted" },
  error: { label: "出错", tone: "danger" }
};

const TOOL_META = {
  keep: {
    label: "保留工具",
    hint: "点选要保留的人脸"
  },
  erase: {
    label: "涂抹工具",
    hint: "点选要抹掉的人脸，可多选"
  }
};

function isImageFile(file) {
  return file.type.startsWith("image/") || IMAGE_FILE_PATTERN.test(file.name);
}

function sortFiles(files) {
  return [...files].sort((left, right) => {
    const leftLabel = left.webkitRelativePath || left.name;
    const rightLabel = right.webkitRelativePath || right.name;
    return leftLabel.localeCompare(rightLabel, "zh-CN");
  });
}

function createQueueItems(files) {
  const timestamp = Date.now();
  return sortFiles(files)
    .filter(isImageFile)
    .map((file, index) => ({
      localId: `${timestamp}-${index}-${file.name}`,
      sourceType: "upload",
      file,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
      pathLabel: file.webkitRelativePath || file.name,
      status: "queued",
      detection: null,
      keepFaceId: null,
      cropBox: null,
      cropBoxEdited: false,
      eraseFaceIds: [],
      result: null,
      error: ""
    }));
}

function revokeQueueUrls(queue) {
  for (const item of queue) {
    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
}

function formatConfidence(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function basename(filename) {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

function isSelectionMissing(item, tool) {
  if (!item?.detection?.faces?.length) {
    return false;
  }
  if (tool === "keep") {
    return item.detection.faces.length > 1 && item.keepFaceId == null;
  }
  return item.eraseFaceIds.length === 0;
}

function queueSummary(queue, tool) {
  const total = queue.length;
  const processed = queue.filter((item) => item.status === "processed").length;
  const waiting = queue.filter((item) => item.status === "queued" || item.status === "ready").length;
  const blocked = queue.filter((item) => item.status === "ready" && isSelectionMissing(item, tool)).length;
  const skipped = queue.filter((item) => item.status === "no_face" || item.status === "skipped").length;
  return { total, processed, waiting, blocked, skipped };
}

function nextReviewableId(queue, currentId) {
  if (!queue.length) {
    return null;
  }

  const currentIndex = Math.max(
    0,
    queue.findIndex((item) => item.localId === currentId)
  );
  const ordered = [...queue.slice(currentIndex + 1), ...queue.slice(0, currentIndex)];
  const next = ordered.find((item) => ["queued", "ready", "error"].includes(item.status));
  return next?.localId ?? null;
}

function modeLabel(mode) {
  return mode === "batch" ? "批量队列" : "单张工作区";
}

function promptForItem(item, tool) {
  if (!item) {
    return "先选择一张图片或一个文件夹。";
  }
  if (item.status === "detecting") {
    return "正在检测人脸。";
  }
  if (item.status === "processing") {
    return "正在生成结果。";
  }
  if (item.status === "error") {
    return item.error || "处理失败，请重试。";
  }
  if (item.status === "no_face") {
    return "这张图没有检测到人脸，可以跳过或继续下一张。";
  }
  if (!item.detection) {
    return "打开图片后会自动开始检测。";
  }
  if (!item.detection.faces.length) {
    return "没有检测到可用人脸。";
  }
  if (tool === "keep") {
    if (item.detection.faces.length > 1 && item.keepFaceId == null) {
      return "保留工具已启用，请点选要保留的人脸。";
    }
    return "已选定保留目标，可以保存这一页。";
  }
  if (item.eraseFaceIds.length === 0) {
    return "涂抹工具已启用，请点选要抹掉的人脸。";
  }
  return `已选择 ${item.eraseFaceIds.length} 张待抹除的人脸。`;
}

function downloadName(item, suffix) {
  return `${basename(item.name)}-${suffix}.jpg`;
}

function tilePreviewSrc(item) {
  return item.previewUrl || item.detection?.image?.dataUrl || "";
}

function buildCropBoxFromFace(face, faceRatio) {
  if (!face) {
    return null;
  }

  const faceWidth = Math.max(face.box.x2 - face.box.x1, 1);
  const faceHeight = Math.max(face.box.y2 - face.box.y1, 1);
  const cropSide = Math.max(faceWidth, faceHeight) / faceRatio;
  const centerX = (face.box.x1 + face.box.x2) / 2;
  const centerY = (face.box.y1 + face.box.y2) / 2;
  const halfSide = cropSide / 2;

  return {
    x1: centerX - halfSide,
    y1: centerY - halfSide,
    x2: centerX + halfSide,
    y2: centerY + halfSide
  };
}

function clampCropBox(cropBox, image) {
  if (!cropBox || !image) {
    return null;
  }

  const side = Math.max(cropBox.x2 - cropBox.x1, cropBox.y2 - cropBox.y1);
  const minSide = Math.max(64, Math.min(image.width, image.height) * 0.08);
  const maxSide = Math.max(image.width, image.height) * 1.8;
  const normalizedSide = Math.min(Math.max(side, minSide), maxSide);
  const centerX = (cropBox.x1 + cropBox.x2) / 2;
  const centerY = (cropBox.y1 + cropBox.y2) / 2;

  return {
    x1: centerX - normalizedSide / 2,
    y1: centerY - normalizedSide / 2,
    x2: centerX + normalizedSide / 2,
    y2: centerY + normalizedSide / 2
  };
}

function cropBoxEquals(left, right) {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    Math.abs(left.x1 - right.x1) < 0.5 &&
    Math.abs(left.y1 - right.y1) < 0.5 &&
    Math.abs(left.x2 - right.x2) < 0.5 &&
    Math.abs(left.y2 - right.y2) < 0.5
  );
}

export default function FaceWorkbench() {
  const [mode, setMode] = useState("single");
  const [tool, setTool] = useState("keep");
  const [queue, setQueue] = useState([]);
  const [activeItemId, setActiveItemId] = useState(null);
  const [globalError, setGlobalError] = useState("");
  const [faceRatio, setFaceRatio] = useState(0.45);
  const [serverInputPath, setServerInputPath] = useState("");
  const [serverOutputPath, setServerOutputPath] = useState("");
  const [serverLoading, setServerLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);

  const queueRef = useRef([]);
  const singleInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const canvasPaneRef = useRef(null);
  const stageCanvasRef = useRef(null);
  const dragStateRef = useRef(null);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    return () => {
      revokeQueueUrls(queueRef.current);
    };
  }, []);

  const activeItem = queue.find((item) => item.localId === activeItemId) ?? null;
  const summary = queueSummary(queue, tool);

  useEffect(() => {
    if (!activeItemId && queue.length) {
      setActiveItemId(queue[0].localId);
    }
  }, [activeItemId, queue]);

  useEffect(() => {
    if (mode !== "batch") {
      return;
    }

    const start = currentPage * PAGE_SIZE;
    const visibleIds = queue.slice(start, start + PAGE_SIZE).map((item) => item.localId);
    if (!visibleIds.length) {
      return;
    }

    if (!activeItemId || !visibleIds.includes(activeItemId)) {
      setActiveItemId(visibleIds[0]);
    }
  }, [activeItemId, currentPage, mode, queue]);

  useEffect(() => {
    const hasRunningDetection = queue.some((item) => item.status === "detecting");
    if (hasRunningDetection) {
      return;
    }

    const nextQueued = queue.find((item) => item.status === "queued");
    if (nextQueued) {
      void detectItem(nextQueued.localId);
    }
  }, [queue]);

  useEffect(() => {
    if (!activeItem || tool !== "keep" || activeItem.cropBoxEdited) {
      return;
    }

    if (!activeItem.detection?.faces?.length) {
      return;
    }

    const keepFace =
      activeItem.keepFaceId != null
        ? activeItem.detection.faces.find((face) => face.index === activeItem.keepFaceId)
        : activeItem.detection.faces[0];
    const nextCropBox = clampCropBox(buildCropBoxFromFace(keepFace, faceRatio), activeItem.detection.image);
    if (!nextCropBox) {
      return;
    }
    if (cropBoxEquals(activeItem.cropBox, nextCropBox)) {
      return;
    }

    updateQueueItem(activeItem.localId, {
      cropBox: nextCropBox
    });
  }, [activeItem, faceRatio, tool]);

  function installQueue(nextFiles, nextMode) {
    const nextItems = createQueueItems(Array.from(nextFiles || []));
    revokeQueueUrls(queueRef.current);
    setQueue(nextItems);
    setMode(nextMode);
    setCurrentPage(0);
    setActiveItemId(nextItems[0]?.localId ?? null);
    setGlobalError(nextItems.length ? "" : "所选内容里没有可处理的图片。");
  }

  function installServerQueue(payload) {
    revokeQueueUrls(queueRef.current);
    setQueue(payload.items || []);
    setMode(payload.mode || "single");
    setCurrentPage(0);
    setActiveItemId(payload.items?.[0]?.localId ?? null);
    setServerOutputPath(payload.outputRoot || "");
    setGlobalError(payload.items?.length ? "" : "服务端路径里没有可处理的图片。");
  }

  function updateQueueItem(localId, transform) {
    setQueue((current) =>
      current.map((item) => {
        if (item.localId !== localId) {
          return item;
        }
        return typeof transform === "function" ? transform(item) : { ...item, ...transform };
      })
    );
  }

  function getFacesByIndexes(faces, indexes) {
    const indexSet = new Set(indexes);
    return faces.filter((face) => indexSet.has(face.index));
  }

  async function detectItem(localId, force = false) {
    const item = queueRef.current.find((entry) => entry.localId === localId);
    if (!item) {
      return;
    }
    if (!force && (item.status === "detecting" || item.status === "processing")) {
      return;
    }

    updateQueueItem(localId, {
      status: "detecting",
      error: ""
    });

    try {
      const response =
        item.sourceType === "server"
          ? await fetch("/api/detect", {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                imagePath: item.serverImagePath
              })
            })
          : await (async () => {
              const formData = new FormData();
              formData.append("file", item.file);
              return fetch("/api/detect", {
                method: "POST",
                body: formData
              });
            })();
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "检测失败。");
      }

      updateQueueItem(localId, (current) => {
        const faces = payload.faces || [];
        const validKeep = faces.some((face) => face.index === current.keepFaceId) ? current.keepFaceId : null;
        const validEraseFaceIds = current.eraseFaceIds.filter((faceId) =>
          faces.some((face) => face.index === faceId)
        );

        return {
          ...current,
          status: faces.length ? "ready" : "no_face",
          error: "",
          detection: {
            imageId: payload.imageId,
            image: {
              dataUrl: payload.image.dataUrl,
              width: payload.image.width,
              height: payload.image.height,
              name: payload.image.name
            },
            faces
          },
          keepFaceId: faces.length === 1 ? faces[0].index : validKeep,
          cropBox: faces.length
            ? clampCropBox(
                buildCropBoxFromFace(
                  faces.length === 1 ? faces[0] : faces.find((face) => face.index === validKeep) ?? faces[0],
                  faceRatio
                ),
                payload.image
              )
            : null,
          cropBoxEdited: false,
          eraseFaceIds: validEraseFaceIds
        };
      });
      setGlobalError("");
    } catch (error) {
      updateQueueItem(localId, {
        status: "error",
        error: error instanceof Error ? error.message : "检测失败。"
      });
      setGlobalError(error instanceof Error ? error.message : "检测失败。");
    }
  }

  async function importServerPath() {
    if (!serverInputPath.trim()) {
      setGlobalError("先输入服务端图片路径。");
      return;
    }

    setServerLoading(true);
    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          inputPath: serverInputPath,
          outputPath: serverOutputPath
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "导入服务端路径失败。");
      }

      installServerQueue(payload);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "导入服务端路径失败。");
    } finally {
      setServerLoading(false);
    }
  }

  async function saveCurrentItem(localId) {
    let item = queueRef.current.find((entry) => entry.localId === localId);
    if (!item) {
      return;
    }

    if (!item.detection && item.status === "queued") {
      await detectItem(localId);
      item = queueRef.current.find((entry) => entry.localId === localId);
    }

    if (!item?.detection?.faces?.length) {
      setGlobalError("这张图没有可处理的人脸。");
      return;
    }

    const keepFace =
      tool === "keep" && item.keepFaceId != null
        ? item.detection.faces.find((face) => face.index === item.keepFaceId)
        : null;
    const eraseFaces = tool === "erase" ? getFacesByIndexes(item.detection.faces, item.eraseFaceIds) : [];

    if (!keepFace && eraseFaces.length === 0) {
      setGlobalError("先用工具选人脸：保留一张，或者抹掉一张。");
      return;
    }

    updateQueueItem(localId, { status: "processing", error: "" });

    try {
      const response = await fetch("/api/process", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          imageId: item.detection.imageId,
          imagePath: item.serverImagePath,
          sourceType: item.sourceType,
          outputRoot: item.outputRoot,
          relativePath: item.relativePath,
          faceRatio,
          keepBox: keepFace?.box ?? null,
          cropBox: tool === "keep" ? item.cropBox ?? null : null,
          eraseBoxes: eraseFaces.map((face) => face.box)
        })
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "处理失败。");
      }

      updateQueueItem(localId, (current) => ({
        ...current,
        status: "processed",
        result: {
          ...(current.result ?? {}),
          ...payload
        },
        error: ""
      }));
      setGlobalError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "处理失败。";
      updateQueueItem(localId, {
        status: "error",
        error: message
      });
      setGlobalError(message);
    }
  }

  function goNextItem() {
    if (!activeItem) {
      return;
    }
    const nextId = nextReviewableId(queueRef.current, activeItem.localId);
    if (nextId) {
      setActiveItemId(nextId);
    }
  }

  function skipActiveItem() {
    if (!activeItem) {
      return;
    }
    updateQueueItem(activeItem.localId, { status: "skipped", error: "" });
    goNextItem();
  }

  function clearWorkspace() {
    revokeQueueUrls(queueRef.current);
    setQueue([]);
    setCurrentPage(0);
    setActiveItemId(null);
    setGlobalError("");
  }

  async function saveCurrentPage() {
    const start = currentPage * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const pageItems = queueRef.current.slice(start, end);

    for (const item of pageItems) {
      if (["processed", "processing", "detecting", "skipped", "no_face"].includes(item.status)) {
        continue;
      }

      if (item.status === "ready" && isSelectionMissing(item, tool)) {
        continue;
      }

      if (item.detection?.faces?.length) {
        await saveCurrentItem(item.localId);
      }
    }

    setGlobalError("本页可处理图片已提交保存，未选人脸的图片已保留供单图精修。");
  }

  function removeItem(localId) {
    const item = queueRef.current.find((entry) => entry.localId === localId);
    if (!item) {
      return;
    }

    const confirmed = window.confirm(`确认移除这张图片的处理？\n${item.pathLabel}`);
    if (!confirmed) {
      return;
    }

    updateQueueItem(localId, {
      status: "skipped",
      keepFaceId: null,
      cropBox: null,
      cropBoxEdited: false,
      eraseFaceIds: [],
      error: ""
    });

    if (activeItemId === localId) {
      const nextId = nextReviewableId(queueRef.current, localId);
      setActiveItemId(nextId);
    }
  }

  function focusItem(localId) {
    setActiveItemId(localId);

    if (mode !== "batch") {
      return;
    }

    requestAnimationFrame(() => {
      canvasPaneRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  }

  function selectFace(faceIndex) {
    if (!activeItem) {
      return;
    }

    if (tool === "keep") {
      updateQueueItem(activeItem.localId, (current) => {
        const nextFace = current.detection?.faces?.find((face) => face.index === faceIndex);
        return {
          ...current,
          keepFaceId: faceIndex,
          cropBox: current.cropBoxEdited
            ? current.cropBox
            : clampCropBox(buildCropBoxFromFace(nextFace, faceRatio), current.detection?.image),
          cropBoxEdited: false
        };
      });
    } else {
      updateQueueItem(activeItem.localId, (current) => {
        const exists = current.eraseFaceIds.includes(faceIndex);
        return {
          ...current,
          eraseFaceIds: exists
            ? current.eraseFaceIds.filter((id) => id !== faceIndex)
            : [...current.eraseFaceIds, faceIndex]
        };
      });
    }

    setGlobalError("");
  }

  function updateActiveCropBox(transform) {
    if (!activeItem?.detection?.image) {
      return;
    }

    updateQueueItem(activeItem.localId, (current) => ({
      ...current,
      cropBox: clampCropBox(
        typeof transform === "function" ? transform(current.cropBox) : transform,
        current.detection?.image
      ),
      cropBoxEdited: true
    }));
  }

  function beginCropInteraction(modeName, event) {
    if (tool !== "keep" || !activeItem?.cropBox || !activeItem.detection?.image || !stageCanvasRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    dragStateRef.current = {
      mode: modeName,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCropBox: activeItem.cropBox,
      stageRect: stageCanvasRef.current.getBoundingClientRect(),
      image: activeItem.detection.image
    };
  }

  function handleStageWheel(event) {
    if (tool !== "keep" || !activeItem?.cropBox || !activeItem.detection?.image || !stageCanvasRef.current) {
      return;
    }

    event.preventDefault();

    const rect = stageCanvasRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const image = activeItem.detection.image;
    const scaleX = image.width / rect.width;
    const scaleY = image.height / rect.height;
    const anchorX = (event.clientX - rect.left) * scaleX;
    const anchorY = (event.clientY - rect.top) * scaleY;
    const factor = event.deltaY < 0 ? 0.92 : 1.08;

    updateActiveCropBox((currentCropBox) => ({
      x1: anchorX + (currentCropBox.x1 - anchorX) * factor,
      y1: anchorY + (currentCropBox.y1 - anchorY) * factor,
      x2: anchorX + (currentCropBox.x2 - anchorX) * factor,
      y2: anchorY + (currentCropBox.y2 - anchorY) * factor
    }));
  }

  useEffect(() => {
    function handlePointerMove(event) {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }

      const scaleX = dragState.image.width / dragState.stageRect.width;
      const scaleY = dragState.image.height / dragState.stageRect.height;
      const deltaX = (event.clientX - dragState.startClientX) * scaleX;
      const deltaY = (event.clientY - dragState.startClientY) * scaleY;

      if (dragState.mode === "move") {
        updateActiveCropBox({
          x1: dragState.startCropBox.x1 + deltaX,
          y1: dragState.startCropBox.y1 + deltaY,
          x2: dragState.startCropBox.x2 + deltaX,
          y2: dragState.startCropBox.y2 + deltaY
        });
        return;
      }

      const startSide = dragState.startCropBox.x2 - dragState.startCropBox.x1;
      const centerX = (dragState.startCropBox.x1 + dragState.startCropBox.x2) / 2;
      const centerY = (dragState.startCropBox.y1 + dragState.startCropBox.y2) / 2;
      let side = startSide;

      if (dragState.mode === "resize-east") {
        side = startSide + deltaX * 2;
      } else if (dragState.mode === "resize-west") {
        side = startSide - deltaX * 2;
      } else if (dragState.mode === "resize-south") {
        side = startSide + deltaY * 2;
      } else if (dragState.mode === "resize-north") {
        side = startSide - deltaY * 2;
      } else {
        side = Math.max(startSide + deltaX * 2, startSide + deltaY * 2);
      }

      updateActiveCropBox({
        x1: centerX - side / 2,
        y1: centerY - side / 2,
        x2: centerX + side / 2,
        y2: centerY + side / 2
      });
    }

    function handlePointerUp() {
      dragStateRef.current = null;
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [activeItem, tool]);

  const currentPrompt = promptForItem(activeItem, tool);
  const saveDisabled =
    !activeItem ||
    activeItem.status === "detecting" ||
    activeItem.status === "processing" ||
    !activeItem.detection?.faces?.length ||
    isSelectionMissing(activeItem, tool);
  const cropBox = activeItem?.cropBox;
  const cropBoxWidth =
    cropBox && activeItem?.detection?.image
      ? ((cropBox.x2 - cropBox.x1) / activeItem.detection.image.width) * 100
      : 0;
  const cropBoxHeight =
    cropBox && activeItem?.detection?.image
      ? ((cropBox.y2 - cropBox.y1) / activeItem.detection.image.height) * 100
      : 0;
  const cropBoxLeft =
    cropBox && activeItem?.detection?.image
      ? (cropBox.x1 / activeItem.detection.image.width) * 100
      : 0;
  const cropBoxTop =
    cropBox && activeItem?.detection?.image
      ? (cropBox.y1 / activeItem.detection.image.height) * 100
      : 0;
  const totalPages = Math.max(1, Math.ceil(queue.length / PAGE_SIZE));
  const normalizedPage = Math.min(currentPage, totalPages - 1);
  const pageStart = normalizedPage * PAGE_SIZE;
  const pageItems = queue.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <main className="mailApp">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandGlyph">F</div>
          <div>
            <p className="brandEyebrow">Face Mailroom</p>
            <h1>像收件箱一样处理人脸图片</h1>
          </div>
        </div>

        <div className="summaryStrip">
          <div className="summaryChip">
            <span>总数</span>
            <strong>{summary.total}</strong>
          </div>
          <div className="summaryChip">
            <span>已完成</span>
            <strong>{summary.processed}</strong>
          </div>
          <div className="summaryChip">
            <span>待处理</span>
            <strong>{summary.waiting}</strong>
          </div>
          <div className="summaryChip">
            <span>待选人</span>
            <strong>{summary.blocked}</strong>
          </div>
        </div>
      </header>

      <section className="workbenchShell">
        <aside className="leftRail">
          <div className="railPanel">
            <div className="segmented">
              <button
                className={mode === "single" ? "segment selected" : "segment"}
                onClick={() => setMode("single")}
                type="button"
              >
                单张
              </button>
              <button
                className={mode === "batch" ? "segment selected" : "segment"}
                onClick={() => setMode("batch")}
                type="button"
              >
                批量
              </button>
            </div>

            <button className="actionButton primary" onClick={() => singleInputRef.current?.click()} type="button">
              选择图片
            </button>
            <button className="actionButton" onClick={() => folderInputRef.current?.click()} type="button">
              选择文件夹
            </button>
            <div className="serverImportCard">
              <label className="fieldLabel" htmlFor="server-input-path">
                服务端输入路径
              </label>
              <input
                className="textInput"
                id="server-input-path"
                onChange={(event) => setServerInputPath(event.target.value)}
                placeholder="/data/images 或 /data/images/a.jpg"
                type="text"
                value={serverInputPath}
              />
              <label className="fieldLabel" htmlFor="server-output-path">
                服务端输出路径
              </label>
              <input
                className="textInput"
                id="server-output-path"
                onChange={(event) => setServerOutputPath(event.target.value)}
                placeholder="留空则自动生成输出目录"
                type="text"
                value={serverOutputPath}
              />
              <button className="actionButton" onClick={importServerPath} type="button" disabled={serverLoading}>
                {serverLoading ? "读取中..." : "读取服务端路径"}
              </button>
            </div>
            <button className="actionButton subtle" onClick={clearWorkspace} type="button">
              清空当前队列
            </button>

            <div className="toolPalette">
              <div className="toolPaletteHeader">
                <span className="fieldLabel">工具</span>
                <span className="toolHint">{TOOL_META[tool].hint}</span>
              </div>
              <div className="toolToggle">
                <button
                  className={tool === "keep" ? "toolButton selected" : "toolButton"}
                  onClick={() => setTool("keep")}
                  type="button"
                >
                  {TOOL_META.keep.label}
                </button>
                <button
                  className={tool === "erase" ? "toolButton selected" : "toolButton"}
                  onClick={() => setTool("erase")}
                  type="button"
                >
                  {TOOL_META.erase.label}
                </button>
              </div>
            </div>

            <div className="controlCluster">
              <label className="fieldLabel" htmlFor="face-ratio">
                自动裁剪参考占比 {Math.round(faceRatio * 100)}%
              </label>
              <input
                id="face-ratio"
                max="0.7"
                min="0.3"
                onChange={(event) => setFaceRatio(Number(event.target.value))}
                step="0.01"
                type="range"
                value={faceRatio}
              />
            </div>
          </div>

          <div className="railPanel railListPanel">
            <div className="listPanelHeader">
              <div>
                <p className="sectionEyebrow">{modeLabel(mode)}</p>
                <h2>{mode === "batch" ? "批量平铺" : "图片队列"}</h2>
              </div>
              <span className="countBadge">{summary.total}</span>
            </div>

            {mode === "batch" ? (
              <div className="batchHint">
                点击缩略图进入编辑区，选择保留人脸并调整裁剪框。本页保存会跳过未确认图片。
              </div>
            ) : null}

            {mode === "batch" ? (
              <div className="batchPager">
                <button
                  className="actionButton subtle pagerButton"
                  disabled={normalizedPage === 0}
                  onClick={() => setCurrentPage((value) => Math.max(0, value - 1))}
                  type="button"
                >
                  上一页
                </button>
                <span className="pagerText">
                  第 {normalizedPage + 1} / {totalPages} 页
                </span>
                <button
                  className="actionButton subtle pagerButton"
                  disabled={normalizedPage >= totalPages - 1}
                  onClick={() => setCurrentPage((value) => Math.min(totalPages - 1, value + 1))}
                  type="button"
                >
                  下一页
                </button>
              </div>
            ) : null}

            {queue.length ? (
              <div className={mode === "batch" ? "queueGrid" : "queueList"}>
                {(mode === "batch" ? pageItems : queue).map((item, index) => {
                  const status = STATUS_META[item.status];
                  const isActive = item.localId === activeItemId;
                  const selectedCount = (item.keepFaceId != null ? 1 : 0) + item.eraseFaceIds.length;
                  const previewSrc = tilePreviewSrc(item);
                  return (
                    <div className={isActive ? "queueTile active" : "queueTile"} key={item.localId}>
                      <div className="queueItemTop">
                        <span className="queueOrder">{mode === "batch" ? pageStart + index + 1 : index + 1}</span>
                        <span className={`statusDot ${status.tone}`}>{status.label}</span>
                      </div>
                      <button
                        className="queueTileMain"
                        onClick={() => focusItem(item.localId)}
                        type="button"
                      >
                        {previewSrc ? (
                          <img alt={item.name} className="queueTilePreview" src={previewSrc} />
                        ) : (
                          <div className="queueTilePlaceholder">等待预览</div>
                        )}
                        <strong>{item.name}</strong>
                        <span className="queuePath">{item.pathLabel}</span>
                        <div className="queueMeta">
                          <span>{item.detection?.faces?.length ?? 0} 张脸</span>
                          <span>{selectedCount ? `${selectedCount} 个已选` : "未选"}</span>
                        </div>
                        <span className="queueTileHint">
                          {item.status === "ready"
                            ? isSelectionMissing(item, tool)
                              ? "点击精修"
                              : "已可保存"
                            : item.status === "processed"
                              ? "已完成"
                              : "等待检测"}
                        </span>
                      </button>
                      <div className="queueTileActions">
                        <button
                          className="tileIconButton"
                          onClick={() => removeItem(item.localId)}
                          type="button"
                        >
                          丢弃
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="emptyQueue">
                <strong>还没有图片</strong>
                <p>单张模式可直接选图，批量模式可直接选择整个文件夹。</p>
              </div>
            )}

            {mode === "batch" ? (
              <button className="actionButton primary" onClick={saveCurrentPage} type="button">
                保存本页
              </button>
            ) : null}
          </div>
        </aside>

        <section className="canvasPane" ref={canvasPaneRef}>
          <div className="paneHeader">
            <div>
              <p className="sectionEyebrow">Review</p>
              <h2>{activeItem?.name || "当前预览"}</h2>
            </div>
            <div className="statusStack">
              {activeItem ? (
                <span className={`statusBadge ${STATUS_META[activeItem.status].tone}`}>
                  {STATUS_META[activeItem.status].label}
                </span>
              ) : null}
              <span className="mutedLine">{currentPrompt}</span>
            </div>
          </div>

          {activeItem ? (
            <div className="stagePanel">
              <div className="stageCanvas" onWheel={handleStageWheel} ref={stageCanvasRef}>
                <img
                  alt={activeItem.name}
                  className="stageImage"
                  src={activeItem.previewUrl || activeItem.detection?.image?.dataUrl}
                />
                {tool === "keep" && cropBox ? (
                  <div
                    className="cropBox"
                    onPointerDown={(event) => beginCropInteraction("move", event)}
                    style={{
                      left: `${cropBoxLeft}%`,
                      top: `${cropBoxTop}%`,
                      width: `${cropBoxWidth}%`,
                      height: `${cropBoxHeight}%`
                    }}
                  >
                    <div className="cropBoxBadge">裁剪预览</div>
                    <button
                      className="cropResizeHandle east"
                      onPointerDown={(event) => beginCropInteraction("resize-east", event)}
                      type="button"
                    />
                    <button
                      className="cropResizeHandle west"
                      onPointerDown={(event) => beginCropInteraction("resize-west", event)}
                      type="button"
                    />
                    <button
                      className="cropResizeHandle north"
                      onPointerDown={(event) => beginCropInteraction("resize-north", event)}
                      type="button"
                    />
                    <button
                      className="cropResizeHandle south"
                      onPointerDown={(event) => beginCropInteraction("resize-south", event)}
                      type="button"
                    />
                  </div>
                ) : null}
                {activeItem.detection?.faces?.map((face, order) => {
                  const keepSelected = tool === "keep" && face.index === activeItem.keepFaceId;
                  const eraseSelected = tool === "erase" && activeItem.eraseFaceIds.includes(face.index);
                  const boxWidth =
                    ((face.box.x2 - face.box.x1) / activeItem.detection.image.width) * 100;
                  const boxHeight =
                    ((face.box.y2 - face.box.y1) / activeItem.detection.image.height) * 100;
                  const boxLeft = (face.box.x1 / activeItem.detection.image.width) * 100;
                  const boxTop = (face.box.y1 / activeItem.detection.image.height) * 100;

                  return (
                    <button
                      className={
                        keepSelected
                          ? "faceBox keepSelected"
                          : eraseSelected
                            ? "faceBox eraseSelected"
                            : "faceBox"
                      }
                      key={face.index}
                      onClick={() => selectFace(face.index)}
                      style={{
                        left: `${boxLeft}%`,
                        top: `${boxTop}%`,
                        width: `${boxWidth}%`,
                        height: `${boxHeight}%`
                      }}
                      type="button"
                    >
                      <span>{order + 1}</span>
                    </button>
                  );
                })}
              </div>

              <div className="stageToolbar">
                <button className="actionButton subtle" onClick={() => detectItem(activeItem.localId, true)} type="button">
                  重新检测
                </button>
                <button
                  className="actionButton primary"
                  disabled={saveDisabled}
                  onClick={() => saveCurrentItem(activeItem.localId)}
                  type="button"
                >
                  {activeItem?.status === "processing" ? "处理中..." : mode === "batch" ? "保存" : "生成结果"}
                </button>
                {mode === "batch" ? (
                  <button className="actionButton" onClick={goNextItem} type="button">
                    下一张
                  </button>
                ) : null}
                <button
                  className="actionButton subtle"
                  disabled={!activeItem || ["processed", "skipped"].includes(activeItem.status)}
                  onClick={skipActiveItem}
                  type="button"
                >
                  跳过这张
                </button>
              </div>
            </div>
          ) : (
            <div className="canvasEmpty">
              <strong>像看邮件一样逐张处理图片。</strong>
              <p>左边导入图片或文件夹，系统会把它们组织成一个可审阅的工作队列。</p>
            </div>
          )}
        </section>

        <aside className="inspectorPane">
          <div className="railPanel">
            <div className="listPanelHeader">
              <div>
                <p className="sectionEyebrow">Faces</p>
                <h2>候选人脸</h2>
              </div>
              {activeItem?.detection?.faces?.length ? (
                <span className="countBadge">{activeItem.detection.faces.length}</span>
              ) : null}
            </div>

            {activeItem?.detection?.faces?.length ? (
              <div className="faceList">
                {activeItem.detection.faces.map((face, order) => {
                  const keepSelected = tool === "keep" && face.index === activeItem.keepFaceId;
                  const eraseSelected = tool === "erase" && activeItem.eraseFaceIds.includes(face.index);
                  return (
                    <button
                      className={
                        keepSelected
                          ? "faceListCard keepSelected"
                          : eraseSelected
                            ? "faceListCard eraseSelected"
                            : "faceListCard"
                      }
                      key={face.index}
                      onClick={() => selectFace(face.index)}
                      type="button"
                    >
                      <img alt={`Face ${order + 1}`} src={face.previewDataUrl} />
                      <div>
                        <strong>{keepSelected ? "保留目标" : eraseSelected ? "抹除目标" : `候选 ${order + 1}`}</strong>
                        <span>置信度 {formatConfidence(face.confidence)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="miniEmpty">检测完成后，这里会列出所有候选人脸。</div>
            )}
          </div>

          <div className="railPanel">
            <div className="listPanelHeader">
              <div>
                <p className="sectionEyebrow">Output</p>
                <h2>结果预览</h2>
              </div>
            </div>

            {activeItem?.result?.crop ? (
              <div className="resultStack">
                <div className="resultCard">
                  <div className="resultCardHeader">
                    <strong>裁剪结果</strong>
                    {activeItem.sourceType === "server" ? null : (
                      <a
                        className="downloadLink"
                        download={downloadName(activeItem, "crop")}
                        href={activeItem.result.crop.dataUrl}
                      >
                        下载
                      </a>
                    )}
                  </div>
                  <img alt="Crop result" src={activeItem.result.crop.dataUrl} />
                  {activeItem.result.saved?.cropPath ? (
                    <p className="resultPath">已保存到：{activeItem.result.saved.cropPath}</p>
                  ) : null}
                </div>

                {activeItem.result.painted ? (
                  <div className="resultCard">
                    <div className="resultCardHeader">
                      <strong>涂抹结果</strong>
                      {activeItem.sourceType === "server" ? null : (
                        <a
                          className="downloadLink"
                          download={downloadName(activeItem, "painted")}
                          href={activeItem.result.painted.dataUrl}
                        >
                          下载
                        </a>
                      )}
                    </div>
                    <img alt="Painted result" src={activeItem.result.painted.dataUrl} />
                    {activeItem.result.saved?.paintedPath ? (
                      <p className="resultPath">已保存到：{activeItem.result.saved.paintedPath}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : activeItem?.result?.painted ? (
              <div className="resultStack">
                <div className="resultCard">
                  <div className="resultCardHeader">
                    <strong>涂抹结果</strong>
                    {activeItem.sourceType === "server" ? null : (
                      <a
                        className="downloadLink"
                        download={downloadName(activeItem, "painted")}
                        href={activeItem.result.painted.dataUrl}
                      >
                        下载
                      </a>
                    )}
                  </div>
                  <img alt="Painted result" src={activeItem.result.painted.dataUrl} />
                  {activeItem.result.saved?.paintedPath ? (
                    <p className="resultPath">已保存到：{activeItem.result.saved.paintedPath}</p>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="miniEmpty">当前图片处理完成后，结果会出现在这里。</div>
            )}

            {globalError ? <p className="errorBanner">{globalError}</p> : null}
          </div>
        </aside>
      </section>

      <input
        accept="image/*"
        hidden
        onChange={(event) => {
          installQueue(event.target.files, "single");
          event.target.value = "";
        }}
        ref={singleInputRef}
        type="file"
      />
      <input
        accept="image/*"
        hidden
        multiple
        onChange={(event) => {
          installQueue(event.target.files, "batch");
          event.target.value = "";
        }}
        ref={folderInputRef}
        type="file"
      />
    </main>
  );
}
