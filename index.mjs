/**
 * dsh-daily-checkin —— DSH 启动时自动完成 WorkBuddy、WPS 灵犀、Qoder、MiniMax Code、码道 CodeArts 的每日签到。
 *
 * - Host 半：读取本机客户端登录态（只读、只在内存中解密），调用官方接口签到；
 *   MiniMax Code 只读 ~/.mavis/auth/.../auth.json 里的 accessToken，不刷新、不改写；
 *   码道 CodeArts 走无头浏览器（codearts-claim.mjs）：注入登录快照 → SSO 自动续期 → 页面内调接口领取；
 *   状态写入 $DSH_HOME/.daily-checkin.json；向本地 Web UI 提供状态/重试接口；
 *   跨天后的第一次面板打开会自动补签当天。
 * - Client 半：会话标题栏入口 + 结果面板（失败可重试）。
 *
 * 安全：token/cookie 只在内存中使用，不落盘、不打印；只读客户端登录态文件。
 *       码道登录快照（$DSH_HOME/codearts-session.json）是唯一落盘的凭据文件，权限 600，仅本机使用。
 * 平台：WPS 灵犀 / Qoder 的登录态解密依赖 Windows（DPAPI + Chromium Cookie）；码道依赖 Playwright。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baseUrl as CODEARTS_BASE,
  profileDir as CODEARTS_PROFILE_DIR,
  statePath as CODEARTS_STATE_PATH,
} from './codearts-browser-common.mjs';

export const name = 'dsh-daily-checkin';
export const inject = ['webServer'];

const TITLE = {
  workbuddy: 'WorkBuddy',
  lingxi: 'WPS 灵犀',
  qoder: 'Qoder',
  codearts: '码道 CodeArts',
  minimax: 'MiniMax Code',
};

const LINGXI_TASKS = 'https://lingxi.wps.cn/api/public/v1/tasks';
const LINGXI_CLAIM = 'https://lingxi.wps.cn/api/public/v1/tasks/daily_check_in/claim';
const LINGXI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) WPS-LingXi/1.3.15 Chrome/138.0.0.0 Safari/537.36';
const QODER_API = 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns';

const HTTP_TIMEOUT_MS = 25000;
const HELPER_TIMEOUT_MS = 15000;

function statePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.daily-checkin.json');
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function shortText(value, limit = 120) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function roamingAppData() {
  return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
}

// ---------------------------------------------------------------- DPAPI / Chromium 解密

function runPowershell(script) {
  const encoded = Buffer.from(String(script), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { timeout: HELPER_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          status: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Windows DPAPI 解密（借 Windows PowerShell 的 .NET ProtectedData，当前用户上下文）。 */
