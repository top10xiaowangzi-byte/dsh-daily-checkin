/**
 * codearts-login.mjs —— 码道 CodeArts 人工登录助手（有头浏览器，登录一次即可）。
 *
 *   node codearts-login.mjs            打开浏览器 → 人工登录 → 保存登录快照 → 自动关闭
 *   node codearts-login.mjs --headless 无头自检（诊断用，检查当前登录快照是否还有效）
 *
 * 产物：
 *   - Playwright 持久化 profile（默认 $DSH_HOME/codearts-profile）
 *   - 登录快照 storageState（默认 $DSH_HOME/codearts-session.json，含 SSO 票据，用于日常自动续期）
 *
 * 输出一行 JSON：
 *   {"ok":true,"loggedIn":true,"profile":"...","state":"..."}
 *   {"ok":false,"reason":"login-required"}
 *   {"ok":false,"reason":"save-error","error":"..."}
 *   {"ok":false,"reason":"error","error":"..."}
 */

import { emit, homeUrl, launch, profileDir, saveState, seedCookies, statePath, timeoutFromEnv, waitForLogin } from './codearts-browser-common.mjs';

const headless = process.argv.includes('--headless');
const timeoutMs = timeoutFromEnv(process.env.CODEARTS_LOGIN_TIMEOUT_MS, headless ? 60_000 : 10 * 60_000, 10_000, 30 * 60_000);

if (!headless) {
  console.log('============================================');
  console.log('  码道 CodeArts 登录助手');
  console.log('  即将打开浏览器，请用华为云账号登录一次；');
  console.log('  检测到登录成功后窗口会自动关闭。');
  console.log('  登录态保存在本机，之后每天自动领取积分。');
  console.log('============================================');
  console.log('');
}

let context;
let exitCode = 0;
try {
  const launched = await launch({ headless, navigate: false });
  context = launched.context;
  await seedCookies(context);
  await launched.page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
  if (await waitForLogin(launched.page, timeoutMs)) {
    await launched.page.waitForTimeout(1500);
    const saved = await saveState(context);
    if (!saved.ok) {
      emit({ ok: false, reason: 'save-error', error: `登录快照保存失败：${saved.error}`, profile: profileDir });
      exitCode = 1;
      if (!headless) console.log(`\n[失败] 登录快照保存失败：${saved.error}`);
    } else {
      emit({ ok: true, loggedIn: true, profile: profileDir, state: statePath, playwright: launched.playwright });
      if (!headless) console.log(`\n[成功] 码道登录态已保存：${statePath}`);
    }
  } else {
    emit({ ok: false, reason: 'login-required', profile: profileDir });
    exitCode = 2;
    if (!headless) console.log('\n[未完成] 没有检测到登录成功，请重新运行本脚本再登录一次。');
  }
} catch (error) {
  emit({ ok: false, reason: 'error', error: String(error?.message || error) });
  exitCode = 1;
  console.log(`\n[失败] ${error?.message || error}`);
} finally {
  await context?.close().catch(() => {});
}
setTimeout(() => process.exit(exitCode), 50);
