/** @type {import('next').NextConfig} */
const nextConfig = {
  // lib/*가 CommonJS로 mongodb/bcryptjs를 require → 번들 대신 외부 모듈로 처리(서버리스 호환)
  experimental: {
    serverComponentsExternalPackages: ['mongodb', 'bcryptjs'],
  },
};

module.exports = nextConfig;
