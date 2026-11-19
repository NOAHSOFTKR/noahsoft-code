import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`Windows installer: isolated clone, Unicode launcher, PATH, update and guards (${shell})`, {skip: process.platform !== 'win32', timeout: 180000}, t => {
    if (spawnSync(shell, ['-NoProfile','-Command','exit 0']).error) {t.skip('Shell unavailable');return;}
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cvp-install-'));
    const remote=path.join(root,'remote');fs.mkdirSync(remote);
    const git=(...args)=>{const r=spawnSync('git',args,{cwd:remote,encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);};
    git('init','--initial-branch=main');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
    fs.writeFileSync(path.join(remote,'package.json'),JSON.stringify({name:'cvp-cli',version:'1.0.0',scripts:{build:'node build.cjs'}}));
    fs.writeFileSync(path.join(remote,'package-lock.json'),JSON.stringify({name:'cvp-cli',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'cvp-cli',version:'1.0.0'}}}));
    fs.writeFileSync(path.join(remote,'build.cjs'),`require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.js',"console.log('fixture-version');console.log(JSON.stringify(process.argv.slice(2)));if(process.env.CVP_ARG_FILE)require('fs').writeFileSync(process.env.CVP_ARG_FILE,JSON.stringify(process.argv.slice(2)))");`);
    git('add','.');git('commit','-m','fixture');
    const target=path.join(root,'설치 경로 % fixture');const bin=path.join(root,'명령 경로 % fixture');fs.mkdirSync(target);
    const script=path.join(root,'test.ps1');
    fs.writeFileSync(script,'\ufeff'+`
$ErrorActionPreference='Stop'
. $env:CVP_INSTALL_SCRIPT
$script:savedPath='C:\\fixture;'+$env:CVP_TEST_BIN.ToUpperInvariant()+';C:\\fixture'
$script:writes=0
function Get-CvpUserPath { $script:savedPath }
function Set-CvpUserPath([string]$Value) { $script:savedPath=$Value; $script:writes++ }
function Check([bool]$ok,[string]$message) { if (!$ok) { throw $message } }
function Install { Install-Cvp -TargetDirectory $env:CVP_TEST_TARGET -CommandDirectory $env:CVP_TEST_BIN -Remote $env:CVP_TEST_REMOTE -NoPrerequisites }
Install
Check ($script:savedPath.Split(';').Length -eq 2) 'PATH not deduplicated'
Check ($script:savedPath.StartsWith($env:CVP_TEST_BIN)) 'PATH not prepended'
Install
Check ($script:writes -eq 1) 'PATH changed on repeat'
Set-Content -LiteralPath (Join-Path $env:CVP_TEST_REMOTE 'update.txt') -Value 'updated'
& git -C $env:CVP_TEST_REMOTE add update.txt
& git -C $env:CVP_TEST_REMOTE commit -m update
Install
Check (Test-Path -LiteralPath (Join-Path $env:CVP_TEST_TARGET 'update.txt')) 'Fast forward missing'
$result=& (Join-Path $env:CVP_TEST_BIN 'cvp.cmd') 'space argument' '한글' '--flag'
Check ($LASTEXITCODE -eq 0) 'Launcher failed'
Check (($result -join '') -match 'space argument') 'Space argument lost'
Check (($result -join '') -match '--flag') 'Flag lost'
$other=Join-Path (Split-Path $env:CVP_TEST_TARGET) 'unmanaged'
New-Item -ItemType Directory -Path $other | Out-Null
Set-Content -LiteralPath (Join-Path $other 'keep.txt') -Value 'keep'
$rejected=$false
try { Install-Cvp -TargetDirectory $other -CommandDirectory $env:CVP_TEST_BIN -Remote $env:CVP_TEST_REMOTE -NoPrerequisites } catch { $rejected=$true }
Check $rejected 'Unmanaged directory accepted'
Check ((Get-Content -LiteralPath (Join-Path $other 'keep.txt')) -eq 'keep') 'Unmanaged file changed'
$shimPath=Join-Path $env:CVP_TEST_BIN 'cvp.cmd'
$shimBytes=[IO.File]::ReadAllBytes($shimPath)
Set-Content -LiteralPath $shimPath -Value 'unmanaged sentinel'
$rejected=$false
try { Install } catch { $rejected=$true }
Check $rejected 'Unmanaged launcher accepted'
Check ((Get-Content -LiteralPath $shimPath) -eq 'unmanaged sentinel') 'Unmanaged launcher overwritten'
[IO.File]::WriteAllBytes($shimPath,$shimBytes)
Set-Content -LiteralPath (Join-Path $env:CVP_TEST_TARGET 'package.json') -Value '{}'
$rejected=$false
try { Install } catch { $rejected=$true }
Check $rejected 'Dirty checkout accepted'
Write-Output 'INSTALLER_TEST_OK'
`);
    const r=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{env:{...process.env,CVP_INSTALL_SCRIPT:path.resolve('install.ps1'),CVP_TEST_TARGET:target,CVP_TEST_BIN:bin,CVP_TEST_REMOTE:remote},encoding:'utf8',timeout:170000});
    assert.equal(r.status,0,r.stdout+'\n'+r.stderr);assert.match(r.stdout,/INSTALLER_TEST_OK/);
    const argFile=path.join(root,'args.json');
    const rawArgs='--model "space argument" "a\\\"b" "$literal`x" "" "한글"';
    const cmd=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`""${path.join(bin,'cvp.cmd')}" ${rawArgs}"`],{env:{...process.env,CVP_ARG_FILE:argFile},encoding:'utf8',windowsVerbatimArguments:true});
    assert.equal(cmd.status,0,cmd.stdout+cmd.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(argFile,'utf8')),['--model','space argument','a"b','$literal`x','','한글']);

    // Only the isolated fixture created by this test is removed.
    fs.rmSync(root,{recursive:true,force:true});
  });
}
