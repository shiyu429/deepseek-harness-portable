import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,relative,isAbsolute} from 'node:path';
const project=resolve(import.meta.dirname,'..');
test('legacy Windows extraction rejects the reported path; compact paths and explicit extended I/O work without a system change',{skip:process.platform!=='win32'},t=>{
 const base=mkdtempSync(join(tmpdir(),'dsh-lp-'));
 try{
  if(base.length>60){t.skip('A short temporary parent is needed for the legacy MAX_PATH boundary');return;}
  const root=join(base,'x'.repeat(63-base.length));assert.equal(root.length,64);mkdirSync(root);
  const exe=join(base,'legacy.exe');
  execFileSync(join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/utf8output','/target:exe','/platform:x64','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll','/out:'+exe,join(import.meta.dirname,'LegacyZip.cs'),join(project,'native/WindowsPaths.cs')],{windowsHide:true});
  const run=(args)=>spawnSync(exe,args,{encoding:'utf8',windowsHide:true});
  const old='app/1.3.0-2a2e094635340127/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/program/share/config/soffice.cfg/modules/simpress/popupmenu/pagepanecanvasmaster.xml';
  const first=join(base,'old.zip');assert.equal(run(['fixture',first,old]).status,0);
  const failed=run([first,root]);assert.notEqual(failed.status,0);assert.match(failed.stderr,/Legacy CreateFile:.*length=260/);
  const compact=old.replace('1.3.0-2a2e094635340127','bin'),second=join(base,'compact.zip');assert.equal(run(['fixture',second,compact]).status,0);
  const passed=run([second,root]);assert.equal(passed.status,0,passed.stderr);assert.equal(readFileSync(join(root,compact),'utf8'),'fixture resource');
  const deep=join(root,'long'.repeat(28),'more'.repeat(28),'read-write.bin');assert.ok(deep.length>300);
  const extended=run(['extended',deep]);assert.equal(extended.status,0,extended.stderr);assert.deepEqual(readFileSync(deep),Buffer.from([42]));
 }finally{const part=relative(tmpdir(),base);assert.ok(part&&!part.startsWith('..')&&!isAbsolute(part));rmSync(base,{recursive:true,force:true});}
});
