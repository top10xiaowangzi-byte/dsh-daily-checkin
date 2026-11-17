/**
 * codearts-claim.mjs —— 码道 CodeArts「活动福利 → 每日签到」自动领取（插件日常调用）。
 *
 * 流程：
 *   1) 无头启动浏览器，注入登录快照（storageState，含 SSO 票据）→ 打开 chat/home；
 *      华为云 SSO 会用票据自动续上登录态；
 *   2) 在页面内调 PromptCenterService 接口：活动列表 → 待领取则 claim + confirm；
 *   3) 把刷新后的登录快照原子写回，供下次使用。
 *
 * 输出：stdout 一行 JSON：
 *   {"ok":true,"state":"signed","credit":100,"nickname":"...","detail":"领取成功 +100 积分"}
 *   {"ok":true,"state":"already",...}
 *   {"ok":false,"reason":"login-required"}          没有登录快照 / 快照过期（运行「码道登录.cmd」）
 *   {"ok":false,"reason":"network-error"}           页面/接口不可达
 *   {"ok":false,"reason":"error","error":"..."}
 */

import { emit, homeUrl, launch, saveState, seedCookies, stateStatus, timeoutFromEnv, waitForLogin } from './codearts-browser-common.mjs';

const LOGIN_TIMEOUT_MS = timeoutFromEnv(process.env.CODEARTS_LOGIN_TIMEOUT_MS, 45_000, 10_000, 120_000);
const STATUS_TEXT = {
  ELIGIBLE: '待领取',
  CLAIMED: '已领取',
  CONFIRMED: '已到账',
  CONSUMED: '已使用',
  ENTRY: '待登录',
};
const CLAIMED_STATUS = new Set(['CLAIMED', 'CONFIRMED', 'CONSUMED']);
const DAILY_TYPES = ['USER_LOGIN', 'DAILY_CLAIM', 'LOGIN'];

// 没有登录快照就快速失败，不用白等浏览器启动
const snapshot = stateStatus();
if (snapshot.status !== 'ok') {
  emit({
    ok: false,
    reason: 'login-required',
    snapshot: snapshot.status,
    error: snapshot.status === 'corrupt' ? '登录快照损坏' : '还没有码道登录态',
  });
  setTimeout(() => process.exit(2), 50);
} else {
  await runClaim();
}

