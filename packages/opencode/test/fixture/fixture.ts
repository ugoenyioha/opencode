import { $ } from "bun"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import type { Config } from "../../src/config/config"
import crypto from "crypto"
import { ConfigPaths } from "../../src/config/paths"
import { Filesystem } from "../../src/util/filesystem"
import { Glob } from "../../src/util/glob"
import { Trust } from "../../src/trust"
import { Global } from "../../src/global"

import { Flag } from "../../src/flag/flag"

// Strip null bytes from paths (defensive fix for CI environment issues)
function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

type TmpDirOptions<T> = {
  git?: boolean
  config?: Partial<Config.Info>
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
  trust?: boolean
}

function localId(dir: string) {
  return `local_${crypto.createHash("sha256").update(dir).digest("hex").slice(0, 16)}`
}

async function projectId(dir: string, git?: boolean) {
  if (!git) return localId(dir)
  const roots = await $`git rev-list --max-parents=0 --all`
    .cwd(dir)
    .text()
    .then((out) =>
      out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .toSorted(),
    )
    .catch(() => undefined)
  if (!roots?.length) return localId(dir)
  return roots[0] || localId(dir)
}

async function trustInputs(dir: string) {
  const files = new Set<string>()
  for (const file of await ConfigPaths.projectFiles("opencode", dir, dir)) {
    files.add(file)
  }
  for await (const root of Filesystem.up({ targets: [".opencode"], start: dir, stop: dir })) {
    const matches = await Glob.scan("**/*", {
      cwd: root,
      absolute: true,
      include: "file",
      dot: true,
      symlink: true,
    })
    for (const match of matches) files.add(match)
  }
  for await (const root of Filesystem.up({ targets: [".claude", ".agents"], start: dir, stop: dir })) {
    const matches = await Glob.scan("skills/**/SKILL.md", {
      cwd: root,
      absolute: true,
      include: "file",
      dot: true,
      symlink: true,
    })
    for (const match of matches) files.add(match)
  }
  return [...files]
}

export async function trustWorkspace(dir: string, git?: boolean) {
  const inputs = await trustInputs(dir)
  if (!inputs.length) return
  const { hash } = await Trust.hash(inputs)
  const id = await projectId(dir, git)
  const filepath = path.join(Global.Path.config, "trust.json")
  const existing = await Filesystem.readJson<Record<string, string>>(filepath).catch(
    () => ({}) as Record<string, string>,
  )
  existing[id] = hash
  await Filesystem.writeJson(filepath, existing)
}
export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = sanitizePath(path.join(os.tmpdir(), "opencode-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  if (options?.git) {
    await $`git init`.cwd(dirpath).quiet()
    await $`git commit --allow-empty -m "root commit ${dirpath}"`.cwd(dirpath).quiet()
  }
  if (options?.config) {
    await Bun.write(
      path.join(dirpath, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        ...options.config,
      }),
    )
  }
  const extra = await options?.init?.(dirpath)
  const realpath = sanitizePath(await fs.realpath(dirpath))
  if (options?.trust !== false) {
    await trustWorkspace(realpath, options?.git)
  }
  const result = {
    [Symbol.asyncDispose]: async () => {
      await options?.dispose?.(dirpath)
      // await fs.rm(dirpath, { recursive: true, force: true })
    },
    path: realpath,
    extra: extra as T,
  }
  return result
}
