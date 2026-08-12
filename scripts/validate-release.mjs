import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
const releaseTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const version = manifest.version;

assert(/^\d+\.\d+\.\d+$/.test(version), `manifest version must be semantic (x.y.z), received: ${version}`);
assert(packageJson.version === version, `package.json ${packageJson.version} does not match manifest.json ${version}`);
assert(versions[version] === manifest.minAppVersion, `versions.json must map ${version} to ${manifest.minAppVersion}`);
if (releaseTag) {
  assert(releaseTag === version, `release tag ${releaseTag} does not match manifest version ${version}`);
}

console.log(`Release metadata valid for KnowFlow ${version}.`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
