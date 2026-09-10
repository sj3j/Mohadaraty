# syntax=docker/dockerfile:1

# The build context is the REPO ROOT, not bot/: the bot imports the announcement
# types and richText helpers straight out of src/ so that the schema and the
# link sanitiser have exactly one definition. esbuild resolves those at build
# time, which is why the runtime stage needs no src/ tree and no TypeScript.
#
#   docker build -f bot/Dockerfile -t mylecture-bot .

# Node 22 because functions/package.json already pins engines.node "22" - that
# is the runtime this codebase is certified on. Alpine is safe here: the
# dependency set (firebase-admin, dotenv) has no native modules. If a future
# dependency needs glibc, switch to node:22-bookworm-slim.
FROM node:22-alpine AS deps
WORKDIR /app
COPY bot/package.json bot/package-lock.json* ./
RUN npm install --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY bot/package.json ./package.json
COPY bot/src ./src
COPY bot/tsconfig.json ./tsconfig.json
# The two cross-tree imports. Copied explicitly rather than with `COPY . .` so
# the builder layer never contains .env or credentials even transiently.
COPY shared/telegramMirror.ts /shared/telegramMirror.ts
COPY src/types/announcement.types.ts /src/types/announcement.types.ts
COPY src/lib/richText.ts /src/lib/richText.ts
RUN npx esbuild src/index.ts \
      --bundle --platform=node --format=cjs --target=node22 \
      --packages=external --sourcemap --outfile=/out/bot.cjs

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Production deps only. Never `COPY . .` in this stage.
COPY bot/package.json bot/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /out/bot.cjs ./bot.cjs
USER node
CMD ["node", "bot.cjs"]
