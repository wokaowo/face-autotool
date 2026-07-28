# auto-img

基于 YOLOv8 的人脸检测与自动裁切工具。自动把图片裁成以人脸为中心的 **1024×1024** 正方形，支持长图自动切割、多人脸手动选择、人脸涂抹消除。提供命令行（CLI）和 Web GUI 两种用法。

---

## 功能概览

| 功能 | CLI | Web GUI |
|---|---|---|
| 批量处理文件夹 | ✅ | ✅ |
| 长图自动分割 | ✅ | — |
| 人脸自动居中裁切 (1024×1024) | ✅ | ✅ |
| 多人脸手动点选 | — | ✅ |
| 人脸涂抹工具 | — | ✅ |
| 实时进度预览 | — | ✅ |

---

## 环境要求

- Python 3.9+
- Node.js 18+（仅 Web GUI 需要）
- YOLOv8 人脸模型权重（`face_yolov8s.pt` 已随仓库提供）

---

## 安装

```powershell
# Python 依赖
pip install -r requirements.txt

# Node 依赖（仅 Web GUI）
npm install
```

---

## 用法

### CLI

```powershell
python main.py --input .\Wepppin --model .\face_yolov8s.pt --output .\output
```

处理后结果保存到 `.\output`，人脸在 1024×1024 画面中占约 **45%**。

**常用参数：**

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--input` | （必填） | 输入图片目录 |
| `--model` | （必填） | YOLO 模型路径 |
| `--output` | `./output` | 输出目录 |
| `--face-ratio` | `0.45` | 人脸占输出图边长的比例 |
| `--conf` | `0.25` | YOLO 检测置信度阈值 |
| `--ratio` | `1.78 (16/9)` | 触发长图分割的高宽比阈值 |
| `--seam-sensitivity` | `1.5` | 长图分割缝隙灵敏度，越低分割越激进 |
| `--pad-incomplete` | 关闭 | 不足 1024 的边缘裁块用边缘像素补齐 |
| `--no-save-split` | 关闭 | 不保存长图分割的中间结果 |

### Web GUI

```powershell
npm run dev
```

打开 `http://localhost:3000`

**操作流程：**

1. 选择单张图片，或点击「选择文件夹」批量导入
2. 系统自动检测每张图片中的人脸
3. 使用「保留工具」点选要裁切保留的人脸，或切换到「涂抹工具」点选要抹掉的人脸
4. 在批量模式中，「保存」和「下一张」分开，适合长图拆分后逐张确认
5. 结果可直接在右侧预览并下载

---

## 项目结构

```
auto-img/
├── main.py               # CLI 主程序（图片分割 + 人脸检测 + 裁切）
├── gui_service.py        # Web GUI 的 Python JSON 桥接服务
├── face_yolov8s.pt       # YOLOv8 人脸检测模型权重
├── requirements.txt      # Python 依赖
├── app/                  # Next.js App Router 页面与 API
│   ├── page.js
│   └── api/
│       ├── detect/       # 人脸检测接口
│       └── process/      # 裁切/涂抹处理接口
├── components/
│   └── face-workbench.jsx  # 主 UI 组件（队列管理 + 人脸点选）
└── lib/
    └── server/
        ├── python.js     # 调用 Python 子进程的工具函数
        └── storage.js    # 临时文件存储管理
```

---

## 工作原理

1. **长图分割**：对高宽比超过阈值（默认 16:9）的拼接图，利用水平亮度梯度找缝隙自动切割
2. **人脸检测**：使用 YOLOv8 模型对每张子图检测所有人脸边界框
3. **智能裁切**：以选定人脸为锚点，计算最优裁切窗口，使人脸在 1024×1024 输出中占目标比例，并对超出图像边界的情况自动缩放或填充
