# 码道网关 · 生产镜像
# 零依赖：只有 node 运行时和仓库文件
FROM node:24-alpine

LABEL org.opencontainers.image.title="kio-code gateway" \
      org.opencontainers.image.description="码道（CodeArts）CLI 反代网关：OpenAI 兼容入口 + 多账号 + 控制台" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 运行时不装任何 npm 包，直接拷源码
COPY package.json ./
COPY server.mjs config.json ./
# lib/ 是运行时的全部实现（gateway / sign / stealth / transport / pacing），少一行就起不来
COPY lib ./lib
COPY public ./public
COPY tools ./tools
COPY docs ./docs
COPY LICENSE README.md ./

# 构建信息：容器里没有 .git，在线更新靠 build-info.json 判断「我现在是哪个提交」
ARG GIT_SHA=unknown
ARG BUILD_TIME=
RUN GIT_SHA="${GIT_SHA}" BUILD_TIME="${BUILD_TIME}" node -e "\
  const fs=require('fs');\
  const pkg=require('./package.json');\
  fs.writeFileSync('build-info.json', JSON.stringify({\
    sha: process.env.GIT_SHA || 'unknown',\
    version: pkg.version,\
    builtAt: process.env.BUILD_TIME || new Date().toISOString(),\
    source: 'docker'\
  }, null, 2));"

# 数据目录：账号、Key、用量、日志都落在这里，必须挂卷
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    MOCK_HUB_HOST=0.0.0.0 \
    MOCK_HUB_PORT=8787 \
    MOCK_HUB_MODE=gateway \
    MOCK_HUB_DATA=/app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MOCK_HUB_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
