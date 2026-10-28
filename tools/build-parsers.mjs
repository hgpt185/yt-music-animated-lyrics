// Pin and bundle the same MIT parsers used by Better Lyrics. Development only.
import { mkdtemp, writeFile, readFile, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'ytmal-parsers-'));
try {
  let lock;
  try { lock = await readFile(join(root,'vendor/parsers.package-lock.json'),'utf8'); } catch {}
  if (lock) {
    await writeFile(join(scratch,'package-lock.json'),lock);
    await writeFile(join(scratch,'package.json'),JSON.stringify({ private:true, dependencies:JSON.parse(lock).packages[''].dependencies }));
    execFileSync('npm', ['ci','--prefix',scratch,'--ignore-scripts','--no-audit','--no-fund','--cache',join(tmpdir(),'ytmal-npm-cache')], {stdio:'inherit'});
  } else {
    execFileSync('npm', ['install', '--prefix', scratch, '--ignore-scripts', '--no-audit', '--no-fund',
      '--save-exact', '--cache', join(tmpdir(), 'ytmal-npm-cache'), '@braccato/parsers@0.4.0', 'fast-xml-parser@5.11.2', 'esbuild@0.25.12'], { stdio: 'inherit' });
  }
  const entry = join(scratch, 'entry.js');
  await writeFile(entry, 'export {parseTTMLContent,parseLRC,parseQRC} from "@braccato/parsers";\n');
  execFileSync(join(scratch,'node_modules/.bin/esbuild'), [entry, '--bundle', '--minify', '--format=iife',
    '--global-name=YtmalParsers', '--target=chrome120', '--platform=browser',
    '--banner:js=/*! @braccato/parsers 0.4.0 and dependencies; see parsers.LICENSE.txt. */',
    `--outfile=${join(root,'vendor/parsers.min.js')}`], { stdio:'inherit' });
  // Preserve the actual installed dependency versions/integrities for rebuilding.
  await copyFile(join(scratch,'package-lock.json'),join(root,'vendor/parsers.package-lock.json'));
  const bundled = ['@braccato/parsers','fast-xml-parser','@nodable/entities','fast-xml-builder','path-expression-matcher','strnum','xml-naming','is-unsafe','anynum'];
  const notices = [];
  for (const name of bundled) {
    const dir = join(scratch,'node_modules',name);
    let files; try { files = await readdir(dir); } catch { continue; }
    const pkg = JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
    const license = files.find(file=>/^licen[cs]e(?:\.|$)/i.test(file));
    let licenseText;
    if (license) licenseText = await readFile(join(dir,license),'utf8');
    else if (name === '@nodable/entities') {
      const response = await fetch('https://raw.githubusercontent.com/nodable/val-parsers/main/LICENSE');
      if (!response.ok) throw new Error('Cannot read entities upstream license');
      licenseText = await response.text();
      if (!licenseText.includes('MIT License')) throw new Error('Unexpected entities license');
    } else throw new Error(`Missing bundled license: ${name}`);
    notices.push(`${name} ${pkg.version}\n${licenseText}`);
  }
  await writeFile(join(root,'vendor/parsers.LICENSE.txt'),notices.join('\n\n--------------------\n\n'));
  await writeFile(join(root,'vendor/parsers.README.md'),'# Lyrics parsers\n\n@braccato/parsers 0.4.0 (MIT), the TTML/enhanced-LRC/QRC parsers used by Better Lyrics. Bundled locally for the extension service worker. No remote code. See parsers.LICENSE.txt and parsers.package-lock.json for bundled licenses and exact dependencies.\n\nRebuild: `node tools/build-parsers.mjs` (Node 22+). Upstream: https://github.com/better-lyrics/braccato\n');
} finally { await rm(scratch,{recursive:true,force:true}); }