async function dpapiUnprotect(data) {
  const b64 = Buffer.from(data).toString('base64');
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$bytes = [Convert]::FromBase64String('${b64}')`,
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.WriteLine([Convert]::ToBase64String($plain))',
  ].join('\n');
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await runPowershell(script);
    const lines = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z0-9+/]{40,}={0,2}$/.test(line));
    if (result.status === 0 && lines.length > 0) {
      const key = Buffer.from(lines[lines.length - 1], 'base64');
      if (key.length === 32) return key;
      lastError = `密钥长度异常：${key.length}`;
    } else {
      const stderr = String(result.stderr || '').replace(/\s+/g, ' ').slice(0, 160);
      lastError = `PowerShell 退出码 ${result.status}${stderr ? `：${stderr}` : ''}`;
    }
    await sleep(250);
  }
  throw new Error(`DPAPI 解密失败（${lastError || '未知原因'}）；请确认以当前登录的 Windows 用户运行 DSH`);
}

const chromiumKeyCache = new Map();
async function chromiumKeyFor(localStatePath) {
  if (chromiumKeyCache.has(localStatePath)) return chromiumKeyCache.get(localStatePath);
  if (!existsSync(localStatePath)) {
    throw new Error(`找不到 ${localStatePath}（请先登录对应客户端）`);
  }
  let state;
  try {
    state = JSON.parse(readFileSync(localStatePath, 'utf8'));
  } catch {
    throw new Error(`${localStatePath} 不是合法 JSON`);
  }
  const encoded = state?.os_crypt?.encrypted_key;
  if (typeof encoded !== 'string' || encoded === '') {
    throw new Error(`${localStatePath} 里没有 os_crypt.encrypted_key`);
  }
  const raw = Buffer.from(encoded, 'base64');
  if (raw.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new Error(`${localStatePath} 的密钥不是 DPAPI 格式`);
  }
  const key = await dpapiUnprotect(raw.subarray(5));
  chromiumKeyCache.set(localStatePath, key);
  return key;
}

function decryptChromiumValue(key, encryptedValue, hostKey) {
  const value = Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(encryptedValue ?? []);
  if (value.length === 0) return '';
  const prefix = value.subarray(0, 3).toString('latin1');
  let plain;
  if (prefix === 'v10' || prefix === 'v11') {
    const nonce = value.subarray(3, 15);
    const payload = value.subarray(15);
    if (payload.length < 16) throw new Error('Chromium 加密数据过短');
    const tag = payload.subarray(payload.length - 16);
    const ciphertext = payload.subarray(0, payload.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } else if (prefix === 'v20') {
    throw new Error('暂不支持 app-bound（v20）加密格式');
  } else {
    plain = value;
  }
  if (plain.length > 32) {
    const head = plain.subarray(0, 32);
    // Chromium 127+ 的 Cookie 明文前面带 sha256(host_key)（host 绑定），解出后要剥掉。
    let bound = false;
    if (typeof hostKey === 'string' && hostKey) {
      try {
        bound = createHash('sha256').update(hostKey).digest().equals(head);
      } catch {
        bound = false;
      }
    }
    if (!bound && [...head].some((byte) => byte < 0x20 || byte > 0x7e)) bound = true;
    if (bound) plain = plain.subarray(32);
  }
  return plain.toString('utf8');
}

let sqlitePromise;
async function loadSqlite() {
  if (!sqlitePromise) {
    sqlitePromise = import('node:sqlite').then(
      (module) => module.DatabaseSync,
      () => null,
    );
  }
  const DatabaseSync = await sqlitePromise;
  if (!DatabaseSync) {
    throw new Error('当前 DSH 运行时不支持 node:sqlite（需要 Node ≥ 22.13 / Electron 37+）');
  }
  return DatabaseSync;
}

/** 找 DSH 自带的 Node（宿主不支持 node:sqlite 时，用它作为子进程读取 Cookie）。 */
function runtimeNodeCandidates() {
  const candidates = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(
      join(process.resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    );
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(
      join(
        localAppData,
        'Programs',
        'DeepSeek Harness',
        'resources',
        'runtime',
        'primary-runtime',
        'dependencies',
        'node',
        'bin',
        'node.exe',
      ),
    );
  }
  candidates.push('node');
  return [...new Set(candidates)];
}

function helperScriptPath() {
  return fileURLToPath(new URL('./cookies-helper.mjs', import.meta.url));
}

function runCookieHelper(nodeExe, payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(nodeExe, [helperScriptPath()], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 30000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(error?.message || error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
        resolve(JSON.parse(line));
      } catch {
        resolve({
          ok: false,
          error: `helper 退出码 ${code}${stderr ? `：${shortText(stderr.trim(), 160)}` : ''}`,
        });
      }
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      /* ignore */
    }
  });
}

async function readChromiumCookiesViaHelper(dbPath, key, { names, hostFilterDesc } = {}) {
  const payload = { dbPath, keyBase64: key.toString('base64') };
  if (names) payload.names = names;
  if (hostFilterDesc) payload.hostFilter = hostFilterDesc;
  let lastError = '';
  for (const nodeExe of runtimeNodeCandidates()) {
    if (nodeExe !== 'node' && !existsSync(nodeExe)) continue;
    const result = await runCookieHelper(nodeExe, payload);
    if (result && result.ok === true && Array.isArray(result.cookies)) {
      return result.cookies.map((item) => ({ name: item.name, value: item.value, host: item.host ?? '' }));
    }
    lastError = result?.error || '未知错误';
  }
  throw new Error(`Cookie 读取 helper 失败：${shortText(lastError)}`);
}

/** 先在内置运行时读，失败再用 DSH 自带 Node 子进程兜底。 */
async function readChromiumCookies(dbPath, key, opts = {}) {
  try {
    return await readChromiumCookiesNative(dbPath, key, opts);
  } catch (nativeError) {
    try {
      return await readChromiumCookiesViaHelper(dbPath, key, opts);
    } catch (helperError) {
      throw new Error(
        `读取 Cookie 失败（内置：${shortText(nativeError?.message || nativeError, 140)}；helper：${shortText(
          helperError?.message || helperError,
          140,
        )}）`,
      );
    }
  }
}

/** 复制一份 Cookie 数据库再读（避免锁库、绝不修改原文件）；多个目录回退应对权限限制。 */
async function readChromiumCookiesNative(dbPath, key, { filterHost, names } = {}) {
  const DatabaseSync = await loadSqlite();
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const candidateDirs = [tmpdir(), dirname(dbPath), homedir()];
  let lastError;
  for (const directory of [...new Set(candidateDirs.filter(Boolean))]) {
    const temp = join(directory, `.dsh-cookie-${token}.db`);
    try {
      writeFileSync(temp, readFileSync(dbPath));
    } catch (error) {
      lastError = error;
      continue;
    }
    try {
      let db;
      try {
        db = new DatabaseSync(temp, { readOnly: true });
      } catch {
        db = new DatabaseSync(temp);
      }
      const rows = [];
      try {
        const statement = db.prepare('SELECT host_key, name, encrypted_value, value FROM cookies');
        for (const row of statement.all()) {
          const host = String(row.host_key ?? '');
          const cookieName = String(row.name ?? '');
          if (filterHost && !filterHost(host)) continue;
          if (names && !names.includes(cookieName)) continue;
          const plainValue = typeof row.value === 'string' ? row.value : '';
          let value = plainValue;
          if (!value && row.encrypted_value) {
            try {
              value = decryptChromiumValue(key, row.encrypted_value, host);
            } catch {
              continue;
            }
          }
          if (!value || !/^[\x20-\x7e]+$/.test(value)) continue;
          rows.push({ host, name: cookieName, value });
        }
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      return rows;
    } catch (error) {
      lastError = error;
    } finally {
      try {
        const { rmSync } = await import('node:fs');
        rmSync(temp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('无法读取 Cookie 数据库');
}

// ---------------------------------------------------------------- WPS 灵犀

async function wpsOfficeCookies() {
  const base = join(roamingAppData(), 'kingsoft', 'wps', 'addons', 'data', 'win-i386');
  const localPrefs = join(base, 'LocalPrefs.json');
  if (!existsSync(localPrefs)) {
    throw new Error('没有找到 WPS Office 的登录态（LocalPrefs.json）');
  }
  const key = await chromiumKeyFor(localPrefs);
  const databases = [join(base, 'cef', '1', 'cache', 'Network', 'Cookies')];
  // WPS Office 把 kessapp 的 Cookie 放在一个带安装标识的子目录里，该标识随安装/版本变化，
  // 这里动态扫一遍目录，避免在源码里写死某台机器的安装标识。
  try {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(base, entry.name, 'appdata', 'kessapp', 'Network', 'Cookies');
      if (existsSync(candidate)) databases.push(candidate);
    }
  } catch {
    /* 目录读不到就只扫默认位置 */
  }
  const wanted = ['wps_sid', '_cdr', 'wps_sid_2'];
  const cookies = {};
  for (const database of databases) {
    if (!existsSync(database)) continue;
    const rows = await readChromiumCookies(database, key, { names: wanted });
    for (const row of rows) {
      if (!cookies[row.name]) cookies[row.name] = row.value;
    }
    if (cookies.wps_sid) break;
  }
  return cookies;
}

async function lingxiOwnCookies() {
  const dir = join(roamingAppData(), 'WPS 灵犀');
  const localState = join(dir, 'Local State');
  const database = join(dir, 'Network', 'Cookies');
  if (!existsSync(localState) || !existsSync(database)) {
    throw new Error('没有找到 WPS 灵犀的登录态');
  }
  const key = await chromiumKeyFor(localState);
  const rows = await readChromiumCookies(database, key, {
    filterHost: (host) => host.endsWith('wps.cn') || host.includes('lingxi'),
    hostFilterDesc: { suffix: 'wps.cn', includes: 'lingxi' },
  });
  const cookies = {};
  for (const row of rows) cookies[row.name] = row.value;
  return cookies;
}

function lingxiHeaders(cookies) {
  const cookieHeader = Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([cookieName, value]) => `${cookieName}=${value}`)
    .join('; ');
  return {
    Accept: 'application/json, text/plain, */*',
    Cookie: cookieHeader,
    Origin: 'https://lingxi.wps.cn',
    Referer: 'https://lingxi.wps.cn/',
    'User-Agent': LINGXI_UA,
  };
}

async function httpJson(url, { method = 'GET', headers = {}, body, timeout = HTTP_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* ignore */
    }
    throw new Error(`请求 ${host} 失败：${error?.name || 'Error'}`);
  }
  const text = await response.text().catch(() => '');
  let payload;
  try {
    payload = text.trim() ? JSON.parse(text) : {};
  } catch {
    payload = { _raw: text.slice(0, 200) };
  }
  return { status: response.status, payload };
}

async function lingxiFetchTasks(cookies) {
  const { status, payload } = await httpJson(LINGXI_TASKS, { headers: lingxiHeaders(cookies) });
  if (status === 200 && payload && payload.result === 'ok') return payload;
  if (status === 401 || status === 403) {
    throw new Error('WPS 登录态被拒绝（请重新登录 WPS 灵犀或 WPS Office）');
  }
  throw new Error(`WPS 任务接口返回 HTTP ${status}`);
}

function parseLingxiTasks(payload) {
  const body = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  const total = Number(body.total_claimed_credits) || 0;
  const daily = tasks.find((task) => task?.type === 'daily');
  let todayTask = {};
  if (daily) {
    const extra = daily.extra && typeof daily.extra === 'object' ? daily.extra : {};
    const days = Array.isArray(extra.check_in_days) ? extra.check_in_days : [];
    const row = days.find((day) => day && day.day === extra.today_day);
    todayTask = row && typeof row === 'object' ? { ...row } : {};
    todayTask.consecutiveDays = extra.consecutive_days;
    todayTask.reward = todayTask.reward || extra.today_reward;
  }
  return { todayTask, total };
}

async function runLingxi() {
  const at = new Date().toISOString();
  const sources = [];
  let cookies;
  let payload;
  let source = '';
  let lastError;
  for (const attempt of [
    ['WPS Office 共用登录态', wpsOfficeCookies],
    ['WPS 灵犀自己的登录态', lingxiOwnCookies],
  ]) {
    let loaded;
    try {
      loaded = await attempt[1]();
    } catch (error) {
      sources.push(`${attempt[0]}：${shortText(error?.message || error, 100)}`);
      continue;
    }
    if (!loaded?.wps_sid) {
      sources.push(`${attempt[0]}：没有 wps_sid`);
      continue;
    }
    try {
      payload = await lingxiFetchTasks(loaded);
      cookies = loaded;
      source = attempt[0];
      break;
    } catch (error) {
      lastError = error;
      sources.push(`${attempt[0]}：${shortText(error?.message || error, 100)}`);
    }
  }
  if (!payload) {
    return {
      uid: 'lingxi',
      nickname: TITLE.lingxi,
      state: 'failed',
      at,
      error: shortText(
        lastError
          ? `WPS 签到失败：${lastError.message}`
          : `找不到可用的 WPS 登录态（${sources.join('；') || '请先登录 WPS 灵犀或 WPS Office'}）`,
        300,
      ),
    };
  }
  const { todayTask, total } = parseLingxiTasks(payload);
  const state = typeof todayTask?.status === 'string' ? todayTask.status : '';
  const streak = typeof todayTask?.consecutive_days === 'number' ? todayTask.consecutive_days : todayTask?.consecutiveDays;
  const reward = typeof todayTask?.reward === 'number' ? todayTask.reward : 100;
  const row = {
    uid: 'lingxi',
    nickname: TITLE.lingxi,
    at,
    source,
    streakDays: typeof streak === 'number' ? streak : undefined,
    totalCredits: total,
  };
  if (state === 'claimed') {
    return {
      ...row,
      state: 'already',
      detail: `今天已签到（第 ${todayTask.day ?? '?'} 天，+${reward} 智点，累计 ${total}）`,
    };
  }
  if (state !== 'available') {
    return {
      ...row,
      state: 'failed',
      error: `WPS 任务状态异常：${state || '未知'}`,
    };
  }
  const { status, payload: claimPayload } = await httpJson(LINGXI_CLAIM, {
    method: 'POST',
    headers: lingxiHeaders(cookies),
  });
  if (status === 200 && claimPayload?.result === 'ok') {
    const newTotal = Number(claimPayload?.data?.total_claimed_credits) || total;
    const gained = newTotal - total;
    return {
      ...row,
      state: 'signed',
      credit: gained > 0 ? gained : reward,
      totalCredits: newTotal,
      detail: `签到成功 +${gained > 0 ? gained : reward} 智点（累计 ${newTotal}）`,
    };
  }
  return {
    ...row,
    state: 'failed',
    error: `WPS 签到失败：${shortText(claimPayload?.hint || claimPayload?.msg || `HTTP ${status}`)}`,
  };
}

// ---------------------------------------------------------------- Qoder

function qoderDataDir() {
  return join(roamingAppData(), 'com.qodercn.app.stable');
}

function qoderVersion() {
  const logsDir = join(qoderDataDir(), 'logs');
  let directories = [];
  try {
    directories = readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(logsDir, entry.name));
  } catch {
    return '0.4.8';
  }
  directories.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  for (const directory of directories.slice(0, 3)) {
    try {
      const text = readFileSync(join(directory, 'main.log'), 'utf8').slice(0, 30000);
      const match = /"version"\s*:\s*"(\d+(?:\.\d+){1,3})"/.exec(text);
      if (match) return match[1];
    } catch {
      /* 继续找 */
    }
  }
  return '0.4.8';
}

async function qoderAuth() {
  const dir = qoderDataDir();
  const localState = join(dir, 'Local State');
  const authFile = join(dir, 'auth.v1.dat');
  if (!existsSync(localState) || !existsSync(authFile)) {
    throw new Error('找不到 Qoder 登录态（请先登录 Qoder CN 桌面版）');
  }
  const key = await chromiumKeyFor(localState);
  let plain;
  try {
    plain = decryptChromiumValue(key, readFileSync(authFile));
  } catch (error) {
    throw new Error(`Qoder 登录态解密失败：${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(plain);
  } catch {
    throw new Error('Qoder 登录态内容不是合法 JSON');
  }
  if (!data || typeof data.token !== 'string' || !data.token) {
    throw new Error('Qoder 登录态里没有 token');
  }
  return data;
}

