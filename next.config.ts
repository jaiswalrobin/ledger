import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // .eml uploads are capped at 4 MB by the app; Vercel itself rejects bodies over 4.5 MB.
  experimental: { serverActions: { bodySizeLimit: "4.4mb" } },
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default nextConfig;
