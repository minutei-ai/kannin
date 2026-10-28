FROM docker.io/oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS runtime
WORKDIR /app
COPY dist/server/ ./dist/server/
COPY dist/wasm/raio_engine_bg.wasm ./dist/wasm/raio_engine_bg.wasm
USER bun
EXPOSE 3000
ENV HOST=0.0.0.0 PORT=3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["bun", "dist/server/healthcheck.js"]
CMD ["bun", "dist/server/main.js"]
