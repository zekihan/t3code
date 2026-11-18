const { withMainApplication } = require("expo/config-plugins");
const { START_GUARD, CONFIGURATION_GUARD } = require("./lib/meshStreamGuard.cjs");

// The device and browser preview streams run in the `:stream` process, and Android starts the
// app's Application class in every process. There it must set up WebView's data directory and
// then do nothing else: React Native, Expo's lifecycle listeners and the certificate transport
// belong to the app process, and the transport must never present a certificate from here.
function guardStreamProcessStartup(source) {
  // Anchor to the method body, as the certificate plugin does. Fail closed if a template change
  // puts initialization ahead of super.onCreate() or adds a second lifecycle entry.
  const marker = /override fun onCreate\(\)\s*\{\s*super\.onCreate\(\)[ \t]*;?/g;
  const matches = [...source.matchAll(marker)];
  if (matches.length !== 1)
    throw new Error("Cannot keep the stream process out of React Native startup");
  const offset = matches[0].index + matches[0][0].length;
  if (source.includes(START_GUARD)) {
    if (
      !source.slice(offset).trimStart().startsWith(START_GUARD) ||
      source.split(START_GUARD).length !== 2
    )
      throw new Error("The stream process guard must follow super.onCreate() directly");
    return source;
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return source.slice(0, offset) + `${newline}    ${START_GUARD}` + source.slice(offset);
}

// Configuration changes reach every process. Expo's dispatcher would build every lifecycle
// listener on first use, which is exactly the start-up the stream process skips.
function guardStreamProcessConfiguration(source) {
  const dispatch = /ApplicationLifecycleDispatcher\.onConfigurationChanged\(/g;
  if (!dispatch.test(source)) return source;
  const marker =
    /override fun onConfigurationChanged\(newConfig: Configuration\)\s*\{\s*super\.onConfigurationChanged\(newConfig\)[ \t]*;?/g;
  const matches = [...source.matchAll(marker)];
  if (matches.length !== 1)
    throw new Error("Cannot keep the stream process out of Expo configuration callbacks");
  const offset = matches[0].index + matches[0][0].length;
  if (source.includes(CONFIGURATION_GUARD)) {
    if (
      !source.slice(offset).trimStart().startsWith(CONFIGURATION_GUARD) ||
      source.split(CONFIGURATION_GUARD).length !== 2
    )
      throw new Error(
        "The stream process guard must follow super.onConfigurationChanged() directly",
      );
    return source;
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return source.slice(0, offset) + `${newline}    ${CONFIGURATION_GUARD}` + source.slice(offset);
}

module.exports = (config) =>
  withMainApplication(config, (next) => {
    if (next.modResults.language !== "kt")
      throw new Error("Stream process start-up requires Kotlin MainApplication");
    next.modResults.contents = guardStreamProcessConfiguration(
      guardStreamProcessStartup(next.modResults.contents),
    );
    return next;
  });
module.exports.guardStreamProcessStartup = guardStreamProcessStartup;
module.exports.guardStreamProcessConfiguration = guardStreamProcessConfiguration;
