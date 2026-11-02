import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {project} from './environment.mjs';
export async function buildLauncher(iconSource) {
  const compiler=join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const build=join(project,'build'),native=join(project,'native');await mkdir(build,{recursive:true});
  execFileSync(compiler,['/nologo','/utf8output','/optimize+','/target:exe','/platform:x64','/define:ICON_TOOL','/out:'+join(build,'icon-tool.exe'),join(native,'EmbeddedIcon.cs'),join(native,'WindowsPaths.cs')],{windowsHide:true,stdio:'inherit'});
  execFileSync(join(build,'icon-tool.exe'),[iconSource,join(build,'app.ico')],{windowsHide:true,stdio:'inherit'});
  const references=['System.Web.Extensions','System.Windows.Forms','System.Core','System.Drawing','System.IO.Compression','System.IO.Compression.FileSystem'].map(name=>'/reference:'+name+'.dll');
  const output=join(build,'launcher.exe');
  execFileSync(compiler,['/nologo','/utf8output','/optimize+','/target:winexe','/platform:x64',...references,'/win32manifest:'+join(native,'native-helper.manifest'),'/win32icon:'+join(build,'app.ico'),'/out:'+output,...['Launcher.cs','StartupWindow.cs','MaintenanceEngine.cs','MaintenanceForm.cs','EmbeddedIcon.cs','UiKit.cs','WindowsPaths.cs'].map(file=>join(native,file))],{windowsHide:true,stdio:'inherit'});
  return output;
}
