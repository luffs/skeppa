// What a repository's root says about building and running it — offered on
// the mooring form as one-click values, never applied by itself. Reads only
// the root's file names and package.json (two contents-API calls).
//
// The suggestions are bun commands whatever the lockfile, on purpose: the
// panel's default build image is oven/bun, which has no npm, pnpm or yarn,
// and `bun install` reads their lockfiles (and moves them to bun.lock).

const LOCKFILES = [
  ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm'],
]
// Builders whose output is a folder of files, and where they put it.
const SITE_BUILDERS = [
  ['vite', 'Vite', 'dist'], ['astro', 'Astro', 'dist'], ['@vue/cli-service', 'Vue CLI', 'dist'],
  ['react-scripts', 'Create React App', 'build'], ['parcel', 'Parcel', 'dist'], ['@11ty/eleventy', 'Eleventy', '_site'],
]

// { files: [root file names], packageJson: object | null } →
// { found, deploy, start, runtime?, publish_dir?, notes }
export function suggestSetup({ files = [], packageJson = null } = {}) {
  if (!packageJson || typeof packageJson !== 'object') {
    const notes = ['no package.json at the root']
    if (files.includes('Dockerfile')) notes.push('a Dockerfile, which the panel does not build')
    return { found: false, deploy: '', start: '', notes }
  }
  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {}
  const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) }
  const notes = []

  const lock = LOCKFILES.find(([file]) => files.includes(file))
  if (lock) notes.push(lock[1] === 'bun' ? lock[0] : `${lock[0]} — bun install reads it`)

  const deploy = scripts.build ? 'bun install && bun run build' : 'bun install'
  notes.push(scripts.build ? 'a build script' : 'no build script')
  const start = scripts.start ? 'bun run start' : ''
  notes.push(scripts.start ? 'a start script' : 'no start script')

  const builder = SITE_BUILDERS.find(([dep]) => dep in deps)
  if (builder) notes.push(builder[1])
  // Built but never started, by a site builder: a static site.
  if (builder && scripts.build && !scripts.start) {
    return { found: true, deploy, start, runtime: 'static', publish_dir: builder[2], notes }
  }
  return { found: true, deploy, start, notes }
}
