'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertAlias(alias) {
  const value = String(alias || '').trim();
  if (!ALIAS_PATTERN.test(value)) throw new Error('本机凭据别名只能包含字母、数字、点、下划线、冒号和连字符');
  return value;
}

function maskSecret(secret) {
  const value = String(secret || '').trim();
  return `••••${value.slice(-4)}`;
}

function runDpapi(script, input, action) {
  if (process.platform !== 'win32') throw new Error(`Windows DPAPI ${action}仅支持 Windows`);
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || !String(result.stdout || '').trim()) {
    throw new Error(`Windows DPAPI ${action}失败`);
  }
  return String(result.stdout).trim();
}

function protectWithDpapi(secret) {
  const value = String(secret || '').trim();
  if (!value) throw new Error('API密钥不能为空');
  return runDpapi([
    '$plain = [Console]::In.ReadToEnd()',
    '$secure = ConvertTo-SecureString $plain -AsPlainText -Force',
    'ConvertFrom-SecureString $secure',
  ].join('; '), value, '加密');
}

function unprotectWithDpapi(ciphertext) {
  const value = String(ciphertext || '').trim();
  if (!value) throw new Error('DPAPI密文为空');
  return runDpapi([
    '$cipher = [Console]::In.ReadToEnd().Trim()',
    '$secure = ConvertTo-SecureString $cipher',
    '$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }',
  ].join('; '), value, '解密');
}

function createCredentialStore({
  filePath,
  protect = protectWithDpapi,
  unprotect = unprotectWithDpapi,
  now = () => new Date(),
} = {}) {
  const target = path.resolve(String(filePath || ''));
  if (!filePath) throw new Error('凭据库缺少 filePath');

  function readData() {
    if (!fs.existsSync(target)) return { version: 1, credentials: {} };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      throw new Error('本机凭据库文件损坏');
    }
    if (parsed?.version !== 1 || !parsed.credentials || typeof parsed.credentials !== 'object') {
      throw new Error('本机凭据库格式无效');
    }
    return parsed;
  }

  function writeData(data) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, target);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      fs.rmSync(target, { force: true });
      fs.renameSync(temp, target);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  function publicMetadata(alias, entry) {
    if (!entry) return null;
    return {
      alias,
      masked: `••••${String(entry.suffix || '')}`,
      updatedAt: entry.updatedAt,
    };
  }

  return {
    set(alias, secret) {
      const key = assertAlias(alias);
      const value = String(secret || '').trim();
      if (!value) throw new Error('API密钥不能为空');
      const data = readData();
      data.credentials[key] = {
        ciphertext: protect(value),
        suffix: value.slice(-4),
        updatedAt: now().toISOString(),
      };
      writeData(data);
      return publicMetadata(key, data.credentials[key]);
    },

    get(alias) {
      const key = assertAlias(alias);
      const entry = readData().credentials[key];
      if (!entry) return null;
      try {
        return unprotect(entry.ciphertext);
      } catch {
        throw new Error(`本机凭据 ${key} 无法解密，请重新导入`);
      }
    },

    remove(alias) {
      const key = assertAlias(alias);
      const data = readData();
      if (!data.credentials[key]) return false;
      delete data.credentials[key];
      writeData(data);
      return true;
    },

    metadata(alias) {
      const key = assertAlias(alias);
      return publicMetadata(key, readData().credentials[key]);
    },

    list() {
      const data = readData();
      return Object.keys(data.credentials)
        .sort()
        .map((alias) => publicMetadata(alias, data.credentials[alias]));
    },
  };
}

module.exports = {
  createCredentialStore,
  maskSecret,
  protectWithDpapi,
  unprotectWithDpapi,
};

