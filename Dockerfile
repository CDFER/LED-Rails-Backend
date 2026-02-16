# Dockerfile
FROM oven/bun:1.3.9-alpine AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
WORKDIR /usr/src/app
COPY --from=install /temp/dev/node_modules node_modules
COPY . . 

# copy production dependencies and source code into final image
FROM base AS release
WORKDIR /usr/src/app

# 1. Copy only production modules
COPY --from=install /temp/prod/node_modules node_modules

# 2. Copy source code FROM THE CURRENT CONTEXT (User's machine)
#    This respects .dockerignore and avoids copying the heavy prerelease folder
COPY . .

# 3. Setup cache folder
USER root
RUN mkdir -p /usr/src/app/cache && chown bun:bun /usr/src/app/cache
USER bun

EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "server.ts" ]