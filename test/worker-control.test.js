'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('hidden launcher runs PowerShell scripts through wscript without showing a console', () => {
  const launcher = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'run-worker-hidden.vbs'),
    'utf8',
  );

  assert.match(launcher, /WScript\.Shell/);
  assert.match(launcher, /powershell\.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File/);
  assert.match(launcher, /shell\.Run\(cmd,\s*0,\s*True\)/);
  assert.match(launcher, /WScript\.Arguments\(0\)/);
});

test('worker control script keeps the generation worker independent from Feishu 工作状态', () => {
  const controller = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'worker-control.js'),
    'utf8',
  );

  assert.match(controller, /FeishuEcommerceVideoWorker/);
  assert.match(controller, /平台发布/);
  assert.match(controller, /Enable-ScheduledTask/);
  assert.doesNotMatch(controller, /Disable-ScheduledTask/);
  assert.match(controller, /worker-control\.log/);
});

test('PowerShell control wrapper only launches the Node controller', () => {
  const wrapper = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'run-worker-control.ps1'),
    'utf8',
  );

  assert.match(wrapper, /worker-control\.js/);
  assert.match(wrapper, /Start-Process/);
  assert.doesNotMatch(wrapper, /Disable-ScheduledTask/);
  assert.doesNotMatch(wrapper, /Enable-ScheduledTask/);
});

test('scheduled task installer uses the hidden launcher for worker and controller tasks', () => {
  const installer = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'install-scheduled-task.ps1'),
    'utf8',
  );

  assert.match(installer, /FeishuEcommerceVideoWorkerController/);
  assert.match(installer, /run-worker-hidden\.vbs/);
  assert.match(installer, /run-worker-control\.ps1/);
  assert.match(installer, /wscript\.exe/);
  assert.doesNotMatch(installer, /New-ScheduledTaskAction -Execute 'powershell\.exe'/);
});
