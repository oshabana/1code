export type OpenCodeAuthMethod = {
  type: "oauth" | "api"
  label: string
}

export type OpenCodeRawModel = {
  id: string
  name: string
  release_date?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  experimental?: boolean
  status?: "alpha" | "beta" | "deprecated"
}

export type OpenCodeRawProvider = {
  id: string
  name: string
  connected?: boolean
  models: OpenCodeRawModel[]
}

export type OpenCodeCatalogInput = {
  all: OpenCodeRawProvider[]
  authMethods: Record<string, OpenCodeAuthMethod[]>
}

export type OpenCodeModelOption = {
  id: string
  providerID: string
  providerName: string
  name: string
  connected: boolean
  status?: "alpha" | "beta" | "deprecated"
}

export type OpenCodeProviderCatalog = {
  id: string
  name: string
  connected: boolean
  authMethods: OpenCodeAuthMethod[]
  models: OpenCodeModelOption[]
}

export function parseOpenCodeModelId(id: string): {
  providerID: string
  modelID: string
} | null {
  const slashIndex = id.indexOf("/")
  if (slashIndex <= 0 || slashIndex >= id.length - 1) return null
  return {
    providerID: id.slice(0, slashIndex),
    modelID: id.slice(slashIndex + 1),
  }
}

export function formatOpenCodeModelId(input: {
  providerID: string
  modelID: string
}): string {
  return `${input.providerID}/${input.modelID}`
}

export function buildOpenCodeCatalog(
  input: OpenCodeCatalogInput,
): OpenCodeProviderCatalog[] {
  return input.all.map((provider) => {
    const connected = provider.connected ?? false
    const authMethods = input.authMethods[provider.id] ?? []
    const models = provider.models.map((model) => {
      const parsed = parseOpenCodeModelId(model.id)
      return {
        id: model.id,
        providerID: parsed?.providerID ?? provider.id,
        providerName: provider.name,
        name: model.name,
        connected,
        status: model.status,
      }
    })

    return {
      id: provider.id,
      name: provider.name,
      connected,
      authMethods,
      models,
    }
  })
}

export function flattenOpenCodeCatalog(catalog: OpenCodeProviderCatalog[]): OpenCodeModelOption[] {
  return catalog.flatMap((provider) => provider.models)
}

export function pickDefaultOpenCodeModel(
  catalog: OpenCodeProviderCatalog[],
): OpenCodeModelOption | null {
  const connectedProvider = catalog.find((provider) => provider.connected)
  if (connectedProvider?.models.length) return connectedProvider.models[0] ?? null

  for (const provider of catalog) {
    if (provider.models.length) return provider.models[0] ?? null
  }

  return null
}