function qoderExpired(auth) {
  if (typeof auth?.expiresAt !== 'string') return false;
  const timestamp = Date.parse(auth.expiresAt);
  return Number.isFinite(timestamp) && timestamp < Date.now();
}

function qoderHeaders(auth) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${auth.token}`,
    'Cosy-ClientType': '10',
    'Cosy-Version': qoderVersion(),
    'User-Agent': 'Qoder',
  };
}

function formatTimestamp(seconds) {
  try {
    return new Date(Number(seconds) * 1000).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '?';
  }
}

async function runQoder() {
  const at = new Date().toISOString();
  const base = { uid: 'qoder', nickname: TITLE.qoder, at };
  let auth;
  try {
    auth = await qoderAuth();
  } catch (error) {
    return { ...base, state: 'failed', error: shortText(error?.message || error) };
  }
  if (auth?.user?.name) base.nickname = `Qoder（${auth.user.name}）`;
  if (qoderExpired(auth)) {
    return { ...base, state: 'failed', error: 'Qoder 登录态已过期，请打开一次 Qoder 客户端重新登录' };
  }
  let response;
  try {
    response = await httpJson(QODER_API, { headers: qoderHeaders(auth) });
  } catch (error) {
    return { ...base, state: 'failed', error: shortText(error?.message || error) };
  }
  if (response.status === 401 || response.status === 403) {
    return { ...base, state: 'failed', error: 'Qoder 登录态被拒绝（可能需要打开一次 Qoder 客户端刷新）' };
  }
  if (response.status !== 200) {
    return { ...base, state: 'failed', error: `Qoder 接口返回 HTTP ${response.status}` };
  }
  const campaigns = (Array.isArray(response.payload?.campaigns) ? response.payload.campaigns : []).filter(
    (campaign) => campaign?.actionType === 'CLAIM_BENEFIT',
  );
  if (campaigns.length === 0) {
    return { ...base, state: 'already', detail: '当前没有可签到的活动（正常）' };
  }
  campaigns.sort((a, b) => Number(b?.startAt || 0) - Number(a?.startAt || 0));
  const campaign = campaigns[0];
  const amount = Number(campaign?.benefit?.amount);
  const claimStatus = String(campaign?.claimStatus || '');
  const endAt = typeof campaign?.endAt === 'number' ? campaign.endAt : undefined;
  if (claimStatus === 'CLAIMED') {
    return {
      ...base,
      state: 'already',
      credit: Number.isFinite(amount) ? amount : undefined,
      detail: `今天已领取（+${Number.isFinite(amount) ? amount : '?'} Credits${endAt ? `，活动周期至 ${formatTimestamp(endAt)}` : ''}）`,
    };
  }
  if (claimStatus !== 'CLAIMABLE') {
    return { ...base, state: 'already', detail: `活动状态：${claimStatus || '未知'}` };
  }
  let claimResponse;
  try {
    claimResponse = await httpJson(`${QODER_API}/${encodeURIComponent(campaign.campaignId)}/claim`, {
      method: 'POST',
      headers: qoderHeaders(auth),
    });
  } catch (error) {
    return { ...base, state: 'failed', error: shortText(error?.message || error) };
  }
  if (claimResponse.status === 200 && String(claimResponse.payload?.status || '').toUpperCase() === 'CLAIMED') {
    return {
      ...base,
      state: 'signed',
      credit: Number.isFinite(amount) ? amount : undefined,
      detail: `领取成功 +${Number.isFinite(amount) ? amount : '?'} Credits`,
    };
  }
  return {
    ...base,
    state: 'failed',
    error: `Qoder 领取失败：${shortText(claimResponse.payload?.error || claimResponse.payload?.msg || `HTTP ${claimResponse.status}`)}`,
  };
}

// ---------------------------------------------------------------- MiniMax Code（每日签到领积分）

const MINIMAX_ORIGIN = 'https://agent.minimax.cn';
const MINIMAX_SIGNIN_STATUS = '/minimax-cloud/api/v1/signin/status';
const MINIMAX_SIGNIN_CLAIM = '/minimax-cloud/api/v1/signin/claim';
const MINIMAX_CREDIT_DETAILS = '/minimax-cloud/api/v1/credit/details';
const MINIMAX_RECORD_PREFIX = 'com.minimax.mcode.oauth.prod.cn';
const MINIMAX_DAY = { UPCOMING: 1, CLAIMABLE: 2, CLAIMED: 3, DISABLED: 4 };
const MINIMAX_UNAUTHORIZED = 1000048;

function minimaxAuthFile() {
  return (
    process.env.MINIMAX_AUTH_FILE ||
    join(homedir(), '.mavis', 'auth', 'prod', 'cn', 'mcode-public', 'auth.json')
  );
}

/**
 * 只读 MiniMax Code 的 OAuth 凭据（明文 JSON）。不自己刷新：refresh token 是轮换式的，
 * 插件刷新会让 MiniMax Code 自己手里的 refresh token 失效、被迫重新登录。
 */
function minimaxCredential() {
  const path = minimaxAuthFile();
  if (!existsSync(path)) throw new Error('找不到 MiniMax Code 登录态（请先登录 MiniMax Code 桌面版）');
  let payload;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('MiniMax Code 登录态文件不是合法 JSON');
  }
  const records = Object.entries(payload?.records ?? {});
  const preferred = records.find(([key]) => key.startsWith(MINIMAX_RECORD_PREFIX)) ?? records[0];
  const credential = preferred?.[1];
  if (typeof credential?.accessToken !== 'string' || !credential.accessToken) {
    throw new Error('MiniMax Code 登录态里没有 accessToken（请在 MiniMax Code 重新登录）');
  }
  return credential;
}

function minimaxMd5(value) {
  return createHash('md5').update(value).digest('hex');
}

/** 签名算法与 MiniMax Code 客户端一致（yy / x-timestamp / x-signature）。 */
async function minimaxRequest(credential, path, { method = 'GET', query } = {}) {
  const requestTime = Date.now();
  const url = new URL(path, MINIMAX_ORIGIN);
  url.search = new URLSearchParams({
    device_platform: 'mcode',
    biz_id: '3',
    app_id: '3001',
    version_code: '22201',
    unix: String(requestTime),
    timezone_offset: String(new Date().getTimezoneOffset() * -60),
    sys_language: 'zh',
    lang: 'zh',
    device_id: '0',
    os_name: process.platform,
    browser_name: 'mcode',
    user_id: '0',
    client: 'mcode',
    ...(query ?? {}),
  }).toString();
  const body = '{}';
  const second = Math.floor(requestTime / 1000);
  return httpJson(url.href, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'MiniMaxCode',
      Authorization: `Bearer ${credential.accessToken}`,
      yy: minimaxMd5(`${encodeURIComponent(`${url.pathname}${url.search}`)}_${body}${minimaxMd5(String(requestTime))}ooui`),
      'x-timestamp': String(second),
      'x-signature': minimaxMd5(`${second}I*7Cf%WZ#S&%1RlZJ&C2`),
    },
    body: method === 'POST' ? body : undefined,
  });
}

