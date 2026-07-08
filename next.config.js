/** @type {import('next').NextConfig} */
const nextConfig = {
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
