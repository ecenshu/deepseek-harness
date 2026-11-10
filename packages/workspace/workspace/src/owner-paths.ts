/**
 * Owner candidate paths for workspace session membership.
 * @module @deepseek-ai/dsh-workspace/src/owner-paths
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Canonical directories that may own a session whose canonical cwd is `cwd`,
 * most specific first.
 *
 * Evaluates two rules beyond `cwd` itself:
 * 1. Layout rule: each ancestor `P` where the next path segment is exactly
 *    `worktrees` and `cwd` lies below `P/worktrees/<name>`, nearest first.
 * 2. Git rule: walk up from `cwd` to the nearest ancestor with a `.git` entry.
 *    If `.git` is a file with `gitdir: X` and `X/commondir` resolves to a
 *    directory whose basename is `.git`, add the canonical parent of that
 *    common directory.
 *
 * @param cwd - Canonical (`realpathNormalize`d) existing working directory.
 * @returns Ordered list of canonical candidate owner directories with duplicates removed.
 */
export async function ownerCandidatePaths(cwd: string): Promise<readonly string[]> {
  const candidates: string[] = [cwd]

  // Layout rule: nearest ancestor P where next segment is 'worktrees' and cwd is below P/worktrees/<name>
  let ancestor = cwd
  while (true) {
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent

    const rel = relative(ancestor, cwd)
    const segments = rel.split(/[\\/]+/).filter(Boolean)
    if (segments.length >= 2 && segments[0] === 'worktrees') {
      try {
        const canonical = await realpath(ancestor)
        candidates.push(canonical)
      } catch {
        // Ancestors that fail to resolve are dropped
      }
    }
  }

  // Git rule: walk up to nearest ancestor A with a .git entry
  let gitDirWalk: string | null = cwd
  while (gitDirWalk) {
    const dotGit = join(gitDirWalk, '.git')
    let dotGitStat
    try {
      dotGitStat = await stat(dotGit)
    } catch {
      // .git does not exist in this ancestor
    }

    if (dotGitStat) {
      if (dotGitStat.isFile()) {
        try {
          const content = await readFile(dotGit, 'utf8')
          const newlineIndex = content.indexOf('\n')
          const firstLine = (newlineIndex === -1 ? content : content.slice(0, newlineIndex)).trim()
          const match = /^gitdir:\s*(.+)$/.exec(firstLine)
          const rawGitDir = match?.[1]?.trim()
          if (rawGitDir) {
            const gitDir = isAbsolute(rawGitDir)
              ? rawGitDir
              : resolve(gitDirWalk, rawGitDir)
            const commondirFile = join(gitDir, 'commondir')
            let commondirContent: string | undefined
            try {
              commondirContent = (await readFile(commondirFile, 'utf8')).trim()
            } catch {
              // submodule or worktree missing commondir -> adds nothing
            }
            if (commondirContent) {
              const commondirTarget = isAbsolute(commondirContent)
                ? commondirContent
                : resolve(gitDir, commondirContent)
              const canonicalCommonDir = await realpath(commondirTarget)
              if (basename(canonicalCommonDir) === '.git') {
                const mainCheckout = await realpath(dirname(canonicalCommonDir))
                candidates.push(mainCheckout)
              }
            }
          }
        } catch {
          // unresolvable or invalid gitdir adds nothing
        }
      }
      break
    }

    const parent = dirname(gitDirWalk)
    if (parent === gitDirWalk) break
    gitDirWalk = parent
  }

  return Array.from(new Set(candidates))
}
