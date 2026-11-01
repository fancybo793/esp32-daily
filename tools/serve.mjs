#!/usr/bin/env node
/**
 * serve.mjs —— 在局域网里把 site/ 目录发出去，手机连同一 Wi-Fi 就能打开
 * 用法: node tools/serve.mjs [port]
 * 默认端口 8123，监听 0.0.0.0
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const PORT = Number(process.argv[2] || 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(SITE, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(SITE)) { res.writeHead(403); return res.end('403'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}).listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) for (const a of nets[k] || []) {
    if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  console.log(`ESP32 灵感日历已发布（局域网）`);
  console.log(`  本机: http://127.0.0.1:${PORT}/`);
  ips.forEach(ip => console.log(`  手机: http://${ip}:${PORT}/   （需连同一个 Wi-Fi）`));
});
