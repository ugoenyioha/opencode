---
title: Global State Trap
description: Fix cross-folder AI session bleed
---

# Global State Trap

Picture this. You open a fresh terminal window in a new project.

You type `opencode -c` to continue your last AI session.

Instead of helping with your current code, the AI cheerfully resumes a conversation about a completely different project. This is context bleed.

It is the stuff of nightmares for local-first developer tools.

We recently squashed a bug in the OpenCode CLI that caused this exact scenario. Here is how a seemingly harmless fallback created a global state trap.

---

## Understand the flaw

When you run OpenCode, it stores your chat history in a local SQLite database. To resume a session, the CLI needs to know which project you are currently in.

Our original logic for generating a project ID was deeply flawed. If you were in a git repository, it used the root commit hash.

If you were not in a git repo, it fell back to a hardcoded string called global.

At first glance this seems reasonable. It actually created two massive blind spots.

---

## Avoid worktree collisions

Relying on the git root commit hash is dangerous. If you use git worktrees, you have multiple directories pointing to the same repository.

If you clone a boilerplate starter template multiple times, all those separate projects share the same root commit hash. Our CLI treated them as the exact same project.

Running the continue command in one folder would gladly resurrect the session from another.

---

## Eliminate dumping grounds

The fallback for non-git directories was even worse. Every random script folder or scratchpad defaulted to the global ID.

Every non-git folder on your entire machine shared a single chaotic AI session history. If you asked a question in a temporary script, it would show up when you opened your notes folder.

---

## Hash the folder

Global fallbacks in local tools are almost always a mistake. We needed to tie sessions to strict physical disk boundaries.

We ripped out the global fallback and the root commit hash logic. Instead we migrated to deterministic local folder hashing.

We now generate the project ID by hashing the absolute path of the current workspace.

---

## Filter the interface

Generating a better ID was only half the battle. We also updated the Terminal UI to strictly filter the session list.

It now guarantees that when you ask for history, you only see sessions that originated from your exact working directory.

---

## Respect the boundary

Developer tools must respect the physical boundary of the directory you are working in.

Avoid the temptation to group unknown contexts into a global bucket. State should always be scoped as narrowly as possible.

The absolute path on disk is the only source of truth that actually matters.
