'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCredentialStore,
  protectWithDpapi,
  unprotectWithDpapi,
} = require('../src/credential-store');

function withTempStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-store-'));
  const filePath = path.join(dir, 'credentials.json');
  const protect = (secret) => Buffer.from(`protected:${secret}`, 'utf8').toString('base64');
  const unprotect = (ciphertext) => {
    if (ciphertext === 'not-base64') throw new Error('invalid ciphertext');
    return Buffer.from(ciphertext, 'base64').toString('utf8').replace(/^protected:/, '');
  };
  try {
    return run(createCredentialStore({ filePath, protect, unprotect }), filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('credential store persists only protected text and masked metadata', () => {
  withTempStore((store, filePath) => {
    const metadata = store.set('api:record-1', 'sk-secret-1234');
    const disk = fs.readFileSync(filePath, 'utf8');

    assert.doesNotMatch(disk, /sk-secret-1234/);
    assert.equal(metadata.masked, '••••1234');
    assert.equal(store.get('api:record-1'), 'sk-secret-1234');
    assert.deepEqual(store.list().map((item) => item.alias), ['api:record-1']);
  });
});

test('credential store replaces and explicitly removes a credential', () => {
  withTempStore((store) => {
    store.set('api:record-1', 'first-1111');
    store.set('api:record-1', 'second-2222');
    assert.equal(store.get('api:record-1'), 'second-2222');
    assert.equal(store.metadata('api:record-1').masked, '••••2222');
    assert.equal(store.remove('api:record-1'), true);
    assert.equal(store.get('api:record-1'), null);
    assert.equal(store.remove('api:record-1'), false);
  });
});

test('credential store rejects unsafe aliases and corrupt ciphertext', () => {
  withTempStore((store, filePath) => {
    assert.throws(() => store.set('../escape', 'secret'), /凭据别名/);
    store.set('safe.alias', 'secret-9999');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.credentials['safe.alias'].ciphertext = 'not-base64';
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
    assert.throws(() => store.get('safe.alias'), /无法解密/);
  });
});

test('Windows DPAPI adapter round-trips without returning plaintext ciphertext', { skip: process.platform !== 'win32' }, () => {
  const secret = `dpapi-${Date.now()}-AbCd`;
  const ciphertext = protectWithDpapi(secret);
  assert.notEqual(ciphertext, secret);
  assert.doesNotMatch(ciphertext, new RegExp(secret));
  assert.equal(unprotectWithDpapi(ciphertext), secret);
});
