import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishStatic, unpublishStatic, PublishError } from '../src/deploy/publish.js'

// The publish step is the security boundary of the static runtime: what it
// copies is what the harbor gate serves to the internet.

function site(files) {
  const root = mkdtempSync(join(tmpdir(), 'skeppa-publish-'))
  const work = join(root, 'source')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(work, path, '..'), { recursive: true })
    writeFileSync(join(work, path), content)
  }
  return { root, work, target: join(root, 'public') }
}

// A directory link works everywhere: on Windows a junction needs no privilege
// and is reported as a symlink, like the real thing. A file link needs a
// privilege dev machines rarely have there, so that one case is best-effort.
const linkDir = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
function tryLinkFile(target, path) {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch {
    return false
  }
}

const tree = dir => readdirSync(dir, { recursive: true }).map(p => String(p).replaceAll('\\', '/')).sort()

test('publishes the build output as a snapshot and reports what it copied', () => {
  const { work, target } = site({ 'dist/index.html': '<h1>hi</h1>', 'dist/assets/app.js': 'x=1', 'src/main.js': 'source' })
  const result = publishStatic({ workDir: work, publishDir: 'dist', target })
  expect(result).toMatchObject({ files: 2, bytes: 14, symlinks: 0, hidden: 0, hasIndex: true })
  expect(tree(target)).toEqual(['assets', 'assets/app.js', 'index.html'])
  expect(readFileSync(join(target, 'index.html'), 'utf8')).toBe('<h1>hi</h1>')
})

test('dot-entries stay out — a publish directory of the repo root must not serve .git or .env', () => {
  const { work, target } = site({
    'index.html': 'root', '.env': 'SECRET=1', '.git/config': '[core]', 'sub/.htpasswd': 'x',
    '.well-known/security.txt': 'Contact: me',
  })
  const result = publishStatic({ workDir: work, publishDir: '', target })
  expect(tree(target)).toEqual(['.well-known', '.well-known/security.txt', 'index.html', 'sub'])
  expect(result.hidden).toBe(3)
})

test('symlinks are never published, and a symlinked publish directory is refused outright', () => {
  const { work, target } = site({ 'dist/index.html': 'ok', 'secret/master.key': 'KEY' })
  linkDir(join(work, 'secret'), join(work, 'dist', 'leak'))
  const fileLinked = tryLinkFile(join(work, 'secret', 'master.key'), join(work, 'dist', 'key.txt'))

  const result = publishStatic({ workDir: work, publishDir: 'dist', target })
  expect(result.symlinks).toBe(fileLinked ? 2 : 1)
  expect(tree(target)).toEqual(['index.html']) // neither the linked directory nor anything under it

  // dist itself a link to somewhere else: nothing is copied at all
  linkDir(join(work, 'secret'), join(work, 'linked'))
  expect(() => publishStatic({ workDir: work, publishDir: 'linked', target })).toThrow(/symlink/)
  // ...and a link further up the path is caught too
  mkdirSync(join(work, 'secret', 'out'))
  expect(() => publishStatic({ workDir: work, publishDir: 'linked/out', target })).toThrow(/symlink/)
  expect(tree(target)).toEqual(['index.html']) // the published site is untouched
})

test('a missing publish directory fails with a message about the build, and keeps the old site', () => {
  const { work, target } = site({ 'dist/index.html': 'v1' })
  publishStatic({ workDir: work, publishDir: 'dist', target })
  expect(() => publishStatic({ workDir: work, publishDir: 'build', target })).toThrow(PublishError)
  expect(() => publishStatic({ workDir: work, publishDir: 'build', target })).toThrow(/did the build produce it/)
  expect(() => publishStatic({ workDir: work, publishDir: 'dist/index.html', target })).toThrow(/not a directory/)
  expect(readFileSync(join(target, 'index.html'), 'utf8')).toBe('v1')
})

test('a republish replaces the site whole: files the new build dropped are gone, nothing is left behind', () => {
  const { root, work, target } = site({ 'dist/index.html': 'v1', 'dist/old.js': 'gone soon' })
  publishStatic({ workDir: work, publishDir: 'dist', target })
  const second = site({ 'dist/index.html': 'v2', 'dist/new.js': 'fresh' })
  publishStatic({ workDir: second.work, publishDir: 'dist', target })
  expect(tree(target)).toEqual(['index.html', 'new.js'])
  expect(readFileSync(join(target, 'index.html'), 'utf8')).toBe('v2')
  expect(readdirSync(root).sort()).toEqual(['public', 'source']) // no .next / .old
})

test('a site without an index.html publishes, and says so', () => {
  const { work, target } = site({ 'dist/about.html': 'x' })
  expect(publishStatic({ workDir: work, publishDir: 'dist', target }).hasIndex).toBe(false)
})

test('unpublish removes the snapshot and any leftovers of a swap', () => {
  const { work, target } = site({ 'dist/index.html': 'x' })
  publishStatic({ workDir: work, publishDir: 'dist', target })
  mkdirSync(`${target}.next`)
  unpublishStatic(target)
  expect(existsSync(target)).toBe(false)
  expect(existsSync(`${target}.next`)).toBe(false)
})
