/** Apply narrow, version-checked Windows cleanup and empty-render-directory fixes. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export async function patchOfficeRuntime(runtime) {
  const packageRoot = join(runtime, 'node_modules/@deepseek-ai/libreoffice-kit');
  const pkg = JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
  if (pkg.version !== '0.1.5') throw new Error('Review the Office portable patches before updating the upstream kit');
  const descriptorFile = join(runtime,'desktop-runtime.json');
  const descriptor = JSON.parse(await readFile(descriptorFile,'utf8'));
  for (const name of ['index.js','cli.js']) {
    const relative = 'node_modules/@deepseek-ai/libreoffice-kit/lib/' + name;
    const file = join(runtime,relative);
    let text = await readFile(file,'utf8');
    if (!text.includes('// DSH_PORTABLE_OFFICE_V1')) {
      const replace = (before, after) => {
        if (!text.includes(before)) throw new Error('Office patch no longer matches: ' + name);
        text = text.replace(before,after);
      };
      replace('open, readFile, rm, stat, symlink, unlink, writeFile }', 'open, readFile, readdir, rename, rm, rmdir, stat, symlink, unlink, writeFile }');
      replace('let owned = false;\n\t\tlet succeeded = false;', 'let owned = false;\n\t\tlet succeeded = false;\n\t\tconst finalOutputDir = request.outputDir;\n\t\tlet reuseEmptyDirectory = false; // DSH_PORTABLE_OFFICE_V1');
      replace('await mkdir(request.outputDir, { mode: 448 });\n\t\t\towned = true;', `try {
\t\t\t\tawait mkdir(request.outputDir, { mode: 448 });
\t\t\t} catch (error) {
\t\t\t\tif (error.code !== "EEXIST") throw error;
\t\t\t\tconst status = await lstat(request.outputDir);
\t\t\t\tif (!status.isDirectory() || status.isSymbolicLink() || (await readdir(request.outputDir)).length !== 0) throw error;
\t\t\t\treuseEmptyDirectory = true;
\t\t\t\trequest = { ...request, outputDir: await mkdtemp(join(dirname(finalOutputDir), ".dsh-render-")) };
\t\t\t}
\t\t\towned = true;`);
      replace('await writeFile(join(request.outputDir, "manifest.json"),', `if (reuseEmptyDirectory) images = { ...images, images: images.images.map(image => ({ ...image, path: join(finalOutputDir, relative(request.outputDir, image.path)) })) };
\t\t\tawait writeFile(join(request.outputDir, "manifest.json"),`);
      replace('succeeded = true;\n\t\t\treturn images;', `if (reuseEmptyDirectory) {
\t\t\t\t// rmdir refuses a concurrent user's file; rename never replaces a nonempty directory.
\t\t\t\tawait rmdir(finalOutputDir);
\t\t\t\tawait rename(request.outputDir, finalOutputDir);
\t\t\t}
\t\t\tsucceeded = true;
\t\t\treturn images;`);
      // Font/virus scanners may release their file handles shortly after native exit.
      // Bounded retries still report a persistent cleanup failure.
      text = text.replaceAll('rm(scratch, {\n\t\t\t\t\trecursive: true,\n\t\t\t\t\tforce: true', 'rm(scratch, {\n\t\t\t\t\trecursive: true,\n\t\t\t\t\tmaxRetries: 10, retryDelay: 100,\n\t\t\t\t\tforce: true');
      await writeFile(file,text);
    }
    const bytes = await readFile(file), entry = descriptor.files.find(item=>item.path===relative);
    if (!entry) throw new Error('Office file is absent from runtime inventory');
    entry.bytes = bytes.length; entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(descriptorFile,JSON.stringify(descriptor,null,2)+'\n');
}
