import "./globals.css";

export const metadata = {
  title: "Face Studio",
  description: "人脸图片识别、归档与精修工作台。"
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
