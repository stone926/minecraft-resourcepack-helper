import type { ResourceContributionProvider } from "../resourceUniverse/core/types";
import { physicalProviderId } from "../resourceUniverse/core/providerIds";
import type { PhysicalAssetOwnedOutputLookup } from "../resourceUniverse/providers/physicalAssetProvider";

interface PhysicalOwnershipProviderCapability extends ResourceContributionProvider {
  readonly providerId: typeof physicalProviderId;
  setOwnedOutputLookup(lookup: PhysicalAssetOwnedOutputLookup): { dispose(): void };
}

export interface RsglPhysicalOwnershipBinding {
  readonly providerId: typeof physicalProviderId;
  readonly subscription: { dispose(): void };
}

/**
 * Binds the generated-output ownership view to an optional physical provider.
 * Provider instances may originate in another bundle, so this boundary is
 * deliberately structural rather than based on constructor identity.
 */
export function bindRsglPhysicalOwnership(
  provider: ResourceContributionProvider | undefined,
  lookup: PhysicalAssetOwnedOutputLookup
): RsglPhysicalOwnershipBinding | undefined {
  if (!hasPhysicalOwnershipCapability(provider)) {
    return undefined;
  }
  try {
    const subscription = provider.setOwnedOutputLookup(lookup);
    return isDisposable(subscription)
      ? { providerId: provider.providerId, subscription }
      : undefined;
  } catch {
    // Ownership coupling is optional; a foreign provider must not prevent the
    // generated provider from registering and serving snapshots.
    return undefined;
  }
}

function hasPhysicalOwnershipCapability(
  provider: ResourceContributionProvider | undefined
): provider is PhysicalOwnershipProviderCapability {
  try {
    return provider?.providerId === physicalProviderId
      && "setOwnedOutputLookup" in provider
      && typeof provider.setOwnedOutputLookup === "function";
  } catch {
    return false;
  }
}

function isDisposable(value: unknown): value is { dispose(): void } {
  try {
    return typeof value === "object"
      && value !== null
      && "dispose" in value
      && typeof value.dispose === "function";
  } catch {
    return false;
  }
}
