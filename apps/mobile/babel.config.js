module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // react-native-worklets/plugin replaces the old reanimated plugin in
    // Reanimated 4 and must stay last.
    plugins: ["react-native-worklets/plugin"],
  };
};