/** 返回 data；登录态被拒时抛带 unauthorized 标记的错误。 */
function minimaxData({ status, payload }, what) {
  const code = payload?.base_resp?.status_code ?? payload?.statusInfo?.code;
  if (status === 401 || code === MINIMAX_UNAUTHORIZED) {
    const error = new Error('MiniMax 登录态被拒绝：请打开一次 MiniMax Code 刷新登录后重试');
    error.unauthorized = true;
    throw error;
  }
  if (status !== 200) throw new Error(`MiniMax ${what}失败：HTTP ${status}`);
  if (typeof code === 'number' && code !== 0) {
    const message = payload?.base_resp?.status_msg || payload?.statusInfo?.message || `code ${code}`;
    throw new Error(`MiniMax ${what}失败：${shortText(message)}`);
  }
  if (payload?.data === null || payload?.data === undefined) throw new Error(`MiniMax ${what}返回里没有 data`);
  return payload.data;
}

function minimaxDayPoints(day) {
  const points = Number(day?.points) || 0;
  const bonus = Number(day?.bonus_points) || 0;
  return points + bonus;
}

/** 本周期内（第 1 天到今天）已领取的天数。 */
function minimaxClaimedDays(days) {
  const todayNo = Number(days.find((day) => day?.is_today)?.day_no) || 0;
  if (!todayNo) return 0;
  return days.filter((day) => {
    const no = Number(day?.day_no);
    return Number.isFinite(no) && no <= todayNo && day?.status === MINIMAX_DAY.CLAIMED;
  }).length;
}

/**
 * 积分余额：credit/details 是积分发放流水，汇总剩余额度即可。
 * 只是锦上添花，失败不影响签到结果。
 */
async function minimaxCredits(credential) {
  try {
    const payload = (await minimaxRequest(credential, MINIMAX_CREDIT_DETAILS, {
      query: { page: '1', page_size: '50' },
    })).payload;
    const rows = (Array.isArray(payload?.details) ? payload.details : [])
      .map((row) => ({ remaining: Number(row?.remaining_amount), expireAtMs: Number(row?.expire_at_ms) }))
      .filter((row) => Number.isFinite(row.remaining) && row.remaining > 0);
    if (rows.length === 0) return { balance: 0 };
    const balance = Math.round(rows.reduce((sum, row) => sum + row.remaining, 0) * 100) / 100;
    const expireAtMs = rows.reduce(
      (earliest, row) => (Number.isFinite(row.expireAtMs) && row.expireAtMs > 0 && (!earliest || row.expireAtMs < earliest) ? row.expireAtMs : earliest),
      0,
    );
    return { balance, ...(expireAtMs ? { expireAtMs } : {}) };
  } catch {
    return undefined;
  }
}

