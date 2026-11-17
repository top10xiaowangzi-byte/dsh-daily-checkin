/**
 * codearts-browser-common.mjs —— 码道 CodeArts 浏览器助手公共函数。
 *
 * 登录态：
 *   1) Playwright 持久化 profile（默认 $DSH_HOME/codearts-profile）；会话 Cookie 关闭浏览器后会被清掉；
 *   2) storageState 快照（默认 $DSH_HOME/codearts-session.json）——登录时保存，含 SSO 票据（SSOTGC 等），
 *      之后每次领取先把它注入浏览器，华为云 SSO 会自动续上登录态，再把新快照写回。
 *
 * 安全：快照含登录 Cookie。写入用「临时文件 + rename」原子替换并尽量设 0600；
 *       Windows 上 POSIX 权限位基本不生效，实际依赖用户目录（%USERPROFILE%\.dsh）的 ACL。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
export const profileDir = process.env.CODEARTS_PROFILE_DIR || path.join(dshHome, 'codearts-profile');
export const statePath = process.env.CODEARTS_STATE_PATH || path.join(dshHome, 'codearts-session.json');
export const baseUrl = (process.env.CODEARTS_BASE_URL || 'https://devcloud.cn-north-4.huaweicloud.com').replace(/\/+$/, '');
export const homeUrl = `${baseUrl}/chat/home`;

export function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** 读取快照状态：ok / missing / corrupt。 */
export function stateStatus() {
  let text;
  try {
    text = fs.readFileSync(statePath, 'utf8');
  } catch {
    return { status: 'missing' };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.cookies) || parsed.cookies.length === 0) return { status: 'corrupt' };
    return { status: 'ok', state: parsed };
  } catch (error) {
    return { status: 'corrupt', error: String(error?.message || error) };
  }
}

export function readState() {
  const result = stateStatus();
  return result.status === 'ok' ? result.state : undefined;
}

/** 原子写入快照：临时文件(0600) → rename；失败时清理临时文件并返回错误。 */
export async function writeState(state) {
  const directory = path.dirname(statePath);
  const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600, encoding: 'utf8' });
    try {
      await chmod(temporary, 0o600);
    } catch {
      /* Windows 上可能不支持，忽略 */
    }
    await rename(temporary, statePath);
    try {
      await chmod(statePath, 0o600);
    } catch {
      /* ignore */
    }
    return { ok: true };
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      /* ignore */
    }
    return { ok: false, error: String(error?.message || error) };
  }
}

/** 把登录快照里的 Cookie 注入浏览器（session cookie 的 expires 为 -1，Playwright 支持）。 */
export async function seedCookies(context) {
  const state = readState();
  if (!state) return false;
  const cookies = state.cookies.filter((cookie) => cookie && typeof cookie.name === 'string' && cookie.domain);
  if (cookies.length === 0) return false;
  try {
    await context.addCookies(cookies);
    return true;
  } catch {
    // 个别坏 Cookie 可能导致整批失败：逐条注入，跳过失败的
    let seeded = false;
    for (const cookie of cookies) {
      try {
        await context.addCookies([cookie]);
        seeded = true;
      } catch {
        /* 跳过坏 Cookie */
      }
    }
    return seeded;
  }
}

/** 保存当前上下文快照（原子写）。返回 {ok,error}。 */
export async function saveState(context) {
  try {
    const state = await context.storageState();
    return await writeState(state);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function playwrightCandidates() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const list = [];
  const raw = process.env.PLAYWRIGHT_CORE_PATH;
  if (raw) {
    const resolved = path.resolve(raw);
    list.push(resolved, path.join(resolved, 'index.js'), path.join(resolved, 'playwright-core', 'index.js'));
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  list.push(
    path.join(appData, 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright-core', 'index.js'),
    path.join(appData, 'npm', 'node_modules', 'playwright-core', 'index.js'),
    path.join(appData, 'npm', 'node_modules', 'playwright', 'node_modules', 'playwright-core', 'index.js'),
    path.join(appData, 'npm', 'node_modules', 'playwright', 'index.js'),
    path.join(localAppData, 'pnpm', 'global', '5', 'node_modules', 'playwright-core', 'index.js'),
    path.join(scriptDir, 'node_modules', 'playwright-core', 'index.js'),
    path.join(scriptDir, 'node_modules', 'playwright', 'index.js'),
  );
  // nvm-windows：%APPDATA%\nvm\<版本>\node_modules\...
  try {
    for (const entry of fs.readdirSync(path.join(appData, 'nvm'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const base = path.join(appData, 'nvm', entry.name, 'node_modules');
      list.push(path.join(base, 'playwright-core', 'index.js'), path.join(base, 'playwright', 'index.js'));
    }
  } catch {
    /* 没有 nvm 目录 */
  }
  return [...new Set(list)].filter((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

export async function loadChromium() {
  let lastError = '';
  for (const file of playwrightCandidates()) {
    try {
      const module = await import(pathToFileURL(file).href);
      const candidate = module.default?.chromium ? module.default : module;
      if (candidate?.chromium?.launchPersistentContext) return { chromium: candidate.chromium, from: file };
    } catch (error) {
      lastError = String(error?.message || error);
    }
  }
  throw new Error(
    `找不到可用的 playwright-core：请先执行 npm i -g @playwright/cli（或 npm i -g playwright），并 npx playwright install chromium${
      lastError ? `（最后一次加载错误：${lastError.slice(0, 120)}）` : ''
    }`,
  );
}

export async function launch({ headless = true, navigate = true } = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  const { chromium, from } = await loadChromium();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  let navigationError = '';
  if (navigate) {
    navigationError = await page
      .goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      .then(() => '')
      .catch((error) => String(error?.message || error));
  }
  return { context, page, playwright: from, navigationError };
}

/** 用同源接口 /chat/rest/me 判断是否已登录（必须带 API 网关要求的请求头，否则拿到的是 SPA HTML）。 */
export async function pageLoggedIn(page) {
  try {
    return await page.evaluate(async () => {
      try {
        const response = await fetch('/chat/rest/me', {
          credentials: 'include',
          signal: AbortSignal.timeout(15_000),
          headers: {
            Accept: 'application/json',
            'x-requested-with': 'XMLHttpRequest',
            'x-codearts-doer-scenario-type': 'web',
            'Agent-Type': 'PromptCenter',
            'X-Language': 'zh-cn',
          },
        });
        if (response.status !== 200) return false;
        const data = await response.json().catch(() => null);
        return Boolean(data && typeof data.domainName === 'string');
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** 轮询等待登录态（注入 SSO 票据后通常几秒内完成）。 */
export async function waitForLogin(page, timeoutMs, { earlyLoginPageCheck = false } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  // 若浏览器已明确停在华为云登录页，说明快照没续上，早点失败，别让面板干等
  const probeAt = started + Math.min(15_000, Math.floor(timeoutMs / 2));
  while (Date.now() < deadline) {
    if (await pageLoggedIn(page)) return true;
    if (earlyLoginPageCheck && Date.now() > probeAt) {
      try {
        if (page.url().includes('authui/login')) return false;
      } catch {
        /* ignore */
      }
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

/** 解析毫秒超时环境变量，并夹在 [min, max] 区间。 */
export function timeoutFromEnv(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
