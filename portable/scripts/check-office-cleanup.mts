/** A single conversion/render regression, including real cleanup and no-clobber behavior. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AclSandbox, workspaceWriteSid, tempWriteSid } from '../../upstream/packages/sandbox/sandbox-windows-acl/src/index.ts'
import { work } from './environment.mjs'
import assert from 'node:assert/strict'
const root = mkdtempSync(join(work, 'qa/office-cleanup-')), temp = join(root, 'temp'), workspace = join(root, 'workspace')
mkdirSync(temp); mkdirSync(workspace)
mkdirSync(join(workspace,'images'))
mkdirSync(join(workspace,'existing-files'));writeFileSync(join(workspace,'existing-files','keep.txt'),'user content')
const kit = join(work, 'upstream/apps/desktop/.desktop-build/targets/win-x64/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js')
const input = join(work, 'upstream/scripts/fixtures/office-render/color-blocks.docx')
const script = join(workspace, 'probe.mjs')
writeFileSync(script, `import {createConverter} from ${JSON.stringify(pathToFileURL(kit).href)};
import fs from 'node:fs';
const report = {};
function error(e) { return {name:e.name, message:e.message, code:e.code, path:e.path, errors:e.errors?.map(error), cause:e.cause && error(e.cause)}; }
const converter = await createConverter({timeoutMs:60000});
try {
try { report.convert=await converter.render({inputPath:${JSON.stringify(input)},outputPath:'${'OUTPUT'}'}); } catch(e){report.convertError=error(e)}
try { report.images=await converter.renderImages({inputPath:${JSON.stringify(input)},outputDir:${JSON.stringify(join(workspace, 'images'))},pages:[1]}); } catch(e){report.imagesError=error(e)}
try { await converter.renderImages({inputPath:${JSON.stringify(input)},outputDir:${JSON.stringify(join(workspace,'existing-files'))},pages:[1]}); report.collisionRejected=false } catch(e) { report.collisionRejected=e.code==='EEXIST' }
} finally {await converter.dispose()}
report.residue=fs.readdirSync(process.env.TEMP);
console.log(JSON.stringify(report,null,2));
`.replace("'OUTPUT'", JSON.stringify(join(workspace, 'converted.pdf'))))
const previousTemp = process.env.TEMP, previousTmp = process.env.TMP
process.env.TEMP = temp; process.env.TMP = temp
const sandbox = new AclSandbox({ writableDirs:[workspace], tempDir:temp, writeSid:workspaceWriteSid(workspace), tempWriteSid:tempWriteSid(temp), mode:'workspace-write' })
try {
  await sandbox.init()
  const result = await sandbox.spawn({command:process.execPath,args:[script],cwd:workspace}).wait()
  const report = {exitCode:result.exitCode,stdout:result.stdout.toString(),stderr:result.stderr.toString()}
  writeFileSync(join(work,'qa/office-cleanup-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
  assert.equal(result.exitCode,0)
  const data=JSON.parse(report.stdout)
  assert.equal(data.convertError,undefined);assert.equal(data.imagesError,undefined);assert.equal(data.collisionRejected,true)
  assert.equal(readFileSync(join(workspace,'existing-files/keep.txt'),'utf8'),'user content')
  assert.equal(data.residue.some((name:string)=>name.startsWith('libreoffice-kit-')),false)
  assert.ok(data.images.images.every((image:{path:string})=>image.path.startsWith(join(workspace,'images'))))
} finally {
  sandbox.dispose()
  if(previousTemp===undefined)delete process.env.TEMP;else process.env.TEMP=previousTemp
  if(previousTmp===undefined)delete process.env.TMP;else process.env.TMP=previousTmp
  const part=relative(join(work,'qa'),root);assert.ok(part&&!part.startsWith('..')&&!isAbsolute(part));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})
}
