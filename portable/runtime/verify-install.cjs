'use strict';
/** Verify shipped program files; mutable data and backups are intentionally outside the manifest. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createInterface } = require('node:readline/promises');
const core = require('./core.cjs');
const program = path.resolve(__dirname, '..', '..');
const input = createInterface({ input: process.stdin, output: process.stdout });
void (async () => {
  try {
    const { root } = require('./program-guard.cjs').inspect(program);
    const inventory = core.readJson(path.join(root, 'app', 'checksums.json')) ?? core.readJson(path.join(root, 'checksums.json'));
    if (!inventory || inventory.format !== 1 || !Array.isArray(inventory.files)) throw new Error('程序包校验清单缺失或损坏。');
    console.log('正在校验程序和运行环境，请稍候…');
    const remaining = inventory.files.values();
    let checked = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (const file of remaining) {
        const target = path.resolve(root, file.path);
        if (!core.inside(root, target) || file.path.startsWith('data/')) throw new Error('校验清单路径无效。');
        const info = await fs.promises.lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) throw new Error('文件缺失或已变化：' + file.path);
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
        if (hash.digest('hex') !== file.sha256) throw new Error('文件校验失败：' + file.path);
        checked++;
      }
    }));
    console.log(`校验通过：${checked} 个程序文件。聊天、设置和工作文件未参与此项校验。`);
  } catch (error) { console.error('校验未通过：' + error.message); process.exitCode = 1; }
  finally {
    if (process.stdin.isTTY) await input.question('按回车关闭…');
    input.close();
  }
})();
