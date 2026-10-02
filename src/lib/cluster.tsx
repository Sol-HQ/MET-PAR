"use client";

import { createContext, useContext } from "react";
import type { ClusterName } from "./constants";

export type ClusterContextValue = {
  cluster: ClusterName;
  setCluster: (cluster: ClusterName) => void;
};

export const ClusterContext = createContext<ClusterContextValue>({
  cluster: "devnet",
  setCluster: () => {},
});

export function useCluster(): ClusterContextValue {
  return useContext(ClusterContext);
}
