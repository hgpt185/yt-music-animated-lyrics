// Rebuild the pinned MIT-licensed renderer used by Better Lyrics.
// Development only. Loading the unpacked extension does not need Node/npm.
import { mkdtemp, writeFile, readFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const version = '1.16.10';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'ytmal-renderer-'));
try {
  const metadata = await fetch(`https://registry.npmjs.org/@braccato/core/${version}`).then(r => {
    if (!r.ok) throw new Error(`Package metadata: ${r.status}`);
    return r.json();
  });
  const response = await fetch(metadata.dist.tarball);
  if (!response.ok) throw new Error(`Package archive: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  if (integrity !== metadata.dist.integrity) throw new Error('Package integrity mismatch');
  const tarball = join(scratch, 'core.tgz');
  await writeFile(tarball, archive);
  execFileSync('tar', ['-xzf', tarball, '-C', scratch]);
  const source = join(scratch, 'package/dist');
  const styles = (await Promise.all(['variables','image-highlights','lyrics','instrumental'].map(name =>
    readFile(join(source, `styles/${name}.css`), 'utf8')))).join('\n')
    .replaceAll(':root', ':host').replace(/^@import[^;]*;/gm, '');
  const entry = join(scratch, 'entry.js');
  await writeFile(entry, `export { createLyricsRenderer } from ${JSON.stringify(join(source, 'renderer.js'))};\nexport const styles = ${JSON.stringify(styles)};\n`);
  const vendor = join(root, 'vendor');
  await mkdir(vendor, { recursive:true });
  execFileSync('npm', ['exec', '--yes', '--cache', join(tmpdir(),'ytmal-npm-cache'), '--package', 'esbuild@0.25.12', '--',
    'esbuild', entry, '--bundle', '--minify', '--format=iife', '--global-name=YtmalRenderer', '--target=chrome120',
    '--banner:js=/*! @braccato/core 1.16.10 — Copyright (c) 2026 Boidushya Bhattacharya. MIT; see braccato.LICENSE.txt. */',
    `--outfile=${join(vendor,'braccato.min.js')}`], {stdio:'inherit'});
  await copyFile(join(scratch,'package/LICENSE'),join(vendor,'braccato.LICENSE.txt'));
  await writeFile(join(vendor,'braccato.README.md'), `# Braccato renderer\n\nPinned package: @braccato/core ${version} (MIT).\n\nUpstream: https://github.com/better-lyrics/braccato\nUsed by: https://github.com/better-lyrics/better-lyrics\n\nArchive integrity: \`${integrity}\`\n\nThe JavaScript engine is bundled without modification. Its CSS is included in the bundle, with :root changed to :host for our isolated lyrics panel and local CSS imports inlined. The extension's layout overrides live in content.js. No remote scripts or runtime package downloads are used.\n\nRebuild with Node 22+ and npm: \`node tools/build-renderer.mjs\`. No build is needed to load the extension unpacked.\n\nSee braccato.LICENSE.txt for the upstream license.\n`);
} finally {
  await rm(scratch,{recursive:true,force:true});
}
