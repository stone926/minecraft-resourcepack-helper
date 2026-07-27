import type { ResourceContributionProvider } from "./types";

export interface ResourceProviderRegistration {
  dispose(): void;
}

export class ResourceContributionRegistry {
  private readonly providers = new Map<string, ResourceContributionProvider>();

  public register(provider: ResourceContributionProvider): ResourceProviderRegistration {
    if (this.providers.has(provider.providerId)) {
      throw new Error(`Resource provider '${provider.providerId}' is already registered.`);
    }
    this.providers.set(provider.providerId, provider);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        if (this.providers.get(provider.providerId) === provider) {
          this.providers.delete(provider.providerId);
        }
      }
    };
  }

  public get(providerId: string): ResourceContributionProvider | undefined {
    return this.providers.get(providerId);
  }

  public list(): readonly ResourceContributionProvider[] {
    return [...this.providers.values()]
      .sort((left, right) => left.providerId.localeCompare(right.providerId, "en"));
  }
}
