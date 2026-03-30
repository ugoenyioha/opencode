import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Database, eq } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"
import { $ } from "bun"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const GLOBAL_PROJECT_ID = "global"

function uid() {
  return Identifier.ascending("session")
}

function seed(opts: { id: string; dir: string; project: string }) {
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id: opts.id,
        project_id: opts.project,
        slug: opts.id,
        directory: opts.dir,
        title: "test",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
}

function ensureGlobal() {
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({
        id: GLOBAL_PROJECT_ID,
        worktree: "/",
        time_created: Date.now(),
        time_updated: Date.now(),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run(),
  )
}

describe("migrateFromGlobal", () => {
  test("migrates global sessions on first project creation", async () => {
    // 1. Start with git init but no commits. On this branch a repo without a
    // root commit still resolves to a local hashed project ID rather than
    // "global", but sessions created before the first commit may still exist
    // under the historical global bucket and need migrating once a real git ID
    // appears.
    await using tmp = await tmpdir()
    await $`git init`.cwd(tmp.path).quiet()
    await $`git config user.name "Test"`.cwd(tmp.path).quiet()
    await $`git config user.email "test@opencode.test"`.cwd(tmp.path).quiet()
    const { project: pre } = await Project.fromDirectory(tmp.path)
    expect(pre.id).not.toBe(GLOBAL_PROJECT_ID)

    // 2. Seed a session under "global" with matching directory
    ensureGlobal()
    const id = uid()
    seed({ id, dir: tmp.path, project: GLOBAL_PROJECT_ID })

    // 3. Make a commit so the project gets a real ID
    await $`git commit --allow-empty -m "root"`.cwd(tmp.path).quiet()

    const { project: real } = await Project.fromDirectory(tmp.path)
    expect(real.id).not.toBe(GLOBAL_PROJECT_ID)

    // 4. The session should have been migrated to the real project ID
    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
    expect(row).toBeDefined()
    expect(row!.project_id).toBe(real.id)
  })

  test("migrates global sessions even when project row already exists", async () => {
    // 1. Create a repo with a commit — real project ID created immediately
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(GLOBAL_PROJECT_ID)

    // 2. Ensure "global" project row exists (as it would from a prior no-git session)
    ensureGlobal()

    // 3. Seed a session under "global" with matching directory.
    //    This simulates a session created before git init that wasn't
    //    present when the real project row was first created.
    const id = uid()
    seed({ id, dir: tmp.path, project: GLOBAL_PROJECT_ID })

    // 4. Call fromDirectory again — project row already exists,
    //    so the current code skips migration entirely. This is the bug.
    await Project.fromDirectory(tmp.path)

    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
    expect(row).toBeDefined()
    expect(row!.project_id).toBe(project.id)
  })

  test("migrates sessions with empty directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(GLOBAL_PROJECT_ID)

    ensureGlobal()

    // Legacy sessions may lack a directory value
    const id = uid()
    seed({ id, dir: "", project: GLOBAL_PROJECT_ID })

    await Project.fromDirectory(tmp.path)

    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
    expect(row).toBeDefined()
    // Empty directory means "no known origin" — should be claimed
    expect(row!.project_id).toBe(project.id)
  })

  test("does not steal sessions from unrelated directories", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(GLOBAL_PROJECT_ID)

    ensureGlobal()

    // Seed a session under "global" but for a DIFFERENT directory
    const id = uid()
    seed({ id, dir: "/some/other/dir", project: GLOBAL_PROJECT_ID })

    await Project.fromDirectory(tmp.path)

    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
    expect(row).toBeDefined()
    // Should remain under "global" — not stolen
    expect(row!.project_id).toBe(GLOBAL_PROJECT_ID)
  })
})