async function runClaim() {
  let context;
  let exitCode = 0;
  try {
    const launched = await launch({ headless: true, navigate: false });
    context = launched.context;
    const seeded = await seedCookies(context);
    const navigationError = await launched.page
      .goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .then(() => '')
      .catch((error) => String(error?.message || error));

    if (!(await waitForLogin(launched.page, LOGIN_TIMEOUT_MS, { earlyLoginPageCheck: true }))) {
      const finalUrl = launched.page.url();
      const unreachable = Boolean(navigationError) || !finalUrl.startsWith('https://') || finalUrl === 'about:blank';
      emit({
        ok: false,
        reason: unreachable ? 'network-error' : 'login-required',
        seeded,
        error: navigationError || `页面停留在 ${finalUrl}`,
        playwright: launched.playwright,
      });
      exitCode = unreachable ? 1 : 2;
      return;
    }

    const result = await launched.page.evaluate(
      async ({ dailyTypes, statusText, claimedStatus }) => {
        const claimed = new Set(claimedStatus);
        const request = async (method, pathname, body) => {
          let response;
          try {
            response = await fetch(pathname, {
              method,
              credentials: 'include',
              signal: AbortSignal.timeout(20_000),
              headers: {
                Accept: 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                'x-requested-with': 'XMLHttpRequest',
                'x-codearts-doer-scenario-type': 'web',
                'X-Language': 'zh-cn',
                'Agent-Type': 'PromptCenter',
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            });
          } catch (error) {
            return { status: 0, json: { error: `请求失败：${String(error?.message || error)}` } };
          }
          const text = await response.text().catch(() => '');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = { raw: text.slice(0, 200) };
          }
          return { status: response.status, json };
        };

        const me = await request('GET', '/chat/rest/me');
        if (me.status !== 200 || !me.json || typeof me.json.domainName !== 'string') {
          return { ok: false, reason: 'login-required' };
        }
        const nickname = `码道 CodeArts（${me.json.domainName}）`;
        const delivery = await request('GET', '/chat/PromptCenterService/v1/ops/delivery?channel=WEB');
        const items = delivery?.json?.data?.items;
        if (delivery.status !== 200 || !Array.isArray(items)) {
          return {
            ok: false,
            reason: 'error',
            error: `活动列表返回异常（HTTP ${delivery.status}${delivery?.json?.message ? `，${delivery.json.message}` : ''}）`,
          };
        }
        if (Number(delivery?.json?.code) !== 0) {
          return { ok: false, reason: 'error', error: `活动列表业务错误：${delivery?.json?.message || delivery?.json?.code}` };
        }
        const daily =
          items.find((item) => dailyTypes.includes(String(item?.type ?? '').toUpperCase())) ??
          items.find((item) => /每日签到/.test(String(item?.title ?? '')));
        if (!daily) return { ok: true, state: 'already', nickname, detail: '当前没有每日签到活动（正常）' };

        const amount = Number(daily.benefitAmount);
        const credit = Number.isFinite(amount) ? amount : undefined;
        const creditText = credit === undefined ? '' : ` +${credit} 积分`;
        const status = String(daily.status ?? '').toUpperCase();
        if (!(daily.claimable === true || status === 'ELIGIBLE')) {
          if (claimed.has(status)) {
            return {
              ok: true,
              state: 'already',
              nickname,
              credit,
              detail: `今天已领取${creditText}（${statusText[status] || status}）`,
            };
          }
          return {
            ok: false,
            reason: 'error',
            error: `每日签到活动状态异常：${status || '未知'}（可能活动规则已变更）`,
          };
        }

        const campaignId = daily.campaignId ?? daily.id;
        if (campaignId === undefined || campaignId === null || campaignId === '') {
          return { ok: false, reason: 'error', error: '每日签到活动缺少 campaignId，无法领取' };
        }
        const claim = await request('POST', '/chat/PromptCenterService/v1/ops/claim', {
          campaignId,
          idempotentKey: `claim_${campaignId}_${Date.now()}`,
          channel: 'WEB',
        });
        const code = Number(claim.json?.code);
        if (claim.status === 200 && (code === 0 || code === 200)) {
          const confirm = await request('POST', '/chat/PromptCenterService/v1/ops/confirm', { campaignId });
          const confirmOk = confirm.status === 200 && [0, 200].includes(Number(confirm.json?.code));
          return {
            ok: true,
            state: 'signed',
            nickname,
            credit,
            detail: `领取成功${creditText}${confirmOk ? '' : '（到账确认失败，稍后请在活动页复核）'}`,
          };
        }
        if (code === 40001) {
          return {
            ok: true,
            state: 'already',
            nickname,
            credit,
            detail: `今天已领取（${claim.json?.message || '尚未到刷新时间'}）`,
          };
        }
        return {
          ok: false,
          reason: 'error',
          error: `领取失败：${claim.json?.message || claim.json?.error || `HTTP ${claim.status}`}`,
        };
      },
      { dailyTypes: DAILY_TYPES, statusText: STATUS_TEXT, claimedStatus: [...CLAIMED_STATUS] },
    );

    if (result.ok) {
      const saved = await saveState(context);
      if (!saved.ok) result.detail = `${result.detail || ''}（登录快照保存失败：${String(saved.error).slice(0, 80)}）`;
    }
    emit({ ...result, seeded, playwright: launched.playwright });
    if (!result.ok && result.reason === 'login-required') exitCode = 2;
    else if (!result.ok) exitCode = 1;
  } catch (error) {
    emit({ ok: false, reason: 'error', error: String(error?.message || error) });
    exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
  }
  setTimeout(() => process.exit(exitCode), 50);
}
