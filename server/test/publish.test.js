import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishStatic, unpublishStatic, PublishError, findPublishCandidates, isHashedAsset } from '../src/deploy/publish.js'

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

// A page loaded before a deploy lazy-loads chunks by their old names. The
// previous build's hashed assets stay for exactly one more deploy; anything
// else the new build dropped is gone at once.
test('old hashed assets are kept for one more deploy, and only those', () => {
  const { root, target } = site({})
  const build = files => site(files).work
  publishStatic({ workDir: build({ 'dist/index.html': 'v1', 'dist/assets/index-AAAAAAA1.js': '1', 'dist/assets/logo.png': 'p', 'dist/old.html': 'x' }), publishDir: 'dist', target })

  const second = publishStatic({ workDir: build({ 'dist/index.html': 'v2', 'dist/assets/index-BBBBBBB2.js': '2' }), publishDir: 'dist', target })
  expect(second.carried).toBe(1)
  expect(tree(target)).toEqual(['assets', 'assets/index-AAAAAAA1.js', 'assets/index-BBBBBBB2.js', 'index.html'])

  // the third deploy drops what the second carried, and carries the second's own
  const third = publishStatic({ workDir: build({ 'dist/index.html': 'v3', 'dist/assets/index-CCCCCCC3.js': '3' }), publishDir: 'dist', target })
  expect(third.carried).toBe(1)
  expect(tree(target)).toEqual(['assets', 'assets/index-BBBBBBB2.js', 'assets/index-CCCCCCC3.js', 'index.html'])

  // a build that keeps its names carries nothing (B was carried last time,
  // C is in the build), and leaves no list behind
  const fourth = publishStatic({ workDir: build({ 'dist/index.html': 'v4', 'dist/assets/index-CCCCCCC3.js': '3' }), publishDir: 'dist', target })
  expect(fourth.carried).toBe(0)
  expect(tree(target)).toEqual(['assets', 'assets/index-CCCCCCC3.js', 'index.html'])
  expect(existsSync(`${target}.carried`)).toBe(false)
  unpublishStatic(target)
  expect(readdirSync(root).filter(n => n.startsWith('public'))).toEqual([])
})

test('the hashed-asset rule: bundler output under assets/ or static/, nothing else', () => {
  for (const yes of ['assets/index-BxQ3abc1.js', 'assets/chunks/About-Cq1_z9Xk.css', 'static/js/main.3f2a1b9c.js']) expect(isHashedAsset(yes)).toBe(true)
  for (const no of ['index.html', 'assets/app.js', 'favicon-12345678.png', 'assets/index-BxQ3abc1.js.map', 'img/logo-12345678.png']) expect(isHashedAsset(no)).toBe(false)
})

test('a missing publish directory names the built sites it can see, not ones in node_modules or dot-dirs', () => {
  const { work, target } = site({
    'web/dist/index.html': 'a', 'client/dist/index.html': 'b', 'packages/docs/build/index.html': 'c',
    'node_modules/pkg/dist/index.html': 'no', '.cache/dist/index.html': 'no', 'src/dist/readme.txt': 'no index',
  })
  expect(findPublishCandidates(work).sort()).toEqual(['client/dist', 'packages/docs/build', 'web/dist'])
  const err = (() => {
    try {
      publishStatic({ workDir: work, publishDir: 'dist', target })
    } catch (e) {
      return e
    }
  })()
  expect(err).toBeInstanceOf(PublishError)
  expect(err.message).toStartWith('publish directory "dist" not found — did the build produce it? Built sites found at: ')
  expect(err.message).toContain('web/dist')
  expect(existsSync(target)).toBe(false)
})
