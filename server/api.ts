import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import { decodeText, readYaml, writeYaml, validateChart, sortedProject, updateMetadata, type Project, type Song, type ChartEntry } from '../src/model';
import { authUrl, clearSession, exchangeCode, loginRequired, picoConfigured, readSession, redirect, safeLoginError, writeSession } from './pico-auth';
const ROOT = path.resolve('Map');
const BACKUPS = path.resolve('.ringmapper-backups');
export function safePath(root: string, relative: string) {
  if (!relative || relative.includes('\0') || relative.includes(':') || path.isAbsolute(relative)) throw new Error('不合法的相对路径');
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error('路径超出歌曲目录');
  return target;
}
async function checked(root: string, relative: string) {
  const target = safePath(root, relative);
  let cursor = target;
  while (cursor.length >= ROOT.length) {
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('不支持符号链接目录'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    if (cursor === ROOT) break;
    cursor = path.dirname(cursor);
  }
  return target;
}
async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const parts = await Promise.all(entries.filter(e => !e.isSymbolicLink()).map(async e => e.isDirectory() ? (await walk(path.join(dir, e.name))).map(p => `${e.name}/${p}`) : [e.name]));
  return parts.flat();
}
const text = async (p: string) => decodeText(await fs.readFile(p));
async function revision(dir: string, files: string[]) {
  const hash = createHash('sha256');
  for (const f of files) { const target = await checked(dir, f); hash.update(f); try { hash.update(await fs.readFile(target)); } catch (e: any) { if (e.code !== 'ENOENT') throw e; hash.update('missing'); } }
  return hash.digest('hex');
}
let catalogCache: Song[] | undefined;
async function ensureRoot() { await fs.mkdir(ROOT, { recursive: true }); }
export async function catalog(): Promise<Song[]> {
  if (catalogCache) return catalogCache;
  await ensureRoot();
  const dirs = await fs.readdir(ROOT, { withFileTypes: true });
  const results = await Promise.all(dirs.filter(d => d.isDirectory() && !d.isSymbolicLink()).map(async d => {
    try {
      const base = path.join(ROOT, d.name), info = readYaml(await text(path.join(base, 'Info.yaml')));
      const files = await walk(base), warnings: string[] = [];
      const references = new Map<string, any>();
      for (const set of [...(info.difficultyCiphermapSets ?? []), ...(info.difficultyBeatmapSets ?? [])]) {
        for (const entry of set.difficultyCiphermaps ?? set.difficultyBeatmaps ?? []) {
          const filename = (entry.ciphermapFilename ?? entry.beatmapFilename ?? '').replaceAll('\\', '/');
          references.set(filename, { ...entry, mode: set.ciphermapCharacteristicName ?? set.beatmapCharacteristicName });
          if (!files.includes(filename)) warnings.push(`元数据引用不存在：${filename}`);
        }
      }
      const charts: ChartEntry[] = files.filter(f => /\.yaml$/i.test(f) && f !== 'Info.yaml' && !/Event\.yaml$/i.test(f)).map(f => {
        const ref = references.get(f);
        return { path: f, mode: ref?.mode ?? f.split('/')[0], difficulty: ref?.difficulty ?? path.basename(f, '.yaml').replace(/RingDance|Ring/g, ''), eventPath: files.includes(ref?.eventmapFilename) ? ref.eventmapFilename : f.replace(/\.yaml$/i, 'Event.yaml') };
      });
      const order = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
      charts.sort((a, b) => a.mode.localeCompare(b.mode) || order.indexOf(a.difficulty) - order.indexOf(b.difficulty));
      return { id: d.name, name: String(info.songName || d.name), artist: String(info.songAuthorName || '未知艺术家'), bpm: Number(info.beatsPerMinute) || 120, duration: Number(info.songDuration) || 0, cover: files.includes(info.coverImageFilename) ? info.coverImageFilename : '', audio: files.includes(info.songFilename) ? info.songFilename : files.find(f => /\.(ogg|mp3|wav)$/i.test(f)) ?? '', charts, warnings };
    } catch (e) { console.warn(`跳过歌曲 ${d.name}:`, String(e)); return null; }
  }));
  return catalogCache = results.filter((s): s is Song => s !== null).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}
