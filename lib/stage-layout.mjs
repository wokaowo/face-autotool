const IMAGE_VIEW_LIMIT = 0.7;
const CROP_VIEW_LIMIT = 0.88;

export function fitStageLayout({ viewportWidth, viewportHeight, imageWidth, imageHeight, cropBox }) {
  const viewWidth = Number(viewportWidth);
  const viewHeight = Number(viewportHeight);
  const sourceWidth = Number(imageWidth);
  const sourceHeight = Number(imageHeight);

  if (
    !Number.isFinite(viewWidth) ||
    !Number.isFinite(viewHeight) ||
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    viewWidth < 2 ||
    viewHeight < 2 ||
    sourceWidth < 1 ||
    sourceHeight < 1
  ) {
    return null;
  }

  const crop = cropBox
    ? {
        x1: Number(cropBox.x1),
        y1: Number(cropBox.y1),
        x2: Number(cropBox.x2),
        y2: Number(cropBox.y2)
      }
    : { x1: 0, y1: 0, x2: sourceWidth, y2: sourceHeight };

  if (![crop.x1, crop.y1, crop.x2, crop.y2].every(Number.isFinite) || crop.x2 <= crop.x1 || crop.y2 <= crop.y1) {
    return null;
  }

  const minX = Math.min(0, crop.x1);
  const minY = Math.min(0, crop.y1);
  const maxX = Math.max(sourceWidth, crop.x2);
  const maxY = Math.max(sourceHeight, crop.y2);
  const contentWidth = Math.max(maxX - minX, 1);
  const contentHeight = Math.max(maxY - minY, 1);
  const scale = Math.min(
    (viewWidth * IMAGE_VIEW_LIMIT) / sourceWidth,
    (viewHeight * IMAGE_VIEW_LIMIT) / sourceHeight,
    (viewWidth * CROP_VIEW_LIMIT) / contentWidth,
    (viewHeight * CROP_VIEW_LIMIT) / contentHeight
  );

  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }

  return {
    scale,
    boardWidth: contentWidth * scale,
    boardHeight: contentHeight * scale,
    imageLeft: (0 - minX) * scale,
    imageTop: (0 - minY) * scale,
    imageWidth: sourceWidth * scale,
    imageHeight: sourceHeight * scale,
    cropLeft: (crop.x1 - minX) * scale,
    cropTop: (crop.y1 - minY) * scale,
    cropWidth: (crop.x2 - crop.x1) * scale,
    cropHeight: (crop.y2 - crop.y1) * scale,
    overflows:
      crop.x1 < -0.5 || crop.y1 < -0.5 || crop.x2 > sourceWidth + 0.5 || crop.y2 > sourceHeight + 0.5
  };
}
