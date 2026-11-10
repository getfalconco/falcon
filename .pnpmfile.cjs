// Keeps the website's dependency graph free of the mobile app's React Native
// stack. @react-three/fiber lists react-native and expo as optional peers, and
// pnpm links optional peers whenever they exist anywhere in the workspace, so
// once apps/mobile installed Expo, apps/web started resolving react-native
// (React 19 era) through fiber. The site only uses fiber's web build.
const NATIVE_PEERS = ["react-native", "expo", "expo-asset", "expo-file-system", "expo-gl"];

function readPackage(pkg) {
  if (pkg.name === "@react-three/fiber") {
    for (const name of NATIVE_PEERS) {
      if (pkg.peerDependencies) delete pkg.peerDependencies[name];
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
