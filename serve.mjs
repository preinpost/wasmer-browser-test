#!/usr/bin/env node
// wasmer-test 로컬 서버
//   node serve.mjs
//
// 1) 정적 서버 (127.0.0.1:8321)
//    - index.html과 @wasmer/sdk 브라우저 빌드(node_modules)를 그대로 서빙
//    - Wasmer SDK의 공유 메모리·worker pool에 필요한 격리 헤더(COOP/COEP)를
//      모든 응답에 추가. file:// 로는 SDK가 동작하지 않으므로 이 서버가 필수.
// 2) WISP 프록시 (127.0.0.1:5001)
//    - 브라우저 안의 WASIX 프로그램이 TCP(HTTPS)로 나갈 때 쓰는 중계.
//    - WISP 프록시 설정(원본: wasmer 브라우저 yt-dlp PoC의 dev-wisp.mjs)을 이
//      디렉터리에 맞게 복사해 온 것. 정적 서버 Origin만 허용하고 공개하지 않는다.

import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const STATIC_PORT = 8321;
const WISP_PORT = 5001;
const ORIGIN = `http://127.0.0.1:${STATIC_PORT}`;

// ---- 1. 정적 서버 -----------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".d.ts": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const VENDOR_ROOT = resolve(HERE, "node_modules");

function serveStatic(req, res) {
  const url = new URL(req.url, ORIGIN);
  let path = decodeURIComponent(url.pathname);
  if (path === "/") path = "/index.html";

  let file;
  if (path.startsWith("/vendor/")) {
    // /vendor/@wasmer/sdk/... -> node_modules/@wasmer/sdk/...
    file = join(VENDOR_ROOT, normalize(path.slice("/vendor/".length)).replaceAll("\\", "/"));
    // wisp-js는 package.json browser 필드로 compat.mjs를 compat_browser.mjs로
    // 바꿔 번들링하는 구조라서, 정적 서빙에서는 그 치환을 직접 흉내 낸다.
    if (file.endsWith(join("@mercuryworkshop", "wisp-js", "src", "compat.mjs"))) {
      file = file.replace(/compat\.mjs$/, "compat_browser.mjs");
    }
  } else {
    file = join(HERE, normalize(path));
  }
  if (!file.startsWith(HERE) && !file.startsWith(VENDOR_ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const staticServer = http.createServer((req, res) => {
  // 브라우저 격리 헤더: SharedArrayBuffer + worker pool에 필수
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  serveStatic(req, res);
});

staticServer.listen(STATIC_PORT, "127.0.0.1", () => {
  console.log(`Static:  ${ORIGIN}  (브라우저에서 이 주소를 여세요)`);
});

// ---- 2. WISP 프록시 (브랜치 dev-wisp.mjs와 동일한 정책) ---------------------

const allowedOrigins = new Set([ORIGIN, "http://localhost:8321"]);
Object.assign(wisp.options, {
  allow_private_ips: false,
  allow_loopback_ips: false,
  allow_udp_streams: false,
  port_whitelist: [80, 443],
  stream_limit_total: 16,
  // wisp-js 0.4.1의 per-host limiter는 객체를 iterable로 순회해서 터진다.
  stream_limit_per_host: -1,
});
logging.set_level(logging.WARN);

const wispServer = http.createServer((req, res) => {
  // 페이지(8321)에서 fetch로 프록시 생존 여부를 확인할 수 있게 CORS를 붙인다.
  const origin = req.headers.origin;
  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("wasmer-test local WISP proxy\n");
});
wispServer.on("upgrade", (req, socket, head) => {
  if (req.url !== "/" || !allowedOrigins.has(req.headers.origin)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  wisp.routeRequest(req, socket, head);
});
wispServer.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
wispServer.listen(WISP_PORT, "127.0.0.1", () => {
  console.log(`WISP:    ws://127.0.0.1:${WISP_PORT}/  (pip·yt-dlp 네트워크 중계용)`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    staticServer.close(() => {});
    staticServer.closeAllConnections();
    wispServer.close(() => {});
    wispServer.closeAllConnections();
    process.exit(0);
  });
}
