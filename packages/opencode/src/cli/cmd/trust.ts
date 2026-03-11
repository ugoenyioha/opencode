import { Instance } from "../../project/instance"
import { Config } from "../../config/config"
import { Trust } from "../../trust"
import { Project } from "../../project/project"

export const TrustCommand = {
  command: "trust",
  describe: "Approve the current workspace configuration (resolves Gate 3 untrusted workspace errors)",
  handler: async () => {
    const cwd = process.cwd()
    await Instance.provide({
      directory: cwd,
      fn: async () => {
        const trustFiles = await Config.trustInputs()
        const trustData = await Trust.hash(trustFiles)

        console.log("Approving workspace configuration...")
        await Trust.approve(Instance.project.id, trustData.hash)

        console.log("✅ Workspace trusted successfully.")
        console.log(`Project ID: ${Instance.project.id}`)
        console.log(`Config Hash: ${trustData.hash}`)

        process.exit(0)
      },
    })
  },
}
