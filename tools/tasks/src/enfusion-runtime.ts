import { NodeServices } from "@effect/platform-node";
import { Layer, ManagedRuntime } from "effect";
import { ArmaEnvironmentLive } from "./arma-environment";
import { EnfusionBackendLive } from "./enfusion-backend";
import { EnfusionJobsLive } from "./enfusion-jobs";

export const createEnfusionRuntime = (repositoryRoot: string) => {
  const backend = EnfusionBackendLive(repositoryRoot).pipe(
    Layer.provide(ArmaEnvironmentLive),
    Layer.provide(NodeServices.layer),
  );
  return ManagedRuntime.make(EnfusionJobsLive.pipe(Layer.provideMerge(backend)));
};
