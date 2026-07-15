'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 8787);
const VIDEO_DIR = path.resolve(process.env.VIDEO_DIR || path.join(__dirname, 'videos'));
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || '');
const ALLOWED_ORIGIN = String(process.env.ALLOWED_ORIGIN || '*');

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime'
};

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Authorization, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function authorized(req) {
  if (!ACCESS_TOKEN) return true;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return req.query.token === ACCESS_TOKEN || bearer === ACCESS_TOKEN;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/videos/:filename', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Token inválido.' });

  const safeName = path.basename(req.params.filename);
  const filePath = path.join(VIDEO_DIR, safeName);
  if (!filePath.startsWith(VIDEO_DIR + path.sep)) return res.sendStatus(400);

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) return res.status(404).json({ error: 'Vídeo não encontrado.' });

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';
    const range = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (!range) {
      res.setHeader('Content-Length', stat.size);
      return fs.createReadStream(filePath).pipe(res);
    }

    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) return res.sendStatus(416);

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.sendStatus(416);
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de vídeos: http://localhost:${PORT}`);
  console.log(`Pasta: ${VIDEO_DIR}`);
  if (!ACCESS_TOKEN) console.warn('AVISO: ACCESS_TOKEN vazio; os vídeos estão sem proteção por token.');
});
