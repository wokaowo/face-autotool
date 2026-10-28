import "./globals.css";

export const metadata = {
  title: "Face Studio",
  description: "人脸数据集产线：检测、复核，并导出 1024 样本。"
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
