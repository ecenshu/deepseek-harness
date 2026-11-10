import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerCandidatePaths } from '../src/owner-paths.ts'

let base: string | undefined
const tempDirs: string[] = []

async function makeDir(name: string): Promise<string> {
  base ??= await realpath(await mkdtemp(join(tmpdir(), 'dsh-owner-paths-')))
  if (tempDirs.length === 0) tempDirs.push(base)
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  base = undefined
})

describe('ownerCandidatePaths', () => {
  it('returns only the cwd for a plain directory', async () => {
    const dir = await makeDir('plain')
    const canonicalDir = await realpath(dir)
    expect(await ownerCandidatePaths(canonicalDir)).toEqual([canonicalDir])
  })

  it('adds the main checkout for a linked worktree with an absolute gitdir', async () => {
    const repo = await makeDir('repo-abs')
    const commondirDir = join(repo, '.git', 'worktrees', 'w')
    await mkdir(commondirDir, { recursive: true })
    await writeFile(join(commondirDir, 'commondir'), '../..\n')

    const worktree = join(repo, 'wt-elsewhere', 'w')
    await mkdir(worktree, { recursive: true })
    const absGitdir = join(repo, '.git', 'worktrees', 'w')
    await writeFile(join(worktree, '.git'), `gitdir: ${absGitdir}`)

    const canonicalRepo = await realpath(repo)
    const canonicalWorktree = await realpath(worktree)

    expect(await ownerCandidatePaths(canonicalWorktree)).toEqual([canonicalWorktree, canonicalRepo])
  })

  it('resolves a relative gitdir against the .git file directory', async () => {
    const repo = await makeDir('repo-rel')
    const commondirDir = join(repo, '.git', 'worktrees', 'w')
    await mkdir(commondirDir, { recursive: true })
    await writeFile(join(commondirDir, 'commondir'), '../..\n')

    const worktree = join(repo, 'wt-elsewhere', 'w')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/w\n')

    const canonicalRepo = await realpath(repo)
    const canonicalWorktree = await realpath(worktree)

    expect(await ownerCandidatePaths(canonicalWorktree)).toEqual([canonicalWorktree, canonicalRepo])
  })

  it('adds the main checkout for a subdirectory of a worktree', async () => {
    const repo = await makeDir('repo-sub')
    const commondirDir = join(repo, '.git', 'worktrees', 'w')
    await mkdir(commondirDir, { recursive: true })
    await writeFile(join(commondirDir, 'commondir'), '../..\n')

    const worktree = join(repo, 'wt-elsewhere', 'w')
    const subDir = join(worktree, 'src', 'a')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/w\n')

    const canonicalRepo = await realpath(repo)
    const canonicalSubDir = await realpath(subDir)

    expect(await ownerCandidatePaths(canonicalSubDir)).toEqual([canonicalSubDir, canonicalRepo])
  })

  it('adds the worktrees-segment parent without any git metadata', async () => {
    const parent = await makeDir('parent-layout')
    const worktree = join(parent, 'worktrees', 'x')
    await mkdir(worktree, { recursive: true })

    const canonicalParent = await realpath(parent)
    const canonicalWorktree = await realpath(worktree)

    expect(await ownerCandidatePaths(canonicalWorktree)).toEqual([canonicalWorktree, canonicalParent])
  })

  it('ignores a submodule .git file without commondir', async () => {
    const repo = await makeDir('repo-submodule')
    const moduleDir = join(repo, '.git', 'modules', 'm')
    await mkdir(moduleDir, { recursive: true })

    const submod = join(repo, 'submodule')
    await mkdir(submod, { recursive: true })
    await writeFile(join(submod, '.git'), `gitdir: ${moduleDir}\n`)

    const canonicalSubmod = await realpath(submod)

    expect(await ownerCandidatePaths(canonicalSubmod)).toEqual([canonicalSubmod])
  })

  it('ignores a bare common dir', async () => {
    const baseDir = await makeDir('bare-setup')
    const repoGit = join(baseDir, 'repo.git')
    const commondirDir = join(repoGit, 'worktrees', 'w')
    await mkdir(commondirDir, { recursive: true })
    await writeFile(join(commondirDir, 'commondir'), '../..\n')

    const worktree = join(baseDir, 'wt')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, '.git'), `gitdir: ${commondirDir}\n`)

    const canonicalWorktree = await realpath(worktree)

    expect(await ownerCandidatePaths(canonicalWorktree)).toEqual([canonicalWorktree])
  })

  it('canonicalizes a junctioned main checkout', async () => {
    const repo = await makeDir('repo-real')
    const commondirDir = join(repo, '.git', 'worktrees', 'w')
    await mkdir(commondirDir, { recursive: true })
    await writeFile(join(commondirDir, 'commondir'), '../..\n')

    const alias = join(base!, 'repo-junction-alias')
    await symlink(repo, alias, 'junction')

    const worktree = await makeDir('wt-junction')
    await writeFile(join(worktree, '.git'), `gitdir: ${join(alias, '.git', 'worktrees', 'w')}\n`)

    const canonicalRepo = await realpath(repo)
    const canonicalWorktree = await realpath(worktree)

    const result = await ownerCandidatePaths(canonicalWorktree)
    expect(result).toEqual([canonicalWorktree, canonicalRepo])
    expect(result).not.toContain(alias)
  })

  it('orders most specific first with nested worktrees segments', async () => {
    const root = await makeDir('nested-root')
    const nestedB = join(root, 'worktrees', 'b')
    const nestedC = join(nestedB, 'worktrees', 'c')
    await mkdir(nestedC, { recursive: true })

    const canonicalRoot = await realpath(root)
    const canonicalB = await realpath(nestedB)
    const canonicalC = await realpath(nestedC)

    expect(await ownerCandidatePaths(canonicalC)).toEqual([canonicalC, canonicalB, canonicalRoot])
  })

  it('adds nothing when .git is a directory', async () => {
    const repo = await makeDir('repo-dir')
    await mkdir(join(repo, '.git'), { recursive: true })

    const canonicalRepo = await realpath(repo)
    expect(await ownerCandidatePaths(canonicalRepo)).toEqual([canonicalRepo])
  })

  it('ignores a .git file without a gitdir header', async () => {
    const worktree = await makeDir('wt-invalid-gitfile')
    await writeFile(join(worktree, '.git'), 'not a gitdir file\n')

    const canonicalWorktree = await realpath(worktree)
    expect(await ownerCandidatePaths(canonicalWorktree)).toEqual([canonicalWorktree])
  })

  it('handles an absolute commondir path', async () => {
    const repo = await makeDir('repo-abs-commondir')
    const commondirDir = join(repo, '.git', 'worktrees', 'w')
    await mkdir(commondirDir, { recursive: true })
    const absGit = join(repo, '.git')
    await writeFile(join(commondirDir, 'commondir'), `${absGit}\n`)

    const worktree = join(repo, 'wt-elsewhere', 'w')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, '.git'), `gitdir: ${commondirDir}\n`)

    const canonicalRepo = await realpath(repo)
    const canonicalWorktree = await realpath(worktree)

    expect(await ownerCandidatePaths(canonicalWorktree)).toEqual([canonicalWorktree, canonicalRepo])
  })

  it.runIf(process.platform === 'win32')(
    'matches a gitdir spelled in a different case and with forward slashes',
    async () => {
      const repo = await makeDir('RepoWithMixedCase')
      const commondirDir = join(repo, '.git', 'worktrees', 'w')
      await mkdir(commondirDir, { recursive: true })
      await writeFile(join(commondirDir, 'commondir'), '../..\n')

      const canonicalRepo = await realpath(repo)
      const lowerRepoForwardSlashes = canonicalRepo.toLowerCase().replaceAll('\\', '/')

      const worktree = await makeDir('wt-win32')
      await writeFile(
        join(worktree, '.git'),
        `gitdir: ${lowerRepoForwardSlashes}/.git/worktrees/w\n`,
      )

      const canonicalWorktree = await realpath(worktree)
      expect(await ownerCandidatePaths(canonicalWorktree)).toEqual([canonicalWorktree, canonicalRepo])
    },
  )
})
