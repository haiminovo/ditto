/** @type {import('next').NextConfig} */
const nextConfig = {
  // MCP SDK 是双格式且依赖树很重（express/hono/jose/ajv 等）。webpack 会解析到
  // dist/cjs 且无法 tree-shake，把整棵树打进 App Router 服务端 bundle。
  // 外置后变成运行时从 node_modules require。
  experimental: {
    serverComponentsExternalPackages: ['@modelcontextprotocol/sdk'],
  },
  webpack: (config) => {
    config.resolve.extensions.push('.wasm');
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    return config;
  },
};

module.exports = nextConfig;
