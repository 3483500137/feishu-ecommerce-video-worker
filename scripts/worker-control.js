'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOG_PATH = path.join(PROJECT_ROOT, 'logs', 'worker-control.log');
const WORKER_TASK_NAME = 'FeishuEcommerceVideoWorker';

function log(message) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function run(file, args, options = {}) {
  return spawnSync(file, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function scheduledTaskState() {
  const result = run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `(Get-ScheduledTask -TaskName '${WORKER_TASK_NAME}').State`,
  ]);
  if (result.status !== 0) {
    throw new Error(`读取计划任务状态失败：${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

function enableScheduledTask() {
  const command = `Enable-ScheduledTask -TaskName '${WORKER_TASK_NAME}' | Out-Null`;
  const result = run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ]);
  if (result.status !== 0) {
    throw new Error(`切换计划任务失败：${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
}

function main() {
  const state = scheduledTaskState();
  // 平台发布的工作状态属于发布业务开关，不能停掉同一进程内的人设、
  // 中转站和 LTX 生成任务。生成 worker 必须始终可被表格触发；平台发布
  // 自身由发布记录的“确认发布/发布状态”字段控制。
  if (state === 'Disabled') {
    enableScheduledTask();
    log(`已启用 ${WORKER_TASK_NAME}，平台发布暂停不会阻断视频生成任务`);
  }
}

try {
  main();
  process.exit(0);
} catch (error) {
  log(`控制器失败：${error.message}`);
  process.exit(1);
}
