import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@meteora-ag/dynamic-bonding-curve-sdk", "@meteora-ag/cp-amm-sdk"],
  webpack: (config, { isServer, webpack }) => {
    config.resolve.alias = { ...config.resolve.alias, "x402-fetch": false };
    if (!isServer) {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:stream$/, (resource: { request: string }) => {
          resource.request = "readable-stream";
        }),
      );
    }
    return config;
  },
};

export default nextConfig;
