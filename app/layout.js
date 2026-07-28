import "./globals.css";

export const metadata = {
  title: "Face Mailroom",
  description: "Review single images or folder batches, choose the face to keep, and optionally paint it out."
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
