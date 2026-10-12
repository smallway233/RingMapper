import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Vite 只自动注入 VITE_ 前缀，这里自行读取项目根目录 .env。已有环境变量优先。 */
function loadDotEnv() {
  try {
    const text = readFileSync(path.resolve('.env'), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch { /* 未配置 .env 时登录入口会提示缺少凭证 */ }
}
loadDotEnv();

/** 与闪韵谱库（Blitz）相同的 PICO「账号关联」SSO：openid.picovr.com。 */
export type PicoUser = { openId: string; nickname: string; avatar: string };

type TokenData = {
  access_token?: string;
  open_id?: string;
  error_code?: number;
  description?: string;
};

type UserData = {
  open_id?: string;
  nickname?: string;
  avatar?: string;
  error_code?: number;
  description?: string;
};

const COOKIE = 'ringmapper_session';
const WEEK = 7 * 24 * 60 * 60;

function env(name: string, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

export function picoConfigured() {
  return Boolean(env('PICO_CLIENT_ID') && env('PICO_CLIENT_SECRET'));
}

export function loginRequired() {
  return picoConfigured() && env('RINGMAPPER_SKIP_LOGIN') !== '1';
}

function authDomain() {
  return env('PICO_AUTH_DOMAIN', 'https://openid.picovr.com').replace(/\/$/, '');
}

function secret() {
  return env('SESSION_SECRET', 'dev-only-change-me');
}

function redirectUri(req: IncomingMessage) {
  const configured = env('PICO_REDIRECT_URI');
  if (configured) return configured;
  const host = req.headers.host ?? '127.0.0.1:5173';
  const proto = (req.headers['x-forwarded-proto'] ?? 'http').toString().split(',')[0];
  return `${proto}://${host}/api/auth/pico/callback`;
}

export function authUrl(req: IncomingMessage) {
  const q = new URLSearchParams({
    client_key: env('PICO_CLIENT_ID'),
    redirect_uri: redirectUri(req),
  });
  return `${authDomain()}/oauth/authorize?${q}`;
}

function sign(body: string) {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

function writeCookie(res: ServerResponse, value: string, maxAge: number) {
  const secure = env('PICO_REDIRECT_URI').startsWith('https://');
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function writeSession(res: ServerResponse, user: PicoUser) {
  const body = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + WEEK * 1000 })).toString('base64url');
  writeCookie(res, `${body}.${sign(body)}`, WEEK);
}

export function clearSession(res: ServerResponse) {
  writeCookie(res, '', 0);
}

export function readSession(req: IncomingMessage): PicoUser | null {
  const raw = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const token = decodeURIComponent(raw);
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(body);
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PicoUser & { exp?: number };
    if (!data.openId || !data.exp || data.exp < Date.now()) return null;
    return { openId: data.openId, nickname: data.nickname || 'PICO用户', avatar: data.avatar || '' };
  } catch {
    return null;
  }
}

async function postForm<T>(path: string, form: URLSearchParams): Promise<T> {
  const response = await fetch(authDomain() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`PICO 账号服务返回 ${response.status}`);
  const parsed = JSON.parse(text) as { message?: string; data?: T };
  if (!parsed.data) throw new Error(parsed.message || 'PICO 响应缺少 data');
  return parsed.data;
}

export async function exchangeCode(code: string): Promise<PicoUser> {
  const token = await postForm<TokenData>('/passport/open/access_token/', new URLSearchParams({
    client_key: env('PICO_CLIENT_ID'),
    client_secret: env('PICO_CLIENT_SECRET'),
    code,
    grant_type: 'authorization_code',
  }));
  if (token.error_code || !token.access_token || !token.open_id) {
    throw new Error(token.description || '换取 PICO 令牌失败');
  }
  const info = await postForm<UserData>('/passport/open/userinfo/', new URLSearchParams({
    open_id: token.open_id,
    access_token: token.access_token,
  }));
  if (info.error_code && !info.open_id) throw new Error(info.description || '读取 PICO 用户信息失败');
  const openId = token.open_id || info.open_id || '';
  return {
    openId,
    nickname: info.nickname || (openId.length > 8 ? `PICO用户${openId.slice(0, 8)}` : 'PICO用户'),
    avatar: info.avatar || '',
  };
}

export function redirect(res: ServerResponse, location: string) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

const loginErrors = new Set(['missing_pico_credentials', 'missing_code', 'exchange_failed']);

export function safeLoginError(value: string) {
  const code = value.replace(/[^a-z0-9_]/gi, '').slice(0, 64);
  return loginErrors.has(code) || /^[a-z0-9_]{1,64}$/i.test(code) ? code : 'exchange_failed';
}
