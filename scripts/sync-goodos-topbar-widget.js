"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const mode = process.argv.includes("--write") ? "write" : "check";
const unknownArguments = process.argv.slice(2).filter(
  (argument) => argument !== "--check" && argument !== "--write"
);
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument: ${unknownArguments.join(", ")}`);
}

const goodbaseRoot = path.resolve(__dirname, "..");
const repositoriesRoot = path.resolve(
  process.env.GOODOS_REPOSITORIES_ROOT || path.join(goodbaseRoot, "..")
);
const manifestPath = path.join(goodbaseRoot, "deploy/application-paths.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const canonicalRoot = path.join(goodbaseRoot, manifest.canonicalLogin.sourceDirectory);
const packageFiles = ["index.js", "index.d.ts", "package.json", "README.md"];
const protectedStylePattern = /data-goodbase-login|goodos-login-(?:widget|shell)__/;
const protectedMarkupPattern = /data-goodbase-login(?:-[a-z-]+)?\s*(?:=|\}|>)/;
const obsoleteAuthPackages = [
  "@auth0/auth0-react",
  "@clerk/clerk-react",
  "@supabase/auth-helpers-nextjs",
  "@supabase/supabase-js",
  "amazon-cognito-identity-js",
  "firebase",
  "next-auth",
];
const ignoredDirectories = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

function checksum(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function read(filePath) {
  return fs.readFileSync(filePath);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function walk(directory, visitor) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(entryPath, visitor);
    else if (entry.isFile()) visitor(entryPath);
  }
}

const canonicalFiles = new Map(
  packageFiles.map((fileName) => {
    const filePath = path.join(canonicalRoot, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Canonical widget file is missing: ${filePath}`);
    }
    return [fileName, read(filePath)];
  })
);
const canonicalPackage = JSON.parse(readText(path.join(canonicalRoot, "package.json")));
if (canonicalPackage.name !== manifest.canonicalLogin.package) {
  throw new Error("The canonical package name does not match the deployment registry.");
}
if (canonicalPackage.version !== manifest.canonicalLogin.version) {
  throw new Error("The canonical package version does not match the deployment registry.");
}

const applications = manifest.applications.filter(
  (application) =>
    application.status === "active" &&
    application.authEnabled === true &&
    application.canonicalLoginRequired === true
);
const knownDirectories = new Set([
  ...applications.map((application) => application.localDirectory),
  ...manifest.platformServices.map((service) => service.localDirectory).filter(Boolean),
]);
const missingRepositories = [];
const snapshotDrift = [];
const packageLockDrift = [];
const updatedSnapshots = [];
const updatedPackageLocks = [];
const integrationDrift = [];
const packageDependencyDrift = [];
const themeDrift = [];
const providerContractDrift = [];
const accountFlowDrift = [];
const customizationDrift = [];
const protectedMarkupDrift = [];
const protectedStyleDrift = [];
const obsoleteAuthDrift = [];
const authAuthorityDrift = [];
let auditedApplications = 0;
let canonicalSnapshots = 0;
let canonicalIntegrations = 0;
let themeOnlyApplications = 0;

