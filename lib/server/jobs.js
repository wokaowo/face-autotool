import { NextResponse } from "next/server";

import { runPythonCommand } from "./python.js";

const ACTIONS = {
  start: "job_start",
  status: "job_status",
  cancel: "job_cancel",
  sample: "job_sample",
  params: "job_params",
  export: "job_export",
  cursor: "job_cursor"
};

export async function respondJob(body) {
  const action = ACTIONS[body?.action];
  if (!action) {
    return NextResponse.json({ error: "未知任务操作。" }, { status: 400 });
  }

  const command = {
    cmd: action,
    inputPath: body.inputPath,
    outputPath: body.outputPath,
    params: body.params,
    rerun: Boolean(body.rerun),
    sampleId: body.sampleId,
    op: body.op,
    cropBox: body.cropBox,
    kind: body.kind,
    pieceId: body.pieceId,
    redraw: body.redraw
  };
  if (Object.prototype.hasOwnProperty.call(body, "identity")) {
    command.identity = body.identity;
  }

  try {
    const result = await runPythonCommand(command);
    const failed = Boolean(result?.error) && !result.status && !result.missing;
    return NextResponse.json(result, { status: failed ? 400 : 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "任务请求失败。" },
      { status: 500 }
    );
  }
}
