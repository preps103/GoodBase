import React from "react";
import { createRoot } from "react-dom/client";
import { GoodOSFloatingSupportBar } from "./index.js";

const script = document.currentScript;
const appName = script?.dataset?.goodosApp || document.documentElement.dataset.goodosApp || "GoodOS";
const mount = document.createElement("div");
mount.dataset.goodosFloatingSupportRoot = "";
document.body.appendChild(mount);
createRoot(mount).render(<GoodOSFloatingSupportBar appName={appName} />);
