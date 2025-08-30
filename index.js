import express from 'express';
import { fetch } from 'undici';
import { createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const app = express();
app.use(express.json({ limit: '50mb' }));

const dl = async (url, out) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
  return out;
};

const run = (args) => new Promise((resolve, reject) => {
  const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  p.stderr.on('data', (d) => (stderr += d.toString()));
  p.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Último frame (JPG) desde el final (por defecto 0.04s ~= 25fps)
app.get('/last-frame', async (req, res) => {
  try {
    const url = req.query.url;
    const offset = parseFloat(req.query.offset || '0.04'); // segundos desde el final
    if (!url) return res.status(400).json({ error: 'Falta ?url=' });

    const inFile = join(tmpdir(), `in_${Date.now()}.mp4`);
    const outFile = join(tmpdir(), `out_${Date.now()}.jpg`);
    await dl(url, inFile);

    // -sseof busca desde el final; -frames:v 1 saca 1 frame
    await run(['-y', '-sseof', `-${offset}`, '-i', inFile, '-frames:v', '1', '-q:v', '2', outFile]);

    const buf = await fs.readFile(outFile);
    res.set('Content-Type', 'image/jpeg').send(buf);
    fs.unlink(inFile).catch(()=>{});
    fs.unlink(outFile).catch(()=>{});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Concatenar varios MP4 (demuxer concat)
app.post('/concat', async (req, res) => {
  try {
    const urls = req.body.urls;
    if (!Array.isArray(urls) || urls.length < 2) {
      return res.status(400).json({ error: 'Envía { "urls": ["u1","u2",...] } (>=2)' });
    }
    const stamp = Date.now();
    const files = [];
    for (let i = 0; i < urls.length; i++) {
      const f = join(tmpdir(), `in_${stamp}_${i}.mp4`);
      await dl(urls[i], f);
      files.push(f);
    }
    const listPath = join(tmpdir(), `list_${stamp}.txt`);
    await fs.writeFile(listPath, files.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));

    const outMp4 = join(tmpdir(), `out_${stamp}.mp4`);
    await run(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outMp4]);

    const buf = await fs.readFile(outMp4);
    res.set('Content-Type', 'video/mp4').send(buf);
    // Limpieza
    Promise.allSettled([
      fs.unlink(listPath),
      fs.unlink(outMp4),
      ...files.map(f => fs.unlink(f))
    ]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Listening on', PORT));
