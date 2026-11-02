/** Real bundled pnpm, offline tarballs, CLI bins and pre-existing YAML metadata.
 * Called outside the target volume so the controller can survive a drive-letter change.
 * This is an isolated test project; never pass a user project as --root.
 */
import {cpSync,mkdirSync,readFileSync,writeFileSync,existsSync,lstatSync,readdirSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const args=process.argv.slice(2),arg=n=>args.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const root=resolve(arg('root')),primary=resolve(arg('primary'));
const source=resolve(import.meta.dirname,'../runtime/pnpm-portable.mjs');
const phase=arg('phase')||'initial',owner=join(root,'.portable-test-owner.json');
if(phase==='initial'){
 assert.ok(!existsSync(root),'A new test-only directory is required');mkdirSync(root,{recursive:true});
 writeFileSync(owner,JSON.stringify({test:'pnpm-portability-v1',initialRoot:root,runs:0}));
 cpSync(primary,join(root,'runtime'),{recursive:true});
 cpSync(source,join(root,'runtime/pnpm/bin/pnpm.mjs'));
 if(!existsSync(join(root,'runtime/pnpm/dist/node_modules/yaml'))){
  const yaml=arg('yaml');assert.ok(yaml,'Pass --yaml=PATH for a legacy primary runtime');
  cpSync(resolve(yaml),join(root,'runtime/pnpm/dist/node_modules/yaml'),{recursive:true});
 }
 mkdirSync(join(root,'profile/vendor'),{recursive:true});
 writeFileSync(join(root,'profile/package.json'),JSON.stringify({name:'portable-profile-proof',private:true}));
 for(const [name,version] of [['portable-cli-one','1.0.0'],['portable-cli-two','1.0.0']]){
  const base=join(root,'profile/vendor',name);mkdirSync(join(base,'package'),{recursive:true});
  writeFileSync(join(base,'package/package.json'),JSON.stringify({name,version,main:'index.js',bin:{[name]:'cli.js'}}));
  writeFileSync(join(base,'package/index.js'),'module.exports='+JSON.stringify(name)+';\n');
  writeFileSync(join(base,'package/cli.js'),'#!/usr/bin/env node\nconsole.log('+JSON.stringify(name)+'+":ok");\n');
  // Windows tar uses the active code page for arguments on some clean hosts.
  // Keep its arguments ASCII; the Unicode working directory is passed natively.
  const tar=spawnSync('tar.exe',['-czf','../'+name+'.tgz','package'],{cwd:base,encoding:'utf8',windowsHide:true});assert.equal(tar.status,0,tar.stderr);
 }
}
const record=JSON.parse(readFileSync(owner));assert.equal(record.test,'pnpm-portability-v1');
const node=join(root,'runtime/node/bin/node.exe'),wrapper=join(root,'runtime/pnpm/bin/pnpm.mjs'),profile=join(root,'profile');
const yaml=createRequire(import.meta.url)(join(root,'runtime/pnpm/dist/node_modules/yaml'));
const home=join(root,'home');mkdirSync(home,{recursive:true});
for(const n of ['npmrc','npmrc-global'])writeFileSync(join(home,n),'');
const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:home,LOCALAPPDATA:home,TEMP:home,TMP:home,PNPM_HOME:join(home,'pnpm'),npm_config_userconfig:join(home,'npmrc'),npm_config_globalconfig:join(home,'npmrc-global'),npm_config_manage_package_manager_versions:'false',PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS:'false',NO_UPDATE_NOTIFIER:'1',CI:'true'};
delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.NODE_PATH;
function run(params){const r=spawnSync(node,[wrapper,...params],{cwd:profile,env,encoding:'utf8',windowsHide:true,timeout:90000});assert.equal(r.status,0,(r.stdout||'')+'\n'+(r.stderr||r.error?.message||''));return r.stdout;}
function requirePkg(name){const r=spawnSync(node,['-p','require('+JSON.stringify(name)+')'],{cwd:profile,env,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),name);}
if(phase==='initial')run(['add','./vendor/portable-cli-one.tgz','--offline','--ignore-scripts','--reporter=append-only']);
else{
 assert.notEqual(record.previousRoot,root,'Move the test directory or change its drive letter before this phase');
 run(['--registry','https://registry.npmjs.org/','install','--offline','--frozen-lockfile','--ignore-scripts','--reporter=append-only']);
}
requirePkg('portable-cli-one');
if(phase==='initial'&&args.includes('--real-plugin')) {
 run(['add','dsh-pet@0.4.0','--ignore-scripts','--config.auto-install-peers=false','--registry=https://registry.npmjs.org/','--reporter=append-only']);
 record.realPlugin=true;
}
if(record.realPlugin){
 assert.equal(JSON.parse(readFileSync(join(profile,'node_modules/dsh-pet/package.json'))).version,'0.4.0');
 assert.ok(lstatSync(join(profile,'node_modules/dsh-pet/lib/standalone.js')).isFile());
}
run(['add','./vendor/portable-cli-two.tgz','--offline','--ignore-scripts','--reporter=append-only']);requirePkg('portable-cli-two');
run(['remove','portable-cli-two','--reporter=append-only']);
run(['install','--offline','--frozen-lockfile','--ignore-scripts','--reporter=append-only']);
const modules=join(profile,'node_modules/.modules.yaml');let metadata=yaml.parse(readFileSync(modules,'utf8'));
assert.equal(metadata.nodeLinker,'hoisted');
assert.ok(relative(join(profile,'.dsh-cache/pnpm/store'),metadata.storeDir).startsWith('v11'));
if(record.previousRoot)assert.ok(!JSON.stringify(metadata).toLowerCase().includes(record.previousRoot.toLowerCase()));
const shim=join(profile,'node_modules/.bin/portable-cli-one.cmd');
const cli=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c','""'+shim+'""'],{cwd:profile,env:{...env,PATH:dirname(node)+';'+env.PATH},encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true});
assert.equal(cli.status,0,cli.stderr);assert.equal(cli.stdout.trim(),'portable-cli-one:ok');
let links=0;function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const f=join(dir,e.name);if(lstatSync(f).isSymbolicLink())links++;else if(e.isDirectory())walk(f);}}walk(profile);assert.equal(links,0);
// Exercise the representation produced by 1.3.2's desktop repair on the next move.
writeFileSync(modules,yaml.stringify(metadata));
record.runs++;record.previousRoot=root;writeFileSync(owner,JSON.stringify(record));
console.log(JSON.stringify({phase,root,drive:root.slice(0,2),runs:record.runs,pnpmInstall:true,addRemove:true,bin:true,noLinks:true,legacyYamlOnNextMove:true,realPluginInstalled:!!record.realPlugin}));
