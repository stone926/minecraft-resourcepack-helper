const defaultProfile = Object.freeze({
  name: "default",
  pathCanonicalizationIterations: 1_000,
  multiRootProjectCount: 8,
  projectDiscoveryIterations: 12,
  targetedInvalidationIterations: 20,
  remoteDiscoveryIterations: 30,
  physicalProducerCount: 20_000,
  physicalEdgeCount: 20_000,
  snapshotConstructionIterations: 5,
  atomicReplacementIterations: 5,
  queryCount: 4_000,
  queryBatchSize: 100,
  warmQueryPasses: 5,
  zipEntryCount: 5_000,
  zipIndexIterations: 7,
  zipReadCount: 1_000,
  zipReadBatchSize: 50,
  zipWarmReadPasses: 5
});

const smokeProfile = Object.freeze({
  name: "smoke",
  pathCanonicalizationIterations: 40,
  multiRootProjectCount: 2,
  projectDiscoveryIterations: 2,
  targetedInvalidationIterations: 3,
  remoteDiscoveryIterations: 3,
  physicalProducerCount: 500,
  physicalEdgeCount: 500,
  snapshotConstructionIterations: 2,
  atomicReplacementIterations: 2,
  queryCount: 100,
  queryBatchSize: 20,
  warmQueryPasses: 2,
  zipEntryCount: 100,
  zipIndexIterations: 2,
  zipReadCount: 40,
  zipReadBatchSize: 10,
  zipWarmReadPasses: 2
});

export const resourceUniverseBenchmarkProfiles = Object.freeze({
  default: defaultProfile,
  smoke: smokeProfile
});

export function resolveResourceUniverseBenchmarkProfile(name) {
  const profile = resourceUniverseBenchmarkProfiles[name];
  if (!profile) {
    throw new Error(`Unknown resource-universe benchmark profile '${name}'.`);
  }
  return profile;
}
