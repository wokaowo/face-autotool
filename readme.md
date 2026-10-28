# auto-img

基于 YOLOv8 的人脸数据集产线。长图会先按缝切开，每张脸上都生成 **1024×1024** 样本和侧车信息。满足条件的脸自动入库，其余进入复核。YOLO 和按人分夹是单独导出。

## 功能

| 功能 | CLI | Web |
|---|---|---|
| 长图按缝切开 | 是 | 是 |
| 每张脸都裁成 1024 样本 | 是 | 是 |
| 单脸、清晰、完整、不重复时自动入库 | 是 | 是 |
| 复核多脸、低置信度、出框、过小、补边、模糊、重复 |  | 是 |
| 排除某张脸，不把涂黑写进训练图 |  | 是 |
| 导出生成集、YOLO、按人分夹 | 导出目录里都有生成集，YOLO 和按人分夹在 Web 里单独导出 | Web 里点导出 |

默认：检测阈值 0.25，自动入库阈值 0.6，最短边 64，模糊阈值 50，重复距离 8，人脸比例 0.45，验证集比例 0.1，长图阈值 16/9。

同一张原图上的脸进同一个 train 或 val。刷新页面后，用上次的输出目录恢复 `job.json`。

## 安装

```powershell
pip install -r requirements.txt
npm install
```

模型文件是仓库里的 `face_yolov8s.pt`。

## 命令行

```powershell
python main.py --input .\input --model .\face_yolov8s.pt --output .\output
```

生成文件在 `output/dataset/generation/{train|val}/`。任务状态在 `output/job.json`。

| 参数 | 默认 | 作用 |
|---|---|---|
| `--conf` | 0.25 | 检测阈值 |
| `--auto-conf` | 0.6 | 自动入库的最低置信度 |
| `--min-face` | 64 | 自动入库的人脸最短边 |
| `--blur-threshold` | 50 | 自动入库的清晰度下限 |
| `--face-ratio` | 0.45 | 人脸占输出边长的比例 |
| `--val-ratio` | 0.1 | 验证集比例，按原图划分 |
| `--ratio` | 1.78 | 长图高宽比阈值 |
| `--seam-sensitivity` | 1.5 | 切缝灵敏度 |
| `--device` | auto | cuda、cpu 或 0 |

## Web

```powershell
npm run dev
```

打开 `http://localhost:3000`。

1. 填写输出目录。上传的图片会先复制到该目录的 `incoming`。
2. 也可以直接选服务器上的输入文件夹，再开始检测。
3. 画布是格子底。参考图最大占可见区域的 70%。裁剪框如果超出照片，露出的是格子。
4. 滚轮缩放画面，按住 Alt 滚轮调整裁剪。方向键换图，1 到 9 选脸，S 入库，X 跳过。
5. 入库、跳过、排除和失败原因都会写出来。
6. 导出可选生成集、YOLO 或按人分夹。身份留空时进入 `unknown`。

## 目录

```
auto-img/
├── main.py
├── dataset.py
├── pipeline.py
├── gui_service.py
├── face_yolov8s.pt
├── app/
├── components/face-workbench.jsx
└── lib/stage-layout.mjs
```
