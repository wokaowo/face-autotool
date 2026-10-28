/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1", "192.168.*.*"],
  typedRoutes: false
};

export default nextConfig;
