# The Global State Trap: Stopping AI Sessions from Bleeding Across Git Worktrees

Picture this: You are deep in the zone. You open a fresh terminal window in a new, empty directory to write a quick shell script. You type `opencode -c` (continue) to pick up where you left off on an AI coding session from earlier.

Instead of a blank slate or an error, the AI cheerfully resumes a conversation about a massive Next.js refactor from a completely different project.

This is context bleed. For local-first developer tools, it is the ultimate sin.

We recently squashed a bug in the OpenCode CLI that caused this exact scenario. Here is how a seemingly harmless piece of fallback logic created a "global state trap", and how we fixed it.

## The Flawed Architecture

When you run OpenCode, it stores your chat history in a local SQLite database (`~/.local/share/opencode`). To figure out which chat history to show you, the CLI needs to identify which "Project" you are currently working in.

Our original logic for `Project.fromDirectory()` did this:

1. Walk up the directory tree to find a `.git` folder.
2. If found, run `git rev-list --max-parents=0 HEAD` to get the root commit hash of the repository, and use that as the Project ID.
3. If no `.git` folder is found, fallback to returning the hardcoded string `"global"`.

At first glance, this seems elegant. But it created two massive blind spots that collided in the worst way possible.

### Trap 1: The Git Root Hash Collision

Relying on the git root commit hash is a trap.

If you use `git worktree`, you have multiple independent directories pointing to the exact same repository. Because they share the same root commit hash, our CLI treated them as the exact same Project. If you were fixing a bug in `worktree-a` and running an AI session, and then switched to `worktree-b` to review a PR, your AI sessions would silently bleed into each other.

Worse, if you clone a popular boilerplate (like a `create-react-app` starter template) multiple times for different clients, all those separate client projects share the _same initial root commit_. The CLI merged them all together.

### Trap 2: The Global Dumping Ground

The fallback for non-git directories was catastrophic.

Every random script folder, every scratchpad, every downloaded ZIP file that wasn't a git repo defaulted to the `"global"` ID.

This meant every non-git folder on your entire machine shared a single, chaotic AI session history. If you asked a question about parsing JSON in `~/tmp/scriptA`, it would show up when you opened `~/tmp/scriptB`.

## The Fix: Deterministic Hashing and Strict Filtering

Global fallbacks in local tools are almost always a mistake. We needed to tie sessions to strict physical disk boundaries.

Here is the three-step fix we implemented:

### 1. Hash the Absolute Path

We ripped out the `"global"` fallback entirely. If a directory isn't part of a git repo, we now generate a deterministic ID by hashing the absolute path of the current workspace.

```typescript
// Old: The trap
if (!roots) return { id: "global", worktree: directory }

// New: Strict physical isolation
import crypto from "crypto"

const getLocalId = (dir: string) => `local_${crypto.createHash("sha256").update(dir).digest("hex").slice(0, 16)}`

if (!roots) return { id: getLocalId(directory), worktree: directory }
```

Now, `~/tmp/scriptA` and `~/tmp/scriptB` get entirely distinct Project IDs.

### 2. Handle Git Worktrees Properly

We couldn't just abandon the git root hash entirely without breaking backward compatibility for existing users. But we needed to stop the worktree bleed.

We solved this in the Terminal UI bootstrap sequence. When you run `opencode -c`, we grab the list of all sessions for the current Project ID. But before we resume the most recent one, we apply a strict filter against the physical working directory:

```tsx
// The strict context-aware filter
const match = sync.data.session
  .toSorted((a, b) => b.time.updated - a.time.updated)
  .find(
    (session) => session.parentID === undefined && session.directory === sync.data.path.directory, // Strict exact match
  )?.id
```

Even if two worktrees share the same Project ID (because of the root commit hash), the UI will aggressively refuse to resume a session that was initiated in a different physical directory path.

## Respect the Physical Boundary

The absolute path on disk is the only source of truth that actually matters for a developer.

When building CLI tools, avoid the temptation to group unknown contexts into a generic "global" bucket. State should always be scoped as narrowly as possible. If you can't identify a logical project boundary, default to the physical directory boundary.

Never guess what context the user wants. Enforce the boundary they are standing in.
