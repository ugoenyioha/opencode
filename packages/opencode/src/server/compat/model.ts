import { Provider } from "@/provider/provider"
import type { CompatProvider } from "./types"

export async function resolveModel(provider: CompatProvider, model: string) {
  void provider
  const parsed = Provider.parseModel(model)
  await Provider.getModel(parsed.providerID, parsed.modelID)
  return {
    publicModel: model,
    resolvedModel: model,
  }
}

export async function listModels(provider: CompatProvider) {
  void provider
  const providers = await Provider.list()
  return Object.entries(providers).flatMap(([providerID, info]) =>
    Object.keys(info.models).map((modelID) => `${providerID}/${modelID}`),
  )
}
