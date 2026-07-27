'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runPowerShell(script) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || 'PowerShell failed').trim());
  }
  return result.stdout.trim();
}

test('MultiPost account service task stays running without battery or 72-hour limits', () => {
  const scriptsDir = path.resolve(__dirname, '..', 'scripts');
  const sourcePath = path.join(scriptsDir, 'install-multipost-account-server.ps1');
  const taskName = `CodexTestMultiPostAccountServer_${process.pid}`;
  const testInstaller = path.join(scriptsDir, `.test-install-multipost-${process.pid}.ps1`);
  const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(
      "$taskName = 'FeishuMultiPostAccountServer'",
      `$taskName = '${taskName}'`,
    )
    .replace(
      /\$action = New-ScheduledTaskAction[^\r\n]+/,
      "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -Command \"Start-Sleep -Seconds 30\"'",
    );

  fs.writeFileSync(testInstaller, source, 'utf8');
  try {
    const install = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', testInstaller,
    ], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const state = JSON.parse(runPowerShell(`
      $task = Get-ScheduledTask -TaskName '${taskName}'
      [pscustomobject]@{
        State = [string]$task.State
        ExecutionTimeLimit = [string]$task.Settings.ExecutionTimeLimit
        DisallowStartIfOnBatteries = [bool]$task.Settings.DisallowStartIfOnBatteries
        StopIfGoingOnBatteries = [bool]$task.Settings.StopIfGoingOnBatteries
      } | ConvertTo-Json -Compress
    `));

    assert.equal(state.ExecutionTimeLimit, 'PT0S');
    assert.equal(state.DisallowStartIfOnBatteries, false);
    assert.equal(state.StopIfGoingOnBatteries, false);
    assert.equal(state.State, 'Running');
  } finally {
    runPowerShell(`
      Stop-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue
    `);
    fs.rmSync(testInstaller, { force: true });
  }
});