function formatDayMs(ms) {
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 面板第二行的小字：积分余额 / 过期日 / 明日奖励 / 本周期进度。 */
function minimaxMeta({ credits, nextPoints, claimedDays } = {}) {
  const parts = [];
  if (Number.isFinite(credits?.balance)) parts.push(`积分余额 ${credits.balance}`);
  const expires = formatDayMs(credits?.expireAtMs);
  if (expires) parts.push(`${expires} 过期`);
  if (Number.isFinite(nextPoints) && nextPoints > 0) parts.push(`明日 +${nextPoints}`);
  if (claimedDays) parts.push(`本周期 ${claimedDays}/7 天`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

async function runMinimax() {
  const at = new Date().toISOString();
  const base = { uid: 'minimax', nickname: TITLE.minimax, at };
  if (String(process.env.MINIMAX_DISABLED ?? '').trim() === '1') return undefined;
  let credential;
  try {
    credential = minimaxCredential();
  } catch (error) {
    return { ...base, state: 'failed', error: shortText(error?.message || error) };
  }
  if (Number.isFinite(credential.expiresAtMs) && credential.expiresAtMs <= Date.now() + 60_000) {
    return {
      ...base,
      state: 'failed',
      error: 'MiniMax 登录态已过期：打开一次 MiniMax Code（会自动刷新），再点重试',
    };
  }
  try {
    const panel = minimaxData(await minimaxRequest(credential, MINIMAX_SIGNIN_STATUS), '签到状态查询');
    const days = Array.isArray(panel?.days) ? panel.days : [];
    const todayEntry = days.find((day) => day?.is_today);
    const todayNo = Number(todayEntry?.day_no) || 0;
    const claimable = days.find((day) => day?.status === MINIMAX_DAY.CLAIMABLE);
    // 明天（第 7 天之后回到新一周期的第 1 天）的奖励，用于「明日 +X」。
    const nextDay = days.find((day) => Number(day?.day_no) === (todayNo % 7) + 1);
    const before = await minimaxCredits(credential);
    if (!claimable) {
      if (todayEntry?.status === MINIMAX_DAY.CLAIMED) {
        const credit = minimaxDayPoints(todayEntry);
        return {
          ...base,
          state: 'already',
          credit,
          balance: before?.balance,
          detail: `今天已领取（+${credit} 积分，第 ${todayEntry.day_no}/7 天）`,
          meta: minimaxMeta({
            credits: before,
            nextPoints: minimaxDayPoints(nextDay),
            claimedDays: minimaxClaimedDays(days),
          }),
        };
      }
      return {
        ...base,
        state: 'already',
        detail: '今天没有可领取的签到奖励',
        meta: minimaxMeta({ credits: before, nextPoints: minimaxDayPoints(nextDay) }),
      };
    }
    const claim = minimaxData(
      await minimaxRequest(credential, MINIMAX_SIGNIN_CLAIM, { method: 'POST' }),
      '签到领取',
    );
    const credit = Number.isFinite(claim?.points) ? claim.points : minimaxDayPoints(claimable);
    const dayNo = claim?.day_no ?? claimable.day_no;
    const alreadyClaimed = claim?.claim_result === 2;
    // 领取后余额变了，重新取一次。
    const after = alreadyClaimed ? before : await minimaxCredits(credential);
    const meta = minimaxMeta({
      credits: after,
      nextPoints: minimaxDayPoints(nextDay),
      claimedDays: minimaxClaimedDays(days) + (alreadyClaimed ? 0 : 1),
    });
    const detail = alreadyClaimed
      ? `今天已领取（+${credit} 积分，第 ${dayNo}/7 天）`
      : `领取成功 +${credit} 积分（第 ${dayNo}/7 天）`;
    return {
      ...base,
      state: alreadyClaimed ? 'already' : 'signed',
      credit,
      balance: after?.balance,
      detail,
      ...(meta ? { meta } : {}),
    };
  } catch (error) {
    return { ...base, state: 'failed', error: shortText(error?.message || error) };
  }
}

// ---------------------------------------------------------------- 码道 CodeArts（网页端每日签到）

function codeartsClaimScript() {
  return fileURLToPath(new URL('./codearts-claim.mjs', import.meta.url));
}

function codeartsNodeExe() {
  for (const candidate of runtimeNodeCandidates()) {
    if (candidate !== 'node' && existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

/** 子进程只带必要环境变量，避免把 NODE_* / DEBUG 之类调试开关带进去（Playwright 协议日志可能含 Cookie）。 */
function codeartsChildEnv() {
  const names = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SystemDrive',
    'windir',
    'COMSPEC',
    'TEMP',
    'TMP',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'DSH_HOME',
    'PLAYWRIGHT_CORE_PATH',
    'PLAYWRIGHT_BROWSERS_PATH',
  ];
  const env = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.CODEARTS_PROFILE_DIR = CODEARTS_PROFILE_DIR;
  env.CODEARTS_STATE_PATH = CODEARTS_STATE_PATH;
  env.CODEARTS_BASE_URL = CODEARTS_BASE;
  return env;
}

function clampTimeout(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** 杀子进程树（node 子进程还会拉起 Chromium 孙进程，只 kill 父进程会留孤儿）。 */
function killProcessTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {});
      return;
    }
    child.kill();
  } catch {
    /* ignore */
  }
}

/** 跑无头浏览器领取脚本（codearts-claim.mjs），解析它输出的一行 JSON。 */
function runCodeartsBrowser(timeoutMs = 180000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(codeartsNodeExe(), [codeartsClaimScript()], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: codeartsChildEnv(),
      });
    } catch (error) {
      resolve({ ok: false, reason: 'error', error: String(error?.message || error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let parsed;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const takeParsed = () => {
      for (const line of stdout.split(/\r?\n/)) {
        const text = line.trim();
        if (!text.startsWith('{') || !text.endsWith('}')) continue;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* 继续找 */
        }
      }
      return parsed;
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      const last = takeParsed();
      // 超时但脚本其实已经输出结果（例如卡在关浏览器）时，用已解析到的成功结果
      if (last && last.ok === true) finish(last);
      else finish({ ok: false, reason: 'error', error: '码道领取脚本超时' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      takeParsed();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish({ ok: false, reason: 'error', error: String(error?.message || error) }));
    child.on('close', (code) => {
      const last = takeParsed();
      if (last) {
        finish(last);
        return;
      }
      finish({
        ok: false,
        reason: 'error',
        error: `码道领取脚本退出码 ${code}${stderr ? `：${shortText(stderr.trim(), 160)}` : ''}`,
      });
    });
  });
}

/** 码道「活动福利 → 每日签到」：无头浏览器打开页面 → 页面内调活动接口领取。 */
async function runCodearts() {
  const at = new Date().toISOString();
  const base = { uid: 'codearts', nickname: TITLE.codearts, at };
  if (String(process.env.CODEARTS_DISABLED ?? '').trim() === '1') return undefined;
  if (!existsSync(CODEARTS_STATE_PATH)) {
    return {
      ...base,
      state: 'failed',
      error: '还没有码道登录态：请运行插件目录里的「码道登录.cmd」登录一次',
    };
  }
  const timeoutMs = clampTimeout(process.env.CODEARTS_CLAIM_TIMEOUT_MS, 180000, 60000, 600000);
  const result = await runCodeartsBrowser(timeoutMs);
  if (result?.nickname) base.nickname = result.nickname;
  if (result?.ok) {
    return {
      ...base,
      state: result.state === 'signed' ? 'signed' : 'already',
      credit: typeof result.credit === 'number' && Number.isFinite(result.credit) ? result.credit : undefined,
      detail: result.detail,
    };
  }
  if (result?.reason === 'login-required') {
    return {
      ...base,
      state: 'failed',
      error: '码道登录态已过期：请运行插件目录里的「码道登录.cmd」重新登录',
    };
  }
  if (result?.reason === 'network-error') {
    return {
      ...base,
      state: 'failed',
      error: `码道页面/接口不可达：${shortText(result?.error || '网络异常', 180)}`,
    };
  }
  return {
    ...base,
    state: 'failed',
    error: shortText(result?.error || '码道领取失败', 240),
  };
}

// ---------------------------------------------------------------- WorkBuddy（腾讯国内版）

const CN_INFO_FILE = /^workbuddy-desktop\.info$|^workbuddy-desktop\.\d{4}-.+\.info$/;
const WORKBUDDY_HELPER_JS =
  "process.stdout.write(String(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()))";

function asNonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stripScheme(value) {
  const text = asNonEmpty(value);
  return text ? text.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') : undefined;
}

function expandHomePath(value) {
  return String(value).replace(/^~(?=$|[\\/])/, homedir());
}

function workbuddyAuthDirs() {
  const home = homedir();
  const dirs = [];
  const override = process.env.WB_AUTH_DIR;
  if (override) dirs.push(expandHomePath(override));
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  dirs.push(join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
  dirs.push(join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
  dirs.push(join(home, '.workbuddy', 'auth'));
  return [...new Set(dirs)];
}

function parseWorkBuddyCredentials(path) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { error: '凭据文件不是合法 JSON（重新登录 WorkBuddy 可重建）' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { error: '凭据文件结构无法识别' };
  }
  const auth = doc.auth && typeof doc.auth === 'object' ? doc.auth : {};
  const account = doc.account && typeof doc.account === 'object' ? doc.account : {};
  const uid = asNonEmpty(account.uid);
  if (!uid) return { error: '缺少 account.uid' };
  if (auth.accessToken === undefined || auth.accessToken === null) {
    return { error: '缺少 auth.accessToken' };
  }
  return {
    uid,
    domain: stripScheme(auth.domain) || stripScheme(account.domain?.domain),
    token: auth.accessToken,
    nickname: account.nickname,
    path,
  };
}

function discoverWorkBuddyCredentials() {
  const accounts = [];
  const seenUid = new Set();
  const sources = [];
  for (const dir of workbuddyAuthDirs()) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const files = names.filter((name) => CN_INFO_FILE.test(name)).sort().reverse();
    if (files.length === 0) continue;
    sources.push(dir);
    let usable = 0;
    for (const name of files) {
      const path = join(dir, name);
      try {
        if (!statSync(path).isFile()) continue;
      } catch {
        continue;
      }
      const raw = parseWorkBuddyCredentials(path);
      if (raw.error) continue;
      if (seenUid.has(raw.uid)) continue;
      seenUid.add(raw.uid);
      accounts.push(raw);
      usable += 1;
    }
    if (usable > 0) break;
  }
  return { accounts, sources };
}

function parseEnvelopeValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.$wbEncrypted !== 1 || typeof value.envelope !== 'string') return undefined;
  let inner;
  try {
    inner = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return undefined;
  if (inner.suite !== 1) return { unsupportedSuite: inner.suite };
  const decode = (b64, length) => {
    if (typeof b64 !== 'string' || b64 === '') return undefined;
    let buffer;
    try {
      buffer = Buffer.from(b64, 'base64');
    } catch {
      return undefined;
    }
    if (buffer.length === 0) return undefined;
    if (length !== undefined && buffer.length !== length) return undefined;
    return buffer;
  };
  const nonce = decode(inner.nonce, 12);
  const authTag = decode(inner.authTag, 16);
  const ciphertext = decode(inner.ciphertext);
  if (!nonce || !authTag || !ciphertext) return undefined;
  if (typeof inner.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(inner.keyId)) return undefined;
  return { suite: inner.suite, keyId: inner.keyId, nonce, authTag, ciphertext };
}

function lengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

function buildWorkBuddyAad(keyId, suite) {
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

function openWorkBuddyEnvelope(envelope, keyState, what) {
  if (envelope.unsupportedSuite !== undefined) {
    throw new Error(`${what} 使用了尚未支持的加密格式（suite ${envelope.unsupportedSuite}）`);
  }
  if (envelope.keyId !== keyState.keyId) {
    throw new Error(`${what} 的加密密钥与本机 WorkBuddy 不匹配（可能是重装前的旧备份），请在 WorkBuddy 重新登录`);
  }
  const decipher = createDecipheriv('aes-256-gcm', keyState.key, envelope.nonce, { authTagLength: 16 });
  decipher.setAAD(buildWorkBuddyAad(envelope.keyId, envelope.suite));
  decipher.setAuthTag(envelope.authTag);
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
}

function isWorkBuddyLayout(exe) {
  try {
    if (!existsSync(exe)) return false;
    const root = dirname(exe);
    if (!existsSync(join(root, 'resources', 'app.asar'))) return false;
    const versionFile = join(root, 'version');
    if (!existsSync(versionFile)) return false;
    return /^\d+\.\d+\.\d+/.test(readFileSync(versionFile, 'utf8').trim());
  } catch {
    return false;
  }
}

let workbuddyElectronCache;
function resolveWorkBuddyElectron() {
  if (workbuddyElectronCache) return workbuddyElectronCache;
  const override = process.env.WORKBUDDY_EXE || process.env.WORKBUDDY_ELECTRON_BIN;
  if (override) {
    const path = expandHomePath(override);
    if (!existsSync(path)) throw new Error(`WORKBUDDY_EXE 指向的文件不存在：${path}`);
    workbuddyElectronCache = path;
    return path;
  }
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const candidates = [join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')];
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const root = process.env[key];
    if (root) candidates.push(join(root, 'WorkBuddy', 'WorkBuddy.exe'));
  }
  for (const candidate of candidates) {
    if (isWorkBuddyLayout(candidate)) {
      workbuddyElectronCache = candidate;
      return candidate;
    }
  }
  throw new Error('未找到本机 WorkBuddy 客户端（可设置 WORKBUDDY_EXE 指向 WorkBuddy.exe）');
}

function readWorkBuddyAtRestPayload(exe) {
  return new Promise((resolve, reject) => {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (/^(NODE_|ELECTRON_|WORKBUDDY_)/i.test(key)) continue;
      env[key] = value;
    }
    env.ELECTRON_RUN_AS_NODE = '1';
    execFile(
      exe,
      ['-e', WORKBUDDY_HELPER_JS],
      { timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env },
      (error, stdout) => {
        if (error) {
          reject(new Error(`无法从 WorkBuddy 客户端读取解密密钥（${error.killed ? '超时' : `退出码 ${error.code ?? '未知'}`}）`));
          return;
        }
        const text = String(stdout ?? '').trim();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          reject(new Error('WorkBuddy 客户端返回的解密密钥不是合法 JSON'));
          return;
        }
        const secret = payload?.atRestSecretKey;
        if (payload?.version !== 1 || typeof secret !== 'string' || secret === '') {
          reject(new Error('WorkBuddy 客户端返回的解密密钥结构不符合预期'));
          return;
        }
        let decoded;
        try {
          decoded = Buffer.from(secret, 'base64');
        } catch {
          decoded = undefined;
        }
        if (!decoded || decoded.length !== 32) {
          reject(new Error('WorkBuddy 客户端返回的解密密钥长度不符合预期'));
          return;
        }
        resolve(secret);
      },
    );
  });
}

let workbuddyKeyCache;
let workbuddyKeyPromise;
async function workbuddyProtectorKey() {
  if (workbuddyKeyCache) return workbuddyKeyCache;
  if (!workbuddyKeyPromise) {
    workbuddyKeyPromise = (async () => {
      const exe = resolveWorkBuddyElectron();
      const secret = await readWorkBuddyAtRestPayload(exe);
      const key = createHash('sha256').update(secret, 'utf8').digest();
      const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
      workbuddyKeyCache = { key, keyId, exe };
      return workbuddyKeyCache;
    })().finally(() => {
      workbuddyKeyPromise = undefined;
    });
  }
  return workbuddyKeyPromise;
}

function hostFromWorkBuddyToken(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return undefined;
    const segment = parts[1];
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
    const data = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
    for (const field of ['iss', 'domain', 'aud']) {
      const raw = data?.[field];
      for (const item of Array.isArray(raw) ? raw : [raw]) {
        if (typeof item !== 'string' || !item.includes('://')) continue;
        try {
          const host = new URL(item).hostname;
          if (host) return host;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

async function loadWorkBuddyAccounts() {
  const discovered = discoverWorkBuddyCredentials();
  if (discovered.accounts.length === 0) {
    return { accounts: [], sources: discovered.sources };
  }
  const needsKey = discovered.accounts.some(
    (raw) => typeof raw.token !== 'string' && parseEnvelopeValue(raw.token) !== undefined,
  );
  let keyState;
  let keyError;
  if (needsKey) {
    try {
      keyState = await workbuddyProtectorKey();
    } catch (error) {
      keyError = error;
    }
  }
  const accounts = [];
  for (const raw of discovered.accounts) {
    const entry = { uid: raw.uid, nickname: undefined, host: undefined, token: undefined, error: undefined };
    try {
      let token;
      if (typeof raw.token === 'string') {
        token = raw.token;
      } else {
        const envelope = parseEnvelopeValue(raw.token);
        if (!envelope) throw new Error('登录态 accessToken 格式无法识别');
        if (!keyState) throw keyError ?? new Error('需要 WorkBuddy 客户端解密登录态，但客户端不可用');
        token = openWorkBuddyEnvelope(envelope, keyState, 'accessToken');
      }
      entry.token = token;
      const nicknameEnvelope = parseEnvelopeValue(raw.nickname);
      if (typeof raw.nickname === 'string' && raw.nickname) entry.nickname = raw.nickname;
      else if (nicknameEnvelope && keyState) {
        try {
          entry.nickname = openWorkBuddyEnvelope(nicknameEnvelope, keyState, 'nickname');
        } catch {
          /* ignore */
        }
      }
      entry.host = raw.domain || hostFromWorkBuddyToken(token) || 'www.codebuddy.cn';
    } catch (error) {
      entry.error = shortText(error?.message || error, 160);
    }
    accounts.push(entry);
  }
  return { accounts, sources: discovered.sources };
}

function workbuddyHeaders(account) {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${account.token}`,
    'x-user-id': account.uid,
    'x-domain': account.host,
  };
}

async function workbuddyStatus(account) {
  const { status, payload } = await httpJson(
    `https://${account.host}/v2/billing/meter/checkin-activity-status`,
    { method: 'POST', headers: workbuddyHeaders(account), body: '{}' },
  );
  if (status === 401) throw new Error('WorkBuddy 登录态被拒绝（HTTP 401），请重新登录 WorkBuddy');
  if (status !== 200) throw new Error(`WorkBuddy 状态查询失败：HTTP ${status}`);
  if (payload && typeof payload === 'object' && payload.code !== undefined && payload.code !== 0) {
    throw new Error(`WorkBuddy 状态查询返回错误：${payload.msg || `code ${payload.code}`}`);
  }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
  return {
    active: Boolean(data.active),
    todayCheckedIn: Boolean(data.today_checked_in),
    streakDays: Number(data.streak_days) || 0,
    totalCredits: data.total_credits === undefined ? undefined : Number(data.total_credits),
  };
}

async function workbuddyClaim(account) {
  const { status, payload } = await httpJson(`https://${account.host}/v2/billing/meter/daily-checkin`, {
    method: 'POST',
    headers: workbuddyHeaders(account),
    body: '{}',
  });
  const message = String(payload?.msg ?? payload?.message ?? '');
  if (status === 200 && (payload?.code === undefined || payload?.code === 0)) {
    if (/已签到|already/i.test(message)) return { state: 'already' };
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
    const credit = [data.credit, payload?.credit].find((value) => typeof value === 'number');
    return { state: 'signed', credit };
  }
  if (status === 400 && /已签到|already/i.test(message)) return { state: 'already' };
  throw new Error(`WorkBuddy 领取失败：HTTP ${status}${message ? `（${message}）` : ''}`);
}

/** 返回一个或多个账号结果行；启动时自动领取。 */
async function runWorkBuddy() {
  const at = new Date().toISOString();
  let loaded;
  try {
    loaded = await loadWorkBuddyAccounts();
  } catch (error) {
    return [{ uid: 'workbuddy', nickname: 'WorkBuddy', at, state: 'failed', error: shortText(error?.message || error) }];
  }
  if (loaded.accounts.length === 0) {
    return [
      {
        uid: 'workbuddy',
        nickname: 'WorkBuddy',
        at,
        state: 'failed',
        error: '找不到 WorkBuddy 国内版登录态（请先登录 WorkBuddy 桌面端）',
      },
    ];
  }
  const rows = [];
  for (const account of loaded.accounts) {
    const row = { uid: account.uid, nickname: account.nickname ? `WorkBuddy（${account.nickname}）` : 'WorkBuddy', at };
    if (account.error) {
      rows.push({ ...row, state: 'failed', error: account.error });
      continue;
    }
    try {
      const status = await workbuddyStatus(account);
      if (!status.active) {
        rows.push({ ...row, state: 'already', detail: '当前没有进行中的签到活动（正常）' });
        continue;
      }
      if (status.todayCheckedIn) {
        rows.push({
          ...row,
          state: 'already',
          streakDays: status.streakDays,
          totalCredits: status.totalCredits,
          detail: `今天已签到（连续 ${status.streakDays} 天${
            status.totalCredits === undefined ? '' : `，累计 ${status.totalCredits} 积分`
          }）`,
        });
        continue;
      }
      const claimed = await workbuddyClaim(account);
      if (claimed.state === 'already') {
        rows.push({ ...row, state: 'already', detail: '今天已签到' });
      } else {
        rows.push({
          ...row,
          state: 'signed',
          credit: claimed.credit,
          detail: `签到成功${claimed.credit === undefined ? '' : ` +${claimed.credit} 积分`}`,
        });
      }
    } catch (error) {
      rows.push({ ...row, state: 'failed', error: shortText(error?.message || error) });
    }
  }
  return rows;
}

// ---------------------------------------------------------------- 状态持久化 / 运行

async function load() {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    if (typeof parsed.day !== 'string' || !Array.isArray(parsed.results)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function save(saved) {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(saved), { mode: 384 });
  await rename(temporary, path);
  return saved;
}

function statusOf(saved) {
  if (!saved || saved.results.length === 0) return 'none';
  if (saved.results.every((row) => row.state !== 'failed')) return 'ok';
  return saved.results.some((row) => row.state !== 'failed') ? 'warn' : 'error';
}

async function run({ notice = true } = {}) {
  const results = [];
  const tasks = [
    [runWorkBuddy, 'workbuddy'],
    [runLingxi, 'lingxi'],
    [runQoder, 'qoder'],
    [runMinimax, 'minimax'],
    [runCodearts, 'codearts'],
  ];
  for (const [task, uid] of tasks) {
    try {
      const produced = await task();
      if (Array.isArray(produced)) results.push(...produced);
      else if (produced) results.push(produced);
    } catch (error) {
      results.push({
        uid,
        nickname: TITLE[uid] ?? uid,
        state: 'failed',
        at: new Date().toISOString(),
        error: shortText(error?.message || error),
      });
    }
  }
  const ok = results.filter((row) => row.state !== 'failed').length;
  const failed = results.length - ok;
  const saved = {
    day: today(),
    checkedAt: new Date().toISOString(),
    results,
    ...(notice
      ? {
          notice:
            failed > 0
              ? `每日签到 ${ok}/${results.length} 成功，失败项可在面板中重试`
              : `已完成今日签到（${ok}/${results.length}）`,
        }
      : {}),
  };
  return save(saved);
}

/** 同一时间只允许一次签到运行（DSH 启动、面板打开、手动重试可能并发触发）。 */
let inFlightRun;
function runOnce(options) {
  if (!inFlightRun) {
    inFlightRun = run(options).finally(() => {
      inFlightRun = undefined;
    });
  }
  return inFlightRun;
}

/** 跨天后第一次打开面板自动补签当天。 */
async function ensureToday() {
  const saved = await load();
  return saved?.day === today() ? saved : runOnce({ notice: false });
}

/** 把 notice 交给第一个读者后清除（避免每次重开面板都弹提示）。 */
async function claimNotice() {
  const saved = await load();
  if (!saved?.notice) return saved;
  const latest = await load();
  if (!latest) return saved;
  if (latest.day !== saved.day) return latest;
  if (!latest.notice) return latest;
  const { notice: _notice, ...withoutNotice } = latest;
  try {
    await save(withoutNotice);
  } catch {
    /* ignore */
  }
  return latest;
}

/**
 * 跨天自动补签：DSH 长期开着时，每小时看一眼日期是否变了，变了就跑一轮。
 * 只用文件里的日期判断，不额外调用接口；同一天最多触发一次（失败可手动重试）。
 */
const DAILY_TIMER_MS = 60 * 60 * 1000;
let timerDay;
function startDailyTimer({ intervalMs = DAILY_TIMER_MS, runner = runOnce } = {}) {
  const timer = setInterval(() => {
    const day = today();
    if (timerDay === day) return;
    load()
      .then((saved) => {
        if (saved?.day === day || timerDay === day) {
          timerDay = day;
          return;
        }
        timerDay = day;
        void runner({ notice: false }).catch(() => {});
      })
      .catch(() => {});
  }, intervalMs);
  // 不要因为这个定时器让 DSH 无法退出。
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------- Web 接口 / 挂载

function localHost(value) {
  if (typeof value !== 'string') return false;
  return (
    value === 'localhost' ||
    value.startsWith('localhost:') ||
    value === '127.0.0.1' ||
    value.startsWith('127.0.0.1:') ||
    value === '[::1]' ||
    value.startsWith('[::1]:')
  );
}

function trusted(req) {
  if (!localHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return localHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function respond(res, saved) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify(
      saved
        ? { ...saved, status: statusOf(saved) }
        : { status: 'none', results: [] },
    ),
  );
}

export function apply(ctx) {
  const startup = runOnce().catch((error) => {
    ctx.logger.warn?.(error);
  });
  ctx.logger.info?.('[daily-checkin] 启动签到已排队（WorkBuddy / 灵犀 / Qoder / MiniMax / 码道）');

  // DSH 长期开着时也能每天自动签：日期一变就跑一轮（不需要重启 DSH）。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => startDailyTimer(), 'dsh-daily-checkin: daily timer');
  } else {
    startDailyTimer();
  }

  ctx.inject(['webServer'], (webCtx) =>
    webCtx.effect(() => {
      const disposeStatus = webCtx.webServer.register({
        kind: 'exact',
        path: '/daily-checkin/status',
        handler: async (req, res) => {
          if (!trusted(req)) {
            res.writeHead(403);
            res.end();
            return;
          }
          if (req.method === 'GET') {
            // 启动签到可能包含码道无头浏览器（最长约 1 分钟），面板请求等不起这么久：
            // 只等 12 秒，没跑完就先返回上一次结果；跨天补签放到后台继续。
            const finished = await Promise.race([startup.then(() => true), sleep(12000).then(() => false)]);
            if (!finished) {
              const saved = await load();
              if (!saved || saved.day !== today()) void runOnce({ notice: false }).catch(() => {});
              respond(res, saved);
              return;
            }
            await ensureToday();
            respond(res, await claimNotice());
            return;
          }
          if (req.method === 'POST') {
            await startup;
            respond(res, await runOnce({ notice: false }));
            return;
          }
          res.writeHead(405, { allow: 'GET, POST' });
          res.end();
        },
      });
      return () => {
        disposeStatus();
      };
    }, 'dsh-daily-checkin: status'),
  );
}

/** 仅供本地自测/排障使用（DSH 加载插件时忽略多余导出）。 */
export const internals =
  process.env.DSH_DAILY_CHECKIN_DEBUG === '1'
    ? { run, runCodearts, runCodeartsBrowser, runMinimax, startDailyTimer }
    : undefined;
