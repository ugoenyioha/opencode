import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"
import { Filesystem } from "../util/filesystem"

const app = "opencode"

function dataPath() {
  return path.join((process.env.XDG_DATA_HOME || xdgData)!, app)
}

function cachePath() {
  return path.join((process.env.XDG_CACHE_HOME || xdgCache)!, app)
}

function configPath() {
  return path.join((process.env.XDG_CONFIG_HOME || xdgConfig)!, app)
}

function statePath() {
  return path.join((process.env.XDG_STATE_HOME || xdgState)!, app)
}

export namespace Global {
  export const Path = {
    // Allow override via OPENCODE_TEST_HOME for test isolation
    get home() {
      return process.env.OPENCODE_TEST_HOME || os.homedir()
    },
    get data() {
      return dataPath()
    },
    get bin() {
      return path.join(cachePath(), "bin")
    },
    get log() {
      return path.join(dataPath(), "log")
    },
    get cache() {
      return cachePath()
    },
    get config() {
      return configPath()
    },
    get state() {
      return statePath()
    },
  }
}

await Promise.all([
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
])

const CACHE_VERSION = "21"

const version = await Filesystem.readText(path.join(Global.Path.cache, "version")).catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Global.Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Global.Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Filesystem.write(path.join(Global.Path.cache, "version"), CACHE_VERSION)
}
