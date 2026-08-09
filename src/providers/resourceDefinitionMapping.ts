import type { ResourceLocation, ResourceNavigationResult } from "../resourceUniverse";

/**
 * Projects Resource Universe navigation into the ordered, de-duplicated
 * locations shown by VS Code's definition UI.
 */
export function definitionLocationsForNavigation(
  navigation: ResourceNavigationResult | undefined,
  fallbackUri: string | null = null
): ResourceLocation[] {
  const locations = navigationLocations(navigation);
  if (locations.length === 0 && fallbackUri) {
    locations.push({ uri: fallbackUri, origin: "physical" });
  }

  return [...new Map(locations.map(location => [
    `${location.uri}\0${location.range?.start ?? 0}\0${location.range?.end ?? 0}`,
    location
  ])).values()];
}

function navigationLocations(navigation: ResourceNavigationResult | undefined): ResourceLocation[] {
  if (!navigation) {
    return [];
  }
  if (navigation.status === "resolved") {
    return [navigation.primary, ...navigation.alternatives];
  }
  return navigation.candidates.flatMap(producer => [
    ...producer.sourceOrigins,
    ...producer.physicalOrigins
  ]);
}
