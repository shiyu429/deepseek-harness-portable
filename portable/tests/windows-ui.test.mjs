import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
const project=resolve(import.meta.dirname,'..'),native=join(project,'native'),icon=join(project,'build/app.ico');
test('Windows maintenance windows stay centered and bounded, with a DPI-sized hand cursor and scrollable compact layout',{skip:process.platform!=='win32'},t=>{
 if(!existsSync(icon)){t.skip('Build the native launcher icon before running the Windows UI check');return;}
 const base=mkdtempSync(join(tmpdir(),'dsh-ui-'));
 try{
  mkdirSync(join(base,'app'));writeFileSync(join(base,'app/portable.json'),JSON.stringify({portableVersion:'layout-test'}));
  const exe=join(base,'ui.exe'),report=join(base,'layout');
  const refs=['System.Web.Extensions','System.Windows.Forms','System.Core','System.Drawing','System.IO.Compression','System.IO.Compression.FileSystem'];
  execFileSync(join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/utf8output','/target:exe','/platform:x64','/main:UiRegression',...refs.map(n=>'/reference:'+n+'.dll'),'/win32manifest:'+join(native,'native-helper.manifest'),'/win32icon:'+icon,'/out:'+exe,...['Launcher.cs','StartupWindow.cs','MaintenanceEngine.cs','MaintenanceForm.cs','EmbeddedIcon.cs','UiKit.cs','WindowsPaths.cs'].map(n=>join(native,n)),join(import.meta.dirname,'UiLayout.cs')],{windowsHide:true});
  try{execFileSync(exe,[base,report],{windowsHide:true,timeout:45000});}catch(error){throw new Error(error.stdout?.toString()||error.message);}
  const result=JSON.parse(readFileSync(report+'.json','utf8'));
  assert.equal(result.syntheticLayouts,20);assert.equal(result.handCursorWidth,result.expectedCursorWidth);
 }finally{const part=relative(tmpdir(),base);assert.ok(part&&!part.startsWith('..')&&!isAbsolute(part));rmSync(base,{recursive:true,force:true});}
});