for (const application of applications) {
  const repositoryRoot = path.join(repositoriesRoot, application.localDirectory);
  if (!fs.existsSync(repositoryRoot)) {
    missingRepositories.push(application.localDirectory);
    continue;
  }
  auditedApplications += 1;

  const targetRoot = path.join(repositoryRoot, "vendor/goodos-topbar-widget");
  let snapshotMatches = true;
  for (const [fileName, canonicalContent] of canonicalFiles) {
    const targetPath = path.join(targetRoot, fileName);
    const matches =
      fs.existsSync(targetPath) && checksum(read(targetPath)) === checksum(canonicalContent);
    if (matches) continue;

    snapshotMatches = false;
    if (mode === "write") {
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(targetPath, canonicalContent);
      updatedSnapshots.push(`${application.id}:vendor/goodos-topbar-widget/${fileName}`);
      snapshotMatches = true;
    } else {
      snapshotDrift.push(`${application.id}:vendor/goodos-topbar-widget/${fileName}`);
    }
  }
  if (snapshotMatches) canonicalSnapshots += 1;

  const packageJsonPath = path.join(repositoryRoot, "package.json");
  let dependencyMatches = false;
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(readText(packageJsonPath));
    const declared = {
      ...packageJson.optionalDependencies,
      ...packageJson.devDependencies,
      ...packageJson.dependencies,
    }[manifest.canonicalLogin.package];
    dependencyMatches = declared === "file:vendor/goodos-topbar-widget";
    if (!dependencyMatches) {
      packageDependencyDrift.push(`${application.id}: expected ${manifest.canonicalLogin.package}=file:vendor/goodos-topbar-widget`);
    }
    for (const packageName of obsoleteAuthPackages) {
      if (Object.hasOwn(packageJson.dependencies || {}, packageName) || Object.hasOwn(packageJson.devDependencies || {}, packageName)) {
        obsoleteAuthDrift.push(`${application.id}:package.json:${packageName}`);
      }
    }
  } else {
    packageDependencyDrift.push(`${application.id}: package.json is missing`);
  }

  const packageLockPath = path.join(repositoryRoot, "package-lock.json");
  if (!fs.existsSync(packageLockPath)) {
    packageLockDrift.push(`${application.id}: package-lock.json is missing`);
  } else {
    const packageLock = JSON.parse(readText(packageLockPath));
    const lockKey = "vendor/goodos-topbar-widget";
    const lockedPackage = packageLock.packages?.[lockKey];
    if (lockedPackage?.version !== canonicalPackage.version) {
      if (mode === "write" && lockedPackage) {
        lockedPackage.version = canonicalPackage.version;
        fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
        updatedPackageLocks.push(`${application.id}:package-lock.json`);
      } else {
        packageLockDrift.push(
          `${application.id}: package-lock.json must lock ${manifest.canonicalLogin.package}@${canonicalPackage.version}`
        );
      }
    }
  }

  const integrationPath = path.join(repositoryRoot, application.loginIntegration);
  let integrationMatches = false;
  let themeMatches = false;
  let providerContractMatches = false;
  let accountFlowMatches = false;
  let customizationMatches = false;
  if (!fs.existsSync(integrationPath)) {
    integrationDrift.push(`${application.id}:${application.loginIntegration} is missing`);
  } else {
    const integration = readText(integrationPath);
    const missingComponents = manifest.canonicalLogin.requiredComponents.filter(
      (component) => !integration.includes(component)
    );
    const packageImportPattern = new RegExp(
      `from\\s+["']${manifest.canonicalLogin.package.replace("/", "\\/")}["']`
    );
    const expectedAppName = application.loginAppName || application.name;
    integrationMatches =
      missingComponents.length === 0 &&
      packageImportPattern.test(integration) &&
      integration.includes(`appName="${expectedAppName}"`);
    if (!integrationMatches) {
      integrationDrift.push(
        `${application.id}:${application.loginIntegration} must import the package and render ${manifest.canonicalLogin.requiredComponents.join(" + ")} with appName=\"${expectedAppName}\"`
      );
    }
    themeMatches = Object.entries(application.theme).every(([name, value]) =>
      new RegExp(`${name}\\s*=\\s*["']${value}["']`, "i").test(integration)
    );
    if (!themeMatches) {
      themeDrift.push(`${application.id}:${application.loginIntegration} does not match registered theme tokens`);
    }
    providerContractMatches =
      integration.includes("onProviderSignIn") &&
      integration.includes("providerAvailability") &&
      /providers/i.test(integration) &&
      !/providerAvailability\s*=\s*\{\{[\s\S]{0,240}?google\s*:\s*false[\s\S]{0,240}?apple\s*:\s*false[\s\S]{0,240}?microsoft\s*:\s*false/.test(integration);
    if (!providerContractMatches) {
      providerContractDrift.push(
        `${application.id}:${application.loginIntegration} must discover GoodBase provider availability and handle configured providers`
      );
    }
    const centralizedAccountRouteCount =
      (integration.match(/goodOSAccountUrl/g) || []).length +
      (integration.match(/goodBaseAuthUrl/g) || []).length +
      (integration.match(/\/auth\/ui/g) || []).length;
    accountFlowMatches =
      integration.includes("onForgotPassword") &&
      integration.includes("onCreateAccount") &&
      centralizedAccountRouteCount >= 2;
    if (!accountFlowMatches) {
      accountFlowDrift.push(
        `${application.id}:${application.loginIntegration} must route recovery and registration to the centralized GoodBase auth UI`
      );
    }
    const contextProp = manifest.canonicalLogin.applicationContextProp;
    const allowedCustomizations = application.loginCustomization || [];
    const usesContext = new RegExp(`\\b${contextProp}\\s*=`).test(integration);
    const usesLegacyCustomization = /\\b(?:portalSelector|showSecurityNotice)\\s*=/.test(integration);
    const disablesPasskey = /\\bpasskeyAvailable\\s*=\\s*\\{\\s*false\\s*\\}/.test(integration);
    customizationMatches =
      !usesLegacyCustomization &&
      !disablesPasskey &&
      (!usesContext || allowedCustomizations.includes(contextProp)) &&
      allowedCustomizations.every((prop) => new RegExp(`\\b${prop}\\s*=`).test(integration));
    if (!customizationMatches) {
      customizationDrift.push(
        `${application.id}:${application.loginIntegration} may customize login content only through its registered ${contextProp} slot and must not hide shared security controls`
      );
    }
  }

  let hasProtectedMarkup = false;
  let hasProtectedStyles = false;
  let hasNoncanonicalAuthAuthority = false;
  walk(repositoryRoot, (filePath) => {
    const extension = path.extname(filePath).toLowerCase();
    if (![".css", ".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(extension)) return;
    if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(filePath)) return;
    const content = readText(filePath);
    const relative = path.relative(repositoryRoot, filePath);
    if (extension === ".css" && protectedStylePattern.test(content)) {
      hasProtectedStyles = true;
      protectedStyleDrift.push(`${application.id}:${relative}`);
    }
    if (extension !== ".css" && protectedMarkupPattern.test(content)) {
      hasProtectedMarkup = true;
      protectedMarkupDrift.push(`${application.id}:${relative}`);
    }
    if (/from\s+["'](?:firebase\/auth|@supabase\/|@auth0\/|@clerk\/)|require\(["'](?:firebase\/auth|@supabase\/|@auth0\/|@clerk\/)/.test(content)) {
      obsoleteAuthDrift.push(`${application.id}:${relative}`);
    }
    for (const match of content.matchAll(/https:\/\/([a-z0-9-]+)\.goodos\.app\/api\/auth\b/gi)) {
      if (match[1].toLowerCase() === "base") continue;
      hasNoncanonicalAuthAuthority = true;
      authAuthorityDrift.push(`${application.id}:${relative}:${match[0]}`);
    }
  });

  if (integrationMatches) canonicalIntegrations += 1;
  if (
    snapshotMatches &&
    dependencyMatches &&
    integrationMatches &&
    themeMatches &&
    providerContractMatches &&
    accountFlowMatches &&
    customizationMatches &&
    !hasNoncanonicalAuthAuthority &&
    !hasProtectedMarkup &&
    !hasProtectedStyles
  ) {
    themeOnlyApplications += 1;
  }
}

const unknownIntegrations = [];
for (const entry of fs.readdirSync(repositoriesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || knownDirectories.has(entry.name)) continue;
  const packagePath = path.join(repositoriesRoot, entry.name, "vendor/goodos-topbar-widget/package.json");
  if (fs.existsSync(packagePath)) unknownIntegrations.push(entry.name);
}

const allDrift = [
  ...snapshotDrift,
  ...integrationDrift,
  ...packageDependencyDrift,
  ...packageLockDrift,
  ...themeDrift,
  ...providerContractDrift,
  ...accountFlowDrift,
  ...customizationDrift,
  ...protectedMarkupDrift,
  ...protectedStyleDrift,
  ...obsoleteAuthDrift,
  ...authAuthorityDrift,
];
const report = {
  discoveredApplications: applications.length,
  auditedApplications,
  canonicalSnapshots,
  canonicalIntegrations,
  themeOnlyApplications,
  missingRepositories,
  unknownIntegrations,
  updated: {
    snapshots: updatedSnapshots,
    packageLocks: updatedPackageLocks,
  },
  drift: {
    snapshots: snapshotDrift,
    integrations: integrationDrift,
    dependencies: packageDependencyDrift,
    packageLocks: packageLockDrift,
    themes: themeDrift,
    providers: providerContractDrift,
    accountFlows: accountFlowDrift,
    customizations: customizationDrift,
    protectedMarkup: protectedMarkupDrift,
    protectedStyles: protectedStyleDrift,
    obsoleteAuth: [...new Set(obsoleteAuthDrift)],
    authAuthority: [...new Set(authAuthorityDrift)],
  },
};

console.log(JSON.stringify(report, null, 2));
console.log(
  `GoodOS login audit: discovered=${applications.length} audited=${auditedApplications} canonical=${canonicalIntegrations} theme-only=${themeOnlyApplications} drift=${allDrift.length} missing=${missingRepositories.length} unknown=${unknownIntegrations.length}`
);

if (
  auditedApplications !== applications.length ||
  canonicalSnapshots !== applications.length ||
  canonicalIntegrations !== applications.length ||
  themeOnlyApplications !== applications.length ||
  missingRepositories.length > 0 ||
  unknownIntegrations.length > 0 ||
  allDrift.length > 0
) {
  process.exitCode = 1;
}
