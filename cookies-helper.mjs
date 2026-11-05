/**
 * cookies-helper.mjs —— 由 DSH daily-checkin 插件调用的 Cookie 读取助手。
 *
 * 插件宿主（Electron 主进程）若不能直接 import('node:sqlite')，就用 DSH 自带的
 * Node（已知支持 node:sqlite）以子进程方式运行本文件：
 *   stdin  : {"dbPath": "...", "keyBase64": "...", "names": [...], "hostFilter": {"suffix": "...", "includes": "..."}}
 *   stdout : {"ok": true, "cookies": [{"name": "...", "value": "...", "host": "..."}]} 或 {"ok": false, "error": "..."}
 *
 * 只读：先复制一份 Cookie 数据库到临时位置再打开，绝不修改原文件。
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

function decryptChromiumValue(key, encryptedValue) {
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
    if ([...head].some((byte) => byte < 0x20 || byte > 0x7e)) plain = plain.subarray(32);
  }
  return plain.toString('utf8');
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    emit({ ok: false, error: 'bad input json' });
    return;
  }
  const key = Buffer.from(String(payload.keyBase64 || ''), 'base64');
  if (key.length !== 32) {
    emit({ ok: false, error: `bad key length ${key.length}` });
    return;
  }
  const dbPath = String(payload.dbPath || '');
  const names = Array.isArray(payload.names) ? payload.names : undefined;
  const filter = payload.hostFilter && typeof payload.hostFilter === 'object' ? payload.hostFilter : undefined;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (error) {
    emit({ ok: false, error: `node:sqlite unavailable: ${error?.message || error}` });
    return;
  }
  const directories = [...new Set([tmpdir(), dirname(dbPath), homedir()].filter(Boolean))];
  let lastError = '';
  for (const directory of directories) {
    const temp = join(
      directory,
      `.dsh-cookie-helper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      writeFileSync(temp, readFileSync(dbPath));
    } catch (error) {
      lastError = String(error?.message || error);
      continue;
    }
    try {
      let db;
      try {
        db = new DatabaseSync(temp, { readOnly: true });
      } catch {
        db = new DatabaseSync(temp);
      }
      const cookies = [];
      try {
        const statement = db.prepare('SELECT host_key, name, encrypted_value, value FROM cookies');
        for (const row of statement.all()) {
          const host = String(row.host_key ?? '');
          const cookieName = String(row.name ?? '');
          if (names && !names.includes(cookieName)) continue;
          if (filter) {
            const matchSuffix =
              typeof filter.suffix === 'string' && filter.suffix ? host.endsWith(filter.suffix) : false;
            const matchIncludes =
              typeof filter.includes === 'string' && filter.includes ? host.includes(filter.includes) : false;
            if (!matchSuffix && !matchIncludes) continue;
          }
          const plainValue = typeof row.value === 'string' ? row.value : '';
          let value = plainValue;
          if (!value && row.encrypted_value) {
            try {
              value = decryptChromiumValue(key, row.encrypted_value);
            } catch {
              continue;
            }
          }
          if (!value || !/^[\x20-\x7e]+$/.test(value)) continue;
          cookies.push({ name: cookieName, value, host });
        }
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      emit({ ok: true, cookies });
      return;
    } catch (error) {
      lastError = String(error?.message || error);
    } finally {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  emit({ ok: false, error: lastError || 'unknown error' });
}

main().catch((error) => {
  emit({ ok: false, error: String(error?.message || error) });
});
