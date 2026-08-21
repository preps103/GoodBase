import { access, copyFile, mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const distRoot = path.join(root, "dist");
const clientRoot = path.join(distRoot, "client");
const serverRoot = path.join(distRoot, "server");
const metadataRoot = path.join(distRoot, ".openai");
const adapterRoot = path.join(root, "vendor", "goodos-sites-hosting");
const hostingConfig = path.join(root, ".openai", "hosting.json");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(distRoot))) {
  throw new Error("Build output is missing. Run the application build before preparing Sites.");
}

if (!(await exists(path.join(clientRoot, "index.html")))) {
  if (!(await exists(path.join(distRoot, "index.html")))) {
    throw new Error("The Vite document is missing from dist/index.html or dist/client/index.html.");
  }

  await mkdir(clientRoot, { recursive: true });
  const serverArtifacts = /^(?:server(?:\.(?:c|m)?js)?(?:\.map)?|server-dist)$/i;
  for (const entry of await readdir(distRoot, { withFileTypes: true })) {
    if (["client", "server", ".openai"].includes(entry.name)) continue;
    if (serverArtifacts.test(entry.name)) continue;
    await rename(path.join(distRoot, entry.name), path.join(clientRoot, entry.name));
  }
}

await mkdir(serverRoot, { recursive: true });
await mkdir(metadataRoot, { recursive: true });
await copyFile(path.join(adapterRoot, "sites-worker.js"), path.join(serverRoot, "index.js"));
await copyFile(hostingConfig, path.join(metadataRoot, "hosting.json"));
