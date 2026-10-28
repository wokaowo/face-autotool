import assert from "node:assert/strict";

import { fitStageLayout } from "../lib/stage-layout.mjs";

const viewport = { viewportWidth: 1000, viewportHeight: 800 };

const contained = fitStageLayout({
  ...viewport,
  imageWidth: 2000,
  imageHeight: 1000,
  cropBox: { x1: 400, y1: 200, x2: 900, y2: 700 }
});

assert.ok(contained);
assert.ok(Math.abs(contained.imageWidth - 700) < 0.01, "wide image uses 70% of the view width");
assert.ok(contained.imageHeight <= 800 * 0.7 + 0.01);
assert.equal(contained.overflows, false);
assert.ok(contained.cropLeft >= contained.imageLeft);
assert.ok(contained.cropLeft + contained.cropWidth <= contained.imageLeft + contained.imageWidth + 0.01);

const portrait = fitStageLayout({
  ...viewport,
  imageWidth: 1000,
  imageHeight: 2000,
  cropBox: { x1: 100, y1: 100, x2: 500, y2: 500 }
});

assert.ok(Math.abs(portrait.imageHeight - 560) < 0.01, "tall image uses 70% of the view height");
assert.ok(portrait.imageWidth <= 1000 * 0.7 + 0.01);

const overflow = fitStageLayout({
  ...viewport,
  imageWidth: 1000,
  imageHeight: 1000,
  cropBox: { x1: -500, y1: -500, x2: 1500, y2: 1500 }
});

assert.equal(overflow.overflows, true);
assert.ok(overflow.imageWidth < 1000 * 0.7);
assert.ok(overflow.cropWidth <= 1000 * 0.88 + 0.01);
assert.ok(overflow.cropHeight <= 800 * 0.88 + 0.01);
assert.ok(overflow.imageLeft > 1, "empty crop area sits on the canvas beside the photo");
assert.ok(Math.abs(overflow.cropLeft) < 0.01);
assert.ok(overflow.boardWidth <= 1000 * 0.88 + 0.01);
assert.ok(overflow.boardHeight <= 800 * 0.88 + 0.01);

assert.equal(
  fitStageLayout({ viewportWidth: 0, viewportHeight: 800, imageWidth: 100, imageHeight: 100, cropBox: null }),
  null
);

console.log("stage layout ok");
