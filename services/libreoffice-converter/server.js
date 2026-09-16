import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';

const PORT = Number(process.env.PORT) || 8080;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS) || 60000;
const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS) || 120000;

const app = express();
app.use(express.json({ limit: '1mb' }));

const SPREADSHEET_EXTENSIONS = new Set(['.xls', '.xlsx', '.ods']);
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.csv',
  '.json',
]);

async function downloadFile(url, destPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `Download failed: ${response.status} ${response.statusText}`,
      );
    }
    await pipeline(
      response.body,
      (await import('node:fs')).createWriteStream(destPath),
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function convertWithLibreOffice(
  inputPath,
  outputDir,
  filter = 'txt:Text',
) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'soffice',
      [
        '--headless',
        '--nologo',
        '--nofirststartwizard',
        '--convert-to',
        filter,
        '--outdir',
        outputDir,
        inputPath,
      ],
      {
        timeout: CONVERT_TIMEOUT_MS,
      },
    );

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(`LibreOffice exited ${code}: ${stderr.slice(0, 500)}`),
        );
        return;
      }
      resolve();
    });
  });
}

async function extractFromPath(inputPath, originalName, workDir) {
  const ext = path.extname(originalName).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    const text = await fs.readFile(inputPath, 'utf-8');
    return { text, format: ext === '.html' || ext === '.htm' ? 'html' : 'text' };
  }

  const baseName = path.basename(originalName, ext);
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    await convertWithLibreOffice(inputPath, workDir, 'html:HTML (StarCalc)');
    const html = await fs.readFile(path.join(workDir, `${baseName}.html`), 'utf-8');
    return { text: html, format: 'html' };
  }

  await convertWithLibreOffice(inputPath, workDir);
  const text = await fs.readFile(path.join(workDir, `${baseName}.txt`), 'utf-8');
  return { text, format: 'text' };
}

async function extractText(url) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-convert-'));
  try {
    const originalName = path.basename(new URL(url).pathname) || 'document';
    const inputPath = path.join(workDir, originalName);
    await downloadFile(url, inputPath);
    const result = await extractFromPath(inputPath, originalName, workDir);
    return { ...result, success: true };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

app.get('/health', (_req, res) => {
  res.json({ healthy: true });
});

app.post(
  '/convert-upload',
  express.raw({ type: () => true, limit: '100mb' }),
  async (req, res) => {
    let filename = 'document.bin';
    try {
      filename = path.basename(
        decodeURIComponent(String(req.headers['x-filename'] || 'document.bin')),
      );
    } catch {
      filename = 'document.bin';
    }
    if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
      res.status(400).json({ success: false, error: 'Missing request body' });
      return;
    }

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-upload-'));
    try {
      const inputPath = path.join(workDir, filename);
      await fs.writeFile(inputPath, req.body);
      const result = await extractFromPath(inputPath, filename, workDir);
      res.json({ ...result, success: true });
    } catch (error) {
      console.error('[libreoffice-converter] upload conversion failed', error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  },
);

app.post('/convert', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    res.status(400).json({ success: false, error: 'Missing url field' });
    return;
  }

  try {
    const result = await extractText(url);
    res.json(result);
  } catch (error) {
    console.error('[libreoffice-converter] conversion failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LibreOffice converter listening on 0.0.0.0:${PORT}`);
});