async function body(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > 150_000_000) throw new Error('请求超过 150MB'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const locks = new Set<string>();
async function save(input: Project & { assets?: Record<string, string> }) {
  const p = sortedProject(input);
  if (!/^[\p{L}\p{N}_.-]+$/u.test(p.songId) || p.songId === '.' || p.songId === '..') throw new Error('歌曲目录名只能包含字母、数字、中文、点、短横线和下划线');
  if (!p.chartPath.endsWith('.yaml') || !p.eventPath.endsWith('.yaml') || p.chartPath === p.eventPath || [p.chartPath, p.eventPath].includes('Info.yaml')) throw new Error('谱面和事件必须使用独立的 YAML 路径');
  const errors = validateChart(p.chart, p.event);
  if (errors.length) throw new Error(errors.slice(0, 5).join('；'));
  if (!(Number(p.info.beatsPerMinute) > 0) || !Number.isFinite(Number(p.info.songTimeOffset))) throw new Error('BPM 或偏移不合法');
  const dir = await checked(ROOT, p.songId);
  if (locks.has(dir)) throw new Error('该歌曲正在保存，请稍后重试');
  locks.add(dir);
  try {
    const primaryNames = ['Info.yaml', p.chartPath, p.eventPath];
    const assetEntries = Object.entries(input.assets ?? {}).filter(([name]) => !primaryNames.includes(name));
    if (assetEntries.some(([name]) => !/\.(yaml|ogg|mp3|wav|png|jpg|jpeg|webp)$/i.test(name))) throw new Error('资源格式不支持');
    const names = [...primaryNames, ...assetEntries.map(([name]) => name)];
    const targets = await Promise.all(names.map(f => checked(dir, f)));
    const current = await revision(dir, primaryNames);
    const exists = await fs.stat(dir).then(() => true, () => false);
    if (exists && (!p.revision || current !== p.revision)) throw new Error('文件已在外部修改或目录已存在。请重新打开，或保存到新的歌曲目录。');
    updateMetadata(p);
    const contents: (string | Buffer)[] = [writeYaml(p.info), writeYaml(p.chart), writeYaml(p.event), ...assetEntries.map(([, base64]) => Buffer.from(base64, 'base64'))];
    const originals = await Promise.all(targets.map(f => fs.readFile(f).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; })));
    let backup = '';
    if (exists) {
      backup = path.join(BACKUPS, p.songId, `${Date.now()}`);
      for (let i = 0; i < names.length; i++) if (originals[i]) { const dest = safePath(backup, names[i]); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, originals[i]!); }
    }
    const written: number[] = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        await fs.mkdir(path.dirname(targets[i]), { recursive: true });
        const tmp = targets[i] + `.ringmapper-${process.pid}.tmp`;
        try { await fs.writeFile(tmp, contents[i], 'utf8'); await fs.rename(tmp, targets[i]); written.push(i); }
        finally { await fs.unlink(tmp).catch(() => {}); }
      }
    } catch (e) {
      for (const i of written) if (originals[i]) await fs.writeFile(targets[i], originals[i]!); else await fs.unlink(targets[i]);
      throw e;
    }
    catalogCache = undefined;
    return { revision: await revision(dir, primaryNames), backup, info: p.info };
  } finally { locks.delete(dir); }
}
export async function workspaceFolder(songId = '') {
  await ensureRoot();
  const folder = songId ? await checked(ROOT, songId) : ROOT;
  if (!(await fs.stat(folder)).isDirectory()) throw new Error('谱面目录不存在');
  return folder;
}
async function openFolder(songId: string) {
  const folder = await workspaceFolder(songId);
  const executable = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [folder], { shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { path: folder };
}
async function handler(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return next();
  const json = (data: unknown, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); };
  try {
    if (url.pathname === '/api/auth/pico/login' && req.method === 'GET') {
      if (!picoConfigured()) return redirect(res, '/');
      return redirect(res, authUrl(req));
    }
    if (url.pathname === '/api/auth/pico/callback' && req.method === 'GET') {
      if (!picoConfigured()) return redirect(res, '/');
      const providerError = url.searchParams.get('error');
      if (providerError) return redirect(res, `/?login_error=${safeLoginError(providerError)}`);
      const code = url.searchParams.get('code') ?? '';
      if (!code) return redirect(res, '/?login_error=missing_code');
      try {
        writeSession(res, await exchangeCode(code));
      } catch {
        console.error('PICO 换票失败');
        return redirect(res, '/?login_error=exchange_failed');
      }
      return redirect(res, '/');
    }
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json({ error: '不接受跨站请求' }, 403);
    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      return json({ user: readSession(req), loginRequired: loginRequired(), configured: picoConfigured() });
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      clearSession(res);
      return json({ ok: true });
    }
    if (url.pathname === '/api/open-folder' && req.method === 'POST') { const input = await body(req); if (typeof input.song !== 'string') throw new Error('歌曲目录参数不合法'); return json(await openFolder(input.song)); }
    if (url.pathname === '/api/catalog' && req.method === 'GET') return json(await catalog());
    const id = url.searchParams.get('song') ?? '';
    if (url.pathname === '/api/project' && req.method === 'GET') {
      const song = (await catalog()).find(s => s.id === id);
      const entry = song?.charts.find(c => c.path === url.searchParams.get('chart'));
      if (!entry) return json({ error: '找不到谱面' }, 404);
      const dir = await checked(ROOT, id);
      const info = readYaml(await text(await checked(dir, 'Info.yaml')));
      const chart = readYaml(await text(await checked(dir, entry.path)));
      let event; try { event = readYaml(await text(await checked(dir, entry.eventPath))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; event = { version: chart.version, events: [] }; }
      return json({ info, chart, event, songId: id, chartPath: entry.path, eventPath: entry.eventPath, revision: await revision(dir, ['Info.yaml', entry.path, entry.eventPath]) });
    }
    if (url.pathname === '/api/revision' && req.method === 'GET') {
      const dir = await checked(ROOT, id);
      return json({ revision: await revision(dir, ['Info.yaml', url.searchParams.get('chart') ?? '', url.searchParams.get('event') ?? '']) });
    }
    if (url.pathname === '/api/save' && req.method === 'POST') return json(await save(await body(req)));
    if (url.pathname === '/api/export' && req.method === 'POST') {
      const p = sortedProject(await body(req));
      if (validateChart(p.chart, p.event).length) throw new Error('谱面存在无效字段');
      updateMetadata(p);
      const zip = new JSZip();
      if (p.songId) {
        const dir = await checked(ROOT, p.songId);
        for (const f of await walk(dir)) { if (!/\.(yaml|ogg|mp3|wav|png|jpg|jpeg|webp)$/i.test(f)) continue; zip.file(f, await fs.readFile(await checked(dir, f))); }
      }
      safePath(ROOT, p.chartPath); safePath(ROOT, p.eventPath);
      zip.file('Info.yaml', writeYaml(p.info)); zip.file(p.chartPath, writeYaml(p.chart)); zip.file(p.eventPath, writeYaml(p.event));
      res.setHeader('Content-Type', 'application/zip'); res.end(await zip.generateAsync({ type: 'nodebuffer' })); return;
    }
    if (url.pathname === '/api/asset' && req.method === 'GET') {
      const dir = await checked(ROOT, id), file = await checked(dir, url.searchParams.get('file') ?? '');
      if (!/\.(ogg|mp3|wav|png|jpg|jpeg|webp)$/i.test(file)) throw new Error('不支持的资源类型');
      const stat = await fs.stat(file); const ext = path.extname(file).toLowerCase();
      const mime: Record<string, string> = { '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
      res.setHeader('Content-Type', mime[ext]); res.setHeader('Accept-Ranges', 'bytes');
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      let start = 0, end = stat.size - 1;
      if (match) {
        start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
        res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      res.setHeader('Content-Length', end - start + 1);
      const stream = createReadStream(file, { start, end }); stream.on('error', () => res.destroy()); stream.pipe(res); return;
    }
    return json({ error: '接口不存在' }, 404);
  } catch (e: any) { json({ error: e.message || String(e) }, 400); }
}
export function mapApi(): Plugin { return { name: 'ringmapper-local-api', configureServer(server) { server.middlewares.use((req, res, next) => { void handler(req, res, next); }); }, configurePreviewServer(server) { server.middlewares.use((req, res, next) => { void handler(req, res, next); }); } }; }
